import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { evaluateHealth, rulesFromEnv } from '@/lib/health'

export const dynamic = 'force-dynamic'

/**
 * Saúde da instalação para o monitor externo. 200 = tudo certo,
 * 503 = algum problema (lista em `problems`). Exige ?key=HEALTH_CHECK_KEY;
 * sem a variável configurada a rota nem existe (404).
 */
export async function GET(request: NextRequest) {
  const expected = process.env.HEALTH_CHECK_KEY
  const given = request.nextUrl.searchParams.get('key') ?? ''
  if (
    !expected ||
    given.length !== expected.length ||
    !timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const db = supabaseAdmin()
  const [config, lastMsg] = await Promise.all([
    db.from('whatsapp_config').select('status'),
    db
      .from('messages')
      .select('created_at')
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1),
  ])

  const result = evaluateHealth(
    {
      dbOk: !config.error && !lastMsg.error,
      whatsappStatuses: (config.data ?? []).map((r) => String(r.status)),
      lastCustomerMessageAt: lastMsg.data?.[0]?.created_at ?? null,
      now: new Date(),
    },
    rulesFromEnv(process.env),
  )

  return NextResponse.json(
    { ...result, checkedAt: new Date().toISOString() },
    { status: result.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  )
}
