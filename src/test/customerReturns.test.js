// P-05a (20260902): customer returns. Pins the shape of the migration so a later
// edit cannot quietly drop a guard; supabase/tests/customer_returns.sql is the
// behavioural reference script (run against staging, rolled back).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { BACKUP_TABLES } from '../api/backup.js'

const sql = readFileSync('supabase/migrations/20260902_customer_returns.sql', 'utf8')
const fn = (name) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return sql.slice(start, sql.indexOf('$fn$;', start))
}

describe('20260902 customer returns', () => {
  it('only managers and above create, confirm or cancel a return (owner decision; fails closed)', () => {
    for (const f of ['create_customer_return', 'confirm_customer_return', 'cancel_customer_return']) {
      expect(fn(f)).toMatch(/v_actor IS NULL OR NOT COALESCE\(public\.rma_is_manager_or_above\(\), false\)/)
    }
  })

  it('goods first: only from a confirmed delivery whose invoice is posted, checked again at confirmation', () => {
    const create = fn('create_customer_return')
    expect(create).toContain("IF v_d.status <> 'confirmed' THEN")
    expect(create).toMatch(/WHERE delivery_id = p_delivery_id AND doc_status = 'posted'/)
    expect(fn('confirm_customer_return')).toMatch(/WHERE delivery_id = v_did AND doc_status = 'posted'/)
  })

  it('never more than left on the delivery line, drafts counted; whole numbers judged as text', () => {
    const create = fn('create_customer_return')
    expect(create).toMatch(/rma_delivery_line_returned_qty\(v_dl\.id, true\) \+ v_qty > v_dl\.qty/)
    expect(create).toContain("(v_x ->> 'qty') !~ '^[0-9]{1,6}$'")
    expect(fn('confirm_customer_return')).toMatch(/rma_delivery_line_returned_qty\(v_l\.delivery_line_id, false\) \+ v_l\.qty > v_l\.delivered/)
  })

  it('serialized: only units that left on that line, each once, and still with the customer', () => {
    const create = fn('create_customer_return')
    expect(create).toMatch(/FROM public\.delivery_line_units WHERE delivery_line_id = v_dl\.id AND unit_id = v_uid/)
    expect(create).toMatch(/r\.status <> 'cancelled' AND r\.id <> v_r\.id\s+AND v_uid = ANY \(l\.unit_ids\)/)
    expect(fn('confirm_customer_return')).toContain("v_unit.status <> 'company_stock' OR v_unit.reservation_status <> 'delivered'")
  })

  it('back to stock only, at the cost it left with; unknown stays unknown, never 0', () => {
    expect(fn('_rma_warehouse_is_sellable')).toContain("COALESCE(w.warehouse_type, 'main') IN ('main', 'branch')")
    const confirm = fn('confirm_customer_return')
    expect(confirm).toContain('bool_and(b.avg_cost_base IS NOT NULL)')
    expect(confirm).toContain('uncosted_quantity = uncosted_quantity + v_l.qty')
    expect(confirm).toContain("set_config('rma.cost_stated', 'on', true)")
    expect(confirm).toContain("SET reservation_status = 'available', warehouse_id = v_l.warehouse_id")
    expect(confirm).toMatch(/'customer_return', p_return_id, 'restore'/)
  })

  it('a delivery with a return is credited, never voided or invoiced again', () => {
    expect(sql).toContain('it cannot be invoiced again')
    expect(sql).toContain('credit it with a credit note instead of voiding it')
    expect(sql).toMatch(/RAISE EXCEPTION 'Refusing to apply: void_invoice holds its unit restore/)
  })

  it('procedure-only, numbered RTN-, restorable', () => {
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public\.%I FROM authenticated/)
    expect(sql).toContain("REVOKE ALL ON FUNCTION public._rma_warehouse_is_sellable(uuid) FROM PUBLIC, anon, authenticated;")
    expect(sql).toContain("WHEN ''customer_return'' THEN ''RTN''")
    expect(sql).toContain("(''customer_return'', ''customer_returns''")
    const tables = BACKUP_TABLES.map((t) => t.table)
    for (const t of ['customer_returns', 'customer_return_lines', 'customer_return_line_units', 'customer_return_line_bins']) {
      expect(tables.indexOf(t), t).toBeGreaterThan(tables.indexOf('delivery_line_bins'))
      expect(tables.indexOf(t), t).toBeLessThan(tables.indexOf('crm_invoices'))
    }
  })
})
