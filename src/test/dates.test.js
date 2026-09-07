/**
 * dates.test.js — BUG-038.
 *
 * Two mistakes, both from mixing local arithmetic with UTC formatting in a
 * business that runs on Cairo time:
 *   writing — `d.setDate(d.getDate()+7)` then `toISOString().split('T')[0]`,
 *     so at 01:00 Cairo "seven days" came out as six;
 *   reading — `new Date('2026-09-06') < new Date()`, which parses as UTC
 *     midnight, so a ticket due today read as overdue from 02:00 Cairo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  todayLocalISO,
  addDaysLocalISO,
  addHoursLocalISO,
  parseDateOnlyLocal,
  isPastDueLocal,
  daysPastDueLocal,
  daysUntilDueLocal,
} from '../lib/dates'

afterEach(() => vi.useRealTimers())

/** Pin the clock to a local wall-clock time, whatever the runner's zone. */
function atLocal(y, m, d, hh = 12, mm = 0) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(y, m - 1, d, hh, mm, 0))
}

describe('writing a date — local calendar, not UTC', () => {
  it('adds whole days in the local calendar', () => {
    atLocal(2026, 9, 6, 12)
    expect(addDaysLocalISO(7)).toBe('2026-09-13')
  })

  it('still returns the local calendar date just after local midnight', () => {
    // This is the case that was wrong: at 01:00 local, toISOString() is still
    // on the previous UTC day for any positive offset.
    atLocal(2026, 9, 7, 1)
    expect(todayLocalISO()).toBe('2026-09-07')
    expect(addDaysLocalISO(7)).toBe('2026-09-14')
  })

  it('adds hours in the local calendar', () => {
    atLocal(2026, 9, 6, 12)
    expect(addHoursLocalISO(48)).toBe('2026-09-08')
  })

  it('never returns yesterday for a positive offset', () => {
    for (const hour of [0, 1, 2, 3, 23]) {
      atLocal(2026, 9, 7, hour)
      expect(addDaysLocalISO(7) >= '2026-09-14').toBe(true)
    }
  })
})

describe('reading a date — inclusive to the end of the local day', () => {
  it('a task due today is NOT overdue, even in the small hours', () => {
    atLocal(2026, 9, 6, 3)
    expect(isPastDueLocal('2026-09-06')).toBe(false)
  })

  it('a task due today is not overdue late in the evening either', () => {
    atLocal(2026, 9, 6, 23, 30)
    expect(isPastDueLocal('2026-09-06')).toBe(false)
  })

  it('becomes overdue once the day is actually over', () => {
    atLocal(2026, 9, 7, 0, 30)
    expect(isPastDueLocal('2026-09-06')).toBe(true)
  })

  it('a future date is never overdue', () => {
    atLocal(2026, 9, 6, 12)
    expect(isPastDueLocal('2026-09-30')).toBe(false)
  })

  it('treats a missing or unparseable value as not overdue rather than 1970', () => {
    expect(isPastDueLocal(null)).toBe(false)
    expect(isPastDueLocal('')).toBe(false)
    expect(isPastDueLocal('not-a-date')).toBe(false)
    expect(parseDateOnlyLocal('not-a-date')).toBeNull()
  })

  it('tolerates a full timestamp by taking its date part', () => {
    atLocal(2026, 9, 8, 12)
    expect(isPastDueLocal('2026-09-06T10:00:00Z')).toBe(true)
  })
})

describe('day counts', () => {
  it('reports 0 days past due while still on the due day', () => {
    atLocal(2026, 9, 6, 23)
    expect(daysPastDueLocal('2026-09-06')).toBe(0)
  })

  it('counts whole days once overdue', () => {
    atLocal(2026, 9, 9, 12)
    expect(daysPastDueLocal('2026-09-06')).toBe(3)
  })

  it('reports 0 days remaining on the due day, not -1', () => {
    atLocal(2026, 9, 6, 9)
    expect(daysUntilDueLocal('2026-09-06')).toBe(0)
  })

  it('counts days remaining before the due day', () => {
    atLocal(2026, 9, 6, 9)
    expect(daysUntilDueLocal('2026-09-09')).toBe(3)
  })

  it('returns null when there is no date', () => {
    expect(daysUntilDueLocal(null)).toBeNull()
  })
})
