// Shapes normalizados do dashboard de marketing — contrato entre as Tasks
// 2 (GA4), 3 (Meta Ads), 5 (rotas/atribuição) e 6 (UI). Ver
// docs/superpowers/plans/2026-07-12-marketing-dashboard.md, seção "Shapes
// normalizados": mudar aqui exige revisar quem consome cada campo.

export interface AdsCampaignRow {
  id: string
  name: string
  status: string
  spend: number
  impressions: number
  reach: number | null
  clicks: number
  ctr: number
  cpc: number
  leads: number
  cpl: number
  frequency: number | null
}

export interface AdsDaily {
  date: string /*YYYY-MM-DD*/
  spend: number
  leads: number
}

export interface AdsSummary {
  spend: number
  leads: number
  campaigns: AdsCampaignRow[]
  daily: AdsDaily[]
}

export interface Ga4Summary {
  sessions: number
  totalUsers: number
  newUsers: number
  engagementRate: number
  avgSessionDurationSec: number
  conversions: number
  sources: Array<{ sourceMedium: string; sessions: number; conversions: number }>
  topPages: Array<{ path: string; views: number }>
  whatsappClicks: Array<{ sourceMedium: string; clicks: number }> /*evento click_whatsapp; vazio se não configurado*/
}

export interface AttributionSummary {
  byOrigin: { ad: number; site: number; direct: number }
  byAd: Array<{
    adId: string | null
    headline: string | null
    conversations: number
    replied: number
    deals: number
  }>
  bySitePage: Array<{ ref: string; conversations: number }>
}
