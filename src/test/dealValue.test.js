import { describe, it, expect } from 'vitest'
import {
  dealValueFor,
  canMarkDealWon,
  liveQuotations,
  convertedQuotations,
} from '../lib/dealValue'

const qt = (total, status, archived = false) => ({ total, status, archived })

// The worked example from the spec: one deal, three quotations.
//   Quote 1 = 10 → approved and converted to a Sales Order
//   Quote 2 = 15 → still pending
//   Quote 3 = 20 → still pending
const THREE = [qt(10, 'converted'), qt(15, 'sent'), qt(20, 'sent')]

describe('dealValueFor', () => {
  it('sums every live quotation while the deal is open', () => {
    expect(dealValueFor(THREE, 'open')).toBe(45)
  })

  it('drops to only the converted quotations once the deal is won', () => {
    expect(dealValueFor(THREE, 'won')).toBe(10)
  })

  it('uses the same actual-value rule for a lost deal', () => {
    expect(dealValueFor(THREE, 'lost')).toBe(10)
  })

  it('returns 0 for a lost deal where nothing ever converted', () => {
    expect(dealValueFor([qt(15, 'sent'), qt(20, 'draft')], 'lost')).toBe(0)
  })

  it('excludes cancelled and declined quotations from the forecast', () => {
    const list = [qt(10, 'converted'), qt(15, 'cancelled'), qt(20, 'declined')]
    expect(dealValueFor(list, 'open')).toBe(10)
  })

  it('excludes expired quotations from the forecast', () => {
    expect(dealValueFor([qt(10, 'sent'), qt(99, 'expired')], 'open')).toBe(10)
  })

  it('excludes archived quotations even when their status is live', () => {
    const list = [qt(10, 'sent'), qt(20, 'sent', true)]
    expect(dealValueFor(list, 'open')).toBe(10)
  })

  it('excludes an archived quotation from the actual value too', () => {
    expect(dealValueFor([qt(10, 'converted', true)], 'won')).toBe(0)
  })

  it('treats a missing total as zero rather than NaN', () => {
    expect(dealValueFor([qt(null, 'sent'), qt(10, 'sent')], 'open')).toBe(10)
    expect(dealValueFor([{ status: 'sent' }], 'open')).toBe(0)
  })

  it('returns 0 for an empty list (callers skip the sync in that case)', () => {
    expect(dealValueFor([], 'open')).toBe(0)
    expect(dealValueFor([], 'won')).toBe(0)
  })

  it('climbs back to the forecast when a closed deal is reopened', () => {
    expect(dealValueFor(THREE, 'won')).toBe(10)
    expect(dealValueFor(THREE, 'open')).toBe(45)
  })
})

describe('canMarkDealWon', () => {
  it('allows a deal that has no quotations at all', () => {
    expect(canMarkDealWon([])).toBe(true)
  })

  it('allows a deal with at least one converted quotation', () => {
    expect(canMarkDealWon(THREE)).toBe(true)
  })

  it('blocks a deal whose quotations are all still pending', () => {
    expect(canMarkDealWon([qt(15, 'sent'), qt(20, 'draft')])).toBe(false)
  })

  it('blocks when the only converted quotation is archived', () => {
    expect(canMarkDealWon([qt(10, 'converted', true), qt(15, 'sent')])).toBe(false)
  })

  it('blocks when quotations exist but were all rejected', () => {
    expect(canMarkDealWon([qt(15, 'declined'), qt(20, 'cancelled')])).toBe(false)
  })
})

describe('quotation partitioning', () => {
  it('counts only live quotations', () => {
    expect(liveQuotations(THREE)).toHaveLength(3)
    expect(liveQuotations([qt(1, 'cancelled'), qt(2, 'expired')])).toHaveLength(0)
  })

  it('counts only converted, unarchived quotations', () => {
    expect(convertedQuotations(THREE)).toHaveLength(1)
    expect(convertedQuotations([qt(1, 'converted', true)])).toHaveLength(0)
  })
})
