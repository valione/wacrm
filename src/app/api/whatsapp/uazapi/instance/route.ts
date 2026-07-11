// Rotas de gerenciamento de instância Uazapi (conexão via QR Code,
// provedor alternativo à WAHA — servidor demo expira a instância em 1h).
// Consumidas pela tela Configurações → WhatsApp (Task 6).
//
//   POST   — cria (ou reconecta) a instância wacrm_<account_id> na Uazapi,
//            registra o webhook e chama connectInstance.
//   GET    — status da instância + QR code; quando fica connected+loggedIn
//            com telefone, atualiza a config (auto-vínculo, mesmo espírito
//            do GET da sessão WAHA).
//   DELETE — desconecta+apaga a instância na Uazapi (best-effort) e limpa
//            a linha whatsapp_config.
//
// Estrutura espelha src/app/api/whatsapp/waha/session/route.ts (auth via
// getCurrentAccount, 501 sem provedor habilitado, 409 se outro provedor já
// está configurado, DELETE best-effort).
import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import {
  uazapiEnabled,
  uazapiInstanceName,
  createInstance,
  connectInstance,
  getInstanceStatus,
  disconnectInstance,
  deleteInstance,
  setInstanceWebhook,
} from '@/lib/whatsapp/uazapi-api'

/** `data:image/png;base64,...` pronto pro `<img src>` — a Uazapi às vezes manda o base64 cru. */
function normalizeQrcode(qrcode: string | null): string | null {
  if (!qrcode) return null
  return qrcode.startsWith('data:') ? qrcode : `data:image/png;base64,${qrcode}`
}

export async function POST() {
  if (!uazapiEnabled()) return NextResponse.json({ error: 'uazapi_not_configured' }, { status: 501 })

  let accountId: string
  let userId: string
  try {
    const ctx = await getCurrentAccount()
    accountId = ctx.accountId
    userId = ctx.userId
  } catch (err) {
    return toErrorResponse(err)
  }

  const { data: existing, error: existingError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('provider, access_token')
    .eq('account_id', accountId)
    .maybeSingle()
  if (existingError) {
    console.error('[uazapi/instance POST] lookup de whatsapp_config falhou:', existingError)
    return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
  }
  // Config de OUTRO provedor bloqueia — o usuário desconecta primeiro
  // (mesma regra que waha/session POST aplica para 'meta').
  if (existing && existing.provider !== 'uazapi') {
    return NextResponse.json({ error: `${existing.provider}_config_exists` }, { status: 409 })
  }

  const site = process.env.NEXT_PUBLIC_SITE_URL
  if (!site) {
    return NextResponse.json(
      {
        error: 'site_url_required',
        message: 'Defina NEXT_PUBLIC_SITE_URL para o servidor Uazapi alcançar o CRM.',
      },
      { status: 500 },
    )
  }
  // UAZAPI_WEBHOOK_SECRET é garantido por uazapiEnabled() acima.
  const webhookUrl = `${site.replace(/\/$/, '')}/api/whatsapp/webhook/uazapi?s=${process.env.UAZAPI_WEBHOOK_SECRET}`

  // Reconexão: já existe config uazapi para esta conta. Tenta reusar o
  // token salvo em vez de criar uma instância nova.
  if (existing?.provider === 'uazapi') {
    let savedToken: string | null = null
    try {
      savedToken = decrypt(existing.access_token)
      await getInstanceStatus({ token: savedToken })
    } catch (err) {
      // Token corrompido OU instância morta (o demo server apaga em 1h) —
      // nos dois casos não há nada reaproveitável: limpa e recria do zero.
      console.error(
        '[uazapi/instance POST] instância salva não responde, recriando do zero:',
        err,
      )
      if (savedToken) await deleteInstance({ token: savedToken }).catch(() => {})
      const { error: cleanupError } = await supabaseAdmin()
        .from('whatsapp_config')
        .delete()
        .eq('account_id', accountId)
        .eq('provider', 'uazapi')
      if (cleanupError) {
        console.error('[uazapi/instance POST] limpeza de config-fantasma falhou:', cleanupError)
      }
      savedToken = null
    }

    if (savedToken) {
      // Idempotente: re-registra o webhook antes de reconectar (o número
      // pode ter caído e voltado com outra URL configurada por engano).
      try {
        await setInstanceWebhook({ token: savedToken, url: webhookUrl })
      } catch (err) {
        console.error('[uazapi/instance POST] setInstanceWebhook (reconexão) falhou:', err)
      }
      try {
        await connectInstance({ token: savedToken })
      } catch (err) {
        console.error('[uazapi/instance POST] connectInstance (reconexão) falhou:', err)
      }
      return NextResponse.json({ ok: true })
    }
    // savedToken null → instância anterior morta, cai para a criação abaixo.
  }

  // Criação nova.
  let created: { token: string; id: string }
  try {
    created = await createInstance({ name: uazapiInstanceName(accountId) })
  } catch (err) {
    console.error('[uazapi/instance POST] createInstance falhou:', err)
    return NextResponse.json(
      { error: 'uazapi_unreachable', message: 'Não foi possível criar a instância no servidor Uazapi.' },
      { status: 502 },
    )
  }

  let encryptedToken: string
  try {
    encryptedToken = encrypt(created.token)
  } catch (err) {
    console.error('[uazapi/instance POST] encrypt do token falhou:', err)
    await deleteInstance({ token: created.token }).catch(() => {})
    return NextResponse.json(
      {
        error: 'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string.',
      },
      { status: 500 },
    )
  }

  // provider_session = id da instância (não o nome) — é o valor que o
  // webhook recebe em `event.instance` (ver comentário em createInstance).
  const { error: upsertError } = await supabaseAdmin().from('whatsapp_config').upsert(
    {
      account_id: accountId,
      user_id: userId,
      provider: 'uazapi',
      provider_session: created.id,
      provider_phone: null,
      phone_number_id: null,
      access_token: encryptedToken,
      status: 'disconnected',
    },
    { onConflict: 'account_id' },
  )
  if (upsertError) {
    console.error('[uazapi/instance POST] upsert de whatsapp_config falhou:', upsertError)
    await deleteInstance({ token: created.token }).catch(() => {})
    return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
  }

  // Config já persistida a partir daqui — falhas abaixo são logadas mas
  // não desfazem o save (mesmo espírito best-effort do resto do arquivo);
  // o usuário pode tentar reconectar pelo GET/POST novamente.
  try {
    await setInstanceWebhook({ token: created.token, url: webhookUrl })
  } catch (err) {
    console.error('[uazapi/instance POST] setInstanceWebhook falhou (config já salva):', err)
  }
  try {
    await connectInstance({ token: created.token })
  } catch (err) {
    console.error('[uazapi/instance POST] connectInstance falhou (config já salva):', err)
  }

  return NextResponse.json({ ok: true })
}

export async function GET() {
  if (!uazapiEnabled()) return NextResponse.json({ error: 'uazapi_not_configured' }, { status: 501 })

  let accountId: string
  try {
    const ctx = await getCurrentAccount()
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  const { data: config, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('access_token')
    .eq('account_id', accountId)
    .eq('provider', 'uazapi')
    .maybeSingle()
  if (configError) {
    console.error('[uazapi/instance GET] lookup de whatsapp_config falhou:', configError)
    return NextResponse.json({ error: 'Failed to fetch configuration' }, { status: 500 })
  }
  if (!config) {
    return NextResponse.json({ status: 'none', qrcode: null, phone: null })
  }

  let info
  try {
    const token = decrypt(config.access_token)
    info = await getInstanceStatus({ token })
  } catch (err) {
    // Token corrompido OU servidor Uazapi inacessível OU instância
    // expirada — nos três casos tratamos como desconectada em vez de
    // propagar erro pra UI (mesmo espírito do GET da sessão WAHA).
    console.error('[uazapi/instance GET] getInstanceStatus falhou:', err)
    return NextResponse.json({ status: 'disconnected', qrcode: null, phone: null })
  }

  if (info.status === 'connected' && info.loggedIn && info.phone) {
    const { error: updateError } = await supabaseAdmin()
      .from('whatsapp_config')
      .update({
        provider_phone: info.phone,
        status: 'connected',
        connected_at: new Date().toISOString(),
      })
      .eq('account_id', accountId)
      .eq('provider', 'uazapi')
    if (updateError) {
      console.error('[uazapi/instance GET] update de whatsapp_config falhou:', updateError)
    }
  }

  return NextResponse.json({
    status: info.status,
    qrcode: normalizeQrcode(info.qrcode),
    phone: info.phone,
  })
}

export async function DELETE() {
  if (!uazapiEnabled()) return NextResponse.json({ error: 'uazapi_not_configured' }, { status: 501 })

  let accountId: string
  try {
    const ctx = await getCurrentAccount()
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  const { data: config, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('access_token')
    .eq('account_id', accountId)
    .eq('provider', 'uazapi')
    .maybeSingle()
  if (configError) {
    console.error('[uazapi/instance DELETE] lookup de whatsapp_config falhou:', configError)
    return NextResponse.json({ error: 'Failed to fetch configuration' }, { status: 500 })
  }

  if (config?.access_token) {
    try {
      const token = decrypt(config.access_token)
      await disconnectInstance({ token })
      await deleteInstance({ token })
    } catch (err) {
      // Best-effort: servidor Uazapi inacessível ou instância já expirada
      // não deve travar o usuário sem conseguir limpar a config local
      // (mesmo espírito do DELETE da sessão WAHA).
      console.error(
        '[uazapi/instance DELETE] desconexão/exclusão na Uazapi falhou, prosseguindo com limpeza local:',
        err,
      )
    }
  }

  const { error: deleteError } = await supabaseAdmin()
    .from('whatsapp_config')
    .delete()
    .eq('account_id', accountId)
    .eq('provider', 'uazapi')
  if (deleteError) {
    console.error('[uazapi/instance DELETE] delete de whatsapp_config falhou:', deleteError)
    return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
