/**
 * Decide how to heal a stale `whatsapp_config.status` given what the
 * provider just reported live.
 *
 * The stored column is what the inbox banner (and anything else that
 * can't afford a provider round-trip) reads, but only two writers keep
 * it fresh — the QR polling loop and the webhook 'connection' event —
 * and both can miss: the modal gets closed before polling lands, the
 * event is dropped, or a ban arrives between polls. Seen live on
 * 2026-07-27: Display4's number took a 403 minutes after connecting
 * and the stored status kept saying 'connected' while the instance was
 * dead.
 *
 * Rules:
 * - Live connected → store 'connected' (also heals the stuck-at-
 *   'connecting' case from an interrupted QR flow).
 * - Live down → store 'disconnected', but ONLY over 'connected' — a
 *   stored 'connecting' means a QR scan may be mid-flight right now,
 *   and stomping it would fight the connect flow.
 *
 * Returns the value to write, or null when the stored value should be
 * left alone.
 */
export function resolveStatusPatch(
  stored: string | null,
  liveConnected: boolean,
): 'connected' | 'disconnected' | null {
  if (liveConnected) return stored === 'connected' ? null : 'connected'
  return stored === 'connected' ? 'disconnected' : null
}
