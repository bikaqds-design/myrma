import { supabase } from '../client.js'
import { ROW_LINES, withRowLines } from './_rowLines.js'
import { assertUpdated } from './_assertUpdated.js'
import { fetchAllRows } from './_paging.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface CrmInvoiceLine {
  product_id: string
  product_name: string
  description?: string | null
  qty: number
  unit_price: number
  discount_pct?: number | null
  tax_pct?: number | null
}

/** A row of `crm_invoice_lines` (20260885) — the source of truth behind `line_items`. */
export interface CrmInvoiceLineRow {
  id: string
  crm_invoice_id: string
  line_no: number
  product_id: string | null
  product_name: string
  description: string | null
  qty: number
  unit_price: number
  discount_pct: number
  tax_pct: number
}

export interface CrmInvoiceRow {
  id: string
  inv_code: string | null
  so_id: string | null
  /** The delivery this invoice bills (P-02, 20260896); null for a whole-order or manual invoice. */
  delivery_id?: string | null
  customer_id: string
  doc_status: 'draft' | 'posted' | 'cancelled'
  payment_status: 'unpaid' | 'partial' | 'paid' | 'reversed'
  line_items: CrmInvoiceLine[]
  subtotal: number
  discount_amount: number
  tax_amount: number
  total: number
  amount_paid: number
  due_date: string | null
  payment_terms: string | null
  reference_po: string | null
  notes: string | null
  void_reason: string | null
  assigned_rep: string | null
  created_by: string
  created_at: string
  updated_at: string
  posted_at: string | null
  paid_at: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Module ────────────────────────────────────────────────────────────────────

export const crmInvoices = {
  async list(filters?: {
    customerId?: string
    docStatus?: string
    paymentStatus?: string
    assignedRep?: string
    soId?: string
  }): Promise<CrmInvoiceRow[]> {
    // Every matching invoice — a customer's open invoices for a payment must
    // all be offered, not the first 1 000. (BUG-066.)
    try {
      const rows = await fetchAllRows<CrmInvoiceRow>((from, to) => {
        let q = supabase.from('crm_invoices').select(ROW_LINES.crmInvoice.select)
        if (filters?.customerId) q = q.eq('customer_id', filters.customerId)
        if (filters?.docStatus) q = q.eq('doc_status', filters.docStatus)
        if (filters?.paymentStatus) q = q.eq('payment_status', filters.paymentStatus)
        if (filters?.assignedRep) q = q.eq('assigned_rep', filters.assignedRep)
        if (filters?.soId) q = q.eq('so_id', filters.soId)
        return q.order('created_at', { ascending: false }).order('id', { ascending: true }).range(from, to)
      })
      return rows.map((r) => withRowLines(r, ROW_LINES.crmInvoice))
    } catch (error) {
      if ((error as { code?: string })?.code === '42P01') return []
      throw error
    }
  },

  async get(id: string): Promise<CrmInvoiceRow | null> {
    const { data, error } = await supabase.from('crm_invoices').select(ROW_LINES.crmInvoice.select).eq('id', id).single()
    if (error) {
      if (error.code === 'PGRST116') return null
      throw error
    }
    return withRowLines(data as unknown as CrmInvoiceRow, ROW_LINES.crmInvoice)
  },

  /**
   * A manual invoice, through `create_crm_invoice` (20260885): the lines land in
   * `crm_invoice_lines` (each a real catalogue product), totals are computed in
   * the database, and `line_items` is kept as a mirror of those rows. An invoice
   * is tied to a sales order only by `salesOrders.convertToInvoice`
   * (`convert_so_to_invoice`), so there is no `so_id` here. The number is
   * assigned when it is posted.
   */
  async create(input: {
    customer_id: string
    line_items?: CrmInvoiceLine[]
    due_date?: string | null
    payment_terms?: string | null
    reference_po?: string | null
    notes?: string | null
    assigned_rep?: string | null
    created_by: string
  }): Promise<CrmInvoiceRow> {
    const { data, error } = await supabase.rpc('create_crm_invoice', {
      p_customer_id: input.customer_id,
      p_lines: input.line_items ?? [],
      p_due_date: input.due_date ?? null,
      p_payment_terms: input.payment_terms ?? null,
      p_reference_po: input.reference_po ?? null,
      p_notes: input.notes ?? null,
      p_assigned_rep: input.assigned_rep ?? null,
      p_actor_email: input.created_by,
    })
    if (error) throw error
    return data as CrmInvoiceRow
  },

  /**
   * Every edit goes through `update_crm_invoice` — a DRAFT only. With
   * `line_items` it replaces the line set (not on an invoice made from an order:
   * those bill what was ordered and reserved); it sets only the header fields
   * that were passed. `actorEmail` is display-only.
   */
  async update(
    id: string,
    fields: Partial<
      Pick<
        CrmInvoiceRow,
        | 'line_items'
        | 'due_date'
        | 'payment_terms'
        | 'reference_po'
        | 'notes'
        | 'assigned_rep'
      >
    >,
    actorEmail?: string
  ): Promise<CrmInvoiceRow> {
    const { line_items, ...header } = fields
    const { data, error } = await supabase.rpc('update_crm_invoice', {
      p_id: id,
      p_lines: line_items ?? null,
      p_fields: Object.fromEntries(Object.entries(header).filter(([, v]) => v !== undefined)),
      p_actor_email: actorEmail ?? null,
    })
    if (error) throw error
    return data as CrmInvoiceRow
  },

  /** The relational lines directly (20260885) — crm_invoice_lines, not the line_items mirror. */
  async lines(invoiceId: string): Promise<CrmInvoiceLineRow[]> {
    return fetchAllRows<CrmInvoiceLineRow>((from, to) =>
      supabase
        .from('crm_invoice_lines')
        .select('*')
        .eq('crm_invoice_id', invoiceId)
        .order('line_no', { ascending: true })
        .range(from, to)
    )
  },

  /**
   * post: delegates to the updated post_invoice RPC which assigns the gapless
   * INV code, sets status='posted', and delivers reserved inventory all in one
   * Postgres transaction. Closing H4b — no more split await between code
   * assignment and stock delivery. Role check (manager+) is server-side.
   */
  async post(invoiceId: string, actorEmail: string): Promise<string> {
    const { data, error } = await supabase.rpc('post_invoice', {
      p_invoice_id: invoiceId,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    return data as string
  },

  // recordPayment() used to live here: a client-side read-modify-write of
  // amount_paid with no role check and no caller. Payments are recorded through
  // payments.record() and the application RPCs, which lock the invoice row.
  // Removed rather than left for a future caller to find. (BUG-062)

  /**
   * void_: delegates to void_invoice RPC which blocks if any payments or
   * credit notes have been applied (M4) and restores serialized inventory for
   * a clean posted-but-unpaid invoice. Role check (manager+) is server-side.
   */
  async void_(id: string, reason: string, actorEmail: string): Promise<CrmInvoiceRow> {
    const { error } = await supabase.rpc('void_invoice', {
      p_invoice_id: id,
      p_reason: reason,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    const inv = await crmInvoices.get(id)
    if (!inv) throw new Error('Invoice not found after void')
    return inv
  },

  /**
   * cancelDraft: kills a never-posted invoice. void_() cannot do this —
   * void_invoice raises "Only posted invoices can be voided (current: draft)"
   * because its job is to *undo* posting: it restores the serialized units the
   * post delivered. A draft never delivered any, so there is nothing to
   * restore and the RPC's guard is correct; drafts just need their own path.
   *
   * Reaches the same end state (cancelled + void_reason) without touching
   * stock. payment_status stays 'unpaid' rather than 'reversed' — nothing was
   * ever paid on a draft, so there is nothing to reverse.
   *
   * Used when a manager rejects an invoice in the Activities approval pool
   * (funnel row 22); before this, the reject threw P0001 and the invoice sat
   * in draft forever.
   */
  async cancelDraft(id: string, reason: string, actorEmail: string): Promise<CrmInvoiceRow> {
    const { data, error } = await supabase
      .from('crm_invoices')
      .update({ doc_status: 'cancelled', void_reason: reason })
      .eq('id', id)
      // Guard: refuse to touch anything that has already been posted — that
      // path must go through void_invoice so inventory is restored.
      .eq('doc_status', 'draft')
      .select()
    if (error) throw error

    void actorEmail // audit trail hook, mirrors void_/post
    return assertUpdated(data as CrmInvoiceRow[] | null, 'Invoice')
  },

  /** listBySalesDocument: fetch all invoices for the unified All-tab view. */

}
