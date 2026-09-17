// @vitest-environment node
/**
 * deliveredUnitsNotOnHand.test.js — a unit delivered to a customer is not stock on hand.
 *
 * Delivery keeps a serialized unit as status 'company_stock' with
 * reservation_status 'delivered' (restore_units and customer RMAs rely on
 * that), so every reader that means "on the shelf" has to leave delivered
 * units out. Found in the Warehouse R1 re-run on 2026-09-17: test2 showed Main
 * 21 where 20 had been delivered. 20260874 fixed the views and
 * archive_warehouse; the behaviour was proven by a rolled-back probe on
 * production. This pins that the exclusion stays.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const sql = read('supabase/migrations/20260874_delivered_units_not_on_hand.sql').replace(/--[^\n]*/g, '')
const modal = read('src/pages/Inventory/StockBreakdownModal.jsx')

const ON_HAND = "status = 'company_stock' AND reservation_status IS DISTINCT FROM 'delivered'"

describe('v_product_stock_summary', () => {
  it('leaves delivered units out of Main, branches and physical total', () => {
    expect(sql).toContain(`count(*) FILTER (WHERE ${ON_HAND} AND w_main)::int AS main_qty`)
    expect(sql).toContain(`(count(*) FILTER (WHERE ${ON_HAND} AND w_code IS DISTINCT FROM 'SCRAP')`)
    expect(sql).toContain(`WHERE product_id IS NOT NULL AND ${ON_HAND} AND w_branch`)
  })

  it('still reports how many were delivered', () => {
    expect(sql).toContain("count(*) FILTER (WHERE status = 'company_stock' AND reservation_status = 'delivered')::int AS delivered")
  })
})

describe('warehouse counts and archiving', () => {
  const excludeDelivered = "NOT (status = 'company_stock' AND reservation_status IS NOT DISTINCT FROM 'delivered')"

  it('the Warehouses tab count leaves delivered units out', () => {
    const view = sql.slice(sql.indexOf('CREATE OR REPLACE VIEW public.v_warehouse_unit_counts'), sql.indexOf('CREATE OR REPLACE FUNCTION public.archive_warehouse'))
    expect(view).toContain(excludeDelivered)
  })

  it('a warehouse whose stock has all been delivered can be archived', () => {
    const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.archive_warehouse'))
    expect(fn).toMatch(new RegExp(String.raw`status <> 'closed'\s+AND ` + excludeDelivered.replace(/[()]/g, '\\$&')))
    expect(fn).toContain('IF NOT public.rma_is_manager_or_above() THEN')
  })
})

describe('Stock Breakdown modal', () => {
  it('counts only stock on hand in Total and the warehouse distribution', () => {
    expect(modal).toContain('const total = productSummary.available + productSummary.reserved\n')
    expect(modal).toMatch(/u\.status === 'company_stock' && u\.reservation_status !== 'delivered'/)
  })
})
