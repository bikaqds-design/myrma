import { supabase } from '../client.js'
import { fetchPage, fetchAllRows } from './_paging.js'
import type { PagedResult } from './types.js'

/**
 * Margin reporting — reads v_invoice_margin and v_sales_rep_performance
 * (20260798).
 *
 * The one rule these views enforce, and that anything reading them must not
 * undo: an invoice whose cost of goods is incomplete is NEVER counted as
 * profit. `margin_base` comes back NULL for those, which is "cannot tell" and
 * not "made nothing". Coalescing it to 0 in the UI would put a E£100,000 sale
 * with no recorded cost into the totals as E£100,000 of pure margin — a single
 * such invoice can carry a rep's whole quarter and look like brilliance.
 *
 * That is why every aggregate carries both revenues. `revenue_base` is
 * everything sold; `costed_revenue_base` is the part margin is measured
 * against. The difference is the part nobody can cost yet, and it is reported
 * rather than hidden.
 */

export interface InvoiceMarginRow {
  id: string
  inv_code: string | null
  customer_id: string
  customer_name: string | null
  assigned_rep: string | null
  posted_at: string | null
  doc_status: string
  payment_status: string
  revenue_base: number
  cogs_base: number | null
  cogs_unknown_qty: number
  cogs_complete: boolean
  /** NULL when the cost is incomplete. Never coalesce this to 0. */
  margin_base: number | null
  margin_pct: number | null
}

export interface SalesRepPerformanceRow {
  assigned_rep: string
  invoices_total: number
  invoices_costed: number
  invoices_cost_unknown: number
  /** Everything sold. */
  revenue_base: number
  /** The part that can be costed — what margin_pct is measured against. */
  costed_revenue_base: number
  cogs_base: number
  margin_base: number
  margin_pct: number | null
  first_sale: string | null
  last_sale: string | null
}

/** A missing view means the migration has not been applied yet. */
const NOT_PROVISIONED = ['42P01', 'PGRST205']

/** Raw sums behind the Profitability totals (rma_margin_totals, 20260864). */
export interface MarginTotalsRaw {
  invoices: number
  invoices_costed: number
  revenue_base: number
  costed_revenue_base: number
  cogs_base: number
  margin_base: number
}

export const margin = {
  /**
   * One page of invoice margins, most recently posted first. It read every row
   * — capped at 1 000 — and summed them on the page. (BUG-066.)
   */
  async byInvoicePage(page: number, pageSize: number): Promise<PagedResult<InvoiceMarginRow>> {
    try {
      return await fetchPage<InvoiceMarginRow>((from, to) =>
        supabase
          .from('v_invoice_margin')
          .select('*', { count: 'exact' })
          .order('posted_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
        page, pageSize)
    } catch (error) {
      if (NOT_PROVISIONED.includes((error as { code?: string })?.code ?? '')) {
        return { missing: true, data: [], count: 0, page, pageSize, totalPages: 0 }
      }
      throw error
    }
  },

  /** Totals across every invoice margin, summed in the database; null when the views are missing. */
  async totals(): Promise<MarginTotalsRaw | null> {
    const { data, error } = await supabase.rpc('rma_margin_totals')
    if (error) {
      if (NOT_PROVISIONED.includes(error.code) || error.code === '42883' || error.code === 'PGRST202') return null
      throw error
    }
    const s = (data ?? {}) as Partial<MarginTotalsRaw>
    return {
      invoices: Number(s.invoices) || 0,
      invoices_costed: Number(s.invoices_costed) || 0,
      revenue_base: Number(s.revenue_base) || 0,
      costed_revenue_base: Number(s.costed_revenue_base) || 0,
      cogs_base: Number(s.cogs_base) || 0,
      margin_base: Number(s.margin_base) || 0,
    }
  },

  /** Every rep's performance row (one per rep), best revenue first. */
  async byRep(): Promise<{ data: SalesRepPerformanceRow[]; missing: boolean }> {
    try {
      const data = await fetchAllRows<SalesRepPerformanceRow>((from, to) =>
        supabase
          .from('v_sales_rep_performance')
          .select('*')
          .order('revenue_base', { ascending: false })
          .order('assigned_rep', { ascending: true })
          .range(from, to)
      )
      return { data, missing: false }
    } catch (error) {
      if (NOT_PROVISIONED.includes((error as { code?: string })?.code ?? '')) return { data: [], missing: true }
      throw error
    }
  },
}

/**
 * The Profitability totals from the database's raw sums, rounded exactly as
 * summariseMargin rounds its own — so the two can never disagree.
 */
export function marginTotalsFromRaw(raw: MarginTotalsRaw): ReturnType<typeof summariseMargin> {
  const revenueBase = Number(raw.revenue_base) || 0
  const costedRevenueBase = Number(raw.costed_revenue_base) || 0
  const marginBase = Number(raw.margin_base) || 0
  return {
    invoices: raw.invoices,
    invoicesCosted: raw.invoices_costed,
    invoicesCostUnknown: raw.invoices - raw.invoices_costed,
    revenueBase: Math.round(revenueBase * 100) / 100,
    costedRevenueBase: Math.round(costedRevenueBase * 100) / 100,
    cogsBase: Math.round((Number(raw.cogs_base) || 0) * 100) / 100,
    marginBase: Math.round(marginBase * 100) / 100,
    marginPct: costedRevenueBase > 0 ? Math.round((10000 * marginBase) / costedRevenueBase) / 100 : null,
  }
}

/**
 * Totals across a set of invoices, computed the same way the per-rep view
 * computes them so the page footer cannot disagree with the rows above it.
 *
 * Kept as a pure function so it can be tested without a database.
 */
export function summariseMargin(rows: InvoiceMarginRow[]): {
  invoices: number
  invoicesCosted: number
  invoicesCostUnknown: number
  revenueBase: number
  costedRevenueBase: number
  cogsBase: number
  marginBase: number
  /** NULL when nothing could be costed — not 0, which would read as no profit. */
  marginPct: number | null
} {
  let revenueBase = 0
  let costedRevenueBase = 0
  let cogsBase = 0
  let marginBase = 0
  let invoicesCosted = 0

  for (const r of rows) {
    revenueBase += Number(r.revenue_base) || 0
    // Only complete invoices contribute to anything margin is derived from.
    if (r.cogs_complete && r.margin_base !== null) {
      invoicesCosted += 1
      costedRevenueBase += Number(r.revenue_base) || 0
      cogsBase += Number(r.cogs_base) || 0
      marginBase += Number(r.margin_base) || 0
    }
  }

  return {
    invoices: rows.length,
    invoicesCosted,
    invoicesCostUnknown: rows.length - invoicesCosted,
    revenueBase: Math.round(revenueBase * 100) / 100,
    costedRevenueBase: Math.round(costedRevenueBase * 100) / 100,
    cogsBase: Math.round(cogsBase * 100) / 100,
    marginBase: Math.round(marginBase * 100) / 100,
    // Divided by costed revenue, never by total revenue: dividing by total
    // understates the rate by however much could not be costed, and makes the
    // figure move when an unrelated invoice gets a cost.
    marginPct:
      costedRevenueBase > 0
        ? Math.round((10000 * marginBase) / costedRevenueBase) / 100
        : null,
  }
}
