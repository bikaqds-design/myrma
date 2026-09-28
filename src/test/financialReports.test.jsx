/**
 * financialReports.test.jsx — A-08a (20260916): profit and loss, balance
 * sheet and account drill-down. supabase/tests/financial_reports.sql (22
 * checks, rolled back) is the database half; this pins the totals, the
 * wiring and the screens. The assistant cannot sign in, so the render tests
 * are the screen check.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import React from 'react'
import { readFileSync } from 'node:fs'
import { bsSummary, groupByHeader, plSummary, validatePeriod, yearToDate } from '../pages/Accounting/_reports'

const read = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')

const PL = [
  { account_id: 'a1', code: '4100', name: 'Sales revenue', name_ar: 'المبيعات', account_type: 'income', parent_id: 'h4', parent_code: '4000', parent_name: 'Income', parent_name_ar: 'الإيرادات', amount: 1000.1 },
  { account_id: 'a2', code: '4910', name: 'FX gains', name_ar: null, account_type: 'income', parent_id: 'h4', parent_code: '4000', parent_name: 'Income', parent_name_ar: 'الإيرادات', amount: 0.2 },
  { account_id: 'a3', code: '5100', name: 'Cost of goods sold', name_ar: null, account_type: 'expense', parent_id: 'h5', parent_code: '5000', parent_name: 'Cost of sales', parent_name_ar: null, amount: 600 },
]
const BS = [
  { kind: 'account', section: 'asset', account_id: 'b1', code: '1100', name: 'Cash', name_ar: null, parent_id: 'h1', parent_code: '1000', parent_name: 'Assets', parent_name_ar: null, amount: 1685 },
  { kind: 'account', section: 'liability', account_id: 'b2', code: '2200', name: 'VAT payable', name_ar: null, parent_id: 'h2', parent_code: '2000', parent_name: 'Liabilities', parent_name_ar: null, amount: 105 },
  { kind: 'account', section: 'equity', account_id: 'b3', code: '3900', name: 'Opening equity', name_ar: null, parent_id: 'h3', parent_code: '3000', parent_name: 'Equity', parent_name_ar: null, amount: 1000 },
  { kind: 'prior_years_earnings', section: 'equity', account_id: null, code: null, name: null, name_ar: null, parent_id: null, parent_code: null, parent_name: null, parent_name_ar: null, amount: 500 },
  { kind: 'current_year_earnings', section: 'equity', account_id: null, code: null, name: null, name_ar: null, parent_id: null, parent_code: null, parent_name: null, parent_name_ar: null, amount: 80 },
]

describe('report arithmetic', () => {
  it('groups accounts under their header with an exact total', () => {
    const g = groupByHeader(PL.filter((r) => r.account_type === 'income'), 'ar')
    expect(g).toHaveLength(1)
    expect(g[0]).toMatchObject({ code: '4000', label: 'الإيرادات', total: 1000.3 })
    expect(g[0].rows.map((r) => r.code)).toEqual(['4100', '4910'])
  })

  it('net profit is income less expenses, in cents', () => {
    expect(plSummary(PL)).toEqual({ income: 1000.3, expense: 600, net: 400.3 })
    const tenths = Array.from({ length: 10 }, () => ({ account_type: 'income', amount: 0.1 }))
    expect(plSummary(tenths).income).toBe(1)
  })

  it('the balance sheet balances when assets = liabilities + equity, earnings included', () => {
    expect(bsSummary(BS)).toMatchObject({ assets: 1685, liabilities: 105, equity: 1580, liabilitiesAndEquity: 1685, balanced: true })
    expect(bsSummary(BS.slice(0, 3)).balanced).toBe(false)
  })

  it('a period needs both dates, in order', () => {
    expect(validatePeriod('2026-01-01', '2026-09-28')).toBeNull()
    expect(validatePeriod('2026-09-28', '2026-01-01')).toBe('accounting.repErrPeriod')
    expect(validatePeriod('', '2026-01-01')).toBe('accounting.repErrPeriod')
    expect(yearToDate(new Date(2026, 8, 28))).toEqual({ from: '2026-01-01', to: '2026-09-28' })
  })
})

describe('wiring', () => {
  it('the API calls the three report functions with their parameters, paging in the database', () => {
    const api = read('src/api/db/ledger.ts')
    expect(api).toContain("supabase.rpc('rma_profit_and_loss', { p_from: from, p_to: to })")
    expect(api).toContain("supabase.rpc('rma_balance_sheet', { p_as_of: asOf })")
    expect(api).toContain('p_limit: pageSize, p_offset: (Math.max(page, 1) - 1) * pageSize,')
  })

  it('the migration guards every report and exposes none to anon', () => {
    const sql = read('supabase/migrations/20260916_financial_reports.sql')
    expect(sql.match(/IF NOT COALESCE\(public\.rma_can_handle_cash\(\), false\) THEN/g)).toHaveLength(3)
    for (const f of ['rma_profit_and_loss(date, date)', 'rma_balance_sheet(date)', 'rma_account_activity(uuid, date, date, int, int)', 'rma_fiscal_year_start(date)']) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon;`)
    }
    expect(sql).toContain('LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500)')
  })

  it('both reports are Accounting tabs for the ledger roles', () => {
    const s = read('src/pages/Accounting/index.jsx')
    expect(s).toContain("{tab === 'profit_loss' && canSeeLedger && <ProfitLossTab />}")
    expect(s).toContain("{tab === 'balance_sheet' && canSeeLedger && <BalanceSheetTab />}")
  })

  it('every string exists in both languages', () => {
    const en = JSON.parse(read('src/locales/en.json')).accounting
    const ar = JSON.parse(read('src/locales/ar.json')).accounting
    const files = ['ProfitLossTab.jsx', 'BalanceSheetTab.jsx', 'AccountActivityModal.jsx', 'ReportSection.jsx', '_reports.js']
    const keys = new Set(['rep_prior_years_earnings', 'rep_current_year_earnings', 'tabProfitLoss', 'tabBalanceSheet'])
    for (const f of files) for (const m of read(`src/pages/Accounting/${f}`).matchAll(/'accounting\.(rep\w+)'/g)) keys.add(m[1])
    for (const k of keys) {
      expect(en[k], `en ${k}`).toBeTruthy()
      expect(ar[k], `ar ${k}`).toBeTruthy()
    }
  })
})

// ── rendered ──────────────────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key), i18n: { language: 'en' } }),
}))
vi.mock('../hooks/useBaseCurrency', () => ({ useBaseCurrency: () => 'EGP' }))
const ledger = {
  profitAndLoss: vi.fn(() => Promise.resolve(PL)),
  balanceSheet: vi.fn(() => Promise.resolve(BS)),
  accountActivity: vi.fn(() => Promise.resolve({
    data: [{ entry_id: 'e1', entry_no: 'JE-2026-00001', entry_date: '2026-03-01', source_type: 'crm_invoice', source_id: 'inv1',
      source_code: 'INV-2026-00001', event: 'posted', memo: null, debit: 0, credit: 1000.1, running_balance: 1000.1, opening_balance: 0, total_count: 1 }],
    count: 1, opening: 0,
  })),
}
vi.mock('../api/supabaseClient', () => ({ db: { ledger: new Proxy({}, { get: (_, k) => (...a) => ledger[k](...a) }) } }))
const { default: ProfitLossTab } = await import('../pages/Accounting/ProfitLossTab.jsx')
const { default: BalanceSheetTab } = await import('../pages/Accounting/BalanceSheetTab.jsx')

const wrap = (ui) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>,
)

describe('Profit and loss', () => {
  beforeEach(() => Object.values(ledger).forEach((f) => f.mockClear()))
  afterEach(cleanup)

  it('shows income and expenses by header and the net profit', async () => {
    wrap(<ProfitLossTab />)
    expect(await screen.findByText('400.30 EGP')).toBeTruthy()
    expect(screen.getByText('accounting.repNetProfit')).toBeTruthy()
    expect(screen.getByText('accounting.repTotalIncome').closest('tr').textContent).toContain('1,000.30')
    expect(ledger.profitAndLoss).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-01-01$/), expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
  })

  it('an account opens its entries for the same period, linked to the document', async () => {
    wrap(<ProfitLossTab />)
    fireEvent.click(await screen.findByRole('button', { name: /4100\s+Sales revenue/ }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByRole('link', { name: 'INV-2026-00001' }).getAttribute('href')).toBe('/sales/invoice/inv1'))
    const [id, from, to, page, perPage] = ledger.accountActivity.mock.calls[0]
    expect([id, page, perPage]).toEqual(['a1', 1, 50])
    expect(from).toMatch(/-01-01$/)
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('a start date after the end is refused before the round trip', async () => {
    wrap(<ProfitLossTab />)
    await screen.findByText('400.30 EGP')
    ledger.profitAndLoss.mockClear()
    fireEvent.change(document.getElementById('pl-from'), { target: { value: '2999-01-01' } })
    expect((await screen.findByRole('alert')).textContent).toBe('accounting.repErrPeriod')
    expect(ledger.profitAndLoss).not.toHaveBeenCalled()
  })
})

describe('Balance sheet', () => {
  afterEach(cleanup)

  it('lists the sections with unclosed profit in equity, and says it balances', async () => {
    wrap(<BalanceSheetTab />)
    expect(await screen.findByText('accounting.rep_prior_years_earnings')).toBeTruthy()
    expect(screen.getByText('accounting.repBalanced')).toBeTruthy()
    expect(screen.getByText('accounting.rep_current_year_earnings')).toBeTruthy()
    expect(screen.getByText('accounting.repTotalEquity').closest('tr').textContent).toContain('1,580.00')
    expect(screen.getByText('1,685.00 EGP')).toBeTruthy()
  })

  it('an account opens every entry up to the date', async () => {
    wrap(<BalanceSheetTab />)
    fireEvent.click(await screen.findByRole('button', { name: /1100\s+Cash/ }))
    await screen.findByRole('dialog')
    const call = ledger.accountActivity.mock.calls.at(-1)
    expect(call[0]).toBe('b1')
    expect(call[1]).toBeNull()
  })
})
