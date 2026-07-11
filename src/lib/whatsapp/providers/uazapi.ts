import { uazapiSendText, uazapiSendMedia } from '@/lib/whatsapp/uazapi-api'
import type { WhatsAppProvider } from './types'
import { CAPABILITIES } from './types'

export function uazapiProvider(instanceToken: string): WhatsAppProvider {
  return {
    name: 'uazapi',
    capabilities: CAPABILITIES.uazapi,
    async sendText({ to, text, replyToExternalId }) {
      return uazapiSendText({ token: instanceToken, number: to, text, replyId: replyToExternalId })
    },
    async sendMedia({ to, kind, mediaUrl, caption, filename }) {
      return uazapiSendMedia({
        token: instanceToken,
        number: to,
        kind,
        url: mediaUrl,
        caption,
        docName: filename,
      })
    },
  }
}
