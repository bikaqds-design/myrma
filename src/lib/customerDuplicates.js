/**
 * Deciding whether two customer records are the same person. (BUG-063.)
 *
 * 14 of 888 live customers share a mobile number with another record, and the
 * cost is not cosmetic: RMA intake finds a customer by phone, so when two rows
 * carry the same number the counter clerk picks whichever the list shows first
 * and that ticket lands on one of the two histories. The customer's repairs
 * then split across two records, each showing half the story.
 *
 * ── Why the existing guards let them through ────────────────────────────────
 *
 * The CSV importer built a Set of the mobiles it already had and skipped rows
 * that matched. Two holes:
 *
 *   1. The Set was built from the customer list held in memory. That list is
 *      capped at 5 000 rows (BUG-066); at 888 customers it happens to be
 *      complete today, so the check works — until the day it quietly does not.
 *   2. The Set was never added to inside the loop, so a file containing the
 *      same number on two rows imported both. Nothing in the file was compared
 *      against the rest of the file.
 *
 * And the single-record form never checked at all.
 *
 * ── Comparing numbers rather than strings ───────────────────────────────────
 *
 * `+20 100 123 4567`, `0100 123 4567` and `00201001234567` are one phone. A
 * trim-and-lowercase comparison calls them three, which is how a duplicate gets
 * past a check that looks like it is working.
 *
 * So the key is the digits only, and where there are at least nine of them, the
 * last nine. Nine is chosen because an Egyptian mobile is `01X XXXX XXX` — ten
 * digits locally, twelve with the country code — and the last nine are the same
 * in every form of it. Comparing the tail rather than the whole string is what
 * makes those three spellings meet.
 *
 * This is deliberately a hint, not a verdict. Two people in a household really
 * do share a landline, and a company switchboard is on every one of its
 * contacts' records. So a match warns and asks; it never silently blocks. The
 * database has no unique index on mobile for the same reason.
 */

const MIN_TAIL = 9

/**
 * The comparison key for a phone number, or '' when there is nothing to compare.
 */
export function mobileKey(value) {
  const digits = String(value ?? '').replace(/\D+/g, '')
  if (!digits) return ''
  return digits.length > MIN_TAIL ? digits.slice(-MIN_TAIL) : digits
}

/**
 * Group rows by mobile key, keeping only the keys that appear more than once.
 *
 * Used on a parsed CSV before any of it is written, so the file can be reported
 * on as a whole instead of one row at a time.
 *
 * @param rows   any objects
 * @param getter reads the phone number off a row
 * @returns Map<key, row[]> containing only the collisions
 */
export function groupByMobile(rows, getter = (r) => r.mobile) {
  const groups = new Map()
  for (const row of rows) {
    const key = mobileKey(getter(row))
    if (!key) continue
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }
  for (const [key, bucket] of groups) {
    if (bucket.length < 2) groups.delete(key)
  }
  return groups
}

/**
 * Split incoming rows into those to write and those that collide.
 *
 * `existingKeys` is what the database already holds — a Set of mobileKey()
 * values. Rows are checked against it AND against each other, in file order:
 * the first row carrying a new number is kept and becomes part of the set, so
 * the second occurrence within the same file is caught exactly like one that
 * was already stored.
 *
 * @returns { accepted, duplicates } where each duplicate is
 *          { row, index, key, against: 'database' | 'file' }
 */
export function partitionByMobile(rows, existingKeys, getter = (r) => r.mobile) {
  const seen = new Set(existingKeys)
  const accepted = []
  const duplicates = []
  rows.forEach((row, index) => {
    const key = mobileKey(getter(row))
    if (!key) {
      // No number to compare. Other rules (company name, contact person) decide.
      accepted.push(row)
      return
    }
    if (seen.has(key)) {
      duplicates.push({
        row,
        index,
        key,
        against: existingKeys.has(key) ? 'database' : 'file',
      })
      return
    }
    seen.add(key)
    accepted.push(row)
  })
  return { accepted, duplicates }
}

/**
 * The distinct, non-empty keys in a set of rows — what to ask the database about.
 */
export function mobileKeysOf(rows, getter = (r) => r.mobile) {
  const keys = new Set()
  for (const row of rows) {
    const key = mobileKey(getter(row))
    if (key) keys.add(key)
  }
  return [...keys]
}
