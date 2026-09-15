import { supabase } from '../client.js'
import { fetchPage, fetchAllRows } from './_paging.js'
import type { PagedResult } from './types.js'
import { orIlike } from '../../lib/searchPattern.js'
import type { PaymentListFilters } from './payments.js'

// ── Row types ─────────────────────────────────────────────────────────────────
// AP mirror of payments.ts (customer AR) — see 20260760_vendor_payments.sql.

export interface VendorPaymentRow {
  id: string
  payment_code: string | null
  vendor_id: string
  amount: number
  unapplied_amount: number
  // 20260793. A payment is made in the currency of the invoices it settles and
  // may only be applied to invoices in that currency — the database refuses a
  // mismatch, because `amount_paid + applied >= total` compares the two
  // directly and would mark a $1,000 invoice paid with E£1,000.
  currency: string
  exchange_rate: number
  amount_base: number | null
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

export interface VendorPaymentApplicationRow {
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

/** A vendor payment as the Accounting page lists it (v_vendor_payments_list, 20260861). */
export interface VendorPaymentListRow extends VendorPaymentRow {
  vendor_name: string | null
}

export const vendorPayments = {
  /** One page of vendor payments, newest first, searched in the database. (BUG-066.) */
  async listPage(filters: PaymentListFilters, page: number, pageSize: number): Promise<PagedResult<VendorPaymentListRow>> {
    const search = filters.search?.trim()
    return fetchPage<VendorPaymentListRow>((from, to) => {
      let q = supabase.from('v_vendor_payments_list').select('*', { count: 'exact' })
      if (search) q = q.or(orIlike(['payment_code', 'vendor_name', 'reference_number'], search))
      return q
        .order('payment_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
    }, page, pageSize)
  },

  /** Every vendor payment matching the filters — all of them, not the first 1 000. */
  async list(filters?: { vendorId?: string; status?: string }): Promise<VendorPaymentRow[]> {
    try {
      return await fetchAllRows<VendorPaymentRow>((from, to) => {
        let q = supabase.from('vendor_payments').select('*')
        if (filters?.vendorId) q = q.eq('vendor_id', filters.vendorId)
        if (filters?.status) q = q.eq('status', filters.status)
        return q.order('payment_date', { ascending: false }).order('id', { ascending: true }).range(from, to)
      })
    } catch (error) {
      if ((error as { code?: string })?.code === '42P01') return []
      throw error
    }
  },

  async get(id: string): Promise<VendorPaymentRow | null> {
    const { data, error } = await supabase.from('vendor_payments').select('*').eq('id', id).single()
    if (error) {
      if (error.code === 'PGRST116') return null
      throw error
    }
    return data as VendorPaymentRow
  },

  /**
   * record: delegates to record_vendor_payment, which creates the payment row
   * and applies all allocations atomically in one transaction (same shape as
   * payments.record for the customer side). Any amount not covered by
   * allocations stays as unapplied_amount.
   */
  async record(input: {
    vendor_id: string
    amount: number
    method: VendorPaymentRow['method']
    reference_number?: string | null
    payment_date?: string | null
    notes?: string | null
    created_by: string
    allocations?: { invoice_id: string; amount: number }[]
    currency?: string | null
    exchangeRate?: number | null
  }): Promise<VendorPaymentRow> {
    const allocations = (input.allocations ?? []).filter((a) => a.amount > 0)
    const { data: paymentId, error } = await supabase.rpc('record_vendor_payment', {
      p_vendor_id: input.vendor_id,
      p_amount: input.amount,
      p_method: input.method,
      p_reference_number: input.reference_number ?? null,
      p_payment_date: input.payment_date ?? null,
      p_notes: input.notes ?? null,
      p_actor_email: input.created_by,
      // Array, not JSON.stringify(...) — see the identical fix in payments.ts.
      // A string arrives as a jsonb scalar and record_vendor_payment's
      // jsonb_array_elements(p_allocations) fails with
      // "cannot extract elements from a scalar".
      p_allocations: allocations,
      // Omitted means a local payment: the RPC defaults to the base currency at
      // a rate of 1, so callers that predate the currency engine are unchanged.
      p_currency: input.currency ?? null,
      p_exchange_rate: input.exchangeRate ?? null,
    })
    if (error) throw error
    const payment = await vendorPayments.get(paymentId as string)
    if (!payment) throw new Error('Vendor payment not found after creation')
    return payment
  },

  /**
   * applyToInvoice: applies some or all of this payment's unapplied balance
   * to a vendor invoice, atomically (apply_vendor_payment_to_invoice RPC).
   */
  async applyToInvoice(input: {
    paymentId: string
    invoiceId: string
    amount: number
    actorEmail: string
  }): Promise<VendorPaymentApplicationRow> {
    const { data: appId, error } = await supabase.rpc('apply_vendor_payment_to_invoice', {
      p_payment_id: input.paymentId,
      p_invoice_id: input.invoiceId,
      p_amount: input.amount,
      p_actor_email: input.actorEmail,
    })
    if (error) throw error
    const { data, error: readErr } = await supabase
      .from('vendor_payment_applications')
      .select('*')
      .eq('id', appId as string)
      .single()
    if (readErr) throw readErr
    return data as VendorPaymentApplicationRow
  },

  /**
   * void_: reverses every still-active application of this payment (negative
   * ledger rows, restoring each invoice's amount_paid), then marks it voided.
   */
  async void_(id: string, reason: string, actorEmail: string): Promise<VendorPaymentRow> {
    const { error } = await supabase.rpc('void_vendor_payment', {
      p_payment_id: id,
      p_reason: reason,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    const payment = await vendorPayments.get(id)
    if (!payment) throw new Error('Vendor payment not found after void')
    return payment
  },

  /**
   * reverseApplication: reverses ONE application line without voiding the
   * whole payment — e.g. a payment misapplied to the wrong vendor invoice.
   */
  async reverseApplication(applicationId: string, reason: string, actorEmail: string): Promise<string> {
    const { data, error } = await supabase.rpc('reverse_vendor_payment_application', {
      p_application_id: applicationId,
      p_reason: reason,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    return data as string
  },

  async getApplications(paymentId: string): Promise<VendorPaymentApplicationRow[]> {
    try {
      return await fetchAllRows<VendorPaymentApplicationRow>((from, to) =>
        supabase
          .from('vendor_payment_applications')
          .select('*')
          .eq('payment_id', paymentId)
          .order('applied_date', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to)
      )
    } catch (error) {
      if ((error as { code?: string })?.code === '42P01') return []
      throw error
    }
  },
}
