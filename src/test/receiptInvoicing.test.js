// P-03b (20260898): invoicing what was received, and re-costing it from the
// supplier's invoice. Pins the shape of the migration; the behavioural
// reference is supabase/tests/receipt_invoicing.sql (staging, rolled back).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260898_receipt_invoicing.sql', 'utf8')
const fn = (name) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return sql.slice(start, sql.indexOf('$fn$;', start))
}

describe('20260898 receipt invoicing', () => {
  it('bills confirmed receipt lines not yet billed, at the order price, one invoice line per receipt line', () => {
    const create = fn('create_vendor_invoice_from_receipts')
    expect(create).toMatch(/v_actor IS NULL OR NOT COALESCE\(public\.rma_is_manager_or_above\(\), false\)/)
    expect(create).toMatch(/g\.status = 'confirmed'/)
    expect(create).toMatch(/public\.rma_grn_line_billed_by\(gl\.id\) IS NULL/)
    expect(create).toMatch(/'unit_cost', pol\.unit_cost/)
    expect(create).toMatch(/INSERT INTO public\.vendor_invoice_receipt_lines/)
    // the order is locked first, so two clicks cannot bill the same receipt twice
    expect(create.indexOf('FOR UPDATE')).toBeLessThan(create.indexOf('INSERT INTO public.vendor_invoices'))
  })

  it('a receipt-based order is never invoiced whole, and the check comes before the status check', () => {
    expect(sql).toMatch(/This order is received by goods receipts; invoice it from its receipts/)
    expect(sql).toMatch(/v_ins \|\| v_old/)
  })

  it('three-way match: an invoice from receipts keeps their products and quantities', () => {
    expect(sql).toMatch(/l\.product_id IS DISTINCT FROM g\.product_id OR l\.qty_ordered <> g\.qty/)
    expect(sql).toMatch(/its products and quantities are those of the receipts/)
  })

  it('approval re-costs what is on hand and records a variance on what already left', () => {
    const recost = fn('rma_recost_from_vendor_invoice')
    expect(recost).toMatch(/rma_vi_landed_unit_costs\(p_vi_id\)/)
    expect(recost).toMatch(/v_u\.status = 'company_stock' AND v_u\.reservation_status IN \('available', 'reserved'\)/)
    expect(recost).toMatch(/'revalued'/)
    expect(recost).toMatch(/'variance'/)
    // an unpriced invoice line never overwrites a known cost with nothing
    expect(recost).toMatch(/CONTINUE WHEN v_new IS NULL/)
    // unknown becomes known on the bin, never as a zero
    expect(recost).toMatch(/uncosted_quantity = uncosted_quantity - v_n/)
    expect(sql).toMatch(/CREATE TRIGGER trg_vendor_invoices_recost_on_approval\s+AFTER UPDATE OF status ON public\.vendor_invoices/)
  })

  it('no client runs the re-costing or writes the link/adjustment tables', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.rma_recost_from_vendor_invoice\(uuid\) FROM PUBLIC, anon, authenticated;/)
    expect(sql).toMatch(/ARRAY\['vendor_invoice_receipt_lines', 'purchase_cost_adjustments'\]/)
    expect(sql).toMatch(/CREATE POLICY "read_purchase_cost_adjustments"[\s\S]*?rma_is_manager_or_above\(\) OR public\.rma_user_role\(\) = 'accountant'/)
  })

  it('review: shared bins are revalued once, and nothing is clipped silently', () => {
    const recost = fn('rma_recost_from_vendor_invoice')
    expect(recost).toContain('v_seen ->> v_ws.id::text')
    expect(recost).toContain('v_apply := GREATEST(v_want, -v_ws.total_cost_base)')
    expect(recost).not.toContain('GREATEST(0, total_cost_base')
    expect(recost).toContain('IF v_off + v_clip > 0 THEN')
  })

  it('review: an approved invoice from receipts is fixed, and a restore is exempt and not re-costed', () => {
    expect(sql).toContain('cost of its goods is booked; its charges can no longer change')
    expect(sql).toMatch(/CREATE TRIGGER trg_vendor_invoices_receipt_cancel\s+BEFORE UPDATE OF status/)
    const skips = sql.split("current_setting('rma.audit_suspended', true) = 'on'").length - 1
    expect(skips).toBeGreaterThanOrEqual(3)
  })
})
