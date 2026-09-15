import { supabase } from '../client.js'
import { fetchPage, fetchAllRows } from './_paging.js'
import type { PagedResult } from './types.js'
import { orIlike } from '../../lib/searchPattern.js'

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

/** A payment as the Accounting page lists it (v_payments_list, 20260861). */
export interface PaymentListRow extends PaymentRow {
  customer_name: string | null
}

/** Search text for a payments list: code, counterpart name or reference. */
export interface PaymentListFilters {
  search?: string
}

// ── Module ────────────────────────────────────────────────────────────────────

export const payments = {
  /**
   * One page of payments, newest first, searched in the database. The page
   * used to load every payment and search in the browser — past the Data
   * API's 1 000-row cap, part of the ledger. (BUG-066.)
   */
  async listPage(filters: PaymentListFilters, page: number, pageSize: number): Promise<PagedResult<PaymentListRow>> {
    const search = filters.search?.trim()
    return fetchPage<PaymentListRow>((from, to) => {
      let q = supabase.from('v_payments_list').select('*', { count: 'exact' })
      if (search) q = q.or(orIlike(['payment_code', 'customer_name', 'reference_number'], search))
      return q
        .order('payment_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
    }, page, pageSize)
  },

  /** Every payment matching the filters — all of them, not the first 1 000. */
  async list(filters?: { customerId?: string; status?: string }): Promise<PaymentRow[]> {
    try {
      return await fetchAllRows<PaymentRow>((from, to) => {
        let q = supabase.from('payments').select('*')
        if (filters?.customerId) q = q.eq('customer_id', filters.customerId)
        if (filters?.status) q = q.eq('status', filters.status)
        return q.order('payment_date', { ascending: false }).order('id', { ascending: true }).range(from, to)
      })
    } catch (error) {
      if ((error as { code?: string })?.code === '42P01') return []
      throw error
    }
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
      // Pass the array itself, NOT JSON.stringify(...). supabase-js serialises
      // the whole RPC body as JSON, so a string here arrives as a jsonb *scalar*
      // (`"[]"`) rather than an array, and record_payment's
      // `jsonb_array_elements(p_allocations)` then fails with
      // "cannot extract elements from a scalar" — which killed every payment
      // recorded from an invoice (WAREHOUSE_R1_TEST_CHECKLIST.md funnel row 43).
      p_allocations: allocations,
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
    try {
      return await fetchAllRows<PaymentApplicationRow>((from, to) =>
        supabase
          .from('payment_applications')
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
