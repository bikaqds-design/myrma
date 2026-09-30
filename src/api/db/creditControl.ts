import { supabase } from '../client.js'

// Credit limits (A-06, 20260919). The database refuses approving an order or
// posting an invoice (not from an order) that takes a customer over their
// limit; a manager can approve it with a reason. The figures are the
// database's, in the base currency.

export interface CreditStatusRow {
  credit_limit: number | null
  open_invoices: number
  open_orders: number
  unused_credits: number
  exposure: number
  available: number | null
  currency: string
}

export type CreditOverrideDocType = 'sales_order' | 'invoice'

export const creditControl = {
  /** The customer's limit, what counts against it and what is left (any staff). */
  async status(customerId: string): Promise<CreditStatusRow | null> {
    const { data, error } = await supabase.rpc('rma_customer_credit_status', { p_customer_id: customerId })
    if (error) throw error
    return ((data ?? []) as CreditStatusRow[])[0] ?? null
  },

  /** A manager approves this document going over the limit (reason 10+ characters). */
  async approveOverride(docType: CreditOverrideDocType, docId: string, reason: string): Promise<void> {
    const { error } = await supabase.rpc('approve_credit_override', { p_doc_type: docType, p_doc_id: docId, p_reason: reason })
    if (error) throw error
  },
}
