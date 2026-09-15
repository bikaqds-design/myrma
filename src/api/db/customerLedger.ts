import { supabase } from '../client.js'
import { fetchAllRows } from './_paging.js'
import { todayLocalISO } from '../../lib/dates.js'

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

// See src/lib/aging.js for what each bucket means and why 'current' is gone.
export type AgingBucket = 'not_due' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus' | 'no_due_date'

/** One customer's open receivables by bucket (rma_ar_aging, 20260861). */
export type AgingCustomerRow = {
  customer_id: string
  customer_name: string | null
  total: number
} & Record<AgingBucket, number>

const AGING_NUMBER_FIELDS = ['not_due', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'no_due_date', 'total'] as const

/** Numeric columns come back as strings or numbers; the report adds them. */
export function toAgingNumbers<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row }
  for (const f of AGING_NUMBER_FIELDS) out[f] = Number(row[f] ?? 0)
  return out as T
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
    // A statement needs every entry — read past the Data API's row cap. (BUG-066.)
    try {
      return await fetchAllRows<LedgerEntryRow>((from, to) =>
        supabase
          .from('v_customer_ledger')
          .select('*')
          .eq('customer_id', customerId)
          .order('entry_date', { ascending: true })
          .order('entry_type', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)
      )
    } catch (error) {
      if ((error as { code?: string })?.code === '42P01') return []
      throw error
    }
  },

  /**
   * arAging: open receivables per customer, by aging bucket (src/lib/aging.js),
   * largest total first. Bucketed and summed in the database (rma_ar_aging,
   * 20260861) over every posted invoice with a balance — this used to load
   * every posted invoice into the browser, which the Data API caps at 1 000
   * rows, so the receivable total could quietly leave invoices out. (BUG-066.)
   * `today` is the viewer's local date: an invoice due today is not yet late.
   */
  async arAging(today: string = todayLocalISO()): Promise<AgingCustomerRow[]> {
    const rows = await fetchAllRows<AgingCustomerRow>((from, to) =>
      supabase
        .rpc('rma_ar_aging', { p_today: today })
        .order('total', { ascending: false })
        .order('customer_id', { ascending: true })
        .range(from, to)
    )
    return rows.map(toAgingNumbers)
  },
}
