// Helpers puros (sem I/O) para o dashboard de marketing — janela de
// período/anterior e decisão de cache fresh/stale. Espelham o padrão de
// `site-ref.ts`: funções pequenas, testadas via TDD, sem dependências de
// Supabase/rede, `now`/`fetchedAt` sempre injetados (nunca `Date.now()`
// lido internamente) para os testes controlarem o relógio.

export type Period = '7d' | '30d' | '90d'

export interface PeriodWindow {
  /** YYYY-MM-DD, início do período atual (inclusive, UTC). */
  start: string
  /** YYYY-MM-DD, hoje (inclusive, UTC). */
  end: string
  /** YYYY-MM-DD, início do período anterior de mesmo tamanho. */
  prevStart: string
  /** YYYY-MM-DD, fim do período anterior (dia imediatamente antes de `start`). */
  prevEnd: string
}

const PERIOD_DAYS: Record<Period, number> = { '7d': 7, '30d': 30, '90d': 90 }

// 1h — mesmo valor documentado na migração 040 / plano da Task 5.
const CACHE_FRESH_MS = 60 * 60 * 1000

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Soma `days` (pode ser negativo) a uma data YYYY-MM-DD, em UTC. */
function addDaysUTC(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return toDateOnly(date)
}

/**
 * Janela do período (N dias terminando hoje, UTC, ambas as pontas
 * inclusive) e do período imediatamente anterior de mesmo tamanho — usada
 * para calcular deltas. Ex.: `period='7d'`, hoje=11/07 → atual
 * [05/07, 11/07], anterior [28/06, 04/07] (também 7 dias, terminando no
 * dia anterior ao início do atual, sem sobreposição nem gap).
 */
export function periodWindow(period: Period, now: Date): PeriodWindow {
  const days = PERIOD_DAYS[period]
  const end = toDateOnly(now)
  const start = addDaysUTC(end, -(days - 1))
  const prevEnd = addDaysUTC(start, -1)
  const prevStart = addDaysUTC(prevEnd, -(days - 1))
  return { start, end, prevStart, prevEnd }
}

/**
 * `true` quando `fetchedAt` (timestamp ISO de `marketing_cache.fetched_at`)
 * tem menos de 1h em relação a `now`. Um timestamp ilegível é tratado como
 * não-fresh (força um novo fetch) em vez de lançar — o cache é uma
 * otimização, nunca deve derrubar a rota de summary.
 */
export function isCacheFresh(fetchedAt: string, now: Date): boolean {
  const fetchedMs = new Date(fetchedAt).getTime()
  if (Number.isNaN(fetchedMs)) return false
  return now.getTime() - fetchedMs < CACHE_FRESH_MS
}
