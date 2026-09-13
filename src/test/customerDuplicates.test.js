import { describe, it, expect } from 'vitest'
import {
  mobileKey,
  groupByMobile,
  partitionByMobile,
  mobileKeysOf,
  isEgyptianMobile,
  mobileFormatWarning,
} from '../lib/customerDuplicates'

describe('mobileKey', () => {
  it('treats the same Egyptian number written three ways as one', () => {
    const local = mobileKey('0100 123 4567')
    expect(mobileKey('+20 100 123 4567')).toBe(local)
    expect(mobileKey('00201001234567')).toBe(local)
    expect(mobileKey('(0100)-123-4567')).toBe(local)
  })

  it('does not conflate two different numbers', () => {
    expect(mobileKey('01001234567')).not.toBe(mobileKey('01001234568'))
  })

  it('returns an empty key for nothing to compare', () => {
    for (const v of [null, undefined, '', '   ', '-- --', 'n/a']) {
      expect(mobileKey(v)).toBe('')
    }
  })

  it('keeps short numbers whole rather than padding them', () => {
    expect(mobileKey('12345')).toBe('12345')
  })
})

describe('groupByMobile', () => {
  it('reports only the collisions', () => {
    const rows = [
      { id: 'a', mobile: '01001234567' },
      { id: 'b', mobile: '+20 100 123 4567' },
      { id: 'c', mobile: '01119998888' },
      { id: 'd', mobile: '' },
    ]
    const groups = groupByMobile(rows)
    expect([...groups.keys()]).toEqual(['001234567'])
    expect(groups.get('001234567').map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('partitionByMobile', () => {
  it('catches a row that collides with the database', () => {
    const { accepted, duplicates } = partitionByMobile(
      [{ id: 'new', mobile: '+20 100 123 4567' }],
      new Set([mobileKey('01001234567')])
    )
    expect(accepted).toHaveLength(0)
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0].against).toBe('database')
  })

  // The hole the old importer had: it never compared the file against itself.
  it('catches a second occurrence within the same file', () => {
    const { accepted, duplicates } = partitionByMobile(
      [
        { id: 'first', mobile: '01001234567' },
        { id: 'second', mobile: '0100 123 4567' },
      ],
      new Set()
    )
    expect(accepted.map((r) => r.id)).toEqual(['first'])
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0].against).toBe('file')
    expect(duplicates[0].index).toBe(1)
  })

  it('keeps the first row and drops the later one, in file order', () => {
    const rows = [
      { id: 'a', mobile: '01111111111' },
      { id: 'b', mobile: '02222222222' },
      { id: 'c', mobile: '01111111111' },
      { id: 'd', mobile: '02222222222' },
    ]
    const { accepted, duplicates } = partitionByMobile(rows, new Set())
    expect(accepted.map((r) => r.id)).toEqual(['a', 'b'])
    expect(duplicates.map((d) => d.id ?? d.row.id)).toEqual(['c', 'd'])
  })

  it('passes rows with no number through — other rules decide those', () => {
    const rows = [
      { id: 'a', mobile: '' },
      { id: 'b', mobile: null },
      { id: 'c' },
    ]
    const { accepted, duplicates } = partitionByMobile(rows, new Set())
    expect(accepted).toHaveLength(3)
    expect(duplicates).toHaveLength(0)
  })

  it('does not mutate the set it was given', () => {
    const existing = new Set(['001234567'])
    partitionByMobile([{ mobile: '01119998888' }], existing)
    expect([...existing]).toEqual(['001234567'])
  })
})

describe('mobileKeysOf', () => {
  it('returns each key once, skipping the empty ones', () => {
    expect(
      mobileKeysOf([
        { mobile: '01001234567' },
        { mobile: '+20 100 123 4567' },
        { mobile: '' },
        { mobile: '01119998888' },
      ]).sort()
    ).toEqual(['001234567', '119998888'])
  })
})

describe('isEgyptianMobile', () => {
  it('accepts the four live prefixes, local and international', () => {
    for (const p of ['010', '011', '012', '015']) {
      expect(isEgyptianMobile(`${p}12345678`)).toBe(true)
      expect(isEgyptianMobile(`+20${p.slice(1)}12345678`)).toBe(true)
    }
  })

  it('accepts a number written with spaces and brackets', () => {
    expect(isEgyptianMobile('(0100) 123-4567')).toBe(true)
  })

  it('rejects a prefix that is not a mobile', () => {
    expect(isEgyptianMobile('01312345678')).toBe(false)
    expect(isEgyptianMobile('0223456789')).toBe(false)
  })

  // The exact damage found in the live book: the leading 0 became a +.
  it('rejects the "+1…" shape that 27 live records had', () => {
    expect(isEgyptianMobile('+1091768465')).toBe(false)
    expect(isEgyptianMobile('01091768465')).toBe(true)
  })

  it('rejects nothing-at-all', () => {
    for (const v of [null, undefined, '', '+', '   ']) expect(isEgyptianMobile(v)).toBe(false)
  })
})

describe('mobileFormatWarning', () => {
  it('says nothing about a good number, or about a blank field', () => {
    expect(mobileFormatWarning('01091768465')).toBe('')
    expect(mobileFormatWarning('+20 100 123 4567')).toBe('')
    expect(mobileFormatWarning('')).toBe('')
    expect(mobileFormatWarning(null)).toBe('')
  })

  it('names the leading-zero case specifically, since it is repairable', () => {
    expect(mobileFormatWarning('+1091768465')).toMatch(/leading 0/)
    expect(mobileFormatWarning('1061661466')).toMatch(/leading 0/)
  })

  it('calls out a value with no digits', () => {
    expect(mobileFormatWarning('+')).toBe('contains no digits')
  })

  it('suggests a landline for a short number', () => {
    expect(mobileFormatWarning('0223456789')).toMatch(/landline/)
  })

  it('reports the digit count for anything else', () => {
    expect(mobileFormatWarning('0123456789012345')).toMatch(/16 digits/)
  })
})
