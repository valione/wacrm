'use client'

import { useEffect, useState } from 'react'
import { CAPABILITIES, type ProviderCapabilities } from '@/lib/whatsapp/providers/types'

// Module-level cache: every consumer of this hook shares one fetch of
// `GET /api/whatsapp/config` for the lifetime of the page. Trade-off —
// switching providers in Settings won't be reflected in an already-open
// inbox tab until it's reloaded. Acceptable for this phase; revisit if
// live provider switching becomes a real workflow.
let cached: ProviderCapabilities | null = null

/**
 * Resolves the active WhatsApp provider's capabilities so the inbox can
 * relax provider-specific restrictions (e.g. the 24h customer-service
 * window, which WAHA doesn't have). Falls back to Meta's capabilities —
 * the most restrictive set — on fetch failure or when there's no
 * config yet, so a network hiccup never *loosens* a gate that should
 * stay closed.
 */
export function useProviderCapabilities(): ProviderCapabilities | null {
  const [caps, setCaps] = useState<ProviderCapabilities | null>(cached)

  useEffect(() => {
    if (cached) return
    let cancelled = false
    fetch('/api/whatsapp/config')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        cached = d?.capabilities ?? CAPABILITIES.meta
        setCaps(cached)
      })
      .catch(() => {
        if (cancelled) return
        cached = CAPABILITIES.meta
        setCaps(cached)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return caps
}
