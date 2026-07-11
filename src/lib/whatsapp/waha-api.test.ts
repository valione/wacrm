import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('waha-api', () => {
  beforeEach(() => {
    vi.stubEnv('WAHA_URL', 'http://waha.local:3001')
    vi.stubEnv('WAHA_API_KEY', 'test-key')
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

  it('wahaEnabled reflete presença das envs', async () => {
    const { wahaEnabled } = await import('./waha-api')
    expect(wahaEnabled()).toBe(true)
  })
})
