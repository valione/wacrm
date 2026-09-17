/**
 * Shared inbound-message persistence pipeline.
 *
 * Extracted verbatim from `src/app/api/whatsapp/webhook/route.ts` (the
 * Meta Cloud API webhook) so that provider webhooks (Meta, WAHA) can
 * share one pipeline: find-or-create contact/conversation, insert the
 * message, update the conversation, and fan out to flows / automations /
 * AI auto-reply / public webhooks.
 *
 * Provider routes are responsible for everything provider-specific —
 * signature verification, payload unpacking, media-URL resolution and
 * content-type mapping — and hand this module a `NormalizedInboundMessage`.
 */
import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { extractSiteRef } from '@/lib/marketing/site-ref'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import {
  hasUsableIdentity,
  identityDisplayName,
  type WaIdentity,
} from '@/lib/whatsapp/wa-identity'

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

export interface NormalizedInboundMessage {
  externalId: string            // wamid (Meta) ou id WAHA — vai em messages.message_id
  fromPhone: string             // dígitos, sem '+'
  contactName: string | null
  contentType: 'text' | 'image' | 'document' | 'audio' | 'video' | 'location' | 'interactive'
  contentText: string | null
  mediaUrl: string | null       // URL já resolvida/proxied, pronta pra gravar
  // MIME type do anexo, quando o provedor informa (Meta: `getMediaUrl`).
  // Gravado em `messages.media_type` (migração 047) para que o download
  // saiba a extensão sem ter que baixar os bytes primeiro. Os provedores
  // QR não informam — fica null e a coluna segue nula, como antes.
  mediaType?: string | null
  timestamp: Date
  replyToExternalId: string | null
  interactiveReplyId: string | null
  fromMe: boolean               // eco de mensagem enviada pelo próprio número
  // Payload cru de referral de anúncio click-to-WhatsApp, quando o provedor
  // o entrega (Meta: `message.referral`). Objeto cru {source_id, source_type,
  // source_url, headline, body, ...}, sem transformação. Só usado na captura
  // de origem quando a conversa é criada; ausente/null na esmagadora maioria
  // das mensagens.
  adReferral?: Record<string, unknown> | null
  // ============================================================
  // Identidade business-scoped (BSUID) — só a Meta envia (#519).
  //
  // Quando o cliente adota um username do WhatsApp, a Meta para de
  // mandar o telefone: `fromPhone` chega vazio e estes campos são a
  // única chave do contato. WAHA e Uazapi endereçam só telefone e
  // deixam os três ausentes, então o caminho deles é idêntico ao de
  // antes (telefone → findExistingContact).
  // ============================================================
  waUserId?: string | null
  waParentUserId?: string | null
  waUsername?: string | null
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once Meta has
// delivered or the user has read or replied, a later "failed" status
// event is a bug in Meta's pipeline or a spoof attempt and must be
// ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
export function isValidStatusTransition(
  current: string | null,
  incoming: string
): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current ?? '')
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

/**
 * Apply a provider status update to everything that mirrors it: the
 * `messages` row(s), the matching `broadcast_recipients` row, and the
 * `message.status_updated` webhook fan-out.
 *
 * `externalId` is the provider-side message id (Meta wamid / WAHA id)
 * stored in `messages.message_id` / `broadcast_recipients.whatsapp_message_id`.
 * `timestamp` is the provider's event time, used for the
 * sent_at/delivered_at/read_at mirrors; defaults to now when the
 * provider doesn't supply one.
 * `failure` is the provider's reason for a failed send (#535). Only
 * Meta supplies one; the QR providers pass nothing and the error
 * columns are left untouched, exactly as before. It is never cleared
 * on a later non-failed status, so the reason survives a replay.
 */
export interface InboundStatusFailure {
  code: number
  title: string
  details: string | null
}

export async function applyStatusByExternalId(
  externalId: string,
  status: 'sent' | 'delivered' | 'read' | 'failed',
  timestamp?: Date,
  failure?: InboundStatusFailure | null
): Promise<void> {
  // 1) Mirror onto messages (legacy behavior) — Meta's status values
  //    already match the CHECK constraint on messages.status. No
  //    `.select()`: message_id is NOT unique (migration 009 — Meta ids
  //    repeat across numbers), so this updates 0..N rows and must not
  //    assume a single row.
  const messageUpdate: Record<string, unknown> = { status: status }
  if (failure) {
    messageUpdate.error_code = failure.code
    messageUpdate.error_title = failure.title
    messageUpdate.error_details = failure.details
  }
  const { error: msgErr } = await supabaseAdmin()
    .from('messages')
    .update(messageUpdate)
    .eq('message_id', externalId)

  if (msgErr) {
    console.error('Error updating message status:', msgErr)
  }

  // Webhook fan-out for this status change happens at the END of this
  // handler (after the broadcast mirror below), so a slow subscriber
  // endpoint can't delay the broadcast_recipients update.

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const tsIso = (timestamp ?? new Date()).toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', externalId)
    .maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
  } else if (
    recipient &&
    // Guard transitions — forward-only on the success ladder, and
    // `failed` only from pre-delivered states.
    isValidStatusTransition(recipient.status, status)
  ) {
    const update: Record<string, unknown> = { status: status }
    if (status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
    if (status === 'delivered') update.delivered_at = tsIso
    if (status === 'read') update.read_at = tsIso
    // broadcast_recipients already has a free-text error_message column
    // (migration 001), so the reason is folded into it rather than
    // adding three more columns there.
    if (failure) {
      update.error_message =
        `[${failure.code}] ${failure.title}` +
        (failure.details ? `: ${failure.details}` : '')
    }

    const { error: recUpdateErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  //    Bounded to one row (message_id isn't unique) purely to resolve
  //    the owning account for delivery.
  const { data: msgRow } = await supabaseAdmin()
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', externalId)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv = msgRow.conversations as { account_id: string } | null
    const accountId = conv?.account_id
    if (accountId) {
      await dispatchWebhookEvent(
        supabaseAdmin(),
        accountId,
        'message.status_updated',
        {
          whatsapp_message_id: externalId,
          conversation_id: msgRow.conversation_id,
          status: status,
        }
      )
    }
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a provider-side message_id into the matching internal UUID,
 * scoped to one conversation. Returns null when we never received the
 * parent (e.g. a swipe-reply to a message older than this CRM install).
 */
export async function lookupInternalIdByExternalId(
  externalId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', externalId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook] lookupInternalIdByExternalId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in persistInboundMessage. */
  wasCreated: boolean
}

/**
 * Look a contact up by BSUID. Exact match on the column backing
 * migration 048's unique index — no fuzzy matching, because a BSUID is
 * an opaque identifier with exactly one correct spelling.
 *
 * Only the Meta path ever reaches this: WAHA and Uazapi leave
 * `waUserId` null, so the caller short-circuits straight to the phone
 * lookup for them.
 */
async function findContactByWaUserId(
  accountId: string,
  waUserId: string
): Promise<ContactRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('wa_user_id', waUserId)
    .maybeSingle()

  if (error) {
    console.error('[webhook] BSUID contact lookup failed:', error.message)
    return null
  }
  return data ?? null
}

/**
 * Fields worth writing back onto a contact we just matched, given what
 * this delivery told us. Returns null when nothing changed, so the
 * common case costs no UPDATE — which is what the phone-only providers
 * (WAHA / Uazapi) see on every message from a known contact.
 *
 * The BSUID backfill is the important one: it stamps the id onto a
 * contact we have only ever known by phone, so the NEXT message from
 * that person — which may well arrive with no phone number at all —
 * still resolves to this same row instead of forking a new one.
 * Likewise a phone backfill upgrades a BSUID-only contact the moment
 * Meta discloses the number.
 */
function contactIdentityPatch(
  existing: ContactRow,
  identity: WaIdentity
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}

  // Only ever from a label the provider actually supplied.
  // `identityDisplayName` falls back to the phone number / BSUID, which
  // is the right choice for a brand-new row but would clobber an
  // agent's hand-edited name on every inbound message from a contact
  // with no WhatsApp profile name.
  const name = identity.name || identity.waUsername
  if (name && name !== existing.name) patch.name = name

  if (identity.waUserId && identity.waUserId !== existing.wa_user_id) {
    patch.wa_user_id = identity.waUserId
  }
  if (
    identity.waParentUserId &&
    identity.waParentUserId !== existing.wa_parent_user_id
  ) {
    patch.wa_parent_user_id = identity.waParentUserId
  }
  if (identity.waUsername && identity.waUsername !== existing.wa_username) {
    patch.wa_username = identity.waUsername
  }
  // Only ever fills a blank. An existing number is left alone — the
  // send path's variant retry already owns correcting it, and a
  // provider's formatting differences are not a reason to rewrite it.
  if (identity.phone && !normalizePhone(existing.phone ?? '')) {
    patch.phone = identity.phone
  }

  return Object.keys(patch).length > 0 ? patch : null
}

/**
 * Resolve the contact an inbound delivery belongs to, creating it when
 * we've never seen this person.
 *
 * `identity` carries BOTH possible keys. Phone is the only one WAHA and
 * Uazapi ever fill, so for them this behaves exactly as the phone-only
 * version did; the BSUID branches are inert.
 */
export async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  identity: WaIdentity
): Promise<ContactOutcome | null> {
  // BSUID first when we have one. It's stable per (user, business
  // portfolio) and, unlike the phone number, Meta keeps sending it — so
  // it's the key that survives a customer adopting a username.
  let existingContact: ContactRow | null = identity.waUserId
    ? await findContactByWaUserId(accountId, identity.waUserId)
    : null

  // Fall back to the phone. The shared helper pre-filters in SQL by the
  // last-8-digit suffix (so we don't pull every contact on every
  // inbound message) then applies the strict `phonesMatch` in JS on the
  // small candidate set. The same helper backs the manual contact form
  // and CSV import, so all three paths agree on what "same number"
  // means (issue #212). Skipped entirely when there is no phone —
  // looking '' up is what used to fork a new contact per message.
  if (!existingContact && identity.phone) {
    existingContact = await findExistingContact(
      supabaseAdmin(),
      accountId,
      identity.phone,
    )
  }

  if (existingContact) {
    const patch = contactIdentityPatch(existingContact, identity)
    if (patch) {
      const { data: updated, error: updateError } = await supabaseAdmin()
        .from('contacts')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
        .select()
        .maybeSingle()

      if (updateError) {
        // A BSUID backfill can lose a race with a concurrent delivery
        // that already claimed it for another row. Not fatal — the
        // message still belongs to the contact we matched.
        console.error(
          '[webhook] contact identity backfill failed:',
          updateError.message
        )
      } else if (updated) {
        existingContact = updated
      }
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  //
  // `phone` stays NOT NULL in the schema, so a BSUID-only sender is
  // stored with '' — which migration 022's partial unique index
  // tolerates, and migration 048's BSUID index is what keeps them
  // unique instead.
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone: identity.phone,
      name: identityDisplayName(identity),
      wa_user_id: identity.waUserId,
      wa_parent_user_id: identity.waParentUserId,
      wa_username: identity.waUsername,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and a unique
    // index (022's phone, or 048's BSUID) rejected the duplicate.
    // Re-resolve the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = identity.waUserId
        ? await findContactByWaUserId(accountId, identity.waUserId)
        : null
      if (raced) return { contact: raced, wasCreated: false }
      if (identity.phone) {
        const racedByPhone = await findExistingContact(
          supabaseAdmin(),
          accountId,
          identity.phone
        )
        if (racedByPhone) return { contact: racedByPhone, wasCreated: false }
      }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

export async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows, and the old code treated any error as
  // "none found" and inserted a new row. So once two conversations
  // existed for a contact (from a race — Meta retries a delivery, or a
  // batch fans out to concurrent runs), every subsequent inbound
  // message errored on the lookup and created yet another conversation,
  // snowballing into a wall of duplicate chats (issue #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve to
  // the same canonical survivor the dedup migration (036) keeps, so any
  // pre-existing duplicates converge instead of compounding.
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migration 036) rejected the duplicate. Re-resolve the winning
    // row instead of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

/**
 * Persist a normalized inbound message and run the full post-insert
 * pipeline (conversation bump, broadcast reply flag, flows, automations,
 * AI auto-reply, public webhooks).
 *
 * `accountId` is the tenancy — resolved from the matched provider config
 * row; every contact / conversation / message row created downstream is
 * stamped with it so any member of the account can see it.
 * `configOwnerUserId` is the sender-of-record for inserts that need a
 * NOT NULL user_id FK (contacts, conversations). Always the admin who
 * saved the provider config; the choice is arbitrary post-017 but stable.
 */
export async function persistInboundMessage(
  normalized: NormalizedInboundMessage,
  accountId: string,
  configOwnerUserId: string,
  // Janela de espera antes de re-consultar o dedupe de um eco fromMe cujo
  // primeiro lookup não achou match (ver bloco fromMe abaixo). Injetável
  // para testes; em produção usa o default de 3s.
  echoDedupeRetryMs = 3000,
): Promise<void> {
  // Identidade do remetente: telefone E/OU BSUID. Os provedores QR
  // (WAHA / Uazapi) só preenchem o telefone, então para eles isto é
  // exatamente o que era antes.
  const identity: WaIdentity = {
    phone: normalizePhone(normalized.fromPhone),
    waUserId: normalized.waUserId ?? null,
    waParentUserId: normalized.waParentUserId ?? null,
    waUsername: normalized.waUsername ?? null,
    name: normalized.contactName ?? '',
  }
  if (!hasUsableIdentity(identity)) {
    // Nenhuma das duas chaves. Criar a linha assim mesmo geraria um
    // contato inalcançável que nunca mais casa com nada — melhor
    // descartar a entrega com log do que acumular lixo.
    console.error(
      '[inbound] message carries neither a phone number nor a BSUID; skipping:',
      normalized.externalId
    )
    return
  }

  // Content arrives pre-parsed by the provider route (Meta:
  // parseMessageContent; WAHA: its own normalizer). `contentType` is
  // already one of the values allowed by the messages.content_type
  // CHECK constraint.
  const { contentText, mediaUrl, contentType, interactiveReplyId } = normalized

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    identity
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  // Find or create conversation
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the short-circuits below — so a subscriber always sees the thread
  // open before its first message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Echo of a message sent by our own number (fromMe). If the CRM sent
  // it, the send path already persisted the row — dedupe on message_id
  // and stop. Otherwise (sent from the phone / another client), store it
  // as an agent message WITHOUT bumping unread_count and WITHOUT firing
  // flows / automations / AI / message.received — an outbound echo is
  // not a customer trigger.
  if (normalized.fromMe) {
    const lookupEcho = async () =>
      supabaseAdmin()
        .from('messages')
        .select('id')
        .eq('message_id', normalized.externalId)
        .limit(1)
        .maybeSingle()

    const { data: existingEcho, error: echoLookupError } = await lookupEcho()

    if (echoLookupError) {
      console.error('Error checking for echoed message:', echoLookupError)
      return
    }
    if (existingEcho) return // already persisted by the CRM send path

    // Corrida do eco: quando o próprio CRM envia, a WAHA pode entregar o
    // eco fromMe ANTES do INSERT do send path concluir a transação — o
    // primeiro lookup por message_id não acha nada mas a linha está a
    // caminho. Antes de inserir como agente (o que duplicaria o thread),
    // aguardamos ~3s e re-consultamos uma vez. Só inserimos se, passada a
    // janela, o send path ainda não gravou (eco genuíno de outro cliente:
    // celular/WhatsApp Web). Estamos dentro de after(), então essa espera
    // não bloqueia a resposta 200 ao webhook.
    if (echoDedupeRetryMs > 0) {
      await new Promise((r) => setTimeout(r, echoDedupeRetryMs))
      const { data: recheckedEcho, error: recheckError } = await lookupEcho()
      if (recheckError) {
        console.error('Error re-checking for echoed message:', recheckError)
        return
      }
      if (recheckedEcho) return // send path finished the INSERT during the wait
    }

    const { error: echoMsgError } = await supabaseAdmin().from('messages').insert({
      conversation_id: conversation.id,
      sender_type: 'agent',
      content_type: contentType,
      content_text: contentText,
      media_url: mediaUrl,
      media_type: normalized.mediaType ?? null,
      message_id: normalized.externalId,
      status: 'sent',
      created_at: normalized.timestamp.toISOString(),
      interactive_reply_id: interactiveReplyId,
    })

    if (echoMsgError) {
      console.error('Error inserting echoed message:', echoMsgError)
      return
    }

    // Update conversation — no unread_count bump for our own messages.
    const { error: echoConvError } = await supabaseAdmin()
      .from('conversations')
      .update({
        last_message_text: contentText || `[${contentType}]`,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id)

    if (echoConvError) {
      console.error('Error updating conversation:', echoConvError)
    }
    return
  }

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (normalized.replyToExternalId) {
    replyToInternalId = await lookupInternalIdByExternalId(
      normalized.replyToExternalId,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        normalized.replyToExternalId
      )
    }
  }

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // ============================================================
  // Origin capture (ADITIVO).
  //
  // Só na PRIMEIRA mensagem de uma conversa recém-criada (convResult.created)
  // e nunca em ecos fromMe (já retornaram acima). Detecta o marcador de site
  // `[ref:<slug>]` no texto e, quando presente, persiste o texto SEM o
  // marcador; captura também o adReferral cru do provedor (anúncio CTWA).
  // Fora desse caso, `contentTextToStore === contentText` e nada muda em
  // relação ao comportamento anterior.
  let contentTextToStore = contentText
  let capturedSiteRef: string | null = null
  const capturedAdReferral = convResult.created ? (normalized.adReferral ?? null) : null
  if (convResult.created && contentText) {
    const { ref, cleanText } = extractSiteRef(contentText)
    if (ref !== null) {
      capturedSiteRef = ref
      contentTextToStore = cleanText // só troca quando havia marcador
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, template_name, message_id, status, created_at
  //
  // Idempotent insert. Every provider retries a delivery it didn't see
  // acked (Meta on a slow 200 or a transient 5xx; the QR providers on a
  // reconnect), and each retry replays the exact same provider message
  // id. The unique index on (conversation_id, message_id) added in
  // migration 045 makes a replay conflict; `ignoreDuplicates` turns that
  // into an ON CONFLICT DO NOTHING, and the `.select()` then returns the
  // inserted row ONLY on a genuine first insert — an empty result means
  // this delivery was a replay. This is the single idempotency boundary
  // and it must sit BEFORE the unread bump and all downstream fan-out
  // below (issue #367).
  //
  // An empty-string external id is treated as absent (same as null)
  // before it ever reaches the unique index: unlike NULL, two empty
  // strings compare equal, so a blank id would make the first message in
  // a conversation collide with every later one, get returned as `[]` by
  // the upsert below, and be discarded as a "duplicate" it never was.
  const externalIdForInsert = normalized.externalId ? normalized.externalId : null
  const messageRow = {
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentTextToStore,
    media_url: mediaUrl,
    // MIME type do anexo (migração 047). Era descartado, o que
    // obrigava o download a adivinhar a extensão só depois de já
    // ter buscado os bytes. Null para quem não informa.
    media_type: normalized.mediaType ?? null,
    message_id: externalIdForInsert,
    status: 'delivered',
    created_at: normalized.timestamp.toISOString(),
    reply_to_message_id: replyToInternalId,
    // Only populated for content_type='interactive'. Migration 010 added
    // the column; null for every other content_type so existing inserts
    // behave identically.
    interactive_reply_id: interactiveReplyId,
  }

  let insertedRows: { id: string }[] | null = null
  const { data: upsertRows, error: msgError } = await supabaseAdmin()
    .from('messages')
    .upsert(messageRow, {
      onConflict: 'conversation_id,message_id',
      ignoreDuplicates: true,
    })
    .select('id')

  if (msgError) {
    // 42P10 = Postgres "invalid ON CONFLICT specification": the unique
    // index migration 045 adds on (conversation_id, message_id) doesn't
    // exist yet in this database, so the ON CONFLICT clause itself is
    // invalid and PostgREST never attempts the write. Fall back to a
    // plain insert so the message isn't lost. This only covers a missing
    // 045 — it assumes 047 (messages.media_type) and 048 (contacts.wa_*)
    // are already applied. It does NOT make deploying out of order safe:
    // without 047 this same insert fails with PGRST204 instead, and
    // without 048 every new contact fails separately. All of 045-050
    // must be applied first; see CHANGELOG.display4.md.
    if (msgError.code === '42P10') {
      console.error(
        '[inbound] migration 045 unique index missing on messages(conversation_id, message_id) — deduplication INACTIVE, falling back to plain insert:',
        normalized.externalId
      )
      const { data: fallbackRows, error: fallbackError } = await supabaseAdmin()
        .from('messages')
        .insert(messageRow)
        .select('id')

      if (fallbackError) {
        console.error('Error inserting message (fallback insert):', fallbackError)
        return
      }
      insertedRows = fallbackRows
    } else {
      console.error('Error inserting message:', msgError)
      return
    }
  } else {
    insertedRows = upsertRows
  }

  // Replayed delivery: the message already exists, so acknowledge it as a
  // no-op. Returning here is what keeps a retry from double-bumping unread,
  // re-advancing flows, re-firing automations, re-invoking AI handling, and
  // re-dispatching public webhooks (issue #367). Never true on the
  // fallback-insert path above — a plain insert always returns its row.
  if (!insertedRows || insertedRows.length === 0) {
    console.info(
      '[inbound] duplicate inbound message ignored (idempotent replay):',
      normalized.externalId
    )
    return
  }

  // Update conversation. The unread bump is done DB-side (migration 045's
  // bump_conversation_on_inbound) rather than as a read-modify-write of the
  // snapshot loaded above: two inbound messages for the same conversation
  // can process concurrently, and computing `snapshot + 1` in the app let
  // both reads see the same value and write the same increment, losing one
  // (issue #369). The RPC increments in a single UPDATE and refreshes the
  // last-message summary in the same statement.
  const { error: convError } = await supabaseAdmin().rpc(
    'bump_conversation_on_inbound',
    {
      p_conversation_id: conversation.id,
      p_last_message_text: contentTextToStore || `[${contentType}]`,
    }
  )

  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  // Origem (site_ref / ad_referral). Antes pegava carona no UPDATE acima;
  // como o bump virou RPC, vira uma escrita própria — que só acontece na
  // primeira mensagem de uma conversa recém-criada em que houve captura,
  // ou seja, praticamente nunca. Nada muda para as demais mensagens.
  if (capturedSiteRef || capturedAdReferral) {
    const originUpdate: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }
    if (capturedSiteRef) originUpdate.site_ref = capturedSiteRef
    if (capturedAdReferral) originUpdate.ad_referral = capturedAdReferral

    const { error: originError } = await supabaseAdmin()
      .from('conversations')
      .update(originUpdate)
      .eq('id', conversation.id)

    if (originError) {
      console.error('Error persisting conversation origin:', originError)
    }
  }

  // A customer writing again re-opens the thread (issue #409). Kept as a
  // separate statement rather than a `status` field on the write above so
  // it can be gated on the row's CURRENT status in SQL — see the helper
  // for why that matters. No-op (and no round trip) unless the snapshot
  // we loaded says the thread was closed.
  await reopenClosedConversation(supabaseAdmin(), conversation)

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003).
  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: contentText ?? '',
            meta_message_id: normalized.externalId,
          }
        : {
            kind: 'text',
            text: contentText ?? '',
            meta_message_id: normalized.externalId,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  const inboundText = contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    // Interactive tap → fire the interactive_reply trigger too (only
    // meaningful when a button/list reply actually arrived). Enables
    // automation-only chained menus; when a Flow owns the menu it will
    // have consumed the reply and this is skipped.
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  // Awaited — not fire-and-forget. Every provider route calls this from
  // inside `after()`, which only keeps the function alive for promises it
  // can see, so a detached dispatch can be frozen part-way through: the
  // log row is inserted, then the steps never run. `runAutomationsForTrigger`
  // owns its own try/catch and never throws; the `.catch` is belt-and-braces
  // so one trigger type's failure can't skip the rest of the loop.
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        // Only set on interactive taps; drives the interactive_reply
        // trigger's exact-id match.
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply. Runs only for plain-text inbound the deterministic
  // flow runner did NOT consume (flows win over the LLM), and only when
  // the account has enabled it. Awaited inside `after()` (same reason as
  // the webhook dispatch below); `dispatchInboundToAiReply` owns its
  // eligibility gates + try/catch and never throws.
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  // message.received webhook (public API). Awaited — not fire-and-forget
  // — because we're inside the route's `after()` block, which only keeps
  // the function alive for promises it can see; a detached promise could
  // be frozen before it delivers. `dispatchWebhookEvent` early-exits
  // when the account has no matching endpoint and never throws.
  // (conversation.created is emitted earlier, right after the thread is
  // opened.)
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: normalized.externalId,
    content_type: contentType,
    text: contentText,
  })
}
