/**
 * importValidation.test.js — BUG-045.
 *
 * The CSV importers checked only that required fields were non-empty. The zod
 * schemas the forms use were never applied, so a value the single-record form
 * refuses — `email = "notanemail"` is the finding's own repro — went straight
 * into the database when it arrived in a spreadsheet instead.
 */
import { describe, it, expect } from 'vitest'
import { isImportableEmail, contactFieldProblems, missingCustomerFields } from '../lib/importValidation'

describe('isImportableEmail', () => {
  it('rejects the value from the finding', () => {
    expect(isImportableEmail('notanemail')).toBe(false)
  })

  it('rejects other malformed addresses', () => {
    for (const bad of ['a@', '@b.com', 'a b@c.com', 'a@b', 'a@@b.com']) {
      expect(isImportableEmail(bad)).toBe(false)
    }
  })

  it('accepts blank, because email is optional on an import row', () => {
    expect(isImportableEmail('')).toBe(true)
    expect(isImportableEmail('   ')).toBe(true)
    expect(isImportableEmail(null)).toBe(true)
    expect(isImportableEmail(undefined)).toBe(true)
  })

  it('accepts ordinary addresses', () => {
    for (const good of ['a@b.com', 'first.last+tag@sub.example.co.uk']) {
      expect(isImportableEmail(good)).toBe(true)
    }
  })

  it('rejects an absurdly long address', () => {
    expect(isImportableEmail('a'.repeat(320) + '@b.com')).toBe(false)
  })
})

describe('contactFieldProblems', () => {
  it('reports nothing for a clean row', () => {
    expect(contactFieldProblems({ email: 'a@b.com', mobile: '01000000000' })).toEqual([])
  })

  it('reports an invalid email and quotes the offending value', () => {
    const problems = contactFieldProblems({ email: 'notanemail' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('notanemail')
  })

  it('checks phone on leads and mobile on customers', () => {
    expect(contactFieldProblems({ phone: '0'.repeat(51) })).toHaveLength(1)
    expect(contactFieldProblems({ mobile: '0'.repeat(51) })).toHaveLength(1)
  })

  it('accepts an empty row rather than inventing problems', () => {
    expect(contactFieldProblems({})).toEqual([])
  })

  it('does not truncate a short bad value into something confusing', () => {
    expect(contactFieldProblems({ email: 'x@' })[0]).toContain('x@')
  })
})

// BUG-045: rows the add-customer form would refuse are imported, and named.
describe('missingCustomerFields', () => {
  it('reports nothing for a complete row', () => {
    expect(missingCustomerFields({ contact_person: 'Mona', mobile: '01001234567' })).toEqual([])
  })

  it('names a missing mobile', () => {
    expect(missingCustomerFields({ contact_person: 'Mona', mobile: '' })).toEqual(['mobile'])
  })

  it('names a missing contact person — allowed on a B2B import, required by the form', () => {
    expect(missingCustomerFields({ company_name: 'Acme', mobile: '01001234567' })).toEqual(['contact person'])
  })

  it('treats whitespace as missing and names both when both are absent', () => {
    expect(missingCustomerFields({ contact_person: '   ', mobile: null })).toEqual(['contact person', 'mobile'])
  })
})
