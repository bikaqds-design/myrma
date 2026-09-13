import { describe, it, expect } from 'vitest'
import {
  mobileKey,
  groupByMobile,
  partitionByMobile,
  mobileKeysOf,
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
