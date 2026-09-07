/**
 * mfaGate.test.js — BUG-020.
 *
 * The sign-in paths discarded the error from getLevel(), so a transient
 * failure (or a deliberately blocked /auth/v1/factors request) admitted an
 * MFA-enrolled user at AAL1. These pin the rule: only a definite "no second
 * factor required" admits; anything else, including not being able to tell,
 * refuses.
 */
import { describe, it, expect } from 'vitest'
import { resolveMfaGate } from '../lib/mfaGate'

const auth = (getLevel, listFactors) => ({ mfa: { getLevel, listFactors } })
const ok = (data) => async () => ({ data, error: null })
const fails = (message) => async () => ({ data: null, error: { message } })
const throws = (message) => async () => {
  throw new Error(message)
}

describe('resolveMfaGate — admits only when it is certain', () => {
  it('admits when no second factor is required', async () => {
    const gate = await resolveMfaGate(auth(ok({ currentLevel: 'aal1', nextLevel: 'aal1' })))
    expect(gate.status).toBe('ok')
  })

  it('admits when the second factor has already been satisfied', async () => {
    const gate = await resolveMfaGate(auth(ok({ currentLevel: 'aal2', nextLevel: 'aal2' })))
    expect(gate.status).toBe('ok')
  })

  it('challenges when a verified TOTP factor is owed', async () => {
    const gate = await resolveMfaGate(
      auth(
        ok({ currentLevel: 'aal1', nextLevel: 'aal2' }),
        ok({ all: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] }),
      ),
    )
    expect(gate).toEqual({ status: 'challenge', factorId: 'f1' })
  })
})

describe('resolveMfaGate — fails closed', () => {
  it('refuses when getLevel returns an error (the original bypass)', async () => {
    const gate = await resolveMfaGate(auth(fails('network')))
    expect(gate.status).toBe('unavailable')
  })

  it('refuses when getLevel returns no data at all', async () => {
    const gate = await resolveMfaGate(auth(ok(null)))
    expect(gate.status).toBe('unavailable')
  })

  it('refuses when getLevel throws rather than returning an error', async () => {
    const gate = await resolveMfaGate(auth(throws('offline')))
    expect(gate.status).toBe('unavailable')
  })

  it('refuses when a factor is owed but listFactors fails — the second, unreported bypass', async () => {
    const gate = await resolveMfaGate(
      auth(ok({ currentLevel: 'aal1', nextLevel: 'aal2' }), fails('blocked')),
    )
    expect(gate.status).toBe('unavailable')
  })

  it('refuses when listFactors throws', async () => {
    const gate = await resolveMfaGate(
      auth(ok({ currentLevel: 'aal1', nextLevel: 'aal2' }), throws('blocked')),
    )
    expect(gate.status).toBe('unavailable')
  })

  it('refuses when a factor is owed but none is verified', async () => {
    const gate = await resolveMfaGate(
      auth(
        ok({ currentLevel: 'aal1', nextLevel: 'aal2' }),
        ok({ all: [{ id: 'f1', factor_type: 'totp', status: 'unverified' }] }),
      ),
    )
    expect(gate.status).toBe('unavailable')
  })

  it('refuses when the only factor is a type this app cannot challenge', async () => {
    const gate = await resolveMfaGate(
      auth(
        ok({ currentLevel: 'aal1', nextLevel: 'aal2' }),
        ok({ all: [{ id: 'f1', factor_type: 'phone', status: 'verified' }] }),
      ),
    )
    expect(gate.status).toBe('unavailable')
  })

  it('never returns ok on any failure path', async () => {
    const paths = [
      auth(fails('x')),
      auth(throws('x')),
      auth(ok({ currentLevel: 'aal1', nextLevel: 'aal2' }), fails('x')),
      auth(ok({ currentLevel: 'aal1', nextLevel: 'aal2' }), ok({ all: [] })),
    ]
    for (const a of paths) {
      expect((await resolveMfaGate(a)).status).not.toBe('ok')
    }
  })
})
