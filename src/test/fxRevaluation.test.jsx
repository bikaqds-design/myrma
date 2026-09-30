/**
 * fxRevaluation.test.jsx — A-08c (20260918): month-end revaluation of
 * foreign balances. supabase/tests/fx_revaluation.sql (24 checks, rolled back)
 * is the database half; this pins the helpers, the wiring and the screen.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import React from 'react'
import { readFileSync } from 'node:fs'
import { lastEndedMonth, monthHasEnded, revaluationSummary } from '../pages/Accounting/_reports'
import { resolvePermissions } from '../lib/permissions'

const read = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
const SQL = read('supabase/migrations/20260918_fx_revaluation.sql')

const ITEMS = [
  { side: 'receivable', doc_type: 'invoice', doc_id: 'i1', doc_code: 'INV-2026-00007', party_name: 'Acme', currency: 'USD',
    open_amount: 100, doc_rate: 50, carried_base: 5000, rate: 52, revalued_base: 5200, effect: 200 },
  { side: 'receivable', doc_type: 'payment', doc_id: 'p1', doc_code: 'PAY-2026-00003', party_name: 'Acme', currency: 'USD',
    open_amount: -30, doc_rate: 51, carried_base: -1530, rate: 52, revalued_base: -1560, effect: -30 },
  { side: 'payable', doc_type: 'vendor_invoice', doc_id: 'v1', doc_code: 'VI-2026-00002', party_name: 'Supplier', currency: 'USD',
    open_amount: 40, doc_rate: 50, carried_base: 2000, rate: 52, revalued_base: 2080, effect: -80 },
]

describe('helpers', () => {
  it('the default month is the last one that has ended', () => {
    expect(lastEndedMonth(new Date(2026, 8, 30))).toBe('2026-08-01')
    expect(lastEndedMonth(new Date(2026, 0, 5))).toBe('2025-12-01')
    expect(monthHasEnded('2026-08-01', new Date(2026, 8, 30))).toBe(true)
    expect(monthHasEnded('2026-09-01', new Date(2026, 8, 30))).toBe(false)
    expect(monthHasEnded('garbage', new Date(2026, 8, 30))).toBe(false)
  })

  it('totals gains, losses and each side in cents, and names currencies with no rate', () => {
    expect(revaluationSummary(ITEMS)).toEqual({ gain: 200, loss: 110, net: 90, receivable: 170, payable: -80, missingCurrencies: [] })
    const noRate = [...ITEMS, { side: 'payable', currency: 'SAR', rate: null, effect: null }]
    expect(revaluationSummary(noRate).missingCurrencies).toEqual(['SAR'])
  })
})

describe('the migration', () => {
  it('books to separate unrealised accounts and reverses on the 1st (owner decisions)', () => {
    expect(SQL).toContain("jsonb_build_object('role', 'fx_unrealised_gain', 'credit', v_gain)")
    expect(SQL).toContain("jsonb_build_object('role', 'fx_unrealised_loss', 'debit', v_loss)")
    expect(SQL).toContain("public._gl_reverse('fx_revaluation', v_id, 'revalue', 'reverse', v_end + 1,")
    expect(SQL).toContain("md5('gl_account:4915')::uuid, '4915'")
    expect(SQL).toContain("md5('gl_account:6525')::uuid, '6525'")
  })

  it('is finance-only with the close permission, once a month, after it ends, and never with a missing rate', () => {
    expect(SQL).toContain("PERFORM public.rma_require_permission('accounting', 'close_period');")
    expect(SQL).toContain('IF NOT COALESCE(public.rma_is_finance(), false) THEN')
    expect(SQL).toContain('has already been revalued')
    expect(SQL).toContain('IF v_end >= public.rma_today() THEN')
    expect(SQL).toContain("RAISE EXCEPTION 'Enter an exchange rate on or before % for: %.'")
    expect(SQL).toContain("SET functions = array_append(functions, 'run_fx_revaluation')")
  })

  it('the checklist only warns, and the record is backed up', () => {
    expect(SQL).toContain("''fx_not_revalued''::text")
    expect(SQL).toContain("'fx_revaluations', 'fx_revaluation_lines',")
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public._rma_fx_open_items(date) FROM PUBLIC, anon, authenticated;')
  })

  it('the API calls the preview and the run', () => {
    const api = read('src/api/db/fxRevaluation.ts')
    expect(api).toContain("supabase.rpc('rma_fx_revaluation_preview', { p_month: month })")
    expect(api).toContain("supabase.rpc('run_fx_revaluation', { p_month: month })")
  })

  it('every string exists in both languages', () => {
    const en = JSON.parse(read('src/locales/en.json')).accounting
    const ar = JSON.parse(read('src/locales/ar.json')).accounting
    const keys = new Set(['tabRevaluation', 'pcItem_fx_not_revalued', 'glRole_fx_unrealised_gain', 'glRole_fx_unrealised_loss'])
    for (const m of read('src/pages/Accounting/FxRevaluationTab.jsx').matchAll(/'accounting\.(fxr\w+)'/g)) keys.add(m[1])
    for (const k of keys) {
      expect(en[k], `en ${k}`).toBeTruthy()
      expect(ar[k], `ar ${k}`).toBeTruthy()
    }
  })
})

// ── rendered ──────────────────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, vars) => (vars && !('defaultValue' in vars) ? `${key}:${JSON.stringify(vars)}` : key), i18n: { language: 'en' } }),
}))
vi.mock('../hooks/useBaseCurrency', () => ({ useBaseCurrency: () => 'EGP' }))
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }))
let previewRows = ITEMS
let runRows = []
const api = {
  preview: vi.fn(() => Promise.resolve(previewRows)),
  run: vi.fn(() => Promise.resolve('run1')),
  runsPage: vi.fn(() => Promise.resolve({ data: runRows, count: runRows.length })),
  lines: vi.fn(() => Promise.resolve(ITEMS)),
}
vi.mock('../api/supabaseClient', () => ({ db: { fxRevaluation: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }) } }))
const { default: FxRevaluationTab } = await import('../pages/Accounting/FxRevaluationTab.jsx')

const wrap = (role) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>
      <FxRevaluationTab currentUserRole={role} currentUserPermissions={resolvePermissions(role, null)} />
    </MemoryRouter>
  </QueryClientProvider>,
)

describe('Accounting › Revaluation', () => {
  beforeEach(() => {
    previewRows = ITEMS
    runRows = []
    Object.values(api).forEach((f) => f.mockClear())
  })
  afterEach(cleanup)

  it('previews last month: each item, its rates and effect, and the totals', async () => {
    wrap('accountant')
    expect(await screen.findByRole('link', { name: 'INV-2026-00007' })).toBeTruthy()
    expect(api.preview.mock.calls[0][0]).toMatch(/^\d{4}-\d{2}-01$/)
    expect(screen.getAllByText('200.00')).toHaveLength(2) // the invoice's gain, and the total
    expect(screen.getByText('-80.00')).toBeTruthy()
    expect(screen.getByText('110.00')).toBeTruthy() // the loss
  })

  it('an accountant runs it after confirming', async () => {
    wrap('accountant')
    await screen.findByRole('link', { name: 'INV-2026-00007' }) // the button waits for the preview
    fireEvent.click(screen.getByRole('button', { name: 'accounting.fxrRun' }))
    expect(api.run).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'accounting.fxrRun' }))
    await waitFor(() => expect(api.run).toHaveBeenCalledWith(api.preview.mock.calls[0][0]))
  })

  it('a currency with no month-end rate is named and the run is held back', async () => {
    previewRows = [...ITEMS, { side: 'payable', doc_type: 'vendor_invoice', doc_id: 'v2', doc_code: 'VI-2026-00009', currency: 'SAR',
      open_amount: 10, doc_rate: 13, carried_base: 130, rate: null, revalued_base: null, effect: null }]
    wrap('accountant')
    expect(await screen.findByText('accounting.fxrMissingRates:{"currencies":"SAR"}')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'accounting.fxrRun' }).disabled).toBe(true)
  })

  it('a manager sees the preview but cannot run it', async () => {
    wrap('manager')
    await screen.findByRole('link', { name: 'INV-2026-00007' })
    expect(screen.queryByRole('button', { name: 'accounting.fxrRun' })).toBeNull()
  })

  it('a month already revalued says so and lists its items from the history', async () => {
    runRows = [{ id: 'run1', period_start: '2026-08-01', revalued_on: '2026-08-31', item_count: 3, total_gain: 200, total_loss: 110, created_by: 'acc@x' }]
    wrap('accountant')
    fireEvent.click(await screen.findByRole('button', { name: 'accounting.fxrShowLines' }))
    await waitFor(() => expect(api.lines).toHaveBeenCalledWith('run1'))
    expect(await screen.findAllByRole('link', { name: 'INV-2026-00007' })).toBeTruthy()
  })
})
