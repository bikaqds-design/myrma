import { supabase } from '../client.js'
import { assertAffected } from './_assertUpdated.js'
import { fetchAllRows } from './_paging.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface QuotationLine {
  product_id?: string | null
  product_name: string
  description?: string | null
  qty: number
  unit_price: number
  discount_pct?: number | null
  tax_pct?: number | null
}

/**
 * A row of `quotation_lines` (20260883, W2/L-01) — the real, FK-enforced,
 * per-line source of truth. `quotations.line_items` (the QuotationLine shape
 * above) is a server-maintained mirror of these rows, kept for every existing
 * reader (the shared Sales Documents form, quotationPdf.js, DealDetail.jsx,
 * convert_quotation_to_so); this is the same data, with an id and FK.
 */
export interface QuotationLineRow {
  id: string
  quotation_id: string
  line_no: number
  product_id: string | null
  product_name: string
  description: string | null
  qty: number
  unit_price: number
  discount_pct: number
  tax_pct: number
}

export interface QuotationRow {
  id: string
  qt_code: string
  deal_id: string | null
  customer_id: string
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'cancelled' | 'converted'
  line_items: QuotationLine[]
  subtotal: number
  discount_amount: number
  tax_amount: number
  total: number
  validity_until: string | null
  payment_terms: string | null
  reference_po: string | null
  notes: string | null
  assigned_rep: string | null
  created_by: string
  created_at: string
  updated_at: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Module ────────────────────────────────────────────────────────────────────

export const quotations = {
  async list(filters?: {
    dealId?: string
    customerId?: string
    status?: string
    assignedRep?: string
  }): Promise<QuotationRow[]> {
    // Every matching quotation, newest first — not the first 1 000. (BUG-066.)
    try {
      return await fetchAllRows<QuotationRow>((from, to) => {
        let q = supabase.from('quotations').select('*')
        if (filters?.dealId) q = q.eq('deal_id', filters.dealId)
        if (filters?.customerId) q = q.eq('customer_id', filters.customerId)
        if (filters?.status) q = q.eq('status', filters.status)
        if (filters?.assignedRep) q = q.eq('assigned_rep', filters.assignedRep)
        return q.order('created_at', { ascending: false }).order('id', { ascending: true }).range(from, to)
      })
    } catch (error) {
      if ((error as { code?: string })?.code === '42P01') return []
      throw error
    }
  },

  async get(id: string): Promise<QuotationRow | null> {
    const { data, error } = await supabase.from('quotations').select('*').eq('id', id).single()
    if (error) {
      if (error.code === 'PGRST116') return null
      throw error
    }
    return data as QuotationRow
  },

  /**
   * Writes the header AND the lines atomically through `create_quotation`
   * (20260883): the lines land in `quotation_lines` (FK'd to products,
   * CHECK-constrained), totals are computed server-side from them, and
   * `line_items` is filled in as a mirror of those rows — so nothing that
   * reads `line_items` had to change for this to be true relational storage
   * underneath. The signature is unchanged; only the write path is new.
   */
  async create(input: {
    customer_id: string
    deal_id?: string | null
    line_items?: QuotationLine[]
    validity_until?: string | null
    payment_terms?: string | null
    reference_po?: string | null
    notes?: string | null
    assigned_rep?: string | null
    created_by: string
  }): Promise<QuotationRow> {
    const { data, error } = await supabase.rpc('create_quotation', {
      p_customer_id: input.customer_id,
      p_deal_id: input.deal_id ?? null,
      p_lines: input.line_items ?? [],
      p_validity_until: input.validity_until ?? null,
      p_payment_terms: input.payment_terms ?? null,
      p_reference_po: input.reference_po ?? null,
      p_notes: input.notes ?? null,
      p_assigned_rep: input.assigned_rep ?? null,
      p_actor_email: input.created_by,
    })
    if (error) throw error
    return data as QuotationRow
  },

  /**
   * With `line_items`: replaces the whole line set and the header fields that
   * were passed, in one atomic call through `update_quotation`, and only while
   * the quotation is `draft`/`sent` (the database now enforces what was
   * previously "enforced in app layer" only). Without `line_items` (no
   * current caller does this, but the signature allows it), falls back to a
   * plain field update — those columns carry no derived totals.
   * `actorEmail` is display-only: the database takes the editor from the login.
   */
  async update(
    id: string,
    fields: Partial<
      Pick<
        QuotationRow,
        | 'line_items'
        | 'validity_until'
        | 'payment_terms'
        | 'reference_po'
        | 'notes'
        | 'assigned_rep'
      >
    >,
    actorEmail?: string
  ): Promise<QuotationRow> {
    if (fields.line_items) {
      // Only the header fields the caller actually passed: the Deal screen
      // sends no reference_po / assigned_rep, and sending them as null would
      // blank them. A key present with a null value does blank its field.
      const { line_items, ...header } = fields
      const { data, error } = await supabase.rpc('update_quotation', {
        p_id: id,
        p_lines: line_items,
        p_fields: Object.fromEntries(Object.entries(header).filter(([, v]) => v !== undefined)),
        p_actor_email: actorEmail ?? null,
      })
      if (error) throw error
      return data as QuotationRow
    }

    const { data, error } = await supabase
      .from('quotations')
      .update(fields)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    assertAffected(data, 'Quotation')
    return data as QuotationRow
  },

  /** The relational lines directly (20260883) — quotation_lines, not the line_items mirror. */
  async lines(quotationId: string): Promise<QuotationLineRow[]> {
    return fetchAllRows<QuotationLineRow>((from, to) =>
      supabase
        .from('quotation_lines')
        .select('*')
        .eq('quotation_id', quotationId)
        .order('line_no', { ascending: true })
        .range(from, to)
    )
  },

  async markSent(id: string): Promise<QuotationRow> {
    const { data, error } = await supabase
      .from('quotations')
      .update({ status: 'sent' })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    assertAffected(data, 'Quotation')
    return data as QuotationRow
  },

  async markAccepted(id: string): Promise<QuotationRow> {
    const { data, error } = await supabase
      .from('quotations')
      .update({ status: 'accepted' })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    assertAffected(data, 'Quotation')
    return data as QuotationRow
  },

  async markDeclined(id: string): Promise<QuotationRow> {
    const { data, error } = await supabase
      .from('quotations')
      .update({ status: 'declined' })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    assertAffected(data, 'Quotation')
    return data as QuotationRow
  },

  async cancel(id: string): Promise<QuotationRow> {
    const { data, error } = await supabase
      .from('quotations')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    assertAffected(data, 'Quotation')
    return data as QuotationRow
  },

  async reopen(id: string): Promise<QuotationRow> {
    const { data, error } = await supabase
      .from('quotations')
      .update({ status: 'draft' })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    assertAffected(data, 'Quotation')
    return data as QuotationRow
  },

  /** Returns any lines that have no product_id (free-form lines). */
  freeFormLines(qt: QuotationRow): QuotationLine[] {
    return qt.line_items.filter((l) => !l.product_id)
  },

  /**
   * convertToSalesOrder: delegates to the convert_quotation_to_so RPC which
   * inserts the SO and flips qt.status='converted' atomically in one Postgres
   * transaction, with a FOR UPDATE lock that prevents duplicate SOs from
   * concurrent double-clicks (FR-005, FR-006, H4a).
   *
   * Only an ACCEPTED quotation converts (20260880). If its validity date has
   * passed, a manager can still convert it by passing `overrideReason` (at
   * least 10 characters), which is kept on the sales order.
   */
  async convertToSalesOrder(quotationId: string, actorEmail: string, overrideReason?: string): Promise<string> {
    const { data, error } = await supabase.rpc('convert_quotation_to_so', {
      p_quotation_id: quotationId,
      p_actor_email: actorEmail,
      p_override_reason: overrideReason?.trim() ? overrideReason.trim() : null,
    })
    if (error) throw error
    return data as string
  },
}
