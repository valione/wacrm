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

  it('createSession recupera de sessão órfã: 422 already exists -> logout+delete -> retry', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    // 1º POST /api/sessions: 422 already exists (sessão órfã pós-queda)
    // 2º logout, 3º delete (logoutAndDelete), 4º POST /api/sessions: 201 ok
    mock
      .mockResolvedValueOnce(new Response('{"message":"Session \'s1\' already exists"}', { status: 422 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 })) // logout
      .mockResolvedValueOnce(new Response('{}', { status: 200 })) // delete
      .mockResolvedValueOnce(new Response('{}', { status: 201 })) // retry create
    const { createSession } = await import('./waha-api')
    await expect(
      createSession({ session: 's1', webhookUrl: 'http://crm.local/api/whatsapp/webhook/waha' }),
    ).resolves.toBeUndefined()
    const paths = mock.mock.calls.map((c) => new URL(c[0] as string).pathname)
    expect(paths).toEqual([
      '/api/sessions',
      '/api/sessions/s1/logout',
      '/api/sessions/s1',
      '/api/sessions',
    ])
  })

  it('createSession propaga se o retry pós-limpeza também falhar', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock
      .mockResolvedValueOnce(new Response('{"message":"Session already exists"}', { status: 422 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 })) // logout
      .mockResolvedValueOnce(new Response('{}', { status: 200 })) // delete
      .mockResolvedValueOnce(new Response('{"message":"boom"}', { status: 500 })) // retry falha
    const { createSession } = await import('./waha-api')
    await expect(
      createSession({ session: 's1', webhookUrl: 'http://crm.local/api/whatsapp/webhook/waha' }),
    ).rejects.toThrow(/500/)
  })
})
