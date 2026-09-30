/**
 * openingBalances.test.js — B-03a (20260921). Owner decisions 2026-09-30:
 * customers and suppliers bring each open invoice / bill; the figures come in
 * by CSV and are reviewed before posting; everything posts against Opening
 * balance equity; finance can reverse until the month is closed.
 * supabase/tests/opening_balances.sql (34 checks, rolled back) is the
 * database half; this pins the migration's shape.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SQL = readFileSync('supabase/migrations/20260921_opening_balances.sql', 'utf8').replace(/\r\n/g, '\n')

describe('opening balances', () => {
  it('open invoices and bills become real documents flagged as opening, each with its own entry', () => {
    expect(SQL).toContain('ALTER TABLE public.crm_invoices    ADD COLUMN IF NOT EXISTS is_opening boolean NOT NULL DEFAULT false;')
    expect(SQL).toContain("PERFORM public._gl_post('crm_invoice', v_id, 'opening', v_d, v_code,")
    expect(SQL).toContain("PERFORM public._gl_post('vendor_invoice', v_id, 'opening', v_d, v_code,")
    expect(SQL).toContain("v_code := 'OB-' || v_r.doc_no;")
  })

  it('the trial balance posts every account but the three the detail posts, against opening balance equity', () => {
    expect(SQL).toContain("WHERE r.role IN ('accounts_receivable', 'accounts_payable', 'inventory')")
    expect(SQL).toContain("AND a.account_id NOT IN (SELECT account_id FROM public._opening_balance_control_accounts());")
    expect(SQL).toContain("jsonb_build_object('role', 'opening_balance_equity',")
    expect(SQL).toContain("'equity_difference', -(v_other + v_rec - v_pay + v_stock),")
  })

  it('a section with a bad row stores nothing and names every bad row', () => {
    expect(SQL).toContain("RETURN jsonb_build_object('stored', 0, 'errors', v_errs);")
    expect(SQL).toContain("v_errs := v_errs || jsonb_build_object('row', i, 'error', v_msg);")
  })

  it('is for finance, one batch at a time, and procedure-only', () => {
    expect(SQL).toContain("RAISE EXCEPTION 'Only administrators and accountants can enter opening balances.' USING ERRCODE = '42501';")
    expect(SQL).toContain("ON public.opening_balance_batches ((true)) WHERE status IN ('draft', 'posted');")
    expect(SQL).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.opening_balance_batches,')
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public._opening_balance_resolve_party(text, text) FROM PUBLIC, anon, authenticated;')
  })

  it('reverses only while nothing has used them; an opening document is not voided on its own', () => {
    expect(SQL).toContain('Already paid or credited, so the opening balances can no longer be reversed')
    expect(SQL).toContain('Opening stock has moved since, so the opening balances can no longer be reversed')
    expect(SQL).toContain("An opening-balance invoice is not voided on its own: credit it with a credit note, or reverse the opening balances.")
  })

  it('opening invoices stay out of revenue: margin, the report list, the financial and sales reports', () => {
    expect(SQL).toContain("'WHERE i.doc_status = ''posted''::text AND NOT i.is_opening) m'")
    expect(SQL).toContain("E'\\n  WHERE NOT i.is_opening'")
    expect(SQL).toContain("RAISE EXCEPTION 'A report still counts opening invoices';")
    expect(SQL).toContain("RAISE EXCEPTION 'A replaced view lost security_invoker';")
  })

  it('stock arrives at its stated cost, unknown when blank, under its own ledger kind', () => {
    expect(SQL).toContain("'goods_receipt', 'customer_return', 'opening_balance']));")
    expect(SQL).toContain("PERFORM set_config('rma.cost_stated', 'on', true);")
    expect(SQL).toContain("VALUES ('unit', v_unit, 'opening_balance', p_batch, 'receive', 1, NULL, 'available', v_actor);")
  })
})
