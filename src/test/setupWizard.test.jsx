/**
 * setupWizard.test.jsx — B-03c: the first-run setup wizard (20260922).
 * Owner decisions 2026-10-01: shown at first login, every System Setup
 * preference included, company / country and currency / chart required, the
 * rest optional. Browser-checked on staging; these pin the rules and the
 * page's behaviour.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import React from 'react'
import { readFileSync } from 'node:fs'
import { STEPS, missingRequired, readState, shouldOpenWizard, stepDone, suggestedCurrency, writeState } from '../pages/SetupWizard/_steps'

describe('setup wizard rules', () => {
  it('a missing or odd row reads as a wizard still to do', () => {
    expect(readState(null)).toEqual({ status: 'in_progress', stepsDone: [], chartConfirmed: false, finishedAt: null, finishedBy: null })
    expect(readState({ status: 'weird', steps_done: ['users', 7] }).stepsDone).toEqual(['users'])
    expect(writeState(readState(null), { stepsDone: ['users', 'users'], status: 'skipped' }))
      .toEqual({ status: 'skipped', steps_done: ['users'], chart_confirmed: false })
  })

  it('the three core steps are judged from what is saved', () => {
    const state = readState(null)
    expect(missingRequired({ config: {}, state })).toEqual(['company', 'country', 'chart'])
    const config = { legal_name: 'ACME', default_country: 'EG', default_currency: 'EGP' }
    // a new database may carry a default country and currency: the step must be confirmed
    expect(stepDone('country', { config, state })).toBe(false)
    const confirmed = readState({ steps_done: ['country'], chart_confirmed: true })
    expect(missingRequired({ config, state: confirmed })).toEqual([])
    expect(stepDone('chart', { config: { chart_template: 'EG' }, state })).toBe(true)
    expect(stepDone('company', { config: { legal_name: '   ' }, state })).toBe(false)
  })

  it('optional steps are done only when marked', () => {
    const ctx = { config: {}, state: readState({ steps_done: ['users'] }) }
    expect(stepDone('users', ctx)).toBe(true)
    expect(stepDone('opening', ctx)).toBe(false)
    expect(STEPS.filter((s) => s.required).map((s) => s.id)).toEqual(['company', 'country', 'chart'])
  })

  it('opens only for an administrator, once the state is known, while in progress', () => {
    expect(shouldOpenWizard({ isAdmin: true, loaded: true, value: null })).toBe(true)
    expect(shouldOpenWizard({ isAdmin: true, loaded: false, value: null })).toBe(false)
    expect(shouldOpenWizard({ isAdmin: false, loaded: true, value: null })).toBe(false)
    expect(shouldOpenWizard({ isAdmin: true, loaded: true, value: { status: 'skipped' } })).toBe(false)
    expect(shouldOpenWizard({ isAdmin: true, loaded: true, value: { status: 'finished' } })).toBe(false)
  })

  it('suggests the country\'s own currency', () => {
    expect(suggestedCurrency([{ code: 'AE', currency_code: 'AED' }], 'AE')).toBe('AED')
    expect(suggestedCurrency([], 'AE')).toBeNull()
  })
})

describe('wiring', () => {
  it('an existing database is never sent to the wizard', () => {
    const sql = readFileSync('supabase/migrations/20260922_setup_wizard.sql', 'utf8').replace(/\r\n/g, '\n')
    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM public.rma_config WHERE config_key = 'setup_wizard')")
    expect(sql).toContain('OR EXISTS (SELECT 1 FROM public.crm_invoices)')
  })
  it('the app opens it for the real administrator only, and guards the route', () => {
    const app = readFileSync('src/App.jsx', 'utf8')
    expect(app).toContain("if (shouldOpenWizard({ isAdmin: isRealAdmin && !previewUser, loaded: setupWizardLoaded, value: setupWizardValue })) {")
    expect(app).toContain('path="/setup"')
    expect(app).toContain('isRealAdmin && !previewUser ? (')
  })
  it('System Setup offers the way back in', () => {
    expect(readFileSync('src/pages/cp/SystemSetup.jsx', 'utf8')).toContain("navigate('/setup')")
  })
  it('every string is in both languages', () => {
    const page = readFileSync('src/pages/SetupWizard/index.jsx', 'utf8')
    const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8')).setupWizard
    const ar = JSON.parse(readFileSync('src/locales/ar.json', 'utf8')).setupWizard
    const keys = new Set([...page.matchAll(/setupWizard\.(\w+)/g)].map((m) => m[1]).filter((k) => !k.endsWith('_')))
    for (const s of STEPS) { keys.add(`step_${s.id}`); keys.add(`intro_${s.id}`) }
    keys.add('open')
    for (const k of keys) {
      expect(en[k], k).toBeTruthy()
      expect(ar[k], k).toBeTruthy()
    }
  })
})

// ── render ───────────────────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key), i18n: { language: 'en' } }),
}))
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))
// the hosted panels are tested where they live
vi.mock('../pages/cp/setup/BusinessIdentity', () => ({ default: () => <div>BusinessIdentity</div> }))
vi.mock('../pages/cp/setup/RegionalSettings', () => ({ default: () => <div>RegionalSettings</div> }))
vi.mock('../pages/cp/setup/DocumentNumbering', () => ({ default: () => <div>DocumentNumbering</div> }))
vi.mock('../pages/cp/setup/AiSettings', () => ({ default: () => <div>AiSettings</div> }))
vi.mock('../pages/cp/ChartOfAccounts', () => ({ default: () => <div>ChartOfAccounts</div> }))
vi.mock('../pages/cp/CurrencySettings', () => ({ default: () => <div>CurrencySettings</div> }))
vi.mock('../pages/BrandingSettings', () => ({ default: () => <div>BrandingSettings</div> }))
vi.mock('../pages/UserManagement', () => ({ default: () => <div>UserManagement</div> }))
vi.mock('../pages/Accounting/OpeningBalancesTab', () => ({ default: () => <div>OpeningBalancesTab</div> }))

const navigate = vi.fn()
vi.mock('react-router-dom', async (orig) => ({ ...(await orig()), useNavigate: () => navigate }))

let config = []
const calls = []
const rmaConfig = {
  getAll: vi.fn(() => Promise.resolve({ missing: false, data: config })),
  set: vi.fn((key, value) => {
    calls.push([key, value])
    if (key === 'default_currency' && value === 'AED') return Promise.reject(new Error('The base currency cannot be changed'))
    config = config.filter((r) => r.config_key !== key).concat({ config_key: key, config_value: value })
    return Promise.resolve({})
  }),
}
vi.mock('../api/supabaseClient', () => ({
  db: {
    rmaConfig: new Proxy({}, { get: (_, k) => (...a) => rmaConfig[k](...a) }),
    geo: { listCountries: () => Promise.resolve({ data: [{ code: 'EG', name: 'Egypt', currency_code: 'EGP' }, { code: 'AE', name: 'UAE', currency_code: 'AED' }] }) },
    currencies: { listActive: () => Promise.resolve([{ code: 'EGP', name: 'Pound' }, { code: 'AED', name: 'Dirham' }]) },
  },
}))
const { default: SetupWizard } = await import('../pages/SetupWizard/index.jsx')

const wrap = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><SetupWizard currentUserRole="admin" currentUserEmail="admin@test.local" /></MemoryRouter>
  </QueryClientProvider>,
)
const step = (name) => fireEvent.click(screen.getByText(`setupWizard.step_${name}`, { selector: 'span' }))

describe('Setup wizard page', () => {
  beforeEach(() => {
    config = [{ config_key: 'default_country', config_value: 'EG' }, { config_key: 'default_currency', config_value: 'EGP' }]
    calls.length = 0
    navigate.mockClear()
  })
  afterEach(cleanup)

  it('cannot be finished until the core is done, and names what is missing', async () => {
    wrap()
    await screen.findByText('setupWizard.welcomeBody')
    step('finish')
    expect(screen.getByText('setupWizard.finish').closest('button').disabled).toBe(true)
    expect(screen.getByText(/setupWizard\.missingRequired/).textContent).toContain('step_company')
  })

  it('keeping the default chart and marking a step done are saved', async () => {
    wrap()
    await screen.findByText('setupWizard.welcomeBody')
    step('chart')
    fireEvent.click(screen.getByText('setupWizard.keepDefaultChart'))
    await waitFor(() => expect(calls.at(-1)).toEqual(['setup_wizard', { status: 'in_progress', steps_done: [], chart_confirmed: true }]))
    step('users')
    fireEvent.click(await screen.findByText('setupWizard.markDone'))
    await waitFor(() => expect(calls.at(-1)[1].steps_done).toEqual(['users']))
  })

  it('a refused base currency leaves the country alone', async () => {
    wrap()
    await screen.findByText('setupWizard.welcomeBody')
    step('country')
    const country = await screen.findByLabelText(/setupWizard\.country/)
    fireEvent.change(country, { target: { value: 'AE' } })
    expect(screen.getByLabelText(/setupWizard\.baseCurrency/).value).toBe('AED')
    fireEvent.click(screen.getByText('setupWizard.saveCountry'))
    await waitFor(() => expect(calls).toEqual([['default_currency', 'AED']]))
    expect(config.find((r) => r.config_key === 'default_country').config_value).toBe('EG')
  })

  it('finishes once the core is done, and skipping can be chosen any time', async () => {
    config.push({ config_key: 'legal_name', config_value: 'ACME' },
      { config_key: 'setup_wizard', config_value: { status: 'in_progress', steps_done: ['country'], chart_confirmed: true } })
    wrap()
    await screen.findByText('setupWizard.welcomeBody')
    step('finish')
    fireEvent.click(screen.getByText('setupWizard.finish'))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'))
    expect(calls.at(-1)[1]).toMatchObject({ status: 'finished', finished_by: 'admin@test.local' })
  })

  it('skip for now records it and leaves', async () => {
    wrap()
    fireEvent.click(await screen.findByText('setupWizard.skipForNow'))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'))
    expect(calls.at(-1)).toEqual(['setup_wizard', { status: 'skipped', steps_done: [], chart_confirmed: false }])
  })
})
