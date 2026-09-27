// glPurchasePostings.test.js — A-01b purchase side (20260907). Pins the posting
// map in the migration; supabase/tests/gl_purchase_postings.sql (16) and the
// ledger section of supabase/tests/receipt_invoicing.sql (38 in all, through
// the real receipt, invoicing and re-costing RPCs) are the rolled-back
// reference scripts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260907_gl_purchase_postings.sql', 'utf8')
const fn = (name) => {
  const at = sql.indexOf(`FUNCTION public.${name}(`)
  expect(at, `${name} is defined`).toBeGreaterThan(-1)
  return sql.slice(at, sql.indexOf('$fn$;', at))
}
const TRIGGERS = [
  'rma_gl_post_goods_receipt',
  'rma_gl_post_vendor_invoice',
  'rma_gl_post_vendor_invoice_receipt',
  'rma_gl_post_vendor_payment',
]

describe('purchase postings (A-01b)', () => {
  it('posts only through the engine; a restore posts nothing; no client runs the triggers', () => {
    for (const name of TRIGGERS) {
      const body = fn(name)
      expect(body, name).toContain(`IF current_setting('rma.audit_suspended', true) = 'on' THEN`)
      expect(body, name).toMatch(/public\._gl_(post|reverse)\(/)
      expect(body, name).not.toMatch(/INSERT INTO public\.journal_/)
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC, anon, authenticated;`)
    }
  })

  it('posts supplier invoices after the re-costing, so its adjustments exist', () => {
    expect(sql).toMatch(/CREATE TRIGGER trg_vendor_invoices_zz_gl AFTER UPDATE OF status ON public\.vendor_invoices/)
    expect('trg_vendor_invoices_zz_gl' > 'trg_vendor_invoices_recost_on_approval').toBe(true)
  })

  it('clears what the receipts booked — the old cost where the re-costing changed it', () => {
    const body = fn('rma_gl_post_vendor_invoice')
    expect(body).toContain('CASE WHEN a.goods_receipt_line_id IS NOT NULL THEN a.old_unit_cost_base ELSE g.unit_cost_base END')
    expect(body).toMatch(/_gl_line\('purchase_price_variance', v_var \+ v_rest, NEW\.vendor_id\)/)
  })

  it('credits the supplier its total, freight and duties to their own account, and VAT only when not in cost', () => {
    const body = fn('rma_gl_post_vendor_invoice')
    expect(body).toContain('v_ap  := round(COALESCE(NEW.total, 0) * v_rate, 2)')
    expect(body).toMatch(/_gl_line\('accrued_landed_costs', -v_chg, NEW\.vendor_id\)/)
    expect(body).toMatch(/v_vat := CASE WHEN COALESCE\(v_tax_in, false\) THEN 0/)
    expect(sql).toMatch(/'rounding', 'accrued_landed_costs'\)\)/)
    expect(sql).toContain("md5('gl_account:2160')::uuid, '2160'")
  })

  it('goods received on an invoice post once per increase, only on an approved invoice without receipts', () => {
    const body = fn('rma_gl_post_vendor_invoice_receipt')
    expect(body).toContain("'received:' || NEW.line_no || ':' || NEW.qty_received")
    expect(body).toContain("IF v_vi.status NOT IN ('approved', 'partially_received', 'received') THEN")
    expect(body).toMatch(/FROM public\.vendor_invoice_receipt_lines WHERE vendor_invoice_id = NEW\.vendor_invoice_id\) THEN\s+RETURN NULL;/)
  })

  it('vendor payments at their own rate, on their own date; voided: reversed', () => {
    const body = fn('rma_gl_post_vendor_payment')
    expect(body).toContain('v_amt  numeric := round(NEW.amount * COALESCE(NEW.exchange_rate, 1), 2);')
    expect(body).toMatch(/_gl_reverse\('vendor_payment', NEW\.id, 'paid', 'voided'/)
  })
})
