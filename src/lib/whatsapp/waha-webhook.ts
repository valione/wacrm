// Normalização de eventos do webhook WAHA -> pipeline inbound compartilhado.
import crypto from 'node:crypto'
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound'
import { fromChatId } from '@/lib/whatsapp/waha-api'
import { buildMediaProxyUrl } from '@/lib/whatsapp/media-proxy'

// Re-exportado para não quebrar os call sites existentes (este arquivo e
// src/app/api/whatsapp/waha/media/route.ts importavam a definição local).
// A implementação real agora mora em media-proxy.ts — módulo neutro
// compartilhado com o webhook Uazapi (ver comentário lá).
export { buildMediaProxyUrl }

/** HMAC-SHA512 hex do corpo cru, chave WAHA_WEBHOOK_SECRET. Fail-closed. */
export function verifyWahaHmac(rawBody: string, headerValue: string | null): boolean {
  const secret = process.env.WAHA_WEBHOOK_SECRET
  if (!secret || !headerValue) return false
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected, 'hex')
  let b: Buffer
  try { b = Buffer.from(headerValue, 'hex') } catch { return false }
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** Escala de ack da WAHA: -1 ERROR, 0 PENDING, 1 SERVER, 2 DEVICE, 3 READ, 4 PLAYED. */
export function mapAckToStatus(ack: number): 'sent' | 'delivered' | 'read' | 'failed' | null {
  if (ack === -1) return 'failed'
  if (ack === 1) return 'sent'
  if (ack === 2) return 'delivered'
  if (ack === 3 || ack === 4) return 'read'
  return null
}

interface WahaMessagePayload {
  id: string
  from: string
  /** Presente em ecos fromMe: o chat do interlocutor (destino). */
  to?: string
  fromMe: boolean
  body?: string
  hasMedia?: boolean
  media?: { url: string; mimetype?: string | null; filename?: string | null } | null
  timestamp: number
  replyTo?: string | null
  _data?: { notifyName?: string } | null
}

const MIME_TO_CONTENT: Array<[RegExp, NormalizedInboundMessage['contentType']]> = [
  [/^image\//, 'image'],
  [/^video\//, 'video'],
  [/^audio\//, 'audio'],
]

/** Retorna null para eventos que a fase 1 não ingere (grupos, status@broadcast). */
export function normalizeWahaMessage(
  payload: WahaMessagePayload,
  mediaProxyPath: string,
): NormalizedInboundMessage | null {
  // fromMe: o interlocutor é o 'to'; inbound: é o 'from'.
  const counterpart = payload.fromMe ? payload.to ?? payload.from : payload.from
  if (!counterpart.endsWith('@c.us') && !counterpart.endsWith('@s.whatsapp.net')) return null

  let contentType: NormalizedInboundMessage['contentType'] = 'text'
  let mediaUrl: string | null = null
  if (payload.hasMedia && payload.media?.url) {
    const mime = payload.media.mimetype ?? ''
    contentType = MIME_TO_CONTENT.find(([re]) => re.test(mime))?.[1] ?? 'document'
    mediaUrl = buildMediaProxyUrl(mediaProxyPath, payload.media.url)
  }

  return {
    externalId: payload.id,
    fromPhone: fromChatId(counterpart),
    contactName: payload._data?.notifyName ?? null,
    contentType,
    contentText: payload.body || null,
    mediaUrl,
    timestamp: new Date(payload.timestamp * 1000),
    replyToExternalId: payload.replyTo ?? null,
    interactiveReplyId: null,
    fromMe: payload.fromMe,
  }
}
