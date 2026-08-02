// ============================================================
// Agent message signature (migration 042).
//
// WhatsApp identifies every outbound message by the business phone
// number — there is no per-sender field. When several agents share
// one inbox the customer sees a single faceless voice, so we prefix
// the agent's first name into the body:
//
//     *Marcos*
//     Bom dia! Sobre o painel de LED…
//
// The asterisks are WhatsApp's own bold markup, which every client
// renders. The prefix goes into the text we hand the provider AND
// into the row we persist, so the thread in the inbox shows exactly
// what the customer received.
//
// Scope, deliberately narrow — only what a human typed in the
// dashboard is signed:
//
//   • plain text        → signed
//   • media WITH caption→ caption signed
//   • media WITHOUT one → untouched (a caption holding only a name
//                          reads like a glitch)
//   • templates         → never (the body is Meta-approved; adding
//                          a line would break the match)
//   • interactive       → never (same reason, structured payload)
//   • flows/automations/broadcasts/public API → never (no human
//                          author to attribute)
//
// Everything here is pure so the rules are unit-testable without a
// database or a provider.
// ============================================================

/** Message kinds that must never be signed. */
const UNSIGNABLE_TYPES = new Set(["template", "interactive"]);

/**
 * First word of a display name, for a signature that reads the way
 * people actually talk. "Marcos Silva Pereira" → "Marcos".
 *
 * Returns null for anything unusable (null, blank, whitespace-only)
 * so callers can treat "no usable name" and "signature off" the
 * same way.
 */
export function firstName(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  const first = fullName.trim().split(/\s+/)[0];
  return first ? first : null;
}

/**
 * Prefix `text` with a bold name line.
 *
 * Idempotent: a body that already opens with this exact signature
 * is returned unchanged, so a retry (or a caller that signs twice
 * by mistake) can't stack "*Marcos*" lines.
 */
export function applySignature(text: string, name: string): string {
  const prefix = `*${name}*`;
  if (text.startsWith(`${prefix}\n`)) return text;
  return `${prefix}\n${text}`;
}

/**
 * Decide the outbound body for a dashboard send.
 *
 * Returns the text unchanged whenever signing doesn't apply, so the
 * caller can assign the result unconditionally:
 *
 *     const body = signOutboundText({ ... })
 *
 * `text` is the caption for media kinds — passing null/empty for a
 * caption-less media send is what keeps it unsigned.
 */
export function signOutboundText(params: {
  text: string | null | undefined;
  messageType: string;
  enabled: boolean;
  fullName: string | null | undefined;
}): string | null | undefined {
  const { text, messageType, enabled, fullName } = params;

  if (!enabled) return text;
  if (UNSIGNABLE_TYPES.has(messageType)) return text;
  // Covers both "no text at all" and a caption of only whitespace —
  // neither is something a name should be glued onto.
  if (!text || !text.trim()) return text;

  const name = firstName(fullName);
  if (!name) return text;

  return applySignature(text, name);
}
