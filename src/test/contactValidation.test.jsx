/**
 * contactValidation.test.jsx — the new-vs-existing rule.
 *
 * The rule chosen for this system: a NEW record must comply with the phone
 * rules; an EXISTING one is warned and saved anyway. Getting that backwards is
 * not a cosmetic bug — enforcing everywhere immediately would stop someone
 * updating a customer's address because of a landline typed two years ago,
 * before any rule existed, with no way forward but to invent a number. Invented
 * data is worse than the wrong data it replaces.
 *
 * These tests pin the asymmetry, and the three cases that must never block:
 * an empty field, a country with no rules, and any email at all.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import React from 'react'
import { readFileSync } from 'node:fs'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key) }),
}))

const EG = {
  dialCode: '+20',
  trunkPrefix: '0',
  mobilePrefixes: ['010', '011', '012', '015'],
  mobileDigits: 11,
  hasAreaCodes: true,
  landlineDigits: null,
  areaCodes: [{ areaCode: '2', name: 'Cairo / Giza', digits: 8 }],
}

let RULES = EG
vi.mock('../hooks/useCountryRules', () => ({
  useCountryRules: () => RULES,
  useCountryOptions: () => [],
}))

const { useContactValidation } = await import('../hooks/useContactValidation')
const { PhoneNote, EmailNote } = await import('../components/ContactValidation')

afterEach(() => {
  cleanup()
  RULES = EG
})

/** Runs the hook by rendering a probe component. */
function run(args) {
  let captured
  function Probe() {
    captured = useContactValidation(args)
    return null
  }
  render(<Probe />)
  return captured
}

describe('a new record must comply', () => {
  it('blocks a mobile that is too short', () => {
    const r = run({ mobile: '0101234567', landline: '', email: '', editing: false })
    expect(r.blocking).toBe(true)
  })

  it('blocks a landline with an unknown area code', () => {
    const r = run({ mobile: '01012345678', landline: '0991234567', email: '', editing: false })
    expect(r.blocking).toBe(true)
  })

  it('allows a valid pair', () => {
    const r = run({ mobile: '01012345678', landline: '0223456789', email: '', editing: false })
    expect(r.blocking).toBe(false)
  })
})

describe('an existing record is warned, never blocked', () => {
  // The asymmetry, stated directly. Same input, different verdict.
  it('does not block the very number it would reject on a new record', () => {
    const asNew = run({ mobile: '0101234567', landline: '', email: '', editing: false })
    const asExisting = run({ mobile: '0101234567', landline: '', email: '', editing: true })
    expect(asNew.blocking).toBe(true)
    expect(asExisting.blocking).toBe(false)
    // But the problem is still detected — it is the severity that changes, not
    // the verdict. A warning that did not know there was a problem would be no
    // warning at all.
    expect(asExisting.mobileResult.code).toBe(asNew.mobileResult.code)
  })
})

describe('what must never block anyone', () => {
  it('an empty field', () => {
    expect(run({ mobile: '', landline: '', email: '', editing: false }).blocking).toBe(false)
  })

  // "No rules configured" is not "everything is valid" — but it must not stop a
  // save either. Silence is the only honest response.
  it('a country with no rules configured', () => {
    RULES = null
    const r = run({ mobile: 'anything at all', landline: '', email: '', editing: false })
    expect(r.blocking).toBe(false)
  })

  it('any email, however odd, since there is no allowlist', () => {
    const r = run({
      mobile: '01012345678',
      landline: '',
      email: 'someone@a-domain-nobody-listed.example',
      editing: false,
    })
    expect(r.blocking).toBe(false)
    expect(r.emailResult.ok).toBe(true)
    expect(r.emailResult.warning).toBeUndefined()
  })

  it('a mistyped email — it suggests, it does not refuse', () => {
    const r = run({ mobile: '01012345678', landline: '', email: 'sara@gmai.com', editing: false })
    expect(r.blocking).toBe(false)
    expect(r.emailResult.warning).toBe('typo')
    expect(r.emailResult.suggestion).toBe('gmail.com')
  })
})

describe('PhoneNote', () => {
  it.each([
    ['ok', { code: 'ok' }],
    ['empty', { code: 'empty' }],
    // Announcing "no rules" under every field would train people to ignore the
    // line where a real problem later appears.
    ['no_rules', { code: 'no_rules' }],
  ])('says nothing for %s', (_name, result) => {
    const { container } = render(<PhoneNote result={result} editing={false} />)
    expect(container.textContent).toBe('')
  })

  it('is red on a new record and says nothing about saving anyway', () => {
    const { container } = render(
      <PhoneNote result={{ code: 'bad_length', expected: 11, actual: 10 }} editing={false} />
    )
    expect(container.querySelector('p').className).toContain('text-red-600')
    expect(container.textContent).not.toContain('savedAnyway')
  })

  it('is amber on an existing record and says it will save anyway', () => {
    const { container } = render(
      <PhoneNote result={{ code: 'bad_length', expected: 11, actual: 10 }} editing />
    )
    expect(container.querySelector('p').className).toContain('text-amber-600')
    expect(container.textContent).toContain('phone.savedAnyway')
  })

  it('passes the numbers into the message so it can say what was expected', () => {
    render(<PhoneNote result={{ code: 'bad_length', expected: 11, actual: 10 }} editing={false} />)
    expect(screen.getByText(/"expected":11/)).toBeTruthy()
    expect(screen.getByText(/"actual":10/)).toBeTruthy()
  })
})

describe('EmailNote', () => {
  it('says nothing when there is no warning', () => {
    const { container } = render(<EmailNote result={{ ok: true }} />)
    expect(container.textContent).toBe('')
  })

  it('offers the suggestion and hands back the corrected domain', () => {
    const onAccept = vi.fn()
    render(
      <EmailNote
        result={{ ok: true, warning: 'typo', domain: 'gmai.com', suggestion: 'gmail.com' }}
        onAccept={onAccept}
      />
    )
    screen.getByText('phone.emailUseSuggestion').click()
    expect(onAccept).toHaveBeenCalledWith('gmail.com')
  })
})

describe('the customer form applies the rule', () => {
  const src = readFileSync('src/pages/Customers/_modals.jsx', 'utf8')

  it('gates the save button on the blocking verdict, not on the raw result', () => {
    expect(src).toContain('disabled={contact.blocking}')
  })

  it('passes `editing` through, so the severity can differ', () => {
    expect(src).toContain('editing,')
    expect(src).toContain('<PhoneNote result={contact.mobileResult} editing={editing} />')
    expect(src).toContain('<PhoneNote result={contact.landlineResult} editing={editing} />')
  })

  it('sends the country override with the record', () => {
    const index = readFileSync('src/pages/Customers/index.jsx', 'utf8')
    expect(index).toContain('country_code: customerForm.country_code || null')
  })
})

/**
 * The single-phone forms: leads and vendors.
 *
 * One box that may hold a mobile or a landline. Validating it strictly as a
 * mobile would reject a supplier who gave their switchboard number, which is
 * not a mistake.
 */
describe('a single phone field accepts either kind', () => {
  it('passes a mobile and a landline alike', () => {
    expect(run({ phone: '01012345678', email: '', editing: false }).blocking).toBe(false)
    expect(run({ phone: '0223456789', email: '', editing: false }).blocking).toBe(false)
  })

  it('blocks something that is neither, on a new record', () => {
    expect(run({ phone: '0991234567', email: '', editing: false }).blocking).toBe(true)
  })

  it('warns rather than blocks on an existing record', () => {
    expect(run({ phone: '0991234567', email: '', editing: true }).blocking).toBe(false)
  })

  it('leaves an empty phone alone', () => {
    expect(run({ phone: '', email: '', editing: false }).blocking).toBe(false)
  })
})

describe('the other three forms apply the rule', () => {
  const leads = readFileSync('src/pages/Leads/_modals.jsx', 'utf8')
  const purchasing = readFileSync('src/pages/Purchasing/_modals.jsx', 'utf8')
  const users = readFileSync('src/pages/UserManagement/UsersTab.jsx', 'utf8')

  it('the lead form validates its phone and gates its save', () => {
    expect(leads).toContain('<PhoneNote result={contact.phoneResult} editing={editing} />')
    expect(leads).toContain('disabled={contact.blocking}')
  })

  it('the vendor field-set validates phone and email', () => {
    expect(purchasing).toContain('<PhoneNote result={contact.phoneResult} editing={editing} />')
    expect(purchasing).toContain('result={contact.emailResult}')
  })

  // Create must enforce, edit must warn. Passing `editing` to both — or to
  // neither — silently collapses the whole distinction.
  it('the vendor CREATE modal enforces and the EDIT modal warns', () => {
    // [\s\S]*? and not [^>]*: the props contain an arrow function, so a
    // negated-'>' class stops at the '=>' and matches nothing.
    const calls = purchasing.match(/<VendorFieldsSection[\s\S]*?\/>/g) ?? []
    expect(calls).toHaveLength(2)
    const withEditing = calls.filter((c) => /\bediting\b/.test(c))
    expect(withEditing).toHaveLength(1)
  })

  it('the vendor country override reaches the database', () => {
    expect(purchasing).toContain('country_code: vendor.country_code || null')
    // Both save paths spread the field-set, so the new column travels with it.
    expect(purchasing).toContain('...vendorFields')
  })

  // No phone on a user, and an unfamiliar domain must never stop a colleague
  // being invited.
  it('the user invite warns about a typo and blocks nothing', () => {
    expect(users).toContain('<EmailNote')
    expect(users).toContain('checkEmail(email)')
    expect(users).not.toContain('contact.blocking')
  })
})
