import { supabase } from '../client.js'
import { crmInvoices } from './crmInvoices'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface CreditNoteLine {
  product_id?: string | null
  product_name: string
  qty: number
  unit_price: number
  restock: boolean
  warehouse_id?: string | null
}

export interface CreditNoteRow {
  id: string
  cn_code: string | null
  type: 'rma_return' | 'rebate' | 'discount' | 'correction'
  source_invoice_id: string | null
  source_invoice_number: string | null
  ticket_id: string | null
  customer_id: string
  status: 'draft' | 'issued' | 'applied' | 'voided'
  line_items: CreditNoteLine[]
  subtotal: number
  tax_amount: number
  total: number
  applied_amount: number
  remaining_balance: number
  reason: string
  affects_inventory: boolean
  restock_status: 'not_applicable' | 'pending' | 'restocked'
  assigned_rep: string | null
  created_by: string
  created_at: string
  updated_at: string
  issued_at: string | null
}

export interface CreditNoteApplicationRow {
  id: string
  credit_note_id: string
  invoice_id: string
  amount_applied: number
  applied_date: string
  applied_by: string
}

// ── Module ────────────────────────────────────────────────────────────────────

export const creditNotes = {
  async list(filters?: {
    customerId?: string
    status?: string
    type?: string
    sourceInvoiceId?: string
    assignedRep?: string
  }): Promise<CreditNoteRow[]> {
    let q = supabase.from('credit_notes').select('*').order('created_at', { ascending: false })
    if (filters?.customerId) q = q.eq('customer_id', filters.customerId)
    if (filters?.status) q = q.eq('status', filters.status)
    if (filters?.type) q = q.eq('type', filters.type)
    if (filters?.sourceInvoiceId) q = q.eq('source_invoice_id', filters.sourceInvoiceId)
    if (filters?.assignedRep) q = q.eq('assigned_rep', filters.assignedRep)
    const { data, error } = await q
    if (error) {
      if (error.code === '42P01') return []
      throw error
    }
    return (data ?? []) as CreditNoteRow[]
  },

  async get(id: string): Promise<CreditNoteRow | null> {
    const { data, error } = await supabase.from('credit_notes').select('*').eq('id', id).single()
    if (error) {
      if (error.code === 'PGRST116') return null
      throw error
    }
    return data as CreditNoteRow
  },

  async create(input: {
    type: CreditNoteRow['type']
    customer_id: string
    reason: string
    created_by: string
    line_items?: CreditNoteLine[]
    source_invoice_id?: string | null
    source_invoice_number?: string | null
    ticket_id?: string | null
    assigned_rep?: string | null
  }): Promise<CreditNoteRow> {
    const lines = input.line_items ?? []
    const subtotal = lines.reduce((sum, l) => sum + l.qty * l.unit_price, 0)
    const total = Math.round(subtotal * 100) / 100

    const { data, error } = await supabase
      .from('credit_notes')
      .insert({
        type: input.type,
        customer_id: input.customer_id,
        reason: input.reason,
        created_by: input.created_by,
        status: 'draft',
        line_items: lines,
        subtotal: total,
        tax_amount: 0,
        total,
        applied_amount: 0,
        remaining_balance: 0,
        restock_status: input.type === 'rma_return' ? 'pending' : 'not_applicable',
        source_invoice_id: input.source_invoice_id ?? null,
        source_invoice_number: input.source_invoice_number ?? null,
        ticket_id: input.ticket_id ?? null,
        assigned_rep: input.assigned_rep ?? null,
      })
      .select()
      .single()
    if (error) throw error
    return data as CreditNoteRow
  },

  async update(
    id: string,
    fields: Partial<
      Pick<CreditNoteRow, 'line_items' | 'reason' | 'assigned_rep' | 'source_invoice_number'>
    >
  ): Promise<CreditNoteRow> {
    const updates: Record<string, unknown> = { ...fields }

    if (fields.line_items) {
      const subtotal = fields.line_items.reduce((sum, l) => sum + l.qty * l.unit_price, 0)
      updates.subtotal = Math.round(subtotal * 100) / 100
      updates.total = updates.subtotal
    }

    const { data, error } = await supabase
      .from('credit_notes')
      .update(updates)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data as CreditNoteRow
  },

  /**
   * issue: draft → issued. Calls issue_credit_note RPC to assign the
   * gapless CN-YYYY-NNNNN code atomically. Returns the assigned cn_code.
   *
   * Inventory restock (rma_return type) is a separate two-step flow:
   *   1. The UI resolves actual inventory_units.id values for the returned items.
   *   2. Call restoreUnits() with those IDs.
   * This keeps the issue step fast and avoids coupling the code-assignment
   * RPC to potentially slow unit lookups.
   *
   * If the CN is linked to a source invoice (source_invoice_id), the
   * standard AR practice (no separate "payment" concept since there's no
   * full accounting module yet) is to apply the CN straight to that
   * invoice's outstanding balance via credit_note_applications, then
   * mirror the same amount onto the invoice's amount_paid/payment_status
   * through the existing recordPayment() path.
   */
  async issue(cnId: string, actorEmail: string): Promise<string> {
    const { data, error } = await supabase.rpc('issue_credit_note', {
      p_cn_id: cnId,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    const code = data as string

    const cn = await creditNotes.get(cnId)
    if (cn?.source_invoice_id) {
      const inv = await crmInvoices.get(cn.source_invoice_id)
      const remainingOnInvoice = inv ? Math.max((inv.total ?? 0) - (inv.amount_paid ?? 0), 0) : 0
      const applyAmount = Math.min(cn.remaining_balance, remainingOnInvoice)
      if (applyAmount > 0) {
        await creditNotes.applyToInvoice({
          creditNoteId: cnId,
          invoiceId: cn.source_invoice_id,
          amount: applyAmount,
          actorEmail,
        })
        await crmInvoices.recordPayment(cn.source_invoice_id, applyAmount, actorEmail)
      }
    }

    return code
  },

  /**
   * restoreUnits: brings specific delivered inventory_units back to 'available'.
   * Only valid on rma_return type credit notes in 'issued' status.
   * unitIds must be inventory_units.id UUIDs (not product IDs) — the UI
   * resolves these from stock_moves or the inventory module.
   */
  async restoreUnits(cnId: string, unitIds: string[], actorEmail: string): Promise<void> {
    if (unitIds.length === 0) return

    const { error } = await supabase.rpc('restore_units', {
      p_unit_ids: unitIds,
      p_doc_type: 'credit_note',
      p_doc_id: cnId,
      p_actor_email: actorEmail,
      p_to_status: 'available',
    })
    if (error) throw error

    await supabase
      .from('credit_notes')
      .update({ restock_status: 'restocked' })
      .eq('id', cnId)
  },

  /**
   * applyToInvoice: applies some or all of this credit note's balance to an invoice.
   * The sync_credit_note_balance trigger on credit_note_applications recalculates
   * remaining_balance and flips status to 'applied' when exhausted.
   */
  async applyToInvoice(input: {
    creditNoteId: string
    invoiceId: string
    amount: number
    actorEmail: string
  }): Promise<CreditNoteApplicationRow> {
    const cn = await creditNotes.get(input.creditNoteId)
    if (!cn) throw new Error('Credit note not found')
    if (cn.status !== 'issued') {
      throw new Error(`Credit note must be issued before applying (current: ${cn.status})`)
    }
    if (input.amount > cn.remaining_balance) {
      throw new Error(
        `Amount ${input.amount} exceeds remaining balance ${cn.remaining_balance}`
      )
    }

    const { data, error } = await supabase
      .from('credit_note_applications')
      .insert({
        credit_note_id: input.creditNoteId,
        invoice_id: input.invoiceId,
        amount_applied: input.amount,
        applied_by: input.actorEmail,
      })
      .select()
      .single()
    if (error) throw error
    return data as CreditNoteApplicationRow
  },

  /**
   * void_: cancels a draft or issued credit note. Cannot void an 'applied' CN.
   */
  async void_(id: string, actorEmail: string): Promise<CreditNoteRow> {
    const cn = await creditNotes.get(id)
    if (!cn) throw new Error('Credit note not found')
    if (cn.status === 'applied') {
      throw new Error('Cannot void a credit note that has already been applied to invoices')
    }
    if (cn.status === 'voided') {
      throw new Error('Credit note is already voided')
    }

    const { data, error } = await supabase
      .from('credit_notes')
      .update({ status: 'voided' })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error

    void actorEmail
    return data as CreditNoteRow
  },

  async getApplications(creditNoteId: string): Promise<CreditNoteApplicationRow[]> {
    const { data, error } = await supabase
      .from('credit_note_applications')
      .select('*')
      .eq('credit_note_id', creditNoteId)
      .order('applied_date', { ascending: false })
    if (error) {
      if (error.code === '42P01') return []
      throw error
    }
    return (data ?? []) as CreditNoteApplicationRow[]
  },
}
