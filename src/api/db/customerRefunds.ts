import { supabase } from '../client.js'
import { fetchAllRows, fetchPage } from './_paging.js'

// Customer refunds (P-05c, 20260904): money paid back from a credit note's
// remaining balance or a payment's unapplied amount. Every write is an RPC
// (the table is procedure-only); a manager records one, a DIFFERENT manager
// approves it (owner decision), and the database enforces both.

export interface CustomerRefundRow {
  id: string
  refund_code: string | null
  customer_id: string
  credit_note_id: string | null
  payment_id: string | null
  amount: number
  method: string
  reference_number: string | null
  refund_date: string
  notes: string | null
  status: 'pending_approval' | 'approved' | 'rejected'
  created_by: string
  created_at: string
  approved_by: string | null
  approved_at: string | null
  rejected_by: string | null
  reject_reason: string | null
  customer: { company_name: string | null; contact_person: string | null } | null
  credit_note: { cn_code: string | null } | null
  payment: { payment_code: string | null } | null
}

/** Something a customer can be paid back from, and how much it has left. */
export interface RefundSource {
  type: 'credit_note' | 'payment'
  id: string
  code: string | null
  balance: number
}

const REFUND_SELECT =
  'id, refund_code, customer_id, credit_note_id, payment_id, amount, method, reference_number, refund_date, notes, status, ' +
  'created_by, created_at, approved_by, approved_at, rejected_by, reject_reason, ' +
  'customer:customers(company_name, contact_person), credit_note:credit_notes(cn_code), payment:payments(payment_code)'

export const customerRefunds = {
  /** One page of refunds, newest first. */
  async listPage(page: number, pageSize: number) {
    return fetchPage<CustomerRefundRow>(
      (from, to) =>
        supabase
          .from('customer_refunds')
          .select(REFUND_SELECT, { count: 'exact' })
          .order('created_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
      page,
      pageSize
    )
  },

  /** What one customer can be refunded from: active payments with money unapplied, issued credit notes with a balance. */
  async sources(customerId: string): Promise<RefundSource[]> {
    const [payments, notes] = await Promise.all([
      fetchAllRows<{ id: string; payment_code: string | null; unapplied_amount: number }>((from, to) =>
        supabase
          .from('payments')
          .select('id, payment_code, unapplied_amount')
          .eq('customer_id', customerId)
          .eq('status', 'active')
          .gt('unapplied_amount', 0)
          .order('id', { ascending: true })
          .range(from, to)
      ),
      fetchAllRows<{ id: string; cn_code: string | null; remaining_balance: number }>((from, to) =>
        supabase
          .from('credit_notes')
          .select('id, cn_code, remaining_balance')
          .eq('customer_id', customerId)
          .in('status', ['issued', 'applied'])
          .gt('remaining_balance', 0)
          .order('id', { ascending: true })
          .range(from, to)
      ),
    ])
    return [
      ...notes.map((n) => ({ type: 'credit_note' as const, id: n.id, code: n.cn_code, balance: Number(n.remaining_balance) })),
      ...payments.map((p) => ({ type: 'payment' as const, id: p.id, code: p.payment_code, balance: Number(p.unapplied_amount) })),
    ]
  },

  /** Recorded as waiting for a second manager; nothing leaves the balance until it is approved. */
  async record(input: {
    sourceType: 'credit_note' | 'payment'
    sourceId: string
    amount: number
    method: string
    referenceNumber?: string | null
    refundDate?: string | null
    notes?: string | null
    actorEmail: string
  }): Promise<CustomerRefundRow> {
    const { data, error } = await supabase.rpc('record_customer_refund', {
      p_source_type: input.sourceType,
      p_source_id: input.sourceId,
      p_amount: input.amount,
      p_method: input.method,
      p_reference_number: input.referenceNumber ?? null,
      p_refund_date: input.refundDate || null,
      p_notes: input.notes ?? null,
      p_actor_email: input.actorEmail,
    })
    if (error) throw error
    return data as CustomerRefundRow
  },

  /** A manager who did not record it; numbers it RF- and takes it off the source's balance. */
  async approve(id: string, actorEmail: string): Promise<CustomerRefundRow> {
    const { data, error } = await supabase.rpc('approve_customer_refund', { p_refund_id: id, p_actor_email: actorEmail })
    if (error) throw error
    return data as CustomerRefundRow
  },

  /** A waiting refund only; an approved one is final (the money has left). */
  async reject(id: string, reason: string, actorEmail: string): Promise<CustomerRefundRow> {
    const { data, error } = await supabase.rpc('reject_customer_refund', {
      p_refund_id: id,
      p_reason: reason,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    return data as CustomerRefundRow
  },
}
