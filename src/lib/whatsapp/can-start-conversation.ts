import type { ProviderCapabilities } from './providers/types'

/**
 * Whether the UI may offer "start a conversation with free text".
 *
 * Only providers without Meta's 24h customer-service window can do it —
 * on Meta a business-initiated message must be an approved template, so
 * the affordance would only produce API errors. `null` (capabilities
 * still loading, or fetch failed) resolves to false: the hook falls
 * back to Meta's capability set, the restrictive one, and a gate that
 * should stay closed must never open on a network hiccup.
 */
export function canStartConversation(
  caps: ProviderCapabilities | null,
): boolean {
  return caps !== null && !caps.has24hWindow
}
