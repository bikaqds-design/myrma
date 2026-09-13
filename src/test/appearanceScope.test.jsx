/**
 * appearanceScope.test.jsx — appearance settings belong to the right owner.
 *
 * These all lived in one global row, so one user enabling dark mode enabled it
 * for everyone (UX-DARK-001). The properties worth pinning are the ones where
 * being wrong is invisible until someone else complains:
 *
 *  - a personal preference must never reach the company row. That is the
 *    original defect, and the subtle version of it is writing the *merged*
 *    settings object to the org row, which quietly publishes this person's
 *    theme as everyone's default;
 *  - a company setting must never be written to a personal row, or changing the
 *    favicon would only change it for the admin who did it;
 *  - resolution order is DEFAULT -> company -> personal, so an inherited house
 *    setting applies to everyone who has not chosen their own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, cleanup, act } from '@testing-library/react'
import React from 'react'

const state = {
  orgRow: { config_value: { dateFormat: 'DD/MM/YYYY', fontFamily: 'poppins', tabTitle: 'myCRM', darkMode: false } },
  personal: null,
  orgWrites: [],
  personalWrites: [],
  email: 'tech@test.com',
}

vi.mock('../api/supabaseClient', () => ({
  db: {
    rmaConfig: {
      getAll: () =>
        Promise.resolve({
          missing: false,
          data: state.orgRow ? [{ config_key: 'appearance_settings', ...state.orgRow }] : [],
        }),
      set: (key, value, actor) => {
        state.orgWrites.push({ key, value, actor })
        return Promise.resolve()
      },
    },
    userPreferences: {
      get: () => Promise.resolve({ missing: false, prefs: state.personal }),
      set: (email, prefs) => {
        state.personalWrites.push({ email, prefs })
        return Promise.resolve({ missing: false })
      },
    },
  },
}))

vi.mock('../api/client', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: { email: state.email } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}))

vi.mock('../lib/i18n.js', () => ({ default: { changeLanguage: () => {}, t: (k) => k } }))

// Controllable OS colour scheme.
const listeners = new Set()
beforeEach(() => {
  listeners.clear()
  state.osDark = false
  window.matchMedia = (q) => ({
    matches: q.includes('dark') ? state.osDark : false,
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
  })
})
const setOs = (dark) => {
  state.osDark = dark
  listeners.forEach((fn) => fn({ matches: dark }))
}
vi.mock('react-hot-toast', () => ({ default: Object.assign(() => {}, { error: () => {} }) }))
vi.mock('../lib/sentry', () => ({ captureException: vi.fn() }))

const { AppearanceProvider, useAppearance } = await import('../contexts/AppearanceContext')

function Probe({ onReady }) {
  const a = useAppearance()
  React.useEffect(() => { onReady(a) })
  return <div data-testid="dark">{String(a.darkMode)}</div>
}

let api
const mount = () =>
  render(
    <AppearanceProvider>
      <Probe onReady={(a) => { api = a }} />
    </AppearanceProvider>
  )

beforeEach(() => {
  state.orgWrites = []
  state.personalWrites = []
  state.personal = null
  state.orgRow = { config_value: { dateFormat: 'DD/MM/YYYY', fontFamily: 'poppins', tabTitle: 'myCRM', darkMode: false } }
})
afterEach(cleanup)

describe('resolving settings', () => {
  it('inherits the company setting when the person has none', async () => {
    mount()
    // Asserted together against one settled state (BUG-081): read after the
    // waitFor, the second value could still be the earlier one under a loaded run.
    await waitFor(() => {
      expect(api.fontFamily).toBe('poppins')
      expect(api.dateFormat).toBe('DD/MM/YYYY')
    })
  })

  it('lets a personal preference win over the company one', async () => {
    state.personal = { appearance: { darkMode: true, fontFamily: 'inter' } }
    mount()
    await waitFor(() => expect(api.darkMode).toBe(true))
    expect(api.fontFamily).toBe('inter')
    // Company keys still come from the org row.
    expect(api.tabTitle).toBe('myCRM')
  })

  it('ignores non-personal keys stored in a personal row', async () => {
    // A personal row must not be able to override company branding.
    state.personal = { appearance: { tabTitle: 'hijacked', darkMode: true } }
    mount()
    await waitFor(() => expect(api.darkMode).toBe(true))
    expect(api.tabTitle).toBe('myCRM')
  })
})

describe('writing settings', () => {
  it('sends a personal preference only to the personal row', async () => {
    mount()
    await waitFor(() => expect(api).toBeTruthy())
    await act(async () => { await api.updateAppearance({ darkMode: true }, 'tech@test.com') })

    expect(state.personalWrites).toHaveLength(1)
    expect(state.personalWrites[0].email).toBe('tech@test.com')
    expect(state.personalWrites[0].prefs.appearance.darkMode).toBe(true)
    // The company row must not be touched at all.
    expect(state.orgWrites).toHaveLength(0)
  })

  it('sends a company setting only to the company row', async () => {
    mount()
    await waitFor(() => expect(api).toBeTruthy())
    await act(async () => { await api.updateAppearance({ tabTitle: 'QDS' }, 'admin@test.com') })

    expect(state.orgWrites).toHaveLength(1)
    expect(state.orgWrites[0].value.tabTitle).toBe('QDS')
    expect(state.personalWrites).toHaveLength(0)
  })

  /**
   * The subtle version of the original bug. Writing the merged settings object
   * to the org row publishes whatever theme this person happens to be using as
   * the company default, without anyone asking for it.
   */
  it('never leaks a personal preference into the company row', async () => {
    state.personal = { appearance: { darkMode: true } }
    mount()
    await waitFor(() => expect(api.darkMode).toBe(true))
    await act(async () => { await api.updateAppearance({ tabTitle: 'QDS' }, 'admin@test.com') })

    expect(state.orgWrites).toHaveLength(1)
    const written = state.orgWrites[0].value
    expect(written.tabTitle).toBe('QDS')
    // darkMode in the org row must still be the company's value, not this user's.
    expect(written.darkMode).toBe(false)
  })

  it('splits a change that touches both kinds', async () => {
    mount()
    await waitFor(() => expect(api).toBeTruthy())
    await act(async () => {
      await api.updateAppearance({ darkMode: true, tabTitle: 'QDS' }, 'admin@test.com')
    })
    expect(state.personalWrites[0].prefs.appearance).toEqual({ darkMode: true })
    expect(state.orgWrites[0].value.tabTitle).toBe('QDS')
    expect(state.orgWrites[0].value.darkMode).toBe(false)
  })
})

describe('degrading safely', () => {
  it('falls back to company settings when there is no personal row', async () => {
    state.personal = null
    mount()
    // Asserted together against one settled state (BUG-081): read after the
    // waitFor, the second value could still be the earlier one under a loaded run.
    await waitFor(() => {
      expect(api.fontFamily).toBe('poppins')
      expect(api.darkMode).toBe(false)
    })
  })

  it('still resolves when the company row is absent', async () => {
    state.orgRow = null
    mount()
    // Falls all the way back to DEFAULT rather than rendering nothing.
    await waitFor(() => expect(api.fontFamily).toBe('inter'))
  })
})

describe('following the operating system', () => {
  /**
   * The point of UX-DARK-002. Someone who has never touched the toggle should
   * get whatever their machine is set to, not an admin's choice.
   */
  it('uses the OS theme when the person has expressed no preference', async () => {
    state.osDark = true
    state.personal = null
    mount()
    await waitFor(() => expect(api.darkMode).toBe(true))
  })

  it('stays light when the OS is light and nothing is set', async () => {
    state.osDark = false
    state.personal = null
    mount()
    // Asserted together against one settled state (BUG-081): read after the
    // waitFor, the second value could still be the earlier one under a loaded run.
    await waitFor(() => {
      expect(api.fontFamily).toBe('poppins')
      expect(api.darkMode).toBe(false)
    })
  })

  /**
   * An explicit choice must survive a contrary OS. Otherwise the toggle looks
   * broken to anyone whose machine disagrees with them.
   */
  it('respects an explicit choice over the OS', async () => {
    state.osDark = true
    state.personal = { appearance: { darkMode: false } }
    mount()
    // Asserted together against one settled state (BUG-081): read after the
    // waitFor, the second value could still be the earlier one under a loaded run.
    await waitFor(() => {
      expect(api.fontFamily).toBe('poppins')
      expect(api.darkMode).toBe(false)
    })
  })

  /**
   * The company row must never supply a theme — inheriting an admin's is the
   * defect UX-DARK-001 removed. Asserted from both sides, because a company
   * value of `true` with an OS of `false` is indistinguishable from the OS
   * simply winning unless the opposite case is checked too.
   */
  it('ignores darkMode in the company row when the OS says light', async () => {
    state.orgRow = { config_value: { darkMode: true, fontFamily: 'poppins' } }
    state.osDark = false
    state.personal = null
    mount()
    // Asserted together against one settled state (BUG-081): read after the
    // waitFor, the second value could still be the earlier one under a loaded run.
    await waitFor(() => {
      expect(api.fontFamily).toBe('poppins')
      expect(api.darkMode).toBe(false)
    })
  })

  it('ignores darkMode in the company row when the OS says dark', async () => {
    state.orgRow = { config_value: { darkMode: false, fontFamily: 'poppins' } }
    state.osDark = true
    state.personal = null
    mount()
    await waitFor(() => expect(api.darkMode).toBe(true))
  })

  it('follows the OS live while no preference is set', async () => {
    state.osDark = false
    state.personal = null
    mount()
    await waitFor(() => expect(api.darkMode).toBe(false))
    await act(async () => { setOs(true) })
    await waitFor(() => expect(api.darkMode).toBe(true))
  })

  it('stops following the OS once the person chooses', async () => {
    state.osDark = false
    state.personal = null
    mount()
    await waitFor(() => expect(api).toBeTruthy())
    await act(async () => { await api.updateAppearance({ darkMode: false }, 'tech@test.com') })
    // The OS flipping must no longer move them.
    await act(async () => { setOs(true) })
    expect(api.darkMode).toBe(false)
  })
})
