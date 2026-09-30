/**
 * bankScreens.test.jsx — A-07b: the bank reconciliation screens over 20260920.
 * Owner decisions 2026-09-30: any bank or cash account; the statement comes in
 * as a CSV; an unmatched line is booked from the line; accountants and
 * administrators reconcile, managers read. The database enforces all of it;
 * these pin the CSV reading and what each role is offered.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { readFileSync } from 'node:fs'
import { guessMapping, lastDate, linesTotal, mapStatementRows, parseAmount, parseCsv, parseDate, splitCsvLine } from '../pages/Accounting/_bank'

describe('reading a bank CSV', () => {
  it('splits quoted fields and guesses the delimiter', () => {
    expect(splitCsvLine('a,"b, c","d ""e"""')).toEqual(['a', 'b, c', 'd "e"'])
    expect(parseCsv('﻿Date;Amount\n2026-09-01;10,50\n\n').rows).toEqual([['2026-09-01', '10,50']])
    expect(parseCsv('Date\tAmount\n1\t2').headers).toEqual(['Date', 'Amount'])
  })

  it('reads amounts as banks write them', () => {
    expect(parseAmount('1,234.50')).toBe('1234.50')
    expect(parseAmount('1.234,50')).toBe('1234.50')
    expect(parseAmount('12,50')).toBe('12.50')
    expect(parseAmount('1,250')).toBe('1250.00')
    expect(parseAmount('(12.00)')).toBe('-12.00')
    expect(parseAmount('12.00-')).toBe('-12.00')
    expect(parseAmount('EGP -5')).toBe('-5.00')
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('abc')).toBeNull()
  })

  it('reads dates in the chosen order and refuses impossible ones', () => {
    expect(parseDate('2026-09-01')).toBe('2026-09-01')
    expect(parseDate('01/09/2026', 'dmy')).toBe('2026-09-01')
    expect(parseDate('09/01/2026', 'mdy')).toBe('2026-09-01')
    expect(parseDate('31/02/2026', 'dmy')).toBeNull()
    expect(parseDate('1.9.26', 'dmy')).toBe('2026-09-01')
    expect(parseDate('yesterday')).toBeNull()
  })

  it('guesses the columns, one amount or money in / money out', () => {
    expect(guessMapping(['Date', 'Description', 'Reference', 'Amount'])).toEqual({ date: 0, description: 1, reference: 2, amount: 3, debit: null, credit: null })
    const m = guessMapping(['Value date', 'Narrative', 'Debit', 'Credit'])
    expect([m.date, m.description, m.amount, m.debit, m.credit]).toEqual([0, 1, null, 2, 3])
  })

  it('maps rows to lines, money in positive, and names the rows it cannot read', () => {
    const rows = [['01/09/2026', 'Fee', '15.00', ''], ['02/09/2026', 'Receipt', '', '1,000.00'], ['xx', 'Bad', '1', ''], ['03/09/2026', 'Zero', '', '']]
    const { lines, errors } = mapStatementRows(rows, { date: 0, description: 1, reference: null, amount: null, debit: 2, credit: 3 }, 'dmy')
    expect(lines).toEqual([
      { txn_date: '2026-09-01', amount: '-15.00', description: 'Fee', reference: null },
      { txn_date: '2026-09-02', amount: '1000.00', description: 'Receipt', reference: null },
    ])
    expect(errors).toEqual([{ row: 3, key: 'accounting.bankErrDate' }, { row: 4, key: 'accounting.bankErrAmount' }])
    expect(linesTotal(lines)).toBe(985)
    expect(lastDate(lines)).toBe('2026-09-02')
    expect(linesTotal([{ amount: '0.10' }, { amount: '0.20' }])).toBe(0.3)
  })
})

describe('wiring', () => {
  const tab = readFileSync('src/pages/Accounting/BankReconciliationTab.jsx', 'utf8')
  const api = readFileSync('src/api/db/bankRec.ts', 'utf8')
  it('changes nothing except through the database functions', () => {
    expect(api).not.toMatch(/\.(insert|update|upsert|delete)\(/)
    for (const fn of ['create_bank_statement', 'match_bank_line', 'unmatch_bank_line', 'auto_match_bank_statement', 'book_bank_line', 'complete_bank_statement', 'reopen_bank_statement', 'delete_bank_statement']) {
      expect(api).toContain(`'${fn}'`)
    }
  })
  it('is offered in Accounting to the ledger roles, and edits only for finance', () => {
    const idx = readFileSync('src/pages/Accounting/index.jsx', 'utf8')
    expect(idx).toContain("{tab === 'bank' && canSeeLedger && <BankReconciliationTab")
    expect(tab).toContain('const canEdit = isFinanceRole(currentUserRole)')
  })
  it('every string is in both languages', () => {
    const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8')).accounting
    const ar = JSON.parse(readFileSync('src/locales/ar.json', 'utf8')).accounting
    const keys = new Set([...tab.matchAll(/accounting\.(bank\w+|tabBank)/g)].map((m) => m[1]))
    for (const k of ['bankCol_date', 'bankCol_reference', 'bankCol_debit', 'bankCol_credit', 'bankStatus_open', 'bankStatus_completed', 'bankErrDate', 'bankErrAmount', 'bankMark', 'bankUnmark', 'bankBadge', 'tabBank']) keys.add(k)
    keys.delete('bankCol_'); keys.delete('bankStatus_')
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

const ACC = { id: 'acc1', code: '1130', name: 'Bank current account', name_ar: null }
const ST = { id: 's1', account_id: 'acc1', statement_date: '2026-09-30', reference: 'SEP', opening_balance: 0, closing_balance: 985, status: 'open' }
const bankRec = {
  accounts: vi.fn(() => Promise.resolve([ACC])),
  statementsPage: vi.fn(() => Promise.resolve({ data: [ST], count: 1 })),
  latest: vi.fn(() => Promise.resolve(ST)),
  statement: vi.fn(() => Promise.resolve(ST)),
  lines: vi.fn(() => Promise.resolve([
    { id: 'l1', statement_id: 's1', line_no: 1, txn_date: '2026-09-02', description: 'Receipt', reference: null, amount: 1000, journal_line_id: null, booked_entry_id: null },
    { id: 'l2', statement_id: 's1', line_no: 2, txn_date: '2026-09-01', description: 'Fee', reference: null, amount: -15, journal_line_id: null, booked_entry_id: null },
  ])),
  candidates: vi.fn(() => Promise.resolve([
    { statement_line_id: 'l1', journal_line_id: 'jl1', entry_no: 'JE-2026-00007', entry_date: '2026-09-01', source_type: 'payment', source_id: 'p1', source_code: 'PAY-2026-00003', memo: null, amount: 1000, days_apart: 1 },
  ])),
  summary: vi.fn(() => Promise.resolve({ opening_balance: 0, lines_total: 985, closing_balance: 985, lines_count: 2, unmatched_count: 2, statement_balances: true, ledger_balance: 1000, uncleared_total: 1000, uncleared_count: 1, difference: 985, previous_closing: null })),
  match: vi.fn(() => Promise.resolve()),
  book: vi.fn(() => Promise.resolve('e1')),
  autoMatch: vi.fn(() => Promise.resolve(1)),
  complete: vi.fn(() => Promise.resolve()),
  create: vi.fn(() => Promise.resolve('s2')),
}
const ledger = {
  accounts: vi.fn(() => Promise.resolve([
    { id: 'x1', code: '6100', name: 'Bank charges', name_ar: null, is_postable: true, is_active: true, is_bank: false },
    ACC && { ...ACC, is_postable: true, is_active: true, is_bank: true },
  ])),
}
vi.mock('../api/supabaseClient', () => ({
  db: {
    bankRec: new Proxy({}, { get: (_, k) => (...a) => bankRec[k](...a) }),
    ledger: new Proxy({}, { get: (_, k) => (...a) => ledger[k](...a) }),
  },
}))
const { default: BankReconciliationTab } = await import('../pages/Accounting/BankReconciliationTab.jsx')

const wrap = (ui) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>,
)

describe('Bank reconciliation tab', () => {
  beforeEach(() => Object.values(bankRec).forEach((f) => f.mockClear()))
  afterEach(cleanup)

  it('an accountant opens a statement, matches a line to its entry and books a fee', async () => {
    wrap(<BankReconciliationTab currentUserRole="accountant" />)
    fireEvent.click(await screen.findByRole('button', { name: 'accounting.bankOpenIt' }))
    expect(await screen.findByText('Receipt')).toBeTruthy()
    const select = await screen.findByLabelText('accounting.bankCandidate')
    expect(select.textContent).toContain('JE-2026-00007')
    fireEvent.click(screen.getByText('accounting.bankMatchIt'))
    await waitFor(() => expect(bankRec.match).toHaveBeenCalledWith('l1', 'jl1'))

    // the fee has no entry: booked from the line to an expense account (never a bank account)
    expect(screen.getByText('accounting.bankNoCandidate')).toBeTruthy()
    fireEvent.click(screen.getAllByText('accounting.bankBook')[1])
    const acct = await screen.findByLabelText(/accounting.bankBookAccount/)
    await waitFor(() => expect(acct.textContent).toContain('6100'))
    expect(acct.textContent).not.toContain('1130')
    fireEvent.change(acct, { target: { value: 'x1' } })
    fireEvent.click(screen.getByText('accounting.bankBookIt'))
    await waitFor(() => expect(bankRec.book).toHaveBeenCalledWith('l2', 'x1', 'Fee'))
  })

  it('Complete waits until every line is matched', async () => {
    wrap(<BankReconciliationTab currentUserRole="admin" />)
    fireEvent.click(await screen.findByRole('button', { name: 'accounting.bankOpenIt' }))
    await screen.findByLabelText('accounting.bankSummary')
    expect(screen.getByText('accounting.bankComplete').closest('button').disabled).toBe(true)
  })

  it('a manager reads the statement but is offered no action', async () => {
    wrap(<BankReconciliationTab currentUserRole="manager" />)
    fireEvent.click(await screen.findByRole('button', { name: 'accounting.bankOpenIt' }))
    expect(await screen.findByText('Receipt')).toBeTruthy()
    expect(screen.queryByText('accounting.bankNew')).toBeNull()
    expect(screen.queryByText('accounting.bankAutoMatch')).toBeNull()
    expect(screen.queryByText('accounting.bankBook')).toBeNull()
    expect(screen.getAllByText('accounting.bankNotMatched').length).toBe(2)
  })

  it('says how to mark an account when there is none', async () => {
    bankRec.accounts.mockImplementationOnce(() => Promise.resolve([]))
    wrap(<BankReconciliationTab currentUserRole="accountant" />)
    expect(await screen.findByText('accounting.bankNoAccounts')).toBeTruthy()
  })

  it('imports a CSV: maps it, fills the closing and date, sends the lines', async () => {
    bankRec.latest.mockImplementation(() => Promise.resolve({ ...ST, status: 'completed', closing_balance: 100 }))
    wrap(<BankReconciliationTab currentUserRole="accountant" />)
    fireEvent.click(await screen.findByText('accounting.bankNew'))
    const file = new File(['Date,Description,Amount\n2026-10-01,Fee,-15\n2026-10-03,Receipt,"1,000.00"\n'], 'oct.csv', { type: 'text/csv' })
    fireEvent.change(screen.getByLabelText('accounting.bankFile'), { target: { files: [file] } })
    expect(await screen.findByText(/accounting.bankPreviewCount/)).toBeTruthy()
    expect(screen.getByLabelText(/accounting.bankOpening/).value).toBe('100')
    expect(screen.getByLabelText(/accounting.bankClosing/).placeholder).toBe('1085.00')
    expect(screen.getByLabelText(/accounting.bankStatementDate/).value).toBe('2026-10-03')
    fireEvent.click(screen.getByText('accounting.bankImport'))
    await waitFor(() => expect(bankRec.create).toHaveBeenCalledWith({
      accountId: 'acc1', statementDate: '2026-10-03', reference: 'oct', openingBalance: 100, closingBalance: 1085,
      lines: [
        { txn_date: '2026-10-01', amount: '-15.00', description: 'Fee', reference: null },
        { txn_date: '2026-10-03', amount: '1000.00', description: 'Receipt', reference: null },
      ],
    }))
    bankRec.latest.mockImplementation(() => Promise.resolve(ST))
  })
})
