// baseCurrencyReporting.test.js — A-05b part 2 (20260913): statements, aging,
// reports and the month-end checklist add money in the base currency, each
// document at its own rate, and the statements carry the realised exchange
// differences so they equal the ledger. The database behaviour is proved by
// supabase/tests/base_currency_reporting.sql (14 checks, rolled back); this
// pins the migration's shape and the screens' arithmetic.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { EXCHANGE_DIFFERENCE, baseAmount, statementBalance, statementLines } from '../lib/statementLines'

const sql = readFileSync('supabase/migrations/20260913_base_currency_reporting.sql', 'utf8').replace(/\r\n/g, '\n')
const section = (start, end) => sql.slice(sql.indexOf(start), end ? sql.indexOf(end, sql.indexOf(start)) : undefined)

describe('20260913 — the database adds in base currency', () => {
  it('every replaced view keeps security_invoker (RLS still applies to the reader)', () => {
    for (const v of ['v_customer_ledger', 'v_vendor_ledger', 'v_report_invoices', 'v_invoice_margin']) {
      expect(sql, v).toContain(`CREATE OR REPLACE VIEW public.${v} WITH (security_invoker = true) AS`)
    }
  })

  it('the customer statement converts each entry at its own rate and carries the exchange differences', () => {
    const v = section('CREATE OR REPLACE VIEW public.v_customer_ledger', 'CREATE OR REPLACE VIEW public.v_vendor_ledger')
    for (const t of ['crm_invoices.total', 'credit_notes.total', 'payments.amount', 'customer_refunds.amount']) {
      expect(v, t).toContain(`round(${t} * COALESCE(${t.split('.')[0]}.exchange_rate, 1), 2)`)
    }
    expect(v).toContain("'exchange_difference'::text")
    // the same difference rma_gl_post_ar_fx posts, with the receivable's sign
    expect(v).toContain('round(pa.amount_applied * COALESCE(p.exchange_rate, 1), 2)\n              - round(pa.amount_applied * COALESCE(i.exchange_rate, 1), 2)')
    expect(v).toContain('round(ca.amount_applied * COALESCE(cn.exchange_rate, 1), 2)\n              - round(ca.amount_applied * COALESCE(i.exchange_rate, 1), 2)')
    // new columns only at the end: CREATE OR REPLACE VIEW cannot reorder
    expect(v.indexOf('crm_invoices.created_at,')).toBeLessThan(v.indexOf('crm_invoices.currency,'))
  })

  it('the supplier statement carries its exchange differences (rma_gl_post_ap_fx)', () => {
    const v = section('CREATE OR REPLACE VIEW public.v_vendor_ledger', 'CREATE OR REPLACE FUNCTION public.rma_ar_aging')
    expect(v).toContain("'exchange_difference'::text")
    expect(v).toContain('round(va.amount_applied * COALESCE(vp.exchange_rate, 1), 2)\n              - round(va.amount_applied * COALESCE(vi.exchange_rate, 1), 2)')
  })

  it('receivables aging values each open invoice at its own rate, like payables aging', () => {
    const f = section('CREATE OR REPLACE FUNCTION public.rma_ar_aging', 'CREATE OR REPLACE FUNCTION public.rma_report_financial')
    expect(f).toContain('round(remaining * rate, 2) AS remaining_base')
    expect(f).not.toMatch(/sum\(o\.remaining\)/)
  })

  it('the financial and sales reports add base amounts and say which currency', () => {
    const fin = section('CREATE OR REPLACE FUNCTION public.rma_report_financial', 'CREATE OR REPLACE FUNCTION public.rma_report_sales')
    const sales = section('CREATE OR REPLACE FUNCTION public.rma_report_sales', 'CREATE OR REPLACE VIEW public.v_report_invoices')
    for (const f of [fin, sales]) {
      expect(f).toContain("'currency', public.rma_base_currency()")
      expect(f).not.toMatch(/sum\(coalesce\((total|amount), 0\)\)/)
    }
  })

  it('margin revenue is the net amount at the invoice rate, typed as before', () => {
    const v = section('CREATE OR REPLACE VIEW public.v_invoice_margin', '-- ── 7.')
    expect(v).toContain('round((COALESCE(i.total, 0) - COALESCE(i.tax_amount, 0)) * COALESCE(i.exchange_rate, 1), 2)::numeric(12,2) AS revenue_base')
  })

  it('the month-end checklist rewrite counts each of its five anchors and refuses otherwise', () => {
    const b = section('-- ── 7. the month-end checklist')
    expect((b.match(/COALESCE\(sum\(total\), 0\)::numeric'/g) || []).length).toBe(3)
    expect(b).toContain("sum(vp.amount), 0)::numeric'")
    expect(b).toContain("sum(r.amount), 0)::numeric'")
    expect(b).toContain('<> 1 THEN')
    expect(b).toContain("Refusing to apply: rma_period_close_checklist does not read as expected")
    expect(b).toContain("Refusing to finish: the close checklist still adds document-currency amounts")
  })
})

describe('statementLines — the statements’ arithmetic', () => {
  // A USD invoice of 114 at 51, paid at 53 (the reference script's case), next
  // to a local invoice of 1,140.
  const entries = [
    { id: 'i1', entry_type: 'invoice', amount: 114, currency: 'USD', exchange_rate: 51, amount_base: 5814 },
    { id: 'i2', entry_type: 'invoice', amount: 1140, currency: 'EGP', exchange_rate: 1, amount_base: 1140 },
    { id: 'p1', entry_type: 'payment', amount: -114, currency: 'USD', exchange_rate: 53, amount_base: -6042 },
    { id: 'x1', entry_type: EXCHANGE_DIFFERENCE, amount: 0, currency: 'USD', exchange_rate: null, amount_base: 228 },
  ]

  it('runs the balance in base: the USD invoice is settled to 0, the local one remains', () => {
    const lines = statementLines(entries, 'EGP')
    expect(lines.map((l) => l.running)).toEqual([5814, 6954, 912, 1140])
    expect(statementBalance(entries)).toBe(1140)
  })

  it('shows each entry in its own currency, and an exchange difference in base', () => {
    const lines = statementLines(entries, 'EGP')
    expect(lines[0].shown).toEqual({ value: 114, currency: 'USD' })
    expect(lines[2].shown).toEqual({ value: -114, currency: 'USD' })
    expect(lines[3].shown).toEqual({ value: 228, currency: 'EGP' })
  })

  it('adds in cents, so many small entries do not drift', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: String(i), entry_type: 'invoice', amount: 0.1, amount_base: 0.1 }))
    expect(statementBalance(many)).toBe(1)
    expect(statementLines(many, 'EGP').at(-1).running).toBe(1)
  })

  it('falls back to the own amount for a row with no base amount', () => {
    expect(baseAmount({ amount: 50 })).toBe(50)
    expect(statementBalance([{ amount: 50, currency: null }])).toBe(50)
    expect(statementLines([{ id: 'a', amount: 50, currency: null }], 'EGP')[0].shown.currency).toBe('EGP')
  })
})

describe('the screens add in base', () => {
  const customer = readFileSync('src/pages/CustomerDetails.jsx', 'utf8')
  const vendor = readFileSync('src/pages/Purchasing/VendorDetails.jsx', 'utf8')
  const reports = readFileSync('src/pages/Reports.jsx', 'utf8')

  it('both statements run their balance through statementLines, not over own-currency amounts', () => {
    for (const [name, src] of [['CustomerDetails', customer], ['VendorDetails', vendor]]) {
      expect(src, name).toContain('statementLines(ledger, baseCurrency)')
      expect(src, name).toContain('statementBalance(ledger)')
      expect(src, name).not.toMatch(/running \+= Number\(entry\.amount\)/)
      expect(src, name).toContain('[EXCHANGE_DIFFERENCE]:')
    }
    expect(customer).not.toMatch(/ledger\.reduce\(\(sum, e\) => sum \+ \(Number\(e\.amount\)/)
  })

  it('the Reports invoice table prints each invoice in its own currency and exports the base amount', () => {
    expect(reports).toContain('formatMoney(Number(inv.total) || 0, inv.currency || baseCurrency)')
    expect(reports).toContain("amount_base: Number(i.total_base ?? i.total) || 0")
  })
})
