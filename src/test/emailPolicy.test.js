/**
 * emailPolicy.test.js — warn about likely typos, never reject a domain.
 *
 * The policy chosen for this system is deliberately not an allowlist. Rejecting
 * an unlisted domain turns away exactly the people you least want to turn away:
 * a new customer on their own company domain, or an overseas supplier. So the
 * only job here is catching a domain that is one or two keystrokes from a very
 * common one — and being quiet otherwise, because a warning nobody trusts is
 * worse than no warning at all.
 */
import { describe, it, expect } from 'vitest'
import {
  editDistance,
  emailDomain,
  suggestEmailDomain,
  checkEmail,
  COMMON_DOMAINS,
} from '../lib/emailPolicy.js'

describe('editDistance', () => {
  it('is zero for identical strings', () => {
    expect(editDistance('gmail.com', 'gmail.com')).toBe(0)
  })

  it('counts a single substitution, insertion or deletion as one', () => {
    expect(editDistance('gmial.com', 'gmail.com')).toBe(2) // transposition = 2 edits
    expect(editDistance('gmai.com', 'gmail.com')).toBe(1)
    expect(editDistance('gmaill.com', 'gmail.com')).toBe(1)
  })

  it('gives up early on wildly different lengths', () => {
    expect(editDistance('a', 'averylongdomain.com')).toBe(3)
  })
})

describe('emailDomain', () => {
  it('takes everything after the last @', () => {
    expect(emailDomain('sara@gmail.com')).toBe('gmail.com')
    // A quoted local part may itself contain an @.
    expect(emailDomain('odd@name@company.com')).toBe('company.com')
  })

  it('lower-cases and trims', () => {
    expect(emailDomain('  Sara@GMail.Com ')).toBe('gmail.com')
  })

  it('is empty for anything without an @', () => {
    expect(emailDomain('not-an-email')).toBe('')
    expect(emailDomain('')).toBe('')
    expect(emailDomain(null)).toBe('')
  })
})

describe('suggestEmailDomain', () => {
  it.each([
    ['sara@gmai.com', 'gmail.com'],
    ['sara@gmaill.com', 'gmail.com'],
    ['sara@hotmai.com', 'hotmail.com'],
    ['sara@outlok.com', 'outlook.com'],
    ['sara@yaho.com', 'yahoo.com'],
  ])('suggests a correction for %s', (email, expected) => {
    expect(suggestEmailDomain(email)).toBe(expected)
  })

  // The whole point of the policy. A company's own domain must never be
  // second-guessed, and neither must a correct common one.
  it.each([
    'sara@gmail.com',
    'sara@outlook.com',
    'ahmed@qdsegypt.com',
    'buyer@asrock.com.tw',
    'contact@some-small-business.eg',
  ])('stays quiet about %s', (email) => {
    expect(suggestEmailDomain(email)).toBeNull()
  })

  it('never suggests a domain that is already common and correct', () => {
    for (const d of COMMON_DOMAINS) {
      expect(suggestEmailDomain(`x@${d}`)).toBeNull()
    }
  })

  // Two edits on a short domain can reach something entirely unrelated, so the
  // looser threshold only applies where the word is long enough for two edits
  // to still mean "almost the same".
  it('does not fire on a short domain that is merely two edits away', () => {
    expect(suggestEmailDomain('x@aol.org')).toBeNull()
  })

  it('handles an address with no domain without throwing', () => {
    expect(suggestEmailDomain('not-an-email')).toBeNull()
    expect(suggestEmailDomain('')).toBeNull()
    expect(suggestEmailDomain(null)).toBeNull()
  })
})

describe('checkEmail', () => {
  // Never ok:false. A typo is a warning; the address is still saved if the
  // person means it.
  it('is always ok, even when it warns', () => {
    const r = checkEmail('sara@gmai.com')
    expect(r.ok).toBe(true)
    expect(r.warning).toBe('typo')
    expect(r.suggestion).toBe('gmail.com')
  })

  it('reports no warning for a good address', () => {
    expect(checkEmail('sara@gmail.com')).toEqual({ ok: true })
  })

  it('stays silent when typo warnings are switched off', () => {
    expect(checkEmail('sara@gmai.com', { typoWarnings: false })).toEqual({ ok: true })
  })

  it('says nothing about an empty field', () => {
    expect(checkEmail('')).toEqual({ ok: true })
    expect(checkEmail(null)).toEqual({ ok: true })
  })
})
