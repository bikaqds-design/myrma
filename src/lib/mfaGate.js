/**
 * Decide whether a session still owes a second factor — failing CLOSED.
 * (Audit finding BUG-020.)
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 *
 * Both sign-in paths in App.jsx used to read the assurance level and discard
 * the error:
 *
 *   const { data: aalData } = await auth.mfa.getLevel()
 *   if (aalData?.nextLevel === 'aal2' && aalData?.currentLevel !== 'aal2') { … }
 *
 * When that call failed, `aalData` was undefined, the condition was false, and
 * the user was admitted at AAL1 with no second factor. There was a second
 * instance of the same shape immediately after it, which the finding did not
 * mention: when `getLevel()` *did* report that a second factor was owed but
 * `listFactors()` then failed, `totp` was undefined and control fell through to
 * the same `finishLogin` call.
 *
 * Either way a transient network fault — or a deliberately blocked
 * /auth/v1/factors request — turned MFA off for that sign-in.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * Only a definite "no second factor is required" admits the user. Anything
 * else, including not being able to tell, refuses. The caller is expected to
 * sign the session out rather than leave it half-authenticated.
 *
 * Lives here rather than inline in App.jsx so it can be tested: a security
 * check that nothing exercises is how the original defect survived.
 */

/**
 * @param {{ mfa: { getLevel: Function, listFactors: Function } }} auth
 * @returns {Promise<{status:'ok'} | {status:'challenge', factorId:string} | {status:'unavailable', reason?:unknown}>}
 */
export async function resolveMfaGate(auth) {
  let level, levelError
  try {
    ;({ data: level, error: levelError } = await auth.mfa.getLevel())
  } catch (err) {
    return { status: 'unavailable', reason: err }
  }
  if (levelError || !level) return { status: 'unavailable', reason: levelError }

  // The only path that admits without a challenge.
  if (level.nextLevel !== 'aal2' || level.currentLevel === 'aal2') return { status: 'ok' }

  let factors, factorsError
  try {
    ;({ data: factors, error: factorsError } = await auth.mfa.listFactors())
  } catch (err) {
    return { status: 'unavailable', reason: err }
  }
  if (factorsError || !factors) return { status: 'unavailable', reason: factorsError }

  const totp = factors.all?.find((f) => f.factor_type === 'totp' && f.status === 'verified')

  // `nextLevel === 'aal2'` means Supabase knows of a verified factor, so
  // finding none here is a contradiction, not a green light. Refuse.
  if (!totp) {
    return { status: 'unavailable', reason: new Error('MFA required but no usable factor was found') }
  }

  return { status: 'challenge', factorId: totp.id }
}
