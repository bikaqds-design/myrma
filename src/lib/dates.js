/**
 * Calendar dates in the user's own timezone. (Audit finding BUG-038.)
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * Two different mistakes, both from mixing local arithmetic with UTC
 * formatting, in a business that operates in Cairo (UTC+2/+3).
 *
 * 1. WRITING a date. `DEFAULT_DUE` and `slaConfig.computeDueDate` both did:
 *
 *      const d = new Date(); d.setDate(d.getDate() + 7)
 *      return d.toISOString().split('T')[0]
 *
 *    The arithmetic is local, the formatting is UTC. At 01:00 Cairo on the 7th
 *    it is still 22:00 UTC on the 6th, so "seven days from today" came out as
 *    six. Every ticket raised in that window got a due date a day early, and
 *    nobody could see why.
 *
 * 2. READING a date. `new Date(t.due_date) < new Date()` where `due_date` is a
 *    `date` column. `new Date("2026-09-06")` is parsed by the spec as UTC
 *    midnight, so a ticket due *today* became overdue at 00:00 UTC — 02:00 or
 *    03:00 Cairo, depending on DST. The dashboard called work late while the
 *    person doing it still had the whole day.
 *
 * A `date` column has no time in it. "Due 6 September" means the end of the
 * 6th, not the start of it, so the comparison has to be against the end of that
 * day in the reader's timezone.
 *
 * ── The third convention, and why it is left alone ──────────────────────────
 *
 * `queue_overdue_ticket_emails` uses `CURRENT_DATE`, and the database's
 * timezone is UTC (verified: `current_setting('TimeZone')` = 'UTC'). So the
 * cron's idea of "today" is the UTC date, which is what these helpers now agree
 * with for most of the day and differ from for the first two or three hours of
 * a Cairo morning. Reconciling that properly means deciding the business
 * timezone and setting it in one place, which is a decision for the owner
 * rather than something to hard-code here. These helpers at least make the
 * browser self-consistent, which it was not.
 */

import {
  format, addDays, addHours, endOfDay, parseISO, isValid, differenceInCalendarDays,
} from 'date-fns'

/** Today as `yyyy-MM-dd` in the local calendar, not UTC. */
export function todayLocalISO() {
  return format(new Date(), 'yyyy-MM-dd')
}

/** `days` from now as `yyyy-MM-dd` in the local calendar. */
export function addDaysLocalISO(days, from = new Date()) {
  return format(addDays(from, days), 'yyyy-MM-dd')
}

/** `hours` from now as `yyyy-MM-dd` in the local calendar. */
export function addHoursLocalISO(hours, from = new Date()) {
  return format(addHours(from, hours), 'yyyy-MM-dd')
}

/**
 * Parse a `date` column value as a LOCAL day rather than UTC midnight.
 * Returns null for anything unparseable, so a bad value is not silently
 * treated as 1970.
 */
export function parseDateOnlyLocal(value) {
  if (!value) return null
  const s = String(value).slice(0, 10)
  const d = parseISO(s) // parseISO treats a bare yyyy-MM-dd as local, unlike new Date()
  return isValid(d) ? d : null
}

/**
 * True when a `date`-column value is in the past, treating it as inclusive:
 * a task due today is not overdue until today is over.
 */
export function isPastDueLocal(value, now = new Date()) {
  const d = parseDateOnlyLocal(value)
  if (!d) return false
  return now > endOfDay(d)
}

/**
 * Whole CALENDAR days a `date` value is past due; 0 when not yet overdue.
 *
 * Counted in calendar days rather than by dividing an interval: at 09:00 on
 * the due day the raw gap to end-of-day is 15 hours, and rounding that up
 * reports "1 day" for something not yet due at all.
 */
export function daysPastDueLocal(value, now = new Date()) {
  const d = parseDateOnlyLocal(value)
  if (!d) return 0
  return Math.max(0, differenceInCalendarDays(now, d))
}

/**
 * Whole days remaining until a `date` value is due, counted to the END of that
 * local day. A task due today returns 0, not -1; null when there is no date.
 */
export function daysUntilDueLocal(value, now = new Date()) {
  const d = parseDateOnlyLocal(value)
  if (!d) return null
  return Math.max(0, differenceInCalendarDays(d, now))
}
