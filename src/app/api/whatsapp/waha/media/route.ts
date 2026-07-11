// Proxy autenticado da mídia hospedada no servidor WAHA. O navegador
// nunca fala com a WAHA nem vê a API key. Auth por sessão do dashboard.
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { downloadWahaMedia } from '@/lib/whatsapp/waha-api'
import { buildMediaProxyUrl } from '@/lib/whatsapp/waha-webhook'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const src = request.nextUrl.searchParams.get('src')
  if (!src) return NextResponse.json({ error: 'src required' }, { status: 400 })

  // Isolamento por conta: só serve a mídia se o `src` pedido corresponder a
  // uma mensagem VISÍVEL para a conta do usuário. A normalização grava em
  // messages.media_url exatamente `buildMediaProxyUrl(...)`; reconstruímos a
  // mesma string (searchParams.get já devolveu o `src` decodificado, então o
  // re-encode bate byte a byte) e consultamos com o client do USUÁRIO — o
  // RLS pós-migração 017 limita messages/conversations à conta dele.
  const proxyUrl = buildMediaProxyUrl('/api/whatsapp/waha/media', src)
  const { data: allowed, error: lookupError } = await supabase
    .from('messages')
    .select('id')
    .eq('media_url', proxyUrl)
    .limit(1)
    .maybeSingle()
  if (lookupError) {
    console.error('[waha/media] lookup de autorização falhou:', lookupError)
    return NextResponse.json({ error: 'media unavailable' }, { status: 502 })
  }
  if (!allowed) return NextResponse.json({ error: 'not found' }, { status: 404 })

  try {
    const upstream = await downloadWahaMedia({ url: src })  // valida host = WAHA_URL
    return new NextResponse(upstream.body, {
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream',
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    return NextResponse.json({ error: 'media unavailable' }, { status: 502 })
  }
}
