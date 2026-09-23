// @vitest-environment node
/**
 * lineReadersMoneyStock.test.js — W2 / L-02 step 1 (20260890).
 *
 * Proven against a real database in supabase/tests/line_readers_money_stock.sql
 * (7/7 on staging; before the migration the reservation, shipment and credit
 * cap followed a tampered line_items copy — reserved 9, shipped 9, allowed the
 * credit). Pinned here: which readers moved, how, and what did not.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260890_line_readers_money_stock.sql', 'utf8')

describe('the lines helpers', () => {
  for (const [fn, table, key] of [
    ['rma_sales_order_lines_json', 'sales_order_lines', 'sales_order_id'],
    ['rma_crm_invoice_lines_json', 'crm_invoice_lines', 'crm_invoice_id'],
    ['rma_credit_note_lines_json', 'credit_note_lines', 'credit_note_id'],
    ['rma_vendor_invoice_lines_json', 'vendor_invoice_lines', 'vendor_invoice_id'],
  ]) {
    it(`${fn} reads the rows in line order, falling back to the copy only when there are none`, () => {
      const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(p_id uuid)`)
      expect(start).toBeGreaterThan(-1)
      const body = sql.slice(start, sql.indexOf('$function$;', start))
      expect(body).toContain(`FROM public.${table} l WHERE l.${key} = p_id`)
      expect(body).toContain('ORDER BY l.line_no')
      expect(body.indexOf(`public.${table}`)).toBeLessThan(body.indexOf('line_items FROM'))
    })
  }

  it('are internal', () => {
    expect(sql).toContain("EXECUTE format('REVOKE ALL ON FUNCTION public.%I(uuid) FROM PUBLIC, anon, authenticated', f)")
  })
})

describe('the money and stock readers', () => {
  it('each exact expression is rewritten, counted first, and nothing is replaced unless every count matches', () => {
    for (const fn of ['approve_sales_order', 'post_invoice', '_credit_note_assert_within_caps', 'rma_reservation_integrity', 'rma_vi_landed_unit_costs']) {
      expect(sql, fn).toContain(`jsonb_build_array('${fn}',`)
    }
    expect(sql).toContain("RAISE EXCEPTION 'Refusing to apply: % holds \"%\" % time(s), expected %'")
    // replacement happens only after the checking loop has finished
    expect(sql.indexOf('EXECUTE v_defs->>v_fn')).toBeGreaterThan(sql.indexOf('v_defs := jsonb_set(v_defs, ARRAY[v_fn]'))
  })

  it('the migration refuses to finish while any of them still reads a .line_items copy', () => {
    expect(sql).toContain("AND pg_get_functiondef(p.oid) ~ '\\.line_items'")
  })

  it('leaves the approval fingerprint on the copy until the copy is dropped (pending notes would fail their check)', () => {
    expect(sql).not.toMatch(/jsonb_build_array\('(issue_credit_note|submit_credit_note_for_approval)'/)
  })
})
