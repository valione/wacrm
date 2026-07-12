"use client"

// Marketing dashboard (spec: docs/superpowers/specs/2026-07-12-marketing-
// dashboard-design.md, metrics 1–38). One fetch per period against
// GET /api/marketing/summary (cached server-side for 1h), plus a local
// conversations-per-day series read straight from Supabase (same
// client-side bucketing pattern as src/lib/dashboard/queries.ts).
//
// Per-platform results follow the route's PlatformResult contract:
// null = not configured; data (optionally stale+error) = show it, with a
// stale notice; {error} only = error card with a "reconfigure" path that
// never takes down the other platforms.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  AlertTriangle,
  DollarSign,
  Globe,
  Megaphone,
  MessageSquare,
  Settings,
  Target,
  UserPlus,
  Users,
} from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import type { AdsSummary, AttributionSummary, Ga4Summary } from '@/lib/marketing/types'

import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { EmptyState } from '@/components/dashboard/empty-state'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  MarketingTrendChart,
  type MarketingTrendPoint,
} from '@/components/marketing/trend-chart'

type Period = '7d' | '30d' | '90d'
const PERIODS: Period[] = ['7d', '30d', '90d']
const PERIOD_DAYS: Record<Period, number> = { '7d': 7, '30d': 30, '90d': 90 }

/** Mirror of the summary route's per-platform result union. */
type PlatformResult<T> = (T & { stale?: boolean; error?: string }) | { error: string } | null

interface SummaryResponse {
  period: Period
  ga4: PlatformResult<Ga4Summary>
  metaAds: PlatformResult<AdsSummary>
  attribution: AttributionSummary | { error: string }
  previous: {
    ga4: PlatformResult<Ga4Summary>
    metaAds: PlatformResult<AdsSummary>
  }
  fetchedAt: string
}

// --- PlatformResult narrowing -------------------------------------------
// A stale fallback carries data AND an error, so "has data" is keyed on a
// field that only the real payload has — not on the absence of `error`.

function adsData(r: PlatformResult<AdsSummary>): (AdsSummary & { stale?: boolean; error?: string }) | null {
  return r && 'spend' in r ? r : null
}

function ga4Data(r: PlatformResult<Ga4Summary>): (Ga4Summary & { stale?: boolean; error?: string }) | null {
  return r && 'sessions' in r ? r : null
}

function attrData(a: SummaryResponse['attribution'] | undefined): AttributionSummary | null {
  return a && 'byOrigin' in a ? a : null
}

function errorOf(r: object | null | undefined): string | null {
  return r && 'error' in r && typeof r.error === 'string' ? r.error : null
}

export default function MarketingPage() {
  const t = useTranslations('Marketing')
  const { defaultCurrency } = useAuth()

  const [period, setPeriod] = useState<Period>('30d')
  // Cache per period so switching back is instant (dashboard pattern).
  const [summaries, setSummaries] = useState<Record<Period, SummaryResponse | null>>({
    '7d': null,
    '30d': null,
    '90d': null,
  })
  const [convSeries, setConvSeries] = useState<Record<Period, Map<string, number> | null>>({
    '7d': null,
    '30d': null,
    '90d': null,
  })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  // Sem setState síncrono aqui — quem chama (handlers de evento) liga o
  // loading antes; o effect inicial conta com o estado inicial `true`
  // (mesmo padrão do dashboard, exigido pela regra set-state-in-effect).
  const loadPeriod = useCallback(
    (p: Period) => {
      const summaryPromise = fetch(`/api/marketing/summary?period=${p}`, { cache: 'no-store' })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return (await res.json()) as SummaryResponse
        })
      const conversationsPromise = loadConversationsPerDay(p)

      void Promise.all([summaryPromise, conversationsPromise])
        .then(([summary, conversations]) => {
          setSummaries((prev) => ({ ...prev, [p]: summary }))
          setConvSeries((prev) => ({ ...prev, [p]: conversations }))
        })
        .catch((err) => {
          console.error('[marketing] summary failed:', err)
          setLoadError(true)
        })
        .finally(() => setLoading(false))
    },
    [],
  )

  useEffect(() => {
    loadPeriod('30d')
  }, [loadPeriod])

  const handlePeriodChange = (p: Period) => {
    setPeriod(p)
    if (summaries[p] === null) {
      setLoading(true)
      setLoadError(false)
      loadPeriod(p)
    }
  }

  const handleRetry = () => {
    setLoading(true)
    setLoadError(false)
    loadPeriod(period)
  }

  const summary = summaries[period]
  const ads = summary ? adsData(summary.metaAds) : null
  const ga4 = summary ? ga4Data(summary.ga4) : null
  const attribution = summary ? attrData(summary.attribution) : null
  const prevAds = summary ? adsData(summary.previous.metaAds) : null
  const prevGa4 = summary ? ga4Data(summary.previous.ga4) : null

  const notConfigured = !!summary && summary.ga4 === null && summary.metaAds === null

  const conversationsTotal = attribution
    ? attribution.byOrigin.ad + attribution.byOrigin.site + attribution.byOrigin.direct
    : null

  const trendData: MarketingTrendPoint[] | null = summary
    ? mergeTrend(period, ads?.daily ?? [], convSeries[period])
    : null

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => handlePeriodChange(p)}
              className={
                period === p
                  ? 'rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground'
                  : 'rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground'
              }
            >
              {t('days', { count: PERIOD_DAYS[p] })}
            </button>
          ))}
        </div>
      </div>

      {loadError ? (
        <div className="rounded-xl border border-border bg-card p-6">
          <EmptyState icon={AlertTriangle} title={t('loadError')} hint={t('loadErrorHint')} />
          <div className="mt-4 flex justify-center">
            <Button variant="outline" onClick={handleRetry}>
              {t('retry')}
            </Button>
          </div>
        </div>
      ) : loading || !summary ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : notConfigured ? (
        <div className="rounded-xl border border-border bg-card p-6">
          <EmptyState icon={Megaphone} title={t('notConfigured')} hint={t('notConfiguredHint')} />
          <div className="mt-4 flex justify-center">
            <Button render={<Link href="/settings?tab=marketing" />}>
              <Settings className="size-4" />
              {t('goToSettings')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* Summary cards (metrics 1–6) */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <MetricCard
              title={t('cards.spend')}
              value={ads ? formatCurrency(ads.spend, defaultCurrency) : '—'}
              icon={DollarSign}
              delta={deltaProps(ads?.spend, prevAds?.spend, t)}
              subtitle={ads ? undefined : t('cards.needsMeta')}
            />
            <MetricCard
              title={t('cards.adLeads')}
              value={ads ? ads.leads.toLocaleString() : '—'}
              icon={UserPlus}
              delta={deltaProps(ads?.leads, prevAds?.leads, t)}
              subtitle={ads ? undefined : t('cards.needsMeta')}
            />
            <MetricCard
              title={t('cards.cpl')}
              value={
                ads && ads.leads > 0 ? formatCurrency(ads.spend / ads.leads, defaultCurrency) : '—'
              }
              icon={Target}
              delta={deltaProps(
                ads && ads.leads > 0 ? ads.spend / ads.leads : undefined,
                prevAds && prevAds.leads > 0 ? prevAds.spend / prevAds.leads : undefined,
                t,
                // For a cost metric, going DOWN is the good direction —
                // flip the arrow tone so a cheaper lead reads green.
                { invert: true },
              )}
              subtitle={ads && ads.leads > 0 ? undefined : t('cards.needsLeads')}
            />
            <MetricCard
              title={t('cards.sessions')}
              value={ga4 ? ga4.sessions.toLocaleString() : '—'}
              icon={Globe}
              delta={deltaProps(ga4?.sessions, prevGa4?.sessions, t)}
              subtitle={ga4 ? undefined : t('cards.needsGa4')}
            />
            <MetricCard
              title={t('cards.conversations')}
              value={conversationsTotal !== null ? conversationsTotal.toLocaleString() : '—'}
              icon={MessageSquare}
              subtitle={t('cards.fromCrm')}
            />
            <MetricCard
              title={t('cards.adConversations')}
              value={attribution ? attribution.byOrigin.ad.toLocaleString() : '—'}
              icon={Megaphone}
              subtitle={t('cards.fromCrm')}
            />
          </div>

          {/* Per-platform stale/error notices */}
          <PlatformNotices summary={summary} t={t} />

          {/* Daily trend (metrics 7–9) */}
          <MarketingTrendChart data={trendData} loading={false} currency={defaultCurrency} />

          {/* Meta Ads campaigns (metrics 10–18) */}
          {summary.metaAds !== null && (
            <MetaAdsSection result={summary.metaAds} currency={defaultCurrency} t={t} />
          )}

          {/* GA4 (metrics 27–33 + 37) */}
          {summary.ga4 !== null && <Ga4Section result={summary.ga4} t={t} />}

          {/* Attribution (metrics 34–36 + 38) */}
          <AttributionSection
            attribution={summary.attribution}
            adsSpend={ads?.spend ?? null}
            currency={defaultCurrency}
            t={t}
          />
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------
// Data helpers
// ------------------------------------------------------------

/**
 * Conversations created per UTC day for the period — read directly from
 * Supabase (RLS-scoped) and bucketed client-side, mirroring
 * loadConversationsSeries in src/lib/dashboard/queries.ts. UTC keys match
 * the summary route's periodWindow, so the merge with metaAds.daily lines
 * up day-by-day.
 */
async function loadConversationsPerDay(period: Period): Promise<Map<string, number>> {
  const days = PERIOD_DAYS[period]
  const start = new Date()
  start.setUTCDate(start.getUTCDate() - (days - 1))
  start.setUTCHours(0, 0, 0, 0)

  const db = createClient()
  const { data, error } = await db
    .from('conversations')
    .select('created_at')
    .gte('created_at', start.toISOString())
  if (error) throw error

  const buckets = new Map<string, number>()
  for (const row of (data ?? []) as { created_at: string }[]) {
    const key = row.created_at.slice(0, 10)
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  return buckets
}

/** Zero-filled merge of ad spend/leads and conversations onto the period's day grid. */
function mergeTrend(
  period: Period,
  adsDaily: AdsSummary['daily'],
  conversations: Map<string, number> | null,
): MarketingTrendPoint[] {
  const days = PERIOD_DAYS[period]
  const byDate = new Map(adsDaily.map((d) => [d.date, d]))
  const points: MarketingTrendPoint[] = []
  const cursor = new Date()
  cursor.setUTCDate(cursor.getUTCDate() - (days - 1))
  for (let i = 0; i < days; i++) {
    const key = cursor.toISOString().slice(0, 10)
    const ad = byDate.get(key)
    points.push({
      date: key,
      spend: ad?.spend ?? 0,
      leads: ad?.leads ?? 0,
      conversations: conversations?.get(key) ?? 0,
    })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return points
}

/** % delta vs the previous period, as MetricCard delta props (or undefined). */
function deltaProps(
  current: number | undefined,
  previous: number | undefined,
  t: ReturnType<typeof useTranslations>,
  opts?: { invert?: boolean },
): { sign: number; label: string } | undefined {
  if (current === undefined || previous === undefined || previous <= 0) return undefined
  const pct = ((current - previous) / previous) * 100
  const rounded = Math.round(pct * 10) / 10
  const sign = opts?.invert ? -rounded : rounded
  const label =
    rounded === 0
      ? t('cards.noChange')
      : `${rounded > 0 ? '+' : ''}${rounded.toLocaleString(undefined, { maximumFractionDigits: 1 })}% ${t('cards.vsPrevious')}`
  return { sign, label }
}

// ------------------------------------------------------------
// Notices (stale / error per platform)
// ------------------------------------------------------------

function PlatformNotices({
  summary,
  t,
}: {
  summary: SummaryResponse
  t: ReturnType<typeof useTranslations>
}) {
  const notices: { key: string; name: string; message: string; dataShown: boolean }[] = []

  const push = (key: string, name: string, result: PlatformResult<object>, dataShown: boolean) => {
    const error = errorOf(result)
    if (!error) return
    notices.push({ key, name, message: error, dataShown })
  }
  push('meta', t('metaName'), summary.metaAds, adsData(summary.metaAds) !== null)
  push('ga4', t('ga4Name'), summary.ga4, ga4Data(summary.ga4) !== null)
  if (errorOf(summary.attribution)) {
    notices.push({
      key: 'attribution',
      name: t('attribution.title'),
      message: errorOf(summary.attribution)!,
      dataShown: false,
    })
  }

  if (notices.length === 0) return null

  return (
    <div className="space-y-2">
      {notices.map((n) => (
        <div
          key={n.key}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-300"
        >
          <AlertTriangle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">{n.name}:</span>{' '}
            {n.dataShown ? t('staleNotice') : n.message}
          </span>
          <Link
            href="/settings?tab=marketing"
            className="shrink-0 font-medium underline underline-offset-2 hover:text-amber-200"
          >
            {t('reconfigure')}
          </Link>
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------
// Meta Ads section
// ------------------------------------------------------------

function MetaAdsSection({
  result,
  currency,
  t,
}: {
  result: PlatformResult<AdsSummary>
  currency: string
  t: ReturnType<typeof useTranslations>
}) {
  const data = adsData(result)

  return (
    <Section title={t('meta.title')} description={t('meta.description')}>
      {!data ? (
        <SectionError t={t} />
      ) : data.campaigns.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">{t('meta.noCampaigns')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <Th>{t('meta.campaign')}</Th>
                <Th>{t('meta.status')}</Th>
                <Th right>{t('meta.spend')}</Th>
                <Th right>{t('meta.impressions')}</Th>
                <Th right>{t('meta.reach')}</Th>
                <Th right>{t('meta.clicks')}</Th>
                <Th right>{t('meta.ctr')}</Th>
                <Th right>{t('meta.cpc')}</Th>
                <Th right>{t('meta.leads')}</Th>
                <Th right>{t('meta.cpl')}</Th>
                <Th right>{t('meta.frequency')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.campaigns.map((c) => (
                <tr key={c.id} className="border-b border-border/60 last:border-0">
                  <Td className="max-w-56">
                    <span className="block truncate font-medium text-foreground" title={c.name}>
                      {c.name}
                    </span>
                  </Td>
                  <Td>
                    <StatusBadge status={c.status} t={t} />
                  </Td>
                  <Td right>{formatCurrency(c.spend, currency)}</Td>
                  <Td right>{c.impressions.toLocaleString()}</Td>
                  <Td right>{c.reach !== null ? c.reach.toLocaleString() : '—'}</Td>
                  <Td right>{c.clicks.toLocaleString()}</Td>
                  <Td right>{fmtPct(c.ctr)}</Td>
                  <Td right>{formatCurrency(c.cpc, currency)}</Td>
                  <Td right>{c.leads.toLocaleString()}</Td>
                  <Td right>{c.leads > 0 ? formatCurrency(c.cpl, currency) : '—'}</Td>
                  <Td right>{c.frequency !== null ? c.frequency.toFixed(2) : '—'}</Td>
                </tr>
              ))}
              {/* Totals row (spend/leads come from the summary; the rest
                  sums client-side — same numbers Meta shows per column). */}
              <tr className="bg-muted/40 font-medium text-foreground">
                <Td>{t('meta.totals')}</Td>
                <Td>{''}</Td>
                <Td right>{formatCurrency(data.spend, currency)}</Td>
                <Td right>
                  {data.campaigns.reduce((s, c) => s + c.impressions, 0).toLocaleString()}
                </Td>
                <Td right>—</Td>
                <Td right>{data.campaigns.reduce((s, c) => s + c.clicks, 0).toLocaleString()}</Td>
                <Td right>—</Td>
                <Td right>—</Td>
                <Td right>{data.leads.toLocaleString()}</Td>
                <Td right>
                  {data.leads > 0 ? formatCurrency(data.spend / data.leads, currency) : '—'}
                </Td>
                <Td right>—</Td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

function StatusBadge({
  status,
  t,
}: {
  status: string
  t: ReturnType<typeof useTranslations>
}) {
  if (status === 'ACTIVE') {
    return (
      <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
        {t('meta.statusActive')}
      </Badge>
    )
  }
  if (status === 'PAUSED') {
    return <Badge variant="outline">{t('meta.statusPaused')}</Badge>
  }
  return <Badge variant="outline">{status}</Badge>
}

// ------------------------------------------------------------
// GA4 section
// ------------------------------------------------------------

function Ga4Section({
  result,
  t,
}: {
  result: PlatformResult<Ga4Summary>
  t: ReturnType<typeof useTranslations>
}) {
  const data = ga4Data(result)

  return (
    <Section title={t('ga4.title')} description={t('ga4.description')}>
      {!data ? (
        <SectionError t={t} />
      ) : (
        <div className="space-y-5 p-5">
          {/* Totals strip (27–31) */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label={t('ga4.sessions')} value={data.sessions.toLocaleString()} />
            <Stat label={t('ga4.totalUsers')} value={data.totalUsers.toLocaleString()} />
            <Stat label={t('ga4.newUsers')} value={data.newUsers.toLocaleString()} />
            <Stat label={t('ga4.engagementRate')} value={fmtPct(data.engagementRate * 100)} />
            <Stat label={t('ga4.avgSessionDuration')} value={fmtDuration(data.avgSessionDurationSec)} />
            <Stat label={t('ga4.conversions')} value={data.conversions.toLocaleString()} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            {/* Source / medium (32) */}
            <MiniTable
              title={t('ga4.sources')}
              headers={[t('ga4.sourceMedium'), t('ga4.sessions'), t('ga4.conversions')]}
              rows={data.sources.map((s) => [
                s.sourceMedium,
                s.sessions.toLocaleString(),
                s.conversions.toLocaleString(),
              ])}
              empty={t('ga4.noData')}
            />
            {/* Top pages (33) */}
            <MiniTable
              title={t('ga4.topPages')}
              headers={[t('ga4.path'), t('ga4.views')]}
              rows={data.topPages.map((p) => [p.path, p.views.toLocaleString()])}
              empty={t('ga4.noData')}
            />
          </div>

          {/* WhatsApp button clicks by session source (37) */}
          <MiniTable
            title={t('ga4.whatsappClicks')}
            headers={[t('ga4.sourceMedium'), t('ga4.clicks')]}
            rows={data.whatsappClicks.map((c) => [c.sourceMedium, c.clicks.toLocaleString()])}
            empty={t('ga4.whatsappClicksEmpty')}
          />
        </div>
      )}
    </Section>
  )
}

// ------------------------------------------------------------
// Attribution section
// ------------------------------------------------------------

function AttributionSection({
  attribution,
  adsSpend,
  currency,
  t,
}: {
  attribution: SummaryResponse['attribution']
  adsSpend: number | null
  currency: string
  t: ReturnType<typeof useTranslations>
}) {
  const data = attrData(attribution)

  return (
    <Section title={t('attribution.title')} description={t('attribution.description')}>
      {!data ? (
        <SectionError t={t} />
      ) : (
        <div className="space-y-5 p-5">
          {/* Conversations by origin (34) + cost per ad conversation (36) */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat icon={Megaphone} label={t('attribution.originAd')} value={data.byOrigin.ad.toLocaleString()} />
            <Stat icon={Globe} label={t('attribution.originSite')} value={data.byOrigin.site.toLocaleString()} />
            <Stat icon={Users} label={t('attribution.originDirect')} value={data.byOrigin.direct.toLocaleString()} />
            <Stat
              icon={DollarSign}
              label={t('attribution.costPerConversation')}
              value={
                adsSpend !== null && data.byOrigin.ad > 0
                  ? formatCurrency(adsSpend / data.byOrigin.ad, currency)
                  : '—'
              }
            />
          </div>

          {/* By source ad (35) */}
          <MiniTable
            title={t('attribution.byAd')}
            headers={[
              t('attribution.ad'),
              t('attribution.conversations'),
              t('attribution.repliedPct'),
              t('attribution.deals'),
            ]}
            rows={data.byAd.map((row) => [
              row.headline ?? row.adId ?? t('attribution.unknownAd'),
              row.conversations.toLocaleString(),
              row.conversations > 0 ? fmtPct((row.replied / row.conversations) * 100) : '—',
              row.deals.toLocaleString(),
            ])}
            empty={t('attribution.noAdConversations')}
          />

          {/* Site conversations by landing marker (38) */}
          <MiniTable
            title={t('attribution.bySitePage')}
            headers={[t('attribution.pageRef'), t('attribution.conversations')]}
            rows={data.bySitePage.map((row) => [row.ref, row.conversations.toLocaleString()])}
            empty={t('attribution.noSiteConversations')}
          />

          {/* Scope honesty (spec): traffic campaigns show spend but no
              attributed conversations — flag it so they don't read as
              underperforming. */}
          <p className="text-xs text-muted-foreground">{t('attribution.scopeNote')}</p>
        </div>
      )}
    </Section>
  )
}

// ------------------------------------------------------------
// Shared bits
// ------------------------------------------------------------

function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </header>
      {children}
    </section>
  )
}

/** Body of a section whose platform returned {error} with no cached data. */
function SectionError({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-6">
      <AlertTriangle className="size-4 text-amber-300" />
      <span className="text-sm text-muted-foreground">{t('sectionError')}</span>
      <Link
        href="/settings?tab=marketing"
        className="text-sm font-medium text-primary underline underline-offset-2"
      >
        {t('reconfigure')}
      </Link>
    </div>
  )
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: string
  icon?: React.ComponentType<{ className?: string }>
}) {
  return (
    <div className="rounded-lg border border-border bg-card-2 p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon ? <Icon className="size-3.5" /> : null}
        {label}
      </div>
      <div className="mt-1 text-lg font-bold tabular-nums text-foreground">{value}</div>
    </div>
  )
}

function MiniTable({
  title,
  headers,
  rows,
  empty,
}: {
  title: string
  headers: string[]
  rows: string[][]
  empty: string
}) {
  return (
    <div className="rounded-lg border border-border">
      <div className="border-b border-border px-4 py-2.5 text-xs font-semibold text-foreground">
        {title}
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                {headers.map((h, i) => (
                  <Th key={h} right={i > 0}>
                    {h}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((cells, ri) => (
                <tr key={ri} className="border-b border-border/40 last:border-0">
                  {cells.map((cell, ci) => (
                    <Td key={ci} right={ci > 0} className={ci === 0 ? 'max-w-64' : undefined}>
                      {ci === 0 ? (
                        <span className="block truncate" title={cell}>
                          {cell}
                        </span>
                      ) : (
                        cell
                      )}
                    </Td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-4 py-2 font-medium whitespace-nowrap ${right ? 'text-right' : ''}`}>
      {children}
    </th>
  )
}

function Td({
  children,
  right,
  className,
}: {
  children: React.ReactNode
  right?: boolean
  className?: string
}) {
  return (
    <td
      className={`px-4 py-2 whitespace-nowrap tabular-nums text-muted-foreground ${right ? 'text-right' : ''} ${className ?? ''}`}
    >
      {children}
    </td>
  )
}

function fmtPct(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
}

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
