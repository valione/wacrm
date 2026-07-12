"use client"

import { useEffect, useMemo, useRef, useState } from 'react'
import { LineChart } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { formatCurrency } from '@/lib/currency'
import { EmptyState } from '@/components/dashboard/empty-state'
import { Skeleton } from '@/components/dashboard/skeleton'

/** One merged day of the marketing series (all sources zero-filled). */
export interface MarketingTrendPoint {
  date: string /*YYYY-MM-DD*/
  spend: number
  leads: number
  conversations: number
}

// Same fixed-viewBox SVG approach as the dashboard's conversations
// chart (see conversations-chart.tsx) — everything is drawn in viewBox
// coordinates and scaled by CSS, keeping the math resolution-agnostic.
const VB_W = 760
const VB_H = 240
// Extra right padding vs the dashboard chart: this one has a second
// (counts) axis on the right edge.
const PADDING = { top: 16, right: 44, bottom: 28, left: 52 }

const COLOR = {
  spend: '#f59e0b',
  leads: '#3b82f6',
  conversations: '#7c3aed',
} as const

/**
 * Line chart for the marketing dashboard: ad spend, ad leads and
 * WhatsApp conversations per day. Spend lives on its own left axis
 * (currency); leads + conversations share the right axis (counts) —
 * a single scale would flatten whichever unit is smaller.
 */
export function MarketingTrendChart({
  data,
  loading,
  currency,
}: {
  data: MarketingTrendPoint[] | null
  loading: boolean
  currency: string
}) {
  const t = useTranslations('Marketing.chart')

  const { maxSpend, maxCount } = useMemo(() => {
    const arr = data ?? []
    return {
      maxSpend: niceCeil(arr.reduce((m, p) => Math.max(m, p.spend), 0)),
      maxCount: niceCeil(
        arr.reduce((m, p) => Math.max(m, p.leads, p.conversations), 0),
      ),
    }
  }, [data])

  const empty =
    !!data && data.every((p) => p.spend === 0 && p.leads === 0 && p.conversations === 0)

  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
      </header>

      <div className="p-5">
        {loading || !data ? (
          <Skeleton className="h-[240px] w-full" />
        ) : empty ? (
          <EmptyState icon={LineChart} title={t('noData')} hint={t('noDataHint')} />
        ) : (
          <TrendSvg data={data} maxSpend={maxSpend} maxCount={maxCount} currency={currency} t={t} />
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-4 border-t border-border px-5 py-3 text-xs text-muted-foreground">
        <LegendDot color={COLOR.spend} label={t('spend')} />
        <LegendDot color={COLOR.leads} label={t('leads')} />
        <LegendDot color={COLOR.conversations} label={t('conversations')} />
      </footer>
    </section>
  )
}

function TrendSvg({
  data,
  maxSpend,
  maxCount,
  currency,
  t,
}: {
  data: MarketingTrendPoint[]
  maxSpend: number
  maxCount: number
  currency: string
  t: ReturnType<typeof useTranslations>
}) {
  const [hover, setHover] = useState<{ idx: number; tooltipLeftPx: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const chartW = VB_W - PADDING.left - PADDING.right
  const chartH = VB_H - PADDING.top - PADDING.bottom

  const stepX = data.length > 1 ? chartW / (data.length - 1) : 0
  const xFor = (i: number) => PADDING.left + i * stepX
  const ySpend = (v: number) =>
    maxSpend === 0 ? PADDING.top + chartH : PADDING.top + chartH - (v / maxSpend) * chartH
  const yCount = (v: number) =>
    maxCount === 0 ? PADDING.top + chartH : PADDING.top + chartH - (v / maxCount) * chartH

  const path = (get: (p: MarketingTrendPoint) => number, y: (v: number) => number) =>
    data.map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(i)},${y(get(p))}`).join(' ')

  // Gridlines follow the count axis (4 bands); the spend axis reuses the
  // same y positions with its own labels, so the grid stays uncluttered.
  const bands = [0, 0.25, 0.5, 0.75, 1]

  // CTM-based hover mapping — see the precision note in
  // conversations-chart.tsx (rect-based math breaks under the SVG's
  // default letterboxing when the container is wider than the viewBox).
  useEffect(() => {
    const svg = svgRef.current
    const wrap = wrapRef.current
    if (!svg || !wrap) return
    const onMove = (e: MouseEvent) => {
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const local = pt.matrixTransform(ctm.inverse())
      if (local.x < PADDING.left - 8 || local.x > VB_W - PADDING.right + 8) {
        setHover(null)
        return
      }
      const idx = Math.max(
        0,
        Math.min(
          data.length - 1,
          Math.round(stepX === 0 ? 0 : (local.x - PADDING.left) / stepX),
        ),
      )
      const dataPointPt = svg.createSVGPoint()
      dataPointPt.x = PADDING.left + idx * stepX
      dataPointPt.y = 0
      const screen = dataPointPt.matrixTransform(ctm)
      setHover({ idx, tooltipLeftPx: screen.x - wrap.getBoundingClientRect().left })
    }
    const onLeave = () => setHover(null)
    svg.addEventListener('mousemove', onMove)
    svg.addEventListener('mouseleave', onLeave)
    return () => {
      svg.removeEventListener('mousemove', onMove)
      svg.removeEventListener('mouseleave', onLeave)
    }
  }, [data, stepX])

  const hovered = hover !== null ? data[hover.idx] : null
  const hoverX = hover !== null ? xFor(hover.idx) : 0
  const labelStride = Math.max(1, Math.ceil(data.length / 6))

  return (
    <div ref={wrapRef} className="relative w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="h-[240px] w-full"
        role="img"
        aria-label={t('ariaLabel')}
      >
        {bands.map((f) => {
          const y = PADDING.top + chartH - f * chartH
          return (
            <g key={f}>
              <line
                x1={PADDING.left}
                x2={VB_W - PADDING.right}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeDasharray="3 3"
              />
              {/* Left: spend scale */}
              <text
                x={PADDING.left - 8}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {compactCurrency(f * maxSpend, currency)}
              </text>
              {/* Right: counts scale */}
              <text
                x={VB_W - PADDING.right + 8}
                y={y}
                textAnchor="start"
                dominantBaseline="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {Math.round(f * maxCount)}
              </text>
            </g>
          )
        })}

        {data.map((p, i) =>
          i % labelStride === 0 ? (
            <text
              key={p.date}
              x={xFor(i)}
              y={VB_H - 8}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {shortDayLabel(p.date)}
            </text>
          ) : null,
        )}

        <path d={path((p) => p.spend, ySpend)} fill="none" stroke={COLOR.spend} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <path d={path((p) => p.leads, yCount)} fill="none" stroke={COLOR.leads} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <path d={path((p) => p.conversations, yCount)} fill="none" stroke={COLOR.conversations} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

        {hover !== null && (
          <g pointerEvents="none">
            <line
              x1={hoverX}
              x2={hoverX}
              y1={PADDING.top}
              y2={PADDING.top + chartH}
              stroke="var(--muted-foreground)"
              strokeDasharray="3 3"
            />
            <circle cx={hoverX} cy={ySpend(data[hover.idx].spend)} r={3.5} fill={COLOR.spend} />
            <circle cx={hoverX} cy={yCount(data[hover.idx].leads)} r={3.5} fill={COLOR.leads} />
            <circle cx={hoverX} cy={yCount(data[hover.idx].conversations)} r={3.5} fill={COLOR.conversations} />
          </g>
        )}
      </svg>

      {hovered && hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] shadow-lg"
          style={{ left: `${hover.tooltipLeftPx}px` }}
        >
          <div className="font-medium text-popover-foreground">{longDayLabel(hovered.date)}</div>
          <div className="mt-1 flex flex-col gap-0.5">
            <TooltipRow color={COLOR.spend} label={t('spend')} value={formatCurrency(hovered.spend, currency)} />
            <TooltipRow color={COLOR.leads} label={t('leads')} value={hovered.leads.toLocaleString()} />
            <TooltipRow color={COLOR.conversations} label={t('conversations')} value={hovered.conversations.toLocaleString()} />
          </div>
        </div>
      )}
    </div>
  )
}

function TooltipRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5 text-popover-foreground">
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}: {value}
    </span>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}

/** Axis-label currency: symbol + compact number ("R$ 1,2 mil" is too long). */
function compactCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)
  } catch {
    return value.toFixed(0)
  }
}

function shortDayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function longDayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

/** Same "nice ceiling" as the dashboard chart (1/2/5×10ⁿ). */
function niceCeil(max: number): number {
  if (max <= 0) return 4
  const pow = Math.pow(10, Math.floor(Math.log10(max)))
  const normalised = max / pow
  let nice: number
  if (normalised <= 1) nice = 1
  else if (normalised <= 2) nice = 2
  else if (normalised <= 5) nice = 5
  else nice = 10
  return nice * pow
}
