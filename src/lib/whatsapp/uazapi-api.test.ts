import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('uazapi-api', () => {
  beforeEach(() => {
    vi.stubEnv('UAZAPI_URL', 'http://uazapi.local:8080')
    vi.stubEnv('UAZAPI_ADMIN_TOKEN', 'test-admin-token')
    vi.stubEnv('UAZAPI_WEBHOOK_SECRET', 'test-secret')
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('uazapiInstanceName gera nome prefixado com a conta', async () => {
    const { uazapiInstanceName } = await import('./uazapi-api')
    expect(uazapiInstanceName('acc123')).toBe('wacrm_acc123')
  })

  it('uazapiEnabled exige as TRÊS envs (URL, admin token e webhook secret)', async () => {
    const { uazapiEnabled } = await import('./uazapi-api')
    expect(uazapiEnabled()).toBe(true)
    // Sem o secret o webhook fica sem segredo embutido na URL (a Uazapi
    // não assina webhooks) — melhor nem oferecer a opção.
    vi.stubEnv('UAZAPI_WEBHOOK_SECRET', '')
    expect(uazapiEnabled()).toBe(false)
    vi.stubEnv('UAZAPI_WEBHOOK_SECRET', 'test-secret')
    vi.stubEnv('UAZAPI_ADMIN_TOKEN', '')
    expect(uazapiEnabled()).toBe(false)
    vi.stubEnv('UAZAPI_ADMIN_TOKEN', 'test-admin-token')
    vi.stubEnv('UAZAPI_URL', '')
    expect(uazapiEnabled()).toBe(false)
  })

  it('createInstance faz POST /instance/create com header admintoken e retorna o token', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response(JSON.stringify({ token: 'uuid-1234' }), { status: 200 }))
    const { createInstance } = await import('./uazapi-api')
    const r = await createInstance({ name: 'wacrm_acc123' })
    expect(r.token).toBe('uuid-1234')
    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('http://uazapi.local:8080/instance/create')
    expect((init.headers as Record<string, string>).admintoken).toBe('test-admin-token')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'wacrm_acc123' })
  })

  it('connectInstance faz POST /instance/connect com header token da instância', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response('{}', { status: 200 }))
    const { connectInstance } = await import('./uazapi-api')
    await connectInstance({ token: 'inst-token' })
    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('http://uazapi.local:8080/instance/connect')
    expect((init.headers as Record<string, string>).token).toBe('inst-token')
  })

  it('getInstanceStatus normaliza a resposta da Uazapi (instance.qrcode, status.loggedIn, status.jid.user)', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response(JSON.stringify({
      instance: { status: 'connected', qrcode: 'base64...' },
      status: { loggedIn: true, jid: { user: '5511999999999' } },
    }), { status: 200 }))
    const { getInstanceStatus } = await import('./uazapi-api')
    const r = await getInstanceStatus({ token: 'inst-token' })
    expect(r).toEqual({ status: 'connected', qrcode: 'base64...', phone: '5511999999999', loggedIn: true })
  })

  it('getInstanceStatus retorna qrcode null quando ausente', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response(JSON.stringify({
      instance: { status: 'disconnected' },
      status: { loggedIn: false, jid: null },
    }), { status: 200 }))
    const { getInstanceStatus } = await import('./uazapi-api')
    const r = await getInstanceStatus({ token: 'inst-token' })
    expect(r).toEqual({ status: 'disconnected', qrcode: null, phone: null, loggedIn: false })
  })

  it('disconnectInstance tolera 401/404 (instância já expirada/apagada)', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response('{"error":"not found"}', { status: 404 }))
    const { disconnectInstance } = await import('./uazapi-api')
    await expect(disconnectInstance({ token: 'inst-token' })).resolves.toBeUndefined()
  })

  it('disconnectInstance propaga erros que não são 401/404', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response('{"error":"boom"}', { status: 500 }))
    const { disconnectInstance } = await import('./uazapi-api')
    await expect(disconnectInstance({ token: 'inst-token' })).rejects.toThrow(/500/)
  })

  it('deleteInstance faz DELETE /instance com header token e tolera 401/404', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }))
    const { deleteInstance } = await import('./uazapi-api')
    await expect(deleteInstance({ token: 'inst-token' })).resolves.toBeUndefined()
    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('http://uazapi.local:8080/instance')
    expect(init.method).toBe('DELETE')
    expect((init.headers as Record<string, string>).token).toBe('inst-token')
  })

  it('setInstanceWebhook envia url, events e excludeMessages (evita loop de eco)', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response('[]', { status: 200 }))
    const { setInstanceWebhook } = await import('./uazapi-api')
    await setInstanceWebhook({ token: 'inst-token', url: 'http://crm.local/api/whatsapp/webhook/uazapi' })
    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('http://uazapi.local:8080/webhook')
    expect(JSON.parse(init.body as string)).toEqual({
      url: 'http://crm.local/api/whatsapp/webhook/uazapi',
      events: ['messages', 'messages_update', 'connection'],
      excludeMessages: ['wasSentByApi'],
    })
  })

  it('uazapiSendText faz POST /send/text com header token e retorna o messageId', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response(JSON.stringify({ messageid: '3EB0538DA65A59F6D8A251' }), { status: 200 }))
    const { uazapiSendText } = await import('./uazapi-api')
    const r = await uazapiSendText({ token: 'inst-token', number: '5511999999999', text: 'oi' })
    expect(r.messageId).toBe('3EB0538DA65A59F6D8A251')
    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('http://uazapi.local:8080/send/text')
    expect((init.headers as Record<string, string>).token).toBe('inst-token')
    expect(JSON.parse(init.body as string)).toEqual({ number: '5511999999999', text: 'oi' })
  })

  it('uazapiSendText inclui replyid quando replyId é informado', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response(JSON.stringify({ messageid: 'ABC' }), { status: 200 }))
    const { uazapiSendText } = await import('./uazapi-api')
    await uazapiSendText({ token: 'inst-token', number: '5511999999999', text: 'oi', replyId: 'MSG1' })
    const [, init] = mock.mock.calls[0]
    expect(JSON.parse(init.body as string)).toEqual({ number: '5511999999999', text: 'oi', replyid: 'MSG1' })
  })

  it('uazapiSendText lança erro legível em non-2xx', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response('{"error":"Invalid token"}', { status: 401 }))
    const { uazapiSendText } = await import('./uazapi-api')
    await expect(uazapiSendText({ token: 'inst-token', number: '5511999999999', text: 'oi' }))
      .rejects.toThrow(/Uazapi .*4\d\d/)
  })

  it('uazapiSendMedia mapeia kind para type e envia caption como text', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response(JSON.stringify({ messageid: 'IMG1' }), { status: 200 }))
    const { uazapiSendMedia } = await import('./uazapi-api')
    const r = await uazapiSendMedia({
      token: 'inst-token', number: '5511999999999', kind: 'image',
      url: 'https://cdn.local/foto.jpg', caption: 'Olha isso',
    })
    expect(r.messageId).toBe('IMG1')
    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('http://uazapi.local:8080/send/media')
    expect(JSON.parse(init.body as string)).toEqual({
      number: '5511999999999', type: 'image', file: 'https://cdn.local/foto.jpg', text: 'Olha isso',
    })
  })

  it('uazapiSendMedia mapeia audio para type ptt (sem caption)', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response(JSON.stringify({ messageid: 'AUD1' }), { status: 200 }))
    const { uazapiSendMedia } = await import('./uazapi-api')
    await uazapiSendMedia({ token: 'inst-token', number: '5511999999999', kind: 'audio', url: 'https://cdn.local/audio.ogg' })
    const [, init] = mock.mock.calls[0]
    expect(JSON.parse(init.body as string)).toEqual({
      number: '5511999999999', type: 'ptt', file: 'https://cdn.local/audio.ogg',
    })
  })

  it('uazapiSendMedia envia docName para document', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response(JSON.stringify({ messageid: 'DOC1' }), { status: 200 }))
    const { uazapiSendMedia } = await import('./uazapi-api')
    await uazapiSendMedia({
      token: 'inst-token', number: '5511999999999', kind: 'document',
      url: 'https://cdn.local/relatorio.pdf', docName: 'relatorio.pdf',
    })
    const [, init] = mock.mock.calls[0]
    expect(JSON.parse(init.body as string)).toEqual({
      number: '5511999999999', type: 'document', file: 'https://cdn.local/relatorio.pdf', docName: 'relatorio.pdf',
    })
  })

  it('uazapiSendReaction faz POST /message/react com {number, text: emoji, id}', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response('{"success":true}', { status: 200 }))
    const { uazapiSendReaction } = await import('./uazapi-api')
    await uazapiSendReaction({ token: 'inst-token', number: '5511999999999', messageId: 'MSG1', emoji: '👍' })
    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('http://uazapi.local:8080/message/react')
    expect(JSON.parse(init.body as string)).toEqual({ number: '5511999999999', text: '👍', id: 'MSG1' })
  })

  it('downloadUazapiMedia recusa URL fora de UAZAPI_URL', async () => {
    const { downloadUazapiMedia } = await import('./uazapi-api')
    await expect(downloadUazapiMedia({ url: 'http://evil.example/x.jpg' }))
      .rejects.toThrow(/fora do servidor Uazapi/)
  })

  it('downloadUazapiMedia baixa mídia hospedada no próprio servidor Uazapi', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response('binary', { status: 200 }))
    const { downloadUazapiMedia } = await import('./uazapi-api')
    await downloadUazapiMedia({ url: 'http://uazapi.local:8080/files/foto.jpg' })
    const [url] = mock.mock.calls[0]
    expect(url).toBe('http://uazapi.local:8080/files/foto.jpg')
  })
})
