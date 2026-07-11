// PATCH /api/whatsapp/broadcasts/[id] — pause/resume/cancel a
// cron-processed broadcast (Task 4 drains 'sending' rows on a
// schedule). Structure mirrors src/app/api/whatsapp/uazapi/instance/route.ts:
// auth via getCurrentAccount, supabaseAdmin() for every DB read/write.
import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

type Action = 'pause' | 'resume' | 'cancel'

function invalidTransition(message: string) {
  return NextResponse.json({ error: 'invalid_transition', message }, { status: 409 })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let accountId: string
  try {
    const ctx = await getCurrentAccount()
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params

  const body = (await request.json().catch(() => null)) as { action?: unknown } | null
  const action = body?.action
  if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
    return NextResponse.json(
      { error: 'bad_request', message: "'action' deve ser 'pause', 'resume' ou 'cancel'." },
      { status: 400 },
    )
  }

  const admin = supabaseAdmin()

  const { data: broadcast, error: fetchError } = await admin
    .from('broadcasts')
    .select('id, status, sent_count')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (fetchError) {
    console.error('[whatsapp/broadcasts/[id] PATCH] lookup de broadcast falhou:', fetchError)
    return NextResponse.json({ error: 'Failed to load broadcast' }, { status: 500 })
  }
  if (!broadcast) {
    return NextResponse.json({ error: 'not_found', message: 'Transmissão não encontrada.' }, { status: 404 })
  }

  return handleAction(admin, broadcast as { id: string; status: string; sent_count: number }, action as Action)
}

async function handleAction(
  admin: ReturnType<typeof supabaseAdmin>,
  broadcast: { id: string; status: string; sent_count: number },
  action: Action,
) {
  if (action === 'pause') {
    if (broadcast.status !== 'sending') {
      return invalidTransition(`Não é possível pausar uma transmissão em status '${broadcast.status}'.`)
    }
    return applyStatus(admin, broadcast.id, 'paused')
  }

  if (action === 'resume') {
    if (broadcast.status !== 'paused' && broadcast.status !== 'scheduled') {
      return invalidTransition(`Não é possível retomar uma transmissão em status '${broadcast.status}'.`)
    }
    return applyStatus(admin, broadcast.id, 'sending')
  }

  // cancel
  if (!['scheduled', 'sending', 'paused'].includes(broadcast.status)) {
    return invalidTransition(`Não é possível cancelar uma transmissão em status '${broadcast.status}'.`)
  }

  const { error: recipientsError } = await admin
    .from('broadcast_recipients')
    .update({ status: 'failed', error_message: 'cancelado pelo usuário' })
    .eq('broadcast_id', broadcast.id)
    .eq('status', 'pending')
  if (recipientsError) {
    console.error('[whatsapp/broadcasts/[id] PATCH] update de broadcast_recipients (cancel) falhou:', recipientsError)
    return NextResponse.json({ error: 'Failed to cancel broadcast recipients' }, { status: 500 })
  }

  // sent_count is maintained by the counts trigger (migration 005) off
  // recipient status — re-read after the update above so the final
  // status reflects whatever the trigger just derived, not the
  // pre-cancel snapshot fetched earlier.
  const { data: refreshed, error: refetchError } = await admin
    .from('broadcasts')
    .select('sent_count')
    .eq('id', broadcast.id)
    .maybeSingle()
  if (refetchError || !refreshed) {
    console.error('[whatsapp/broadcasts/[id] PATCH] re-leitura de broadcast (cancel) falhou:', refetchError)
    return NextResponse.json({ error: 'Failed to finalize cancelled broadcast' }, { status: 500 })
  }

  const finalStatus = refreshed.sent_count > 0 ? 'sent' : 'failed'
  return applyStatus(admin, broadcast.id, finalStatus)
}

async function applyStatus(admin: ReturnType<typeof supabaseAdmin>, id: string, status: string) {
  const { error } = await admin.from('broadcasts').update({ status }).eq('id', id)
  if (error) {
    console.error('[whatsapp/broadcasts/[id] PATCH] update de status falhou:', error)
    return NextResponse.json({ error: 'Failed to update broadcast status' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, status })
}
