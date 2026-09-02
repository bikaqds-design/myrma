/**
 * skuMatch.test.js — matching uploaded filenames to products.
 *
 * The failure that matters is not "did not match". It is "matched the WRONG
 * product", because that files a datasheet under a part it does not describe
 * and the search then answers questions about it confidently. Most of these
 * tests exist to pin the cases where a looser matcher would guess.
 */
import { describe, it, expect } from 'vitest'
import { matchFile, matchFiles, normalise, baseName } from '../lib/skuMatch.js'

const PRODUCTS = [
  { id: 'p1', sku: 'XPG-8200-PRO', product_name: 'XPG 8200 Pro SSD' },
  { id: 'p2', sku: 'PS5012', product_name: 'Phison PS5012' },
  { id: 'p3', sku: 'PS5012E16', product_name: 'Phison PS5012-E16' },
  { id: 'p4', sku: 'SSD', product_name: 'Generic SSD' },
  { id: 'p5', sku: 'AOC-24G2', product_name: 'AOC 24G2 Monitor' },
]

describe('normalising', () => {
  it('makes the vendors spellings of one part number identical', () => {
    expect(normalise('XPG-8200-Pro')).toBe(normalise('xpg 8200 pro'))
    expect(normalise('XPG_8200_PRO')).toBe('XPG8200PRO')
  })

  it('survives nothing', () => {
    expect(normalise(null)).toBe('')
    expect(normalise('')).toBe('')
  })

  it('strips only the final extension', () => {
    expect(baseName('XPG-8200-Pro.datasheet.pdf')).toBe('XPG-8200-Pro.datasheet')
    expect(baseName('no-extension')).toBe('no-extension')
  })
})

describe('matching one file', () => {
  it('matches a filename that is the SKU', () => {
    const m = matchFile('XPG-8200-PRO.pdf', PRODUCTS)
    expect(m.product.id).toBe('p1')
    expect(m.reason).toBe('exact')
  })

  it('matches through the vendors punctuation', () => {
    expect(matchFile('xpg 8200 pro.pdf', PRODUCTS).product.id).toBe('p1')
    expect(matchFile('XPG_8200_PRO.PDF', PRODUCTS).product.id).toBe('p1')
  })

  it('finds the SKU inside a longer filename', () => {
    const m = matchFile('AOC-24G2 Datasheet EN v3.pdf', PRODUCTS)
    expect(m.product.id).toBe('p5')
    expect(m.reason).toBe('contained')
  })

  /**
   * The interesting one. Both PS5012 and PS5012E16 sit inside this filename;
   * the longer SKU is the more specific claim and must win, or every E16
   * datasheet lands on the base part.
   */
  it('prefers the more specific SKU when one contains the other', () => {
    const m = matchFile('PS5012E16-datasheet.pdf', PRODUCTS)
    expect(m.product.id).toBe('p3')
  })

  /**
   * A three-letter SKU appears inside half of everything. Matching it by
   * containment would file unrelated documents under it.
   */
  it('refuses to match a very short SKU by containment', () => {
    const m = matchFile('Some SSD comparison guide.pdf', PRODUCTS)
    expect(m.product).toBeNull()
    expect(m.reason).toBe('none')
  })

  it('still matches a short SKU when the filename IS that SKU', () => {
    const m = matchFile('SSD.pdf', PRODUCTS)
    expect(m.product.id).toBe('p4')
    expect(m.reason).toBe('exact')
  })

  it('reports nothing rather than guessing when no SKU appears', () => {
    const m = matchFile('company-price-list-2026.pdf', PRODUCTS)
    expect(m.product).toBeNull()
    expect(m.reason).toBe('none')
  })

  // Two products sharing a SKU is bad data, but it must not become a coin toss.
  it('refuses to choose between duplicate SKUs', () => {
    const dupes = [
      { id: 'a', sku: 'DUPE-1' },
      { id: 'b', sku: 'DUPE-1' },
    ]
    const m = matchFile('DUPE-1.pdf', dupes)
    expect(m.product).toBeNull()
    expect(m.reason).toBe('ambiguous')
  })

  it('refuses to choose between two equally specific containments', () => {
    const tied = [
      { id: 'a', sku: 'ABCD' },
      { id: 'b', sku: 'WXYZ' },
    ]
    const m = matchFile('ABCD-and-WXYZ-combined.pdf', tied)
    expect(m.product).toBeNull()
    expect(m.reason).toBe('ambiguous')
  })

  it('copes with a product list that has missing SKUs', () => {
    const messy = [{ id: 'a', sku: null }, { id: 'b', sku: '' }, { id: 'c', sku: 'REAL-SKU' }]
    expect(matchFile('REAL-SKU.pdf', messy).product.id).toBe('c')
    expect(matchFile('anything.pdf', messy).product).toBeNull()
  })

  it('copes with a filename that normalises to nothing', () => {
    expect(matchFile('---.pdf', PRODUCTS).product).toBeNull()
    expect(matchFile('', PRODUCTS).product).toBeNull()
  })
})

describe('matching a batch', () => {
  it('returns one row per file, in order, keeping the original file', () => {
    const files = [
      { name: 'XPG-8200-PRO.pdf' },
      { name: 'unknown.pdf' },
      { name: 'AOC-24G2 EN.pdf' },
    ]
    const rows = matchFiles(files, PRODUCTS)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.reason)).toEqual(['exact', 'none', 'contained'])
    expect(rows.map((r) => r.product?.id)).toEqual(['p1', undefined, 'p5'])
    // The caller needs the File itself back to upload it.
    expect(rows[0].file).toBe(files[0])
  })

  it('accepts plain filenames as well as File objects', () => {
    expect(matchFiles(['XPG-8200-PRO.pdf'], PRODUCTS)[0].product.id).toBe('p1')
  })

  it('handles nothing at all', () => {
    expect(matchFiles([], PRODUCTS)).toEqual([])
    expect(matchFiles(null, PRODUCTS)).toEqual([])
    expect(matchFiles(['a.pdf'], null)).toHaveLength(1)
  })
})
