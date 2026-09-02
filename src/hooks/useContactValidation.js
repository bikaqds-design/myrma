import { useCountryRules } from '../hooks/useCountryRules'
import {
  validateMobile,
  validateLandline,
  validatePhoneEither,
  isPhoneProblem,
} from '../lib/phone'
import { checkEmail } from '../lib/emailPolicy'

/**
 * Phone and email checking for any form that collects them.
 *
 * ── Why a new record and an existing one are treated differently ─────────────
 *
 * Enforcing the rules everywhere immediately would block routine edits on
 * hundreds of records because of a number somebody typed two years ago, before
 * any rule existed. Someone updating a customer's address would be stopped by
 * their landline and would have no way forward except to invent a number, which
 * is worse data than the wrong one.
 *
 * So: a NEW record must comply. An EXISTING one shows the same message as a
 * warning and saves anyway. The data gets cleaner as records are touched, and
 * nobody is held hostage by history.
 *
 * ── Why email is never blocked ──────────────────────────────────────────────
 *
 * There is deliberately no domain allowlist. A near-miss on a very common
 * domain is a warning with a suggestion; everything else passes silently. The
 * addresses an allowlist would reject are new customers on their own company
 * domains — the worst possible thing to refuse.
 */
export function useContactValidation({
  mobile,
  landline,
  /**
   * For forms with ONE phone box rather than a mobile and a landline — leads
   * and vendors. Validated as either kind, because a supplier who gives their
   * switchboard number is not making a mistake.
   */
  phone,
  email,
  countryCode,
  editing = false,
  typoWarnings = true,
}) {
  const rules = useCountryRules(countryCode)

  const mobileResult = validateMobile(mobile, rules)
  const landlineResult = validateLandline(landline, rules)
  const phoneResult = validatePhoneEither(phone, rules)
  const emailResult = checkEmail(email, { typoWarnings })

  // Only a new record is blocked, and only by a real format problem — never by
  // an empty field or a country with no rules configured.
  const blocking =
    !editing &&
    (isPhoneProblem(mobileResult) ||
      isPhoneProblem(landlineResult) ||
      isPhoneProblem(phoneResult))

  return { rules, mobileResult, landlineResult, phoneResult, emailResult, blocking }
}
