/**
 * updatePassword.test.js — Unit tests for the password-change surface of src/api/auth.js
 *
 * These lock in the contract that lets the Supabase project setting
 * "Require current password when updating"
 * (GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD) be turned on:
 *
 *   - the signed-in change-password path sends `current_password` (snake_case —
 *     that is the field GoTrue reads; `currentPassword` is silently ignored),
 *   - the recovery-link path sends no current password at all, which GoTrue
 *     permits because its check is guarded by `if !session.IsRecovery()`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const updateUserMock = vi.fn()
vi.mock('../api/client.js', () => ({
  supabase: { auth: { updateUser: updateUserMock } },
}))

const { auth } = await import('../api/auth.js')

beforeEach(() => {
  updateUserMock.mockReset()
  updateUserMock.mockResolvedValue({ data: {}, error: null })
})

describe('auth.updatePassword — signed-in change', () => {
  it('sends the current password as `current_password`', async () => {
    await auth.updatePassword('newpass1', 'oldpass1')
    expect(updateUserMock).toHaveBeenCalledTimes(1)
    expect(updateUserMock).toHaveBeenCalledWith({
      password: 'newpass1',
      current_password: 'oldpass1',
    })
  })

  it('does not use the camelCase spelling GoTrue would ignore', async () => {
    await auth.updatePassword('newpass1', 'oldpass1')
    expect(updateUserMock.mock.calls[0][0]).not.toHaveProperty('currentPassword')
  })

  it('omits the field entirely when no current password is given', async () => {
    // Keeps the call valid while the project setting is still off, so this
    // change can ship before the setting is flipped.
    await auth.updatePassword('newpass1')
    expect(updateUserMock).toHaveBeenCalledWith({ password: 'newpass1' })
    expect(updateUserMock.mock.calls[0][0]).not.toHaveProperty('current_password')
  })

  it('propagates a wrong-current-password error with its code intact', async () => {
    const err = Object.assign(new Error('Current password required when setting new password.'), {
      code: 'current_password_invalid',
    })
    updateUserMock.mockResolvedValue({ data: null, error: err })
    await expect(auth.updatePassword('newpass1', 'wrong')).rejects.toMatchObject({
      code: 'current_password_invalid',
    })
  })
})

describe('auth.updatePasswordViaRecovery — emailed reset link', () => {
  it('sends only the new password, never a current one', async () => {
    await auth.updatePasswordViaRecovery('newpass1')
    expect(updateUserMock).toHaveBeenCalledTimes(1)
    expect(updateUserMock).toHaveBeenCalledWith({ password: 'newpass1' })
    expect(updateUserMock.mock.calls[0][0]).not.toHaveProperty('current_password')
  })

  it('ignores any extra argument rather than forwarding it', async () => {
    // Guards against a future caller "helpfully" threading a current password
    // through a flow that has no way to know one.
    await auth.updatePasswordViaRecovery('newpass1', 'oldpass1')
    expect(updateUserMock).toHaveBeenCalledWith({ password: 'newpass1' })
  })

  it('propagates errors', async () => {
    updateUserMock.mockResolvedValue({ data: null, error: new Error('nope') })
    await expect(auth.updatePasswordViaRecovery('newpass1')).rejects.toThrow('nope')
  })
})
