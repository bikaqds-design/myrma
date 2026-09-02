/**
 * money.test.js — formatting, conversion and apportionment.
 *
 * `apportion` gets the most attention here because it is the one with a
 * correctness trap: freight split across lines has to sum back to the freight.
 * A rounding remainder that quietly vanishes means stock is costed slightly
 * wrong forever, and nothing ever reports it.
 */
import { describe, it, expect } from 'vitest'
import {
  formatMoney,
  formatMoneyCompact,
  currencyMeta,
  toBase,
  apportion,
  FALLBACK_CURRENCY,
} from '../lib/money'

describe('formatMoney', () => {
  it('uses the currency symbol, not a hardcoded dollar', () => {
    expect(formatMoney(1234.5, 'EGP', { locale: 'en-US' })).toBe('E£ 1,234.50')
    expect(formatMoney(1234.5, 'USD', { locale: 'en-US' })).toBe('$ 1,234.50')
  })

  // JPY has no minor unit. Assuming two decimals everywhere prints ¥ 100.00,
  // which is not a number anyone in that currency would write.
  it('respects each currency’s decimal count', () => {
    expect(formatMoney(100, 'JPY', { locale: 'en-US' })).toBe('¥ 100')
    expect(formatMoney(100, 'EGP', { locale: 'en-US' })).toBe('E£ 100.00')
  })

  it('defaults to the base currency', () => {
    expect(formatMoney(5, undefined, { locale: 'en-US' })).toContain(
      currencyMeta(FALLBACK_CURRENCY).symbol
    )
  })

  // Rendering "NaN" or "undefined" where a number belongs is worse than a zero.
  it('survives junk', () => {
    for (const junk of [null, undefined, NaN, 'abc', {}]) {
      expect(formatMoney(junk, 'EGP', { locale: 'en-US' })).toBe('E£ 0.00')
    }
  })

  // A code with no symbol on file still formats — printing the ISO code is
  // correct, where printing someone else's symbol would not be.
  it('falls back to the code for an unknown currency', () => {
    expect(formatMoney(10, 'XYZ', { locale: 'en-US' })).toBe('XYZ 10.00')
  })
})

describe('formatMoneyCompact', () => {
  it('abbreviates thousands and millions', () => {
    expect(formatMoneyCompact(1_500_000, 'EGP')).toBe('E£ 1.5M')
    expect(formatMoneyCompact(2_400, 'EGP')).toBe('E£ 2.4K')
    expect(formatMoneyCompact(750, 'EGP')).toBe('E£ 750')
  })

  // The three copies this replaces all rendered `$`. On an Egyptian
  // installation that is a wrong statement about the money, not a style choice.
  it('never emits a dollar sign for a pound amount', () => {
    expect(formatMoneyCompact(1_000_000, 'EGP')).not.toContain('$')
  })

  it('keeps the sign on negatives', () => {
    expect(formatMoneyCompact(-2_400, 'EGP')).toBe('-E£ 2.4K')
  })

  it('survives junk', () => {
    expect(formatMoneyCompact(null, 'EGP')).toBe('E£ 0')
  })
})

describe('toBase', () => {
  it('multiplies by the document’s own rate', () => {
    expect(toBase(100, 48.5, 'EGP')).toBe(4850)
  })

  it('rounds to the base currency’s decimals', () => {
    expect(toBase(10.005, 3.333, 'EGP')).toBe(33.35)
    expect(toBase(10.005, 3.333, 'JPY')).toBe(33)
  })

  // A missing rate must not silently convert at 1:1 — that would record a
  // foreign amount as though it were already base currency.
  it('returns null rather than guessing when the rate is missing', () => {
    expect(toBase(100, null)).toBeNull()
    expect(toBase(100, undefined)).toBeNull()
    expect(toBase(100, 'abc')).toBeNull()
    expect(toBase(null, 48.5)).toBeNull()
  })
})

describe('apportion', () => {
  it('splits in proportion to value', () => {
    expect(apportion(100, [50, 50])).toEqual([50, 50])
    expect(apportion(90, [100, 200])).toEqual([30, 60])
  })

  // The property that matters: the parts must equal the whole. Freight that
  // does not fully land in unit cost is freight that silently disappears.
  it.each([
    [100, [1, 1, 1]],
    [0.01, [1, 1, 1]],
    [1234.56, [3, 7, 11, 13]],
    [999.99, [1, 2, 3, 4, 5, 6, 7]],
    [55.55, [0.1, 0.2, 0.7]],
  ])('sums back exactly: %s across %j', (total, weights) => {
    const parts = apportion(total, weights)
    const sum = parts.reduce((a, b) => a + b, 0)
    expect(Math.abs(sum - total)).toBeLessThan(1e-9)
  })

  it('gives the remainder to the largest line', () => {
    // 100 / 3 leaves a remainder that has to land somewhere.
    const parts = apportion(100, [1, 1, 2])
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 9)
    expect(parts[2]).toBeGreaterThan(parts[0])
  })

  // A shipment of zero-value samples still costs freight. Refusing to
  // apportion would lose the charge entirely.
  it('splits evenly when every weight is zero', () => {
    const parts = apportion(90, [0, 0, 0])
    expect(parts).toEqual([30, 30, 30])
  })

  it('returns zeros for a zero charge or no lines', () => {
    expect(apportion(0, [1, 2])).toEqual([0, 0])
    expect(apportion(100, [])).toEqual([])
  })

  it('treats a negative weight as zero rather than inverting the split', () => {
    const parts = apportion(100, [-5, 100])
    expect(parts[0]).toBe(0)
    expect(parts[1]).toBeCloseTo(100, 9)
  })
})
