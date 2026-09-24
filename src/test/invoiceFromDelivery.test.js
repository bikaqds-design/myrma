// P-02a (20260896): invoice what a delivery shipped. Pins the shape of the
// migration; supabase/tests/invoice_from_delivery.sql is the behavioural
// reference script (run against staging, rolled back).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260896_invoice_from_delivery.sql', 'utf8')
const create = sql.slice(
  sql.indexOf('FUNCTION public.create_invoice_from_delivery('),
  sql.indexOf('$fn$;', sql.indexOf('FUNCTION public.create_invoice_from_delivery(')),
)

describe('20260896 invoice from a delivery', () => {
  it('one live invoice per delivery; one per order only for whole-order invoices', () => {
    expect(sql).toMatch(/crm_invoices_one_live_per_so_idx ON public\.crm_invoices \(so_id\)\s+WHERE so_id IS NOT NULL AND delivery_id IS NULL AND doc_status <> 'cancelled'/)
    expect(sql).toMatch(/crm_invoices_one_live_per_delivery_idx ON public\.crm_invoices \(delivery_id\)\s+WHERE delivery_id IS NOT NULL AND doc_status <> 'cancelled'/)
  })

  it('invoices only a confirmed delivery, once, as manager+ or the order\'s rep (fail closed)', () => {
    expect(create).toMatch(/v_d\.status <> 'confirmed'/)
    expect(create).toMatch(/already been invoiced/)
    expect(create).toMatch(/IF NOT COALESCE\(\s*public\.rma_is_manager_or_above\(\)/)
    expect(create).toMatch(/v_actor text := public\.rma_current_user_email\(\)/)
  })

  it('bills what shipped at the order line\'s price, discount and tax', () => {
    expect(create).toMatch(/'qty', dl\.qty, 'unit_price', sol\.unit_price, 'discount_pct', sol\.discount_pct, 'tax_pct', sol\.tax_pct/)
    expect(create).toMatch(/_crm_invoice_write_lines\(v_id, v_src\)/)
  })

  it('locks the delivery before its order, like confirm_delivery', () => {
    expect(create.indexOf('FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE')).toBeLessThan(
      create.indexOf('FROM public.sales_orders WHERE id = v_d.sales_order_id FOR UPDATE'),
    )
  })

  it('post_invoice and void_invoice leave stock alone for a delivery invoice; its cost is the delivery\'s', () => {
    expect(sql).toMatch(/post_invoice has % order branches, expected 3/)
    expect(sql).toMatch(/void_invoice has % order branches, expected 2/)
    expect(sql).toContain("'IF v_inv.so_id IS NOT NULL AND v_inv.delivery_id IS NULL THEN'")
    expect(sql).toMatch(/SUM\(dl\.cogs_base\)/)
    expect(sql).toMatch(/rma_invoice_cogs/)
  })

  it("a return against one delivery's invoice restores only units that delivery shipped (review)", () => {
    expect(sql).toContain('SELECT i.so_id, i.delivery_id INTO v_so_id, v_delivery_id FROM public.crm_invoices i WHERE i.id = p_doc_id;')
    expect(sql).toContain('OR (v_delivery_id IS NOT NULL AND NOT EXISTS (')
    expect(sql).toContain('WHERE dl.delivery_id = v_delivery_id AND dlu.unit_id = u.unit_id')
  })

  it('only a whole-order invoice ends the back-order integrity check; cost is manager/accountant only (review)', () => {
    expect(sql).toContain('WHERE i.so_id = so.id AND i.delivery_id IS NULL);')
    expect(sql).toContain("IF NOT COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = ''accountant'', false) THEN")
  })

  it('anon cannot execute it', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.create_invoice_from_delivery\(uuid, text\) FROM PUBLIC, anon;/)
  })
})
