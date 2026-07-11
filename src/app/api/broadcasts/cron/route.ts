import { NextResponse } from 'next/server'
import { runBroadcastTick } from '@/lib/broadcasts/processor'

/**
 * Drain due/in-flight broadcasts. Meant to be hit on a schedule (Vercel
 * Cron / external pinger) — requires a shared secret via the
 * `x-cron-secret` header to match `BROADCAST_CRON_SECRET`. Auth skeleton
 * mirrors src/app/api/automations/cron/route.ts (503 unconfigured, 401
 * on mismatch).
 *
 * `runBroadcastTick` sends at most BROADCAST_RATE_PER_MINUTE per account
 * per invocation and returns; maxDuration caps the wall clock so a slow
 * provider can't run past the platform limit.
 */
export const maxDuration = 60

export async function GET(request: Request) {
  const expected = process.env.BROADCAST_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret')
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const summary = await runBroadcastTick()
  return NextResponse.json(summary)
}
