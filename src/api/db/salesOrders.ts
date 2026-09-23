import { supabase } from '../client.js'
import { assertUpdated } from './_assertUpdated.js'
import { fetchAllRows, chunksOf } from './_paging.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface SalesOrderLine {
  product_id: string
  product_name: string
  description?: string | null
  qty: number
  unit_price: number
  discount_pct?: number | null
  tax_pct?: number | null
}

/** A row of `sales_order_lines` (20260884) — the source of truth behind `line_items`. */
export interface SalesOrderLineRow {
  id: string
  sales_order_id: string
  line_no: number
  product_id: string | null
  product_name: string
  description: string | null
  qty: number
  unit_price: number
  discount_pct: number
  tax_pct: number
}

export interface SalesOrderRow {
  id: string
  so_code: string
  quotation_id: string | null
  customer_id: string
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'confirmed' | 'delivered' | 'cancelled'
  line_items: SalesOrderLine[]
  subtotal: number
  discount_amount: number
  tax_amount: number
  total: number
  delivery_date: string | null
  payment_terms: string | null
  reference_po: string | null
  notes: string | null
  assigned_rep: string | null
  created_by: string
  created_at: string
  updated_at: string
  confirmed_at: string | null
  delivered_at: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Module ────────────────────────────────────────────────────────────────────

export const salesOrders = {
  async list(filters?: {
    customerId?: string
    status?: string
    assignedRep?: string
    quotationId?: string
    /** Resolve SOs for several quotations at once — a deal can hold many. */
    quotationIds?: string[]
  }): Promise<SalesOrderRow[]> {
    // Every matching order, newest first — not the first 1 000 — with a long
    // quotationIds list asked for in chunks. (BUG-066.)
    const read = (quotationIds?: string[]) =>
      fetchAllRows<SalesOrderRow>((from, to) => {
        let q = supabase.from('sales_orders').select('*')
        if (filters?.customerId) q = q.eq('customer_id', filters.customerId)
        if (filters?.status) q = q.eq('status', filters.status)
        if (filters?.assignedRep) q = q.eq('assigned_rep', filters.assignedRep)
        if (filters?.quotationId) q = q.eq('quotation_id', filters.quotationId)
        if (quotationIds) q = q.in('quotation_id', quotationIds)
        return q.order('created_at', { ascending: false }).order('id', { ascending: true }).range(from, to)
      })
    try {
      if (!filters?.quotationIds) return await read()
      if (filters.quotationIds.length === 0) return []
      const parts = await Promise.all(chunksOf(filters.quotationIds, 100).map((ids) => read(ids)))
      return parts.flat().sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? -1 : 1))
    } catch (error) {
      if ((error as { code?: string })?.code === '42P01') return []
      throw error
    }
  },

  async get(id: string): Promise<SalesOrderRow | null> {
    const { data, error } = await supabase.from('sales_orders').select('*').eq('id', id).single()
    if (error) {
      if (error.code === 'PGRST116') return null
      throw error
    }
    return data as SalesOrderRow
  },

  /**
   * Writes the order and its lines atomically through `create_sales_order`
   * (20260884): the lines land in `sales_order_lines` (each a real catalogue
   * product), totals are computed in the database, and `line_items` is kept as
   * a mirror of those rows. An order is linked to a quotation only by
   * `convert_quotation_to_so`, so there is no `quotation_id` here.
   */
  async create(input: {
    customer_id: string
    line_items?: SalesOrderLine[]
    delivery_date?: string | null
    payment_terms?: string | null
    reference_po?: string | null
    notes?: string | null
    assigned_rep?: string | null
    created_by: string
  }): Promise<SalesOrderRow> {
    const { data, error } = await supabase.rpc('create_sales_order', {
      p_customer_id: input.customer_id,
      p_lines: input.line_items ?? [],
      p_delivery_date: input.delivery_date ?? null,
      p_payment_terms: input.payment_terms ?? null,
      p_reference_po: input.reference_po ?? null,
      p_notes: input.notes ?? null,
      p_assigned_rep: input.assigned_rep ?? null,
      p_actor_email: input.created_by,
    })
    if (error) throw error
    return data as SalesOrderRow
  },

  /**
   * Every edit goes through `update_sales_order` — only on a DRAFT order (a sent
   * one awaits approval; a confirmed one holds stock for its lines). With
   * `line_items` it replaces the line set; it sets only the header fields that
   * were passed (a key with null blanks it). `actorEmail` is display-only.
   */
  async update(
    id: string,
    fields: Partial<
      Pick<
        SalesOrderRow,
        | 'line_items'
        | 'delivery_date'
        | 'payment_terms'
        | 'reference_po'
        | 'notes'
        | 'assigned_rep'
      >
    >,
    actorEmail?: string
  ): Promise<SalesOrderRow> {
    const { line_items, ...header } = fields
    const { data, error } = await supabase.rpc('update_sales_order', {
      p_id: id,
      p_lines: line_items ?? null,
      p_fields: Object.fromEntries(Object.entries(header).filter(([, v]) => v !== undefined)),
      p_actor_email: actorEmail ?? null,
    })
    if (error) throw error
    return data as SalesOrderRow
  },

  /** The relational lines directly (20260884) — sales_order_lines, not the line_items mirror. */
  async lines(salesOrderId: string): Promise<SalesOrderLineRow[]> {
    return fetchAllRows<SalesOrderLineRow>((from, to) =>
      supabase
        .from('sales_order_lines')
        .select('*')
        .eq('sales_order_id', salesOrderId)
        .order('line_no', { ascending: true })
        .range(from, to)
    )
  },

  async markSent(soId: string): Promise<SalesOrderRow> {
    const { data, error } = await supabase
      .from('sales_orders')
      .update({ status: 'sent' })
      .eq('id', soId)
      .select()
    if (error) throw error
    return assertUpdated(data as SalesOrderRow[] | null, 'Sales order')
  },

  /**
   * markAccepted: delegates to approve_sales_order RPC which reserves every
   * line's inventory by derived type (serialized → reserve_units; bulk →
   * reserve_warehouse_stock; service → no-op) and sets status='confirmed'
   * atomically in one transaction. 'confirmed', not 'delivered': the stock is
   * held for the customer but has not left (delivered_at stays empty; the
   * units move to delivered when the invoice posts). A line with no valid
   * quantity refuses the approval. Role check (manager+) is enforced
   * server-side. Closes H1, H4a, M1, M5; BL-04 (20260879).
   */
  async markAccepted(soId: string, actorEmail: string): Promise<SalesOrderRow> {
    const { data, error } = await supabase.rpc('approve_sales_order', {
      p_so_id: soId,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    const rows = data as SalesOrderRow[]
    return rows[0]
  },

  /**
   * markDeclined: delegates to reject_sales_order RPC (role-checked, locked).
   * Only an order awaiting approval ('sent') can be rejected; one that was
   * already approved holds stock and has to be cancelled, which releases it.
   */
  async markDeclined(soId: string, actorEmail = 'system'): Promise<SalesOrderRow> {
    const { data, error } = await supabase.rpc('reject_sales_order', {
      p_so_id: soId,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    const rows = data as SalesOrderRow[]
    return rows[0]
  },

  /**
   * cancel: delegates to cancel_sales_order RPC which checks for a live
   * invoice first, releases serialized AND bulk reservations, then sets
   * status='cancelled'. Works from any not-yet-invoiced status. Closes H2;
   * bulk release BL-04 (20260879).
   */
  async cancel(soId: string, actorEmail: string): Promise<SalesOrderRow> {
    const { data, error } = await supabase.rpc('cancel_sales_order', {
      p_so_id: soId,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    const rows = data as SalesOrderRow[]
    return rows[0]
  },

  /**
   * convertToInvoice: creates a crm_invoices draft from this sales order.
   * Returns the new invoice id.
   */
  async convertToInvoice(soId: string, actorEmail: string): Promise<string> {
    const so = await salesOrders.get(soId)
    if (!so) throw new Error('Sales order not found')
    if (so.status === 'cancelled') {
      throw new Error('Cannot invoice a cancelled sales order')
    }
    // The database refuses this too (trg_crm_invoices_from_approved_order);
    // saying so here gives the person the reason before the round trip.
    if (so.status !== 'confirmed' && so.status !== 'delivered') {
      throw new Error('Approve the sales order before invoicing it')
    }

    // Prevent re-conversion if a non-cancelled invoice already exists for this SO.
    const { data: existingInv } = await supabase
      .from('crm_invoices')
      .select('id')
      .eq('so_id', soId)
      .neq('doc_status', 'cancelled')
      .limit(1)
    if (existingInv && existingInv.length > 0) {
      throw new Error('This sales order has already been converted to an invoice')
    }

    // inv_code stays NULL on draft — it is assigned only on post() via
    // the nextval_for_type RPC (gapless sequential requirement).
    const { data, error } = await supabase
      .from('crm_invoices')
      .insert({
        so_id: soId,
        customer_id: so.customer_id,
        doc_status: 'draft',
        payment_status: 'unpaid',
        line_items: so.line_items,
        subtotal: so.subtotal,
        discount_amount: so.discount_amount,
        tax_amount: so.tax_amount,
        total: so.total,
        payment_terms: so.payment_terms,
        reference_po: so.reference_po,
        notes: so.notes,
        assigned_rep: so.assigned_rep ?? actorEmail,
        created_by: actorEmail,
      })
      .select('id')
      .single()
    if (error) throw error
    return (data as { id: string }).id
  },
}
