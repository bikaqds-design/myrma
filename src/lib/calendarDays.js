/**
 * Calendar days in the viewer's own time zone.
 *
 * The Tech Calendar named each day column by `date.toISOString().split('T')[0]`
 * — the UTC date of that day's local midnight. East of UTC that is the day
 * before: at UTC+3 (Egypt), midnight on Thursday 13 August is 21:00 on
 * Wednesday 12 August in UTC. So the Thursday column was keyed "2026-08-12"
 * and everything due on the 13th was filed under Friday — every ticket and
 * activity sat one column late. The same slip moved "today" and "overdue".
 *
 * A day here is always the calendar date the viewer sees: built from local
 * year/month/day, never from an ISO string's date part.
 */

const pad = (n) => String(n).padStart(2, '0')

/** 'YYYY-MM-DD' of `date` in the viewer's time zone. */
export function localDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Local midnight of the Monday of the week containing `date`. */
export function getMonday(date) {
  const d = new Date(date)
  const day = d.getDay() // 0 = Sunday
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day))
  d.setHours(0, 0, 0, 0)
  return d
}

/** The 7 local midnights starting at `monday`. */
export function weekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(d.getDate() + i)
    return d
  })
}

/**
 * What to ask the database for one week starting at local midnight `monday`:
 * the first and last day keys (for a `date` column such as a ticket's due
 * date) and the instants the week starts and ends (for a timestamp column such
 * as an activity's due date).
 */
export function weekRange(monday) {
  const days = weekDays(monday)
  const next = new Date(monday)
  next.setDate(next.getDate() + 7)
  return {
    firstKey: localDateKey(days[0]),
    lastKey: localDateKey(days[6]),
    fromIso: days[0].toISOString(),
    toIso: next.toISOString(),
  }
}

/**
 * The day key a due date falls on for the viewer. A plain date ('YYYY-MM-DD',
 * a ticket's due date) is that day as written; a timestamp is converted to the
 * viewer's local date. Null for no date.
 */
export function dueDayKey(due) {
  if (!due) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return due
  const d = new Date(due)
  return Number.isNaN(d.getTime()) ? null : localDateKey(d)
}
