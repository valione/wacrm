import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'
import { uazapiSendPresence } from './uazapi-api'
import { resolveContactSendTarget } from './wa-identity'

/** Tempo do "digitando…": cobre a geração da resposta; some quando ela chega. */
const TYPING_MS = 25_000

/**
 * "Digitando…" da resposta da IA em conta Uazapi. Retorna false quando a
 * conta não é Uazapi (o chamador segue para o caminho da Meta).
 *
 * Não espera a Uazapi responder: a presença pode segurar a requisição
 * pelo tempo do `delay`, e a resposta da IA não pode esperar por ela.
 */
export async function showUazapiTyping(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  accountId: string,
  contactId: string,
): Promise<boolean> {
  const { data: config } = await db
    .from('whatsapp_config')
    .select('provider, access_token')
    .eq('account_id', accountId)
    .maybeSingle()
  if (config?.provider !== 'uazapi') return false

  const { data: contact } = await db
    .from('contacts')
    .select('phone, wa_user_id')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  const target = resolveContactSendTarget(contact)
  if (!target || !config.access_token) return true

  void uazapiSendPresence({
    token: decrypt(config.access_token),
    number: target.target,
    delayMs: TYPING_MS,
  }).catch((err) => console.warn('[ai auto-reply] digitando (Uazapi) falhou:', err))
  return true
}
