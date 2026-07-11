import type { WhatsAppConfig } from '@/types'
import type { WhatsAppProvider } from './types'
import { metaProvider } from './meta'
import { wahaProvider } from './waha'
import { uazapiProvider } from './uazapi'

export type { WhatsAppProvider, ProviderCapabilities } from './types'
export { CAPABILITIES } from './types'

/**
 * Resolve a instância de provedor a partir da linha de whatsapp_config.
 * Para Meta, o chamador já descriptografou o token (padrão atual dos
 * call sites); para WAHA o token é ignorado.
 */
export function resolveProvider(
  config: Pick<WhatsAppConfig, 'provider' | 'phone_number_id' | 'provider_session'>,
  accessToken: string | null,
): WhatsAppProvider {
  if (config.provider === 'waha') {
    if (!config.provider_session) throw new Error('Config WAHA sem sessão WAHA vinculada — reconecte pelo QR Code.')
    return wahaProvider(config.provider_session)
  }
  if (config.provider === 'uazapi') {
    if (!config.provider_session) throw new Error('Config Uazapi sem instância vinculada — reconecte pelo QR Code.')
    if (!accessToken) throw new Error('Config Uazapi sem token de instância descriptografado.')
    return uazapiProvider(accessToken)
  }
  if (!config.phone_number_id) throw new Error('Config Meta sem phone_number_id.')
  if (!accessToken) throw new Error('Config Meta sem access token descriptografado.')
  return metaProvider(config.phone_number_id, accessToken)
}
