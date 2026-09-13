/**
 * Receivable and payable aging buckets. (Audit finding BUG-065.)
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * Both ledgers carried the same copy of this:
 *
 *   if (daysPastDue <= 30) return 'current'
 *
 * so an invoice 29 days PAST its due date was reported as "Current" — the word
 * an accountant reads as "not yet due". The whole first month of lateness was
 * invisible on the aging report, which is exactly the window in which a
 * reminder is still cheap.
 *
 * And an invoice with no due date was given `daysPastDue = 0`, which put it in
 * that same "Current" bucket forever. It could never age, never look overdue,
 * and never prompt anyone to fix the missing date. Three posted invoices in
 * production have no due date (see BUG-041).
 *
 * The day count itself was `(Date.now() - new Date(due_date)) / 86_400_000`.
 * `due_date` is a `date` column, and `new Date("2026-09-10")` is UTC midnight,
 * so the count was off by one for part of every Cairo morning — the BUG-038
 * mistake, still live here.
 *
 * ── The buckets now ─────────────────────────────────────────────────────────
 *
 *   not_due      due today or later. A task due today is not late until today
 *                is over — the convention src/lib/dates.js already uses.
 *   d1_30        1–30 days past due. This is the bucket that did not exist.
 *   d31_60, d61_90, d90_plus   unchanged.
 *   no_due_date  its own column, so the gap is visible rather than hidden.
 *
 * Order matters: it is the column order on the aging report.
 */

import { daysPastDueLocal, parseDateOnlyLocal } from './dates.js'

export const AGING_BUCKETS = ['not_due', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'no_due_date']

/**
 * The bucket for a `date`-column due date, counted in local calendar days.
 * Anything that does not parse as a date is treated as missing rather than as
 * "due today", which is how a bad value used to disappear into Current.
 */
export function agingBucket(dueDate, now = new Date()) {
  if (!parseDateOnlyLocal(dueDate)) return 'no_due_date'
  const days = daysPastDueLocal(dueDate, now)
  if (days <= 0) return 'not_due'
  if (days <= 30) return 'd1_30'
  if (days <= 60) return 'd31_60'
  if (days <= 90) return 'd61_90'
  return 'd90_plus'
}

/** A zeroed accumulator with one field per bucket plus `total`. */
export function emptyAgingTotals() {
  const totals = { total: 0 }
  for (const bucket of AGING_BUCKETS) totals[bucket] = 0
  return totals
}
