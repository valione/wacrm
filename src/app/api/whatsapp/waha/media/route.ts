// Proxy autenticado da mídia hospedada no servidor WAHA. O navegador
// nunca fala com a WAHA nem vê a API key. Auth por sessão do dashboard.
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { downloadWahaMedia } from '@/lib/whatsapp/waha-api'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const src = request.nextUrl.searchParams.get('src')
  if (!src) return NextResponse.json({ error: 'src required' }, { status: 400 })

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
