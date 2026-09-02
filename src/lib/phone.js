/**
 * Phone number validation, driven by country rules from the database.
 *
 * Before this, `mobile` and `landline` were free text with a 50-character cap,
 * so "0100" and "call the office" were equally valid. Numbers are the only way
 * to reach a customer about a repair, and one that is three digits short fails
 * silently at the moment someone needs it.
 *
 * ── The shape of a rule ──────────────────────────────────────────────────────
 *
 * A country carries:
 *   dialCode         '+20'
 *   mobilePrefixes   ['010','011','012','015']
 *   mobileDigits     11  — total national digits INCLUDING the prefix
 *   hasAreaCodes     true
 *   landlineDigits   only used when hasAreaCodes is false
 *   areaCodes        [{ areaCode: '2', name: 'Cairo / Giza', digits: 8 }, …]
 *
 * A country with no area codes just has none, and a landline is checked on
 * length alone. That is what "skip it and use the country code and the digit
 * count" means in practice.
 *
 * ── What counts as the same number ───────────────────────────────────────────
 *
 * People type +20 10 1234 5678, 0020-101-234-5678 and 01012345678 meaning the
 * same thing. All three normalise to the same national digits before any rule
 * is applied, because rejecting a correct number for its punctuation trains
 * people to fight the form.
 */

/** Everything that is not a digit or a leading +. */
export function stripFormatting(raw) {
  if (raw === null || raw === undefined) return ''
  const s = String(raw).trim()
  const plus = s.startsWith('+') ? '+' : ''
  return plus + s.replace(/[^\d]/g, '')
}

/**
 * Reduce a number to its NATIONAL digits — no country code, no trunk zero.
 *
 * Egypt: +201012345678, 00201012345678 and 01012345678 all become 1012345678.
 * The trunk zero is stripped last, because a national number that legitimately
 * starts with a zero after the country code would otherwise lose a digit.
 */
export function toNationalDigits(raw, country) {
  let s = stripFormatting(raw)
  if (!s) return ''

  const dial = (country?.dialCode || '').replace(/[^\d]/g, '')

  if (s.startsWith('+')) {
    s = s.slice(1)
    if (dial && s.startsWith(dial)) s = s.slice(dial.length)
  } else if (s.startsWith('00')) {
    // The keypad spelling of '+'.
    s = s.slice(2)
    if (dial && s.startsWith(dial)) s = s.slice(dial.length)
  } else if (dial && s.startsWith(dial) && s.length > dial.length + 6) {
    // A country code typed with no + and no 00. Only treated as one when what
    // remains is still long enough to be a real number — otherwise '20' at the
    // start of a local number would be eaten.
    s = s.slice(dial.length)
  }

  // Strip the country's OWN trunk prefix, not an assumed '0'. In a country with
  // no trunk prefix a national number that begins with 0 would otherwise lose a
  // digit — silently, and only for that country's numbers.
  const trunk = country?.trunkPrefix === undefined || country?.trunkPrefix === null
    ? '0'
    : String(country.trunkPrefix)
  if (trunk && s.startsWith(trunk)) s = s.slice(trunk.length)
  return s
}

export const PHONE_OK = 'ok'
export const PHONE_EMPTY = 'empty'
export const PHONE_NO_RULES = 'no_rules'
export const PHONE_BAD_PREFIX = 'bad_prefix'
export const PHONE_BAD_LENGTH = 'bad_length'
export const PHONE_BAD_AREA = 'bad_area'
export const PHONE_BAD_EITHER = 'bad_either'

/**
 * Validate a mobile number against a country's rules.
 *
 * Returns { code, expected } rather than a message, so the caller decides
 * whether a failure is an error or a warning — the difference between a new
 * record and one typed two years ago.
 */
/** How many digits the domestic trunk prefix adds. '0' → 1, '' → 0. */
function trunkPrefixLength(country) {
  const trunk = country?.trunkPrefix
  // Default to '0' when unset: it is by far the commoner convention, and the
  // seed sets it explicitly for every country that differs.
  return (trunk === undefined || trunk === null ? '0' : String(trunk)).length
}

export function validateMobile(raw, country) {
  const national = toNationalDigits(raw, country)
  if (!national) return { code: PHONE_EMPTY }

  // No rules configured is not the same as valid. Saying so lets the caller
  // stay silent rather than inventing a verdict it has no basis for.
  if (!country || !country.mobileDigits) return { code: PHONE_NO_RULES, national }

  const prefixes = country.mobilePrefixes || []
  // Prefixes are stored in trunk form ('010'); national digits have the trunk
  // zero removed, so compare against both spellings.
  const matchesPrefix =
    prefixes.length === 0 ||
    prefixes.some((p) => {
      const bare = String(p).replace(/^0+/, '')
      return national.startsWith(bare) || `0${national}`.startsWith(p)
    })

  // Length is checked the way the country writes it. Egypt's "11 digits" counts
  // the trunk zero (01012345678); Kuwait's "8 digits" has no zero to count.
  // Hardcoding +1 was right for Egypt and silently rejected every correct
  // number in a country with no trunk prefix.
  const trunkLength = trunkPrefixLength(country) + national.length

  if (!matchesPrefix) {
    return { code: PHONE_BAD_PREFIX, national, expected: prefixes.join(', ') }
  }
  if (trunkLength !== country.mobileDigits) {
    return { code: PHONE_BAD_LENGTH, national, expected: country.mobileDigits, actual: trunkLength }
  }
  return { code: PHONE_OK, national }
}

/**
 * Validate a landline.
 *
 * With area codes: the number must begin with a known area code and carry
 * exactly that area's subscriber-digit count. Longest match wins, so '2' does
 * not swallow a number that belongs to area '20'.
 *
 * Without area codes: length alone.
 */
export function validateLandline(raw, country) {
  const national = toNationalDigits(raw, country)
  if (!national) return { code: PHONE_EMPTY }
  if (!country) return { code: PHONE_NO_RULES, national }

  const areas = country.areaCodes || []

  if (country.hasAreaCodes && areas.length > 0) {
    // Longest first: '13' must be tried before '1'.
    const sorted = [...areas].sort((a, b) => String(b.areaCode).length - String(a.areaCode).length)
    const match = sorted.find((a) => national.startsWith(String(a.areaCode).replace(/^0+/, '')))

    if (!match) {
      return { code: PHONE_BAD_AREA, national, expected: sorted.map((a) => a.areaCode).join(', ') }
    }
    const bare = String(match.areaCode).replace(/^0+/, '')
    const subscriber = national.slice(bare.length)
    if (subscriber.length !== match.digits) {
      return {
        code: PHONE_BAD_LENGTH,
        national,
        area: match,
        expected: match.digits,
        actual: subscriber.length,
      }
    }
    return { code: PHONE_OK, national, area: match }
  }

  if (!country.landlineDigits) return { code: PHONE_NO_RULES, national }
  const trunkLength = trunkPrefixLength(country) + national.length
  if (trunkLength !== country.landlineDigits) {
    return { code: PHONE_BAD_LENGTH, national, expected: country.landlineDigits, actual: trunkLength }
  }
  return { code: PHONE_OK, national }
}

/**
 * Display form: +20 10 1234 5678.
 *
 * Grouping is deliberately loose — a country-by-country grouping table would be
 * a lot of data to maintain for a cosmetic gain, and a wrong grouping reads
 * worse than none.
 */
export function formatPhone(raw, country) {
  const national = toNationalDigits(raw, country)
  if (!national) return ''
  const dial = country?.dialCode || ''
  // Last four as one group, everything before it in threes. Grouping properly
  // is country-specific and a wrong grouping reads worse than none, so this
  // stays deliberately generic — but a trailing orphan digit ("234 567 8")
  // looks like a typo, which is worse than either.
  const head = national.slice(0, -4)
  const tail = national.slice(-4)
  const grouped = head
    ? `${head.replace(/(\d{3})(?=\d)/g, '$1 ')} ${tail}`.replace(/\s+/g, ' ').trim()
    : tail
  return dial ? `${dial} ${grouped}` : grouped
}

/**
 * Validate a field that may hold EITHER a mobile or a landline.
 *
 * Leads and vendors have one `phone` box, not two. Checking it as a mobile
 * would reject a supplier who gave their switchboard number, and checking it as
 * a landline would reject the majority who gave a mobile — so it passes if it
 * satisfies either rule.
 *
 * When it satisfies neither, the message matters. A number that starts with a
 * real mobile prefix is almost certainly a mobile with the wrong digit count,
 * and saying "expected 11 digits, got 10" is something a person can act on.
 * Only when it looks like neither does it fall back to saying so.
 */
export function validatePhoneEither(raw, country) {
  const asMobile = validateMobile(raw, country)
  if (asMobile.code === PHONE_EMPTY || asMobile.code === PHONE_NO_RULES) return asMobile
  if (asMobile.code === PHONE_OK) return asMobile

  const asLandline = validateLandline(raw, country)
  if (asLandline.code === PHONE_OK) return asLandline

  // It matched a mobile prefix but not the length: report that, because it is
  // the specific and actionable failure.
  if (asMobile.code === PHONE_BAD_LENGTH) return asMobile
  // It matched a known area code but not that area's length: same reasoning.
  if (asLandline.code === PHONE_BAD_LENGTH) return asLandline

  return {
    code: PHONE_BAD_EITHER,
    national: asMobile.national,
    expectedMobile: country?.mobileDigits,
    expectedPrefixes: (country?.mobilePrefixes || []).join(', '),
  }
}

/** True when a verdict should stop a save on a NEW record. */
export function isPhoneProblem(result) {
  return (
    result?.code === PHONE_BAD_PREFIX ||
    result?.code === PHONE_BAD_LENGTH ||
    result?.code === PHONE_BAD_AREA ||
    result?.code === PHONE_BAD_EITHER
  )
}
