// @vitest-environment node
/**
 * costingCleanup.test.js — BL-09 / I-07.
 *
 * The behaviour is proven against a real database in
 * supabase/tests/costing_cleanup.sql (25/25 on staging). Pinned here: the
 * migration keeps the properties that make a cost real or honestly unknown, and
 * the browser client speaks the new contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260882_costing_cleanup.sql', 'utf8')

function fn(name) {
  const start = sql.indexOf('FUNCTION public.' + name + '(')
  expect(start, name + ' not found').toBeGreaterThan(-1)
  const end = sql.indexOf('$fn$;', start)
  return sql.slice(start, end)
}

describe('landed cost is per line, and unknown is not zero', () => {
  const body = fn('rma_vi_landed_unit_costs')

  it('returns the line index with every row', () => {
    expect(sql).toMatch(/RETURNS TABLE \(line_index integer, product_id uuid, unit_cost_base numeric\)/)
    expect(body).toMatch(/WITH ORDINALITY/)
  })

  it('gives a line with no price a NULL cost, not a share of the freight on top of nothing', () => {
    expect(body).toMatch(/COALESCE\(\(t\.l->>'unit_cost'\)::numeric, 0\) <= 0 THEN NULL/)
  })

  it('is refused to anyone who is not staff, with the helper wrapped so a role-less caller is refused', () => {
    expect(body).toMatch(/NOT COALESCE\(public\.rma_is_staff\(\), false\)/)
  })
})

describe('receive_vendor_invoice', () => {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.receive_vendor_invoice(')
  const body = sql.slice(start, sql.indexOf('$$;', start))

  it('no longer looks a cost up by product with LIMIT 1', () => {
    expect(body).not.toMatch(/LIMIT 1/)
    expect(body).toMatch(/WHERE c\.line_index = v_line_idx/)
  })

  it('never turns a missing cost into zero', () => {
    expect(body).not.toMatch(/COALESCE\(v_unit_cost, 0\)/)
    expect(body).toMatch(/WHEN v_unit_cost IS NULL THEN v_received_this_line/)     // new bin: counted as uncosted
    expect(body).toMatch(/uncosted_quantity = uncosted_quantity \+ v_received_this_line/) // existing bin: likewise
  })

  it('refuses a product on several lines without a line_index, and a product not on the invoice', () => {
    expect(body).toContain('say which line is being received')
    expect(body).toContain('is not on this vendor invoice')
  })

  it('bounds what is received by what the line has left, across entries in one call', () => {
    expect(body).toMatch(/v_taken->>v_line_idx::text/)
    expect(body).toContain('left to receive')
  })

  it('folds received quantities onto their own line by index', () => {
    expect(body).toMatch(/v_taken \? \(\(t\.ord - 1\)::text\)/)
    expect(body).not.toMatch(/r->>'product_id' = line->>'product_id'/)
  })

  it('keeps the search_path pinned, pg_temp last, and the manager guard wrapped', () => {
    expect(body).toMatch(/SET search_path TO 'public', 'pg_temp'/)
    expect(body).toMatch(/NOT COALESCE\(public\.rma_is_manager_or_above\(\), false\)/)
  })
})

describe('the worklist and the import', () => {
  it('lists uncosted stock for managers and accountants only, leaving out delivered units', () => {
    const body = fn('rma_uncosted_stock')
    expect(body).toMatch(/rma_is_manager_or_above\(\) OR public\.rma_user_role\(\) = 'accountant'/)
    expect(body).toMatch(/reservation_status IS DISTINCT FROM 'delivered'/)
    expect(body).toMatch(/u\.unit_cost_base IS NULL/)
  })

  it('imports through rma_set_opening_cost, so every rule of a single valuation applies', () => {
    const body = fn('rma_import_opening_costs')
    expect(body).toMatch(/public\.rma_set_opening_cost\(v_product, v_wh, v_cost\)/)
    expect(body).toMatch(/NOT COALESCE\(public\.rma_is_manager_or_above\(\), false\)/)
    expect(body).toMatch(/> 1000/)
    // a bad row is reported, not fatal
    expect(body).toMatch(/EXCEPTION WHEN OTHERS THEN/)
  })

  it('is not executable by anon, and the migration refuses to finish if it is', () => {
    for (const sig of ['rma_uncosted_stock\\(\\)', 'rma_import_opening_costs\\(jsonb\\)', 'rma_vi_landed_unit_costs\\(uuid\\)']) {
      expect(sql, sig).toMatch(new RegExp('REVOKE ALL ON FUNCTION public\\.' + sig + ' FROM PUBLIC, anon'))
    }
    expect(sql).toContain('Refusing to finish: a costing function is executable by anon')
  })
})

// ── the browser client ──────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({ calls: [], result: { data: null, error: null } }))

vi.mock('../api/client.js', () => ({
  supabase: {
    rpc: (name, args) => {
      mocks.calls.push({ name, args })
      return Promise.resolve(mocks.result)
    },
  },
}))

const { vendorInvoices, landedUnitCosts, uncostedStock, importOpeningCosts } = await import('../api/db/purchasing')

describe('purchasing client', () => {
  beforeEach(() => {
    mocks.calls.length = 0
    mocks.result = { data: [], error: null }
  })

  it('sends the line index with each receipt line', async () => {
    await vendorInvoices.receive('vi-1', [
      { productId: 'p1', warehouseId: 'w1', lineIndex: 1, serials: ['A'] },
      { productId: 'p2', warehouseId: 'w1', qty: 4 },
    ], 'a@b.c')
    expect(mocks.calls[0].args.p_receipt_lines).toEqual([
      { product_id: 'p1', warehouse_id: 'w1', line_index: 1, serials: ['A'], qty: undefined },
      { product_id: 'p2', warehouse_id: 'w1', line_index: undefined, serials: undefined, qty: 4 },
    ])
  })

  it('reads the per-line landed cost, unknown as null', async () => {
    mocks.result = { data: [{ line_index: 0, product_id: 'p', unit_cost_base: null }], error: null }
    const rows = await landedUnitCosts('vi-1')
    expect(mocks.calls[0]).toEqual({ name: 'rma_vi_landed_unit_costs', args: { p_vi_id: 'vi-1' } })
    expect(rows[0].unit_cost_base).toBeNull()
  })

  it('reads the worklist and sends an import through the RPC', async () => {
    await uncostedStock()
    await importOpeningCosts([{ sku: 'S', warehouse: 'W', unit_cost: 5 }])
    expect(mocks.calls.map((c) => c.name)).toEqual(['rma_uncosted_stock', 'rma_import_opening_costs'])
    expect(mocks.calls[1].args).toEqual({ p_rows: [{ sku: 'S', warehouse: 'W', unit_cost: 5 }] })
  })

  it('throws the database refusal', async () => {
    mocks.result = { data: null, error: { code: 'P0001', message: 'Not authorized' } }
    await expect(uncostedStock()).rejects.toMatchObject({ code: 'P0001' })
  })
})

describe('the receive screen', () => {
  it('names the invoice line it is receiving against', () => {
    const src = readFileSync('src/pages/Purchasing/PurchaseDocumentDetail.jsx', 'utf8')
    expect(src).toContain('lineIndex: line.index, qty')
    expect(src).toContain('lineIndex: line.index, serials')
  })
})
