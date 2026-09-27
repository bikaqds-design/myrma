// ledgerScreens.test.js — A-01c: the ledger screens' pure helpers, and the API
// wiring (journals are only read; the posting engine writes them).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import {
  POSTING_ROLES, SOURCE_TYPE_KEYS, accountName, chartRows, entryTotal, sourceLink, trialBalanceTotals, validateAccount,
} from '../pages/Accounting/_ledger'

describe('ledger helpers', () => {
  it('links invoices, credit notes and supplier invoices to their pages; nothing else', () => {
    expect(sourceLink({ source_type: 'crm_invoice', source_id: 'I1' })).toBe('/sales/invoice/I1')
    expect(sourceLink({ source_type: 'credit_note', source_id: 'C1' })).toBe('/sales/credit_note/C1')
    expect(sourceLink({ source_type: 'vendor_invoice', source_id: 'V1' })).toBe('/purchasing/vendor_invoice/V1')
    expect(sourceLink({ source_type: 'payment', source_id: 'P1' })).toBeNull()
    expect(sourceLink({ source_type: 'crm_invoice', source_id: null })).toBeNull()
  })

  it('names every source type the posting triggers use', () => {
    const sales = readFileSync('supabase/migrations/20260906_gl_sales_postings.sql', 'utf8')
    const purchase = readFileSync('supabase/migrations/20260907_gl_purchase_postings.sql', 'utf8')
    const used = new Set([...(sales + purchase).matchAll(/_gl_post\('([a-z_]+)'/g)].map((m) => m[1]))
    for (const type of used) expect(SOURCE_TYPE_KEYS, type).toHaveProperty(type)
  })

  it('offers exactly the posting roles the database accepts', () => {
    // the latest migration that redefines the role list (20260909 adds bank)
    const sql = readFileSync('supabase/migrations/20260909_cash_and_bank.sql', 'utf8')
    const check = sql.match(/ADD CONSTRAINT posting_rules_role_check CHECK \(role IN \(([\s\S]*?)\)\);/)[1]
    const roles = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    expect([...POSTING_ROLES].sort()).toEqual(roles)
  })

  it('shows the Arabic name when there is one and the page is in Arabic', () => {
    expect(accountName({ name: 'Bank', name_ar: 'البنك' }, 'ar')).toBe('البنك')
    expect(accountName({ name: 'Bank', name_ar: null }, 'ar')).toBe('Bank')
    expect(accountName({ name: 'Bank', name_ar: 'البنك' }, 'en')).toBe('Bank')
  })

  it('totals an entry by its debits, and a trial balance in cents', () => {
    expect(entryTotal({ journal_lines: [{ debit: 115, credit: 0 }, { debit: 0, credit: 100 }, { debit: 0, credit: 15 }] })).toBe(115)
    expect(trialBalanceTotals([{ debit: 0.1, credit: 0 }, { debit: 0.2, credit: 0.3 }])).toEqual({ debit: 0.3, credit: 0.3, balanced: true })
    expect(trialBalanceTotals([{ debit: 10, credit: 9.99 }]).balanced).toBe(false)
  })

  it('lays the chart out as a tree in code order, keeping an orphan', () => {
    const rows = chartRows([
      { id: 'h2', code: '2000', parent_id: null },
      { id: 'a', code: '1200', parent_id: 'h1' },
      { id: 'h1', code: '1000', parent_id: null },
      { id: 'b', code: '1100', parent_id: 'h1' },
      { id: 'x', code: '9000', parent_id: 'gone' },
    ])
    expect(rows.map((r) => `${r.code}:${r.depth}`)).toEqual(['1000:0', '1100:1', '1200:1', '2000:0', '9000:0'])
  })

  it('names what is wrong with a new account before the round trip', () => {
    expect(validateAccount({ code: '', name: 'X', account_type: 'asset' })).toBe('accounting.glErrCode')
    expect(validateAccount({ code: ' 12', name: 'X', account_type: 'asset' })).toBe('accounting.glErrCodeSpaces')
    expect(validateAccount({ code: '12', name: ' ', account_type: 'asset' })).toBe('accounting.glErrName')
    expect(validateAccount({ code: '12', name: 'X', account_type: 'other' })).toBe('accounting.glErrType')
    expect(validateAccount({ code: '12', name: 'X', account_type: 'income' })).toBeNull()
  })
})

describe('ledger API', () => {
  const api = readFileSync('src/api/db/ledger.ts', 'utf8')
  it('never writes a journal or calls the posting engine', () => {
    expect(api).not.toMatch(/from\('journal_(entries|lines)'\)\.(insert|update|upsert|delete)/)
    expect(api).not.toMatch(/_gl_(post|reverse)/)
  })
  it('no ledger screen queries the database directly (only through db.ledger)', () => {
    const files = [
      ...readdirSync('src/pages/Accounting').map((f) => `src/pages/Accounting/${f}`),
      'src/pages/cp/ChartOfAccounts.jsx',
    ].filter((f) => /\.(jsx?|tsx?)$/.test(f))
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/from\(['"]journal_|supabase\./)
  })
})
