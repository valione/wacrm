// Cliente HTTP do servidor WAHA (https://waha.devlike.pro/swagger/).
// Espelha o papel do meta-api.ts para o provedor WAHA: cada função faz
// um fetch isolado, lança em non-2xx e retorna dados mínimos.
// Server-side apenas — usa WAHA_API_KEY.

function wahaBase(): string {
  const url = process.env.WAHA_URL
  if (!url) throw new Error('WAHA_URL não configurada')
  return url.replace(/\/$/, '')
}

export function wahaEnabled(): boolean {
  return Boolean(process.env.WAHA_URL && process.env.WAHA_API_KEY)
}

export function wahaSessionName(accountId: string): string {
  return `wacrm_${accountId}`
}

export function toChatId(phone: string): string {
  return `${phone.replace(/\D/g, '')}@c.us`
}

export function fromChatId(chatId: string): string {
  return chatId.replace(/@.*$/, '')
}

async function wahaFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${wahaBase()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': process.env.WAHA_API_KEY ?? '',
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`WAHA ${path} falhou: ${response.status} ${body.slice(0, 300)}`)
  }
  return response
}

export interface WahaSessionInfo {
  status: 'STOPPED' | 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'FAILED'
  me?: { id: string; pushName?: string }
}

/** Cria (ou recria) e inicia a sessão, já apontando o webhook de volta pro CRM. */
export async function createSession(args: { session: string; webhookUrl: string }): Promise<void> {
  await wahaFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      name: args.session,
      start: true,
      config: {
        webhooks: [
          {
            url: args.webhookUrl,
            events: ['message', 'message.ack', 'session.status'],
            hmac: { key: process.env.WAHA_WEBHOOK_SECRET ?? '' },
          },
        ],
      },
    }),
  })
}

export async function getSession(args: { session: string }): Promise<WahaSessionInfo> {
  const r = await wahaFetch(`/api/sessions/${encodeURIComponent(args.session)}`)
  const data = await r.json()
  return { status: data.status, me: data.me ?? undefined }
}

export async function getQrPng(args: { session: string }): Promise<ArrayBuffer> {
  const r = await wahaFetch(`/api/${encodeURIComponent(args.session)}/auth/qr`, {
    headers: { Accept: 'image/png' },
  })
  return r.arrayBuffer()
}

export async function logoutAndDelete(args: { session: string }): Promise<void> {
  // Logout desvincula o número; DELETE remove a sessão do servidor.
  // Ambos toleram 404 (sessão já removida) para o reset ser idempotente.
  const tolerate404 = async (fn: () => Promise<Response>) => {
    try { await fn() } catch (err) {
      if (!(err instanceof Error && /: 404/.test(err.message))) throw err
    }
  }
  await tolerate404(() =>
    wahaFetch(`/api/sessions/${encodeURIComponent(args.session)}/logout`, { method: 'POST' }))
  await tolerate404(() =>
    wahaFetch(`/api/sessions/${encodeURIComponent(args.session)}`, { method: 'DELETE' }))
}

export async function wahaSendText(args: {
  session: string; chatId: string; text: string; replyTo?: string
}): Promise<{ messageId: string }> {
  const r = await wahaFetch('/api/sendText', {
    method: 'POST',
    body: JSON.stringify({
      session: args.session,
      chatId: args.chatId,
      text: args.text,
      ...(args.replyTo ? { reply_to: args.replyTo } : {}),
    }),
  })
  const data = await r.json()
  // WAHA retorna o objeto da mensagem; id pode vir como string ou {id,_serialized}.
  const id = typeof data.id === 'string' ? data.id : data.id?._serialized
  if (!id) throw new Error('WAHA sendText: resposta sem id de mensagem')
  return { messageId: id }
}

const WAHA_MEDIA_PATHS = {
  image: '/api/sendImage',
  video: '/api/sendVideo',
  document: '/api/sendFile',
  audio: '/api/sendVoice',
} as const

export async function wahaSendMedia(args: {
  session: string; chatId: string
  kind: keyof typeof WAHA_MEDIA_PATHS
  url: string; caption?: string; filename?: string
}): Promise<{ messageId: string }> {
  const body: Record<string, unknown> = {
    session: args.session,
    chatId: args.chatId,
    file: { url: args.url, ...(args.filename ? { filename: args.filename } : {}) },
  }
  // Voz não aceita caption (mesma regra do caminho Meta para áudio).
  if (args.caption && args.kind !== 'audio') body.caption = args.caption
  const r = await wahaFetch(WAHA_MEDIA_PATHS[args.kind], { method: 'POST', body: JSON.stringify(body) })
  const data = await r.json()
  const id = typeof data.id === 'string' ? data.id : data.id?._serialized
  if (!id) throw new Error(`WAHA ${WAHA_MEDIA_PATHS[args.kind]}: resposta sem id`)
  return { messageId: id }
}

/** Baixa mídia hospedada no WAHA com a API key. Só aceita URLs do próprio servidor. */
export async function downloadWahaMedia(args: { url: string }): Promise<Response> {
  if (!args.url.startsWith(wahaBase() + '/')) {
    throw new Error('URL de mídia fora do servidor WAHA')
  }
  return wahaFetch(args.url.slice(wahaBase().length))
}
