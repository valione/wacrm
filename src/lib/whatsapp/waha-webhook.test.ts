import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'

describe('waha-webhook helpers', () => {
  beforeEach(() => vi.stubEnv('WAHA_WEBHOOK_SECRET', 'segredo'))
  afterEach(() => vi.unstubAllEnvs())

  it('verifyWahaHmac aceita assinatura correta (sha512) e rejeita errada', async () => {
    const { verifyWahaHmac } = await import('./waha-webhook')
    const body = '{"event":"message"}'
    const good = crypto.createHmac('sha512', 'segredo').update(body).digest('hex')
    expect(verifyWahaHmac(body, good)).toBe(true)
    expect(verifyWahaHmac(body, 'deadbeef')).toBe(false)
    expect(verifyWahaHmac(body, null)).toBe(false)
  })

  it('mapAckToStatus mapeia a escala da WAHA', async () => {
    const { mapAckToStatus } = await import('./waha-webhook')
    expect(mapAckToStatus(1)).toBe('sent')
    expect(mapAckToStatus(2)).toBe('delivered')
    expect(mapAckToStatus(3)).toBe('read')
    expect(mapAckToStatus(4)).toBe('read')     // PLAYED conta como lida
    expect(mapAckToStatus(-1)).toBe('failed')
    expect(mapAckToStatus(0)).toBe(null)       // PENDING não regride a escada
  })

  it('normalizeWahaMessage converte texto simples', async () => {
    const { normalizeWahaMessage } = await import('./waha-webhook')
    const n = normalizeWahaMessage({
      id: 'false_5511999999999@c.us_ABC',
      from: '5511999999999@c.us',
      fromMe: false,
      body: 'olá',
      hasMedia: false,
      timestamp: 1767998400,
      _data: { notifyName: 'Fulano' },
    }, '/api/whatsapp/waha/media')
    expect(n).toMatchObject({
      externalId: 'false_5511999999999@c.us_ABC',
      fromPhone: '5511999999999',
      contactName: 'Fulano',
      contentType: 'text',
      contentText: 'olá',
      mediaUrl: null,
      fromMe: false,
    })
    expect(n!.timestamp.toISOString()).toBe('2026-01-09T22:40:00.000Z')
  })

  it('normalizeWahaMessage converte mídia para URL do proxy', async () => {
    const { normalizeWahaMessage } = await import('./waha-webhook')
    const n = normalizeWahaMessage({
      id: 'x', from: '55@c.us', fromMe: false, body: 'legenda',
      hasMedia: true,
      media: { url: 'http://waha.local:3001/api/files/x.jpg', mimetype: 'image/jpeg', filename: null },
      timestamp: 1767998400,
    }, '/api/whatsapp/waha/media')
    expect(n!.contentType).toBe('image')
    expect(n!.mediaUrl).toBe('/api/whatsapp/waha/media?src=' + encodeURIComponent('http://waha.local:3001/api/files/x.jpg'))
    expect(n!.contentText).toBe('legenda')
  })

  it('buildMediaProxyUrl reconstrói byte a byte a URL gravada pela normalização', async () => {
    const { buildMediaProxyUrl, normalizeWahaMessage } = await import('./waha-webhook')
    // Fonte com caracteres que exigem encoding (querystring, espaço, acento).
    const src = 'http://waha.local:3001/api/files/relatório final.jpg?session=a&id=b'
    const n = normalizeWahaMessage({
      id: 'x', from: '55@c.us', fromMe: false, hasMedia: true,
      media: { url: src, mimetype: 'image/jpeg', filename: null },
      timestamp: 1767998400,
    }, '/api/whatsapp/waha/media')
    // A rota do proxy recebe `src` já DECODIFICADO por searchParams.get() e
    // precisa reconstruir exatamente a string persistida em messages.media_url
    // para a checagem de autorização por conta bater byte a byte.
    const decoded = new URLSearchParams(n!.mediaUrl!.split('?')[1]).get('src')
    expect(decoded).toBe(src)
    expect(buildMediaProxyUrl('/api/whatsapp/waha/media', decoded!)).toBe(n!.mediaUrl)
  })

  it('normalizeWahaMessage aceita contraparte @lid já traduzida pela rota (telefone real)', async () => {
    // Simula o que a ROTA faz antes de chamar normalize: quando o payload
    // original trazia 'from' terminado em '@lid', ela resolve via
    // getLidPhone e substitui o campo pelo `pn` retornado (ex.:
    // '5511981453314@c.us') antes de invocar esta função pura.
    const { normalizeWahaMessage } = await import('./waha-webhook')
    const n = normalizeWahaMessage({
      id: 'false_5511981453314@c.us_XYZ',
      from: '5511981453314@c.us',
      fromMe: false,
      body: 'oi via LID',
      hasMedia: false,
      timestamp: 1767998400,
    }, '/api/whatsapp/waha/media')
    expect(n).toMatchObject({
      fromPhone: '5511981453314',
      contentText: 'oi via LID',
    })
  })

  it('normalizeWahaMessage aceita contraparte @lid bruta sem retornar null (tradução é responsabilidade da rota)', async () => {
    // normalize é pura/síncrona e não faz a chamada de rede que traduz o
    // LID — por isso ela não rejeita o sufixo @lid (evita voltar a
    // descartar a mensagem silenciosamente), mas também não inventa um
    // telefone: fromPhone aqui é o LID cru, exatamente o motivo pelo qual
    // a ROTA deve sempre substituir o campo antes de chamar normalize.
    const { normalizeWahaMessage } = await import('./waha-webhook')
    const n = normalizeWahaMessage({
      id: 'x',
      from: '138061891522811@lid',
      fromMe: false,
      body: 'oi',
      hasMedia: false,
      timestamp: 1,
    }, '/api/whatsapp/waha/media')
    expect(n).not.toBe(null)
    expect(n!.fromPhone).toBe('138061891522811')
  })

  it('ignora eventos de grupo (sufixo @g.us)', async () => {
    const { normalizeWahaMessage } = await import('./waha-webhook')
    const n = normalizeWahaMessage({ id: 'x', from: '5511-123@g.us', fromMe: false, body: 'oi',
      hasMedia: false, timestamp: 1 }, '/api/whatsapp/waha/media')
    expect(n).toBe(null)
  })
})
