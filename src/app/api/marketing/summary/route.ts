// ============================================================
// GET /api/marketing/summary?period=7d|30d|90d
//
// Orchestrates the marketing dashboard's single read: current-period +
// previous-period metrics for every configured platform (GA4, Meta Ads),
// plus conversation-origin attribution — behind a 1h cache in
// `marketing_cache` (migration 040) keyed by (account, platform, period).
//
// Response shape (contract for Task 6's UI — do not change without
// reviewing that consumer):
//   {
//     period, ga4, metaAds,      // current period — see PlatformResult
//     attribution,               // AttributionSummary, always computed live
//     previous: { ga4, metaAds }, // same shapes, previous-period window
//     fetchedAt,                  // ISO timestamp of THIS response
//   }
//
// Per-platform `PlatformResult<T>` is one of:
//   - `null`               — platform not configured for this account.
//   - `T`                   — fresh data (from cache or a live fetch).
//   - `T & {stale, error}`  — the live fetch failed AND an old cache
//     entry existed; serves the stale entry with a flag + the error that
//     caused the fallback (dashboard shows a "data from <hour>" notice).
//   - `{error}`             — the live fetch failed and there was no
//     cache to fall back to.
//
// Cache reads/writes go through the service-role client
// (`supabaseAdmin()`, `src/lib/automations/admin-client.ts`) — writes
// bypass RLS by design (`marketing_cache` has no INSERT/UPDATE policy;
// migration 040 comment). Credentials + attribution reads go through the
// caller's RLS-scoped client (`ctx.supabase`) since those tables DO have
// member-readable SELECT policies.
// ============================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { periodWindow, isCacheFresh, type Period, type PeriodWindow } from '@/lib/marketing/period'
import { ga4Summary } from '@/lib/marketing/ga4'
import { metaAdsSummary } from '@/lib/marketing/meta-ads'
import { attributionSummary } from '@/lib/marketing/attribution'
import type { Ga4Summary, AdsSummary } from '@/lib/marketing/types'

type PlatformResult<T> = (T & { stale?: boolean; error?: string }) | { error: string } | null

type MarketingPlatform = 'ga4' | 'meta_ads'

interface IntegrationRow {
  platform: MarketingPlatform
  credentials: string
  config: Record<string, unknown>
}

/**
 * Reads (or refreshes) one cache slot: `platform` × `periodKey` (`'7d'`,
 * `'7d-prev'`, ...) for this account. Fresh cache (< 1h, `isCacheFresh`)
 * is served as-is. Otherwise calls `fetcher()`; success is cached and
 * returned; failure falls back to the stale cache entry (if any, flagged
 * `stale: true` + the error) or surfaces as `{error}` when there's
 * nothing to fall back to.
 */
async function resolvePlatform<T extends object>(
  admin: SupabaseClient,
  accountId: string,
  platform: MarketingPlatform,
  periodKey: string,
  now: Date,
  fetcher: () => Promise<T>,
): Promise<PlatformResult<T>> {
  const { data: cached, error: cacheReadError } = await admin
    .from('marketing_cache')
    .select('payload, fetched_at')
    .eq('account_id', accountId)
    .eq('platform', platform)
    .eq('period', periodKey)
    .maybeSingle()

  if (cacheReadError) {
    console.error(`[marketing/summary] cache read failed (${platform}/${periodKey}):`, cacheReadError)
  }

  if (cached && isCacheFresh(cached.fetched_at as string, now)) {
    return cached.payload as T
  }

  try {
    const fresh = await fetcher()
    const { error: cacheWriteError } = await admin.from('marketing_cache').upsert(
      {
        account_id: accountId,
        platform,
        period: periodKey,
        payload: fresh,
        fetched_at: now.toISOString(),
      },
      { onConflict: 'account_id,platform,period' },
    )
    if (cacheWriteError) {
      console.error(`[marketing/summary] cache write failed (${platform}/${periodKey}):`, cacheWriteError)
    }
    return fresh
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro desconhecido'
    console.error(`[marketing/summary] fetch failed (${platform}/${periodKey}):`, message)
    if (cached) {
      return { ...(cached.payload as T), stale: true, error: message }
    }
    return { error: message }
  }
}

/**
 * Decrypts + fetches both the current AND previous window for one
 * platform, sharing the decrypted credentials between the two calls.
 * Returns `{current: null, previous: null}` when the platform isn't
 * configured; a decrypt failure (e.g. `ENCRYPTION_KEY` rotated since the
 * credential was saved) surfaces as the same `{error}` shape a live API
 * failure would, on both windows.
 */
async function loadPlatformPair<T extends object>(args: {
  admin: SupabaseClient
  accountId: string
  platform: MarketingPlatform
  period: Period
  now: Date
  window: PeriodWindow
  integration: IntegrationRow | null
  decryptCredentials: (raw: string) => unknown
  fetchSummary: (
    credentials: unknown,
    config: Record<string, unknown>,
    window: { start: string; end: string },
  ) => Promise<T>
}): Promise<{ current: PlatformResult<T>; previous: PlatformResult<T> }> {
  const { admin, accountId, platform, period, now, window, integration, decryptCredentials, fetchSummary } = args
  if (!integration) return { current: null, previous: null }

  let credentials: unknown
  try {
    credentials = decryptCredentials(integration.credentials)
  } catch (err) {
    console.error(`[marketing/summary] ${platform} credential decrypt failed:`, err)
    const error = {
      error: 'Credenciais corrompidas — reconfigure esta integração em Configurações.',
    }
    return { current: error, previous: error }
  }

  const current = await resolvePlatform(admin, accountId, platform, period, now, () =>
    fetchSummary(credentials, integration.config, { start: window.start, end: window.end }),
  )
  const previous = await resolvePlatform(admin, accountId, platform, `${period}-prev`, now, () =>
    fetchSummary(credentials, integration.config, { start: window.prevStart, end: window.prevEnd }),
  )
  return { current, previous }
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()

    const url = new URL(request.url)
    const periodParam = url.searchParams.get('period') ?? '7d'
    if (periodParam !== '7d' && periodParam !== '30d' && periodParam !== '90d') {
      return NextResponse.json(
        { error: "'period' deve ser '7d', '30d' ou '90d'" },
        { status: 400 },
      )
    }
    const period: Period = periodParam

    const now = new Date()
    const window = periodWindow(period, now)

    const { data: integrationRows, error: integrationsError } = await ctx.supabase
      .from('marketing_integrations')
      .select('platform, credentials, config')
      .eq('account_id', ctx.accountId)
      .in('platform', ['ga4', 'meta_ads'])

    if (integrationsError) {
      console.error('[GET /api/marketing/summary] integrations fetch error:', integrationsError)
      return NextResponse.json({ error: 'Falha ao carregar integrações' }, { status: 500 })
    }

    const rows = (integrationRows ?? []) as IntegrationRow[]
    const ga4Integration = rows.find((row) => row.platform === 'ga4') ?? null
    const metaIntegration = rows.find((row) => row.platform === 'meta_ads') ?? null

    const admin = supabaseAdmin()

    const [ga4Pair, metaPair, attribution] = await Promise.all([
      loadPlatformPair<Ga4Summary>({
        admin,
        accountId: ctx.accountId,
        platform: 'ga4',
        period,
        now,
        window,
        integration: ga4Integration,
        decryptCredentials: (raw) => JSON.parse(decrypt(raw)) as { serviceAccountJson: string },
        fetchSummary: (credentials, config, win) => {
          const { serviceAccountJson } = credentials as { serviceAccountJson: string }
          return ga4Summary({ serviceAccountJson, propertyId: config.propertyId as string, period: win })
        },
      }),
      loadPlatformPair<AdsSummary>({
        admin,
        accountId: ctx.accountId,
        platform: 'meta_ads',
        period,
        now,
        window,
        integration: metaIntegration,
        decryptCredentials: (raw) => JSON.parse(decrypt(raw)) as { accessToken: string },
        fetchSummary: (credentials, config, win) => {
          const { accessToken } = credentials as { accessToken: string }
          return metaAdsSummary({ accessToken, adAccountId: config.adAccountId as string, period: win })
        },
      }),
      attributionSummary(ctx.supabase, ctx.accountId, { start: window.start, end: window.end }),
    ])

    return NextResponse.json({
      period,
      ga4: ga4Pair.current,
      metaAds: metaPair.current,
      attribution,
      previous: {
        ga4: ga4Pair.previous,
        metaAds: metaPair.previous,
      },
      fetchedAt: now.toISOString(),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
