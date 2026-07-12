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

  // Formato REAL confirmado no E2E (via GET /webhook/errors do servidor):
  //   { BaseUrl, EventType: 'messages', instanceName: 'wacrm_<accountId>',
  //     owner, token, chat: {...}, message: {...} }
  //   { EventType: 'messages_update', event: {MessageIDs, Type, Timestamp}, ... }
  // — difere do OpenAPI publicado ({event, instance, data}), que mantemos
  // como fallback caso outra versão do servidor use o formato documentado.
  let event: {
    event?: string
    EventType?: string
    instance?: string
    instanceName?: string
    data?: unknown
    message?: unknown
  }
  try { event = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const eventType = event.EventType ?? event.event ?? ''

  // Resolve a conta. O payload real NÃO traz o id da instância
  // (provider_session) — traz `instanceName`, que nós mesmos definimos no
  // create como `wacrm_<account_id>` (uazapiInstanceName). Confiar nele é
  // seguro porque o segredo da URL já autenticou a origem. O caminho por
  // `instance`/provider_session fica como fallback do formato documentado.
  const db = supabaseAdmin()
  let config: { account_id: string; user_id: string } | null = null
  if (event.instance) {
    const { data } = await db
      .from('whatsapp_config')
      .select('account_id, user_id')
      .eq('provider_session', event.instance)
      .eq('provider', 'uazapi')
      .maybeSingle()
    config = data
  }
  if (!config && event.instanceName?.startsWith('wacrm_')) {
    const accountId = event.instanceName.slice('wacrm_'.length)
    const { data } = await db
      .from('whatsapp_config')
      .select('account_id, user_id')
      .eq('account_id', accountId)
      .eq('provider', 'uazapi')
      .maybeSingle()
    config = data
  }
  if (!config) {
    console.warn(
      '[webhook/uazapi] instância sem config, descartando:',
      event.instance ?? event.instanceName,
    )
    return NextResponse.json({ received: true })
  }

  // O container do dado varia por tipo de evento no formato real:
  // messages → `message`; messages_update/connection → `event` (o campo,
  // não o tipo); formato documentado → sempre `data`.
  const raw = event as Record<string, unknown>

  after(async () => {
    try {
      if (eventType === 'messages') {
        const normalized = normalizeUazapiMessage(
          (event.message ?? event.data) as UazapiMessagePayload,
          '/api/whatsapp/uazapi/media',
        )
        if (normalized) await persistInboundMessage(normalized, config.account_id, config.user_id)
      } else if (eventType === 'messages_update') {
        // Real: {MessageIDs: string[], Type: 'Read'|..., Timestamp: segundos}
        // Doc:  {messageid, status, messageTimestamp: ms}
        const p = (raw.event ?? event.data ?? {}) as {
          MessageIDs?: string[]
          Type?: string
          Timestamp?: number
          messageid?: string
          id?: string
          status?: string
          messageTimestamp?: number
        }
        const ids = p.MessageIDs ?? (p.messageid ? [p.messageid] : p.id ? [p.id] : [])
        const status = mapUazapiStatus(p.Type ?? p.status ?? '')
        // Timestamp real vem em SEGUNDOS; messageTimestamp documentado, em ms.
        const ts =
          typeof p.Timestamp === 'number' ? new Date(p.Timestamp * 1000)
          : typeof p.messageTimestamp === 'number' ? new Date(p.messageTimestamp)
          : undefined
        if (status) {
          for (const externalId of ids) {
            await applyStatusByExternalId(externalId, status, ts)
          }
        }
      } else if (eventType === 'connection') {
        const p = (raw.event ?? event.data ?? {}) as { status?: string; state?: string }
        const connStatus = p.status ?? p.state
        // Update por account_id (+provider), não por provider_session — o
        // formato real não traz o id da instância no payload.
        if (connStatus === 'disconnected' || connStatus === 'hibernated') {
          await db.from('whatsapp_config')
            .update({ status: 'disconnected' })
            .eq('account_id', config.account_id)
            .eq('provider', 'uazapi')
          await db.from('notifications').insert({
            account_id: config.account_id,
            user_id: config.user_id,
            type: 'whatsapp_disconnected',
            title: 'Sessão do WhatsApp desconectada',
            body: 'Sua instância Uazapi caiu — reconecte pelo QR Code em Configurações → WhatsApp.',
          })
        } else if (connStatus === 'connected') {
          await db.from('whatsapp_config')
            .update({ status: 'connected' })
            .eq('account_id', config.account_id)
            .eq('provider', 'uazapi')
        }
      }
    } catch (err) {
      console.error('[webhook/uazapi] processamento falhou:', err)
    }
  })

  return NextResponse.json({ received: true })
}
