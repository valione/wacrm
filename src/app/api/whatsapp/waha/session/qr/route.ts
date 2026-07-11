// Proxy autenticado do QR code da sessão WAHA. O navegador nunca fala
// com a WAHA nem vê a WAHA_API_KEY — mesmo papel que o proxy de mídia
// (src/app/api/whatsapp/waha/media/route.ts) cumpre para anexos.
import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { wahaEnabled, wahaSessionName, getQrPng } from '@/lib/whatsapp/waha-api'

export async function GET() {
  if (!wahaEnabled()) return NextResponse.json({ error: 'waha_not_configured' }, { status: 501 })

  let accountId: string
  try {
    const ctx = await getCurrentAccount()
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  try {
    const png = await getQrPng({ session: wahaSessionName(accountId) })
    return new NextResponse(png, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    // Cobre tanto "sessão não está em SCAN_QR_CODE" (a WAHA responde
    // non-2xx) quanto o servidor WAHA estar fora do ar (fetch reject).
    console.error('[waha/session/qr GET] getQrPng falhou:', err)
    return NextResponse.json({ error: 'qr_unavailable' }, { status: 400 })
  }
}
