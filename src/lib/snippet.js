/**
 * Why a document matched — the passage, with the search terms marked.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A full-text search over document bodies returns rows whose connection to the
 * query is invisible. Someone searching "180Hz" gets back six datasheets and
 * has to open each one to find out which actually says it. The snippet turns a
 * list of filenames into a list of answers.
 *
 * ── Why nothing is shown when the body does not match ───────────────────────
 *
 * A document can match on its title alone. Showing the opening paragraph in
 * that case would be worse than showing nothing, because a snippet under a
 * result reads as "here is the bit you searched for" — and it would not be.
 * When no term appears in the body, this returns null and the caller shows no
 * snippet at all.
 */

/** Newlines and tabs by code, never as literals — they do not survive tooling. */
const WHITESPACE = new RegExp(`[${String.fromCharCode(10, 13, 9)} ]+`, 'g')

/** How much text to show around the match. */
const WINDOW = 260

/**
 * Terms worth looking for, from what the person typed.
 *
 * websearch syntax leaks in here — quoted phrases, OR, leading minus — so the
 * operators are stripped rather than searched for literally. Single characters
 * are dropped because a lone "a" would mark half the passage.
 */
export function queryTerms(query) {
  if (!query) return []
  return [
    ...new Set(
      String(query)
        .toLowerCase()
        .replace(/["']/g, ' ')
        .split(/[^a-z0-9.+/-]+/i)
        .map((w) => w.replace(/^[-.+/]+|[-.+/]+$/g, ''))
        .filter((w) => w.length >= 2 && w !== 'or' && w !== 'and')
    ),
  ]
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every position in `text` where any term occurs.
 * Returns [{ start, end, term }] in document order.
 */
function findHits(text, terms) {
  const hits = []
  const lower = text.toLowerCase()
  for (const term of terms) {
    const re = new RegExp(escapeRegExp(term), 'g')
    let m
    while ((m = re.exec(lower)) !== null) {
      hits.push({ start: m.index, end: m.index + term.length, term })
      // A zero-length match would spin forever; terms are non-empty, but the
      // guard costs nothing and the alternative is a hung tab.
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }
  return hits.sort((a, b) => a.start - b.start)
}

/**
 * The window containing the most DISTINCT terms.
 *
 * Distinct, not total: a passage saying "180Hz" six times is less useful than
 * one saying "180Hz" and "DisplayPort" once each, which is far more likely to
 * be the sentence the person is looking for.
 */
function bestWindow(hits, textLength) {
  let best = { start: 0, score: -1 }
  for (const hit of hits) {
    const start = Math.max(0, hit.start - Math.floor(WINDOW / 3))
    const end = start + WINDOW
    const terms = new Set()
    for (const other of hits) {
      if (other.start >= start && other.end <= end) terms.add(other.term)
    }
    if (terms.size > best.score) best = { start, score: terms.size }
  }
  return Math.min(best.start, Math.max(0, textLength - WINDOW))
}

/** Widen to whole words so the snippet does not begin mid-syllable. */
function trimToWords(text, from, to) {
  let start = from
  let end = to
  if (start > 0) {
    const space = text.indexOf(' ', start)
    if (space !== -1 && space - start < 25) start = space + 1
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end)
    if (space !== -1 && end - space < 25) end = space
  }
  return [start, end]
}

/**
 * Build the snippet.
 *
 * Returns `{ segments, before, after }` where `segments` is a list of
 * `{ text, match }` for rendering, or **null** when the body does not contain
 * any of the terms. `before`/`after` say whether text was cut off, so the
 * caller can show an ellipsis without guessing.
 */
export function buildSnippet(body, query) {
  if (!body) return null
  const terms = queryTerms(query)
  if (terms.length === 0) return null

  // Collapse runs of whitespace first: extracted PDF text is full of newlines
  // mid-sentence, and a snippet is one line.
  const text = String(body).replace(WHITESPACE, ' ').trim()
  if (!text) return null

  const hits = findHits(text, terms)
  if (hits.length === 0) return null

  const windowStart = bestWindow(hits, text.length)
  const [start, end] = trimToWords(text, windowStart, Math.min(text.length, windowStart + WINDOW))
  const slice = text.slice(start, end)

  // Re-find within the slice so the offsets line up with what is rendered.
  const sliceHits = findHits(slice, terms)

  const segments = []
  let cursor = 0
  for (const hit of sliceHits) {
    // Overlapping terms ("hz" inside "180hz") would double-render the text.
    // The first match wins and later ones inside it are skipped.
    if (hit.start < cursor) continue
    if (hit.start > cursor) segments.push({ text: slice.slice(cursor, hit.start), match: false })
    segments.push({ text: slice.slice(hit.start, hit.end), match: true })
    cursor = hit.end
  }
  if (cursor < slice.length) segments.push({ text: slice.slice(cursor), match: false })

  return { segments, before: start > 0, after: end < text.length }
}
