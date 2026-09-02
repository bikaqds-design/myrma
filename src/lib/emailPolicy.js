/**
 * Email domain typo detection.
 *
 * The policy chosen for this system is deliberately NOT an allowlist. Rejecting
 * an unlisted domain turns away exactly the people you least want to turn away
 * — a new customer on their own company domain, or a supplier abroad. Format
 * validation stays as it is, and this adds the one thing that catches real
 * mistakes without refusing anything: a warning when a domain is one or two
 * keystrokes away from a very common one.
 *
 * A warning, never a rejection. `sara@gmial.com` is almost certainly a typo,
 * but `gmial.com` is a real registrable domain and somebody might genuinely
 * have an address there. The user is told and can carry on.
 */

/**
 * Domains common enough that a near-miss is far more likely to be a typo than a
 * real address. Deliberately short: a long list produces false warnings on
 * legitimate small domains, and a warning nobody trusts is worse than none.
 */
export const COMMON_DOMAINS = [
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'yahoo.com',
  'icloud.com',
  'live.com',
  'aol.com',
  'protonmail.com',
]

/** Levenshtein distance, capped — we only care about 1 and 2. */
export function editDistance(a, b) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > 2) return 3
  const prev = new Array(b.length + 1)
  const curr = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]
  }
  return prev[b.length]
}

export function emailDomain(email) {
  if (!email || typeof email !== 'string') return ''
  const at = email.lastIndexOf('@')
  if (at < 0) return ''
  return email.slice(at + 1).trim().toLowerCase()
}

/**
 * Suggest a correction for a likely mistyped domain, or null.
 *
 * Returns null for anything already correct, anything far from every common
 * domain, and anything that IS a common domain — so a company's own domain is
 * never second-guessed.
 */
export function suggestEmailDomain(email) {
  const domain = emailDomain(email)
  if (!domain) return null
  // An exact match is right by definition.
  if (COMMON_DOMAINS.includes(domain)) return null

  let best = null
  let bestDistance = 3
  for (const candidate of COMMON_DOMAINS) {
    const d = editDistance(domain, candidate)
    if (d < bestDistance) {
      bestDistance = d
      best = candidate
    }
  }

  // Distance 1 is a near-certain typo. Distance 2 only when the domain is long
  // enough that two edits still means "almost the same word" — on a short
  // domain, two edits can reach something entirely different.
  if (bestDistance === 1) return best
  if (bestDistance === 2 && domain.length >= 8) return best
  return null
}

/**
 * The full check a form runs: format is handled by the schema, so this only
 * reports a suspected typo.
 */
export function checkEmail(email, { typoWarnings = true } = {}) {
  if (!email) return { ok: true }
  if (!typoWarnings) return { ok: true }
  const suggestion = suggestEmailDomain(email)
  if (!suggestion) return { ok: true }
  return { ok: true, warning: 'typo', suggestion, domain: emailDomain(email) }
}
