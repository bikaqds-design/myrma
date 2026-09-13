import { supabase } from '../client.js'
import { vendorInvoices } from './purchasing'
import type { AgingBucket } from './customerLedger'
import { agingBucket } from '../../lib/aging.js'
import { daysPastDueLocal } from '../../lib/dates.js'

// ── Row types ─────────────────────────────────────────────────────────────────
// AP mirror of customerLedger.ts — reads v_vendor_ledger
// (20260761_vendor_ledger_view.sql).

export type VendorLedgerEntryType = 'vendor_invoice' | 'vendor_payment'

export interface VendorLedgerEntryRow {
  id: string
  entry_type: VendorLedgerEntryType
  entry_code: string | null
  vendor_id: string
  /** Signed, in the entry's own `currency`. Never add these across rows. */
  amount: number
  currency: string
  /** `amount` in the base currency. This is what a running balance must use. */
  amount_base: number | null
  status: string
  due_date: string | null
  entry_date: string
  created_at: string
}

// Same buckets as receivables — one definition in src/lib/aging.js.
export type ApAgingBucket = AgingBucket

export interface ApAgingInvoiceRow {
  vendor_id: string
  invoice_id: string
  vi_code: string | null
  due_date: string | null
  /** Outstanding in the invoice's own `currency`. */
  remaining: number
  currency: string
  /**
   * The same balance in base currency. Aging buckets sum across every vendor
   * invoice, so they have to add these — adding `remaining` would put dollars
   * and pounds in one total and report a number that is not money.
   */
  remaining_base: number
  daysPastDue: number
  bucket: ApAgingBucket
}

const PAYABLE_STATUSES = ['approved', 'partially_received', 'received']

// ── Module ────────────────────────────────────────────────────────────────────

export const vendorLedger = {
  /**
   * list: the full signed transaction feed for one vendor (vendor invoices,
   * vendor payments), reading v_vendor_ledger. Powers a per-vendor statement,
   * mirroring the Customer Details "Billing" tab.
   */
  async list(vendorId: string): Promise<VendorLedgerEntryRow[]> {
    const { data, error } = await supabase
      .from('v_vendor_ledger')
      .select('*')
      .eq('vendor_id', vendorId)
      .order('entry_date', { ascending: true })
    if (error) {
      if (error.code === '42P01') return []
      throw error
    }
    return (data ?? []) as VendorLedgerEntryRow[]
  },

  /**
   * apAgingReport: one row per payable vendor invoice with an outstanding
   * balance, bucketed by days past due relative to due_date — the AP
   * analogue of customerLedger.agingReport().
   */
  async apAgingReport(): Promise<ApAgingInvoiceRow[]> {
    const invoices = await vendorInvoices.list()
    return invoices
      .filter((inv) => PAYABLE_STATUSES.includes(inv.status))
      .map((inv) => {
        const remaining = Math.round(((inv.total ?? 0) - (inv.amount_paid ?? 0)) * 100) / 100
        if (remaining <= 0.001) return null
        const rate = Number(inv.exchange_rate) || 1
        // Local calendar days — see customerLedger.agingReport.
        const daysPastDue = daysPastDueLocal(inv.due_date)
        return {
          vendor_id: inv.vendor_id,
          invoice_id: inv.id,
          vi_code: inv.vi_code,
          due_date: inv.due_date,
          remaining,
          currency: inv.currency,
          remaining_base: Math.round(remaining * rate * 100) / 100,
          daysPastDue,
          bucket: agingBucket(inv.due_date) as ApAgingBucket,
        } as ApAgingInvoiceRow
      })
      .filter((row): row is ApAgingInvoiceRow => row !== null)
  },
}
