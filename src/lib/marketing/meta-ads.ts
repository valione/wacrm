// Cliente da Meta Marketing API (Graph API) — insights de anúncios (Meta
// Ads / Facebook & Instagram). Espelha o padrão dos clientes irmãos
// (src/lib/whatsapp/meta-api.ts, src/lib/marketing/ga4.ts): fetch puro,
// erro `Meta Ads <path> falhou: <status> <corpo 300c>`, nada lança na
// importação do módulo — toda credencial chega por argumento, nunca de
// env. Token SEMPRE via header Authorization: Bearer, nunca em query —
// inclusive ao seguir paginação — porque o corpo de erro do Graph pode
// ecoar a URL da requisição, e isso não pode vazar o token em logs.

import type { AdsSummary, AdsCampaignRow, AdsDaily } from './types'

// Mesma versão usada em src/lib/whatsapp/meta-api.ts. Não exportada de lá
// (const module-local), então espelhada aqui de propósito — mudar uma
// exige revisar a outra.
const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

// action_types que contam como "lead" no resumo: lead ads tradicionais
// ('lead') e cliques de anúncio que abrem uma conversa de WhatsApp
// ('onsite_conversion.messaging_conversation_started_7d', clique-para-
// WhatsApp). Somados — um anúncio pode gerar os dois tipos de conversão
// dependendo do objetivo de campanha.
const LEAD_ACTION_TYPES = ['lead', 'onsite_conversion.messaging_conversation_started_7d']

// Trava de segurança contra paginação infinita (mesmo valor usado em
// src/app/api/whatsapp/templates/sync/route.ts para o mesmo endpoint).
const MAX_PAGES = 20

interface MetaAction {
  action_type?: string
  value?: string
}

interface MetaInsightRow {
  campaign_id?: string
  campaign_name?: string
  spend?: string
  impressions?: string
  reach?: string
  clicks?: string
  ctr?: string
  cpc?: string
  frequency?: string
  actions?: MetaAction[]
  date_start?: string
}

interface MetaCampaignStatusRow {
  id?: string
  name?: string
  status?: string
}

interface MetaListResponse<T> {
  data?: T[]
  paging?: { next?: string }
}

/**
 * Segue `paging.next` (URL completa devolvida pelo Graph) até esgotar ou
 * atingir MAX_PAGES. O token nunca entra na URL — cada página é buscada
 * com o mesmo header Authorization da primeira chamada.
 */
async function fetchAllPages<T>(
  initialUrl: string,
  accessToken: string,
  path: string,
): Promise<T[]> {
  const items: T[] = []
  let url: string | null = initialUrl
  let pageCount = 0
  while (url && pageCount < MAX_PAGES) {
    pageCount++
    const response: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Meta Ads ${path} falhou: ${response.status} ${body.slice(0, 300)}`)
    }
    const data: MetaListResponse<T> = await response.json()
    if (data.data) items.push(...data.data)
    url = data.paging?.next ?? null
  }
  return items
}

/** Números do Graph API vêm como strings — parseFloat em tudo. `undefined` → null. */
function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = parseFloat(value)
  return Number.isNaN(parsed) ? null : parsed
}

function numberOrZero(value: string | undefined): number {
  return numberOrNull(value) ?? 0
}

function leadsFromActions(actions: MetaAction[] | undefined): number {
  if (!actions) return 0
  return actions
    .filter((action) => action.action_type && LEAD_ACTION_TYPES.includes(action.action_type))
    .reduce((sum, action) => sum + (parseFloat(action.value ?? '0') || 0), 0)
}

function timeRangeParam(period: { start: string; end: string }): string {
  return JSON.stringify({ since: period.start, until: period.end })
}

/**
 * Busca o resumo Meta Ads do período: 3 chamadas ao Graph API (cada uma
 * seguindo sua própria paginação) — insights por campanha, série diária
 * da conta, e status das campanhas para merge. Sequenciais (não
 * Promise.all) de propósito: mantém a ordem de chamadas previsível e o
 * primeiro erro interrompe cedo, sem gastar as outras duas.
 *
 *   - campanhas: GET /act_{id}/insights?level=campaign&fields=campaign_id,
 *     campaign_name,spend,impressions,reach,clicks,ctr,cpc,frequency,
 *     actions&time_range={since,until}
 *   - série diária: mesmo endpoint com level=account&time_increment=1&
 *     fields=spend,actions
 *   - status: GET /act_{id}/campaigns?fields=id,name,status — merge por
 *     campaign_id. Campanha sem insights no período não entra no
 *     resultado (só linhas com dados de insight viram AdsCampaignRow).
 *     Insight sem status correspondente (ex.: campanha excluída) recebe
 *     status 'UNKNOWN'.
 */
export async function metaAdsSummary(args: {
  accessToken: string
  adAccountId: string
  period: { start: string; end: string }
}): Promise<AdsSummary> {
  const { accessToken, adAccountId, period } = args
  const timeRange = timeRangeParam(period)

  const campaignInsightsParams = new URLSearchParams({
    level: 'campaign',
    fields: 'campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpc,frequency,actions',
    time_range: timeRange,
  })
  const dailyInsightsParams = new URLSearchParams({
    level: 'account',
    time_increment: '1',
    fields: 'spend,actions',
    time_range: timeRange,
  })
  const statusParams = new URLSearchParams({ fields: 'id,name,status' })

  const campaignRows = await fetchAllPages<MetaInsightRow>(
    `${META_API_BASE}/act_${adAccountId}/insights?${campaignInsightsParams.toString()}`,
    accessToken,
    '/insights',
  )
  const dailyRows = await fetchAllPages<MetaInsightRow>(
    `${META_API_BASE}/act_${adAccountId}/insights?${dailyInsightsParams.toString()}`,
    accessToken,
    '/insights',
  )
  const statusRows = await fetchAllPages<MetaCampaignStatusRow>(
    `${META_API_BASE}/act_${adAccountId}/campaigns?${statusParams.toString()}`,
    accessToken,
    '/campaigns',
  )

  const statusById = new Map<string, string>()
  for (const row of statusRows) {
    if (row.id) statusById.set(row.id, row.status ?? 'UNKNOWN')
  }

  const campaigns: AdsCampaignRow[] = campaignRows.map((row) => {
    const spend = numberOrZero(row.spend)
    const leads = leadsFromActions(row.actions)
    const id = row.campaign_id ?? ''
    return {
      id,
      name: row.campaign_name ?? '',
      status: statusById.get(id) ?? 'UNKNOWN',
      spend,
      impressions: numberOrZero(row.impressions),
      reach: numberOrNull(row.reach),
      clicks: numberOrZero(row.clicks),
      ctr: numberOrZero(row.ctr),
      cpc: numberOrZero(row.cpc),
      leads,
      cpl: leads === 0 ? 0 : spend / leads,
      frequency: numberOrNull(row.frequency),
    }
  })

  const daily: AdsDaily[] = dailyRows.map((row) => ({
    date: row.date_start ?? '',
    spend: numberOrZero(row.spend),
    leads: leadsFromActions(row.actions),
  }))

  return {
    spend: campaigns.reduce((sum, c) => sum + c.spend, 0),
    leads: campaigns.reduce((sum, c) => sum + c.leads, 0),
    campaigns,
    daily,
  }
}
