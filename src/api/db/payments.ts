import { supabase } from '../client.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface PaymentRow {
  id: string
  payment_code: string | null
  customer_id: string
  amount: number
  unapplied_amount: number
  method: 'cash' | 'bank_transfer' | 'check' | 'card' | 'other'
  reference_number: string | null
  payment_date: string
  notes: string | null
  status: 'active' | 'voided'
  created_by: string
  created_at: string
  updated_at: string
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
}

export interface PaymentApplicationRow {
  id: string
  payment_id: string
  invoice_id: string
  amount_applied: number
  applied_date: string
  applied_by: string
  is_reversal: boolean
  reverses_application_id: string | null
  reversal_reason: string | null
}

// ── Module ────────────────────────────────────────────────────────────────────

export const payments = {
  async list(filters?: { customerId?: string; status?: string }): Promise<PaymentRow[]> {
    let q = supabase.from('payments').select('*').order('payment_date', { ascending: false })
    if (filters?.customerId) q = q.eq('customer_id', filters.customerId)
    if (filters?.status) q = q.eq('status', filters.status)
    const { data, error } = await q
    if (error) {
      if (error.code === '42P01') return []
      throw error
    }
    return (data ?? []) as PaymentRow[]
  },

  async get(id: string): Promise<PaymentRow | null> {
    const { data, error } = await supabase.from('payments').select('*').eq('id', id).single()
    if (error) {
      if (error.code === 'PGRST116') return null
      throw error
    }
    return data as PaymentRow
  },

  /**
   * record: delegates to the extended record_payment RPC which creates the
   * payment row and applies all allocations atomically in one Postgres
   * transaction. Closes H4d — no more loop of separate awaits between the
   * payment insert and each invoice balance update.
   * Any amount not covered by allocations stays as unapplied_amount (usable
   * later via applyToInvoice for customer prepayments/overpayments).
   */
  async record(input: {
    customer_id: string
    amount: number
    method: PaymentRow['method']
    reference_number?: string | null
    payment_date?: string | null
    notes?: string | null
    created_by: string
    allocations?: { invoice_id: string; amount: number }[]
  }): Promise<PaymentRow> {
    const allocations = (input.allocations ?? []).filter((a) => a.amount > 0)
    const { data: paymentId, error } = await supabase.rpc('record_payment', {
      p_customer_id: input.customer_id,
      p_amount: input.amount,
      p_method: input.method,
      p_reference_number: input.reference_number ?? null,
      p_payment_date: input.payment_date ?? null,
      p_notes: input.notes ?? null,
      p_actor_email: input.created_by,
      p_allocations: JSON.stringify(allocations),
    })
    if (error) throw error
    const payment = await payments.get(paymentId as string)
    if (!payment) throw new Error('Payment not found after creation')
    return payment
  },

  /**
   * applyToInvoice: applies some or all of this payment's unapplied balance
   * to an invoice. Delegates to the apply_payment_to_invoice RPC so the
   * application insert and the invoice-balance update happen in ONE Postgres
   * transaction (closes HIGH-2 — the previous read-then-write was non-atomic
   * and raced under concurrent applies). The RPC also enforces the manager+
   * guard, unapplied-balance check, and customer-match server-side.
   */
  async applyToInvoice(input: {
    paymentId: string
    invoiceId: string
    amount: number
    actorEmail: string
  }): Promise<PaymentApplicationRow> {
    const { data: appId, error } = await supabase.rpc('apply_payment_to_invoice', {
      p_payment_id: input.paymentId,
      p_invoice_id: input.invoiceId,
      p_amount: input.amount,
      p_actor_email: input.actorEmail,
    })
    if (error) throw error
    const { data, error: readErr } = await supabase
      .from('payment_applications')
      .select('*')
      .eq('id', appId as string)
      .single()
    if (readErr) throw readErr
    return data as PaymentApplicationRow
  },

  /**
   * void_: delegates to the void_payment RPC (closes CRIT-5). Reverses every
   * still-active application of this payment — inserting a negative
   * payment_applications row per line, restoring each invoice's amount_paid —
   * then marks the payment voided. Never mutates or deletes existing
   * application rows, matching the append-only ledger discipline already
   * used for stock_moves. A payment with nothing applied simply voids with
   * zero reversal rows.
   */
  async void_(id: string, reason: string, actorEmail: string): Promise<PaymentRow> {
    const { error } = await supabase.rpc('void_payment', {
      p_payment_id: id,
      p_reason: reason,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    const payment = await payments.get(id)
    if (!payment) throw new Error('Payment not found after void')
    return payment
  },

  /**
   * reverseApplication: reverses ONE application line without voiding the
   * whole payment — the fix for the CRIT-2 scenario where a payment was
   * applied to the wrong invoice. Restores the payment's unapplied_amount so
   * it can be re-applied correctly.
   */
  async reverseApplication(
    applicationId: string,
    reason: string,
    actorEmail: string
  ): Promise<string> {
    const { data, error } = await supabase.rpc('reverse_payment_application', {
      p_application_id: applicationId,
      p_reason: reason,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    return data as string
  },

  async getApplications(paymentId: string): Promise<PaymentApplicationRow[]> {
    const { data, error } = await supabase
      .from('payment_applications')
      .select('*')
      .eq('payment_id', paymentId)
      .order('applied_date', { ascending: false })
    if (error) {
      if (error.code === '42P01') return []
      throw error
    }
    return (data ?? []) as PaymentApplicationRow[]
  },
}
