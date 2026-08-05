import { supabase } from '../client.js'

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

function computeTotals(lines: SalesOrderLine[]): {
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

export const salesOrders = {
  async list(filters?: {
    customerId?: string
    status?: string
    assignedRep?: string
    quotationId?: string
    /** Resolve SOs for several quotations at once — a deal can hold many. */
    quotationIds?: string[]
  }): Promise<SalesOrderRow[]> {
    let q = supabase.from('sales_orders').select('*').order('created_at', { ascending: false })
    if (filters?.customerId) q = q.eq('customer_id', filters.customerId)
    if (filters?.status) q = q.eq('status', filters.status)
    if (filters?.assignedRep) q = q.eq('assigned_rep', filters.assignedRep)
    if (filters?.quotationId) q = q.eq('quotation_id', filters.quotationId)
    if (filters?.quotationIds) q = q.in('quotation_id', filters.quotationIds)
    const { data, error } = await q
    if (error) {
      if (error.code === '42P01') return []
      throw error
    }
    return (data ?? []) as SalesOrderRow[]
  },

  async get(id: string): Promise<SalesOrderRow | null> {
    const { data, error } = await supabase.from('sales_orders').select('*').eq('id', id).single()
    if (error) {
      if (error.code === 'PGRST116') return null
      throw error
    }
    return data as SalesOrderRow
  },

  async create(input: {
    customer_id: string
    quotation_id?: string | null
    line_items?: SalesOrderLine[]
    delivery_date?: string | null
    payment_terms?: string | null
    reference_po?: string | null
    notes?: string | null
    assigned_rep?: string | null
    created_by: string
  }): Promise<SalesOrderRow> {
    const { data: codeData, error: codeErr } = await supabase.rpc('generate_doc_code', {
      p_prefix: 'SO',
    })
    if (codeErr) throw codeErr

    const lines = input.line_items ?? []
    const totals = computeTotals(lines)

    const { data, error } = await supabase
      .from('sales_orders')
      .insert({
        so_code: codeData as string,
        quotation_id: input.quotation_id ?? null,
        customer_id: input.customer_id,
        status: 'draft',
        line_items: lines,
        ...totals,
        delivery_date: input.delivery_date ?? null,
        payment_terms: input.payment_terms ?? null,
        reference_po: input.reference_po ?? null,
        notes: input.notes ?? null,
        assigned_rep: input.assigned_rep ?? null,
        created_by: input.created_by,
      })
      .select()
      .single()
    if (error) throw error
    return data as SalesOrderRow
  },

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
    >
  ): Promise<SalesOrderRow> {
    const updates: Record<string, unknown> = { ...fields }

    if (fields.line_items) {
      Object.assign(updates, computeTotals(fields.line_items))
    }

    const { data, error } = await supabase
      .from('sales_orders')
      .update(updates)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data as SalesOrderRow
  },

  async markSent(soId: string): Promise<SalesOrderRow> {
    const { data, error } = await supabase
      .from('sales_orders')
      .update({ status: 'sent' })
      .eq('id', soId)
      .select()
      .single()
    if (error) throw error
    return data as SalesOrderRow
  },

  /**
   * markAccepted: delegates to approve_sales_order RPC which reserves every
   * line's inventory by derived type (serialized → reserve_units; service →
   * no-op) and sets status='delivered' atomically in one transaction.
   * Role check (manager+) is enforced server-side. Closes H1, H4a, M1, M5.
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
   * invoice first, releases serialized unit reservations, then sets
   * status='cancelled'. Works from any not-yet-invoiced status. Closes H2.
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
