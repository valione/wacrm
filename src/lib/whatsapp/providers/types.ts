export interface ProviderCapabilities {
  supportsTemplates: boolean
  has24hWindow: boolean
  supportsInteractive: boolean
  supportsReactions: boolean
}

export const CAPABILITIES: Record<'meta' | 'waha' | 'uazapi', ProviderCapabilities> = {
  meta: { supportsTemplates: true, has24hWindow: true, supportsInteractive: true, supportsReactions: true },
  waha: { supportsTemplates: false, has24hWindow: false, supportsInteractive: false, supportsReactions: false },
  uazapi: { supportsTemplates: false, has24hWindow: false, supportsInteractive: false, supportsReactions: true },
}

export interface WhatsAppProvider {
  readonly name: 'meta' | 'waha' | 'uazapi'
  readonly capabilities: ProviderCapabilities
  sendText(args: { to: string; text: string; replyToExternalId?: string }): Promise<{ messageId: string }>
  sendMedia(args: {
    to: string
    kind: 'image' | 'video' | 'document' | 'audio'
    mediaUrl: string
    caption?: string
    filename?: string
    replyToExternalId?: string
  }): Promise<{ messageId: string }>
}
