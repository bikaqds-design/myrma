import { supabase } from '../client.js'
import { fetchAllRows, fetchPage } from './_paging.js'

// Month-end revaluation of foreign-currency balances (A-08c, 20260918). The
// preview shows what a month's run would book; the run (administrators and
// accountants with accounting.close_period) posts on the month end and
// reverses on the 1st. Nothing here writes the tables.

export interface FxRevaluationItemRow {
  side: 'receivable' | 'payable'
  doc_type: 'invoice' | 'payment' | 'credit_note' | 'vendor_invoice' | 'vendor_payment'
  doc_id: string
  doc_code: string | null
  party_id: string | null
  party_name?: string | null
  currency: string
  open_amount: number
  doc_rate: number
  carried_base: number
  rate: number | null
  revalued_base: number | null
  effect: number | null
}

export interface FxRevaluationRunRow {
  id: string
  period_start: string
  revalued_on: string
  item_count: number
  total_gain: number
  total_loss: number
  entry_id: string | null
  reversal_entry_id: string | null
  created_by: string | null
  created_at: string
}

export const fxRevaluation = {
  /** What revaluing the month would book, one row per open foreign item. */
  async preview(month: string): Promise<FxRevaluationItemRow[]> {
    const { data, error } = await supabase.rpc('rma_fx_revaluation_preview', { p_month: month })
    if (error) throw error
    return (data ?? []) as FxRevaluationItemRow[]
  },

  /** Revalue the month (once): returns the run's id. */
  async run(month: string): Promise<string> {
    const { data, error } = await supabase.rpc('run_fx_revaluation', { p_month: month })
    if (error) throw error
    return data as string
  },

  /** Past runs, newest month first, a page at a time. */
  async runsPage(page: number, pageSize: number) {
    return fetchPage<FxRevaluationRunRow>(
      (from, to) =>
        supabase
          .from('fx_revaluations')
          .select('*', { count: 'exact' })
          .order('period_start', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
      page,
      pageSize,
    )
  },

  /** A run's lines (every one: the run is what they add up to). */
  async lines(runId: string): Promise<FxRevaluationItemRow[]> {
    return fetchAllRows<FxRevaluationItemRow>((from, to) =>
      supabase
        .from('fx_revaluation_lines')
        .select('side, doc_type, doc_id, doc_code, party_id, currency, open_amount, doc_rate, carried_base, rate, revalued_base, effect')
        .eq('revaluation_id', runId)
        .order('side', { ascending: false })
        .order('currency', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    )
  },
}
