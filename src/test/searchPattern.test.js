import { describe, it, expect } from 'vitest'
import { escapeLike, containsPattern, quoteOrValue, orIlike } from '../lib/searchPattern'

/**
 * PostgREST's unquoting, as MEASURED against the live API rather than assumed:
 * inside a double-quoted value a backslash escapes the next character. See the
 * table in src/lib/searchPattern.js. Used to check that what the helper sends is
 * what the database ends up comparing against.
 */
function postgrestUnquote(quoted) {
  expect(quoted.startsWith('"') && quoted.endsWith('"')).toBe(true)
  return quoted.slice(1, -1).replace(/\\(.)/g, '$1')
}

describe('escapeLike (BUG-060)', () => {
  it('makes an underscore literal, so a part number matches only itself', () => {
    expect(escapeLike('AB_12')).toBe('AB\\_12')
  })

  it('makes a percent sign literal', () => {
    expect(escapeLike('50%')).toBe('50\\%')
  })

  it('escapes the escape character itself', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b')
  })

  it('leaves ordinary text alone', () => {
    expect(escapeLike('Dell Latitude 5440')).toBe('Dell Latitude 5440')
  })

  it('treats a missing term as empty rather than the string "undefined"', () => {
    expect(escapeLike(undefined)).toBe('')
    expect(escapeLike(null)).toBe('')
  })
})

describe('containsPattern', () => {
  it('wraps the escaped term for a substring match', () => {
    expect(containsPattern('a_b')).toBe('%a\\_b%')
  })
})

describe('quoteOrValue', () => {
  it('keeps a comma inside the value instead of splitting the filter', () => {
    expect(quoteOrValue('%Dell, HP%')).toBe('"%Dell, HP%"')
  })

  it('escapes a double quote and a backslash', () => {
    expect(quoteOrValue('a"b')).toBe('"a\\"b"')
    expect(quoteOrValue('a\\b')).toBe('"a\\\\b"')
  })
})

describe('orIlike', () => {
  it('builds one quoted term per column', () => {
    expect(orIlike(['sku', 'product_name'], 'x')).toBe('sku.ilike."%x%",product_name.ilike."%x%"')
  })

  it.each([
    ['Dell, HP'], // a comma — used to raise HTTP 400
    ['(refurb)'], // brackets — used to be silently truncated
    ['AB_12'], // an underscore — used to be a wildcard
    ['50% off'], // a percent — used to be a wildcard
    ['say "hi"'], // double quotes
    ['C:\\path'], // a backslash
  ])('delivers %j to the database as exactly the literal pattern', (term) => {
    const quoted = orIlike(['c'], term).slice('c.ilike.'.length)
    expect(postgrestUnquote(quoted)).toBe(containsPattern(term))
  })
})
