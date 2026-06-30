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

  /** Returns IDs of any lines that have no product_id (free-form lines). */
  freeFormLines(qt: QuotationRow): QuotationLine[] {
    return qt.line_items.filter((l) => !l.product_id)
  },

  /**
   * convertToSalesOrder: creates a sales_orders row from this quotation.
   * Caller must ensure all free-form lines have been promoted to real products
   * first (check freeFormLines() and show the promotion modal before calling).
   * Returns the new sales order id.
   */
  async convertToSalesOrder(
    quotationId: string,
    actorEmail: string
  ): Promise<string> {
    const qt = await quotations.get(quotationId)
    if (!qt) throw new Error('Quotation not found')
    if (['cancelled', 'declined', 'converted'].includes(qt.status)) {
      throw new Error(`Cannot convert a ${qt.status} quotation to a sales order`)
    }

    // Validate all lines have a product_id
    const freeLines = quotations.freeFormLines(qt)
    if (freeLines.length > 0) {
      throw new Error(
        `${freeLines.length} line(s) have no product — promote them to real products first`
      )
    }

    // Generate SO code server-side
    const { data: codeData, error: codeErr } = await supabase.rpc('generate_doc_code', {
      p_prefix: 'SO',
    })
    if (codeErr) throw codeErr

    const { data, error } = await supabase
      .from('sales_orders')
      .insert({
        so_code: codeData as string,
        quotation_id: quotationId,
        customer_id: qt.customer_id,
        status: 'draft',
        line_items: qt.line_items,
        subtotal: qt.subtotal,
        discount_amount: qt.discount_amount,
        tax_amount: qt.tax_amount,
        total: qt.total,
        payment_terms: qt.payment_terms,
        reference_po: qt.reference_po,
        notes: qt.notes,
        assigned_rep: qt.assigned_rep ?? actorEmail,
        created_by: actorEmail,
      })
      .select('id')
      .single()
    if (error) throw error

    // Mark the quotation as converted so it cannot be re-converted.
    await supabase.from('quotations').update({ status: 'converted' }).eq('id', quotationId)

    return (data as { id: string }).id
  },
}
