import { supabase } from '../client.js'

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

export interface CrmInvoiceRow {
  id: string
  inv_code: string | null
  so_id: string | null
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

function computeTotals(lines: CrmInvoiceLine[]): {
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

export const crmInvoices = {
  async list(filters?: {
    customerId?: string
    docStatus?: string
    paymentStatus?: string
    assignedRep?: string
    soId?: string
  }): Promise<CrmInvoiceRow[]> {
    let q = supabase.from('crm_invoices').select('*').order('created_at', { ascending: false })
    if (filters?.customerId) q = q.eq('customer_id', filters.customerId)
    if (filters?.docStatus) q = q.eq('doc_status', filters.docStatus)
    if (filters?.paymentStatus) q = q.eq('payment_status', filters.paymentStatus)
    if (filters?.assignedRep) q = q.eq('assigned_rep', filters.assignedRep)
    if (filters?.soId) q = q.eq('so_id', filters.soId)
    const { data, error } = await q
    if (error) {
      if (error.code === '42P01') return []
      throw error
    }
    return (data ?? []) as CrmInvoiceRow[]
  },

  async get(id: string): Promise<CrmInvoiceRow | null> {
    const { data, error } = await supabase.from('crm_invoices').select('*').eq('id', id).single()
    if (error) {
      if (error.code === 'PGRST116') return null
      throw error
    }
    return data as CrmInvoiceRow
  },

  async create(input: {
    customer_id: string
    so_id?: string | null
    line_items?: CrmInvoiceLine[]
    due_date?: string | null
    payment_terms?: string | null
    reference_po?: string | null
    notes?: string | null
    assigned_rep?: string | null
    created_by: string
  }): Promise<CrmInvoiceRow> {
    const lines = input.line_items ?? []
    const totals = computeTotals(lines)

    const { data, error } = await supabase
      .from('crm_invoices')
      .insert({
        so_id: input.so_id ?? null,
        customer_id: input.customer_id,
        doc_status: 'draft',
        payment_status: 'unpaid',
        line_items: lines,
        ...totals,
        due_date: input.due_date ?? null,
        payment_terms: input.payment_terms ?? null,
        reference_po: input.reference_po ?? null,
        notes: input.notes ?? null,
        assigned_rep: input.assigned_rep ?? null,
        created_by: input.created_by,
      })
      .select()
      .single()
    if (error) throw error
    return data as CrmInvoiceRow
  },

  /** update: only allowed while doc_status = 'draft'. Lines lock on post(). */
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
    >
  ): Promise<CrmInvoiceRow> {
    const updates: Record<string, unknown> = { ...fields }

    if (fields.line_items) {
      Object.assign(updates, computeTotals(fields.line_items))
    }

    const { data, error } = await supabase
      .from('crm_invoices')
      .update(updates)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data as CrmInvoiceRow
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

  /**
   * recordPayment: records a partial or full payment.
   * Updates amount_paid and derives payment_status automatically.
   */
  async recordPayment(
    id: string,
    amountPaid: number,
    actorEmail: string
  ): Promise<CrmInvoiceRow> {
    const inv = await crmInvoices.get(id)
    if (!inv) throw new Error('Invoice not found')
    if (inv.doc_status !== 'posted') {
      throw new Error('Can only record payment against a posted invoice')
    }

    const newPaid = Math.min(inv.amount_paid + amountPaid, inv.total)
    let paymentStatus: CrmInvoiceRow['payment_status']
    if (newPaid >= inv.total) {
      paymentStatus = 'paid'
    } else if (newPaid > 0) {
      paymentStatus = 'partial'
    } else {
      paymentStatus = 'unpaid'
    }

    const updates: Record<string, unknown> = {
      amount_paid: newPaid,
      payment_status: paymentStatus,
    }
    if (paymentStatus === 'paid') {
      updates.paid_at = new Date().toISOString()
    }

    const { data, error } = await supabase
      .from('crm_invoices')
      .update(updates)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error

    void actorEmail // used for audit trail in the future
    return data as CrmInvoiceRow
  },

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
      .single()
    if (error) throw error

    void actorEmail // audit trail hook, mirrors void_/post
    return data as CrmInvoiceRow
  },

  /** listBySalesDocument: fetch all invoices for the unified All-tab view. */
  async listAll(filters?: {
    assignedRep?: string
    search?: string
  }): Promise<CrmInvoiceRow[]> {
    let q = supabase.from('crm_invoices').select('*').order('created_at', { ascending: false })
    if (filters?.assignedRep) q = q.eq('assigned_rep', filters.assignedRep)
    const { data, error } = await q
    if (error) {
      if (error.code === '42P01') return []
      throw error
    }
    return (data ?? []) as CrmInvoiceRow[]
  },
}
