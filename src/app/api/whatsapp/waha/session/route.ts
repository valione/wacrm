// Rotas de gerenciamento de sessão WAHA (conexão via QR Code).
// Consumidas pela tela Configurações → WhatsApp (Task 11).
//
//   POST   — cria+inicia a sessão wacrm_<account_id> na WAHA.
//   GET    — status da sessão; na primeira vez que fica WORKING, grava
//            a config (auto-vínculo, evita um passo extra de "salvar").
//   DELETE — logout+delete na WAHA e limpa a linha whatsapp_config.
//
// Permissão: mesmo nível que `POST /api/whatsapp/config` — qualquer
// membro autenticado da conta (o config route atual não chama
// `requireRole`, só resolve account_id via profile; não introduzimos
// aqui um gate de admin que o fluxo Meta equivalente não tem).
import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  wahaEnabled,
  wahaSessionName,
  createSession,
  getSession,
  logoutAndDelete,
  fromChatId,
} from '@/lib/whatsapp/waha-api'

export async function POST() {
  if (!wahaEnabled()) return NextResponse.json({ error: 'waha_not_configured' }, { status: 501 })

  let accountId: string
  try {
    const ctx = await getCurrentAccount()
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  // Config Meta ativa bloqueia — o usuário desconecta primeiro (mesma
  // regra que o POST /api/whatsapp/config aplica no sentido inverso
  // via unicidade de phone_number_id / account_id).
  const { data: existing, error: existingError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('provider')
    .eq('account_id', accountId)
    .maybeSingle()
  if (existingError) {
    console.error('[waha/session POST] lookup de whatsapp_config falhou:', existingError)
    return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
  }
  if (existing && existing.provider === 'meta') {
    return NextResponse.json({ error: 'meta_config_exists' }, { status: 409 })
  }

  const site = process.env.NEXT_PUBLIC_SITE_URL
  if (!site) {
    return NextResponse.json(
      {
        error: 'site_url_required',
        message: 'Defina NEXT_PUBLIC_SITE_URL para o servidor WAHA alcançar o CRM.',
      },
      { status: 500 },
    )
  }

  const session = wahaSessionName(accountId)
  // Evita barra duplicada caso NEXT_PUBLIC_SITE_URL venha com trailing
  // slash (mesmo saneamento que wahaBase() faz para WAHA_URL).
  const webhookUrl = `${site.replace(/\/$/, '')}/api/whatsapp/webhook/waha`
  try {
    await createSession({ session, webhookUrl })
  } catch (err) {
    console.error('[waha/session POST] createSession falhou:', err)
    return NextResponse.json(
      { error: 'waha_unreachable', message: 'Não foi possível criar a sessão no servidor WAHA.' },
      { status: 502 },
    )
  }

  return NextResponse.json({ session })
}

export async function GET() {
  if (!wahaEnabled()) return NextResponse.json({ error: 'waha_not_configured' }, { status: 501 })

  let accountId: string
  let userId: string
  try {
    const ctx = await getCurrentAccount()
    accountId = ctx.accountId
    userId = ctx.userId
  } catch (err) {
    return toErrorResponse(err)
  }

  const session = wahaSessionName(accountId)
  let info
  try {
    info = await getSession({ session })
  } catch (err) {
    console.error('[waha/session GET] getSession falhou:', err)
    // Servidor WAHA fora do ar ou sessão inexistente — trata como
    // desconectada em vez de propagar erro pra UI (mesmo espírito do
    // health check do config route, que distingue "servidor
    // inacessível" sem quebrar a tela).
    return NextResponse.json({ status: 'STOPPED', phone: null })
  }

  const phone = info.me?.id ? fromChatId(info.me.id) : null
  if (info.status === 'WORKING' && phone) {
    // Não sobrescrever config Meta existente silenciosamente — mesmo
    // guard do POST, aplicado aqui porque este GET também escreve.
    const { data: existing, error: existingError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('provider')
      .eq('account_id', accountId)
      .maybeSingle()
    if (existingError) {
      console.error('[waha/session GET] lookup de whatsapp_config falhou:', existingError)
    } else if (!existing || existing.provider !== 'meta') {
      // Grava/atualiza a config na primeira vez que a sessão fica ativa.
      const { error: upsertError } = await supabaseAdmin().from('whatsapp_config').upsert(
        {
          account_id: accountId,
          user_id: userId,
          provider: 'waha',
          provider_session: session,
          provider_phone: phone,
          phone_number_id: null,
          access_token: 'waha', // NOT NULL no schema; valor sentinela nunca usado
          status: 'connected',
          connected_at: new Date().toISOString(),
        },
        { onConflict: 'account_id' },
      )
      if (upsertError) {
        console.error('[waha/session GET] upsert de whatsapp_config falhou:', upsertError)
      }
    }
  }

  return NextResponse.json({ status: info.status, phone })
}

export async function DELETE() {
  if (!wahaEnabled()) return NextResponse.json({ error: 'waha_not_configured' }, { status: 501 })

  let accountId: string
  try {
    const ctx = await getCurrentAccount()
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  const session = wahaSessionName(accountId)
  try {
    await logoutAndDelete({ session })
  } catch (err) {
    // Best-effort: se o servidor WAHA estiver inacessível não travamos o
    // usuário sem conseguir desconectar — o mesmo espírito do "Reset
    // Configuration" da Meta, que também limpa a linha local sem
    // depender de confirmação remota. Loga para investigação manual.
    console.error(
      '[waha/session DELETE] logoutAndDelete falhou, prosseguindo com limpeza local:',
      err,
    )
  }

  const { error: deleteError } = await supabaseAdmin()
    .from('whatsapp_config')
    .delete()
    .eq('account_id', accountId)
    .eq('provider', 'waha')
  if (deleteError) {
    console.error('[waha/session DELETE] delete de whatsapp_config falhou:', deleteError)
    return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
