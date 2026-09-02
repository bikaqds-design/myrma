/**
 * phone.test.js — country-driven phone validation.
 *
 * Before this, `mobile` and `landline` were free text capped at 50 characters,
 * so "0100" and "call the office" were equally valid. The tests that matter are
 * the ones where being wrong is invisible: a number that is one digit short
 * looks fine on screen and fails only when someone needs to reach a customer
 * about a repair.
 */
import { describe, it, expect } from 'vitest'
import {
  stripFormatting,
  toNationalDigits,
  validateMobile,
  validateLandline,
  validatePhoneEither,
  formatPhone,
  isPhoneProblem,
  PHONE_OK,
  PHONE_EMPTY,
  PHONE_NO_RULES,
  PHONE_BAD_PREFIX,
  PHONE_BAD_LENGTH,
  PHONE_BAD_AREA,
  PHONE_BAD_EITHER,
} from '../lib/phone.js'

/** Egypt, as seeded by 20260799 and corrected by 20260803. */
const EG = {
  dialCode: '+20',
  trunkPrefix: '0',
  mobilePrefixes: ['010', '011', '012', '015'],
  mobileDigits: 11,
  hasAreaCodes: true,
  landlineDigits: null,
  areaCodes: [
    { areaCode: '2', name: 'Cairo / Giza', digits: 8 },
    { areaCode: '3', name: 'Alexandria', digits: 7 },
    { areaCode: '13', name: 'Qalyubia (Banha)', digits: 7 },
    { areaCode: '50', name: 'Dakahlia', digits: 7 },
    // Corrected in 20260803. 62/64 and 68/69 were seeded the wrong way round,
    // and 15 was missing altogether.
    { areaCode: '15', name: '10th of Ramadan City', digits: 7 },
    { areaCode: '62', name: 'Suez', digits: 7 },
    { areaCode: '64', name: 'Ismailia', digits: 7 },
    { areaCode: '68', name: 'North Sinai (El Arish)', digits: 7 },
    { areaCode: '69', name: 'South Sinai (El Tor / Sharm El Sheikh)', digits: 7 },
  ],
}

/** A country with no area codes at all — the "skip it" case from the brief. */
const NO_AREAS = {
  dialCode: '+965',
  trunkPrefix: '',
  mobilePrefixes: ['5', '6', '9'],
  mobileDigits: 8,
  hasAreaCodes: false,
  landlineDigits: 8,
  areaCodes: [],
}

/**
 * The area codes corrected in 20260803.
 *
 * These are not cosmetic labels. useContactValidation blocks a NEW record whose
 * landline fails, and validateLandline resolves the area code against this
 * table — so a missing or misnamed row refuses a real customer at the counter.
 * 20260799 seeded them from memory and got three wrong.
 */
describe('the Egyptian area codes corrected in 20260803', () => {
  it('accepts a 10th of Ramadan landline, which used to be refused outright', () => {
    // The whole industrial city was missing from the seed, so every landline
    // there failed with "unknown area code" and the customer could not be saved.
    expect(validateLandline('0153456789', EG).code).toBe(PHONE_OK)
  })

  /**
   * 015 is both the 10th of Ramadan landline code and the We mobile prefix.
   * They are told apart by length, and the two validators never consult each
   * other — so adding the landline code must not have made mobiles ambiguous.
   */
  it('still reads an 015 mobile as a mobile', () => {
    expect(validateMobile('01512345678', EG).code).toBe(PHONE_OK)
    expect(validatePhoneEither('01512345678', EG).code).toBe(PHONE_OK)
    expect(validatePhoneEither('0153456789', EG).code).toBe(PHONE_OK)
  })

  it('names 62 as Suez and 64 as Ismailia, not the reverse', () => {
    expect(validateLandline('0623456789', EG).area.name).toBe('Suez')
    expect(validateLandline('0643456789', EG).area.name).toBe('Ismailia')
  })

  it('names 68 as North Sinai and 69 as South Sinai, not the reverse', () => {
    expect(validateLandline('0683456789', EG).area.name).toMatch(/^North Sinai/)
    expect(validateLandline('0693456789', EG).area.name).toMatch(/^South Sinai/)
  })

  // The longest-match rule has to keep working now that '15' sits beside '13'
  // and '1' is not an area code at all.
  it('does not let a one-digit area swallow a two-digit one', () => {
    expect(validateLandline('0133456789', EG).area.areaCode).toBe('13')
    expect(validateLandline('0153456789', EG).area.areaCode).toBe('15')
  })
})

describe('normalising what people actually type', () => {
  it('drops spaces, dashes and brackets', () => {
    expect(stripFormatting(' 010 (1234) 5678 ')).toBe('01012345678')
    expect(stripFormatting('+20-10-1234-5678')).toBe('+201012345678')
  })

  it('handles null and undefined without throwing', () => {
    expect(stripFormatting(null)).toBe('')
    expect(stripFormatting(undefined)).toBe('')
  })

  // The same number, three ways people write it. Rejecting a correct number
  // for its punctuation is how forms train people to fight them.
  it.each([
    ['+201012345678', 'international with plus'],
    ['00201012345678', 'international with 00'],
    ['01012345678', 'national with trunk zero'],
    ['+20 10 1234 5678', 'international, spaced'],
  ])('reduces %s (%s) to the same national digits', (input) => {
    expect(toNationalDigits(input, EG)).toBe('1012345678')
  })

  // '20' at the start of a short local number must not be mistaken for the
  // country code — that would silently delete two digits.
  it('does not eat a leading country code from a short local number', () => {
    expect(toNationalDigits('2012345', EG)).toBe('2012345')
  })
})

describe('mobile numbers', () => {
  it.each(['01012345678', '01112345678', '01212345678', '01512345678'])(
    'accepts %s',
    (n) => {
      expect(validateMobile(n, EG).code).toBe(PHONE_OK)
    }
  )

  it('accepts the same number written internationally', () => {
    expect(validateMobile('+20 101 234 5678', EG).code).toBe(PHONE_OK)
  })

  // The invisible failure: right prefix, wrong length.
  it('rejects a number one digit short', () => {
    const r = validateMobile('0101234567', EG)
    expect(r.code).toBe(PHONE_BAD_LENGTH)
    expect(r.expected).toBe(11)
    expect(r.actual).toBe(10)
  })

  it('rejects a number one digit long', () => {
    expect(validateMobile('010123456789', EG).code).toBe(PHONE_BAD_LENGTH)
  })

  it('rejects a prefix Egypt does not issue', () => {
    // 013 is not an Egyptian mobile prefix.
    const r = validateMobile('01312345678', EG)
    expect(r.code).toBe(PHONE_BAD_PREFIX)
    expect(r.expected).toContain('010')
  })

  it('reports empty separately from invalid', () => {
    expect(validateMobile('', EG).code).toBe(PHONE_EMPTY)
    expect(validateMobile(null, EG).code).toBe(PHONE_EMPTY)
  })

  // "No rules" is not "valid". Saying so lets the caller stay silent rather
  // than inventing a verdict it has no basis for.
  it('does not claim a verdict when the country has no rules', () => {
    expect(validateMobile('12345', null).code).toBe(PHONE_NO_RULES)
    expect(validateMobile('12345', { dialCode: '+99' }).code).toBe(PHONE_NO_RULES)
  })

  it('checks length only when a country issues no prefix list', () => {
    const anyPrefix = { ...EG, mobilePrefixes: [] }
    expect(validateMobile('01912345678', anyPrefix).code).toBe(PHONE_OK)
    expect(validateMobile('0191234567', anyPrefix).code).toBe(PHONE_BAD_LENGTH)
  })
})

describe('landlines with area codes', () => {
  it('accepts a Cairo number: area 2 plus eight digits', () => {
    const r = validateLandline('0223456789', EG)
    expect(r.code).toBe(PHONE_OK)
    expect(r.area.name).toBe('Cairo / Giza')
  })

  it('accepts an Alexandria number: area 3 plus seven digits', () => {
    const r = validateLandline('034567890', EG)
    expect(r.code).toBe(PHONE_OK)
    expect(r.area.name).toBe('Alexandria')
  })

  // Cairo takes eight subscriber digits and Alexandria seven, so a single
  // national length would wrongly accept or reject one of them.
  it('holds each area to its own subscriber length', () => {
    // Cairo with only seven — wrong.
    expect(validateLandline('022345678', EG).code).toBe(PHONE_BAD_LENGTH)
    // Alexandria with eight — also wrong.
    expect(validateLandline('0345678901', EG).code).toBe(PHONE_BAD_LENGTH)
  })

  // '13' must be matched before '1'. Without longest-match, a Banha number
  // would be read as area 1 and rejected.
  it('prefers the longest matching area code', () => {
    const r = validateLandline('0131234567', EG)
    expect(r.code).toBe(PHONE_OK)
    expect(r.area.areaCode).toBe('13')
  })

  it('rejects an area code that does not exist', () => {
    const r = validateLandline('0991234567', EG)
    expect(r.code).toBe(PHONE_BAD_AREA)
  })

  it('accepts a landline written internationally', () => {
    expect(validateLandline('+20 2 2345 6789', EG).code).toBe(PHONE_OK)
  })
})

describe('landlines in a country with no area codes', () => {
  // The brief's explicit case: skip the area code, use the country code and the
  // digit count.
  it('checks length alone', () => {
    expect(validateLandline('22345678', NO_AREAS).code).toBe(PHONE_OK)
    expect(validateLandline('2234567', NO_AREAS).code).toBe(PHONE_BAD_LENGTH)
  })

  it('never reports a bad area code', () => {
    expect(validateLandline('99999999', NO_AREAS).code).not.toBe(PHONE_BAD_AREA)
  })

  it('stays silent when the country has no landline length either', () => {
    const noRules = { ...NO_AREAS, landlineDigits: null }
    expect(validateLandline('123', noRules).code).toBe(PHONE_NO_RULES)
  })

  // A country flagged as having area codes but with none configured would
  // otherwise fall through to a NULL length and accept anything.
  it('does not silently accept anything when area codes are claimed but absent', () => {
    const broken = { ...EG, areaCodes: [], landlineDigits: null }
    expect(validateLandline('1', broken).code).toBe(PHONE_NO_RULES)
  })
})

describe('display and severity', () => {
  it('formats with the dial code', () => {
    expect(formatPhone('01012345678', EG)).toBe('+20 101 234 5678')
  })

  it('is empty for an empty number rather than showing a bare +20', () => {
    expect(formatPhone('', EG)).toBe('')
  })

  // Empty and no-rules must not block a save: one is a field nobody filled in,
  // the other is a country nobody has configured.
  it.each([
    [PHONE_OK, false],
    [PHONE_EMPTY, false],
    [PHONE_NO_RULES, false],
    [PHONE_BAD_PREFIX, true],
    [PHONE_BAD_LENGTH, true],
    [PHONE_BAD_AREA, true],
  ])('treats %s as a blocking problem: %s', (code, expected) => {
    expect(isPhoneProblem({ code })).toBe(expected)
  })
})

describe('the trunk prefix comes from the country, not an assumption', () => {
  // Egypt counts the trunk zero in "11 digits"; a country with no trunk prefix
  // counts none. Hardcoding +1 was right for Egypt and silently rejected every
  // correct number elsewhere — the first version of this library did exactly
  // that and the no-area-code test caught it.
  it('counts the trunk zero for a country that has one', () => {
    expect(validateMobile('01012345678', EG).code).toBe(PHONE_OK)
  })

  it('counts no trunk digit for a country without one', () => {
    // 8 national digits, and mobileDigits is 8 — no phantom +1.
    expect(validateMobile('51234567', NO_AREAS).code).toBe(PHONE_OK)
    expect(validateMobile('5123456', NO_AREAS).code).toBe(PHONE_BAD_LENGTH)
  })

  it('does not strip a leading zero in a country with no trunk prefix', () => {
    // The digit would vanish silently, and only for that country's numbers.
    expect(toNationalDigits('0123456', NO_AREAS)).toBe('0123456')
    expect(toNationalDigits('0123456', EG)).toBe('123456')
  })

  it('defaults to a trunk zero when the country does not say', () => {
    const unset = { ...EG, trunkPrefix: undefined }
    expect(validateMobile('01012345678', unset).code).toBe(PHONE_OK)
  })
})

/**
 * A single phone field that may hold either kind.
 *
 * Leads and vendors have one `phone` box, not two. Checking it as a mobile
 * would reject a supplier who gave their switchboard; checking it as a landline
 * would reject the majority who gave a mobile.
 */
describe('validatePhoneEither', () => {
  it('accepts a valid mobile', () => {
    expect(validatePhoneEither('01012345678', EG).code).toBe(PHONE_OK)
  })

  it('accepts a valid landline', () => {
    const r = validatePhoneEither('0223456789', EG)
    expect(r.code).toBe(PHONE_OK)
    expect(r.area.name).toBe('Cairo / Giza')
  })

  // The message has to be actionable. "Expected 11 digits, got 10" is something
  // a person can fix; "not a valid mobile or landline" is not.
  it('reports the length problem when it looks like a mobile', () => {
    const r = validatePhoneEither('0101234567', EG)
    expect(r.code).toBe(PHONE_BAD_LENGTH)
    expect(r.expected).toBe(11)
  })

  it('reports the length problem when it looks like a landline', () => {
    // Cairo area, one digit short of its eight.
    const r = validatePhoneEither('022345678', EG)
    expect(r.code).toBe(PHONE_BAD_LENGTH)
  })

  it('says it is neither when it resembles neither', () => {
    expect(validatePhoneEither('0991234567', EG).code).toBe(PHONE_BAD_EITHER)
  })

  it('stays quiet on empty and on a country with no rules', () => {
    expect(validatePhoneEither('', EG).code).toBe(PHONE_EMPTY)
    expect(validatePhoneEither('123', null).code).toBe(PHONE_NO_RULES)
  })

  it('counts as a blocking problem on a new record', () => {
    expect(isPhoneProblem({ code: PHONE_BAD_EITHER })).toBe(true)
  })
})
