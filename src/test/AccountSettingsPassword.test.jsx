/**
 * AccountSettingsPassword.test.jsx — the signed-in change-password form.
 *
 * This form is the reason the Supabase project setting "Require current password
 * when updating" has to stay off: it used to call updateUser({ password }) with
 * nothing else, which that setting rejects outright. These tests cover the half
 * of the fix that lives in the UI, and assert the properties that would let the
 * setting be turned back on without stranding anyone:
 *
 *  - the current password is actually collected, and actually reaches the API
 *    call (a field that renders but is dropped on submit would look correct and
 *    still fail server-side);
 *  - it is required before the form can be submitted at all;
 *  - GoTrue's `current_password_invalid` response is re-worded, because its own
 *    message for a *wrong* password is the same "Current password required when
 *    setting new password." it sends for a *missing* one — shown verbatim, that
 *    reads as a broken form to someone who just typed their password in.
 *
 * i18n is stubbed to echo the key, so an assertion names the exact message and a
 * wrong branch cannot hide behind plausible English.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  }),
}))

const updatePassword = vi.fn()
const auditLog = vi.fn(() => Promise.resolve())

vi.mock('../api/supabaseClient', () => ({
  auth: {
    updatePassword: (...args) => updatePassword(...args),
    mfa: { listFactors: () => Promise.resolve({ data: { all: [] } }) },
    sessions: {
      list: () => Promise.resolve({ sessions: [], currentSessionId: null, activity: [] }),
    },
  },
  db: {
    auditLog: { log: (...args) => auditLog(...args) },
    userPreferences: { set: () => Promise.resolve() },
    userActivity: { list: () => Promise.resolve([]) },
  },
  storage: { uploadAvatar: () => Promise.resolve('') },
  notifications: {
    getPreferences: () => Promise.resolve({}),
    updatePreferences: () => Promise.resolve(),
  },
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('react-hot-toast', () => ({
  default: { error: (...a) => toastError(...a), success: (...a) => toastSuccess(...a) },
}))

vi.mock('../lib/sentry', () => ({ captureException: vi.fn() }))

vi.mock('../lib/safeStorage', () => ({
  safeStorage: { get: (_k, fallback) => fallback, set: () => {} },
}))

vi.mock('../contexts/AppearanceContext', () => ({
  useAppearance: () => ({
    darkMode: false,
    fontFamily: 'sans',
    tableDensity: 'normal',
    dateFormat: 'YYYY-MM-DD',
    updateAppearance: () => {},
    language: 'en',
    setLanguage: () => {},
  }),
}))

const AccountSettings = (await import('../pages/AccountSettings')).default

const CURRENT = 'input[autocomplete="current-password"]'
const NEW = 'input[autocomplete="new-password"]'

function renderSecurityTab() {
  const utils = render(
    <MemoryRouter initialEntries={['/account?tab=Security']}>
      <AccountSettings
        currentUser={{ id: 'u1', email: 'tech@example.com' }}
        currentUserRole="technician"
        currentUserPermissions={null}
        onProfileUpdate={() => {}}
      />
    </MemoryRouter>
  )
  const currentInput = () => utils.container.querySelector(CURRENT)
  const newInputs = () => utils.container.querySelectorAll(NEW)
  const saveButton = () =>
    [...utils.container.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'accountSettings.changePassword'
    )
  return { ...utils, currentInput, newInputs, saveButton }
}

/** Fill all three fields. */
function fillForm(ui, { current = 'old-pass-1', next = 'New-pass-1', confirm = 'New-pass-1' } = {}) {
  fireEvent.change(ui.currentInput(), { target: { value: current } })
  fireEvent.change(ui.newInputs()[0], { target: { value: next } })
  fireEvent.change(ui.newInputs()[1], { target: { value: confirm } })
}

beforeEach(() => {
  updatePassword.mockReset()
  updatePassword.mockResolvedValue(undefined)
  auditLog.mockClear()
  toastError.mockClear()
  toastSuccess.mockClear()
})

afterEach(cleanup)

describe('change-password form — current password field', () => {
  it('renders a current-password field alongside the two new-password fields', () => {
    const ui = renderSecurityTab()
    expect(screen.getByText('accountSettings.currentPassword')).toBeInTheDocument()
    expect(ui.currentInput()).toBeTruthy()
    // New + confirm, so password managers offer to save rather than autofill.
    expect(ui.newInputs()).toHaveLength(2)
  })

  it('masks the current password by default', () => {
    const ui = renderSecurityTab()
    expect(ui.currentInput().getAttribute('type')).toBe('password')
  })

  it('keeps submit disabled until the current password is supplied', () => {
    const ui = renderSecurityTab()
    fireEvent.change(ui.newInputs()[0], { target: { value: 'New-pass-1' } })
    fireEvent.change(ui.newInputs()[1], { target: { value: 'New-pass-1' } })
    expect(ui.saveButton()).toBeDisabled()

    fireEvent.change(ui.currentInput(), { target: { value: 'old-pass-1' } })
    expect(ui.saveButton()).not.toBeDisabled()
  })
})

describe('change-password form — submit', () => {
  it('passes the typed current password through to the API', async () => {
    const ui = renderSecurityTab()
    fillForm(ui, { current: 'old-pass-1', next: 'New-pass-1', confirm: 'New-pass-1' })
    fireEvent.click(ui.saveButton())

    await waitFor(() => expect(updatePassword).toHaveBeenCalledTimes(1))
    expect(updatePassword).toHaveBeenCalledWith('New-pass-1', 'old-pass-1')
  })

  it('clears all three fields after a successful change', async () => {
    const ui = renderSecurityTab()
    fillForm(ui)
    fireEvent.click(ui.saveButton())

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    expect(ui.currentInput().value).toBe('')
    expect(ui.newInputs()[0].value).toBe('')
    expect(ui.newInputs()[1].value).toBe('')
  })

  it('rejects reusing the current password without calling the API', async () => {
    const ui = renderSecurityTab()
    fillForm(ui, { current: 'Same-pass-1', next: 'Same-pass-1', confirm: 'Same-pass-1' })
    fireEvent.click(ui.saveButton())

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(updatePassword).not.toHaveBeenCalled()
    expect(toastError.mock.calls[0][0]).toMatch(/different from your current password/i)
  })
})

describe('change-password form — GoTrue error mapping', () => {
  it('re-words a wrong current password instead of echoing GoTrue', async () => {
    updatePassword.mockRejectedValue(
      Object.assign(new Error('Current password required when setting new password.'), {
        code: 'current_password_invalid',
      })
    )
    const ui = renderSecurityTab()
    fillForm(ui)
    fireEvent.click(ui.saveButton())

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError).toHaveBeenCalledWith('accountSettings.currentPasswordInvalid')
  })

  it('maps a missing current password to its own message', async () => {
    updatePassword.mockRejectedValue(
      Object.assign(new Error('Current password required when setting new password.'), {
        code: 'current_password_required',
      })
    )
    const ui = renderSecurityTab()
    fillForm(ui)
    fireEvent.click(ui.saveButton())

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError).toHaveBeenCalledWith('accountSettings.currentPasswordRequired')
  })

  it('falls back to the server message for unrelated failures', async () => {
    updatePassword.mockRejectedValue(
      Object.assign(new Error('network down'), { code: 'unexpected_failure' })
    )
    const ui = renderSecurityTab()
    fillForm(ui)
    fireEvent.click(ui.saveButton())

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError).toHaveBeenCalledWith('network down')
  })
})
