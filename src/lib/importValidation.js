/**
 * Validation shared by the CSV importers. (Audit finding BUG-045.)
 *
 * The three import screens each hand-rolled their own parser and checked only
 * that required fields were non-empty. The zod schemas the FORMS use were never
 * applied, so a value the single-record form refuses — `email = "notanemail"`
 * is the finding's own repro — went straight into the database when it arrived
 * in a spreadsheet instead.
 *
 * Scope note, deliberately narrow: this validates the fields where a bad value
 * actually corrupts data, rather than running the full `customerSchema` per
 * row. Full parity would change which rows are ACCEPTED — the schema requires a
 * contact person and a mobile, while the importer permits a B2B row with
 * neither — and silently rejecting rows that import fine today would be a worse
 * failure than the one being fixed. Tightening that is an owner decision, and
 * it is recorded in the report rather than made here.
 */

// Deliberately the same shape as the check in the public-track Edge Function.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** True when a value is absent (blank is allowed) or a plausible address. */
export function isImportableEmail(value) {
  const v = String(value ?? '').trim()
  if (!v) return true
  return v.length <= 320 && EMAIL.test(v)
}

/**
 * Check one parsed CSV row's optional contact fields.
 * @returns {string[]} human-readable problems; empty when the row is fine.
 */
export function contactFieldProblems(row) {
  const problems = []
  if (!isImportableEmail(row?.email)) problems.push(`invalid email "${String(row.email).slice(0, 60)}"`)
  const phone = String(row?.phone ?? row?.mobile ?? '').trim()
  if (phone && phone.length > 50) problems.push('phone number too long')
  return problems
}
