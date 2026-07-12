// ============================================================
// /api/marketing/integrations
//
//   GET    — list this account's configured platforms (never
//            credentials — only `{platform, configured: true, config}`).
//   POST   — connect/update a platform. Body: `{platform, credentials,
//            config}`. Validates against the REAL provider BEFORE writing
//            anything (422 with the provider's own error message if that
//            fails), then encrypts `credentials` and upserts.
//   DELETE — disconnect a platform. Body: `{platform}`.
//
// Auth: `marketing_integrations` INSERT/UPDATE/DELETE are admin-only by
// RLS (migration 040, same settings-class pattern as `api_keys`). GET
// stays open to any member (viewer+), matching the SELECT policy.
//   - POST uses `getCurrentAccount()` (not `requireRole`) and the
//     RLS-scoped user client for the upsert, deliberately letting RLS be
//     the actual authority — the WITH CHECK failure (SQLSTATE 42501) is
//     translated into a clear 403 instead of a generic 500. Mirrors
//     `src/app/api/account/members/[userId]/route.ts`.
//   - DELETE uses `requireRole('admin')` instead, because a DELETE's
//     RLS `USING` clause doesn't raise on a disallowed row — it just
//     makes it invisible, so the delete would silently affect 0 rows.
//     A pre-check is the only way to surface a real 403 there.
// ============================================================

import { NextResponse } from 'next/server'
import type { PostgrestError } from '@supabase/supabase-js'

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { ga4ValidateCredentials } from '@/lib/marketing/ga4'

// Truncate provider error messages before they reach the client — same
// 300-char budget the marketing API clients themselves use for error
// bodies (ga4.ts / meta-ads.ts), so nothing unbounded (or a stray secret
// echoed back by the provider) ends up in the response.
const ERROR_MESSAGE_MAX_LEN = 300

const META_API_VERSION = 'v21.0'

function forbiddenResponse(action: 'salvar' | 'remover'): NextResponse {
  return NextResponse.json(
    { error: `Apenas administradores podem ${action} integrações de marketing.` },
    { status: 403 },
  )
}

function rlsErrorToResponse(err: PostgrestError, action: 'salvar' | 'remover'): NextResponse {
  if (err.code === '42501') return forbiddenResponse(action)
  console.error(`[marketing/integrations] ${action} error:`, err)
  return NextResponse.json(
    { error: `Falha ao ${action} a integração` },
    { status: 500 },
  )
}

function yesterdayUTC(now: Date): string {
  const d = new Date(now)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Valida as credenciais chamando o provedor de verdade, ANTES de gravar
 * qualquer coisa. GA4: `ga4ValidateCredentials` — JWT de service account +
 * troca por access_token + UM runReport mínimo de 1 dia (ontem, só
 * sessions). Meta: `GET /act_{id}?fields=name` — chamada mínima que
 * confirma token + ad_account_id sem gastar cota de /insights.
 *
 * Retorna a mensagem de erro (truncada, sem credencial) quando a
 * validação falha; `null` quando passou.
 */
async function validateCredentials(
  platform: 'ga4' | 'meta_ads',
  credentials: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<string | null> {
  try {
    if (platform === 'ga4') {
      const serviceAccountJson = credentials.serviceAccountJson
      const propertyId = config.propertyId
      if (typeof serviceAccountJson !== 'string' || typeof propertyId !== 'string' || !propertyId) {
        return "GA4 requer 'credentials.serviceAccountJson' (string) e 'config.propertyId'"
      }
      await ga4ValidateCredentials({ serviceAccountJson, propertyId, date: yesterdayUTC(new Date()) })
      return null
    }

    const accessToken = credentials.accessToken
    const adAccountId = config.adAccountId
    if (typeof accessToken !== 'string' || typeof adAccountId !== 'string' || !adAccountId) {
      return "Meta Ads requer 'credentials.accessToken' (string) e 'config.adAccountId'"
    }
    const response = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/act_${adAccountId}?fields=name`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return `Meta Ads rejeitou as credenciais: ${response.status} ${body}`
    }
    return null
  } catch (err) {
    return err instanceof Error ? err.message : 'Erro desconhecido ao validar as credenciais'
  }
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    const { data, error } = await ctx.supabase
      .from('marketing_integrations')
      .select('platform, config')
      .eq('account_id', ctx.accountId)

    if (error) {
      console.error('[GET /api/marketing/integrations] fetch error:', error)
      return NextResponse.json({ error: 'Falha ao carregar integrações' }, { status: 500 })
    }

    return NextResponse.json(
      (data ?? []).map((row) => ({ platform: row.platform, configured: true, config: row.config })),
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()

    const body = (await request.json().catch(() => null)) as {
      platform?: unknown
      credentials?: unknown
      config?: unknown
    } | null

    const platform = body?.platform
    if (platform !== 'ga4' && platform !== 'meta_ads') {
      return NextResponse.json(
        { error: "'platform' deve ser 'ga4' ou 'meta_ads' (Google Ads ainda não é suportado)" },
        { status: 400 },
      )
    }

    const credentials = body?.credentials
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      return NextResponse.json({ error: "'credentials' é obrigatório e deve ser um objeto" }, { status: 400 })
    }

    const config =
      body?.config && typeof body.config === 'object' && !Array.isArray(body.config)
        ? (body.config as Record<string, unknown>)
        : {}

    const validationError = await validateCredentials(
      platform,
      credentials as Record<string, unknown>,
      config,
    )
    if (validationError) {
      return NextResponse.json(
        { error: validationError.slice(0, ERROR_MESSAGE_MAX_LEN) },
        { status: 422 },
      )
    }

    let encryptedCredentials: string
    try {
      encryptedCredentials = encrypt(JSON.stringify(credentials))
    } catch (err) {
      console.error('[POST /api/marketing/integrations] encryption failed:', err)
      return NextResponse.json({ error: 'Falha ao criptografar as credenciais' }, { status: 500 })
    }

    // Client do USUÁRIO (RLS-scoped), não o admin — a RLS de
    // marketing_integrations é a autoridade real sobre quem pode
    // escrever (admin+); só traduzimos o erro dela para 403 acima.
    //
    // Duas formas de bloqueio distintas aqui, ambas tratadas como 403:
    //   - primeira config (INSERT): a policy INSERT tem WITH CHECK, e
    //     Postgres RAISES SQLSTATE 42501 quando ela falha — cai no
    //     branch `error`.
    //   - reconfiguração (UPDATE, linha já existe): a policy UPDATE só
    //     tem USING (sem WITH CHECK explícito), que filtra a linha
    //     ANTES do update em vez de lançar erro — o upsert simplesmente
    //     não afeta nenhuma linha, `error` fica null e `data` vem
    //     vazio. Sem essa checagem extra, esse caminho cairia num 500
    //     genérico em vez do 403 claro que a Task 5 pede.
    const { data, error } = await ctx.supabase
      .from('marketing_integrations')
      .upsert(
        {
          account_id: ctx.accountId,
          platform,
          credentials: encryptedCredentials,
          config,
        },
        { onConflict: 'account_id,platform' },
      )
      .select('platform, config')
      .maybeSingle()

    if (error) {
      return rlsErrorToResponse(error, 'salvar')
    }
    if (!data) {
      return forbiddenResponse('salvar')
    }

    return NextResponse.json({ platform: data.platform, configured: true, config: data.config })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    // `requireRole('admin')` here, unlike the RLS-translation dance in
    // POST above: a DELETE's RLS `USING` clause just makes disallowed
    // rows invisible — a non-admin's DELETE would silently affect 0
    // rows and still return `{success: true}`, not a 42501 error. A
    // pre-check is the only way to give a real 403 instead of a quiet
    // no-op.
    const ctx = await requireRole('admin')

    const body = (await request.json().catch(() => null)) as { platform?: unknown } | null
    const platform = body?.platform
    if (platform !== 'ga4' && platform !== 'meta_ads' && platform !== 'google_ads') {
      return NextResponse.json(
        { error: "'platform' deve ser 'ga4', 'meta_ads' ou 'google_ads'" },
        { status: 400 },
      )
    }

    const { error } = await ctx.supabase
      .from('marketing_integrations')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('platform', platform)

    if (error) {
      return rlsErrorToResponse(error, 'remover')
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
