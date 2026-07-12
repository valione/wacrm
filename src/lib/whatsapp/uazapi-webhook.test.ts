import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('uazapi-webhook helpers', () => {
  beforeEach(() => vi.stubEnv('UAZAPI_WEBHOOK_SECRET', 'segredo'))
  afterEach(() => vi.unstubAllEnvs())

  it('verifyUrlSecret aceita o segredo exato e rejeita errado/null/vazio', async () => {
    const { verifyUrlSecret } = await import('./uazapi-webhook')
    expect(verifyUrlSecret('segredo')).toBe(true)
    expect(verifyUrlSecret('errado')).toBe(false)
    expect(verifyUrlSecret(null)).toBe(false)
    expect(verifyUrlSecret('')).toBe(false)
  })

  it('verifyUrlSecret rejeita quando UAZAPI_WEBHOOK_SECRET não está configurado', async () => {
    vi.unstubAllEnvs()
    const { verifyUrlSecret } = await import('./uazapi-webhook')
    expect(verifyUrlSecret('segredo')).toBe(false)
  })

  it('verifyUrlSecret rejeita comprimento diferente sem lançar (guarda antes do timingSafeEqual)', async () => {
    const { verifyUrlSecret } = await import('./uazapi-webhook')
    expect(verifyUrlSecret('s')).toBe(false)
    expect(verifyUrlSecret('segredo-bem-mais-comprido')).toBe(false)
  })

  it('mapUazapiStatus mapeia a escada de status da Uazapi (schema Message.status)', async () => {
    const { mapUazapiStatus } = await import('./uazapi-webhook')
    expect(mapUazapiStatus('Sent')).toBe('sent')
    expect(mapUazapiStatus('Delivered')).toBe('delivered')
    expect(mapUazapiStatus('Read')).toBe('read')
    expect(mapUazapiStatus('Failed')).toBe('failed')
    expect(mapUazapiStatus('Queued')).toBe(null)
    expect(mapUazapiStatus('Canceled')).toBe(null)
    expect(mapUazapiStatus('AlgoDesconhecido')).toBe(null)
  })

  it('normalizeUazapiMessage converte texto simples (campos reais do schema Message)', async () => {
    const { normalizeUazapiMessage } = await import('./uazapi-webhook')
    const n = normalizeUazapiMessage({
      messageid: '3EB0C767D097B7C4A5F3',
      chatid: '5511999999999@s.whatsapp.net',
      sender: '5511999999999@s.whatsapp.net',
      fromMe: false,
      text: 'olá',
      messageTimestamp: 1767998400000,
      senderName: 'Fulano',
    }, '/api/whatsapp/uazapi/media')
    expect(n).toMatchObject({
      externalId: '3EB0C767D097B7C4A5F3',
      fromPhone: '5511999999999',
      contactName: 'Fulano',
      contentType: 'text',
      contentText: 'olá',
      mediaUrl: null,
      fromMe: false,
    })
    // messageTimestamp já vem em ms (ao contrário da WAHA, que usa segundos).
    expect(n!.timestamp.toISOString()).toBe('2026-01-09T22:40:00.000Z')
    // A Uazapi não expõe referral de anúncio (CTWA) no schema Message —
    // adReferral é sempre null até confirmação de payload real no E2E.
    expect(n!.adReferral).toBe(null)
  })

  it('normalizeUazapiMessage tolera texto em `content` (string) quando `text` está ausente', async () => {
    const { normalizeUazapiMessage } = await import('./uazapi-webhook')
    // O schema documenta `content` como "conteúdo bruto (JSON serializado ou
    // texto)" — ambíguo em relação a `text`. Toleramos string solta em
    // `content` como fallback; registrar para confirmação no E2E qual campo
    // a Uazapi realmente popula em produção.
    const n = normalizeUazapiMessage({
      messageid: 'x',
      chatid: '5511999999999@s.whatsapp.net',
      sender: '5511999999999@s.whatsapp.net',
      fromMe: false,
      content: 'texto via content',
      messageTimestamp: 1767998400000,
    }, '/api/whatsapp/uazapi/media')
    expect(n!.contentText).toBe('texto via content')
  })

  it('normalizeUazapiMessage converte mídia para URL do proxy usando fileURL + messageType', async () => {
    const { normalizeUazapiMessage } = await import('./uazapi-webhook')
    const n = normalizeUazapiMessage({
      messageid: 'x',
      chatid: '5511999999999@s.whatsapp.net',
      sender: '5511999999999@s.whatsapp.net',
      fromMe: false,
      text: 'legenda',
      messageType: 'imageMessage',
      fileURL: 'http://uazapi.local:8080/files/x.jpg',
      messageTimestamp: 1767998400000,
    }, '/api/whatsapp/uazapi/media')
    expect(n!.contentType).toBe('image')
    expect(n!.mediaUrl).toBe(
      '/api/whatsapp/uazapi/media?src=' + encodeURIComponent('http://uazapi.local:8080/files/x.jpg'),
    )
    expect(n!.contentText).toBe('legenda')
  })

  it('normalizeUazapiMessage mapeia sticker para image e cai para document no desconhecido', async () => {
    const { normalizeUazapiMessage } = await import('./uazapi-webhook')
    const base = {
      messageid: 'x',
      chatid: '5511999999999@s.whatsapp.net',
      sender: '5511999999999@s.whatsapp.net',
      fromMe: false,
      fileURL: 'http://uazapi.local:8080/files/x.webp',
      messageTimestamp: 1767998400000,
    }
    // sticker é webp — renderiza como imagem no inbox
    const sticker = normalizeUazapiMessage(
      { ...base, messageType: 'stickerMessage' }, '/api/whatsapp/uazapi/media')
    expect(sticker!.contentType).toBe('image')
    // tipo genuinamente desconhecido → document (link de download genérico)
    const unknown = normalizeUazapiMessage(
      { ...base, messageType: 'contactMessage' }, '/api/whatsapp/uazapi/media')
    expect(unknown!.contentType).toBe('document')
  })

  it('normalizeUazapiMessage usa mediaType do evento real (formato E2E) para o contentType', async () => {
    const { normalizeUazapiMessage } = await import('./uazapi-webhook')
    // Formato real capturado no E2E: mídia sem text, content objeto com a
    // URL criptografada do WhatsApp; fileURL injetado pela rota via
    // POST /message/download; mediaType 'image' no nível da mensagem.
    const n = normalizeUazapiMessage({
      messageid: 'A51369E177C0602EC726548E185811B3',
      chatid: '5511919089809@s.whatsapp.net',
      sender: '45402787156104@lid',
      fromMe: false,
      mediaType: 'image',
      content: { URL: 'https://mmg.whatsapp.net/v/x.enc', mediaKey: 'k' },
      fileURL: 'http://uazapi.local:8080/files/abc.jpg',
      messageTimestamp: 1783897463000,
    }, '/api/whatsapp/uazapi/media')
    expect(n!.contentType).toBe('image')
    expect(n!.contentText).toBeNull()
    expect(n!.mediaUrl).toBe(
      '/api/whatsapp/uazapi/media?src=' + encodeURIComponent('http://uazapi.local:8080/files/abc.jpg'),
    )
  })

  it('ignora mensagens de grupo (chatid @g.us)', async () => {
    const { normalizeUazapiMessage } = await import('./uazapi-webhook')
    const n = normalizeUazapiMessage({
      messageid: 'x',
      chatid: '5511123456-999@g.us',
      sender: '5511999999999@s.whatsapp.net',
      fromMe: false,
      text: 'oi grupo',
      messageTimestamp: 1,
    }, '/api/whatsapp/uazapi/media')
    expect(n).toBe(null)
  })

  it('ignora mensagens de grupo mesmo quando só o flag isGroup indica (chatid sem @g.us)', async () => {
    const { normalizeUazapiMessage } = await import('./uazapi-webhook')
    const n = normalizeUazapiMessage({
      messageid: 'x',
      chatid: '5511999999999@s.whatsapp.net',
      sender: '5511999999999@s.whatsapp.net',
      fromMe: false,
      isGroup: true,
      text: 'oi',
      messageTimestamp: 1,
    }, '/api/whatsapp/uazapi/media')
    expect(n).toBe(null)
  })

  it('propaga fromMe (excludeMessages: wasSentByApi já filtra ecos da própria API na origem)', async () => {
    const { normalizeUazapiMessage } = await import('./uazapi-webhook')
    const n = normalizeUazapiMessage({
      messageid: 'x',
      chatid: '5511999999999@s.whatsapp.net',
      sender: '5511999999999@s.whatsapp.net',
      fromMe: true,
      text: 'digitei no celular',
      messageTimestamp: 1767998400000,
    }, '/api/whatsapp/uazapi/media')
    expect(n!.fromMe).toBe(true)
  })
})
