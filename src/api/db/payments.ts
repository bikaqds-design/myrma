import { supabase } from '../client.js'
import { crmInvoices } from './crmInvoices'

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
}

export interface PaymentApplicationRow {
  id: string
  payment_id: string
  invoice_id: string
  amount_applied: number
  applied_date: string
  applied_by: string
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
   * record: creates a payment (code assigned atomically via the record_payment
   * RPC, mirroring how issue_credit_note assigns cn_code) and immediately
   * applies it across the given allocations. Each allocation inserts a
   * payment_applications row (the sync_payment_balance trigger keeps
   * unapplied_amount in sync) and calls crmInvoices.recordPayment() so the
   * invoice's amount_paid/payment_status reflect it — same pattern
   * creditNotes.issue() already uses for credit-note applications.
   * Any amount not covered by allocations stays as unapplied_amount, usable
   * later via applyToInvoice() (e.g. a customer overpayment/prepayment).
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
    const { data: paymentId, error: rpcErr } = await supabase.rpc('record_payment', {
      p_customer_id: input.customer_id,
      p_amount: input.amount,
      p_method: input.method,
      p_reference_number: input.reference_number ?? null,
      p_payment_date: input.payment_date ?? null,
      p_notes: input.notes ?? null,
      p_actor_email: input.created_by,
    })
    if (rpcErr) throw rpcErr

    for (const alloc of input.allocations ?? []) {
      if (alloc.amount <= 0) continue
      await payments.applyToInvoice({
        paymentId: paymentId as string,
        invoiceId: alloc.invoice_id,
        amount: alloc.amount,
        actorEmail: input.created_by,
      })
    }

    const payment = await payments.get(paymentId as string)
    if (!payment) throw new Error('Payment not found after creation')
    return payment
  },

  /**
   * applyToInvoice: applies some or all of this payment's unapplied balance
   * to an invoice. Mirrors creditNotes.applyToInvoice() exactly.
   */
  async applyToInvoice(input: {
    paymentId: string
    invoiceId: string
    amount: number
    actorEmail: string
  }): Promise<PaymentApplicationRow> {
    const payment = await payments.get(input.paymentId)
    if (!payment) throw new Error('Payment not found')
    if (payment.status !== 'active') {
      throw new Error(`Payment must be active to apply (current: ${payment.status})`)
    }
    if (input.amount > payment.unapplied_amount) {
      throw new Error(
        `Amount ${input.amount} exceeds unapplied balance ${payment.unapplied_amount}`
      )
    }

    const { data, error } = await supabase
      .from('payment_applications')
      .insert({
        payment_id: input.paymentId,
        invoice_id: input.invoiceId,
        amount_applied: input.amount,
        applied_by: input.actorEmail,
      })
      .select()
      .single()
    if (error) throw error

    await crmInvoices.recordPayment(input.invoiceId, input.amount, input.actorEmail)

    return data as PaymentApplicationRow
  },

  /**
   * void_: cancels an active payment. Cannot void one that has already been
   * applied to invoices — same guard as creditNotes.void_(); a real reversal
   * would need to roll back amount_paid on every linked invoice, which is
   * GL-territory and out of scope for this module.
   */
  async void_(id: string, actorEmail: string): Promise<PaymentRow> {
    const payment = await payments.get(id)
    if (!payment) throw new Error('Payment not found')
    if (payment.status === 'voided') {
      throw new Error('Payment is already voided')
    }
    if (payment.amount !== payment.unapplied_amount) {
      throw new Error('Cannot void a payment that has already been applied to invoices')
    }

    const { data, error } = await supabase
      .from('payments')
      .update({ status: 'voided' })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error

    void actorEmail
    return data as PaymentRow
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
