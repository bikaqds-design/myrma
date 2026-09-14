/**
 * Paged reads for the Inventory screen. (Audit finding BUG-066, phase 5.)
 *
 * The screen used to load every unit, stock move, warehouse stock row and the
 * whole catalogue, then group, count, search and page them in the browser —
 * past the Data API's 1 000-row cap, silently wrong. These read the views from
 * `20260854_inventory_list_views.sql` one page at a time instead, with the
 * grouping and the searchable labels done in the database.
 *
 * Per-product drill-downs (a product's units, its RMA units) use
 * `fetchAllRows`: they are scoped to one product, and every row they list is
 * individually actionable, so all of them are genuinely needed.
 */
import { supabase } from '../client.js'
import { fetchPage, fetchAllRows } from './_paging.js'
import type { PagedResult, TableResult } from './types.js'
import { orIlike } from '../../lib/searchPattern.js'
import type {
  InventoryUnitRow,
  ManufacturerBatchRow,
  ProductStockSummary,
  StockMoveRow,
} from './inventory.js'

// ── Row types ─────────────────────────────────────────────────────────────────

/** A unit as `v_inventory_units` returns it. */
export interface InventoryUnitListRow extends InventoryUnitRow {
  /** `product_name`, or "Unknown Product" — the All Units grouping key. */
  group_name: string
  brand_name: string | null
  ticket_customer_name: string | null
  ticket_status: string | null
}

/** One All Units row: a product name and its unit counts. */
export interface InventoryProductGroupRow {
  product_name: string
  brand: string
  total: number
  active_rma: number
  company_stock: number
  sent_to_manufacturer: number
  closed: number
  replacement: number
  credit_note: number
}

/** A dashboard row, with the two array sums the filters use. */
export interface StockSummaryRow extends ProductStockSummary {
  branch_total: number
  rma_total: number
}

export interface StockMoveListRow extends StockMoveRow {
  /** What moved, as the tab shows it: "Product (serial)" or "Product @ Warehouse". */
  ref_label: string
}

export interface BulkReservationRow {
  product_id: string
  doc_type: string
  doc_id: string | null
  qty: number
}

// ── Filters ───────────────────────────────────────────────────────────────────

interface Filterable<Q> {
  or(filters: string): Q
  eq(column: string, value: unknown): Q
  gt(column: string, value: unknown): Q
  is(column: string, value: null): Q
  in(column: string, values: readonly unknown[]): Q
}

export interface UnitFilters {
  warehouseId?: string
  /** Units with no warehouse, in this status. */
  unplacedStatus?: string
  productId?: string
  /** A product with no catalogue match: units with no product_id under this grouping name. */
  unmatchedName?: string
  /** The All Units grouping key. */
  groupName?: string
  status?: string
  /** Neither company stock nor on an RMA (including no status at all). */
  offStock?: boolean
  reservationStatus?: string
  /** Units that have a warehouse. */
  placed?: boolean
  /** Product, serial, RMA number, brand, or the ticket's customer. */
  search?: string
}

const UNIT_SEARCH_COLUMNS = ['product_name', 'serial_number', 'rma_number', 'brand_name', 'ticket_customer_name']

export function applyUnitFilters<Q extends Filterable<Q>>(query: Q, f: UnitFilters): Q {
  let q = query
  if (f.warehouseId) q = q.eq('warehouse_id', f.warehouseId)
  if (f.unplacedStatus) q = q.is('warehouse_id', null).eq('status', f.unplacedStatus)
  if (f.productId) q = q.eq('product_id', f.productId)
  if (f.unmatchedName !== undefined) q = q.is('product_id', null).eq('group_name', f.unmatchedName)
  if (f.groupName) q = q.eq('group_name', f.groupName)
  if (f.status) q = q.eq('status', f.status)
  if (f.offStock) q = q.or('status.is.null,status.not.in.(company_stock,active_rma)')
  if (f.reservationStatus) q = q.eq('reservation_status', f.reservationStatus)
  if (f.placed) q = q.or('warehouse_id.not.is.null')
  const search = f.search?.trim()
  if (search) q = q.or(orIlike(UNIT_SEARCH_COLUMNS, search))
  return q
}

export interface ProductGroupFilters {
  /** Product name or brand. */
  search?: string
  brand?: string
  /** Only groups with at least one unit in this status. */
  status?: string
  /** Product name only. */
  product?: string
}

/** The statuses a group can be filtered on — each is a count column in the view. */
export const GROUP_STATUS_COLUMNS = ['active_rma', 'company_stock', 'sent_to_manufacturer', 'closed'] as const

export function applyProductGroupFilters<Q extends Filterable<Q>>(query: Q, f: ProductGroupFilters): Q {
  let q = query
  const search = f.search?.trim()
  if (search) q = q.or(orIlike(['product_name', 'brand'], search))
  if (f.brand) q = q.eq('brand', f.brand)
  if (f.status && (GROUP_STATUS_COLUMNS as readonly string[]).includes(f.status)) q = q.gt(f.status, 0)
  const product = f.product?.trim()
  // A second .or() is ANDed with the first by PostgREST.
  if (product) q = q.or(orIlike(['product_name'], product))
  return q
}

export interface StockSummaryFilters {
  search?: string
  tracking?: string
  /** 'available' | 'reserved' | 'rma' | 'out' */
  stock?: string
}

export function applyStockSummaryFilters<Q extends Filterable<Q>>(query: Q, f: StockSummaryFilters): Q {
  let q = query
  const search = f.search?.trim()
  if (search) q = q.or(orIlike(['product_name'], search))
  if (f.tracking) q = q.eq('stock_tracking_mode', f.tracking)
  if (f.stock === 'available') q = q.gt('available', 0)
  if (f.stock === 'reserved') q = q.gt('reserved', 0)
  if (f.stock === 'rma') q = q.gt('rma_total', 0)
  if (f.stock === 'out') q = q.eq('physical_total', 0)
  return q
}

export interface StockMoveFilters {
  /** What moved, or who moved it. */
  search?: string
  moveType?: string
  docType?: string
}

export function applyStockMoveFilters<Q extends Filterable<Q>>(query: Q, f: StockMoveFilters): Q {
  let q = query
  if (f.moveType) q = q.eq('move_type', f.moveType)
  if (f.docType) q = q.eq('doc_type', f.docType)
  const search = f.search?.trim()
  if (search) q = q.or(orIlike(['ref_label', 'actor_email'], search))
  return q
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export const inventoryLists = {
  /** One page of units, newest first. */
  async unitsPage(filters: UnitFilters, page: number, pageSize: number): Promise<PagedResult<InventoryUnitListRow>> {
    return fetchPage<InventoryUnitListRow>((from, to) => {
      const base = supabase.from('v_inventory_units').select('*', { count: 'exact' })
      return applyUnitFilters(base, filters)
        .order('created_date', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
    }, page, pageSize)
  },

  /** Every unit matching `filters`, newest first — for a drill-down, a transfer or an export. */
  async allUnits(filters: UnitFilters): Promise<InventoryUnitListRow[]> {
    return fetchAllRows<InventoryUnitListRow>((from, to) => {
      const base = supabase.from('v_inventory_units').select('*')
      return applyUnitFilters(base, filters)
        .order('created_date', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
    })
  },

  async countUnits(filters: UnitFilters = {}): Promise<number> {
    const base = supabase.from('v_inventory_units').select('id', { count: 'exact', head: true })
    const { count, error } = await applyUnitFilters(base, filters)
    if (error) throw error
    return count ?? 0
  },

  /** All Units: one page of product groups, by brand then product, as the tab sorted them. */
  async productGroupsPage(
    filters: ProductGroupFilters,
    page: number,
    pageSize: number
  ): Promise<PagedResult<InventoryProductGroupRow>> {
    return fetchPage<InventoryProductGroupRow>((from, to) => {
      const base = supabase.from('v_inventory_product_groups').select('*', { count: 'exact' })
      return applyProductGroupFilters(base, filters)
        .order('brand', { ascending: true })
        .order('product_name', { ascending: true })
        .range(from, to)
    }, page, pageSize)
  },

  /** Overview: one page of product stock rows, largest physical stock first. */
  async stockSummaryPage(
    filters: StockSummaryFilters,
    page: number,
    pageSize: number
  ): Promise<PagedResult<StockSummaryRow>> {
    return fetchPage<StockSummaryRow>((from, to) => {
      const base = supabase.from('v_product_stock_summary').select('*', { count: 'exact' })
      return applyStockSummaryFilters(base, filters)
        .order('physical_total', { ascending: false })
        .order('product_name', { ascending: true })
        .order('product_id', { ascending: true })
        .range(from, to)
    }, page, pageSize)
  },

  /** One product's dashboard row, or null. */
  async stockSummaryFor(productId: string): Promise<StockSummaryRow | null> {
    const { data, error } = await supabase
      .from('v_product_stock_summary')
      .select('*')
      .eq('product_id', productId)
      .maybeSingle()
    if (error) throw error
    return (data as StockSummaryRow | null) ?? null
  },

  /** What each document still holds reserved of a bulk product. */
  async bulkReservations(productId: string): Promise<BulkReservationRow[]> {
    return fetchAllRows<BulkReservationRow>((from, to) =>
      supabase
        .from('v_bulk_stock_reservations')
        .select('*')
        .eq('product_id', productId)
        .order('doc_type', { ascending: true })
        .order('doc_id', { ascending: true })
        .range(from, to)
    )
  },

  /** `{ [warehouse_id]: unit count }`. */
  async warehouseUnitCounts(): Promise<Record<string, number>> {
    const rows = await fetchAllRows<{ warehouse_id: string; unit_count: number }>((from, to) =>
      supabase
        .from('v_warehouse_unit_counts')
        .select('warehouse_id, unit_count')
        .order('warehouse_id', { ascending: true })
        .range(from, to)
    )
    return Object.fromEntries(rows.map((r) => [r.warehouse_id, r.unit_count]))
  },

  /** Stock Movements: one page of the ledger, newest first. */
  async movesPage(filters: StockMoveFilters, page: number, pageSize: number): Promise<PagedResult<StockMoveListRow>> {
    return fetchPage<StockMoveListRow>((from, to) => {
      const base = supabase.from('v_stock_moves_listing').select('*', { count: 'exact' })
      return applyStockMoveFilters(base, filters)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
    }, page, pageSize)
  },

  async countMoves(): Promise<number> {
    const { count, error } = await supabase.from('stock_moves').select('id', { count: 'exact', head: true })
    if (error) {
      if (error.code === '42P01') return 0
      throw error
    }
    return count ?? 0
  },

  /** Every manufacturer batch, newest first, for the export. */
  async allBatches(): Promise<TableResult<ManufacturerBatchRow[]>> {
    try {
      const data = await fetchAllRows<ManufacturerBatchRow>((from, to) =>
        supabase
          .from('manufacturer_batches')
          .select('*')
          .order('created_date', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to)
      )
      return { missing: false, data }
    } catch (error) {
      if ((error as { code?: string })?.code === '42P01') return { missing: true, data: [] }
      throw error
    }
  },

  async countBatches(): Promise<number> {
    const { count, error } = await supabase.from('manufacturer_batches').select('id', { count: 'exact', head: true })
    if (error) {
      if (error.code === '42P01') return 0
      throw error
    }
    return count ?? 0
  },
}
