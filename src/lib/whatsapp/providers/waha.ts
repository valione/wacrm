import { wahaSendText, wahaSendMedia, toChatId } from '@/lib/whatsapp/waha-api'
import type { WhatsAppProvider } from './types'
import { CAPABILITIES } from './types'

export function wahaProvider(session: string): WhatsAppProvider {
  return {
    name: 'waha',
    capabilities: CAPABILITIES.waha,
    async sendText({ to, text, replyToExternalId }) {
      return wahaSendText({ session, chatId: toChatId(to), text, replyTo: replyToExternalId })
    },
    async sendMedia({ to, kind, mediaUrl, caption, filename }) {
      return wahaSendMedia({ session, chatId: toChatId(to), kind, url: mediaUrl, caption, filename })
    },
  }
}
