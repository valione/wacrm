import { sendTextMessage, sendMediaMessage } from '@/lib/whatsapp/meta-api'
import type { WhatsAppProvider } from './types'
import { CAPABILITIES } from './types'

/** Embrulho fino: delega ao meta-api.ts existente sem mudar comportamento. */
export function metaProvider(phoneNumberId: string, accessToken: string): WhatsAppProvider {
  return {
    name: 'meta',
    capabilities: CAPABILITIES.meta,
    async sendText({ to, text, replyToExternalId }) {
      const r = await sendTextMessage({ phoneNumberId, accessToken, to, text, contextMessageId: replyToExternalId })
      return { messageId: r.messageId }
    },
    async sendMedia({ to, kind, mediaUrl, caption, filename, replyToExternalId }) {
      const r = await sendMediaMessage({
        phoneNumberId, accessToken, to, kind, link: mediaUrl,
        caption, filename, contextMessageId: replyToExternalId,
      })
      return { messageId: r.messageId }
    },
  }
}
