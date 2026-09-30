/**
 * depositsCreditLimits.test.js — A-06a (20260919). Owner decisions
 * 2026-09-30: over the credit limit is refused unless a manager approves it
 * with a reason; checked at order approval and at posting an invoice not
 * raised from an order; exposure = unpaid invoices + open orders − unused
 * credits; a deposit is a liability until applied.
 * supabase/tests/deposits_credit_limits.sql (22 checks, rolled back) is the
 * database half; this pins the migration's shape.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SQL = readFileSync('supabase/migrations/20260919_deposits_credit_limits.sql', 'utf8').replace(/\r\n/g, '\n')

describe('credit limits', () => {
  it('are checked when an order is approved and when an invoice not from an order is posted', () => {
    expect(SQL).toContain('CREATE TRIGGER trg_sales_orders_credit_limit BEFORE UPDATE OF status ON public.sales_orders')
    expect(SQL).toContain('CREATE TRIGGER trg_crm_invoices_credit_limit BEFORE UPDATE OF doc_status ON public.crm_invoices')
    expect(SQL).toContain('IF NEW.so_id IS NOT NULL OR NEW.delivery_id IS NOT NULL THEN RETURN NEW; END IF;')
    expect(SQL).toContain('IF v_limit IS NULL THEN RETURN NEW; END IF;')
  })

  it('count unpaid invoices and open orders, less unused payments, deposits and credit notes, in the base currency', () => {
    expect(SQL).toContain("WHERE i.customer_id = p_customer_id AND i.doc_status = 'posted'")
    expect(SQL).toContain("WHERE o.customer_id = p_customer_id AND o.status IN ('confirmed', 'delivered')")
    expect(SQL).toContain('SELECT inv.v, ord.v, cr.v, inv.v + ord.v - cr.v FROM inv, ord, cr')
  })

  it('an override is a manager\'s, with a reason, for the amount approved', () => {
    expect(SQL).toContain('IF NOT COALESCE(public.rma_is_manager_or_above(), false) THEN')
    expect(SQL).toContain('IF length(v_reason) < 10 THEN')
    expect(SQL).toContain('COALESCE(NEW.credit_override_total, -1) >= COALESCE(NEW.total, 0)')
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public._rma_credit_exposure(uuid) FROM PUBLIC, anon, authenticated;')
  })
})

describe('deposits', () => {
  it('are payments flagged only by record_customer_deposit, and post to Customer deposits', () => {
    expect(SQL).toContain("IF current_setting('rma.payment_is_deposit', true) = 'on' THEN")
    expect(SQL).toContain("CASE WHEN COALESCE(NEW.is_deposit, false) THEN 'customer_deposits' ELSE 'accounts_receivable' END")
    expect(SQL).toContain("PERFORM set_config('rma.payment_is_deposit', 'on', true);")
  })

  it('move to receivables when applied, and come out of deposits when refunded', () => {
    expect(SQL).toContain('CREATE TRIGGER trg_payment_applications_deposit_gl AFTER INSERT ON public.payment_applications')
    expect(SQL).toContain("WHERE p.id = NEW.payment_id AND p.is_deposit) THEN 'customer_deposits'")
  })

  it('the ledger checks count deposits with receivables', () => {
    expect(SQL.match(/l\.account_id = ANY \(v_accounts\)/g)).toHaveLength(3)
    expect(SQL).toContain("OR (v_area = 'receivables' AND l.account_id IN (SELECT r.account_id FROM public.posting_rules r WHERE r.role = 'customer_deposits'))")
  })
})
