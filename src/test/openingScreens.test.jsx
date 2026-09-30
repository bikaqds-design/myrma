/**
 * openingScreens.test.jsx — B-03b: the opening balances screen over 20260921.
 * Owner decisions 2026-09-30: each open document, CSV import reviewed on
 * screen then posted, one Opening balance equity account, reversible until
 * the month is closed. The database enforces all of it; these pin the CSV
 * mapping and what each role is offered.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { readFileSync } from 'node:fs'
import { equityBalances, guessOpeningMapping, mapOpeningRows, missingFields, splitSerials, SECTION_FIELDS } from '../pages/Accounting/_opening'

describe('reading opening-balance CSVs', () => {
  it('guesses each section\'s columns from the headers', () => {
    expect(guessOpeningMapping('accounts', ['Account Code', 'Debit', 'Credit', 'Account name']))
      .toEqual({ account_code: 0, debit: 1, credit: 2, memo: 3 })
    const m = guessOpeningMapping('receivables', ['Customer', 'Invoice No', 'Invoice Date', 'Due Date', 'Currency', 'Balance'])
    expect([m.party, m.doc_no, m.doc_date, m.due_date, m.currency, m.amount, m.exchange_rate]).toEqual([0, 1, 2, 3, 4, 5, null])
    const s = guessOpeningMapping('stock', ['SKU', 'Warehouse', 'Qty', 'Unit cost', 'Serial numbers'])
    expect([s.sku, s.warehouse, s.qty, s.unit_cost, s.serials]).toEqual([0, 1, 2, 3, 4])
  })

  it('names the columns a section cannot do without', () => {
    expect(missingFields('receivables', { party: 0, doc_no: null, doc_date: 1, amount: 2 })).toEqual(['doc_no'])
    expect(missingFields('accounts', { account_code: 0, debit: null, credit: null })).toEqual(['debit'])
    expect(missingFields('stock', { sku: 0, warehouse: 1, qty: 2 })).toEqual([])
  })

  it('normalises amounts and dates it can read, and passes the rest through for the database to name', () => {
    const rows = mapOpeningRows('receivables', [
      ['ACME', 'A-1', '15/11/2023', '', '1,250.50'],
      ['', '', '', '', ''],
      ['ACME', 'A-2', 'soon', '31/12/2023', 'lots'],
    ], { party: 0, doc_no: 1, doc_date: 2, due_date: 3, amount: 4 }, 'dmy')
    expect(rows).toEqual([
      { row: { party: 'ACME', doc_no: 'A-1', doc_date: '2023-11-15', amount: '1250.50' }, sourceRow: 1 },
      { row: { party: 'ACME', doc_no: 'A-2', doc_date: 'soon', due_date: '2023-12-31', amount: 'lots' }, sourceRow: 3 },
    ])
  })

  it('keeps four-decimal costs and reads serials from one cell', () => {
    const [r] = mapOpeningRows('stock', [['R1', 'Main', '2', '1,234.5678', 'SN1; SN2']],
      { sku: 0, warehouse: 1, qty: 2, unit_cost: 3, serials: 4 })
    expect(r.row).toEqual({ sku: 'R1', warehouse: 'Main', qty: '2', unit_cost: '1234.5678', serials: ['SN1', 'SN2'] })
    expect(splitSerials('a|b,c\nd')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('opening balance equity balances only at zero to the cent', () => {
    expect(equityBalances({ equity_difference: 0 })).toBe(true)
    expect(equityBalances({ equity_difference: 0.004 })).toBe(true)
    expect(equityBalances({ equity_difference: -0.01 })).toBe(false)
  })
})

describe('wiring', () => {
  const tab = readFileSync('src/pages/Accounting/OpeningBalancesTab.jsx', 'utf8')
  const api = readFileSync('src/api/db/openingBalances.ts', 'utf8')
  it('changes nothing except through the database functions', () => {
    expect(api).not.toMatch(/\.(insert|update|upsert|delete)\(/)
    for (const fn of ['create_opening_balance_batch', 'set_opening_balance_rows', 'rma_opening_balance_summary',
      'post_opening_balances', 'reverse_opening_balances', 'delete_opening_balance_batch']) {
      expect(api).toContain(`'${fn}'`)
    }
  })
  it('is offered in Accounting to the ledger roles, and acts only for finance', () => {
    expect(readFileSync('src/pages/Accounting/index.jsx', 'utf8')).toContain("{tab === 'opening' && canSeeLedger && <OpeningBalancesTab")
    expect(tab).toContain('const canEdit = isFinanceRole(currentUserRole)')
  })
  it('an opening invoice or bill page offers only what the database allows: pay it, not void, print, receive, cancel or add charges', () => {
    const sales = readFileSync('src/pages/SalesDocuments/SalesDocumentDetail.jsx', 'utf8')
    expect(sales).toContain("{n.status === 'posted' && !doc.is_opening && (")
    expect(sales).toContain("isPrintable('invoice', doc) && !doc.is_opening && (")
    expect(sales).toContain("t('salesDocuments.openingBadge')")
    const purchase = readFileSync('src/pages/Purchasing/PurchaseDocumentDetail.jsx', 'utf8')
    expect(purchase).toContain("{!isReceiptInvoice && !doc.is_opening && ['approved', 'partially_received'].includes(doc.status) && (")
    expect(purchase).toContain("{!doc.is_opening && (isReceiptInvoice ? ['draft', 'pending_approval'] : ['draft', 'pending_approval', 'approved']).includes(doc.status) && (")
    expect(purchase).toContain('{isVI && !doc.is_opening && (\n        <LandedCharges'.replace(/\n/g, purchase.includes('\r\n') ? '\r\n' : '\n'))
  })
  it('every string is in both languages', () => {
    const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8')).accounting
    const ar = JSON.parse(readFileSync('src/locales/ar.json', 'utf8')).accounting
    const keys = new Set([...tab.matchAll(/accounting\.(ob\w+|tabOpening)/g)].map((m) => m[1]).filter((k) => !k.endsWith('_')))
    for (const s of ['accounts', 'receivables', 'payables', 'stock']) { keys.add(`obSection_${s}`); keys.add(`obColumns_${s}`) }
    for (const s of ['receivables', 'payables', 'stock']) keys.add(`obCheck_${s}`)
    for (const s of ['draft', 'posted', 'reversed']) keys.add(`obStatus_${s}`)
    for (const s of Object.values(SECTION_FIELDS)) for (const f of Object.keys(s)) keys.add(`obField_${f}`)
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

const DRAFT = { id: 'b1', opening_date: '2023-12-31', status: 'draft', notes: null }
const SUM = {
  accounts: { rows: 5, debit: 1450, credit: 1450 }, tb_balanced: true,
  receivables: { rows: 2, total_base: 300, trial_balance: 300, difference: 0 },
  payables: { rows: 1, total_base: 200, trial_balance: 250, difference: -50 },
  stock: { rows: 2, units: 12, uncosted_units: 0, known_cost: 150, trial_balance: 150, difference: 0 },
  other_accounts_net: -250, equity_difference: 50, currency: 'EGP',
}
const ob = {
  current: vi.fn(() => Promise.resolve(DRAFT)),
  reversed: vi.fn(() => Promise.resolve([])),
  summary: vi.fn(() => Promise.resolve(SUM)),
  documents: vi.fn(() => Promise.resolve([])),
  accounts: vi.fn(() => Promise.resolve([])),
  stock: vi.fn(() => Promise.resolve([])),
  create: vi.fn(() => Promise.resolve('b2')),
  setRows: vi.fn(() => Promise.resolve({ stored: 1, errors: [] })),
  post: vi.fn(() => Promise.resolve({})),
  reverse: vi.fn(() => Promise.resolve({})),
  remove: vi.fn(() => Promise.resolve()),
}
vi.mock('../api/supabaseClient', () => ({ db: { openingBalances: new Proxy({}, { get: (_, k) => (...a) => ob[k](...a) }) } }))
const { default: OpeningBalancesTab } = await import('../pages/Accounting/OpeningBalancesTab.jsx')

const wrap = (ui) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>,
)

describe('Opening balances tab', () => {
  beforeEach(() => Object.values(ob).forEach((f) => f.mockClear()))
  afterEach(cleanup)

  it('shows where the detail disagrees with the trial balance and what equity would hold', async () => {
    wrap(<OpeningBalancesTab currentUserRole="accountant" />)
    expect(await screen.findByLabelText('accounting.obSummary')).toBeTruthy()
    expect(screen.getAllByText('accounting.obAgrees').length).toBe(2)
    expect(screen.getByText(/accounting\.obDiffers/)).toBeTruthy()
    expect(screen.getByText('50.00 EGP')).toBeTruthy()
  })

  it('imports a section, and names each row the database refuses by its row in the file', async () => {
    ob.setRows.mockImplementationOnce(() => Promise.resolve({ stored: 0, errors: [{ row: 2, error: 'no single customer matches Bob' }] }))
    wrap(<OpeningBalancesTab currentUserRole="accountant" />)
    await screen.findByLabelText('accounting.obSummary')
    fireEvent.click(screen.getAllByText('accounting.obImport')[1])   // receivables
    const file = new File(['Customer,Invoice No,Date,Amount\nACME,A-1,2023-11-15,100\n,,,\nBob,A-2,2023-11-16,5\n'], 'ar.csv', { type: 'text/csv' })
    fireEvent.change(screen.getByLabelText('accounting.bankFile'), { target: { files: [file] } })
    expect(await screen.findByText(/accounting\.obRowsRead/)).toBeTruthy()
    fireEvent.click(screen.getByText('accounting.bankImport'))
    await waitFor(() => expect(ob.setRows).toHaveBeenCalledWith('b1', 'receivables', [
      { party: 'ACME', doc_no: 'A-1', doc_date: '2023-11-15', amount: '100.00' },
      { party: 'Bob', doc_no: 'A-2', doc_date: '2023-11-16', amount: '5.00' },
    ]))
    // the database's row 2 is the file's data row 3 (a blank row was skipped)
    expect(await screen.findByText('accounting.obRowError:{"row":3,"error":"no single customer matches Bob"}')).toBeTruthy()
  })

  it('posting warns that equity will not be zero, then posts', async () => {
    wrap(<OpeningBalancesTab currentUserRole="admin" />)
    await screen.findByLabelText('accounting.obSummary')
    fireEvent.click(screen.getByText('accounting.obPost'))
    expect(await screen.findByText(/accounting\.obPostWarnEquity/)).toBeTruthy()
    const confirmBtn = screen.getAllByText('accounting.obPost').at(-1)
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(ob.post).toHaveBeenCalledWith('b1'))
  })

  it('a manager reads the batch but is offered no action', async () => {
    wrap(<OpeningBalancesTab currentUserRole="manager" />)
    await screen.findByLabelText('accounting.obSummary')
    expect(screen.queryByText('accounting.obImport')).toBeNull()
    expect(screen.queryByText('accounting.obPost')).toBeNull()
    expect(screen.queryByText('accounting.bankDelete')).toBeNull()
  })

  it('with none yet, an accountant starts one on the chosen date', async () => {
    ob.current.mockImplementationOnce(() => Promise.resolve(null))
    wrap(<OpeningBalancesTab currentUserRole="accountant" />)
    fireEvent.change(await screen.findByLabelText(/accounting\.obOpeningDate/), { target: { value: '2023-12-31' } })
    fireEvent.click(screen.getByText('accounting.obStart'))
    await waitFor(() => expect(ob.create).toHaveBeenCalledWith('2023-12-31', null))
  })

  it('a posted batch is reversed only with a reason of 10 characters', async () => {
    ob.current.mockImplementation(() => Promise.resolve({ ...DRAFT, status: 'posted' }))
    wrap(<OpeningBalancesTab currentUserRole="accountant" />)
    await screen.findByLabelText('accounting.obSummary')
    expect(screen.queryByText('accounting.obImport')).toBeNull()
    fireEvent.click(screen.getByText('accounting.obReverse'))
    const go = screen.getAllByText('accounting.obReverse').at(-1).closest('button')
    fireEvent.change(screen.getByLabelText(/accounting\.obReason/), { target: { value: 'too short' } })
    expect(go.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/accounting\.obReason/), { target: { value: 'entered the wrong month' } })
    fireEvent.click(go)
    await waitFor(() => expect(ob.reverse).toHaveBeenCalledWith('b1', 'entered the wrong month'))
    ob.current.mockImplementation(() => Promise.resolve(DRAFT))
  })
})
