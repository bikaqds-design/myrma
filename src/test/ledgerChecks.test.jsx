/**
 * ledgerChecks.test.jsx — A-08b (20260917): the ledger against the customer
 * and supplier statements and the stock. supabase/tests/subledger_reconciliation.sql
 * (20 checks, rolled back) is the database half; this pins the helpers, the
 * wiring and the screen (the assistant cannot sign in, so the render tests are
 * the screen check).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import React from 'react'
import { readFileSync } from 'node:fs'
import { areaMatches, differenceReason, reconDocLink } from '../pages/Accounting/_reports'

const read = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')

describe('helpers', () => {
  it('links documents that have a page, by statement or ledger name', () => {
    expect(reconDocLink({ doc_type: 'invoice', doc_id: 'i1' })).toBe('/sales/invoice/i1')
    expect(reconDocLink({ doc_type: 'crm_invoice', doc_id: 'i1' })).toBe('/sales/invoice/i1')
    expect(reconDocLink({ doc_type: 'credit_note', doc_id: 'c1' })).toBe('/sales/credit_note/c1')
    expect(reconDocLink({ doc_type: 'vendor_invoice', doc_id: 'v1' })).toBe('/purchasing/vendor_invoice/v1')
    expect(reconDocLink({ doc_type: 'payment', doc_id: 'p1' })).toBeNull()
  })

  it('says why a document differs', () => {
    expect(differenceReason({ in_ledger: false, before_ledger: true })).toBe('accounting.recReasonBeforeLedger')
    expect(differenceReason({ in_ledger: false, before_ledger: false })).toBe('accounting.recReasonNotPosted')
    expect(differenceReason({ in_ledger: true, subledger_amount: 0 })).toBe('accounting.recReasonNoDocument')
    expect(differenceReason({ in_ledger: true, subledger_amount: 100 })).toBe('accounting.recReasonAmounts')
  })

  it('an area agrees to the cent', () => {
    expect(areaMatches({ difference: 0.004 })).toBe(true)
    expect(areaMatches({ difference: 0.01 })).toBe(false)
  })
})

describe('wiring', () => {
  it('the API calls both functions, paging in the database', () => {
    const api = read('src/api/db/ledger.ts')
    expect(api).toContain("supabase.rpc('rma_subledger_reconciliation')")
    expect(api).toContain("supabase.rpc('rma_subledger_differences', {")
  })

  it('the migration guards both reports, keeps the internal ones from clients, and matches per document', () => {
    const sql = read('supabase/migrations/20260917_subledger_reconciliation.sql')
    expect(sql.match(/IF NOT COALESCE\(public\.rma_can_handle_cash\(\), false\) THEN/g)).toHaveLength(2)
    expect(sql).toContain('REVOKE ALL ON FUNCTION public._rma_subledger_rows(text) FROM PUBLIC, anon, authenticated;')
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.rma_subledger_reconciliation() FROM PUBLIC, anon;')
    expect(sql.match(/FROM sub s FULL JOIN led g ON g\.id = s\.id/g)).toHaveLength(2)
    // "before the ledger" is judged against the first posting on that same account
    expect(sql).toContain('(v_start IS NULL OR s.ts < v_start)')
  })

  it('the tab is offered to the ledger roles', () => {
    expect(read('src/pages/Accounting/index.jsx')).toContain("{tab === 'ledger_checks' && canSeeLedger && <LedgerChecksTab />}")
  })

  it('every string exists in both languages', () => {
    const en = JSON.parse(read('src/locales/en.json')).accounting
    const ar = JSON.parse(read('src/locales/ar.json')).accounting
    const keys = new Set(['tabLedgerChecks'])
    for (const f of ['LedgerChecksTab.jsx', '_reports.js']) for (const m of read(`src/pages/Accounting/${f}`).matchAll(/'accounting\.(rec\w+)'/g)) keys.add(m[1])
    for (const a of ['receivables', 'payables', 'inventory']) { keys.add(`recArea_${a}`); keys.add(`recRecords_${a}`) }
    for (const d of ['invoice', 'credit_note', 'payment', 'refund', 'exchange_difference', 'vendor_invoice', 'vendor_payment']) keys.add(`recDoc_${d}`)
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
const SUMMARY = [
  { area: 'receivables', account_id: 'a1', account_code: '1200', account_name: 'Accounts receivable', account_name_ar: null,
    ledger_balance: -640, subledger_balance: -60, difference: 580, documents_differing: 1, documents_before_ledger: 1, uncosted_units: null },
  { area: 'payables', account_id: 'a2', account_code: '2100', account_name: 'Accounts payable', account_name_ar: null,
    ledger_balance: 0, subledger_balance: 0, difference: 0, documents_differing: 0, documents_before_ledger: 0, uncosted_units: null },
  { area: 'inventory', account_id: 'a3', account_code: '1300', account_name: 'Inventory', account_name_ar: null,
    ledger_balance: 140, subledger_balance: 610, difference: 470, documents_differing: null, documents_before_ledger: null, uncosted_units: 2 },
]
const ledger = {
  reconciliation: vi.fn(() => Promise.resolve(SUMMARY)),
  reconciliationDifferences: vi.fn(() => Promise.resolve({
    data: [{ doc_type: 'invoice', doc_id: 'inv1', doc_code: 'INV-2026-00001', party_id: 'c1', party_name: 'Acme', doc_date: '2026-09-20',
      subledger_amount: 580, ledger_amount: 0, difference: 580, in_ledger: false, before_ledger: true, total_count: 1 }],
    count: 1,
  })),
}
vi.mock('../api/supabaseClient', () => ({ db: { ledger: new Proxy({}, { get: (_, k) => (...a) => ledger[k](...a) }) } }))
const { default: LedgerChecksTab } = await import('../pages/Accounting/LedgerChecksTab.jsx')

const wrap = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><LedgerChecksTab /></MemoryRouter>
  </QueryClientProvider>,
)

describe('Accounting › Ledger checks', () => {
  beforeEach(() => Object.values(ledger).forEach((f) => f.mockClear()))
  afterEach(cleanup)

  it('shows each area with its figures and whether it agrees', async () => {
    wrap()
    const ar = await screen.findByRole('region', { name: 'accounting.recArea_receivables' })
    expect(within(ar).getByText('accounting.recDiffers')).toBeTruthy()
    expect(within(ar).getByText('580.00')).toBeTruthy()
    expect(within(ar).getByText('accounting.recDocsDiffer:{"count":1,"before":1}')).toBeTruthy()
    const ap = screen.getByRole('region', { name: 'accounting.recArea_payables' })
    expect(within(ap).getByText('accounting.recMatches')).toBeTruthy()
    expect(within(ap).queryByRole('button', { name: 'accounting.recShowDocs' })).toBeNull()
    const inv = screen.getByRole('region', { name: 'accounting.recArea_inventory' })
    expect(within(inv).getByText(/accounting\.recUncosted:\{"count":2\}/)).toBeTruthy()
    expect(within(inv).queryByRole('button', { name: 'accounting.recShowDocs' })).toBeNull()
  })

  it('lists the documents that differ, linked, with the reason', async () => {
    wrap()
    const ar = await screen.findByRole('region', { name: 'accounting.recArea_receivables' })
    fireEvent.click(within(ar).getByRole('button', { name: 'accounting.recShowDocs' }))
    // the documents open full width under the cards
    const link = await screen.findByRole('link', { name: 'INV-2026-00001' })
    expect(link.getAttribute('href')).toBe('/sales/invoice/inv1')
    expect(screen.getByText('accounting.recReasonBeforeLedger')).toBeTruthy()
    expect(screen.getByText('Acme')).toBeTruthy()
    expect(within(ar).getByRole('button', { name: 'accounting.recHideDocs' }).getAttribute('aria-expanded')).toBe('true')
    expect(ledger.reconciliationDifferences).toHaveBeenCalledWith('receivables', 1, 25)
  })
})
