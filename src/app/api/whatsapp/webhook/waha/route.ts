// Webhook da WAHA (WhatsApp via QR Code). Espelha o papel do webhook Meta
// (src/app/api/whatsapp/webhook/route.ts) para o segundo provedor:
// verifica HMAC, resolve a conta pela sessão e entrega ao pipeline
// inbound compartilhado dentro de um `after()` para não bloquear a
// resposta 200 que a WAHA espera receber rapidamente.
import { NextRequest, NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { verifyWahaHmac, normalizeWahaMessage, mapAckToStatus } from '@/lib/whatsapp/waha-webhook'
import { persistInboundMessage, applyStatusByExternalId } from '@/lib/whatsapp/inbound'
import { wahaEnabled } from '@/lib/whatsapp/waha-api'

// O callback do `after()` em POST roda dentro do maxDuration desta rota.
// Mesmo tuning do webhook Meta — dá margem para o processamento
// (persistInboundMessage pode encadear automações/flows/AI reply).
export const maxDuration = 60

export async function POST(request: NextRequest) {
  if (!wahaEnabled()) return NextResponse.json({ error: 'WAHA not configured' }, { status: 501 })

  const rawBody = await request.text()
  const hmac = request.headers.get('x-webhook-hmac')
  if (!verifyWahaHmac(rawBody, hmac)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let event: { event: string; session: string; payload: unknown }
  try { event = JSON.parse(rawBody) } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Resolve a conta pela sessão — espelha o roteamento por phone_number_id do webhook Meta.
  const db = supabaseAdmin()
  const { data: config } = await db
    .from('whatsapp_config')
    .select('account_id, user_id, waha_session, status')
    .eq('waha_session', event.session)
    .eq('provider', 'waha')
    .maybeSingle()
  if (!config) {
    console.warn('[webhook/waha] sessão sem config, descartando:', event.session)
    return NextResponse.json({ received: true })
  }

  after(async () => {
    try {
      if (event.event === 'message') {
        const normalized = normalizeWahaMessage(
          event.payload as Parameters<typeof normalizeWahaMessage>[0],
          '/api/whatsapp/waha/media',
        )
        if (normalized) await persistInboundMessage(normalized, config.account_id, config.user_id)
      } else if (event.event === 'message.ack') {
        const p = event.payload as { id: string; ack: number; timestamp?: number }
        const status = mapAckToStatus(p.ack)
        if (status) {
          await applyStatusByExternalId(
            p.id,
            status,
            typeof p.timestamp === 'number' ? new Date(p.timestamp * 1000) : undefined,
          )
        }
      } else if (event.event === 'session.status') {
        const p = event.payload as { status: string }
        if (p.status === 'STOPPED' || p.status === 'FAILED') {
          await db.from('whatsapp_config')
            .update({ status: 'disconnected' })
            .eq('waha_session', event.session)
          await db.from('notifications').insert({
            account_id: config.account_id,
            user_id: config.user_id,
            type: 'whatsapp_disconnected',
            title: 'Sessão do WhatsApp desconectada',
            body: 'Sua sessão WAHA caiu — reconecte pelo QR Code em Configurações → WhatsApp.',
          })
        } else if (p.status === 'WORKING') {
          await db.from('whatsapp_config')
            .update({ status: 'connected' })
            .eq('waha_session', event.session)
        }
      }
    } catch (err) {
      console.error('[webhook/waha] processamento falhou:', err)
    }
  })

  return NextResponse.json({ received: true })
}
