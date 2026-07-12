// Atribuição de origem das conversas (Anúncio / Site / Direto) — Task 5 do
// dashboard de marketing. Consome as colunas `conversations.ad_referral` /
// `conversations.site_ref` gravadas pelo pipeline inbound (Task 4,
// migração 040).
//
// Sem N+1: 3 queries no total (conversations do período, messages das
// conversas de anúncio, deals dos contatos de anúncio), agregadas em
// memória — volumes esperados são pequenos (dashboard de uma agência, não
// um produto multi-tenant de milhões de conversas).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AttributionSummary } from './types'

interface ConversationOriginRow {
  id: string
  contact_id: string | null
  ad_referral: { source_id?: string; headline?: string } | null
  site_ref: string | null
}

interface ByAdEntry {
  adId: string | null
  headline: string | null
  conversations: number
  replied: number
  deals: number
}

/**
 * Resumo de atribuição de origem para conversas criadas no período
 * (`period.start`/`period.end`, YYYY-MM-DD, UTC, ambas as pontas
 * inclusive — mesmo formato de `periodWindow`).
 *
 * - `byOrigin`: cada conversa cai em exatamente um balde — `ad` quando tem
 *   `ad_referral`, senão `site` quando tem `site_ref`, senão `direct`.
 * - `byAd`: só as conversas com `ad_referral`, agrupadas por
 *   `ad_referral.source_id` (chave `'(sem id)'` quando ausente).
 *   `replied` = tem ≥1 mensagem com `sender_type` em ('agent','bot').
 *   `deals` = o contato da conversa tem ≥1 deal — sem restrição de janela
 *   de tempo (simplificação aceita pelo controlador da Task 5: apenas
 *   `deals.contact_id` igual ao `contact_id` da conversa).
 * - `bySitePage`: só as conversas com `site_ref` (e sem `ad_referral`,
 *   pela mesma exclusividade de `byOrigin`), agrupadas por `site_ref`.
 *
 * `db` é o client do chamador (RLS escopando por conta) — a função não
 * filtra nada além de `account_id` + janela de datas; a RLS de
 * `conversations`/`messages`/`deals` garante o resto.
 */
export async function attributionSummary(
  db: SupabaseClient,
  accountId: string,
  period: { start: string; end: string },
): Promise<AttributionSummary> {
  const { data: conversationRows, error: conversationsError } = await db
    .from('conversations')
    .select('id, contact_id, ad_referral, site_ref')
    .eq('account_id', accountId)
    .gte('created_at', `${period.start}T00:00:00.000Z`)
    .lte('created_at', `${period.end}T23:59:59.999Z`)

  if (conversationsError) {
    throw new Error(`attributionSummary: falha ao buscar conversations: ${conversationsError.message}`)
  }

  const conversations = (conversationRows ?? []) as ConversationOriginRow[]

  const byOrigin = { ad: 0, site: 0, direct: 0 }
  const adConversations: ConversationOriginRow[] = []
  const siteConversations: ConversationOriginRow[] = []
  for (const conversation of conversations) {
    if (conversation.ad_referral) {
      byOrigin.ad++
      adConversations.push(conversation)
    } else if (conversation.site_ref) {
      byOrigin.site++
      siteConversations.push(conversation)
    } else {
      byOrigin.direct++
    }
  }

  // "Respondida" — apenas para as conversas de anúncio (só campo usado em
  // byAd). Uma query cobrindo todas as conversas de anúncio de uma vez.
  const adConversationIds = adConversations.map((c) => c.id)
  const repliedConversationIds = new Set<string>()
  if (adConversationIds.length > 0) {
    const { data: messageRows, error: messagesError } = await db
      .from('messages')
      .select('conversation_id')
      .in('conversation_id', adConversationIds)
      .in('sender_type', ['agent', 'bot'])

    if (messagesError) {
      throw new Error(`attributionSummary: falha ao buscar messages: ${messagesError.message}`)
    }
    for (const row of messageRows ?? []) {
      if (row.conversation_id) repliedConversationIds.add(row.conversation_id as string)
    }
  }

  // Contatos de conversas de anúncio que têm pelo menos um deal — sem
  // filtro de data (ver docstring).
  const adContactIds = [
    ...new Set(adConversations.map((c) => c.contact_id).filter((id): id is string => !!id)),
  ]
  const contactIdsWithDeal = new Set<string>()
  if (adContactIds.length > 0) {
    const { data: dealRows, error: dealsError } = await db
      .from('deals')
      .select('contact_id')
      .in('contact_id', adContactIds)

    if (dealsError) {
      throw new Error(`attributionSummary: falha ao buscar deals: ${dealsError.message}`)
    }
    for (const row of dealRows ?? []) {
      if (row.contact_id) contactIdsWithDeal.add(row.contact_id as string)
    }
  }

  const byAdMap = new Map<string, ByAdEntry>()
  for (const conversation of adConversations) {
    const sourceId = conversation.ad_referral?.source_id ?? null
    const key = sourceId ?? '(sem id)'
    let entry = byAdMap.get(key)
    if (!entry) {
      entry = {
        adId: sourceId,
        headline: conversation.ad_referral?.headline ?? null,
        conversations: 0,
        replied: 0,
        deals: 0,
      }
      byAdMap.set(key, entry)
    }
    entry.conversations++
    if (repliedConversationIds.has(conversation.id)) entry.replied++
    if (conversation.contact_id && contactIdsWithDeal.has(conversation.contact_id)) entry.deals++
  }

  const bySitePageMap = new Map<string, number>()
  for (const conversation of siteConversations) {
    const ref = conversation.site_ref as string
    bySitePageMap.set(ref, (bySitePageMap.get(ref) ?? 0) + 1)
  }

  return {
    byOrigin,
    byAd: [...byAdMap.values()],
    bySitePage: [...bySitePageMap.entries()].map(([ref, convCount]) => ({ ref, conversations: convCount })),
  }
}
