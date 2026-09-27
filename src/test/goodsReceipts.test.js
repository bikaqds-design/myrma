// P-03a (20260897): goods receipts. Pins the shape of the migration so a later
// edit cannot quietly drop a guard; supabase/tests/goods_receipts.sql is the
// behavioural reference script (run against staging, rolled back).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { BACKUP_TABLES } from '../api/backup.js'

const sql = readFileSync('supabase/migrations/20260897_goods_receipts.sql', 'utf8')
const fn = (name) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return sql.slice(start, sql.indexOf('$fn$;', start))
}

describe('20260897 goods receipts', () => {
  it('only managers and above create, confirm or cancel a receipt (owner decision; fails closed)', () => {
    for (const f of ['create_goods_receipt', 'confirm_goods_receipt', 'cancel_goods_receipt']) {
      expect(fn(f)).toMatch(/v_actor IS NULL OR NOT COALESCE\(public\.rma_is_manager_or_above\(\), false\)/)
    }
  })

  it('never receives more than was ordered, drafts counted; no services; whole numbers judged as text', () => {
    const create = fn('create_goods_receipt')
    expect(create).toMatch(/v_pol\.qty_ordered - public\.rma_po_line_received_qty\(v_pol\.id, true\)/)
    expect(create).toMatch(/services are not received into stock/)
    expect(create).toContain("v_qty_txt !~ '^[0-9]{1,9}$'")
    expect(fn('confirm_goods_receipt')).toMatch(/rma_po_line_received_qty\(v_l\.purchase_order_line_id, false\) \+ v_l\.qty > v_l\.qty_ordered/)
  })

  it('serials are scanned on arrival: one per unit, unique, not already in use', () => {
    const create = fn('create_goods_receipt')
    expect(create).toMatch(/need % serial numbers/)
    expect(create).toMatch(/entered twice/)
    expect(create).toMatch(/is already in use/)
  })

  it('receives only into a sellable warehouse', () => {
    expect(fn('create_goods_receipt')).toMatch(/COALESCE\(v_wh\.is_system, false\) OR NOT COALESCE\(v_wh\.is_active, true\)/)
  })

  it('books stock at the PO line net price in the base currency; no price means unknown, never zero', () => {
    const confirm = fn('confirm_goods_receipt')
    expect(confirm).toMatch(/WHEN COALESCE\(v_l\.unit_cost, 0\) <= 0 THEN NULL/)
    expect(confirm).toMatch(/\* COALESCE\(v_po\.exchange_rate, 1\)/)
    expect(confirm).toMatch(/uncosted_quantity = uncosted_quantity \+ v_l\.qty/)
    expect(confirm).toMatch(/'goods_receipt', p_receipt_id, 'receive'/)
  })

  it('keeps the two paths apart and stops amending once receiving has started', () => {
    expect(fn('create_goods_receipt')).toMatch(/being received on its supplier invoice/)
    expect(sql).toMatch(/is received by goods receipts; receive the goods there, not on the invoice/)
    expect(sql).toMatch(/Goods have been received against it/)
  })

  it('numbers receipts GRN- and teaches the restore reconciler about them', () => {
    expect(sql).toMatch(/WHEN ''goods_receipt''\s+THEN ''GRN''/)
    expect(sql).toMatch(/''goods_receipts'',\s+''grn_code''/)
  })

  it('the receipt tables are procedure-only and read like their purchase order', () => {
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE[^;]*FROM authenticated/)
    expect(sql).toMatch(/CREATE POLICY "read_goods_receipts"[\s\S]*?FROM public\.purchase_orders po WHERE po\.id = goods_receipts\.purchase_order_id/)
  })

  it('backs up receipts before stock units (units point at them) and their unit/bin rows after', () => {
    const order = BACKUP_TABLES.map((t) => t.table)
    const at = (t) => order.indexOf(t)
    expect(at('goods_receipts')).toBeGreaterThan(at('purchase_order_lines'))
    expect(at('goods_receipts')).toBeLessThan(at('inventory_units'))
    expect(at('goods_receipt_lines')).toBeGreaterThan(at('goods_receipts'))
    expect(at('goods_receipt_lines')).toBeLessThan(at('inventory_units'))
    for (const t of ['goods_receipt_line_units', 'goods_receipt_line_bins']) {
      expect(at(t), t).toBeGreaterThan(at('inventory_units'))
      expect(at(t), t).toBeGreaterThan(at('warehouse_stock'))
    }
  })
})
