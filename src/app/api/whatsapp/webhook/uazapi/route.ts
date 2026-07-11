// Webhook da Uazapi (WhatsApp via QR Code, provedor alternativo à WAHA).
// Espelha o papel do webhook WAHA (src/app/api/whatsapp/webhook/waha/route.ts):
// verifica o segredo, resolve a conta pela instância e entrega ao pipeline
// inbound compartilhado dentro de um `after()` para não bloquear a resposta
// 200 que a Uazapi espera receber rapidamente.
//
// Diferença de autenticação: a Uazapi NÃO assina webhooks com HMAC. O
// segredo vai embutido na própria URL configurada (`?s=...`), validado por
// verifyUrlSecret (comparação em tempo constante).
import { NextRequest, NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  verifyUrlSecret,
  normalizeUazapiMessage,
  mapUazapiStatus,
  type UazapiMessagePayload,
} from '@/lib/whatsapp/uazapi-webhook'
import { persistInboundMessage, applyStatusByExternalId } from '@/lib/whatsapp/inbound'
import { uazapiEnabled } from '@/lib/whatsapp/uazapi-api'

// Mesmo tuning do webhook WAHA — dá margem para o processamento em
// after() (persistInboundMessage pode encadear automações/flows/AI reply).
export const maxDuration = 60

export async function POST(request: NextRequest) {
  if (!uazapiEnabled()) return NextResponse.json({ error: 'Uazapi not configured' }, { status: 501 })

  const providedSecret = request.nextUrl.searchParams.get('s')
  if (!verifyUrlSecret(providedSecret)) {
    return NextResponse.json({ error: 'Invalid secret' }, { status: 401 })
  }

  let event: { event: string; instance: string; data: unknown }
  try { event = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Resolve a conta pela instância — espelha o roteamento por
  // provider_session do webhook WAHA (migração 038 generalizou a coluna
  // para valer para qualquer provedor não-Meta).
  const db = supabaseAdmin()
  const { data: config } = await db
    .from('whatsapp_config')
    .select('account_id, user_id, provider_session')
    .eq('provider_session', event.instance)
    .eq('provider', 'uazapi')
    .maybeSingle()
  if (!config) {
    console.warn('[webhook/uazapi] instância sem config, descartando:', event.instance)
    return NextResponse.json({ received: true })
  }

  after(async () => {
    try {
      if (event.event === 'messages') {
        const normalized = normalizeUazapiMessage(
          event.data as UazapiMessagePayload,
          '/api/whatsapp/uazapi/media',
        )
        if (normalized) await persistInboundMessage(normalized, config.account_id, config.user_id)
      } else if (event.event === 'messages_update') {
        const p = event.data as { messageid?: string; id?: string; status?: string; messageTimestamp?: number }
        const externalId = p.messageid ?? p.id
        const status = p.status ? mapUazapiStatus(p.status) : null
        if (externalId && status) {
          await applyStatusByExternalId(
            externalId,
            status,
            typeof p.messageTimestamp === 'number' ? new Date(p.messageTimestamp) : undefined,
          )
        }
      } else if (event.event === 'connection') {
        const p = event.data as { status?: string }
        if (p.status === 'disconnected' || p.status === 'hibernated') {
          await db.from('whatsapp_config')
            .update({ status: 'disconnected' })
            .eq('provider_session', event.instance)
          await db.from('notifications').insert({
            account_id: config.account_id,
            user_id: config.user_id,
            type: 'whatsapp_disconnected',
            title: 'Sessão do WhatsApp desconectada',
            body: 'Sua instância Uazapi caiu — reconecte pelo QR Code em Configurações → WhatsApp.',
          })
        } else if (p.status === 'connected') {
          await db.from('whatsapp_config')
            .update({ status: 'connected' })
            .eq('provider_session', event.instance)
        }
      }
    } catch (err) {
      console.error('[webhook/uazapi] processamento falhou:', err)
    }
  })

  return NextResponse.json({ received: true })
}
