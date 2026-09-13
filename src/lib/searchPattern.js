/**
 * Turn what a person typed into a substring search the database takes
 * literally. (Audit finding BUG-060.)
 *
 * Two different encodings are involved, and every call site got at least one
 * of them wrong.
 *
 * ── 1. LIKE ─────────────────────────────────────────────────────────────────
 *
 * In an ILIKE pattern `%` means "anything" and `_` means "any one character",
 * with `\` as the escape. A part number like `AB_12` or a search for `50%`
 * therefore matched far more than was typed. Escaping those three characters
 * makes the term literal.
 *
 * ── 2. PostgREST's .or() filter string ──────────────────────────────────────
 *
 * `.or()` does not take parameters; it takes a small text language, and the
 * user's term is spliced into it. Measured against the live API (2026-09-10,
 * using a uuid column so the database's cast error echoes back exactly what
 * PostgREST forwarded):
 *
 *   bare  a,b      -> HTTP 400 "failed to parse logic tree"
 *   bare  (x)      -> the database received "(x"   (a parenthesis silently eaten)
 *   bare  x\_y     -> received "x\_y"             (backslashes pass through)
 *   "a,b"          -> received "a,b"
 *   "(x)"          -> received "(x)"
 *   "x\\_y"        -> received "x\_y"             (inside quotes, \ escapes)
 *   "a\"b"         -> received a"b
 *
 * So a search containing a comma — "Dell, HP" — raised an error, and one
 * containing brackets searched for something else without saying so. The call
 * sites "handled" this by deleting those characters or turning them into spaces,
 * which avoided the error by searching for the wrong thing.
 *
 * Quoting the value is the documented way to carry any character through: wrap
 * it in double quotes and backslash-escape `\` and `"` inside.
 *
 * Plain `.ilike(column, pattern)` calls pass their value as-is and need only
 * the LIKE half — `containsPattern`. `.or()` needs both — `orIlike`.
 */

/** Escape the three characters ILIKE treats specially. */
export function escapeLike(term) {
  return String(term ?? '').replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** `%term%` with the term taken literally. For `.ilike(column, …)`. */
export function containsPattern(term) {
  return `%${escapeLike(term)}%`
}

/** Quote a value for PostgREST's `.or()` language. */
export function quoteOrValue(value) {
  return `"${String(value).replace(/[\\"]/g, (c) => `\\${c}`)}"`
}

/**
 * `col.ilike."%term%",col2.ilike."%term%"` — a case-insensitive substring match
 * on any of `columns`, safe to pass straight to `.or()`.
 */
export function orIlike(columns, term) {
  const value = quoteOrValue(containsPattern(term))
  return columns.map((column) => `${column}.ilike.${value}`).join(',')
}
