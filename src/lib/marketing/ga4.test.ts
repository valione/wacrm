import crypto from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

function decodeBase64Url(part: string): Buffer {
  return Buffer.from(part, 'base64url')
}

function makeServiceAccount() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return {
    publicKey,
    serviceAccount: {
      client_email: 'test-sa@display4-ga4.iam.gserviceaccount.com',
      private_key: privateKey,
    },
  }
}

describe('ga4', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => { vi.unstubAllGlobals() })

  describe('buildGa4Jwt', () => {
    it('gera um JWT RS256 com header e claims corretos', async () => {
      const { serviceAccount } = makeServiceAccount()
      const { buildGa4Jwt } = await import('./ga4')
      const nowSec = 1_700_000_000
      const jwt = buildGa4Jwt(serviceAccount, nowSec)

      const [headerPart, payloadPart, signaturePart] = jwt.split('.')
      const header = JSON.parse(decodeBase64Url(headerPart).toString('utf8'))
      const payload = JSON.parse(decodeBase64Url(payloadPart).toString('utf8'))

      expect(header).toEqual({ alg: 'RS256', typ: 'JWT' })
      expect(payload).toEqual({
        iss: serviceAccount.client_email,
        scope: 'https://www.googleapis.com/auth/analytics.readonly',
        aud: 'https://oauth2.googleapis.com/token',
        iat: nowSec,
        exp: nowSec + 3600,
      })
      expect(signaturePart).toBeTruthy()
    })

    it('assina com a chave privada da service account (verificável com a pública)', async () => {
      const { serviceAccount, publicKey } = makeServiceAccount()
      const { buildGa4Jwt } = await import('./ga4')
      const nowSec = 1_700_000_000
      const jwt = buildGa4Jwt(serviceAccount, nowSec)
      const [headerPart, payloadPart, signaturePart] = jwt.split('.')

      const verifier = crypto.createVerify('RSA-SHA256')
      verifier.update(`${headerPart}.${payloadPart}`)
      verifier.end()
      const valid = verifier.verify(publicKey, decodeBase64Url(signaturePart))
      expect(valid).toBe(true)
    })
  })

  function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
    const mock = fetch as ReturnType<typeof vi.fn>
    for (const { status, body } of responses) {
      mock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
    }
    return mock
  }

  const totalsFixture = {
    rows: [
      {
        metricValues: [
          { value: '1200' }, // sessions
          { value: '900' }, // totalUsers
          { value: '400' }, // newUsers
          { value: '0.62' }, // engagementRate
          { value: '95.5' }, // averageSessionDuration
          { value: '30' }, // keyEvents
        ],
      },
    ],
  }
  const sourcesFixture = {
    rows: [
      { dimensionValues: [{ value: 'google / cpc' }], metricValues: [{ value: '800' }, { value: '20' }] },
      { dimensionValues: [{ value: '(direct) / (none)' }], metricValues: [{ value: '400' }, { value: '10' }] },
    ],
  }
  const pagesFixture = {
    rows: [
      { dimensionValues: [{ value: '/' }], metricValues: [{ value: '500' }] },
      { dimensionValues: [{ value: '/precos' }], metricValues: [{ value: '150' }] },
    ],
  }
  const whatsappClicksFixture = {
    rows: [
      { dimensionValues: [{ value: 'google / cpc' }], metricValues: [{ value: '12' }] },
    ],
  }

  it('troca o JWT por access_token via POST oauth2.googleapis.com/token', async () => {
    const { serviceAccount } = makeServiceAccount()
    const mock = mockFetchSequence([
      { status: 200, body: { access_token: 'ya29.fake-token' } },
      { status: 200, body: totalsFixture },
      { status: 200, body: sourcesFixture },
      { status: 200, body: pagesFixture },
      { status: 200, body: whatsappClicksFixture },
    ])
    const { ga4Summary } = await import('./ga4')
    await ga4Summary({
      serviceAccountJson: JSON.stringify(serviceAccount),
      propertyId: '123456',
      period: { start: '2026-06-01', end: '2026-06-30' },
    })

    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    expect(init.method).toBe('POST')
    const params = new URLSearchParams(init.body as string)
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(params.get('assertion')).toBeTruthy()
  })

  it('faz 1 POST runReport por relatório (totais, origem/mídia, top páginas, cliques whatsapp) com Bearer e dimensões/métricas exatas', async () => {
    const { serviceAccount } = makeServiceAccount()
    const mock = mockFetchSequence([
      { status: 200, body: { access_token: 'ya29.fake-token' } },
      { status: 200, body: totalsFixture },
      { status: 200, body: sourcesFixture },
      { status: 200, body: pagesFixture },
      { status: 200, body: whatsappClicksFixture },
    ])
    const { ga4Summary } = await import('./ga4')
    await ga4Summary({
      serviceAccountJson: JSON.stringify(serviceAccount),
      propertyId: '123456',
      period: { start: '2026-06-01', end: '2026-06-30' },
    })

    expect(mock.mock.calls).toHaveLength(5)

    const reportUrl = 'https://analyticsdata.googleapis.com/v1beta/properties/123456:runReport'
    const dateRanges = [{ startDate: '2026-06-01', endDate: '2026-06-30' }]

    const [totalsUrl, totalsInit] = mock.mock.calls[1]
    expect(totalsUrl).toBe(reportUrl)
    expect((totalsInit.headers as Record<string, string>).Authorization).toBe('Bearer ya29.fake-token')
    expect(JSON.parse(totalsInit.body as string)).toEqual({
      dateRanges,
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'newUsers' },
        { name: 'engagementRate' },
        { name: 'averageSessionDuration' },
        { name: 'keyEvents' },
      ],
    })

    const [sourcesUrl, sourcesInit] = mock.mock.calls[2]
    expect(sourcesUrl).toBe(reportUrl)
    expect(JSON.parse(sourcesInit.body as string)).toEqual({
      dateRanges,
      dimensions: [{ name: 'sessionSourceMedium' }],
      metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
      limit: '20',
    })

    const [pagesUrl, pagesInit] = mock.mock.calls[3]
    expect(pagesUrl).toBe(reportUrl)
    expect(JSON.parse(pagesInit.body as string)).toEqual({
      dateRanges,
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }],
      limit: '10',
    })

    const [clicksUrl, clicksInit] = mock.mock.calls[4]
    expect(clicksUrl).toBe(reportUrl)
    expect(JSON.parse(clicksInit.body as string)).toEqual({
      dateRanges,
      dimensions: [{ name: 'sessionSourceMedium' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          stringFilter: { matchType: 'EXACT', value: 'click_whatsapp' },
        },
      },
    })
  })

  it('normaliza as 4 respostas fixture em um Ga4Summary', async () => {
    const { serviceAccount } = makeServiceAccount()
    mockFetchSequence([
      { status: 200, body: { access_token: 'ya29.fake-token' } },
      { status: 200, body: totalsFixture },
      { status: 200, body: sourcesFixture },
      { status: 200, body: pagesFixture },
      { status: 200, body: whatsappClicksFixture },
    ])
    const { ga4Summary } = await import('./ga4')
    const result = await ga4Summary({
      serviceAccountJson: JSON.stringify(serviceAccount),
      propertyId: '123456',
      period: { start: '2026-06-01', end: '2026-06-30' },
    })

    expect(result).toEqual({
      sessions: 1200,
      totalUsers: 900,
      newUsers: 400,
      engagementRate: 0.62,
      avgSessionDurationSec: 95.5,
      conversions: 30,
      sources: [
        { sourceMedium: 'google / cpc', sessions: 800, conversions: 20 },
        { sourceMedium: '(direct) / (none)', sessions: 400, conversions: 10 },
      ],
      topPages: [
        { path: '/', views: 500 },
        { path: '/precos', views: 150 },
      ],
      whatsappClicks: [
        { sourceMedium: 'google / cpc', clicks: 12 },
      ],
    })
  })

  it('retorna whatsappClicks: [] sem erro quando o relatório de click_whatsapp vem sem rows (evento não configurado)', async () => {
    const { serviceAccount } = makeServiceAccount()
    mockFetchSequence([
      { status: 200, body: { access_token: 'ya29.fake-token' } },
      { status: 200, body: totalsFixture },
      { status: 200, body: sourcesFixture },
      { status: 200, body: pagesFixture },
      { status: 200, body: {} }, // GA4 omite `rows` quando não há dados
    ])
    const { ga4Summary } = await import('./ga4')
    const result = await ga4Summary({
      serviceAccountJson: JSON.stringify(serviceAccount),
      propertyId: '123456',
      period: { start: '2026-06-01', end: '2026-06-30' },
    })
    expect(result.whatsappClicks).toEqual([])
  })

  it('retorna whatsappClicks: [] sem erro quando o próprio runReport de click_whatsapp falha', async () => {
    const { serviceAccount } = makeServiceAccount()
    const mock = fetch as ReturnType<typeof vi.fn>
    mock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'ya29.fake-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(totalsFixture), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sourcesFixture), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(pagesFixture), { status: 200 }))
      .mockResolvedValueOnce(new Response('{"error":"custom dimension not found"}', { status: 400 }))
    const { ga4Summary } = await import('./ga4')
    const result = await ga4Summary({
      serviceAccountJson: JSON.stringify(serviceAccount),
      propertyId: '123456',
      period: { start: '2026-06-01', end: '2026-06-30' },
    })
    expect(result.whatsappClicks).toEqual([])
    // o resto do resumo continua correto mesmo com o relatório de cliques falhando
    expect(result.sessions).toBe(1200)
  })

  it('lança erro legível quando a troca de token falha', async () => {
    const { serviceAccount } = makeServiceAccount()
    mockFetchSequence([{ status: 401, body: { error: 'invalid_grant' } }])
    const { ga4Summary } = await import('./ga4')
    await expect(ga4Summary({
      serviceAccountJson: JSON.stringify(serviceAccount),
      propertyId: '123456',
      period: { start: '2026-06-01', end: '2026-06-30' },
    })).rejects.toThrow(/GA4 .*401/)
  })

  it('lança erro legível quando um runReport obrigatório falha (não é o de cliques)', async () => {
    const { serviceAccount } = makeServiceAccount()
    // totais, origem/mídia e top páginas disparam em paralelo (Promise.all) —
    // as três precisam de mock, mesmo que só a de totais falhe de propósito.
    mockFetchSequence([
      { status: 200, body: { access_token: 'ya29.fake-token' } },
      { status: 500, body: { error: 'internal' } },
      { status: 200, body: sourcesFixture },
      { status: 200, body: pagesFixture },
    ])
    const { ga4Summary } = await import('./ga4')
    await expect(ga4Summary({
      serviceAccountJson: JSON.stringify(serviceAccount),
      propertyId: '123456',
      period: { start: '2026-06-01', end: '2026-06-30' },
    })).rejects.toThrow(/GA4 .*falhou: 500/)
  })
})
