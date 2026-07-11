// ============================================================
// Broadcast processor — the cron worker (Task 4, fase 2).
//
// Drains `broadcasts` that are due/in-flight:
//   1. ATIVAÇÃO  — flips scheduled rows whose scheduled_at passed to
//                  'sending'.
//   2. SELEÇÃO   — every 'sending' broadcast.
//   3. Por broadcast (sequencial): resolve the account's provider,
//      claim a slice of pending recipients (two-step claim with
//      claimed_at as a light lock), send each one (free text via the
//      provider's sendText/sendMedia, scheduled Meta templates via
//      sendTemplateMessage with phone-variant retry — the same shape as
//      broadcast-core.ts deliverBroadcast), stamp each recipient row,
//      and finalize the broadcast + notify when nothing is left pending.
//
// Budget: at most BROADCAST_RATE_PER_MINUTE sends PER ACCOUNT per tick
// (the route pins export const maxDuration = 60). Per-recipient failures
// never abort the slice. The per-status count columns on `broadcasts`
// are trigger-owned (migrations 003/005) — we only ever write terminal
// `status`, never the counters (global constraint).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveProvider, CAPABILITIES } from '@/lib/whatsapp/providers/resolve'
import type { WhatsAppProvider } from '@/lib/whatsapp/providers/resolve'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import { renderBroadcastText } from '@/lib/broadcasts/render'
import type { MessageTemplate, WhatsAppConfig } from '@/types'

/** Default per-account send budget when the env var is unset. */
const DEFAULT_RATE = 10
/**
 * Average wall-clock cost of one send, in ms: 1000ms fixed + ~1000ms
 * mean of the 0–2000ms jitter (see {@link jitterMs}). Used only to keep
 * a tick under the route's 60s ceiling when the rate is very high.
 */
const AVG_SEND_MS = 2000
/** Route ceiling (maxDuration = 60) expressed in ms. */
const TICK_MS_BUDGET = 60_000
/** Recipients claimed more than this ago are considered stale (a prior
 * tick crashed mid-send) and may be re-claimed. */
const CLAIM_STALE_MS = 5 * 60 * 1000

// ---------- Pure helpers (unit-tested) ----------

/**
 * How many sends fit in this tick: capped by `rate`, by the time
 * budget (~{@link AVG_SEND_MS} per send), and floored at 1 so a tick
 * always makes progress.
 */
export function sliceBudget(rate: number = DEFAULT_RATE, elapsedMsBudget: number = TICK_MS_BUDGET): number {
  const byTime = Math.floor(elapsedMsBudget / AVG_SEND_MS)
  return Math.max(1, Math.min(rate, byTime))
}

/** Random 1000–3000ms pause between sends to look less bot-like. */
export function jitterMs(): number {
  return 1000 + Math.random() * 2000
}

/** A broadcast is done once no recipient is still pending. */
export function isBroadcastComplete(counts: { pending: number }): boolean {
  return counts.pending === 0
}

/** Terminal status: any success → 'sent'; nothing sent → 'failed'. */
export function finalStatus(counts: { sentCount: number }): 'sent' | 'failed' {
  return counts.sentCount > 0 ? 'sent' : 'failed'
}

// ---------- Internals ----------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface SendingBroadcast {
  id: string
  account_id: string
  user_id: string
  name: string
  template_name: string | null
  template_language: string
  template_variables: Record<string, unknown> | null
  content_text: string | null
  content_media_url: string | null
  content_media_type: 'image' | 'video' | 'document' | 'audio' | null
}

type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string }

interface ContactRow {
  id: string
  name: string | null
  phone: string | null
  email: string | null
  company: string | null
}

/** Per-contact custom values, keyed two ways: by field id (template
 *  variable mappings) and by lower-cased field name (free-text
 *  placeholders — the placeholder key is the field name, case-insensitive). */
interface CustomValueBuckets {
  byId: Map<string, string>
  byName: Map<string, string>
}

/**
 * Resolve a template's stored variable mappings into the positional
 * params array Meta expects. Mirrors resolveVariables in
 * use-broadcast-sending.ts (kept server-local so we don't import the
 * client hook). Keys are typically "1","2",… — numeric-aware sort keeps
 * {{1}} before {{10}}.
 */
function resolveTemplateParams(
  variables: Record<string, unknown> | null,
  contact: ContactRow,
  customValues: CustomValueBuckets | undefined,
): string[] {
  if (!variables) return []
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a)
    const bn = Number(b)
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
    return a.localeCompare(b)
  })
  return keys.map((key) => {
    const raw = variables[key]
    if (!raw || typeof raw !== 'object') return ''
    const v = raw as VariableMapping
    if (v.type === 'static') return v.value ?? ''
    if (v.type === 'field') {
      const fieldMap: Record<string, string | null | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      }
      return fieldMap[v.value] ?? ''
    }
    // custom_field — mapping value is the custom_fields.id
    return customValues?.byId.get(v.value) ?? ''
  })
}

/** Flip every still-pending recipient of a broadcast to failed with a
 *  reason (config gone / provider changed). Counts stay trigger-owned. */
async function failAllPending(admin: SupabaseClient, broadcastId: string, message: string): Promise<void> {
  await admin
    .from('broadcast_recipients')
    .update({ status: 'failed', error_message: message, claimed_at: null })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending')
}

/**
 * Finalize a broadcast once nothing is pending: stamp terminal status
 * (via {@link finalStatus}) and drop a 'broadcast_finished'
 * notification. Returns true when it finalized.
 */
async function finalizeIfComplete(admin: SupabaseClient, b: SendingBroadcast): Promise<boolean> {
  const { count: pending } = await admin
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', b.id)
    .eq('status', 'pending')

  if (!isBroadcastComplete({ pending: pending ?? 0 })) return false

  const { count: total } = await admin
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', b.id)
  const { count: failed } = await admin
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', b.id)
    .eq('status', 'failed')

  const failedCount = failed ?? 0
  const sentCount = (total ?? 0) - failedCount

  await admin
    .from('broadcasts')
    .update({ status: finalStatus({ sentCount }), updated_at: new Date().toISOString() })
    .eq('id', b.id)

  await admin.from('notifications').insert({
    account_id: b.account_id,
    user_id: b.user_id,
    type: 'broadcast_finished',
    title: `Transmissão "${b.name}" concluída`,
    body: `${sentCount} enviadas, ${failedCount} falhas`,
  })

  return true
}

/**
 * Batch-load the claimed slice's contacts and their custom values
 * (joined to custom_fields for the field name). One round-trip each,
 * no N+1 in the send loop.
 */
async function loadSliceData(
  admin: SupabaseClient,
  contactIds: string[],
): Promise<{ contacts: Map<string, ContactRow>; customValues: Map<string, CustomValueBuckets> }> {
  const contacts = new Map<string, ContactRow>()
  const customValues = new Map<string, CustomValueBuckets>()
  if (contactIds.length === 0) return { contacts, customValues }

  const { data: contactRows } = await admin
    .from('contacts')
    .select('id, name, phone, email, company')
    .in('id', contactIds)
  for (const row of (contactRows ?? []) as ContactRow[]) {
    contacts.set(row.id, row)
  }

  const { data: cvRows } = await admin
    .from('contact_custom_values')
    .select('contact_id, custom_field_id, value, custom_fields(field_name)')
    .in('contact_id', contactIds)
  for (const row of cvRows ?? []) {
    const contactId = row.contact_id as string
    const value = (row.value as string | null) ?? ''
    const fieldId = row.custom_field_id as string
    // Embedded to-one relation: object in practice, typed loosely.
    const embedded = row.custom_fields as { field_name?: string } | { field_name?: string }[] | null
    const fieldName = Array.isArray(embedded) ? embedded[0]?.field_name : embedded?.field_name
    const bucket = customValues.get(contactId) ?? { byId: new Map(), byName: new Map() }
    bucket.byId.set(fieldId, value)
    if (fieldName) bucket.byName.set(fieldName.toLowerCase(), value)
    customValues.set(contactId, bucket)
  }

  return { contacts, customValues }
}

async function markSent(admin: SupabaseClient, recipientId: string, messageId: string): Promise<void> {
  await admin
    .from('broadcast_recipients')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      whatsapp_message_id: messageId,
      claimed_at: null,
      error_message: null,
    })
    .eq('id', recipientId)
}

async function markFailed(admin: SupabaseClient, recipientId: string, message: string): Promise<void> {
  await admin
    .from('broadcast_recipients')
    .update({ status: 'failed', error_message: message, claimed_at: null })
    .eq('id', recipientId)
}

/**
 * Send one recipient for a free-text (WAHA/Uazapi) broadcast: render
 * placeholders, then sendMedia (caption = rendered text) when the
 * broadcast carries media, else sendText.
 */
async function sendFreeText(
  provider: WhatsAppProvider,
  b: SendingBroadcast,
  phone: string,
  contact: ContactRow,
  cv: CustomValueBuckets | undefined,
): Promise<string> {
  const text = renderBroadcastText(b.content_text ?? '', {
    name: contact.name,
    customValues: cv ? Object.fromEntries(cv.byName) : undefined,
  })
  if (b.content_media_url && b.content_media_type) {
    const { messageId } = await provider.sendMedia({
      to: phone,
      kind: b.content_media_type,
      mediaUrl: b.content_media_url,
      caption: text || undefined,
    })
    return messageId
  }
  const { messageId } = await provider.sendText({ to: phone, text })
  return messageId
}

/**
 * Send one recipient for a scheduled Meta template broadcast, retrying
 * phone variants on "recipient not allowed" — same shape as
 * broadcast-core.ts deliverBroadcast. Returns the message id on success
 * or throws with the last error.
 */
async function sendTemplate(
  config: Pick<WhatsAppConfig, 'phone_number_id'>,
  accessToken: string,
  b: SendingBroadcast,
  phone: string,
  params: string[],
  templateRow: MessageTemplate | null,
): Promise<string> {
  let lastError = 'Unknown error'
  for (const variant of phoneVariants(phone)) {
    try {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id!,
        accessToken,
        to: variant,
        templateName: b.template_name!,
        language: b.template_language,
        template: templateRow ?? undefined,
        params,
      })
      return result.messageId
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error'
      if (!isRecipientNotAllowedError(lastError)) break
    }
  }
  throw new Error(lastError)
}

/** Process one broadcast's slice; returns how many recipients it sent
 *  through the provider (successes + failures that touched the wire),
 *  used to draw down the per-account budget. */
async function processBroadcast(
  admin: SupabaseClient,
  b: SendingBroadcast,
  claimLimit: number,
): Promise<{ processed: number; completed: boolean }> {
  // a. Config da conta.
  const { data: config } = await admin
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', b.account_id)
    .maybeSingle()

  if (!config) {
    await failAllPending(admin, b.id, 'provedor desconectado')
    const completed = await finalizeIfComplete(admin, b)
    return { processed: 0, completed }
  }

  const capabilities = CAPABILITIES[config.provider as 'meta' | 'waha' | 'uazapi']
  const isFreeText = b.content_text !== null
  // Content the current provider can no longer carry: free text needs a
  // non-official provider; a template needs an official one.
  if ((isFreeText && capabilities.supportsTemplates) || (!isFreeText && !capabilities.supportsTemplates)) {
    await failAllPending(admin, b.id, 'provedor da conta mudou')
    const completed = await finalizeIfComplete(admin, b)
    return { processed: 0, completed }
  }

  // Implicit pause: the account's session dropped. Leave recipients
  // pending; a later tick resumes once reconnected.
  if (config.status !== 'connected') {
    console.log(`[broadcast-processor] broadcast ${b.id} pausado: conta ${b.account_id} não conectada`)
    return { processed: 0, completed: false }
  }

  let provider: WhatsAppProvider
  let accessToken: string | null
  try {
    accessToken = config.provider === 'waha' ? null : decrypt(config.access_token)
    provider = resolveProvider(config, accessToken)
  } catch (err) {
    console.error(`[broadcast-processor] broadcast ${b.id}: provedor não resolvido, pulando:`, err)
    return { processed: 0, completed: false }
  }

  // Template header/button components (once per broadcast), guarded like
  // broadcast-core.ts — a malformed local row is skipped this tick.
  let templateRow: MessageTemplate | null = null
  if (!isFreeText && b.template_name) {
    const { data: rawTemplate } = await admin
      .from('message_templates')
      .select('*')
      .eq('account_id', b.account_id)
      .eq('name', b.template_name)
      .eq('language', b.template_language)
      .maybeSingle()
    if (rawTemplate && !isMessageTemplate(rawTemplate)) {
      console.error(`[broadcast-processor] broadcast ${b.id}: template local malformado, pulando`)
      return { processed: 0, completed: false }
    }
    templateRow = (rawTemplate as MessageTemplate | null) ?? null
  }

  // b. CLAIM em duas etapas (padrão automations/cron).
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString()
  const { data: eligible } = await admin
    .from('broadcast_recipients')
    .select('id')
    .eq('broadcast_id', b.id)
    .eq('status', 'pending')
    .or(`claimed_at.is.null,claimed_at.lt.${staleBefore}`)
    .order('created_at', { ascending: true })
    .limit(claimLimit)

  const eligibleIds = (eligible ?? []).map((r) => r.id as string)
  if (eligibleIds.length === 0) {
    // Nothing left claimable — either done or every pending row is
    // freshly claimed by a concurrent tick. Try to finalize.
    const completed = await finalizeIfComplete(admin, b)
    return { processed: 0, completed }
  }

  const { data: claimedRows } = await admin
    .from('broadcast_recipients')
    .update({ claimed_at: new Date().toISOString() })
    .in('id', eligibleIds)
    .eq('status', 'pending')
    .select('id, contact_id')

  const claimed = (claimedRows ?? []) as { id: string; contact_id: string | null }[]
  if (claimed.length === 0) {
    const completed = await finalizeIfComplete(admin, b)
    return { processed: 0, completed }
  }

  // c. ENVIO.
  const contactIds = claimed
    .map((r) => r.contact_id)
    .filter((id): id is string => typeof id === 'string')
  const { contacts, customValues } = await loadSliceData(admin, contactIds)

  let processed = 0
  for (let i = 0; i < claimed.length; i++) {
    const recipient = claimed[i]
    const contact = recipient.contact_id ? contacts.get(recipient.contact_id) : undefined
    const phone = sanitizePhoneForMeta(contact?.phone ?? '')
    if (!contact || !isValidE164(phone)) {
      await markFailed(admin, recipient.id, 'telefone inválido')
      continue
    }
    const cv = customValues.get(contact.id)

    try {
      let messageId: string
      if (isFreeText) {
        messageId = await sendFreeText(provider, b, phone, contact, cv)
      } else {
        const params = resolveTemplateParams(b.template_variables, contact, cv)
        messageId = await sendTemplate(config, accessToken!, b, phone, params, templateRow)
      }
      await markSent(admin, recipient.id, messageId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      await markFailed(admin, recipient.id, message)
    }
    processed++

    // jitter entre envios (não após o último).
    if (i < claimed.length - 1) await sleep(jitterMs())
  }

  // d. CONCLUSÃO.
  const completed = await finalizeIfComplete(admin, b)
  return { processed, completed }
}

/**
 * One cron tick: activate due scheduled broadcasts, then drain a slice
 * of every 'sending' broadcast within the per-account budget.
 */
export async function runBroadcastTick(): Promise<{ activated: number; processed: number; completed: number }> {
  const admin = supabaseAdmin()
  const rate = Number(process.env.BROADCAST_RATE_PER_MINUTE) || DEFAULT_RATE
  const perAccountBudget = sliceBudget(rate)

  // 1. ATIVAÇÃO.
  const { data: activatedRows } = await admin
    .from('broadcasts')
    .update({ status: 'sending', updated_at: new Date().toISOString() })
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString())
    .select('id')
  const activated = activatedRows?.length ?? 0

  // 2. SELEÇÃO.
  const { data: sending } = await admin
    .from('broadcasts')
    .select(
      'id, account_id, user_id, name, template_name, template_language, template_variables, content_text, content_media_url, content_media_type',
    )
    .eq('status', 'sending')
    .order('created_at', { ascending: true })

  let processed = 0
  let completed = 0
  // Remaining send budget per account this tick.
  const remaining = new Map<string, number>()

  for (const row of (sending ?? []) as SendingBroadcast[]) {
    const left = remaining.get(row.account_id) ?? perAccountBudget
    if (left <= 0) {
      // Account already spent its budget on an earlier broadcast.
      continue
    }
    const { processed: sent, completed: done } = await processBroadcast(admin, row, left)
    remaining.set(row.account_id, left - sent)
    processed += sent
    if (done) completed++
  }

  return { activated, processed, completed }
}
