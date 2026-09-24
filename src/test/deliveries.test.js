// P-01a (20260894): deliveries. Pins the shape of the migration so a later
// edit cannot quietly drop a guard; supabase/tests/deliveries.sql is the
// behavioural reference script (run against staging, rolled back).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { BACKUP_TABLES } from '../api/backup.js'

const sql = readFileSync('supabase/migrations/20260894_deliveries.sql', 'utf8')
const fn = (name) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return sql.slice(start, sql.indexOf('$fn$;', start))
}

describe('20260894 deliveries', () => {
  it('only managers and above create, confirm or cancel a delivery (fail closed)', () => {
    for (const f of ['create_delivery', 'confirm_delivery', 'cancel_delivery']) {
      expect(fn(f)).toMatch(/COALESCE\(public\.rma_is_manager_or_above\(\), false\)/)
    }
  })

  it('never delivers more than is still open, and never a service line', () => {
    const body = fn('create_delivery')
    expect(body).toMatch(/rma_so_line_delivered_qty/)
    expect(body).toMatch(/service/)
  })

  it('keeps the two paths apart', () => {
    expect(fn('create_delivery')).toMatch(/delivery_id IS NULL/)
    expect(sql).toMatch(/convert_so_to_invoice/)
  })

  it('numbers deliveries DN- and teaches the restore reconciler about them', () => {
    expect(sql).toMatch(/WHEN ''delivery''\s+THEN ''DN''/)
    expect(sql).toMatch(/rma_reconcile_document_sequences/)
  })

  it('an order with shipped goods cannot be cancelled, and the rep check fails closed (review)', () => {
    expect(sql).toMatch(/Goods have been delivered on this order/)
    // the migration writes the new guard as an E'' string, so its newlines are the two characters \n
    expect(sql).toContain(
      String.raw`IF NOT COALESCE(public.rma_is_manager_or_above()\n          OR v_so.assigned_rep = v_email\n          OR v_so.created_by  = v_email, false) THEN`,
    )
    expect(sql).toMatch(/what confirmed deliveries took/)
    expect(sql).toContain('CREATE TRIGGER trg_audit_deliveries AFTER INSERT OR DELETE OR UPDATE ON public.deliveries')
  })

  it('the delivery tables are procedure-only', () => {
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE[^;]*FROM authenticated/)
    const loop = sql.slice(sql.indexOf('REVOKE INSERT, UPDATE, DELETE, TRUNCATE') - 400, sql.indexOf('REVOKE INSERT, UPDATE, DELETE, TRUNCATE'))
    for (const t of ['deliveries', 'delivery_lines', 'delivery_line_units', 'delivery_line_bins']) expect(loop, t).toContain(`'${t}'`)
  })

  it('backs up deliveries after orders and stock, before invoices', () => {
    const order = BACKUP_TABLES.map((t) => t.table)
    const at = (t) => order.indexOf(t)
    for (const t of ['deliveries', 'delivery_lines', 'delivery_line_units', 'delivery_line_bins']) {
      expect(at(t), t).toBeGreaterThan(at('sales_order_lines'))
      expect(at(t), t).toBeGreaterThan(at('inventory_units'))
      expect(at(t), t).toBeGreaterThan(at('warehouse_stock'))
      expect(at(t), t).toBeLessThan(at('crm_invoices'))
    }
    expect(at('deliveries')).toBeLessThan(at('delivery_lines'))
  })
})
