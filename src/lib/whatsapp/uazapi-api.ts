// Cliente HTTP do servidor Uazapi (https://docs.uazapi.com/).
// Espelha o papel do waha-api.ts para o provedor Uazapi: cada função faz
// um fetch isolado, lança em non-2xx e retorna dados mínimos.
// Server-side apenas — usa UAZAPI_ADMIN_TOKEN (endpoints administrativos,
// como criar instância) e o token de cada instância (demais endpoints).

function uazapiBase(): string {
  const url = process.env.UAZAPI_URL
  if (!url) throw new Error('UAZAPI_URL não configurada')
  return url.replace(/\/$/, '')
}

export function uazapiEnabled(): boolean {
  // As TRÊS envs são obrigatórias. Sem UAZAPI_WEBHOOK_SECRET a URL do
  // webhook fica sem o segredo embutido (a Uazapi não assina webhooks com
  // HMAC) — qualquer um poderia forjar eventos. Melhor nem oferecer a
  // opção do que oferecê-la insegura.
  return Boolean(
    process.env.UAZAPI_URL &&
    process.env.UAZAPI_ADMIN_TOKEN &&
    process.env.UAZAPI_WEBHOOK_SECRET,
  )
}

export function uazapiInstanceName(accountId: string): string {
  return `wacrm_${accountId}`
}

/** Injeta o header certo — `token` da instância ou `admintoken` do servidor. */
async function uazapiFetch(
  path: string,
  init?: RequestInit,
  auth?: { token?: string; admin?: boolean },
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (auth?.admin) headers.admintoken = process.env.UAZAPI_ADMIN_TOKEN ?? ''
  else if (auth?.token) headers.token = auth.token

  const response = await fetch(`${uazapiBase()}${path}`, { ...init, headers })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Uazapi ${path} falhou: ${response.status} ${body.slice(0, 300)}`)
  }
  return response
}

/**
 * Erro do uazapiFetch que indica instância morta (401 = token
 * expirado/inválido, 404 = instância apagada — o demo server apaga em 1h).
 * Ancorado no prefixo `falhou: <status>` que o próprio uazapiFetch monta,
 * para um "401"/"404" solto dentro do corpo do erro não gerar falso
 * positivo. Erros de rede/5xx retornam false — o call site NÃO deve
 * tratá-los como instância morta (ver ramo de reconexão da rota de
 * instância, que só faz limpeza destrutiva quando isto retorna true).
 */
export function isGoneError(err: unknown): boolean {
  return err instanceof Error && /falhou: (401|404)\b/.test(err.message)
}

/** Tolera 401/404: instância expirada ou já apagada (o demo server apaga em 1h). */
async function tolerate401or404(fn: () => Promise<Response>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (!isGoneError(err)) throw err
  }
}

export interface UazapiInstanceStatus {
  status: 'disconnected' | 'connecting' | 'connected' | 'hibernated'
  qrcode: string | null
  phone: string | null
  loggedIn: boolean
}

/**
 * Cria a instância no servidor Uazapi. Retorna o token que autentica as
 * demais chamadas e o id da instância (`instance.id` na resposta) — é
 * esse id, não o nome, que a Uazapi manda no campo `instance` do payload
 * do webhook (confirmado no OpenAPI: `WebhookEvent.instance` = "ID da
 * instância que gerou o evento"; migração 038 documenta a mesma decisão).
 * `provider_session` em whatsapp_config precisa guardar esse id para o
 * webhook conseguir resolver a conta pelo evento recebido.
 */
export async function createInstance(args: { name: string }): Promise<{ token: string; id: string }> {
  const r = await uazapiFetch(
    '/instance/create',
    { method: 'POST', body: JSON.stringify({ name: args.name }) },
    { admin: true },
  )
  const data = await r.json()
  if (!data.token) throw new Error('Uazapi createInstance: resposta sem token')
  if (!data.instance?.id) throw new Error('Uazapi createInstance: resposta sem instance.id')
  return { token: data.token, id: data.instance.id }
}

export async function connectInstance(args: { token: string }): Promise<void> {
  await uazapiFetch(
    '/instance/connect',
    { method: 'POST', body: JSON.stringify({}) },
    { token: args.token },
  )
}

export async function getInstanceStatus(args: { token: string }): Promise<UazapiInstanceStatus> {
  const r = await uazapiFetch('/instance/status', undefined, { token: args.token })
  const data = await r.json()
  return {
    status: data.instance?.status,
    qrcode: data.instance?.qrcode || null,
    phone: data.status?.jid?.user ?? null,
    loggedIn: Boolean(data.status?.loggedIn),
  }
}

export async function disconnectInstance(args: { token: string }): Promise<void> {
  await tolerate401or404(() =>
    uazapiFetch('/instance/disconnect', { method: 'POST' }, { token: args.token }))
}

export async function deleteInstance(args: { token: string }): Promise<void> {
  await tolerate401or404(() =>
    uazapiFetch('/instance', { method: 'DELETE' }, { token: args.token }))
}

export async function setInstanceWebhook(args: { token: string; url: string }): Promise<void> {
  await uazapiFetch(
    '/webhook',
    {
      method: 'POST',
      body: JSON.stringify({
        url: args.url,
        // A Uazapi registra webhooks DESATIVADOS por padrão — sem
        // enabled: true nenhum evento é entregue (descoberto no E2E).
        enabled: true,
        // wasSentByApi evita o loop: sem isso, mensagens enviadas por nós
        // mesmos via API voltariam pelo webhook como se fossem novas.
        events: ['messages', 'messages_update', 'connection'],
        excludeMessages: ['wasSentByApi'],
      }),
    },
    { token: args.token },
  )
}

export async function uazapiSendText(args: {
  token: string; number: string; text: string; replyId?: string
}): Promise<{ messageId: string }> {
  const r = await uazapiFetch(
    '/send/text',
    {
      method: 'POST',
      body: JSON.stringify({
        number: args.number,
        text: args.text,
        ...(args.replyId ? { replyid: args.replyId } : {}),
      }),
    },
    { token: args.token },
  )
  const data = await r.json()
  if (!data.messageid) throw new Error('Uazapi sendText: resposta sem messageid')
  return { messageId: data.messageid }
}

const UAZAPI_MEDIA_TYPE = {
  image: 'image',
  video: 'video',
  document: 'document',
  audio: 'ptt',
} as const

export async function uazapiSendMedia(args: {
  token: string; number: string
  kind: keyof typeof UAZAPI_MEDIA_TYPE
  url: string; caption?: string; docName?: string
}): Promise<{ messageId: string }> {
  const r = await uazapiFetch(
    '/send/media',
    {
      method: 'POST',
      body: JSON.stringify({
        number: args.number,
        type: UAZAPI_MEDIA_TYPE[args.kind],
        file: args.url,
        ...(args.caption ? { text: args.caption } : {}),
        ...(args.docName ? { docName: args.docName } : {}),
      }),
    },
    { token: args.token },
  )
  const data = await r.json()
  if (!data.messageid) throw new Error('Uazapi sendMedia: resposta sem messageid')
  return { messageId: data.messageid }
}

export async function uazapiSendReaction(args: {
  token: string; number: string; messageId: string; emoji: string
}): Promise<void> {
  await uazapiFetch(
    '/message/react',
    { method: 'POST', body: JSON.stringify({ number: args.number, text: args.emoji, id: args.messageId }) },
    { token: args.token },
  )
}

/** Baixa mídia hospedada no próprio servidor Uazapi. Só aceita URLs de UAZAPI_URL. */
export async function downloadUazapiMedia(args: { url: string }): Promise<Response> {
  if (!args.url.startsWith(uazapiBase() + '/')) {
    throw new Error('URL de mídia fora do servidor Uazapi')
  }
  return uazapiFetch(args.url.slice(uazapiBase().length))
}
