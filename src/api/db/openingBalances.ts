import { supabase } from '../client.js'
import { fetchAllRows } from './_paging.js'

// Opening balances (B-03, 20260921). The batch and its rows are read directly
// (managers and accountants); every change goes through the database's
// functions, which only administrators and accountants may call.

export type OpeningSection = 'accounts' | 'receivables' | 'payables' | 'stock'

export interface OpeningBatchRow {
  id: string
  opening_date: string
  status: 'draft' | 'posted' | 'reversed'
  notes: string | null
  created_by: string
  created_at: string
  posted_by: string | null
  posted_at: string | null
  reversed_by: string | null
  reversed_at: string | null
  reverse_reason: string | null
}

export interface OpeningAccountRow {
  id: string
  line_no: number
  debit: number
  credit: number
  memo: string | null
  account: { code: string; name: string; name_ar: string | null } | null
}

export interface OpeningDocumentRow {
  id: string
  line_no: number
  kind: 'receivable' | 'payable'
  doc_no: string
  doc_date: string
  due_date: string | null
  currency: string
  exchange_rate: number
  amount: number
  notes: string | null
  crm_invoice_id: string | null
  vendor_invoice_id: string | null
  customer: { company_name: string | null; customer_code: string | null } | null
  vendor: { brand_name: string } | null
}

export interface OpeningStockRow {
  id: string
  line_no: number
  qty: number
  unit_cost: number | null
  serials: string[]
  notes: string | null
  product: { sku: string; product_name: string } | null
  warehouse: { name: string; code: string | null } | null
}

export interface OpeningSummary {
  accounts: { rows: number; debit: number; credit: number }
  tb_balanced: boolean
  receivables: { rows: number; total_base: number; trial_balance: number; difference: number }
  payables: { rows: number; total_base: number; trial_balance: number; difference: number }
  stock: { rows: number; units: number; uncosted_units: number; known_cost: number; trial_balance: number; difference: number }
  other_accounts_net: number
  equity_difference: number
  currency: string
}

export interface OpeningRowError { row: number; error: string }
export interface OpeningSetResult { stored: number; errors: OpeningRowError[] }

const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw error
  return data as T
}

export const openingBalances = {
  /** The batch being built or in force (at most one), else null. */
  async current(): Promise<OpeningBatchRow | null> {
    const { data, error } = await supabase
      .from('opening_balance_batches')
      .select('*')
      .in('status', ['draft', 'posted'])
      .order('created_at', { ascending: false })
      .range(0, 0)
    if (error) throw error
    return ((data ?? []) as OpeningBatchRow[])[0] ?? null
  },

  /** Reversed batches, newest first (a short history). */
  async reversed(): Promise<OpeningBatchRow[]> {
    const { data, error } = await supabase
      .from('opening_balance_batches')
      .select('*')
      .eq('status', 'reversed')
      .order('reversed_at', { ascending: false })
      .range(0, 19)
    if (error) throw error
    return (data ?? []) as OpeningBatchRow[]
  },

  async accounts(batchId: string): Promise<OpeningAccountRow[]> {
    return fetchAllRows<OpeningAccountRow>((from, to) =>
      supabase
        .from('opening_balance_accounts')
        .select('id, line_no, debit, credit, memo, account:gl_accounts(code, name, name_ar)')
        .eq('batch_id', batchId)
        .order('line_no', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    )
  },

  async documents(batchId: string, kind: 'receivable' | 'payable'): Promise<OpeningDocumentRow[]> {
    return fetchAllRows<OpeningDocumentRow>((from, to) =>
      supabase
        .from('opening_balance_documents')
        .select('id, line_no, kind, doc_no, doc_date, due_date, currency, exchange_rate, amount, notes, crm_invoice_id, vendor_invoice_id, customer:customers(company_name, customer_code), vendor:brands(brand_name)')
        .eq('batch_id', batchId)
        .eq('kind', kind)
        .order('line_no', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    )
  },

  async stock(batchId: string): Promise<OpeningStockRow[]> {
    return fetchAllRows<OpeningStockRow>((from, to) =>
      supabase
        .from('opening_balance_stock')
        .select('id, line_no, qty, unit_cost, serials, notes, product:products(sku, product_name), warehouse:warehouses(name, code)')
        .eq('batch_id', batchId)
        .order('line_no', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    )
  },

  summary: (batchId: string) => rpc<OpeningSummary>('rma_opening_balance_summary', { p_batch: batchId }),
  create: (openingDate: string, notes: string | null) =>
    rpc<string>('create_opening_balance_batch', { p_opening_date: openingDate, p_notes: notes }),
  setRows: (batchId: string, section: OpeningSection, rows: Record<string, unknown>[]) =>
    rpc<OpeningSetResult>('set_opening_balance_rows', { p_batch: batchId, p_section: section, p_rows: rows }),
  post: (batchId: string) => rpc<OpeningBatchRow>('post_opening_balances', { p_batch: batchId }),
  reverse: (batchId: string, reason: string) => rpc<OpeningBatchRow>('reverse_opening_balances', { p_batch: batchId, p_reason: reason }),
  remove: (batchId: string) => rpc<void>('delete_opening_balance_batch', { p_batch: batchId }),
}
