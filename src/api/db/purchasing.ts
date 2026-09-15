import { supabase } from '../client.js'
import type { PagedResult } from './types.js'
import { assertUpdated, assertAffected } from './_assertUpdated.js'
import { fetchPage, fetchAllRows } from './_paging.js'
import { orIlike } from '../../lib/searchPattern.js'

// ── Row types ─────────────────────────────────────────────────────────────────
// Vendors are Brands (src/api/db/catalog.ts `brands`) — there is no separate
// vendors table (Purchasing redesign, 20260756/20260757). Purchase documents
// store a `vendor_id` that is a `brands.id`.

export interface PurchaseLine {
  product_id: string
  product_name: string
  description?: string | null
  qty_ordered: number
  qty_received?: number
  unit_cost: number
  discount_pct?: number | null
  tax_pct?: number | null
}

export type PurchaseDocType = 'purchase_order' | 'vendor_invoice'

export interface PurchaseOrderRow {
  id: string
  po_code: string
  vendor_id: string
  status:
    | 'draft'
    | 'sent'
    | 'pending_confirmation'
    | 'confirmed'
    | 'partially_completed'
    | 'completed'
    | 'cancelled'
    | 'expired'
  line_items: PurchaseLine[]
  subtotal: number
  discount_amount: number
  tax_amount: number
  total: number
  issue_date: string | null
  expected_delivery_date: string | null
  currency: string
  exchange_rate: number
  total_base: number | null
  payment_terms: string | null
  delivery_terms: string | null
  shipping_address: string | null
  billing_address: string | null
  terms_conditions: string | null
  notes: string | null
  archived: boolean
  archived_at: string | null
  archived_by: string | null
  created_by: string
  created_at: string
  updated_at: string | null
}

export interface VendorInvoiceRow {
  id: string
  vi_code: string | null
  purchase_order_id: string | null
  vendor_id: string
  status: 'draft' | 'pending_approval' | 'approved' | 'partially_received' | 'received' | 'cancelled'
  line_items: PurchaseLine[]
  subtotal: number
  discount_amount: number
  tax_amount: number
  total: number
  invoice_date: string | null
  due_date: string | null
  currency: string
  exchange_rate: number
  total_base: number | null
  notes: string | null
  /** In the invoice's own `currency` — settlement may not cross currencies. */
  amount_paid: number
  payment_status: 'unpaid' | 'partial' | 'paid' | 'reversed'
  paid_at: string | null
  archived: boolean
  archived_at: string | null
  archived_by: string | null
  created_by: string
  created_at: string
  updated_at: string | null
  approved_at: string | null
  received_at: string | null
}

export interface PurchaseDocumentRow {
  id: string
  doc_type: PurchaseDocType
  doc_code: string | null
  vendor_id: string
  created_by: string
  doc_status: string
  payment_status: string | null
  /** In the document's own `currency`. Never add these across rows. */
  total: number
  currency: string
  exchange_rate: number
  /** `total` converted to the base currency. Use this for any total. */
  total_base: number | null
  created_at: string
  updated_at: string | null
  type_specific_date: string | null
  type_specific_date_label: string | null
  archived: boolean
  archived_at: string | null
}

/** A document as the Purchasing page lists it (v_purchase_documents_list, 20260862). */
export interface PurchaseDocumentListRow extends PurchaseDocumentRow {
  vendor_name: string | null
  /** `total_base`, or `total` at the document's rate for a row that predates it. */
  total_base_value: number
}

// ── Paged reads (BUG-066) ─────────────────────────────────────────────────────
// The page loaded every document and did the tab split, counts, search,
// filters, sort, paging, spend graph and pivot in the browser — past the Data
// API's 1 000-row cap, part of the documents shown as all of them.

/** 'all' and the two types are the active documents; 'archive' the archived; 'any' every one. */
export type PurchaseDocTab = 'all' | PurchaseDocType | 'archive' | 'any'

export interface PurchaseDocFilters {
  tab?: PurchaseDocTab
  status?: string
  vendorId?: string
  /** Code or vendor name. */
  search?: string
}

export interface PurchaseDocSort {
  key: string
  direction: 'asc' | 'desc'
}

export interface PurchaseDocSummary {
  counts: Record<'all' | PurchaseDocType | 'archive' | 'total', number>
  statuses: string[]
}

/** Documents counted and base-currency spend summed, per type × status × vendor × created month. */
export interface PurchaseDocBucket {
  doc_type: PurchaseDocType
  doc_status: string
  vendor_id: string | null
  vendor_name: string | null
  /** 'YYYY-MM' in the viewer's time zone. */
  created_month: string | null
  doc_count: number
  spend: number
}

interface PurchaseDocFilterable<Q> {
  eq(column: string, value: unknown): Q
  or(filters: string): Q
}

export function applyPurchaseDocFilters<Q extends PurchaseDocFilterable<Q>>(query: Q, f: PurchaseDocFilters): Q {
  let q = query
  if (f.tab === 'archive') q = q.eq('archived', true)
  else if (f.tab !== 'any') {
    q = q.eq('archived', false)
    if (f.tab && f.tab !== 'all') q = q.eq('doc_type', f.tab)
  }
  if (f.status) q = q.eq('doc_status', f.status)
  if (f.vendorId) q = q.eq('vendor_id', f.vendorId)
  const search = f.search?.trim()
  if (search) q = q.or(orIlike(['doc_code', 'vendor_name'], search))
  return q
}

/**
 * Sortable columns → the column ordered on. Codes and vendors sort
 * case-insensitively; a document with no vendor name sorts after every name;
 * totals sort in base currency; a missing date sorts first, as the page's
 * `new Date(0)` did.
 */
export function resolvePurchaseDocSort(sort?: PurchaseDocSort): { column: string; ascending: boolean; nullsFirst: boolean } {
  const ascending = sort ? sort.direction === 'asc' : false
  switch (sort?.key) {
    case 'doc_type':
    case 'doc_status':
    case 'type_specific_date':
    case 'created_at':
      return { column: sort.key, ascending, nullsFirst: ascending }
    case 'doc_code':
      return { column: 'doc_code_sort', ascending, nullsFirst: ascending }
    case 'vendor':
      return { column: 'vendor_sort', ascending, nullsFirst: !ascending }
    case 'total':
      return { column: 'total_base_value', ascending, nullsFirst: ascending }
    default:
      return { column: 'created_at', ascending: false, nullsFirst: false }
  }
}

function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeTotals(lines: PurchaseLine[]): {
  subtotal: number
  discount_amount: number
  tax_amount: number
  total: number
} {
  let subtotal = 0
  let discount_amount = 0
  let tax_amount = 0

  for (const line of lines) {
    const lineBase = line.qty_ordered * line.unit_cost
    const disc = lineBase * ((line.discount_pct ?? 0) / 100)
    const afterDisc = lineBase - disc
    const tax = afterDisc * ((line.tax_pct ?? 0) / 100)
    subtotal += lineBase
    discount_amount += disc
    tax_amount += tax
  }

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    discount_amount: Math.round(discount_amount * 100) / 100,
    tax_amount: Math.round(tax_amount * 100) / 100,
    total: Math.round((subtotal - discount_amount + tax_amount) * 100) / 100,
  }
}

// ── Purchase Orders ───────────────────────────────────────────────────────────
// Non-financial — never touches inventory. completed/partially_completed are
// set server-side by receive_vendor_invoice when a linked VI is received.

export const purchaseOrders = {
  /** Every purchase order, newest first — all of them, not the first 1 000. (BUG-066.) */
  async list(): Promise<PurchaseOrderRow[]> {
    return fetchAllRows<PurchaseOrderRow>((from, to) =>
      supabase
        .from('purchase_orders')
        .select('*')
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
    )
  },
  async get(id: string): Promise<PurchaseOrderRow> {
    const { data, error } = await supabase.from('purchase_orders').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(input: {
    vendorId: string
    lineItems: PurchaseLine[]
    issueDate?: string
    expectedDeliveryDate?: string
    /** ISO 4217. Required since 20260792 — the column is NOT NULL. */
    currency: string
    /**
     * Units of base currency per one unit of `currency`. Must be exactly 1 for a
     * base-currency document and something else for a foreign one; the database
     * refuses anything else, because a rate of 1 on a USD invoice would record
     * dollars as though they were pounds.
     */
    exchangeRate?: number
    paymentTerms?: string
    deliveryTerms?: string
    shippingAddress?: string
    billingAddress?: string
    termsConditions?: string
    notes?: string
    createdBy: string
  }): Promise<PurchaseOrderRow> {
    const { data: code, error: codeErr } = await supabase.rpc('generate_doc_code', { p_prefix: 'PO' })
    if (codeErr) throw codeErr
    const totals = computeTotals(input.lineItems)
    const { data: row, error } = await supabase
      .from('purchase_orders')
      .insert([
        {
          po_code: code,
          vendor_id: input.vendorId,
          line_items: input.lineItems,
          ...totals,
          issue_date: input.issueDate || null,
          expected_delivery_date: input.expectedDeliveryDate || null,
          currency: input.currency,
          exchange_rate: input.exchangeRate ?? 1,
          payment_terms: input.paymentTerms || null,
          delivery_terms: input.deliveryTerms || null,
          shipping_address: input.shippingAddress || null,
          billing_address: input.billingAddress || null,
          terms_conditions: input.termsConditions || null,
          notes: input.notes || null,
          created_by: input.createdBy,
        },
      ])
      .select()
    if (error) throw error
    return row[0]
  },
  async update(id: string, fields: Partial<PurchaseOrderRow>): Promise<PurchaseOrderRow> {
    const patch = { ...fields } as Partial<PurchaseOrderRow>
    if (patch.line_items) Object.assign(patch, computeTotals(patch.line_items))
    const { data, error } = await supabase.from('purchase_orders').update(patch).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Purchase order')
  },
  /** markSent — also used as the "Send for Approval" step; the PO sits here until a manager approves it (via Activities) into Confirmed. */
  async markSent(id: string): Promise<void> {
    const { data, error } = await supabase.from('purchase_orders').update({ status: 'sent' }).eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Purchase order')
  },
  async markConfirmed(id: string): Promise<void> {
    const { data, error } = await supabase.from('purchase_orders').update({ status: 'confirmed' }).eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Purchase order')
  },
  /** rejectToDraft — sends a pending-approval PO back to draft, editable and resubmittable (mirrors vendorInvoices.rejectToDraft). */
  async rejectToDraft(id: string): Promise<void> {
    const { data, error } = await supabase.from('purchase_orders').update({ status: 'draft' }).eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Purchase order')
  },
  async cancel(id: string): Promise<void> {
    const { data, error } = await supabase.from('purchase_orders').update({ status: 'cancelled' }).eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Purchase order')
  },
  /**
   * convertToVendorInvoice — preserves vendor/lines/notes/totals and keeps the
   * purchase_order_id link; caller may pass `overrides` to change fields
   * (e.g. from a "review before saving" edit step) before insert. Lands in
   * 'draft' (the DB default) — a Vendor Invoice always needs its own
   * submit-for-approval step, even converted from an already-confirmed PO.
   */
  async convertToVendorInvoice(
    poId: string,
    createdBy: string,
    overrides?: Partial<{
      lineItems: PurchaseLine[]
      invoiceDate: string
      dueDate: string
      notes: string
    }>
  ): Promise<VendorInvoiceRow> {
    const po = await purchaseOrders.get(poId)
    const lineItems = (overrides?.lineItems ?? po.line_items).map((l) => ({ ...l, qty_received: 0 }))
    const totals = computeTotals(lineItems)
    const { data, error } = await supabase
      .from('vendor_invoices')
      .insert([
        {
          purchase_order_id: poId,
          vendor_id: po.vendor_id,
          line_items: lineItems,
          ...totals,
          invoice_date: overrides?.invoiceDate || null,
          due_date: overrides?.dueDate || null,
          notes: overrides?.notes ?? po.notes,
          created_by: createdBy,
        },
      ])
      .select()
    if (error) throw error
    return data[0]
  },
}

// ── Vendor Invoices ───────────────────────────────────────────────────────────
// The financial document — approval gates receipt; receipt triggers
// inventory + the vendor-payable balance (see vendorPayments.ts).

export const vendorInvoices = {
  /**
   * Every vendor invoice matching the filters, newest first — all of them, not
   * the first 1 000. `vendorId` and `statuses` narrow in the database, so a
   * payment's open invoices are read for that vendor alone. (BUG-066.)
   */
  async list(filters?: { purchaseOrderId?: string; vendorId?: string; statuses?: string[] }): Promise<VendorInvoiceRow[]> {
    return fetchAllRows<VendorInvoiceRow>((from, to) => {
      let q = supabase.from('vendor_invoices').select('*')
      if (filters?.purchaseOrderId) q = q.eq('purchase_order_id', filters.purchaseOrderId)
      if (filters?.vendorId) q = q.eq('vendor_id', filters.vendorId)
      if (filters?.statuses?.length) q = q.in('status', filters.statuses)
      return q.order('created_at', { ascending: false }).order('id', { ascending: true }).range(from, to)
    })
  },
  async get(id: string): Promise<VendorInvoiceRow> {
    const { data, error } = await supabase.from('vendor_invoices').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(input: {
    vendorId: string
    purchaseOrderId?: string
    lineItems: PurchaseLine[]
    invoiceDate?: string
    dueDate?: string
    /** ISO 4217. Required since 20260792 — the column is NOT NULL. */
    currency: string
    /**
     * Units of base currency per one unit of `currency`. This is the rate that
     * costs the received stock, so it is the one number on this document that
     * later determines every margin drawn from it.
     */
    exchangeRate?: number
    notes?: string
    createdBy: string
  }): Promise<VendorInvoiceRow> {
    const lineItems = input.lineItems.map((l) => ({ ...l, qty_received: l.qty_received ?? 0 }))
    const totals = computeTotals(lineItems)
    const { data, error } = await supabase
      .from('vendor_invoices')
      .insert([
        {
          purchase_order_id: input.purchaseOrderId || null,
          vendor_id: input.vendorId,
          line_items: lineItems,
          ...totals,
          currency: input.currency,
          exchange_rate: input.exchangeRate ?? 1,
          invoice_date: input.invoiceDate || null,
          due_date: input.dueDate || null,
          notes: input.notes || null,
          created_by: input.createdBy,
        },
      ])
      .select()
    if (error) throw error
    return data[0]
  },
  /** update — intended for pre-approval edits only; the UI gates this by status. */
  async update(id: string, fields: Partial<VendorInvoiceRow>): Promise<VendorInvoiceRow> {
    const patch = { ...fields } as Partial<VendorInvoiceRow>
    if (patch.line_items) Object.assign(patch, computeTotals(patch.line_items))
    const { data, error } = await supabase.from('vendor_invoices').update(patch).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Vendor invoice')
  },
  async submitForApproval(id: string): Promise<void> {
    const { data, error } = await supabase
      .from('vendor_invoices')
      .update({ status: 'pending_approval' })
      .eq('id', id)
      .select('id')
    if (error) throw error
    assertAffected(data, 'Vendor invoice')
  },
  async approve(id: string): Promise<void> {
    const { data, error } = await supabase
      .from('vendor_invoices')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')
    if (error) throw error
    assertAffected(data, 'Vendor invoice')
  },
  /** rejectToDraft — sends a pending-approval VI back to draft, editable and resubmittable. */
  async rejectToDraft(id: string): Promise<void> {
    const { data, error } = await supabase.from('vendor_invoices').update({ status: 'draft' }).eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Vendor invoice')
  },
  async cancel(id: string): Promise<void> {
    const { data, error } = await supabase.from('vendor_invoices').update({ status: 'cancelled' }).eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Vendor invoice')
  },
  /**
   * receive — the atomic receipt path (Sprint 9, status guard updated by the
   * Purchasing redesign to approved/partially_received). p_receipt_lines shape:
   * serialized: { productId, warehouseId, serials: string[] }
   * bulk:       { productId, warehouseId, qty: number }
   * Also syncs the linked Purchase Order's completed/partially_completed
   * status server-side (20260758_receive_vi_po_completion.sql).
   */
  async receive(
    viId: string,
    receiptLines: Array<{ productId: string; warehouseId: string; serials?: string[]; qty?: number }>,
    actorEmail: string
  ): Promise<void> {
    const { error } = await supabase.rpc('receive_vendor_invoice', {
      p_vi_id: viId,
      p_receipt_lines: receiptLines.map((l) => ({
        product_id: l.productId,
        warehouse_id: l.warehouseId,
        serials: l.serials,
        qty: l.qty,
      })),
      p_actor_email: actorEmail,
    })
    if (error) throw error
  },
}

// ── Unified "All" view ────────────────────────────────────────────────────────

const DOC_TABLE: Record<PurchaseDocType, string> = {
  purchase_order: 'purchase_orders',
  vendor_invoice: 'vendor_invoices',
}

export const purchaseDocuments = {
  /**
   * One page of documents, filtered and sorted in the database, with the exact
   * number that match. A purchase order and a vendor invoice can share an id,
   * so the tie breaker is type then id.
   */
  async listPage(
    filters: PurchaseDocFilters,
    sort: PurchaseDocSort | undefined,
    page: number,
    pageSize: number
  ): Promise<PagedResult<PurchaseDocumentListRow>> {
    const { column, ascending, nullsFirst } = resolvePurchaseDocSort(sort)
    return fetchPage<PurchaseDocumentListRow>((from, to) => {
      const base = supabase.from('v_purchase_documents_list').select('*', { count: 'exact' })
      return applyPurchaseDocFilters(base, filters)
        .order(column, { ascending, nullsFirst })
        .order('doc_type', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    }, page, pageSize)
  },

  /** Every document matching the filters, in the list's order — for an export. */
  async listAllMatching(filters: PurchaseDocFilters, sort?: PurchaseDocSort): Promise<PurchaseDocumentListRow[]> {
    const { column, ascending, nullsFirst } = resolvePurchaseDocSort(sort)
    return fetchAllRows<PurchaseDocumentListRow>((from, to) => {
      const base = supabase.from('v_purchase_documents_list').select('*')
      return applyPurchaseDocFilters(base, filters)
        .order(column, { ascending, nullsFirst })
        .order('doc_type', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    })
  },

  /** Tab counts (and the grand total) and the statuses present in `tab`. */
  async summary(tab: PurchaseDocTab): Promise<PurchaseDocSummary> {
    const { data, error } = await supabase.rpc('rma_purchase_document_summary', { p_tab: tab })
    if (error) throw error
    const s = (data ?? {}) as Partial<PurchaseDocSummary>
    const counts = (s.counts ?? {}) as Partial<PurchaseDocSummary['counts']>
    return {
      counts: {
        all: Number(counts.all ?? 0),
        purchase_order: Number(counts.purchase_order ?? 0),
        vendor_invoice: Number(counts.vendor_invoice ?? 0),
        archive: Number(counts.archive ?? 0),
        total: Number(counts.total ?? 0),
      },
      statuses: s.statuses ?? [],
    }
  },

  /**
   * Count and base-currency spend of the matching documents, per type × status
   * × vendor × created month (rma_purchase_document_buckets). Every number the
   * graph, the pivot and Vendor Details show is a sum of these rows. Cancelled
   * documents are included; the screens leave them out of spend.
   */
  async buckets(filters: PurchaseDocFilters): Promise<PurchaseDocBucket[]> {
    const rows = await fetchAllRows<PurchaseDocBucket>((from, to) =>
      supabase
        .rpc('rma_purchase_document_buckets', {
          p_tab: filters.tab ?? 'all',
          p_status: filters.status || null,
          p_vendor_id: filters.vendorId || null,
          p_term: filters.search?.trim() || null,
          p_tz: viewerTimeZone(),
        })
        .order('doc_type', { ascending: true })
        .order('doc_status', { ascending: true })
        .order('vendor_id', { ascending: true })
        .order('created_month', { ascending: true })
        .range(from, to)
    )
    return rows.map((r) => ({ ...r, doc_count: Number(r.doc_count), spend: Number(r.spend) }))
  },

  /**
   * setArchived — archive (or restore) a purchase document. Documents are
   * never deleted; archiving only flips a flag (mirrors salesDocuments.ts).
   */
  async setArchived(
    docType: PurchaseDocType,
    id: string,
    archived: boolean,
    actorEmail: string
  ): Promise<void> {
    const table = DOC_TABLE[docType]
    if (!table) throw new Error(`Unknown document type: ${docType}`)
    const { data, error } = await supabase
      .from(table)
      .update({
        archived,
        archived_at: archived ? new Date().toISOString() : null,
        archived_by: archived ? actorEmail : null,
      })
      .eq('id', id)
      .select('id')
    if (error) throw error
    assertAffected(data, 'Document')
  },
}

// ── Landed charges ────────────────────────────────────────────────────────────

export type ChargeType =
  | 'freight' | 'customs' | 'clearance' | 'insurance' | 'handling' | 'other'

export interface VendorInvoiceChargeRow {
  id: string
  vendor_invoice_id: string
  charge_type: ChargeType
  description: string | null
  /** In the vendor invoice's own currency, like its line items. */
  amount: number
  created_by: string | null
  created_at: string
}

/**
 * Freight, customs and clearance on a vendor invoice.
 *
 * These are part of what the goods cost. Left out, every imported item looks
 * cheaper than it was and its margin looks better than it is — on an air
 * shipment the freight alone can be a tenth of the invoice.
 *
 * The database refuses a change once the invoice has been received
 * (trg_charges_before_receipt, 20260794): the landed cost is already written
 * onto the units in stock by then, and editing the charge afterwards would
 * leave the invoice and the stock disagreeing with nothing to say which is
 * right.
 */
export const vendorInvoiceCharges = {
  async list(vendorInvoiceId: string): Promise<VendorInvoiceChargeRow[]> {
    try {
      return await fetchAllRows<VendorInvoiceChargeRow>((from, to) =>
        supabase
          .from('vendor_invoice_charges')
          .select('*')
          .eq('vendor_invoice_id', vendorInvoiceId)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)
      )
    } catch (error) {
      if ((error as { code?: string })?.code === '42P01') return []
      throw error
    }
  },

  async create(input: {
    vendorInvoiceId: string
    chargeType: ChargeType
    description?: string | null
    amount: number
    createdBy: string
  }): Promise<VendorInvoiceChargeRow> {
    const { data, error } = await supabase
      .from('vendor_invoice_charges')
      .insert({
        vendor_invoice_id: input.vendorInvoiceId,
        charge_type: input.chargeType,
        description: input.description?.trim() || null,
        amount: input.amount,
        created_by: input.createdBy,
      })
      .select()
      .single()
    if (error) throw error
    return data as VendorInvoiceChargeRow
  },

  async remove(id: string): Promise<void> {
    const { data, error } = await supabase.from('vendor_invoice_charges').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Charge')
  },
}

/**
 * What each line of a vendor invoice will cost per unit, landed, in base
 * currency — the same figure receive_vendor_invoice will write onto the stock,
 * from the same database function, so the preview cannot disagree with what
 * actually happens.
 */
export async function landedUnitCosts(
  vendorInvoiceId: string
): Promise<{ product_id: string; unit_cost_base: number }[]> {
  const { data, error } = await supabase.rpc('rma_vi_landed_unit_costs', {
    p_vi_id: vendorInvoiceId,
  })
  if (error) throw error
  return (data ?? []) as { product_id: string; unit_cost_base: number }[]
}
