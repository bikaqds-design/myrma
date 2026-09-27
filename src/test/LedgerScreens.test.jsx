/**
 * LedgerScreens.test.jsx — the ledger screens, rendered (A-01c).
 *
 * The assistant cannot sign in to the app, so this is the screen check: the
 * journal lists entries, opens one to its lines and links an invoice's entry to
 * the invoice; the trial balance totals and says the books balance; the chart
 * of accounts adds an account, refuses a bad one before the round trip, points
 * a posting rule at another account and shows the database's refusal as it is;
 * a country template is applied only after the dialog, and a CSV import sends
 * the parsed rows and lists the ones the database refused (A-02).
 * i18n echoes the key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key), i18n: { language: 'en' } }),
}))
const toastError = vi.fn()
vi.mock('react-hot-toast', () => ({ default: { error: (...a) => toastError(...a), success: vi.fn() } }))

const ENTRY = {
  id: 'E1', entry_no: 'JE-2026-00001', entry_date: '2026-09-27', source_type: 'crm_invoice', source_id: 'INV1',
  source_code: 'INV-2026-00007', event: 'posted', memo: 'Invoice INV-2026-00007', reverses_entry_id: null,
  journal_lines: [
    { id: 'L1', line_no: 0, account_id: 'A1', debit: 115, credit: 0, account: { code: '1200', name: 'Accounts receivable', name_ar: null } },
    { id: 'L2', line_no: 1, account_id: 'A2', debit: 0, credit: 100, account: { code: '4100', name: 'Sales revenue', name_ar: null } },
    { id: 'L3', line_no: 2, account_id: 'A3', debit: 0, credit: 15, account: { code: '2200', name: 'VAT payable', name_ar: null } },
  ],
}
const ACCOUNTS = [
  { id: 'H1', code: '1000', name: 'Assets', name_ar: null, account_type: 'asset', parent_id: null, is_postable: false, is_active: true },
  { id: 'A1', code: '1200', name: 'Accounts receivable', name_ar: null, account_type: 'asset', parent_id: 'H1', is_postable: true, is_active: true },
  { id: 'A4', code: '1110', name: 'Bank', name_ar: null, account_type: 'asset', parent_id: 'H1', is_postable: true, is_active: true },
]
const api = {
  journalPage: vi.fn(() => Promise.resolve({ data: [ENTRY], count: 1 })),
  trialBalance: vi.fn(() => Promise.resolve([
    { account_id: 'A1', code: '1200', name: 'Accounts receivable', name_ar: null, account_type: 'asset', debit: 115, credit: 0, balance: 115 },
    { account_id: 'A2', code: '4100', name: 'Sales revenue', name_ar: null, account_type: 'income', debit: 0, credit: 115, balance: 115 },
  ])),
  accounts: vi.fn(() => Promise.resolve(ACCOUNTS)),
  postingRules: vi.fn(() => Promise.resolve([{ role: 'cash', account_id: 'A4' }, { role: 'accounts_receivable', account_id: 'A1' }])),
  createAccount: vi.fn(() => Promise.resolve({ id: 'NEW' })),
  updateAccount: vi.fn(() => Promise.resolve({ id: 'A4' })),
  setPostingRule: vi.fn(() => Promise.resolve()),
  chartTemplates: vi.fn(() => Promise.resolve([{ country: 'AE', accounts: 92 }, { country: 'EG', accounts: 95 }, { country: 'SA', accounts: 95 }])),
  appliedTemplate: vi.fn(() => Promise.resolve(null)),
  applyChartTemplate: vi.fn(() => Promise.resolve({ country: 'EG', created: 70, updated: 25, removed: 1 })),
  importChartAccounts: vi.fn(() => Promise.resolve([
    { code: '6190', status: 'created' },
    { code: '1250', status: 'error', message: 'Account 1250: the type must be asset, liability, equity, income or expense.' },
  ])),
}
vi.mock('../api/supabaseClient', () => ({ db: { ledger: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }) } }))

const { default: JournalTab } = await import('../pages/Accounting/JournalTab.jsx')
const { default: TrialBalanceTab } = await import('../pages/Accounting/TrialBalanceTab.jsx')
const { default: ChartOfAccounts } = await import('../pages/cp/ChartOfAccounts.jsx')

function renderIt(el) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider>)
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockClear())
  toastError.mockClear()
})
afterEach(cleanup)

describe('Journal', () => {
  it('lists entries; opening one shows its lines; an invoice entry links to the invoice', async () => {
    renderIt(<JournalTab perPage={25} setPerPage={() => {}} />)
    const open = await screen.findByRole('button', { name: 'JE-2026-00001' })
    expect(screen.getByRole('link', { name: 'INV-2026-00007' }).getAttribute('href')).toBe('/sales/invoice/INV1')
    expect(screen.getByText('115.00')).toBeTruthy()
    expect(screen.queryByText('Sales revenue')).toBeNull()
    fireEvent.click(open)
    expect(open.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Sales revenue')).toBeTruthy()
    expect(screen.getByText('VAT payable')).toBeTruthy()
  })

  it('filters by date and search in the database', async () => {
    renderIt(<JournalTab perPage={25} setPerPage={() => {}} />)
    await screen.findByRole('button', { name: 'JE-2026-00001' })
    fireEvent.change(screen.getByLabelText('accounting.glFrom'), { target: { value: '2026-09-01' } })
    await waitFor(() => expect(api.journalPage).toHaveBeenLastCalledWith(1, 25, expect.objectContaining({ from: '2026-09-01' })))
  })
})

describe('Trial balance', () => {
  it('totals debits and credits and says they balance', async () => {
    renderIt(<TrialBalanceTab />)
    await screen.findByText('Sales revenue')
    expect(screen.getByText('accounting.glBalanced')).toBeTruthy()
    expect(screen.getAllByText('115.00').length).toBeGreaterThanOrEqual(4)
  })

  it('shows the database refusal (a role that may not read the ledger)', async () => {
    api.trialBalance.mockImplementationOnce(() => Promise.reject(new Error('Only managers and accountants can read the ledger.')))
    renderIt(<TrialBalanceTab />)
    expect((await screen.findByRole('alert')).textContent).toBe('Only managers and accountants can read the ledger.')
  })
})

describe('Chart of accounts', () => {
  it('lays the chart out and adds an account under a header', async () => {
    renderIt(<ChartOfAccounts />)
    await screen.findByText('Assets')
    fireEvent.change(screen.getByLabelText(/^accounting\.glCode\*?$/), { target: { value: '1120' } })
    fireEvent.change(screen.getByLabelText(/^accounting\.glName\*?$/), { target: { value: 'Petty cash' } })
    fireEvent.change(screen.getByLabelText('accounting.glParent'), { target: { value: 'H1' } })
    fireEvent.click(screen.getByRole('button', { name: 'accounting.glAdd' }))
    await waitFor(() => expect(api.createAccount).toHaveBeenCalledWith({
      code: '1120', name: 'Petty cash', name_ar: null, account_type: 'asset', parent_id: 'H1', is_postable: true,
    }))
  })

  it('refuses an account with no code before the round trip', async () => {
    renderIt(<ChartOfAccounts />)
    await screen.findByText('Assets')
    fireEvent.click(screen.getByRole('button', { name: 'accounting.glAdd' }))
    expect((await screen.findByRole('alert')).textContent).toBe('accounting.glErrCode')
    expect(api.createAccount).not.toHaveBeenCalled()
  })

  it('points a posting rule at another account; only postable active accounts are offered', async () => {
    renderIt(<ChartOfAccounts />)
    const cash = await screen.findByLabelText('accounting.glRole_cash')
    await waitFor(() => expect(cash.value).toBe('A4'))
    const options = within(cash).getAllByRole('option').map((o) => o.value)
    expect(options).toEqual(['A1', 'A4']) // the header 1000 is not offered
    fireEvent.change(cash, { target: { value: 'A1' } })
    await waitFor(() => expect(api.setPostingRule).toHaveBeenCalledWith('cash', 'A1'))
  })

  it('shows the database refusal as it is', async () => {
    api.updateAccount.mockImplementationOnce(() => Promise.reject(new Error('Account 1110 is used by a posting rule; point the rule at another account first.')))
    renderIt(<ChartOfAccounts />)
    const row = (await screen.findByText('Bank')).closest('tr')
    fireEvent.click(within(row).getByRole('button', { name: 'accounting.glDeactivate' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(
      'Account 1110 is used by a posting rule; point the rule at another account first.', { duration: 7000 }))
  })
})

describe('Chart of accounts: country templates and import (A-02)', () => {
  const csvFile = (text) => ({ name: 'chart.csv', text: () => Promise.resolve(text) })

  it('applies a country template only after the confirmation dialog', async () => {
    renderIt(<ChartOfAccounts />)
    const pick = await screen.findByLabelText('accounting.glTemplateCountry')
    await waitFor(() => expect(within(pick).getAllByRole('option').map((o) => o.value)).toEqual(['', 'EG', 'AE', 'SA']))
    fireEvent.change(pick, { target: { value: 'EG' } })
    fireEvent.click(screen.getByRole('button', { name: 'accounting.glTemplateApply' }))
    expect(api.applyChartTemplate).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'accounting.glTemplateApply' }))
    await waitFor(() => expect(api.applyChartTemplate).toHaveBeenCalledWith('EG'))
  })

  it('shows the database refusal once something has been posted', async () => {
    api.applyChartTemplate.mockImplementationOnce(() =>
      Promise.reject(new Error('The chart can only be replaced before anything has been posted. Add or rename accounts instead.')))
    renderIt(<ChartOfAccounts />)
    const pick = await screen.findByLabelText('accounting.glTemplateCountry')
    await waitFor(() => expect(within(pick).getAllByRole('option')).toHaveLength(4))
    fireEvent.change(pick, { target: { value: 'SA' } })
    fireEvent.click(screen.getByRole('button', { name: 'accounting.glTemplateApply' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'accounting.glTemplateApply' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(
      'The chart can only be replaced before anything has been posted. Add or rename accounts instead.', { duration: 7000 }))
  })

  it('imports a CSV file and lists the rows the database refused', async () => {
    renderIt(<ChartOfAccounts />)
    await screen.findByText('Assets')
    fireEvent.change(screen.getByLabelText('accounting.glImportFile'), {
      target: { files: [csvFile('code,name,type,parent_code\n6190,Staff training,expense,6000\n1250,Bad type,money,1200\n')] },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'accounting.glImportRun:{"count":2}' }))
    await waitFor(() => expect(api.importChartAccounts).toHaveBeenCalledWith([
      { code: '6190', name: 'Staff training', type: 'expense', parent_code: '6000' },
      { code: '1250', name: 'Bad type', type: 'money', parent_code: '1200' },
    ]))
    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('accounting.glImportDone:{"created":1,"updated":0,"errors":1}')
    expect(status.textContent).toContain('Account 1250: the type must be asset, liability, equity, income or expense.')
  })

  it('refuses a file without code and name columns before the round trip', async () => {
    renderIt(<ChartOfAccounts />)
    await screen.findByText('Assets')
    fireEvent.change(screen.getByLabelText('accounting.glImportFile'), { target: { files: [csvFile('number,title\n1,x\n')] } })
    expect((await screen.findByRole('alert')).textContent).toBe('accounting.glImportErrColumns')
    expect(screen.queryByRole('button', { name: /accounting\.glImportRun/ })).toBeNull()
    expect(api.importChartAccounts).not.toHaveBeenCalled()
  })
})
