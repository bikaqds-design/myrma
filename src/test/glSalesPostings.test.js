// glSalesPostings.test.js — A-01b sales side (20260906). Pins the posting map
// in the migration; supabase/tests/gl_sales_postings.sql (22) and the ledger
// section of supabase/tests/invoice_from_delivery.sql (through the real RPCs)
// are the rolled-back reference scripts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260906_gl_sales_postings.sql', 'utf8')
const fn = (name) => {
  const at = sql.indexOf(`FUNCTION public.${name}()`)
  expect(at, `${name} is defined`).toBeGreaterThan(-1)
  return sql.slice(at, sql.indexOf('$fn$;', at))
}
const TRIGGERS = {
  rma_gl_post_crm_invoice: /CREATE TRIGGER trg_crm_invoices_gl AFTER UPDATE OF doc_status, cogs_base ON public\.crm_invoices/,
  rma_gl_post_credit_note: /CREATE TRIGGER trg_credit_notes_gl AFTER UPDATE OF status ON public\.credit_notes/,
  rma_gl_post_payment: /CREATE TRIGGER trg_payments_gl AFTER INSERT OR UPDATE OF status ON public\.payments/,
  rma_gl_post_customer_refund: /CREATE TRIGGER trg_customer_refunds_gl AFTER UPDATE OF status ON public\.customer_refunds/,
  rma_gl_post_delivery: /CREATE TRIGGER trg_deliveries_gl AFTER UPDATE OF status ON public\.deliveries/,
  rma_gl_post_customer_return: /CREATE TRIGGER trg_customer_returns_gl AFTER UPDATE OF status ON public\.customer_returns/,
}

describe('sales postings (A-01b)', () => {
  it('posts from a trigger on every step, so every path to it posts', () => {
    for (const re of Object.values(TRIGGERS)) expect(sql).toMatch(re)
  })

  it('posts only through the engine, and a restore posts nothing', () => {
    for (const name of Object.keys(TRIGGERS)) {
      const body = fn(name)
      expect(body, name).toContain(`IF current_setting('rma.audit_suspended', true) = 'on' THEN`)
      expect(body, name).toMatch(/public\._gl_(post|reverse)\(/)
      expect(body, name).not.toMatch(/INSERT INTO public\.journal_/)
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC, anon, authenticated;`)
    }
  })

  it('an invoice: receivables total, revenue net of tax, VAT; the cost of goods only on a whole-order invoice', () => {
    const body = fn('rma_gl_post_crm_invoice')
    expect(body).toMatch(/'role', 'accounts_receivable', 'debit', v_total, 'customer_id', NEW\.customer_id/)
    expect(body).toMatch(/'role', 'sales_revenue', 'credit', v_total - v_tax/)
    expect(body).toMatch(/'role', 'sales_tax_payable', 'credit', v_tax/)
    expect(body).toMatch(/IF NEW\.delivery_id IS NULL AND COALESCE\(NEW\.cogs_base, 0\) > 0 THEN/)
    expect(body).toMatch(/_gl_reverse\('crm_invoice', NEW\.id, 'posted', 'voided'/)
    expect(body).toMatch(/_gl_reverse\('crm_invoice', NEW\.id, 'cogs', 'voided_cogs'/)
  })

  it('a credit note is the mirror of an invoice, and posts once however it is applied', () => {
    const body = fn('rma_gl_post_credit_note')
    expect(body).toContain(`IF NEW.status IN ('issued', 'applied') AND OLD.status NOT IN ('issued', 'applied') THEN`)
    expect(body).toMatch(/'role', 'accounts_receivable', 'credit', v_total, 'customer_id', NEW\.customer_id/)
  })

  it('money in and out: payments and refunds on their own dates, cash against receivables', () => {
    expect(fn('rma_gl_post_payment')).toMatch(/_gl_post\('payment', NEW\.id, 'recorded', COALESCE\(NEW\.payment_date, public\.rma_today\(\)\)/)
    expect(fn('rma_gl_post_payment')).toMatch(/_gl_reverse\('payment', NEW\.id, 'recorded', 'voided'/)
    expect(fn('rma_gl_post_customer_refund')).toMatch(/_gl_post\('customer_refund', NEW\.id, 'approved', COALESCE\(NEW\.refund_date, public\.rma_today\(\)\)/)
  })

  it("goods: a delivery posts its lines' cost out, a return its lines' cost back", () => {
    expect(fn('rma_gl_post_delivery')).toContain('SELECT COALESCE(sum(cogs_base), 0) INTO v_cost FROM public.delivery_lines WHERE delivery_id = NEW.id;')
    expect(fn('rma_gl_post_customer_return')).toContain('SELECT COALESCE(sum(cost_base), 0) INTO v_cost FROM public.customer_return_lines WHERE customer_return_id = NEW.id;')
  })
})
