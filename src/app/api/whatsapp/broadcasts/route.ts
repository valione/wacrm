// POST /api/whatsapp/broadcasts — creates a broadcast processed by the
// cron worker (Task 4): free-text broadcasts for non-official
// providers (WAHA/Uazapi) and scheduled broadcasts for any provider,
// including Meta templates. Meta's *immediate* template send stays on
// the existing `src/hooks/use-broadcast-sending.ts` +
// `POST /api/whatsapp/broadcast` (singular) flow — untouched by this
// route.
//
// Structure mirrors src/app/api/whatsapp/uazapi/instance/route.ts:
// auth via getCurrentAccount, supabaseAdmin() for every DB read/write
// (RLS bypassed — every query below scopes account_id explicitly),
// `{ error, message? }` JSON on failure.
import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { CAPABILITIES } from '@/lib/whatsapp/providers/resolve'
import { resolveAudienceServer, AudienceError, type AudienceInput } from '@/lib/broadcasts/audience'

/** Cap shared with the existing v1/broadcast-core flow (MAX_RECIPIENTS). */
const MAX_RECIPIENTS = 1000
/** `broadcast_recipients` inserts, matching use-broadcast-sending.ts. */
const INSERT_BATCH_SIZE = 200

const MEDIA_TYPES = new Set(['image', 'video', 'document', 'audio'])

interface CreateBroadcastBody {
  name?: unknown
  content_text?: unknown
  content_media_url?: unknown
  content_media_type?: unknown
  template_name?: unknown
  template_language?: unknown
  template_variables?: unknown
  audience?: unknown
  scheduled_at?: unknown
}

function badRequest(message: string) {
  return NextResponse.json({ error: 'bad_request', message }, { status: 400 })
}

function unprocessable(error: string, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, message, ...extra }, { status: 422 })
}

export async function POST(request: Request) {
  let accountId: string
  let userId: string
  try {
    const ctx = await getCurrentAccount()
    accountId = ctx.accountId
    userId = ctx.userId
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = (await request.json().catch(() => null)) as CreateBroadcastBody | null
  if (!body || typeof body !== 'object') {
    return badRequest('Corpo da requisição deve ser um objeto JSON.')
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return badRequest("'name' é obrigatório.")

  const contentText =
    typeof body.content_text === 'string' && body.content_text.trim().length > 0
      ? body.content_text
      : null
  const templateName =
    typeof body.template_name === 'string' && body.template_name.trim().length > 0
      ? body.template_name.trim()
      : null

  // XOR mirrors the DB CHECK (broadcasts_content_coherence, migration 039):
  // exactly one of content_text / template_name.
  if ((contentText !== null) === (templateName !== null)) {
    return badRequest("Informe exatamente um de 'content_text' ou 'template_name'.")
  }

  const contentMediaUrl =
    typeof body.content_media_url === 'string' && body.content_media_url.trim().length > 0
      ? body.content_media_url.trim()
      : null
  const contentMediaType =
    typeof body.content_media_type === 'string' && body.content_media_type.length > 0
      ? body.content_media_type
      : null

  if ((contentMediaUrl !== null) !== (contentMediaType !== null)) {
    return badRequest("'content_media_url' e 'content_media_type' devem ser informados juntos.")
  }
  if (contentMediaType !== null && !MEDIA_TYPES.has(contentMediaType)) {
    return badRequest("'content_media_type' deve ser 'image', 'video', 'document' ou 'audio'.")
  }
  if (contentMediaUrl !== null && contentText === null) {
    // Media only rides along free text; a template broadcast's media
    // (header) is a separate, existing concern on the Meta immediate flow.
    return badRequest("'content_media_url' exige 'content_text'.")
  }

  let scheduledAt: string | null = null
  if (body.scheduled_at !== undefined && body.scheduled_at !== null) {
    if (typeof body.scheduled_at !== 'string') {
      return badRequest("'scheduled_at' deve ser uma string ISO 8601.")
    }
    const parsed = new Date(body.scheduled_at)
    if (Number.isNaN(parsed.getTime())) {
      return badRequest("'scheduled_at' não é uma data válida.")
    }
    if (parsed.getTime() <= Date.now()) {
      return unprocessable('scheduled_at_in_past', "'scheduled_at' deve estar no futuro.")
    }
    scheduledAt = parsed.toISOString()
  }

  const audience = body.audience as AudienceInput | undefined
  if (!audience || typeof audience !== 'object' || typeof audience.type !== 'string') {
    return badRequest("'audience' é obrigatório e precisa de um 'type' válido.")
  }

  const admin = supabaseAdmin()

  const { data: config, error: configError } = await admin
    .from('whatsapp_config')
    .select('provider')
    .eq('account_id', accountId)
    .maybeSingle()
  if (configError) {
    console.error('[whatsapp/broadcasts POST] lookup de whatsapp_config falhou:', configError)
    return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
  }
  if (!config) {
    return NextResponse.json(
      {
        error: 'whatsapp_not_configured',
        message: 'Conecte um provedor de WhatsApp antes de criar transmissões.',
      },
      { status: 409 },
    )
  }

  const capabilities = CAPABILITIES[config.provider as 'meta' | 'waha' | 'uazapi']

  if (contentText !== null && capabilities.supportsTemplates) {
    return unprocessable(
      'unsupported_by_provider',
      'Transmissão de texto livre exige provedor via QR Code.',
    )
  }
  if (templateName !== null) {
    if (!capabilities.supportsTemplates) {
      return unprocessable('unsupported_by_provider', 'O provedor conectado não usa templates.')
    }
    if (!scheduledAt) {
      return unprocessable(
        'immediate_template_unsupported',
        'Envio imediato de template usa o fluxo atual da tela de transmissões.',
      )
    }
  }

  let contactIds: string[]
  try {
    contactIds = await resolveAudienceServer(admin, accountId, audience)
  } catch (err) {
    if (err instanceof AudienceError) return badRequest(err.message)
    console.error('[whatsapp/broadcasts POST] resolveAudienceServer falhou:', err)
    return NextResponse.json({ error: 'Failed to resolve audience' }, { status: 500 })
  }

  if (contactIds.length === 0) {
    return unprocessable('empty_audience', 'Nenhum contato encontrado para esta audiência.')
  }
  if (contactIds.length > MAX_RECIPIENTS) {
    return unprocessable(
      'audience_too_large',
      `A audiência resolvida tem ${contactIds.length} contatos; o limite é ${MAX_RECIPIENTS}.`,
      { total: contactIds.length },
    )
  }

  const templateVariables =
    templateName !== null && body.template_variables && typeof body.template_variables === 'object'
      ? (body.template_variables as Record<string, unknown>)
      : null
  // Only stamped for template broadcasts — free-text broadcasts leave
  // the key out of the insert so the column's own DEFAULT 'en_US' (NOT
  // NULL) applies, matching "grava template_language/template_variables
  // quando template" from the task brief.
  const templateLanguage =
    templateName !== null
      ? typeof body.template_language === 'string' && body.template_language
        ? body.template_language
        : 'en_US'
      : undefined

  const { data: broadcast, error: insertError } = await admin
    .from('broadcasts')
    .insert({
      user_id: userId,
      account_id: accountId,
      name,
      template_name: templateName,
      template_language: templateLanguage,
      template_variables: templateVariables,
      content_text: contentText,
      content_media_url: contentMediaUrl,
      content_media_type: contentMediaType,
      audience_filter: audience,
      scheduled_at: scheduledAt,
      status: scheduledAt ? 'scheduled' : 'sending',
      total_recipients: contactIds.length,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    })
    .select('id')
    .single()

  if (insertError || !broadcast) {
    console.error('[whatsapp/broadcasts POST] insert de broadcasts falhou:', insertError)
    return NextResponse.json({ error: 'Failed to create broadcast' }, { status: 500 })
  }

  const recipientRows = contactIds.map((contactId) => ({
    broadcast_id: broadcast.id,
    contact_id: contactId,
    status: 'pending' as const,
  }))

  for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
    const batch = recipientRows.slice(i, i + INSERT_BATCH_SIZE)
    const { error: recipientError } = await admin.from('broadcast_recipients').insert(batch)
    if (recipientError) {
      console.error('[whatsapp/broadcasts POST] insert de broadcast_recipients falhou:', recipientError)
      // Mirrors use-broadcast-sending.ts: flip to failed rather than
      // leave an incomplete recipient set behind a 'sending'/'scheduled' row.
      await admin
        .from('broadcasts')
        .update({ status: 'failed', failed_count: contactIds.length })
        .eq('id', broadcast.id)
      return NextResponse.json({ error: 'Failed to create broadcast recipients' }, { status: 500 })
    }
  }

  return NextResponse.json({ broadcast_id: broadcast.id }, { status: 201 })
}
