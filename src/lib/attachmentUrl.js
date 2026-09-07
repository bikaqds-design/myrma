/**
 * Decide whether an attachment URL is safe to put behind a link.
 * (Audit finding BUG-023.)
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Customers add attachments through the public RMA tracker, which needs no
 * account — only a ticket UUID, and those appear in the `?ticket=` URLs staff
 * paste to each other. The Edge Function stored whatever JSON arrived:
 *
 *   attachments: Array.isArray(c.attachments) ? c.attachments : []
 *
 * Staff then render each entry as `<a href={att.url}>` with the poster's own
 * `name` as the link text. So an anonymous stranger could put `javascript:` or
 * a convincing lookalike host behind text reading "invoice.pdf", displayed
 * inside the staff interface on a ticket staff already trust — which is a far
 * better phishing position than an email.
 *
 * The Edge Function now whitelists attachments on the way in. That does not
 * help with anything already stored, or with any other path that writes an
 * attachment, so the renderer checks too. Two halves, like BUG-024: stopping
 * new bad data is not the same as being safe against the data you have.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * An attachment URL must be https and must sit on this project's own Supabase
 * origin. Compared as an ORIGIN, never as a substring — `https://evil.example/
 * ?x=myproject.supabase.co` contains the expected text and is not the expected
 * host.
 */

const PROJECT_ORIGIN = (() => {
  try {
    return new URL(import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co').origin
  } catch {
    return null
  }
})()

/**
 * The URL if it is safe to link to, otherwise null.
 * Callers should render a non-clickable element when this returns null.
 */
export function safeAttachmentUrl(value) {
  if (typeof value !== 'string' || !value) return null
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null // rejects `javascript:alert(1)` and every other non-URL
  }
  if (parsed.protocol !== 'https:') return null
  if (!PROJECT_ORIGIN || parsed.origin !== PROJECT_ORIGIN) return null
  return parsed.toString()
}

/** Convenience for `src`/`href` props: a safe URL, or undefined. */
export function safeAttachmentHref(value) {
  return safeAttachmentUrl(value) ?? undefined
}
