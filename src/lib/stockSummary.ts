// ─── Serialized stock summary — pure core ──────────────────────────────────
// The per-product arithmetic behind the Warehouse Dashboard's Available /
// Reserved / Physical Total / Main / Branches / RMA columns, extracted from
// db.inventory.getStockSummary so it can be tested without a Supabase mock.
//
// Extracted on 2026-08-05 after a bug that only became visible once RMA units
// started carrying product_id (see src/lib/rmaUnitCreate.ts):
//
//   available was counted over EVERY unit belonging to the product. An
//   active_rma unit carries reservation_status 'available' — nothing has
//   reserved it — so a unit sitting in an RMA location was reported as
//   available to sell. Before RMA units had a product_id they matched no
//   product and were silently skipped, which is why it went unnoticed.
//
// The rule the tests below lock down: **availability is a property of company
// stock.** Units in an RMA location are physically present but not sellable.

/** The warehouse fields the summary needs. */
export interface WarehouseLike {
  id: string
  name?: string | null
  code?: string | null
  warehouse_type?: string | null
  is_system?: boolean | null
}

/** The unit fields the summary needs. */
export interface UnitLike {
  status?: string | null
  reservation_status?: string | null
  warehouse_id?: string | null
}

export interface BranchQty {
  warehouse_id: string
  name: string
  code: string | null
  qty: number
}

export interface RmaLocationCount {
  warehouse_id: string
  code: string
  name: string
  count: number
}

export interface SerializedStockCounts {
  available: number
  reserved: number
  delivered: number
  main_qty: number
  physical_total: number
  branches: BranchQty[]
  rma: RmaLocationCount[]
}

/**
 * Warehouses with no type are treated as Main. Rows predate the
 * `warehouse_type` column and are all the legacy main location.
 */
export function isMainOrLegacy(w: WarehouseLike | undefined): boolean {
  return !w || !w.warehouse_type || w.warehouse_type === 'main'
}

export function isBranch(w: WarehouseLike | undefined): boolean {
  return w?.warehouse_type === 'branch'
}

/** Per-branch quantities. Main and system locations are not branches. */
export function branchBreakdown(
  rows: { warehouse_id: string | null | undefined; qty: number }[],
  whById: Map<string, WarehouseLike>
): BranchQty[] {
  const map = new Map<string, BranchQty>()
  for (const row of rows) {
    const w = row.warehouse_id ? whById.get(row.warehouse_id) : undefined
    if (!w || !isBranch(w)) continue
    const entry = map.get(w.id) || { warehouse_id: w.id, name: w.name || '', code: w.code ?? null, qty: 0 }
    entry.qty += row.qty
    map.set(w.id, entry)
  }
  return [...map.values()]
}

/**
 * Per-system-location counts for a product's RMA units. Units parked outside a
 * system warehouse — unplaced legacy rows, or a non-system location — are
 * excluded: they are not at a real RMA stage.
 */
export function rmaBreakdown(
  rmaUnits: UnitLike[],
  whById: Map<string, WarehouseLike>
): RmaLocationCount[] {
  const map = new Map<string, RmaLocationCount>()
  for (const u of rmaUnits) {
    const w = u.warehouse_id ? whById.get(u.warehouse_id) : undefined
    if (!w?.is_system) continue
    const entry = map.get(w.id) || { warehouse_id: w.id, code: w.code || '', name: w.name || '', count: 0 }
    entry.count += 1
    map.set(w.id, entry)
  }
  return [...map.values()]
}

/**
 * Every dashboard count for one serialized product.
 *
 * `units` is that product's units — company stock, RMA and closed alike; the
 * split happens here so callers cannot get it wrong.
 *
 * Physical Total counts what is bodily in the building: company stock plus RMA
 * units, minus anything written off to SCRAP.
 */
export function summarizeSerializedUnits(
  units: UnitLike[],
  whById: Map<string, WarehouseLike>
): SerializedStockCounts {
  const companyStock = units.filter((u) => u.status === 'company_stock')
  const rmaUnits = units.filter((u) => u.status === 'active_rma')

  // Availability is scoped to company stock on purpose — see the module note.
  const countReservation = (state: string) =>
    companyStock.filter((u) => u.reservation_status === state).length

  const rma = rmaBreakdown(rmaUnits, whById)

  return {
    available: countReservation('available'),
    reserved: countReservation('reserved'),
    delivered: countReservation('delivered'),
    main_qty: companyStock.filter((u) => isMainOrLegacy(u.warehouse_id ? whById.get(u.warehouse_id) : undefined)).length,
    physical_total:
      companyStock.filter((u) => (u.warehouse_id ? whById.get(u.warehouse_id)?.code : undefined) !== 'SCRAP').length +
      rma.filter((r) => r.code !== 'SCRAP').reduce((sum, r) => sum + r.count, 0),
    branches: branchBreakdown(
      companyStock.map((u) => ({ warehouse_id: u.warehouse_id, qty: 1 })),
      whById
    ),
    rma,
  }
}
