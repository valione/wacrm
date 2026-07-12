// Normalização de eventos do webhook Uazapi -> pipeline inbound compartilhado.
//
// Diferença estrutural mais importante em relação à WAHA: a Uazapi NÃO
// assina o corpo do webhook (sem HMAC). A autenticação é um segredo simples
// embutido na URL configurada (`?s=<UAZAPI_WEBHOOK_SECRET>`), validado aqui
// com comparação em tempo constante — ver verifyUrlSecret.
//
// Nomes de campo ancorados no schema `Message` real do OpenAPI da Uazapi
// (curl -s https://docs.uazapi.com/openapi-bundled.json | jq
// '.components.schemas.Message'), consultado na Task 4: messageid, chatid,
// sender, senderName, isGroup, fromMe, messageType, messageTimestamp (ms),
// text, content, quoted, fileURL, status.
import crypto from 'node:crypto'
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound'
import { buildMediaProxyUrl } from '@/lib/whatsapp/media-proxy'

export { buildMediaProxyUrl }

/**
 * Segredo simples via querystring (`?s=`), pois a Uazapi não assina
 * webhooks com HMAC — ver comentário de topo. Comparação em tempo
 * constante via crypto.timingSafeEqual; comprimentos diferentes retornam
 * false imediatamente (timingSafeEqual lança se os buffers não tiverem o
 * mesmo tamanho, então essa guarda vem antes, não depois).
 */
export function verifyUrlSecret(provided: string | null): boolean {
  const secret = process.env.UAZAPI_WEBHOOK_SECRET
  if (!secret || !provided) return false
  const a = Buffer.from(secret, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Escada de status do schema Message.status: `Queued`, `Canceled`, `Failed`,
 * `Sent`, `Delivered`, `Read`. Queued/Canceled/desconhecido não regridem a
 * escada do pipeline compartilhado (applyStatusByExternalId já é
 * forward-only; aqui só filtramos o que nem é um status terminal válido).
 */
export function mapUazapiStatus(
  status: string,
): 'sent' | 'delivered' | 'read' | 'failed' | null {
  switch (status) {
    case 'Sent': return 'sent'
    case 'Delivered': return 'delivered'
    case 'Read': return 'read'
    case 'Failed': return 'failed'
    default: return null // Queued, Canceled, ou qualquer valor não mapeado
  }
}

// Extrai o número de um chatid/sender no formato '<dígitos>@sufixo'
// ('@s.whatsapp.net' para contatos, '@g.us' para grupos). Réplica de
// fromChatId (waha-api.ts) — não importamos de lá para não acoplar o
// código da Uazapi a um módulo de outro provedor por uma função de uma
// linha sem nenhuma lógica específica da WAHA.
function fromChatId(chatId: string): string {
  return chatId.replace(/@.*$/, '')
}

const MESSAGE_TYPE_TO_CONTENT: Array<[RegExp, NormalizedInboundMessage['contentType']]> = [
  [/image/i, 'image'],
  [/video/i, 'video'],
  [/audio|ptt/i, 'audio'],
  [/document/i, 'document'],
]

export interface UazapiMessagePayload {
  messageid: string
  chatid: string
  sender: string
  senderName?: string | null
  isGroup?: boolean
  fromMe: boolean
  messageType?: string | null
  messageTimestamp: number
  /** Texto original — nome de campo confirmado no schema Message. */
  text?: string | null
  /**
   * "Conteúdo bruto (JSON serializado ou texto)" por doc do schema — o
   * spec é ambíguo sobre quando `text` vs `content` vem populado.
   * Toleramos string solta aqui como fallback quando `text` está ausente;
   * PENDENTE confirmar no E2E qual campo a Uazapi realmente usa em
   * produção para mensagens de texto simples.
   */
  content?: unknown
  quoted?: string | null
  /** URL do arquivo de mídia, quando presente no próprio evento do webhook. */
  fileURL?: string | null
}

/** Retorna null para mensagens de grupo — fase 1 não as ingere (mesmo corte que a WAHA). */
export function normalizeUazapiMessage(
  data: UazapiMessagePayload,
  mediaProxyPath: string,
): NormalizedInboundMessage | null {
  if (data.isGroup || data.chatid.endsWith('@g.us')) return null

  const contentText = data.text || (typeof data.content === 'string' ? data.content : null) || null

  let contentType: NormalizedInboundMessage['contentType'] = 'text'
  let mediaUrl: string | null = null
  if (data.fileURL) {
    contentType = MESSAGE_TYPE_TO_CONTENT.find(([re]) => re.test(data.messageType ?? ''))?.[1] ?? 'document'
    mediaUrl = buildMediaProxyUrl(mediaProxyPath, data.fileURL)
  }

  return {
    externalId: data.messageid,
    fromPhone: fromChatId(data.chatid),
    contactName: data.senderName || null,
    contentType,
    contentText,
    mediaUrl,
    // messageTimestamp já vem em milissegundos (ao contrário da WAHA, que
    // usa segundos) — ver descrição do campo no schema Message.
    timestamp: new Date(data.messageTimestamp),
    replyToExternalId: data.quoted || null,
    interactiveReplyId: null,
    fromMe: data.fromMe,
    // O schema Message do OpenAPI da Uazapi (consultado na Task 4) NÃO expõe
    // um campo de referral/CTWA/adsSourceUrl equivalente ao `message.referral`
    // da Meta — os campos próximos (`source`, `track_source`, `track_id`) são
    // genéricos de rastreamento, não o payload de anúncio click-to-WhatsApp.
    // Deixamos null; confirmar payload real de uma conversa vinda de anúncio
    // no E2E antes de mapear qualquer campo.
    adReferral: null,
  }
}
