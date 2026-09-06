/**
 * documentTotals.test.js — BUG-013.
 *
 * The credit-note path used to compute `sum(qty * unit_price)` and store
 * `tax_amount: 0`, while the modal previewed the discounted, tax-inclusive
 * figure. These pin the single shared formula both now use, and in particular
 * the worked example from the finding.
 */
import { describe, it, expect } from 'vitest'
import { computeDocumentTotals, computeLineTotal } from '../api/db/_documentTotals'

describe('computeDocumentTotals', () => {
  it('is exact on the case from the finding: 1000.00 at 10% discount and 14% VAT', () => {
    const totals = computeDocumentTotals([
      { qty: 1, unit_price: 1000, discount_pct: 10, tax_pct: 14 },
    ])
    expect(totals).toEqual({
      subtotal: 1000,
      discount_amount: 100,
      tax_amount: 126,
      total: 1026,
    })
  })

  it('applies tax to the discounted amount, never to the gross', () => {
    // Gross-taxed would give 100 + 14 = 114 rather than 90 + 12.6 = 102.6.
    const { total } = computeDocumentTotals([
      { qty: 1, unit_price: 100, discount_pct: 10, tax_pct: 14 },
    ])
    expect(total).toBe(102.6)
  })

  it('treats missing discount and tax as zero', () => {
    expect(computeDocumentTotals([{ qty: 2, unit_price: 50 }])).toEqual({
      subtotal: 100,
      discount_amount: 0,
      tax_amount: 0,
      total: 100,
    })
  })

  it('handles null percentages the same as missing ones', () => {
    expect(
      computeDocumentTotals([{ qty: 1, unit_price: 10, discount_pct: null, tax_pct: null }]).total
    ).toBe(10)
  })

  it('sums several lines with different rates', () => {
    const totals = computeDocumentTotals([
      { qty: 1, unit_price: 1000, discount_pct: 10, tax_pct: 14 },
      { qty: 2, unit_price: 50, discount_pct: 0, tax_pct: 14 },
    ])
    expect(totals.subtotal).toBe(1100)
    expect(totals.discount_amount).toBe(100)
    expect(totals.tax_amount).toBe(140)
    expect(totals.total).toBe(1140)
  })

  it('always reconciles: subtotal - discount + tax === total', () => {
    const lines = [
      { qty: 3, unit_price: 33.33, discount_pct: 7.5, tax_pct: 14 },
      { qty: 1, unit_price: 0.01, discount_pct: 33, tax_pct: 5 },
    ]
    const t = computeDocumentTotals(lines)
    expect(Math.abs(t.subtotal - t.discount_amount + t.tax_amount - t.total)).toBeLessThan(0.011)
  })

  it('returns zeroes for no lines', () => {
    expect(computeDocumentTotals([])).toEqual({
      subtotal: 0,
      discount_amount: 0,
      tax_amount: 0,
      total: 0,
    })
  })

  it('rounds to two decimals', () => {
    const { total } = computeDocumentTotals([{ qty: 3, unit_price: 0.333, tax_pct: 0 }])
    expect(total).toBe(1)
  })
})

describe('computeLineTotal', () => {
  it('matches what the credit note will actually store, so preview cannot drift', () => {
    const line = { qty: 1, unit_price: 1000, discount_pct: 10, tax_pct: 14 }
    expect(computeLineTotal(line)).toBe(computeDocumentTotals([line]).total)
    expect(computeLineTotal(line)).toBe(1026)
  })
})
