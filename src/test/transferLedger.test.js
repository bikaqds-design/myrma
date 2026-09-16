// @vitest-environment node
/**
 * transferLedger.test.js — BUG-032: the last unledgered inventory paths.
 *
 * Moving a unit used to be a direct PATCH of `warehouse_id`, and a manufacturer
 * batch closed its units the same way — neither wrote a `stock_moves` row, so
 * the Warehouse Dashboard and margin reporting could not see any of it.
 *
 * The behaviour itself is proven against a real database in
 * supabase/tests/transfer_units_ledger.sql. What is pinned here is what that
 * file cannot see: that no browser path writes the column directly any more,
 * and that the function keeps the two rules the browser-side guard enforces —
 * which it must repeat, because a SECURITY DEFINER caller skips that guard.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const migration = readFileSync('supabase/migrations/20260866_transfer_units_ledger.sql', 'utf8')
const api = readFileSync('src/api/db/inventory.ts', 'utf8')
const screens = [
  'src/pages/Inventory/CompanyStockTab.jsx',
  'src/pages/Inventory/ProductDetailModal.jsx',
  'src/pages/Inventory/WarehousesTab.jsx',
]

describe('the client no longer moves units by hand', () => {
  it('transferUnits calls the function instead of writing warehouse_id', () => {
    expect(api).toContain("supabase.rpc('transfer_units'")
    expect(api).not.toMatch(/update\(\{\s*warehouse_id/)
  })

  it('no dead direct-mutation helper is left behind', () => {
    // resolveUnits set status/resolution_type straight on the row and had no
    // caller anywhere in src/ — it went with this fix rather than staying as a
    // second unledgered path waiting to be used.
    expect(api).not.toContain('resolveUnits')
  })

  it('every screen passes the signed-in user and reports what actually moved', () => {
    for (const path of screens) {
      const src = readFileSync(path, 'utf8')
      expect(src).toMatch(/transferUnits\([^)]*,\s*warehouseId,\s*userEmail\)/)
      expect(src).toContain('const moved = await db.inventory.transferUnits')
      // the refusal reason (reserved unit, system location) reaches the user
      expect(src).toContain("err?.code === 'P0001'")
    }
  })
})

describe('the function carries the guard’s rules itself', () => {
  it('refuses a reserved unit', () => {
    expect(migration).toMatch(/reservation_status = 'reserved'[\s\S]{0,200}RAISE EXCEPTION/)
  })

  it('refuses a system destination', () => {
    expect(migration).toMatch(/IF v_dest\.is_system THEN[\s\S]{0,200}RAISE EXCEPTION/)
  })

  it('is manager-or-above, like transfer_stock', () => {
    expect(migration).toContain('IF NOT public.rma_is_manager_or_above() THEN')
  })

  it('writes one ledger row per unit moved, and none for a no-op', () => {
    expect(migration).toContain("'unit', v_unit.id, 'manual', NULL, 'transfer', 1")
    expect(migration).toContain('CONTINUE WHEN v_unit.warehouse_id IS NOT DISTINCT FROM p_to_warehouse_id')
  })

  it('takes the actor from the JWT rather than the caller’s argument', () => {
    expect(migration).toMatch(/COALESCE\(public\.rma_current_user_email\(\), NULLIF\(p_actor_email/)
  })

  it('locks EXECUTE down to authenticated and service_role', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.transfer_units(uuid[], uuid, text) FROM PUBLIC')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.transfer_units(uuid[], uuid, text) TO authenticated, service_role')
  })
})

describe('manufacturer batches', () => {
  it('both batch steps write to the ledger under the batch doc type', () => {
    expect(migration).toContain("'manufacturer_batch'")
    for (const to of ['sent_to_manufacturer', 'closed']) {
      expect(migration).toMatch(new RegExp(`INSERT INTO public\\.stock_moves[\\s\\S]{0,400}'${to}'`))
    }
  })

  it('still closes every unit on resolve — the owner’s decision, not an accident', () => {
    // The alternative (a "Replacement Rcvd" batch returning its units to
    // company stock) was put to the owner on 2026-09-16 and declined: the unit
    // that was sent away does not come back.
    expect(migration).toMatch(/SET status = 'closed'/)
    expect(migration).not.toMatch(/resolution_type = 'replacement_received'\s*THEN/)
  })
})
