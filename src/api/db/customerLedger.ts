import { supabase } from '../client.js'
import { crmInvoices } from './crmInvoices'

// ── Row types ─────────────────────────────────────────────────────────────────

export type LedgerEntryType = 'invoice' | 'credit_note' | 'payment'

export interface LedgerEntryRow {
  id: string
  entry_type: LedgerEntryType
  entry_code: string | null
  customer_id: string
  amount: number
  status: string
  due_date: string | null
  entry_date: string
  created_at: string
}

export type AgingBucket = 'current' | 'd31_60' | 'd61_90' | 'd90_plus'

export interface AgingInvoiceRow {
  customer_id: string
  invoice_id: string
  inv_code: string | null
  due_date: string | null
  remaining: number
  daysPastDue: number
  bucket: AgingBucket
}

function bucketFor(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 30) return 'current'
  if (daysPastDue <= 60) return 'd31_60'
  if (daysPastDue <= 90) return 'd61_90'
  return 'd90_plus'
}

// ── Module ────────────────────────────────────────────────────────────────────

export const customerLedger = {
  /**
   * list: the full signed transaction feed for one customer (invoices,
   * credit notes, payments), reading v_customer_ledger
   * (20260730_crm_customer_ledger_view.sql). Powers the Customer Details
   * "Billing" tab statement — sort by entry_date and cumulative-sum `amount`
   * for a running balance.
   */
  async list(customerId: string): Promise<LedgerEntryRow[]> {
    const { data, error } = await supabase
      .from('v_customer_ledger')
      .select('*')
      .eq('customer_id', customerId)
      .order('entry_date', { ascending: true })
    if (error) {
      if (error.code === '42P01') return []
      throw error
    }
    return (data ?? []) as LedgerEntryRow[]
  },

  /**
   * agingReport: one row per posted invoice with an outstanding balance,
   * bucketed by days past due (Current ≤30 / 31-60 / 61-90 / 90+) relative to
   * due_date. Reads crm_invoices directly rather than the ledger view —
   * amount_paid already reflects both payment and credit-note applications
   * (both write through crmInvoices.recordPayment()), so this is the single
   * source of truth for "what's still owed and how overdue is it."
   * Caller groups by customer_id and joins customer names client-side, same
   * convention used by the Sales Documents / Pipeline pages.
   */
  async agingReport(): Promise<AgingInvoiceRow[]> {
    const invoices = await crmInvoices.list({ docStatus: 'posted' })
    const today = Date.now()
    return invoices
      .map((inv) => {
        const remaining = Math.round(((inv.total ?? 0) - (inv.amount_paid ?? 0)) * 100) / 100
        if (remaining <= 0.001) return null
        const daysPastDue = inv.due_date
          ? Math.floor((today - new Date(inv.due_date).getTime()) / 86_400_000)
          : 0
        return {
          customer_id: inv.customer_id,
          invoice_id: inv.id,
          inv_code: inv.inv_code,
          due_date: inv.due_date,
          remaining,
          daysPastDue,
          bucket: bucketFor(daysPastDue),
        } as AgingInvoiceRow
      })
      .filter((row): row is AgingInvoiceRow => row !== null)
  },
}
