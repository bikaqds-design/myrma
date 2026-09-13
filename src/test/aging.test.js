import { describe, it, expect } from 'vitest'
import { AGING_BUCKETS, agingBucket, emptyAgingTotals } from '../lib/aging'

// 10 September 2026, 09:00 local. Day counts below were computed independently
// with Python's datetime, not derived from the code under test.
const NOW = new Date(2026, 8, 10, 9, 0, 0)

describe('agingBucket (BUG-065)', () => {
  it('reports 29 days past due as overdue, not "current" — the finding itself', () => {
    expect(agingBucket('2026-08-12', NOW)).toBe('d1_30')
  })

  it('does not call an invoice due today late until today is over', () => {
    expect(agingBucket('2026-09-10', NOW)).toBe('not_due')
  })

  it('treats a future due date as not yet due', () => {
    expect(agingBucket('2026-10-01', NOW)).toBe('not_due')
  })

  it('moves to 1-30 the day after the due date', () => {
    expect(agingBucket('2026-09-09', NOW)).toBe('d1_30')
  })

  it('puts each boundary in the lower bucket and the next day in the higher', () => {
    expect(agingBucket('2026-08-11', NOW)).toBe('d1_30') // 30
    expect(agingBucket('2026-08-10', NOW)).toBe('d31_60') // 31
    expect(agingBucket('2026-07-12', NOW)).toBe('d31_60') // 60
    expect(agingBucket('2026-07-11', NOW)).toBe('d61_90') // 61
    expect(agingBucket('2026-06-12', NOW)).toBe('d61_90') // 90
    expect(agingBucket('2026-06-11', NOW)).toBe('d90_plus') // 91
  })

  it('gives an invoice with no due date its own bucket instead of hiding it in Current', () => {
    expect(agingBucket(null, NOW)).toBe('no_due_date')
    expect(agingBucket(undefined, NOW)).toBe('no_due_date')
    expect(agingBucket('', NOW)).toBe('no_due_date')
  })

  it('treats an unparseable date as missing rather than as due today', () => {
    expect(agingBucket('not-a-date', NOW)).toBe('no_due_date')
  })

  it('counts calendar days late in the evening, not 24-hour intervals', () => {
    const lateEvening = new Date(2026, 8, 10, 23, 30, 0)
    expect(agingBucket('2026-09-10', lateEvening)).toBe('not_due')
    expect(agingBucket('2026-09-09', lateEvening)).toBe('d1_30')
  })

  it('reads a full timestamp by its date part', () => {
    expect(agingBucket('2026-09-09T23:30:00', NOW)).toBe('d1_30')
  })
})

describe('emptyAgingTotals', () => {
  it('has a zero for every bucket plus a total, in the same keys the report renders', () => {
    const totals = emptyAgingTotals()
    expect(Object.keys(totals).sort()).toEqual([...AGING_BUCKETS, 'total'].sort())
    expect(Object.values(totals).every((v) => v === 0)).toBe(true)
  })

  it('returns a fresh object each call, so one report cannot add into another', () => {
    const a = emptyAgingTotals()
    a.d1_30 = 5
    expect(emptyAgingTotals().d1_30).toBe(0)
  })
})
