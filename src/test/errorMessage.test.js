/**
 * errorMessage.test.js — turning thrown errors into copy a person can act on.
 *
 * The properties worth pinning are the ones where being wrong is either a leak
 * or a loss:
 *
 *  - database vocabulary must never reach the screen. A constraint name tells
 *    the user nothing and tells an attacker something about the schema;
 *  - errors the app raised deliberately must survive untouched. "You cannot
 *    delete your own account" is the whole value of that response, and
 *    replacing it with a generic sentence would be worse than the raw error
 *    this function exists to hide.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('i18next', () => ({
  // Return the key so assertions read as intent rather than as English copy.
  default: { t: (k) => k },
}))

const { toUserMessage } = await import('../lib/errorMessage.js')

describe('mapping Postgres error codes', () => {
  it('explains a unique violation instead of naming the constraint', () => {
    expect(
      toUserMessage({
        code: '23505',
        message: 'duplicate key value violates unique constraint "customers_email_key"',
      })
    ).toBe('errors.duplicate')
  })

  it('explains a foreign-key violation as still in use', () => {
    expect(toUserMessage({ code: '23503', message: 'violates foreign key constraint' })).toBe(
      'errors.inUse'
    )
  })

  it('maps insufficient privilege to a permission message', () => {
    expect(toUserMessage({ code: '42501' })).toBe('errors.noPermission')
  })

  it('maps a missing required field', () => {
    expect(toUserMessage({ code: '23502' })).toBe('errors.missingRequired')
  })
})

describe('errors with no code', () => {
  it('recognises a row-level-security refusal as a permission problem', () => {
    expect(toUserMessage({ message: 'new row violates row-level security policy' })).toBe(
      'errors.noPermission'
    )
  })

  it('recognises an expired session', () => {
    expect(toUserMessage({ message: 'JWT expired' })).toBe('errors.sessionExpired')
  })

  it('recognises a network failure', () => {
    expect(toUserMessage({ message: 'Failed to fetch' })).toBe('errors.network')
  })
})

describe('what must NOT be rewritten', () => {
  /**
   * The guards in this codebase return sentences written for a person. Those
   * are the most useful errors the app produces and must pass through.
   */
  it('passes through an error the app raised on purpose (P0001)', () => {
    expect(toUserMessage({ code: 'P0001', message: 'You cannot delete your own account' })).toBe(
      'You cannot delete your own account'
    )
  })

  it('passes through plain prose from an Edge Function', () => {
    expect(toUserMessage({ message: 'That address already has a pending invitation' })).toBe(
      'That address already has a pending invitation'
    )
  })
})

describe('the safety net', () => {
  /**
   * The point of the whole module: schema vocabulary never reaches a user, even
   * when no code matched and no pattern fired.
   */
  it('falls back to generic for anything still carrying database vocabulary', () => {
    expect(toUserMessage({ message: 'relation "public.rma_tickets" does not exist' })).toBe(
      'errors.generic'
    )
    expect(toUserMessage({ message: 'column t.foo does not exist' })).toBe('errors.generic')
    expect(toUserMessage({ message: 'syntax error at or near "SELECT"' })).toBe('errors.generic')
  })

  it('handles a null or empty error without throwing', () => {
    expect(toUserMessage(null)).toBe('errors.generic')
    expect(toUserMessage(undefined)).toBe('errors.generic')
    expect(toUserMessage({})).toBe('errors.generic')
  })

  it('accepts a bare string', () => {
    expect(toUserMessage('Could not reach the printer')).toBe('Could not reach the printer')
  })
})
