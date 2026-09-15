import { supabase } from '../client.js'
import { fetchAllRows } from './_paging.js'
import { toAgingNumbers } from './customerLedger.js'
import type { AgingBucket } from './customerLedger.js'
import { todayLocalISO } from '../../lib/dates.js'

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

/**
 * One vendor's open payables by bucket, in the base currency (rma_ap_aging,
 * 20260861). Each vendor invoice's balance is converted at its own rate before
 * any two are added — adding the raw balances would put dollars and pounds in
 * one total and report a number that is not money.
 */
export type ApAgingVendorRow = {
  vendor_id: string
  vendor_name: string | null
  total: number
} & Record<ApAgingBucket, number>

// ── Module ────────────────────────────────────────────────────────────────────

export const vendorLedger = {
  /**
   * list: the full signed transaction feed for one vendor (vendor invoices,
   * vendor payments), reading v_vendor_ledger. Powers a per-vendor statement,
   * mirroring the Customer Details "Billing" tab. A statement needs every
   * entry, so it reads past the Data API's row cap. (BUG-066.)
   */
  async list(vendorId: string): Promise<VendorLedgerEntryRow[]> {
    try {
      return await fetchAllRows<VendorLedgerEntryRow>((from, to) =>
        supabase
          .from('v_vendor_ledger')
          .select('*')
          .eq('vendor_id', vendorId)
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
   * apAging: open payables per vendor, by aging bucket (src/lib/aging.js), in
   * the base currency, largest total first — bucketed, converted and summed in
   * the database (rma_ap_aging, 20260861) over every approved-or-later vendor
   * invoice with a balance. This used to load every vendor invoice into the
   * browser, which the Data API caps at 1 000 rows. (BUG-066.) `today` is the
   * viewer's local date.
   */
  async apAging(today: string = todayLocalISO()): Promise<ApAgingVendorRow[]> {
    const rows = await fetchAllRows<ApAgingVendorRow>((from, to) =>
      supabase
        .rpc('rma_ap_aging', { p_today: today })
        .order('total', { ascending: false })
        .order('vendor_id', { ascending: true })
        .range(from, to)
    )
    return rows.map(toAgingNumbers)
  },
}
