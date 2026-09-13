import { supabase } from '../client.js'
import { assertAffected } from './_assertUpdated.js'
import { computeDocumentTotals } from './_documentTotals.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface CreditNoteLine {
  product_id?: string | null
  product_name: string
  qty: number
  unit_price: number
  restock: boolean
  warehouse_id?: string | null
  // Carried over from the invoice line being credited. Without these the
  // credit note silently reversed only the pre-discount, pre-tax amount
  // (BUG-013).
  discount_pct?: number | null
  tax_pct?: number | null
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
  discount_amount: number
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
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
}

export interface CreditNoteApplicationRow {
  id: string
  credit_note_id: string
  invoice_id: string
  amount_applied: number
  applied_date: string
  applied_by: string
  is_reversal: boolean
  reverses_application_id: string | null
  reversal_reason: string | null
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
    // Was: subtotal = sum(qty * unit_price), tax_amount hard-coded to 0, and
    // total = subtotal — so any discount or tax on the credited invoice line
    // was thrown away and the customer was under- or over-credited (BUG-013).
    const totals = computeDocumentTotals(lines)

    const { data, error } = await supabase
      .from('credit_notes')
      .insert({
        type: input.type,
        customer_id: input.customer_id,
        reason: input.reason,
        created_by: input.created_by,
        status: 'draft',
        line_items: lines,
        subtotal: totals.subtotal,
        discount_amount: totals.discount_amount,
        tax_amount: totals.tax_amount,
        total: totals.total,
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
      Object.assign(updates, computeDocumentTotals(fields.line_items))
    }

    const { data, error } = await supabase
      .from('credit_notes')
      .update(updates)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    assertAffected(data, 'Credit note')
    return data as CreditNoteRow
  },

  /**
   * issue: delegates to the extended issue_credit_note RPC which assigns the
   * gapless CN code, sets status='issued', and (if source_invoice_id is set)
   * inserts the credit_note_applications row and updates the invoice's
   * amount_paid/payment_status — all in one Postgres transaction. Closes H4c.
   *
   * Inventory restock (rma_return type) remains a separate two-step flow:
   *   1. UI resolves inventory_units.id values for the returned items.
   *   2. Call restoreUnits() with those IDs.
   */
  /**
   * @param closeTicket close the credit note's own ticket in the same
   *   transaction. The ticket id is taken from the credit note server-side, not
   *   passed in, so this cannot close an unrelated ticket (BUG-048).
   */
  async issue(cnId: string, actorEmail: string, closeTicket = false): Promise<string> {
    const { data, error } = await supabase.rpc('issue_credit_note', {
      p_cn_id: cnId,
      p_actor_email: actorEmail,
      p_close_ticket: closeTicket,
    })
    if (error) throw error
    return data as string
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

    // This write used to ignore its result entirely, so if it failed the units
    // were back in stock while the credit note still read as not restocked —
    // and nothing said so. By this point the units are already restored, so the
    // error cannot undo that; what it does is stop a silent mismatch from
    // passing as success. (BUG-074.)
    const { data, error: markError } = await supabase
      .from('credit_notes')
      .update({ restock_status: 'restocked' })
      .eq('id', cnId)
      .select('id')
    if (markError) throw markError
    assertAffected(data, 'Credit note')
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
    // Delegates to apply_credit_note_to_invoice RPC: the application insert and
    // the invoice-balance update run in ONE transaction (HIGH-2). The previous
    // client path inserted the application row but never reduced the invoice's
    // amount_paid, so applying a CN left the customer still owing the full
    // amount. The RPC also enforces manager+ guard, remaining-balance check,
    // and customer-match server-side.
    const { data: appId, error } = await supabase.rpc('apply_credit_note_to_invoice', {
      p_cn_id: input.creditNoteId,
      p_invoice_id: input.invoiceId,
      p_amount: input.amount,
      p_actor_email: input.actorEmail,
    })
    if (error) throw error
    const { data, error: readErr } = await supabase
      .from('credit_note_applications')
      .select('*')
      .eq('id', appId as string)
      .single()
    if (readErr) throw readErr
    return data as CreditNoteApplicationRow
  },

  /**
   * void_: delegates to the void_credit_note RPC (closes CRIT-5). Reverses
   * every still-active application of this credit note — inserting a
   * negative credit_note_applications row per line, restoring each invoice's
   * amount_paid — then marks the credit note voided. A draft or unapplied
   * issued CN simply voids with zero reversal rows, same as before.
   */
  async void_(id: string, reason: string, actorEmail: string): Promise<CreditNoteRow> {
    const { error } = await supabase.rpc('void_credit_note', {
      p_cn_id: id,
      p_reason: reason,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    const cn = await creditNotes.get(id)
    if (!cn) throw new Error('Credit note not found after void')
    return cn
  },

  /**
   * reverseApplication: reverses ONE application line without voiding the
   * whole credit note — mirrors payments.reverseApplication().
   */
  async reverseApplication(
    applicationId: string,
    reason: string,
    actorEmail: string
  ): Promise<string> {
    const { data, error } = await supabase.rpc('reverse_credit_note_application', {
      p_application_id: applicationId,
      p_reason: reason,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    return data as string
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
