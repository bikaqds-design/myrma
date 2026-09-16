import { supabase } from '../client.js'
import { buildTicketUnits } from '../../lib/rmaUnitCreate.js'
import type { TicketProductInput, CatalogProduct } from '../../lib/rmaUnitCreate.js'
import type { TableResult } from './types.js'
import { assertUpdated, assertAffected } from './_assertUpdated.js'
import { chunksOf, fetchAllRows } from './_paging.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface InventoryUnitRow {
  id: string
  rma_ticket_id: string | null
  rma_number: string | null
  product_id: string | null
  product_name: string
  serial_number: string | null
  warranty_status: string | null
  status: string
  resolution_type: string | null
  resolved_date: string | null
  notes: string | null
  warehouse_id: string | null
  manufacturer_batch_id: string | null
  created_date: string
  reservation_status: 'available' | 'reserved' | 'delivered'
  reserved_by_doc_type: string | null
  reserved_by_doc_id: string | null
  reserved_at: string | null
  reserved_by_email: string | null
}

export interface ManufacturerBatchRow {
  id: string
  batch_number: string
  manufacturer_name: string
  status: string
  unit_count: number
  sent_date: string | null
  tracking_number: string | null
  resolution_type: string | null
  resolution_date: string | null
  resolution_notes: string | null
  created_date: string
  created_by: string | null
}

export interface WarehouseRow {
  id: string
  name: string
  code: string | null
  location: string | null
  description: string | null
  is_active: boolean
  created_date: string
  created_by: string | null
  warehouse_type: 'main' | 'branch' | 'service_center' | 'rma' | 'transit' | 'virtual' | null
  manager: string | null
  notes: string | null
}

export interface WarehouseStockRow {
  id: string
  product_id: string
  warehouse_id: string
  quantity: number
  reserved_quantity: number
  updated_at: string
}

export interface ProductStockSummary {
  product_id: string
  product_name: string
  stock_tracking_mode: 'serialized' | 'bulk'
  available: number
  reserved: number
  /**
   * For `bulk` products this is always 0 — bulk delivery decrements
   * `quantity` directly (like `parts.quantity`), leaving no persistent
   * "delivered" bucket the way serialized units keep a permanent
   * reservation_status='delivered' row. The stock_moves ledger is the
   * historical record for bulk deliveries, not a live counter.
   */
  delivered: number
  /** Every physically-existing unit/qty: sellable (main+branch) + RMA/transit locations. Excludes SCRAP and closed units. */
  physical_total: number
  /** company_stock qty/units in warehouses of type 'main' (or legacy NULL-type, treated as the default location). */
  main_qty: number
  /** Per-branch (warehouse_type='branch') breakdown of company_stock qty/units. */
  branches: WarehouseQtyBreakdown[]
  /** Per-system-RMA-location breakdown of active_rma units (Received/Under Repair/Repaired/Can't Repair/Stock/Replacement/Credit Note/Scrap). */
  rma: RmaLocationBreakdown[]
  /** false for a synthetic row built from RMA units whose product_name has no matching catalog product (product_id is NULL). */
  in_catalog: boolean
}

export interface WarehouseQtyBreakdown {
  warehouse_id: string
  name: string
  code: string | null
  qty: number
}

export interface RmaLocationBreakdown {
  warehouse_id: string
  code: string
  name: string
  count: number
}

export interface StockMoveRow {
  id: string
  ref_type: 'unit' | 'part' | 'warehouse_stock'
  ref_id: string
  // 'vendor_invoice' was added to the DB constraint by 20260747 (a vendor
  // invoice id is a distinct entity from a sales crm_invoices id, so reusing
  // 'invoice' would make doc_id ambiguous) but never reached this type.
  doc_type: 'sales_order' | 'invoice' | 'credit_note' | 'vendor_invoice' | 'manual'
  doc_id: string | null
  move_type: 'reserve' | 'deliver' | 'release' | 'restore' | 'adjust' | 'receive' | 'transfer'
  qty: number
  from_status: string | null
  to_status: string | null
  actor_email: string
  created_at: string
}

/**
 * A stock_moves row joined to whatever its polymorphic ref_id points at, so a
 * receipt can be displayed without the caller re-resolving units and stock.
 */
export interface ReceiptMoveRow extends StockMoveRow {
  serial_number: string | null
  product_name: string | null
  warehouse_id: string | null
}

export interface PartRow {
  id: string
  part_name: string
  part_number: string | null
  quantity: number
  unit_cost: number | null
  supplier: string | null
  reorder_level: number | null
  location: string | null
  notes: string | null
  created_date: string
  updated_date: string | null
}

export interface TicketPartRow {
  id: string
  ticket_id: string
  part_id: string
  quantity: number
  unit_cost: number | null
  notes: string | null
  added_by: string | null
  created_date: string
  part?: Pick<PartRow, 'part_name' | 'part_number'>
}

export interface TimeEntryRow {
  id: string
  ticket_id: string
  technician_email: string
  description: string | null
  duration_min: number | null
  started_at: string | null
  ended_at: string | null
  created_date: string
}

export interface InventoryStatsRow {
  active_rma: number
  company_stock: number
  sent_to_manufacturer: number
  closed: number
  total: number
}

/** A unit that could not be inserted, with enough detail to name it in a toast. */
export interface FailedUnitInsert {
  product_name: string
  serial_number: string
  message: string
  code: string | null
}

export interface CreateUnitsResult {
  created: InventoryUnitRow[]
  /** Non-empty means the caller MUST surface an error — see the note below. */
  failed: FailedUnitInsert[]
  /** `inventory_units` doesn't exist in this deployment (optional table). Not an error. */
  missing: boolean
}

// ── Inventory Units ───────────────────────────────────────────────────────────

export const inventory = {
  /**
   * Creates one `inventory_units` row per product on a newly-saved RMA ticket.
   *
   * Two failure modes were found in manual QA on 2026-08-05
   * (docs/archive/WAREHOUSE_R1_TEST_CHECKLIST.md §2) and are fixed here:
   *
   *  1. **All-or-nothing.** Every unit went in as one `.insert(units)` batch, so
   *     a single duplicate serial discarded the whole ticket's units. The batch
   *     is still attempted first (one round trip, the overwhelmingly common
   *     case), but on failure each row is retried individually so a bad row
   *     only costs itself. A multi-row INSERT is a single atomic statement, so
   *     nothing was written when the batch errored — the retry cannot duplicate
   *     a row the batch already inserted.
   *
   *  2. **Silent failure.** This used to `return []` on any error, leaving the
   *     UI to report success while no unit existed and no stock move was
   *     written. Failures are now returned in `failed` for the caller to toast;
   *     they are deliberately NOT thrown, because a ticket that saved fine
   *     should not be reported as a failed save.
   */
  /**
   * The id + name of every catalog product whose name matches one of `names`
   * (trimmed, case-insensitive — buildCatalogIndex's key), for re-linking RMA
   * ticket lines to `products` (rma_products_by_name_keys, 20260865). It used to
   * read the whole catalog, which past 1 000 products left later ones unmatched.
   * (BUG-066.) Deliberately tolerant: if the lookup fails the unit is still
   * created, just without a `product_id` — losing the dashboard grouping is bad,
   * losing the unit is worse.
   */
  async listCatalogForUnitLinking(names: string[] = []): Promise<CatalogProduct[]> {
    const keys = [...new Set(names.map((n) => (n || '').trim().toLowerCase()).filter(Boolean))]
    if (!keys.length) return []
    try {
      const out: CatalogProduct[] = []
      for (const chunk of chunksOf(keys, 100)) {
        out.push(
          ...(await fetchAllRows<CatalogProduct>((from, to) =>
            supabase.rpc('rma_products_by_name_keys', { p_keys: chunk }).order('id', { ascending: true }).range(from, to)
          ))
        )
      }
      return out
    } catch {
      return []
    }
  },

  async createUnitsFromTicket(
    ticketId: string,
    rmaNumber: string,
    products: TicketProductInput[]
  ): Promise<CreateUnitsResult> {
    // The catalog lookup re-links each line to its `products` row: the form now
    // stores product_id when the user picks from the dropdown, but a typed name
    // (and every ticket saved before that existed) still has to be matched by
    // name. Without it the unit is invisible to getStockSummary's per-product
    // grouping — see buildTicketUnits.
    const catalog = await this.listCatalogForUnitLinking(
      (products || []).filter((p) => !p.product_id).map((p) => p.product_name || '')
    )
    const units = buildTicketUnits(ticketId, rmaNumber, products, undefined, catalog)
    if (!units.length) return { created: [], failed: [], missing: false }

    const batch = await supabase.from('inventory_units').insert(units).select()
    if (!batch.error) return { created: batch.data || [], failed: [], missing: false }
    if (batch.error.code === '42P01') return { created: [], failed: [], missing: true }

    const created: InventoryUnitRow[] = []
    const failed: FailedUnitInsert[] = []
    for (const unit of units) {
      const { data, error } = await supabase.from('inventory_units').insert([unit]).select()
      if (error) {
        failed.push({
          product_name: unit.product_name,
          serial_number: unit.serial_number,
          message: error.message,
          code: error.code ?? null,
        })
      } else if (data?.length) {
        created.push(...data)
      }
    }
    return { created, failed, missing: false }
  },

  /**
   * Looks up which of the given serials are already held by a live
   * `inventory_units` row. The `status <> 'closed'` filter deliberately mirrors
   * the partial index `inv_units_serial_unique_idx`
   * (`20260739_inventory_serial_uniqueness.sql`) — a closed unit may legitimately
   * repeat a serial that later comes back on a new ticket, so it is not a conflict.
   *
   * Used by the ticket form to reject a duplicate serial before saving. Returns
   * `[]` when the table is absent so an optional-table deployment never blocks a save.
   */
  async findTrackedSerials(serials: string[]): Promise<InventoryUnitRow[]> {
    if (!serials?.length) return []
    // In chunks, so a ticket with many serials neither overflows the URL nor
    // meets the 1 000-row cap. (BUG-066.)
    const out: InventoryUnitRow[] = []
    for (const chunk of chunksOf(serials, 100)) {
      const { data, error } = await supabase
        .from('inventory_units')
        .select('*')
        .in('serial_number', chunk)
        .neq('status', 'closed')
      if (error) {
        if (error.code === '42P01') return []
        throw error
      }
      out.push(...(data || []))
    }
    return out
  },

  /**
   * One transaction, and a real sequence for the number.
   *
   * This used to derive `BATCH-<yyyymmdd>-<count+1>` from `SELECT count(*)`.
   * `batch_number` is UNIQUE and a count is not a sequence, so deleting any
   * batch made the next create re-derive a number already in use, and two
   * people creating at once derived the same one — both surfacing as an
   * unexplained failure. It then linked the units in a *second* statement whose
   * error was never captured, so a failure there left a batch claiming
   * `unit_count` units with none attached (BUG-029).
   */
  async createBatch(
    unitIds: string[],
    manufacturerName: string,
    userEmail: string
  ): Promise<ManufacturerBatchRow> {
    const { data, error } = await supabase.rpc('create_manufacturer_batch', {
      p_unit_ids: unitIds,
      p_manufacturer_name: manufacturerName,
      p_actor_email: userEmail,
    })
    if (error) throw error
    return data as ManufacturerBatchRow
  },

  async markBatchSent(
    batchId: string,
    sentDate: string,
    trackingNumber: string
  ): Promise<ManufacturerBatchRow | undefined> {
    // Batch and units move together, or not at all (BUG-029).
    const { data, error } = await supabase.rpc('mark_batch_sent', {
      p_batch_id: batchId,
      p_sent_date: sentDate,
      p_tracking_number: trackingNumber,
    })
    if (error) throw error
    return data as ManufacturerBatchRow
  },

  async markBatchResolved(
    batchId: string,
    resolutionType: string,
    resolutionDate: string,
    notes?: string
  ): Promise<ManufacturerBatchRow | undefined> {
    // Batch and units move together (BUG-029). NOTE the semantics are carried
    // over unchanged: every unit becomes 'closed' whatever the resolution was,
    // so a repaired unit and a scrapped one end up identical. That is an open
    // question recorded against BUG-032, not something changed here.
    const { data, error } = await supabase.rpc('mark_batch_resolved', {
      p_batch_id: batchId,
      p_resolution_type: resolutionType,
      p_resolution_date: resolutionDate,
      p_notes: notes ?? null,
    })
    if (error) throw error
    return data as ManufacturerBatchRow
  },

  /**
   * Units per status, counted in the database (rma_inventory_status_counts,
   * 20260863). It used to read every unit's status and count them here — past
   * the Data API's 1 000-row cap, a count of some units. (BUG-066.)
   */
  async getStats(): Promise<InventoryStatsRow | null> {
    try {
      const { data, error } = await supabase.rpc('rma_inventory_status_counts')
      if (error) return null
      const s = (data ?? {}) as Partial<InventoryStatsRow>
      return {
        active_rma: Number(s.active_rma) || 0,
        company_stock: Number(s.company_stock) || 0,
        sent_to_manufacturer: Number(s.sent_to_manufacturer) || 0,
        closed: Number(s.closed) || 0,
        total: Number(s.total) || 0,
      }
    } catch {
      return null
    }
  },

  /**
   * Move a selection of units to one warehouse, on the ledger. (BUG-032.)
   *
   * This was a direct PATCH of `warehouse_id`, which wrote no `stock_moves`
   * row — so the Warehouse Dashboard and margin reporting could not see a
   * transfer at all. It now goes through `transfer_units` (20260866), which
   * records one ledger row per unit that actually moves, refuses a unit
   * reserved for a sales order, and refuses a system or archived destination.
   *
   * Returns how many units actually moved: one already in the destination is a
   * no-op rather than an error, so the count can be lower than the selection.
   *
   * The whole selection travels in the request body, so there is no longer a
   * URL-length reason to chunk — and chunking would break atomicity, which is
   * the point of routing through the function.
   */
  async transferUnits(unitIds: string[], warehouseId: string, actorEmail?: string): Promise<number> {
    if (!unitIds.length) throw new Error('No unit IDs provided')
    if (!warehouseId) throw new Error('No destination warehouse provided')
    const { data, error } = await supabase.rpc('transfer_units', {
      p_unit_ids: unitIds,
      p_to_warehouse_id: warehouseId,
      p_actor_email: actorEmail ?? null,
    })
    if (error) throw error
    return (data as number) ?? 0
  },

  // ── Sprint 8 Phase 8a RPC wrappers — dual-mode (serialized + bulk) ────────────

  /**
   * receiveStock — the interim manual stock-entry path (Sprint 9's Purchase
   * Module will replace this with vendor-invoice-driven receipt). Pass
   * `serial` for a serialized product, `qty` for a bulk-tracked one — the
   * RPC branches on the product's stock_tracking_mode server-side.
   */
  async receiveStock(params: {
    productId: string
    warehouseId: string
    actorEmail: string
    serial?: string
    qty?: number
  }): Promise<void> {
    const { error } = await supabase.rpc('receive_stock', {
      p_product_id: params.productId,
      p_warehouse_id: params.warehouseId,
      p_actor_email: params.actorEmail,
      p_serial: params.serial ?? null,
      p_qty: params.qty ?? null,
    })
    if (error) throw error
  },

  /**
   * transferStock — atomic warehouse transfer (Sprint 8 Phase 8a). Pass
   * `unitId` for a serialized unit, `qty` for bulk-tracked quantity.
   */
  async transferStock(params: {
    productId: string
    fromWarehouseId: string
    toWarehouseId: string
    actorEmail: string
    unitId?: string
    qty?: number
  }): Promise<void> {
    const { error } = await supabase.rpc('transfer_stock', {
      p_product_id: params.productId,
      p_from_warehouse_id: params.fromWarehouseId,
      p_to_warehouse_id: params.toWarehouseId,
      p_actor_email: params.actorEmail,
      p_unit_id: params.unitId ?? null,
      p_qty: params.qty ?? null,
    })
    if (error) throw error
  },

  /**
   * adjustStock — manual correction. Pass `unitId` + `newStatus` for a
   * serialized unit (found/missing/damaged/etc.), or `qtyDelta` (signed) for
   * bulk-tracked quantity.
   */
  async adjustStock(params: {
    productId: string
    warehouseId: string
    actorEmail: string
    unitId?: string
    newStatus?: string
    qtyDelta?: number
    reason?: string
  }): Promise<void> {
    const { error } = await supabase.rpc('adjust_stock', {
      p_product_id: params.productId,
      p_warehouse_id: params.warehouseId,
      p_actor_email: params.actorEmail,
      p_unit_id: params.unitId ?? null,
      p_new_status: params.newStatus ?? null,
      p_qty_delta: params.qtyDelta ?? null,
      p_reason: params.reason ?? null,
    })
    if (error) throw error
  },

  /**
   * recalculateStock — bulk-tracked reconciliation tool only (serialized
   * availability is always a live COUNT, nothing to drift). Recomputes
   * reserved_quantity from the stock_moves ledger for one product+warehouse.
   */
  async recalculateStock(productId: string, warehouseId: string, actorEmail: string): Promise<void> {
    const { error } = await supabase.rpc('recalculate_stock', {
      p_product_id: productId,
      p_warehouse_id: warehouseId,
      p_actor_email: actorEmail,
    })
    if (error) throw error
  },

  // ── Warehouse Module R1 — RMA stage auto-move / promote-to-sellable ──────────

  /**
   * listUnitsByTicket — every inventory_units row created from a given RMA
   * ticket, regardless of current status/location. Used to compute auto-moves
   * whenever a ticket's product statuses are saved.
   */
  async listUnitsByTicket(ticketId: string): Promise<InventoryUnitRow[]> {
    try {
      return await fetchAllRows<InventoryUnitRow>((from, to) =>
        supabase.from('inventory_units').select('*').eq('rma_ticket_id', ticketId).order('id', { ascending: true }).range(from, to)
      )
    } catch (error) {
      if ((error as { code?: string })?.code === '42P01') return []
      throw error
    }
  },

  /**
   * moveRmaUnits — relocates units to the matching system RMA location
   * (RMA-RECEIVED/RMA-REPAIR/RMA-REPAIRED/RMA-CANTREPAIR/RMA-STOCK/...).
   * Idempotent server-side — a unit already at its target is a no-op.
   * Returns the count of units actually moved.
   */
  async moveRmaUnits(
    ticketId: string,
    moves: { unit_id: string; to_code: string }[],
    actorEmail: string
  ): Promise<number> {
    if (!moves.length) return 0
    const { data, error } = await supabase.rpc('move_rma_units', {
      p_ticket_id: ticketId,
      p_moves: moves,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    return data ?? 0
  },

  /**
   * promoteRmaUnit — the previously-missing path from active_rma to sellable
   * company_stock. Manager+ only (enforced server-side); blocked for reserved
   * units and for is_system/non-sellable destinations.
   */
  async promoteRmaUnit(params: {
    unitId: string
    warehouseId: string
    actorEmail: string
    resolutionType?: string
  }): Promise<void> {
    const { error } = await supabase.rpc('promote_rma_unit', {
      p_unit_id: params.unitId,
      p_warehouse_id: params.warehouseId,
      p_actor_email: params.actorEmail,
      p_resolution_type: params.resolutionType ?? null,
    })
    if (error) throw error
  },

}

// ── Warehouses ────────────────────────────────────────────────────────────────

export const warehouses = {
  /** Every warehouse, A–Z — not the first 1 000. (BUG-066.) */
  async list(): Promise<TableResult<WarehouseRow[]>> {
    try {
      const data = await fetchAllRows<WarehouseRow>((from, to) =>
        supabase.from('warehouses').select('*').order('name', { ascending: true }).order('id', { ascending: true }).range(from, to)
      )
      return { missing: false, data }
    } catch (error) {
      if ((error as { code?: string })?.code === '42P01') return { missing: true, data: [] }
      return { missing: true, data: [] }
    }
  },
  async create(warehouse: Partial<WarehouseRow>): Promise<WarehouseRow | undefined> {
    const { data, error } = await supabase.from('warehouses').insert([warehouse]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, warehouse: Partial<WarehouseRow>): Promise<WarehouseRow | undefined> {
    const { data, error } = await supabase.from('warehouses').update(warehouse).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Warehouse')
  },
  async delete(id: string): Promise<void> {
    const { data, error } = await supabase.from('warehouses').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Warehouse')
  },
  /**
   * archive — soft-delete via the archive_warehouse RPC (Sprint 8 Phase 8a).
   * Server-side blocks the archive if any live serialized units or bulk
   * quantity still reference this warehouse; the RPC's error message names
   * the blocking counts. Prefer this over delete() for warehouses that may
   * have been used — delete() remains for the empty/never-used case.
   */
  async archive(id: string, actorEmail: string): Promise<void> {
    const { error } = await supabase.rpc('archive_warehouse', {
      p_warehouse_id: id,
      p_actor_email: actorEmail,
    })
    if (error) throw error
  },
}

// ── Warehouse stock (bulk-quantity tracking, Sprint 8 Phase 8a) ─────────────────

// Paged and per-product reads for the Inventory screen live in inventoryLists.ts
// (BUG-066): whole-table reads of units, stock rows and moves were removed.
export const warehouseStock = {
  async listByProduct(productId: string): Promise<WarehouseStockRow[]> {
    return fetchAllRows<WarehouseStockRow>((from, to) =>
      supabase.from('warehouse_stock').select('*').eq('product_id', productId).order('id', { ascending: true }).range(from, to)
    )
  },
}

// ── Stock moves (append-only movement ledger) ───────────────────────────────────

export const stockMoves = {
  /**
   * receiptsForDocument — every ledger row one purchase document produced,
   * enriched with the serial / product / warehouse the stock_moves row does not
   * itself carry. ref_id is polymorphic ('unit' points at inventory_units,
   * 'warehouse_stock' at warehouse_stock) so there is no foreign key for
   * PostgREST to embed through and the lookups have to be done by hand.
   *
   * Ordered oldest-first: a receipt history reads as a sequence of events.
   */
  async receiptsForDocument(
    docType: StockMoveRow['doc_type'],
    docId: string
  ): Promise<TableResult<ReceiptMoveRow[]>> {
    try {
      // Every receipt row — a large delivery is thousands of units, past the
      // 1 000-row cap — with the units, stock rows and products they name read
      // in chunks. (BUG-066.)
      let moves: StockMoveRow[]
      try {
        moves = await fetchAllRows<StockMoveRow>((from, to) =>
          supabase
            .from('stock_moves')
            .select('*')
            .eq('doc_type', docType)
            .eq('doc_id', docId)
            .eq('move_type', 'receive')
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to)
        )
      } catch (error) {
        if ((error as { code?: string })?.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      if (!moves.length) return { missing: false, data: [] }

      const unitIds = moves.filter((m) => m.ref_type === 'unit').map((m) => m.ref_id)
      const stockIds = moves.filter((m) => m.ref_type === 'warehouse_stock').map((m) => m.ref_id)

      const readIn = async (table: string, columns: string, ids: string[]) => {
        const rows: Record<string, unknown>[] = []
        for (const chunk of chunksOf([...new Set(ids)], 100)) {
          const { data, error } = await supabase.from(table).select(columns).in('id', chunk)
          if (error) throw error
          rows.push(...((data || []) as unknown as Record<string, unknown>[]))
        }
        return { data: rows, error: null }
      }
      const [unitsRes, stockRes] = await Promise.all([
        readIn('inventory_units', 'id, serial_number, product_name, warehouse_id', unitIds),
        readIn('warehouse_stock', 'id, product_id, warehouse_id', stockIds),
      ])

      const unitById = new Map(
        (unitsRes.data || []).map((u: Record<string, unknown>) => [u.id as string, u])
      )
      const stockById = new Map(
        (stockRes.data || []).map((s: Record<string, unknown>) => [s.id as string, s])
      )

      // A bulk move only reaches a product through warehouse_stock, so the
      // product name needs one more hop that the serialized path does not.
      const productIds = [
        ...new Set(
          (stockRes.data || [])
            .map((s: Record<string, unknown>) => s.product_id as string | null)
            .filter((id): id is string => Boolean(id))
        ),
      ]
      const productsRes = await readIn('products', 'id, product_name', productIds)
      const productNameById = new Map(
        (productsRes.data || []).map((p: Record<string, unknown>) => [
          p.id as string,
          p.product_name as string,
        ])
      )

      const enriched: ReceiptMoveRow[] = moves.map((m) => {
        if (m.ref_type === 'unit') {
          const u = unitById.get(m.ref_id)
          return {
            ...m,
            serial_number: (u?.serial_number as string) ?? null,
            product_name: (u?.product_name as string) ?? null,
            warehouse_id: (u?.warehouse_id as string) ?? null,
          }
        }
        const s = stockById.get(m.ref_id)
        return {
          ...m,
          serial_number: null,
          product_name: s?.product_id
            ? productNameById.get(s.product_id as string) ?? null
            : null,
          warehouse_id: (s?.warehouse_id as string) ?? null,
        }
      })

      return { missing: false, data: enriched }
    } catch {
      return { missing: true, data: [] }
    }
  },
}

// ── Parts ─────────────────────────────────────────────────────────────────────

export const parts = {
  async list(): Promise<TableResult<PartRow[]>> {
    try {
      const data = await fetchAllRows<PartRow>((from, to) =>
        supabase.from('parts').select('*').order('part_name', { ascending: true }).order('id', { ascending: true }).range(from, to)
      )
      return { missing: false, data }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async get(id: string): Promise<PartRow> {
    const { data, error } = await supabase.from('parts').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(part: Partial<PartRow>): Promise<PartRow | undefined> {
    const { data, error } = await supabase
      .from('parts')
      .insert([{ ...part, created_date: new Date().toISOString(), updated_date: new Date().toISOString() }])
      .select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, part: Partial<PartRow>): Promise<PartRow | undefined> {
    const { data, error } = await supabase
      .from('parts')
      .update({ ...part, updated_date: new Date().toISOString() })
      .eq('id', id)
      .select()
    if (error) throw error
    return assertUpdated(data, 'Part')
  },
  async delete(id: string): Promise<void> {
    const { data, error } = await supabase.from('parts').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Part')
  },
  async adjustQuantity(id: string, delta: number): Promise<PartRow | undefined> {
    // Atomic RPC — no read-modify-write race condition (H-3 fix)
    const { data, error } = await supabase.rpc('adjust_part_quantity', { p_id: id, p_delta: delta })
    if (error) throw error
    return data?.[0]
  },
}

// ── Ticket Parts ──────────────────────────────────────────────────────────────

export const ticketParts = {
  async list(ticketId: string): Promise<TableResult<TicketPartRow[]>> {
    try {
      const data = await fetchAllRows<TicketPartRow>((from, to) =>
        supabase
          .from('ticket_parts')
          .select('*, part:parts(part_name, part_number)')
          .eq('ticket_id', ticketId)
          .order('created_date', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)
      )
      return { missing: false, data }
    } catch {
      return { missing: true, data: [] }
    }
  },
  // Stock and the ticket_parts row change in one transaction (BUG-030). The
  // table is not writable directly; added_by is the signed-in user.
  async add(
    ticketId: string,
    partId: string,
    quantity: number,
    unitCost: number | null,
    notes: string | null
  ): Promise<TicketPartRow | undefined> {
    const { data, error } = await supabase.rpc('rma_ticket_part_add', {
      p_ticket_id: ticketId,
      p_part_id: partId,
      p_quantity: quantity,
      p_unit_cost: unitCost,
      p_notes: notes || null,
    })
    if (error) throw error
    const row = data as TicketPartRow | null
    if (!row) return undefined
    const { data: withPart } = await supabase
      .from('ticket_parts')
      .select('*, part:parts(part_name, part_number)')
      .eq('id', row.id)
      .maybeSingle()
    return (withPart as TicketPartRow | null) ?? row
  },
  // Returns the removed row's own quantity to its own part (BUG-030).
  async remove(id: string): Promise<void> {
    const { error } = await supabase.rpc('rma_ticket_part_remove', { p_id: id })
    if (error) throw error
  },
}

// ── Time Tracking ─────────────────────────────────────────────────────────────

export const timeEntries = {
  async list(ticketId: string): Promise<TableResult<TimeEntryRow[]>> {
    try {
      const data = await fetchAllRows<TimeEntryRow>((from, to) =>
        supabase
          .from('time_entries')
          .select('*')
          .eq('ticket_id', ticketId)
          .order('created_date', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to)
      )
      return { missing: false, data }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async create(entry: Partial<TimeEntryRow>): Promise<TimeEntryRow | undefined> {
    const { data, error } = await supabase
      .from('time_entries')
      .insert([{ ...entry, created_date: new Date().toISOString() }])
      .select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, updates: Partial<TimeEntryRow>): Promise<TimeEntryRow | undefined> {
    const { data, error } = await supabase.from('time_entries').update(updates).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Time entry')
  },
  async delete(id: string): Promise<void> {
    const { data, error } = await supabase.from('time_entries').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Time entry')
  },
  async getTotalMinutes(ticketId: string): Promise<number> {
    try {
      const data = await fetchAllRows<{ id: string; duration_min: number | null }>((from, to) =>
        supabase
          .from('time_entries')
          .select('id, duration_min')
          .eq('ticket_id', ticketId)
          .not('duration_min', 'is', null)
          .order('id', { ascending: true })
          .range(from, to)
      )
      return data.reduce((sum, e) => sum + (e.duration_min || 0), 0)
    } catch {
      return 0
    }
  },
}
