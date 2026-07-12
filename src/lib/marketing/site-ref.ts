// Site-origin marker extraction for the inbound pipeline.
//
// A site widget / wa.me deep-link can tag the first WhatsApp message with a
// `[ref:<slug>]` marker so the CRM can attribute the conversation to the page
// that sent it (e.g. `Olá! Vim pelo site [ref:site-home]`). This module pulls
// the first marker out and returns the text with EVERY marker stripped.
//
// The slug class is a single, simple character class with a bounded
// quantifier (`[\w-]{1,64}`) — no nested quantifiers, no alternation, so the
// regex has no ReDoS surface (lição aprendida na fase 2).

const MARKER_RE = /\[ref:([\w-]{1,64})\]/g

/**
 * Detect a `[ref:<slug>]` marker in `text`.
 *
 * @returns `ref` — the FIRST slug found (or null when none matched); and
 *   `cleanText` — `text` with ALL markers removed and any double space left
 *   behind by the removal collapsed + trimmed. When no marker matched the
 *   original `text` is returned untouched (zero normalization), so callers
 *   can cheaply detect "no marker" via `ref === null`.
 */
export function extractSiteRef(text: string): { ref: string | null; cleanText: string } {
  if (!text) return { ref: null, cleanText: text }

  let ref: string | null = null
  const stripped = text.replace(MARKER_RE, (_match, slug: string) => {
    if (ref === null) ref = slug
    return ''
  })

  // No valid marker → leave the text exactly as it came in (an invalid slug
  // like `[ref:has space]` never matches and is preserved verbatim).
  if (ref === null) return { ref: null, cleanText: text }

  // Collapse the double space a mid-text removal leaves behind, then trim.
  const cleanText = stripped.replace(/ {2,}/g, ' ').trim()
  return { ref, cleanText }
}
