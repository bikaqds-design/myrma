import { supabase } from '../client.js'
import type { TableResult } from './types.js'

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
  doc_type: 'sales_order' | 'invoice' | 'credit_note' | 'manual'
  doc_id: string | null
  move_type: 'reserve' | 'deliver' | 'release' | 'restore' | 'adjust' | 'receive' | 'transfer'
  qty: number
  from_status: string | null
  to_status: string | null
  actor_email: string
  created_at: string
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

export interface InvoiceRow {
  id: string
  type: 'invoice' | 'quote'
  invoice_number: string
  customer_name: string
  customer_email: string | null
  rma_number_ref: string | null
  ticket_id: string | null
  lineItems: unknown[]
  labour_hours: number | null
  labour_rate: number | null
  tax_pct: number | null
  notes: string | null
  due_date: string | null
  status: string
  created_date: string
  updated_date: string | null
}

export interface InventoryStatsRow {
  active_rma: number
  company_stock: number
  sent_to_manufacturer: number
  closed: number
  total: number
}

interface TicketProductInput {
  product_name?: string
  serial_number?: string
  warranty_status?: string
}

// ── Inventory Units ───────────────────────────────────────────────────────────

export const inventory = {
  async createUnitsFromTicket(
    ticketId: string,
    rmaNumber: string,
    products: TicketProductInput[]
  ): Promise<InventoryUnitRow[]> {
    if (!products?.length) return []
    const units = products
      .filter((p) => p.product_name || p.serial_number)
      .map((p) => ({
        rma_ticket_id: ticketId,
        rma_number: rmaNumber,
        product_name: p.product_name || '',
        serial_number: p.serial_number || '',
        warranty_status: p.warranty_status || '',
        status: 'active_rma',
        created_date: new Date().toISOString(),
      }))
    if (!units.length) return []
    const { data, error } = await supabase.from('inventory_units').insert(units).select()
    if (error) {
      if (error.code === '42P01') return []
      return []
    }
    return data || []
  },

  async listUnits(): Promise<TableResult<InventoryUnitRow[]>> {
    try {
      const { data, error } = await supabase
        .from('inventory_units')
        .select('*')
        .order('created_date', { ascending: false })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },

  async resolveUnits(
    ids: string[],
    resolutionType: string,
    notes?: string
  ): Promise<InventoryUnitRow[]> {
    const status = resolutionType === 'return_to_customer' ? 'closed' : 'company_stock'
    const { data, error } = await supabase
      .from('inventory_units')
      .update({ status, resolution_type: resolutionType, resolved_date: new Date().toISOString(), notes: notes || null })
      .in('id', ids)
      .select()
    if (error) throw error
    return data || []
  },

  async listBatches(): Promise<TableResult<ManufacturerBatchRow[]>> {
    try {
      const { data, error } = await supabase
        .from('manufacturer_batches')
        .select('*')
        .order('created_date', { ascending: false })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },

  async createBatch(
    unitIds: string[],
    manufacturerName: string,
    userEmail: string
  ): Promise<ManufacturerBatchRow> {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const { count } = await supabase
      .from('manufacturer_batches')
      .select('*', { count: 'exact', head: true })
    const batchNumber = `BATCH-${dateStr}-${String((count || 0) + 1).padStart(3, '0')}`
    const { data: batch, error: batchErr } = await supabase
      .from('manufacturer_batches')
      .insert([{ batch_number: batchNumber, manufacturer_name: manufacturerName, status: 'draft', unit_count: unitIds.length, created_date: new Date().toISOString(), created_by: userEmail }])
      .select()
    if (batchErr) throw batchErr
    const batchId = batch[0].id
    await supabase.from('inventory_units').update({ manufacturer_batch_id: batchId }).in('id', unitIds)
    return batch[0]
  },

  async markBatchSent(
    batchId: string,
    sentDate: string,
    trackingNumber: string
  ): Promise<ManufacturerBatchRow | undefined> {
    const { data, error } = await supabase
      .from('manufacturer_batches')
      .update({ status: 'sent', sent_date: sentDate, tracking_number: trackingNumber })
      .eq('id', batchId)
      .select()
    if (error) throw error
    await supabase.from('inventory_units').update({ status: 'sent_to_manufacturer' }).eq('manufacturer_batch_id', batchId)
    return data?.[0]
  },

  async markBatchResolved(
    batchId: string,
    resolutionType: string,
    resolutionDate: string,
    notes?: string
  ): Promise<ManufacturerBatchRow | undefined> {
    const { data, error } = await supabase
      .from('manufacturer_batches')
      .update({ status: 'resolved', resolution_type: resolutionType, resolution_date: resolutionDate, resolution_notes: notes })
      .eq('id', batchId)
      .select()
    if (error) throw error
    await supabase.from('inventory_units').update({ status: 'closed' }).eq('manufacturer_batch_id', batchId)
    return data?.[0]
  },

  async getStats(): Promise<InventoryStatsRow | null> {
    try {
      const { data, error } = await supabase.from('inventory_units').select('status')
      if (error) {
        if (error.code === '42P01') return null
        return null
      }
      const counts: InventoryStatsRow = { active_rma: 0, company_stock: 0, sent_to_manufacturer: 0, closed: 0, total: 0 }
      data.forEach((u: { status: string }) => {
        if (u.status in counts) (counts as Record<string, number>)[u.status]++
      })
      counts.total = data.length
      return counts
    } catch {
      return null
    }
  },

  async transferUnits(unitIds: string[], warehouseId: string | null): Promise<void> {
    if (!unitIds.length) throw new Error('No unit IDs provided')
    const { error } = await supabase
      .from('inventory_units')
      .update({ warehouse_id: warehouseId || null })
      .in('id', unitIds)
    if (error) throw error
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
    const { data, error } = await supabase
      .from('inventory_units')
      .select('*')
      .eq('rma_ticket_id', ticketId)
    if (error) {
      if (error.code === '42P01') return []
      throw error
    }
    return data || []
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

  /**
   * getStockSummary — per-product Available/Reserved/Delivered PLUS the
   * Warehouse Module R1 dashboard fields: Physical Total, Main, per-branch
   * and per-RMA-location breakdowns. Follows the same
   * fetch-raw-rows-then-aggregate-in-JS pattern as getStats() rather than a
   * DB view — matches existing convention in this file, and product/unit
   * counts at this system's scale don't warrant a server-side aggregate yet.
   *
   * "Main" = warehouses of type 'main' OR legacy NULL-type warehouses
   * (every warehouse created before the warehouse_type column existed) —
   * treated as the default sellable location, never more restrictive than
   * before this model. "Branches" = warehouse_type='branch' only.
   * physical_total excludes the SCRAP location and 'closed'-status units.
   *
   * Units whose product_id is NULL (created from a ticket whose product
   * doesn't match any catalog product by name) surface as synthetic
   * in_catalog:false rows, grouped by product_name — RMA counts only, no
   * available/reserved/delivered/branches/main (there is no catalog product
   * to attach those to).
   */
  async getStockSummary(): Promise<ProductStockSummary[]> {
    const [productsRes, unitsRes, stockRes, warehousesRes] = await Promise.all([
      supabase
        .from('products')
        .select('id, product_name, stock_tracking_mode')
        .neq('product_type', 'service'),
      supabase
        .from('inventory_units')
        .select('product_id, product_name, status, reservation_status, warehouse_id')
        .in('status', ['company_stock', 'active_rma']),
      supabase.from('warehouse_stock').select('product_id, warehouse_id, quantity, reserved_quantity'),
      supabase.from('warehouses').select('id, name, code, warehouse_type, is_system'),
    ])
    if (productsRes.error) throw productsRes.error
    if (unitsRes.error) throw unitsRes.error
    if (stockRes.error && stockRes.error.code !== '42P01') throw stockRes.error
    if (warehousesRes.error && warehousesRes.error.code !== '42P01') throw warehousesRes.error

    const products = productsRes.data || []
    const units = unitsRes.data || []
    const stockRows = stockRes.data || []
    const warehouseList = warehousesRes.data || []
    const whById = new Map(warehouseList.map((w) => [w.id, w]))

    const isMainOrLegacy = (w: (typeof warehouseList)[number] | undefined) =>
      !w || !w.warehouse_type || w.warehouse_type === 'main'
    const isBranch = (w: (typeof warehouseList)[number] | undefined) => w?.warehouse_type === 'branch'

    function branchBreakdown(rowsWithWarehouse: { warehouse_id: string | null; qty: number }[]) {
      const map = new Map<string, WarehouseQtyBreakdown>()
      for (const row of rowsWithWarehouse) {
        const w = row.warehouse_id ? whById.get(row.warehouse_id) : undefined
        if (!isBranch(w) || !w) continue
        const entry = map.get(w.id) || { warehouse_id: w.id, name: w.name, code: w.code, qty: 0 }
        entry.qty += row.qty
        map.set(w.id, entry)
      }
      return [...map.values()]
    }

    function rmaBreakdown(rmaUnits: { warehouse_id: string | null }[]) {
      const map = new Map<string, RmaLocationBreakdown>()
      for (const u of rmaUnits) {
        const w = u.warehouse_id ? whById.get(u.warehouse_id) : undefined
        if (!w?.is_system) continue // unplaced (pre-backfill) or a non-system warehouse — not a real RMA location
        const entry = map.get(w.id) || { warehouse_id: w.id, code: w.code || '', name: w.name, count: 0 }
        entry.count += 1
        map.set(w.id, entry)
      }
      return [...map.values()]
    }

    const summaries: ProductStockSummary[] = products.map((p) => {
      if (p.stock_tracking_mode === 'bulk') {
        const rows = stockRows.filter((s) => s.product_id === p.id)
        const totalQty = rows.reduce((sum, s) => sum + s.quantity, 0)
        const totalReserved = rows.reduce((sum, s) => sum + s.reserved_quantity, 0)
        const mainQty = rows
          .filter((r) => isMainOrLegacy(whById.get(r.warehouse_id)))
          .reduce((sum, r) => sum + r.quantity, 0)
        const branches = branchBreakdown(rows.map((r) => ({ warehouse_id: r.warehouse_id, qty: r.quantity })))
        const physicalTotal = rows
          .filter((r) => whById.get(r.warehouse_id)?.code !== 'SCRAP')
          .reduce((sum, r) => sum + r.quantity, 0)
        return {
          product_id: p.id,
          product_name: p.product_name,
          stock_tracking_mode: 'bulk',
          available: totalQty - totalReserved,
          reserved: totalReserved,
          delivered: 0,
          physical_total: physicalTotal,
          main_qty: mainQty,
          branches,
          rma: [], // bulk products don't get RMA-ticket units in R1 (createUnitsFromTicket is serialized-only)
          in_catalog: true,
        }
      }

      const productUnits = units.filter((u) => u.product_id === p.id)
      const companyStockUnits = productUnits.filter((u) => u.status === 'company_stock')
      const rmaUnits = productUnits.filter((u) => u.status === 'active_rma')
      const mainQty = companyStockUnits.filter((u) => isMainOrLegacy(whById.get(u.warehouse_id))).length
      const branches = branchBreakdown(companyStockUnits.map((u) => ({ warehouse_id: u.warehouse_id, qty: 1 })))
      const rma = rmaBreakdown(rmaUnits)
      const physicalTotal =
        companyStockUnits.filter((u) => whById.get(u.warehouse_id)?.code !== 'SCRAP').length +
        rma.filter((r) => r.code !== 'SCRAP').reduce((sum, r) => sum + r.count, 0)

      return {
        product_id: p.id,
        product_name: p.product_name,
        stock_tracking_mode: 'serialized',
        available: productUnits.filter((u) => u.reservation_status === 'available').length,
        reserved: productUnits.filter((u) => u.reservation_status === 'reserved').length,
        delivered: productUnits.filter((u) => u.reservation_status === 'delivered').length,
        physical_total: physicalTotal,
        main_qty: mainQty,
        branches,
        rma,
        in_catalog: true,
      }
    })

    // Synthetic rows for active_rma units whose product_id is NULL (no catalog
    // match at ticket-creation time) — grouped by product_name so they're still
    // visible on the dashboard instead of silently disappearing.
    const unmatchedByName = new Map<string, typeof units>()
    for (const u of units) {
      if (u.product_id || u.status !== 'active_rma') continue
      const key = u.product_name || 'Unknown Product'
      const list = unmatchedByName.get(key) || []
      list.push(u)
      unmatchedByName.set(key, list)
    }
    for (const [name, rmaUnits] of unmatchedByName) {
      const rma = rmaBreakdown(rmaUnits)
      summaries.push({
        product_id: `unmatched:${name}`,
        product_name: name,
        stock_tracking_mode: 'serialized',
        available: 0,
        reserved: 0,
        delivered: 0,
        physical_total: rma.filter((r) => r.code !== 'SCRAP').reduce((sum, r) => sum + r.count, 0),
        main_qty: 0,
        branches: [],
        rma,
        in_catalog: false,
      })
    }

    return summaries
  },
}

// ── Warehouses ────────────────────────────────────────────────────────────────

export const warehouses = {
  async list(): Promise<TableResult<WarehouseRow[]>> {
    try {
      const { data, error } = await supabase.from('warehouses').select('*').order('name', { ascending: true })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
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
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('warehouses').delete().eq('id', id)
    if (error) throw error
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

export const warehouseStock = {
  async list(): Promise<TableResult<WarehouseStockRow[]>> {
    try {
      const { data, error } = await supabase.from('warehouse_stock').select('*')
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async listByProduct(productId: string): Promise<WarehouseStockRow[]> {
    const { data, error } = await supabase
      .from('warehouse_stock')
      .select('*')
      .eq('product_id', productId)
    if (error) throw error
    return data || []
  },
}

// ── Stock moves (append-only movement ledger) ───────────────────────────────────

export const stockMoves = {
  async list(filters?: { refType?: string; refIds?: string[] }): Promise<TableResult<StockMoveRow[]>> {
    try {
      let query = supabase.from('stock_moves').select('*').order('created_at', { ascending: false })
      if (filters?.refType) query = query.eq('ref_type', filters.refType)
      if (filters?.refIds?.length) query = query.in('ref_id', filters.refIds)
      const { data, error } = await query
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },
}

// ── Parts ─────────────────────────────────────────────────────────────────────

export const parts = {
  async list(): Promise<TableResult<PartRow[]>> {
    try {
      const { data, error } = await supabase.from('parts').select('*').order('part_name', { ascending: true })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
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
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('parts').delete().eq('id', id)
    if (error) throw error
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
      const { data, error } = await supabase
        .from('ticket_parts')
        .select('*, part:parts(part_name, part_number)')
        .eq('ticket_id', ticketId)
        .order('created_date', { ascending: true })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async add(
    ticketId: string,
    partId: string,
    quantity: number,
    unitCost: number | null,
    notes: string | null,
    addedBy: string | null
  ): Promise<TicketPartRow | undefined> {
    await parts.adjustQuantity(partId, -quantity)
    const { data, error } = await supabase
      .from('ticket_parts')
      .insert([{ ticket_id: ticketId, part_id: partId, quantity, unit_cost: unitCost, notes: notes || null, added_by: addedBy || null, created_date: new Date().toISOString() }])
      .select('*, part:parts(part_name, part_number)')
    if (error) throw error
    return data?.[0]
  },
  async remove(id: string, partId: string, quantity: number): Promise<void> {
    await parts.adjustQuantity(partId, quantity)
    const { error } = await supabase.from('ticket_parts').delete().eq('id', id)
    if (error) throw error
  },
}

// ── Time Tracking ─────────────────────────────────────────────────────────────

export const timeEntries = {
  async list(ticketId: string): Promise<TableResult<TimeEntryRow[]>> {
    try {
      const { data, error } = await supabase
        .from('time_entries')
        .select('*')
        .eq('ticket_id', ticketId)
        .order('created_date', { ascending: false })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async listAll(): Promise<TableResult<unknown[]>> {
    try {
      const { data, error } = await supabase
        .from('time_entries')
        .select('*, ticket:rma_tickets(rma_number, customer_name)')
        .order('created_date', { ascending: false })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
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
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('time_entries').delete().eq('id', id)
    if (error) throw error
  },
  async getTotalMinutes(ticketId: string): Promise<number> {
    try {
      const { data, error } = await supabase
        .from('time_entries')
        .select('duration_min')
        .eq('ticket_id', ticketId)
        .not('duration_min', 'is', null)
      if (error) return 0
      return (data || []).reduce((sum, e: { duration_min: number | null }) => sum + (e.duration_min || 0), 0)
    } catch {
      return 0
    }
  },
}

// ── Invoices / Quotes ─────────────────────────────────────────────────────────

export const invoices = {
  async list(): Promise<TableResult<InvoiceRow[]>> {
    try {
      const { data, error } = await supabase
        .from('invoices')
        .select('*')
        .order('created_date', { ascending: false })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async get(id: string): Promise<InvoiceRow> {
    const { data, error } = await supabase.from('invoices').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(invoice: Partial<InvoiceRow>): Promise<InvoiceRow | undefined> {
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('invoices')
      .insert([{ ...invoice, created_date: now, updated_date: now }])
      .select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, updates: Partial<InvoiceRow>): Promise<InvoiceRow | undefined> {
    const { data, error } = await supabase
      .from('invoices')
      .update({ ...updates, updated_date: new Date().toISOString() })
      .eq('id', id)
      .select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('invoices').delete().eq('id', id)
    if (error) throw error
  },
  async generateNumber(existingInvoices: Array<{ invoice_number: string }> = []): Promise<string> {
    const now = new Date()
    const prefix = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-`
    const serials = existingInvoices
      .map((i) => i.invoice_number)
      .filter((n) => n?.startsWith(prefix))
      .map((n) => parseInt(n.replace(prefix, ''), 10))
      .filter((n) => !isNaN(n))
    const next = serials.length > 0 ? Math.max(...serials) + 1 : 1
    return `${prefix}${String(next).padStart(4, '0')}`
  },
}
