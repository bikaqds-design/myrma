import { supabase } from '../client.js'
import { fetchAllRows } from './_paging.js'

// Accounting periods and month-end close (A-03, 20260910). A month with no
// row is open. Every change goes through the database's period functions:
// finance (accountants, administrators) soft close, close and reopen a
// soft-closed month; a closed month is reopened only when an administrator
// other than the one who asked approves it. Nothing here writes the tables.

export type PeriodStatus = 'open' | 'soft_closed' | 'closed'

export interface AccountingPeriodRow {
  period_start: string
  status: PeriodStatus
  soft_closed_by: string | null
  soft_closed_at: string | null
  closed_by: string | null
  closed_at: string | null
  reopened_by: string | null
  reopened_at: string | null
  reopen_reason: string | null
}

export interface PeriodReopenRequestRow {
  id: string
  period_start: string
  reason: string
  requested_by: string
  requested_at: string
  status: 'pending' | 'approved' | 'rejected'
  decided_by: string | null
  decided_at: string | null
  decision_note: string | null
}

export interface CloseChecklistRow {
  item: string
  item_count: number | null
  amount: number | null
}

export const periods = {
  /** Every month that has ever been closed or reopened (a handful per year). */
  async list(): Promise<AccountingPeriodRow[]> {
    return fetchAllRows<AccountingPeriodRow>((from, to) =>
      supabase
        .from('accounting_periods')
        .select('period_start, status, soft_closed_by, soft_closed_at, closed_by, closed_at, reopened_by, reopened_at, reopen_reason')
        .order('period_start', { ascending: false })
        .range(from, to)
    )
  },

  /** Requests to reopen a closed month still waiting for an administrator. */
  async pendingRequests(): Promise<PeriodReopenRequestRow[]> {
    return fetchAllRows<PeriodReopenRequestRow>((from, to) =>
      supabase
        .from('period_reopen_requests')
        .select('id, period_start, reason, requested_by, requested_at, status, decided_by, decided_at, decision_note')
        .eq('status', 'pending')
        .order('requested_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    )
  },

  async softClose(month: string): Promise<void> {
    const { error } = await supabase.rpc('soft_close_accounting_period', { p_month: month })
    if (error) throw error
  },

  async close(month: string): Promise<void> {
    const { error } = await supabase.rpc('close_accounting_period', { p_month: month })
    if (error) throw error
  },

  async reopenSoftClosed(month: string): Promise<void> {
    const { error } = await supabase.rpc('reopen_soft_closed_period', { p_month: month })
    if (error) throw error
  },

  async requestReopen(month: string, reason: string): Promise<string> {
    const { data, error } = await supabase.rpc('request_period_reopen', { p_month: month, p_reason: reason })
    if (error) throw error
    return data as string
  },

  async approveReopen(requestId: string, note?: string): Promise<void> {
    const { error } = await supabase.rpc('approve_period_reopen', { p_request: requestId, p_note: note || null })
    if (error) throw error
  },

  /** An administrator turns the request down, or the one who asked withdraws it. */
  async rejectReopen(requestId: string, note?: string): Promise<void> {
    const { error } = await supabase.rpc('reject_period_reopen', { p_request: requestId, p_note: note || null })
    if (error) throw error
  },

  /** What is still unfinished for a month (advisory: nothing here blocks a close). */
  async checklist(month: string): Promise<CloseChecklistRow[]> {
    const { data, error } = await supabase.rpc('rma_period_close_checklist', { p_month: month })
    if (error) throw error
    return (data ?? []) as CloseChecklistRow[]
  },
}
