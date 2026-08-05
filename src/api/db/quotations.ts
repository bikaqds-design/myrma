import { supabase } from '../client.js'

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

function computeTotals(lines: QuotationLine[]): {
  subtotal: number
  discount_amount: number
  tax_amount: number
  total: number
} {
  let subtotal = 0
  let discount_amount = 0
  let tax_amount = 0

  for (const line of lines) {
    const lineBase = line.qty * line.unit_price
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

// ── Module ────────────────────────────────────────────────────────────────────

export const quotations = {
  async list(filters?: {
    dealId?: string
    customerId?: string
    status?: string
    assignedRep?: string
  }): Promise<QuotationRow[]> {
    let q = supabase.from('quotations').select('*').order('created_at', { ascending: false })
    if (filters?.dealId) q = q.eq('deal_id', filters.dealId)
    if (filters?.customerId) q = q.eq('customer_id', filters.customerId)
    if (filters?.status) q = q.eq('status', filters.status)
    if (filters?.assignedRep) q = q.eq('assigned_rep', filters.assignedRep)
    const { data, error } = await q
    if (error) {
      if (error.code === '42P01') return []
      throw error
    }
    return (data ?? []) as QuotationRow[]
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
   * @deprecated A deal can hold many quotations — this returns only the most
   * recent one and will silently hide the rest. Use list({ dealId }) instead.
   */
  async getByDeal(dealId: string): Promise<QuotationRow | null> {
    const { data, error } = await supabase
      .from('quotations')
      .select('*')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data as QuotationRow | null
  },

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
    // Generate QT- code server-side via the generate_doc_code RPC
    const { data: codeData, error: codeErr } = await supabase.rpc('generate_doc_code', {
      p_prefix: 'QT',
    })
    if (codeErr) throw codeErr

    const lines = input.line_items ?? []
    const totals = computeTotals(lines)

    const { data, error } = await supabase
      .from('quotations')
      .insert({
        qt_code: codeData as string,
        deal_id: input.deal_id ?? null,
        customer_id: input.customer_id,
        status: 'draft',
        line_items: lines,
        ...totals,
        validity_until: input.validity_until ?? null,
        payment_terms: input.payment_terms ?? null,
        reference_po: input.reference_po ?? null,
        notes: input.notes ?? null,
        assigned_rep: input.assigned_rep ?? null,
        created_by: input.created_by,
      })
      .select()
      .single()
    if (error) throw error
    return data as QuotationRow
  },

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
    >
  ): Promise<QuotationRow> {
    const updates: Record<string, unknown> = { ...fields }

    // Recompute totals whenever line_items change
    if (fields.line_items) {
      Object.assign(updates, computeTotals(fields.line_items))
    }

    const { data, error } = await supabase
      .from('quotations')
      .update(updates)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data as QuotationRow
  },

  async markSent(id: string): Promise<QuotationRow> {
    const { data, error } = await supabase
      .from('quotations')
      .update({ status: 'sent' })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
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
   */
  async convertToSalesOrder(quotationId: string, actorEmail: string): Promise<string> {
    const { data, error } = await supabase.rpc('convert_quotation_to_so', {
      p_quotation_id: quotationId,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    return data as string
  },
}
