/**
 * accountingPeriods.test.jsx — month-end close (A-03, 20260910).
 *
 * Pins the shape of the migration (the behaviour is
 * supabase/tests/accounting_periods.sql, 50 checks on staging, rolled back),
 * the Periods tab's rules, and renders the tab: the assistant cannot sign in
 * to the app, so this is the screen check. i18n echoes the key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { readFileSync } from 'node:fs'
import { monthsToShow, periodActions, validateReopenReason } from '../pages/Accounting/_periods'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key), i18n: { language: 'en' } }),
}))
const toastError = vi.fn()
vi.mock('react-hot-toast', () => ({ default: { error: (...a) => toastError(...a), success: vi.fn() } }))

const sql = readFileSync('supabase/migrations/20260910_accounting_periods.sql', 'utf8')
const fn = (name) => {
  const at = sql.indexOf(`FUNCTION public.${name}(`)
  return sql.slice(at, sql.indexOf('END $fn$', at))
}

describe('20260910 — the migration', () => {
  it('guards every posting on journal_entries itself, before insert, and leaves a restore alone', () => {
    expect(sql).toMatch(/CREATE TRIGGER trg_journal_entries_period BEFORE INSERT ON public\.journal_entries/)
    const g = fn('rma_guard_journal_period')
    expect(g).toContain("current_setting('rma.audit_suspended', true) = 'on'")
    expect(g).toMatch(/IF v_status = 'closed' THEN\s+RAISE/)
    expect(g).toMatch(/v_status = 'soft_closed' AND NOT COALESCE\(public\.rma_is_finance\(\), false\)/)
    // a close waits for postings already under way
    expect(g).toContain("pg_advisory_xact_lock_shared(hashtext('rma.accounting_periods'))")
    expect(fn('_period_lock_month')).toContain("pg_advisory_xact_lock(hashtext('rma.accounting_periods'))")
  })

  it('finance = administrators and accountants, fail-closed', () => {
    expect(fn('rma_is_finance')).toContain("COALESCE(public.rma_is_admin() OR public.rma_user_role() = 'accountant', false)")
    for (const f of ['soft_close_accounting_period', 'close_accounting_period', 'reopen_soft_closed_period', 'request_period_reopen']) {
      expect(fn(f), f).toMatch(/IF NOT COALESCE\(public\.rma_is_finance\(\), false\) THEN/)
    }
  })

  it('a closed month reopens only with a second administrator, and back to soft closed', () => {
    const a = fn('approve_period_reopen')
    expect(a).toMatch(/IF NOT COALESCE\(public\.rma_is_admin\(\), false\) THEN/)
    expect(a).toMatch(/lower\(COALESCE\(v_me, ''\)\) = lower\(v_req\.requested_by\)/)
    expect(a).toMatch(/SET status = 'soft_closed', reopened_by = v_me/)
    expect(fn('reopen_soft_closed_period')).toMatch(/IF v_row\.status <> 'soft_closed' THEN/)
  })

  it('soft close first, then close; months in order', () => {
    expect(fn('close_accounting_period')).toMatch(/IF v_row\.status <> 'soft_closed' THEN/)
    expect(fn('soft_close_accounting_period')).toContain('months are closed in order')
  })

  it('the tables are procedure-only, audited, and backed up in manifest order', () => {
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public\.accounting_periods, public\.period_reopen_requests FROM authenticated;/)
    expect(sql).toContain('CREATE TRIGGER trg_audit_accounting_periods')
    expect(sql).toContain('CREATE TRIGGER trg_audit_period_reopen_requests')
    expect(sql).toContain("'journal_entries', 'journal_lines', 'accounting_periods', 'period_reopen_requests',")
    const backup = readFileSync('src/api/backup.js', 'utf8')
    expect(backup).toContain("'journal_lines', 'accounting_periods', 'period_reopen_requests'")
  })

  it('no new function is callable by anon; the internals by no client', () => {
    for (const sig of ['rma_is_finance()', 'rma_period_status(date)', 'soft_close_accounting_period(date)', 'close_accounting_period(date)',
      'reopen_soft_closed_period(date)', 'request_period_reopen(date, text)', 'approve_period_reopen(uuid, text)',
      'reject_period_reopen(uuid, text)', 'rma_period_close_checklist(date)']) {
      expect(sql, sig).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon`)
    }
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.rma_guard_journal_period() FROM PUBLIC, anon, authenticated;')
    expect(sql).toContain('REVOKE ALL ON FUNCTION public._period_lock_month(date) FROM PUBLIC, anon, authenticated;')
  })

  it('the screen goes through the period functions only', () => {
    const api = readFileSync('src/api/db/periods.ts', 'utf8')
    expect(api).not.toMatch(/from\('(accounting_periods|period_reopen_requests)'\)\s*\.(insert|update|upsert|delete)/)
    for (const rpc of ['soft_close_accounting_period', 'close_accounting_period', 'reopen_soft_closed_period',
      'request_period_reopen', 'approve_period_reopen', 'reject_period_reopen', 'rma_period_close_checklist']) {
      expect(api).toContain(`rpc('${rpc}'`)
    }
  })
})

describe('Periods tab rules', () => {
  const today = new Date(2026, 8, 27)

  it('shows the current month and the twelve before it, plus any older closed month, newest first', () => {
    const m = monthsToShow([{ period_start: '2024-12-01' }], today)
    expect(m[0]).toBe('2026-09-01')
    expect(m).toContain('2025-09-01')
    expect(m).not.toContain('2025-08-01')
    expect(m[m.length - 1]).toBe('2024-12-01')
    expect(m).toHaveLength(14)
  })

  it('offers each person only what the database allows', () => {
    const a = (o) => periodActions({ today, ...o })
    expect(a({ month: '2026-08-01', status: 'open', role: 'accountant' })).toEqual(['soft_close'])
    expect(a({ month: '2026-09-01', status: 'open', role: 'accountant' })).toEqual([])  // not ended
    expect(a({ month: '2026-08-01', status: 'open', role: 'manager' })).toEqual([])
    expect(a({ month: '2026-08-01', status: 'soft_closed', role: 'admin' })).toEqual(['close', 'reopen'])
    expect(a({ month: '2026-08-01', status: 'closed', role: 'accountant' })).toEqual(['request_reopen'])
    const pending = { id: 'R1', requested_by: 'Ann@x.com' }
    expect(a({ month: '2026-08-01', status: 'closed', role: 'admin', me: 'bob@x.com', pending })).toEqual(['approve', 'reject'])
    expect(a({ month: '2026-08-01', status: 'closed', role: 'admin', me: 'ann@x.com', pending })).toEqual(['withdraw', 'waiting'])
    expect(a({ month: '2026-08-01', status: 'closed', role: 'accountant', me: 'ann@x.com', pending })).toEqual(['withdraw', 'waiting'])
    expect(a({ month: '2026-08-01', status: 'closed', role: 'accountant', me: 'cy@x.com', pending })).toEqual(['waiting'])
  })

  it('a reopen reason needs ten characters', () => {
    expect(validateReopenReason('  long enough ')).toBe(null)
    expect(validateReopenReason('short')).toBe('accounting.pcReasonTooShort')
  })
})

// ── the tab, rendered ─────────────────────────────────────────────────────────
let PERIODS = []
let REQUESTS = []
const api = {
  list: vi.fn(() => Promise.resolve(PERIODS)),
  pendingRequests: vi.fn(() => Promise.resolve(REQUESTS)),
  softClose: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  reopenSoftClosed: vi.fn(() => Promise.resolve()),
  requestReopen: vi.fn(() => Promise.resolve('R9')),
  approveReopen: vi.fn(() => Promise.resolve()),
  rejectReopen: vi.fn(() => Promise.resolve()),
  checklist: vi.fn(() => Promise.resolve([
    { item: 'draft_sales_invoices', item_count: 2, amount: 300 },
    { item: 'grni_balance', item_count: 1, amount: 40 },
    { item: 'bank_reconciliation', item_count: null, amount: null },
  ])),
}
vi.mock('../api/supabaseClient', () => ({ db: { periods: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }) } }))
const { default: PeriodsTab } = await import('../pages/Accounting/PeriodsTab.jsx')

const renderTab = (role, email = 'me@x.com') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <PeriodsTab currentUserRole={role} currentUserEmail={email} />
  </QueryClientProvider>
)
const row = async (label) => (await screen.findByText(label)).closest('tr')

describe('Periods tab', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 27, 12))
    PERIODS = []
    REQUESTS = []
    Object.values(api).forEach((f) => f.mockClear())
    toastError.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('an accountant soft closes August after the dialog', async () => {
    renderTab('accountant')
    const aug = await row('August 2026')
    fireEvent.click(within(aug).getByRole('button', { name: 'accounting.pcSoftClose' }))
    expect(api.softClose).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'accounting.pcSoftClose' }))
    await waitFor(() => expect(api.softClose).toHaveBeenCalledWith('2026-08-01'))
    // the current month has not ended: nothing to offer
    expect(within(await row('September 2026')).queryByRole('button', { name: 'accounting.pcSoftClose' })).toBeNull()
  })

  it('shows the database refusal as it is', async () => {
    api.softClose.mockRejectedValueOnce(new Error('Close July 2026 first: months are closed in order.'))
    renderTab('admin')
    fireEvent.click(within(await row('August 2026')).getByRole('button', { name: 'accounting.pcSoftClose' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'accounting.pcSoftClose' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Close July 2026 first: months are closed in order.', expect.anything()))
  })

  it('a manager sees the status and the checklist, and no close actions', async () => {
    PERIODS = [{ period_start: '2026-08-01', status: 'closed', closed_by: 'acct@x.com' }]
    renderTab('manager')
    const aug = await row('August 2026')
    expect(await within(aug).findByText('accounting.pcStatus_closed')).toBeTruthy()
    expect(within(aug).getByText('acct@x.com')).toBeTruthy()
    expect(within(aug).getAllByRole('button').map((b) => b.textContent)).toEqual(['August 2026', 'accounting.pcChecklist'])
  })

  it('asking to reopen needs a reason of ten characters', async () => {
    PERIODS = [{ period_start: '2026-08-01', status: 'closed' }]
    renderTab('accountant')
    fireEvent.click(await within(await row('August 2026')).findByRole('button', { name: 'accounting.pcRequestReopen' }))
    const box = await screen.findByLabelText(/accounting\.pcReason/)
    fireEvent.change(box, { target: { value: 'oops' } })
    const modal = box.closest('[aria-label]')
    fireEvent.click(within(modal).getByRole('button', { name: 'accounting.pcRequestReopen' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(api.requestReopen).not.toHaveBeenCalled()
    fireEvent.change(box, { target: { value: 'Supplier bill INV-77 was dated August' } })
    fireEvent.click(within(modal).getByRole('button', { name: 'accounting.pcRequestReopen' }))
    await waitFor(() => expect(api.requestReopen).toHaveBeenCalledWith('2026-08-01', 'Supplier bill INV-77 was dated August'))
  })

  it('another administrator approves; the one who asked can only withdraw', async () => {
    PERIODS = [{ period_start: '2026-08-01', status: 'closed' }]
    REQUESTS = [{ id: 'R1', period_start: '2026-08-01', reason: 'Supplier bill INV-77', requested_by: 'ann@x.com', status: 'pending' }]
    renderTab('admin', 'ann@x.com')
    let aug = await row('August 2026')
    await within(aug).findByRole('button', { name: 'accounting.pcWithdraw' })
    expect(within(aug).queryByRole('button', { name: 'accounting.pcApprove' })).toBeNull()
    expect(within(aug).getByText('accounting.pcWaiting')).toBeTruthy()
    cleanup()

    renderTab('admin', 'bob@x.com')
    aug = await row('August 2026')
    fireEvent.click(await within(aug).findByRole('button', { name: 'accounting.pcApprove' }))
    fireEvent.change(await screen.findByLabelText('accounting.pcNote'), { target: { value: 'OK' } })
    const modal = screen.getByLabelText('accounting.pcNote').closest('[aria-label]')
    fireEvent.click(within(modal).getByRole('button', { name: 'accounting.pcApprove' }))
    await waitFor(() => expect(api.approveReopen).toHaveBeenCalledWith('R1', 'OK'))
  })

  it('the checklist lists the month’s open items; bank reconciliation is not available yet', async () => {
    renderTab('accountant')
    fireEvent.click(within(await row('August 2026')).getByRole('button', { name: 'accounting.pcChecklist' }))
    expect(await screen.findByText('accounting.pcItem_draft_sales_invoices')).toBeTruthy()
    expect(screen.getByText('2 · 300.00')).toBeTruthy()
    expect(screen.getByText('accounting.pcNotAvailable')).toBeTruthy()
    expect(api.checklist).toHaveBeenCalledWith('2026-08-01')
  })
})
