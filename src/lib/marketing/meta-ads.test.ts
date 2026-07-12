import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  const mock = fetch as ReturnType<typeof vi.fn>
  for (const { status, body } of responses) {
    mock.mockResolvedValueOnce(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    )
  }
  return mock
}

const campaignInsightsFixture = {
  data: [
    {
      campaign_id: '111',
      campaign_name: 'Campanha A',
      spend: '150.50',
      impressions: '10000',
      reach: '8000',
      clicks: '200',
      ctr: '2.0',
      cpc: '0.75',
      frequency: '1.25',
      actions: [
        { action_type: 'link_click', value: '150' },
        { action_type: 'lead', value: '3' },
        { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '2' },
      ],
    },
    {
      // sem status correspondente → status vira 'UNKNOWN'; sem frequency → null
      campaign_id: '999',
      campaign_name: 'Campanha Órfã',
      spend: '10.00',
      impressions: '500',
      clicks: '5',
      ctr: '1.0',
      cpc: '2.0',
      actions: [],
    },
  ],
}

const dailyInsightsFixture = {
  data: [
    {
      date_start: '2026-06-01',
      spend: '50.00',
      actions: [{ action_type: 'lead', value: '1' }],
    },
    {
      date_start: '2026-06-02',
      spend: '110.50',
      actions: [
        { action_type: 'lead', value: '2' },
        { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '2' },
      ],
    },
  ],
}

const statusFixture = {
  data: [
    { id: '111', name: 'Campanha A', status: 'ACTIVE' },
    { id: '222', name: 'Campanha Sem Insight', status: 'PAUSED' },
  ],
}

describe('metaAdsSummary', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('faz 3 chamadas (campanhas, diário, status) com header Bearer e query params corretos', async () => {
    const mock = mockFetchSequence([
      { status: 200, body: campaignInsightsFixture },
      { status: 200, body: dailyInsightsFixture },
      { status: 200, body: statusFixture },
    ])
    const { metaAdsSummary } = await import('./meta-ads')
    await metaAdsSummary({
      accessToken: 'EAA-fake-token',
      adAccountId: '123456',
      period: { start: '2026-06-01', end: '2026-06-30' },
    })

    expect(mock.mock.calls).toHaveLength(3)

    const [campaignUrl, campaignInit] = mock.mock.calls[0]
    const campaignParsed = new URL(campaignUrl as string)
    expect(campaignParsed.origin + campaignParsed.pathname).toBe(
      'https://graph.facebook.com/v21.0/act_123456/insights',
    )
    expect(campaignParsed.searchParams.get('level')).toBe('campaign')
    expect(campaignParsed.searchParams.get('fields')).toBe(
      'campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpc,frequency,actions',
    )
    expect(JSON.parse(campaignParsed.searchParams.get('time_range') ?? '')).toEqual({
      since: '2026-06-01',
      until: '2026-06-30',
    })
    // token via header, nunca em query
    expect(campaignParsed.searchParams.get('access_token')).toBeNull()
    expect((campaignInit.headers as Record<string, string>).Authorization).toBe(
      'Bearer EAA-fake-token',
    )

    const [dailyUrl] = mock.mock.calls[1]
    const dailyParsed = new URL(dailyUrl as string)
    expect(dailyParsed.searchParams.get('level')).toBe('account')
    expect(dailyParsed.searchParams.get('time_increment')).toBe('1')
    expect(dailyParsed.searchParams.get('fields')).toBe('spend,actions')

    const [statusUrl] = mock.mock.calls[2]
    const statusParsed = new URL(statusUrl as string)
    expect(statusParsed.origin + statusParsed.pathname).toBe(
      'https://graph.facebook.com/v21.0/act_123456/campaigns',
    )
    expect(statusParsed.searchParams.get('fields')).toBe('id,name,status')
  })

  it('normaliza a fixture em um AdsSummary: números string→number, CTR/CPC, leads somando os 2 action_types, CPL, merge de status', async () => {
    mockFetchSequence([
      { status: 200, body: campaignInsightsFixture },
      { status: 200, body: dailyInsightsFixture },
      { status: 200, body: statusFixture },
    ])
    const { metaAdsSummary } = await import('./meta-ads')
    const result = await metaAdsSummary({
      accessToken: 'EAA-fake-token',
      adAccountId: '123456',
      period: { start: '2026-06-01', end: '2026-06-30' },
    })

    expect(result.campaigns).toEqual([
      {
        id: '111',
        name: 'Campanha A',
        status: 'ACTIVE', // merge por campaign_id com o /campaigns
        spend: 150.5,
        impressions: 10000,
        reach: 8000,
        clicks: 200,
        ctr: 2.0,
        cpc: 0.75,
        leads: 5, // 3 (lead) + 2 (messaging_conversation_started_7d)
        cpl: 150.5 / 5,
        frequency: 1.25,
      },
      {
        id: '999',
        name: 'Campanha Órfã',
        status: 'UNKNOWN', // sem entrada correspondente em /campaigns
        spend: 10,
        impressions: 500,
        reach: null, // ausente na fixture
        clicks: 5,
        ctr: 1.0,
        cpc: 2.0,
        leads: 0,
        cpl: 0, // 0 leads → cpl 0 (0-safe)
        frequency: null, // ausente na fixture
      },
    ])

    // Campanha Sem Insight (id 222) não entra: sem insights no período.
    expect(result.campaigns.find((c) => c.id === '222')).toBeUndefined()

    expect(result.daily).toEqual([
      { date: '2026-06-01', spend: 50, leads: 1 },
      { date: '2026-06-02', spend: 110.5, leads: 4 },
    ])

    expect(result.spend).toBe(160.5) // 150.50 + 10.00
    expect(result.leads).toBe(5) // soma dos leads por campanha
  })

  it('segue paging.next até esgotar (fixture paginada de 2 páginas no endpoint de status)', async () => {
    const statusPage1 = {
      data: [{ id: '111', name: 'Campanha A', status: 'ACTIVE' }],
      paging: { next: 'https://graph.facebook.com/v21.0/act_123456/campaigns?after=CURSOR1' },
    }
    const statusPage2 = {
      data: [{ id: '999', name: 'Campanha Órfã', status: 'PAUSED' }],
    }
    const mock = mockFetchSequence([
      { status: 200, body: { data: [campaignInsightsFixture.data[0]] } },
      { status: 200, body: { data: [] } },
      { status: 200, body: statusPage1 },
      { status: 200, body: statusPage2 },
    ])
    const { metaAdsSummary } = await import('./meta-ads')
    const result = await metaAdsSummary({
      accessToken: 'EAA-fake-token',
      adAccountId: '123456',
      period: { start: '2026-06-01', end: '2026-06-30' },
    })

    expect(mock.mock.calls).toHaveLength(4)
    // 2ª página buscada exatamente na URL de paging.next devolvida pelo Graph.
    expect(mock.mock.calls[3][0]).toBe(
      'https://graph.facebook.com/v21.0/act_123456/campaigns?after=CURSOR1',
    )
    // status vem do merge das 2 páginas
    expect(result.campaigns[0].status).toBe('ACTIVE')
  })

  it('lança erro legível quando /insights falha, sem vazar o token', async () => {
    mockFetchSequence([
      { status: 400, body: { error: { message: 'Invalid parameter', code: 100 } } },
    ])
    const { metaAdsSummary } = await import('./meta-ads')

    let caught: Error | null = null
    try {
      await metaAdsSummary({
        accessToken: 'EAA-super-secret-token',
        adAccountId: '123456',
        period: { start: '2026-06-01', end: '2026-06-30' },
      })
    } catch (err) {
      caught = err as Error
    }

    expect(caught).not.toBeNull()
    expect(caught?.message).toMatch(/^Meta Ads \/insights falhou: 400/)
    expect(caught?.message).not.toContain('EAA-super-secret-token')
  })

  it('lança erro legível quando /campaigns (status) falha', async () => {
    mockFetchSequence([
      { status: 200, body: campaignInsightsFixture },
      { status: 200, body: dailyInsightsFixture },
      { status: 500, body: { error: { message: 'Internal error' } } },
    ])
    const { metaAdsSummary } = await import('./meta-ads')
    await expect(
      metaAdsSummary({
        accessToken: 'EAA-fake-token',
        adAccountId: '123456',
        period: { start: '2026-06-01', end: '2026-06-30' },
      }),
    ).rejects.toThrow(/^Meta Ads \/campaigns falhou: 500/)
  })
})
