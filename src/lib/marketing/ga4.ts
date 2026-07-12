// Cliente da Google Analytics Data API (GA4, v1beta) autenticado por service
// account (JWT RS256 assinado com node:crypto — sem lib de JWT). Espelha o
// papel dos clientes irmãos em src/lib/whatsapp/ (waha-api.ts, uazapi-api.ts):
// fetch puro, erro `<o-que> falhou: <status> <corpo 300c>`, nada lança na
// importação do módulo — toda credencial chega por argumento, nunca de env.

import crypto from 'node:crypto'
import type { Ga4Summary } from './types'

const GA4_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly'

function ga4ReportUrl(propertyId: string): string {
  return `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`
}

/**
 * Monta e assina (RS256) o JWT de autenticação de service account do Google
 * (RFC 7523 — JWT Bearer Grant). `nowSec` é injetado (em vez de lido de
 * Date.now() aqui dentro) para o teste conseguir decodificar iat/exp exatos
 * sem lidar com relógio. exp = iat + 3600 é o máximo aceito pelo Google.
 */
export function buildGa4Jwt(
  serviceAccount: { client_email: string; private_key: string },
  nowSec: number,
): string {
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iss: serviceAccount.client_email,
    scope: GA4_SCOPE,
    aud: GA4_TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  }
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const signingInput = `${encode(header)}.${encode(claims)}`

  const signer = crypto.createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  const signature = signer.sign(serviceAccount.private_key).toString('base64url')

  return `${signingInput}.${signature}`
}

/** Troca o JWT assinado por um access_token OAuth2 (grant JWT Bearer). */
async function ga4AccessToken(serviceAccount: { client_email: string; private_key: string }): Promise<string> {
  const jwt = buildGa4Jwt(serviceAccount, Math.floor(Date.now() / 1000))
  const response = await fetch(GA4_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`GA4 token exchange falhou: ${response.status} ${body.slice(0, 300)}`)
  }
  const data = await response.json()
  if (!data.access_token) throw new Error('GA4 token exchange: resposta sem access_token')
  return data.access_token
}

interface Ga4ReportRow {
  dimensionValues?: Array<{ value?: string }>
  metricValues?: Array<{ value?: string }>
}
interface Ga4ReportResponse {
  rows?: Ga4ReportRow[]
}

async function runGa4Report(
  propertyId: string,
  accessToken: string,
  body: Record<string, unknown>,
  label: string,
): Promise<Ga4ReportResponse> {
  const response = await fetch(ga4ReportUrl(propertyId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    throw new Error(`GA4 ${label} falhou: ${response.status} ${errBody.slice(0, 300)}`)
  }
  return response.json()
}

/**
 * Relatório de cliques no botão do WhatsApp (evento custom `click_whatsapp`,
 * configurado via gtag/GTM no site do cliente — ver docs/marketing.md da
 * Task 7). Nem toda propriedade GA4 tem esse evento configurado: a API pode
 * responder sem `rows` (sem dados) ou, em alguns casos, com erro (ex.: o
 * dimensionFilter não bate com nada rastreado ainda). Nenhum dos dois pode
 * derrubar o resumo inteiro — a UI mostra um empty-state explicando como
 * configurar o evento (Task 6), não um erro de página inteira.
 */
async function fetchWhatsappClicksRows(
  propertyId: string,
  accessToken: string,
  dateRanges: Array<{ startDate: string; endDate: string }>,
): Promise<Ga4ReportRow[]> {
  try {
    const res = await runGa4Report(
      propertyId,
      accessToken,
      {
        dateRanges,
        dimensions: [{ name: 'sessionSourceMedium' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: {
          filter: {
            fieldName: 'eventName',
            stringFilter: { matchType: 'EXACT', value: 'click_whatsapp' },
          },
        },
      },
      'cliques whatsapp',
    )
    return res.rows ?? []
  } catch {
    return []
  }
}

function metricNumber(value: string | undefined): number {
  return value === undefined ? 0 : Number(value)
}

function normalizeGa4Summary(
  totals: Ga4ReportResponse,
  sources: Ga4ReportResponse,
  pages: Ga4ReportResponse,
  whatsappRows: Ga4ReportRow[],
): Ga4Summary {
  const totalsMetrics = totals.rows?.[0]?.metricValues ?? []

  return {
    sessions: metricNumber(totalsMetrics[0]?.value),
    totalUsers: metricNumber(totalsMetrics[1]?.value),
    newUsers: metricNumber(totalsMetrics[2]?.value),
    engagementRate: metricNumber(totalsMetrics[3]?.value),
    avgSessionDurationSec: metricNumber(totalsMetrics[4]?.value),
    conversions: metricNumber(totalsMetrics[5]?.value),
    sources: (sources.rows ?? []).map((row) => ({
      sourceMedium: row.dimensionValues?.[0]?.value ?? '(not set)',
      sessions: metricNumber(row.metricValues?.[0]?.value),
      conversions: metricNumber(row.metricValues?.[1]?.value),
    })),
    topPages: (pages.rows ?? []).map((row) => ({
      path: row.dimensionValues?.[0]?.value ?? '(not set)',
      views: metricNumber(row.metricValues?.[0]?.value),
    })),
    whatsappClicks: whatsappRows.map((row) => ({
      sourceMedium: row.dimensionValues?.[0]?.value ?? '(not set)',
      clicks: metricNumber(row.metricValues?.[0]?.value),
    })),
  }
}

/**
 * Busca o resumo GA4 do período: 1 token exchange + 4 runReport (totais,
 * origem/mídia, top páginas, cliques whatsapp — este último tolerante a
 * ausência, ver fetchWhatsappClicksRows). Dimensões/métricas EXATAS de cada
 * relatório (contrato da Task 2, não mudar sem revisar a Task 6):
 *   - totais: metrics sessions, totalUsers, newUsers, engagementRate,
 *     averageSessionDuration, keyEvents (sem dimensão).
 *   - origem/mídia: dimension sessionSourceMedium; metrics sessions,
 *     keyEvents; limit 20.
 *   - top páginas: dimension pagePath; metric screenPageViews; limit 10.
 *   - cliques whatsapp: dimension sessionSourceMedium; metric eventCount;
 *     dimensionFilter eventName == 'click_whatsapp' (EXACT).
 */
export async function ga4Summary(args: {
  serviceAccountJson: string
  propertyId: string
  period: { start: string; end: string }
}): Promise<Ga4Summary> {
  const serviceAccount = JSON.parse(args.serviceAccountJson) as {
    client_email: string
    private_key: string
  }
  const accessToken = await ga4AccessToken(serviceAccount)
  const dateRanges = [{ startDate: args.period.start, endDate: args.period.end }]

  const [totals, sources, pages] = await Promise.all([
    runGa4Report(
      args.propertyId,
      accessToken,
      {
        dateRanges,
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'newUsers' },
          { name: 'engagementRate' },
          { name: 'averageSessionDuration' },
          { name: 'keyEvents' },
        ],
      },
      'totais',
    ),
    runGa4Report(
      args.propertyId,
      accessToken,
      {
        dateRanges,
        dimensions: [{ name: 'sessionSourceMedium' }],
        metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
        limit: '20',
      },
      'origem/mídia',
    ),
    runGa4Report(
      args.propertyId,
      accessToken,
      {
        dateRanges,
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }],
        limit: '10',
      },
      'top páginas',
    ),
  ])

  const whatsappRows = await fetchWhatsappClicksRows(args.propertyId, accessToken, dateRanges)

  return normalizeGa4Summary(totals, sources, pages, whatsappRows)
}

/**
 * Validação mínima de credenciais para o POST /api/marketing/integrations:
 * exercita o fluxo completo de autenticação (JWT de service account →
 * access_token) + UM runReport de 1 dia com uma única métrica (sessions) —
 * em vez dos 4 runReports do `ga4Summary` — porque o objetivo aqui é só
 * confirmar que as credenciais funcionam e a service account tem acesso à
 * propriedade, não coletar dados. Lança com a mensagem de erro da
 * plataforma (mesmo formato dos demais erros deste módulo) quando algo
 * está errado; resolve sem valor quando as credenciais são válidas.
 *
 * `date` (YYYY-MM-DD) é injetado pelo chamador (a rota passa "ontem" em
 * UTC) para o teste controlar o corpo exato da chamada.
 */
export async function ga4ValidateCredentials(args: {
  serviceAccountJson: string
  propertyId: string
  date: string
}): Promise<void> {
  const serviceAccount = JSON.parse(args.serviceAccountJson) as {
    client_email: string
    private_key: string
  }
  const accessToken = await ga4AccessToken(serviceAccount)
  await runGa4Report(
    args.propertyId,
    accessToken,
    {
      dateRanges: [{ startDate: args.date, endDate: args.date }],
      metrics: [{ name: 'sessions' }],
    },
    'validação de credenciais',
  )
}
