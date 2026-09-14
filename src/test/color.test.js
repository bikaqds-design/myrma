import { describe, it, expect } from 'vitest'
import { contrastRatio, darken, fillForWhiteText } from '../lib/color'

describe('contrastRatio', () => {
  it('matches the WCAG endpoints', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
  })

  it('is symmetric and accepts shorthand hex', () => {
    expect(contrastRatio('#fff', '#BF6E72')).toBeCloseTo(contrastRatio('#BF6E72', '#ffffff'), 10)
  })

  it('returns null for a value that is not a hex colour', () => {
    expect(contrastRatio('rebeccapurple', '#ffffff')).toBeNull()
  })
})

describe('darken', () => {
  it('mixes toward black, and a hover shade of a passing fill still passes', () => {
    expect(darken('#ffffff', 0.5)).toBe('#808080')
    expect(contrastRatio(darken(fillForWhiteText('#BF6E72'), 0.1), '#ffffff')).toBeGreaterThan(5)
  })

  it('returns an unparseable value unchanged', () => {
    expect(darken('var(--primary)', 0.1)).toBe('var(--primary)')
  })
})

describe('fillForWhiteText', () => {
  it('darkens a brand colour that fails, only as far as it takes to pass', () => {
    // QDS Egypt's live primary colour: white text is 3.69:1 on it.
    const fill = fillForWhiteText('#BF6E72')
    expect(fill).toBe('#aa6265')
    expect(contrastRatio(fill, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    // One step lighter would fail, so it did not over-darken.
    expect(contrastRatio('#ac6367', '#ffffff')).toBeLessThan(4.5)
  })

  it('leaves a colour that already passes exactly as given', () => {
    expect(fillForWhiteText('#4F46E5')).toBe('#4F46E5')
  })

  it('always reaches the ratio, even from white', () => {
    const fill = fillForWhiteText('#ffffff')
    expect(contrastRatio(fill, '#ffffff')).toBeGreaterThanOrEqual(4.5)
  })

  it('returns an unparseable value unchanged', () => {
    expect(fillForWhiteText('var(--primary)')).toBe('var(--primary)')
    expect(fillForWhiteText(undefined)).toBeUndefined()
  })
})
