import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('waha-api', () => {
  beforeEach(() => {
    vi.stubEnv('WAHA_URL', 'http://waha.local:3001')
    vi.stubEnv('WAHA_API_KEY', 'test-key')
    vi.stubEnv('WAHA_WEBHOOK_SECRET', 'test-secret')
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('toChatId/fromChatId convertem telefone <-> chatId', async () => {
    const { toChatId, fromChatId } = await import('./waha-api')
    expect(toChatId('5511999999999')).toBe('5511999999999@c.us')
    expect(fromChatId('5511999999999@c.us')).toBe('5511999999999')
    expect(fromChatId('5511999999999@s.whatsapp.net')).toBe('5511999999999')
  })

  it('wahaSendText faz POST /api/sendText com X-Api-Key e retorna o id', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response(JSON.stringify({ id: 'true_5511@c.us_ABC' }), { status: 201 }))
    const { wahaSendText } = await import('./waha-api')
    const r = await wahaSendText({ session: 's1', chatId: '5511@c.us', text: 'oi' })
    expect(r.messageId).toBe('true_5511@c.us_ABC')
    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('http://waha.local:3001/api/sendText')
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('test-key')
    expect(JSON.parse(init.body as string)).toMatchObject({ session: 's1', chatId: '5511@c.us', text: 'oi' })
  })

  it('wahaSendText lança erro legível em non-2xx', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response('{"message":"session not working"}', { status: 422 }))
    const { wahaSendText } = await import('./waha-api')
    await expect(wahaSendText({ session: 's1', chatId: 'x@c.us', text: 'oi' }))
      .rejects.toThrow(/WAHA .*422/)
  })

  it('downloadWahaMedia recusa URL fora do WAHA_URL', async () => {
    const { downloadWahaMedia } = await import('./waha-api')
    await expect(downloadWahaMedia({ url: 'http://evil.example/x.jpg' }))
      .rejects.toThrow(/fora do servidor WAHA/)
  })

  it('wahaEnabled exige as TRÊS envs (URL, API key e webhook secret)', async () => {
    const { wahaEnabled } = await import('./waha-api')
    expect(wahaEnabled()).toBe(true)
    // Sem o secret a opção não deve aparecer: HMAC fail-closed rejeitaria
    // todos os webhooks com 401 e o recebimento morreria em silêncio.
    vi.stubEnv('WAHA_WEBHOOK_SECRET', '')
    expect(wahaEnabled()).toBe(false)
    vi.stubEnv('WAHA_WEBHOOK_SECRET', 'test-secret')
    vi.stubEnv('WAHA_API_KEY', '')
    expect(wahaEnabled()).toBe(false)
    vi.stubEnv('WAHA_API_KEY', 'test-key')
    vi.stubEnv('WAHA_URL', '')
    expect(wahaEnabled()).toBe(false)
  })

  it('createSession assina message.any (cobre fromMe) e não duplica com message', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response('{}', { status: 201 }))
    const { createSession } = await import('./waha-api')
    await createSession({ session: 's1', webhookUrl: 'http://crm.local/api/whatsapp/webhook/waha' })
    const [, init] = mock.mock.calls[0]
    const body = JSON.parse(init.body as string)
    const events = body.config.webhooks[0].events as string[]
    expect(events).toContain('message.any')
    expect(events).not.toContain('message') // senão as recebidas duplicariam
    expect(events).toEqual(['message.any', 'message.ack', 'session.status'])
  })

  it('createSession propaga o erro em non-2xx sem tentar se auto-recuperar (a decisão é da rota)', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response('{"message":"Session \'s1\' already exists"}', { status: 422 }))
    const { createSession } = await import('./waha-api')
    await expect(
      createSession({ session: 's1', webhookUrl: 'http://crm.local/api/whatsapp/webhook/waha' }),
    ).rejects.toThrow(/422/)
    // Só uma chamada — nada de logout/delete automático aqui, pois esta
    // função não sabe se a sessão existente está WORKING (e derrubá-la
    // desconectaria o usuário). Essa decisão é da rota, que consulta
    // getSession antes de chamar createSession.
    expect(mock.mock.calls).toHaveLength(1)
  })

  it('restartSession faz POST /api/sessions/{session}/restart', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response('{}', { status: 200 }))
    const { restartSession } = await import('./waha-api')
    await expect(restartSession({ session: 's1' })).resolves.toBeUndefined()
    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('http://waha.local:3001/api/sessions/s1/restart')
    expect(init?.method).toBe('POST')
  })

  it('restartSession propaga erro em non-2xx', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response('{"message":"boom"}', { status: 500 }))
    const { restartSession } = await import('./waha-api')
    await expect(restartSession({ session: 's1' })).rejects.toThrow(/500/)
  })

  it('getLidPhone traduz LID -> telefone via GET /api/{session}/lids/{lid}', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(
      new Response(JSON.stringify({ lid: '138061891522811@lid', pn: '5511981453314@c.us' }), { status: 200 }),
    )
    const { getLidPhone } = await import('./waha-api')
    const pn = await getLidPhone({ session: 's1', lid: '138061891522811@lid' })
    expect(pn).toBe('5511981453314@c.us')
    const [url] = mock.mock.calls[0]
    expect(url).toBe(
      'http://waha.local:3001/api/s1/lids/' + encodeURIComponent('138061891522811@lid'),
    )
  })

  it('getLidPhone retorna null em 404 sem lançar (falha de tradução não pode derrubar o webhook)', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response('{"message":"not found"}', { status: 404 }))
    const { getLidPhone } = await import('./waha-api')
    await expect(getLidPhone({ session: 's1', lid: 'x@lid' })).resolves.toBe(null)
  })

  it('getLidPhone retorna null se fetch lançar (servidor fora do ar)', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockRejectedValue(new Error('network down'))
    const { getLidPhone } = await import('./waha-api')
    await expect(getLidPhone({ session: 's1', lid: 'x@lid' })).resolves.toBe(null)
  })

  it('getLidPhone retorna null se a resposta não tiver campo pn', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response(JSON.stringify({ lid: 'x@lid' }), { status: 200 }))
    const { getLidPhone } = await import('./waha-api')
    await expect(getLidPhone({ session: 's1', lid: 'x@lid' })).resolves.toBe(null)
  })
})
