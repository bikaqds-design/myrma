/**
 * calendarDays.test.js — Tech Calendar days in the viewer's time zone.
 *
 * The calendar keyed its day columns by `toISOString().split('T')[0]` of each
 * local midnight, which east of UTC is the previous day: in Egypt a ticket due
 * on Thursday showed under Friday. These run in Africa/Cairo (UTC+3 in summer),
 * where that mistake is visible; CI runs in UTC, where it would hide.
 */
process.env.TZ = 'Africa/Cairo'

import { describe, it, expect } from 'vitest'

const { localDateKey, getMonday, weekDays, weekRange, dueDayKey } = await import('../lib/calendarDays')

describe('the test runs east of UTC', () => {
  it('local midnight on 13 Aug is still 12 Aug in UTC here', () => {
    // The exact slip the calendar made; if this fails the zone did not apply.
    expect(new Date(2026, 7, 13).toISOString().slice(0, 10)).toBe('2026-08-12')
  })
})

describe('localDateKey', () => {
  it('is the calendar date the viewer sees', () => {
    expect(localDateKey(new Date(2026, 7, 13))).toBe('2026-08-13')
    expect(localDateKey(new Date(2026, 7, 13, 23, 59))).toBe('2026-08-13')
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('getMonday / weekDays', () => {
  it('starts the week on Monday, Sunday belonging to the week before', () => {
    expect(localDateKey(getMonday(new Date(2026, 8, 15, 10)))).toBe('2026-09-14') // Tuesday
    expect(localDateKey(getMonday(new Date(2026, 8, 20, 22)))).toBe('2026-09-14') // Sunday night
    expect(localDateKey(getMonday(new Date(2026, 8, 14, 0, 0)))).toBe('2026-09-14') // Monday midnight
  })

  it('lists seven consecutive local days', () => {
    const days = weekDays(getMonday(new Date(2026, 7, 12))).map(localDateKey)
    expect(days).toEqual(['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'])
  })
})

describe('weekRange', () => {
  it('asks for the local week: Monday to Sunday by date, local midnights as instants', () => {
    const range = weekRange(getMonday(new Date(2026, 7, 12)))
    expect(range.firstKey).toBe('2026-08-10')
    expect(range.lastKey).toBe('2026-08-16')
    // Monday 10 Aug 00:00 in Cairo is 21:00 UTC on the 9th; the week ends at the next Monday's midnight.
    expect(range.fromIso).toBe('2026-08-09T21:00:00.000Z')
    expect(range.toIso).toBe('2026-08-16T21:00:00.000Z')
  })

  it('stays seven days across the end of daylight saving time', () => {
    // Egypt's DST ends on the last Thursday of October (2026-10-29).
    const range = weekRange(getMonday(new Date(2026, 9, 28)))
    expect(range.firstKey).toBe('2026-10-26')
    expect(range.lastKey).toBe('2026-11-01')
    expect(localDateKey(new Date(range.toIso))).toBe('2026-11-02')
  })
})

describe('dueDayKey', () => {
  it('takes a plain date as written (a ticket due date)', () => {
    expect(dueDayKey('2026-08-13')).toBe('2026-08-13')
  })

  it('converts a timestamp to the viewer’s day (an activity due date)', () => {
    // 22:30 UTC on the 14th is 01:30 on the 15th in Cairo.
    expect(dueDayKey('2026-09-14T22:30:00+00:00')).toBe('2026-09-15')
    expect(dueDayKey('2026-09-15T08:00:00+00:00')).toBe('2026-09-15')
  })

  it('is null for no date or a bad one', () => {
    expect(dueDayKey(null)).toBeNull()
    expect(dueDayKey('')).toBeNull()
    expect(dueDayKey('not a date')).toBeNull()
  })
})
