import { supabase } from '../client.js'

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

export const margin = {
  async byInvoice(): Promise<{ data: InvoiceMarginRow[]; missing: boolean }> {
    const { data, error } = await supabase
      .from('v_invoice_margin')
      .select('*')
      .order('posted_at', { ascending: false })
    if (error) {
      if (NOT_PROVISIONED.includes(error.code)) return { data: [], missing: true }
      throw error
    }
    return { data: (data ?? []) as InvoiceMarginRow[], missing: false }
  },

  async byRep(): Promise<{ data: SalesRepPerformanceRow[]; missing: boolean }> {
    const { data, error } = await supabase
      .from('v_sales_rep_performance')
      .select('*')
      .order('revenue_base', { ascending: false })
    if (error) {
      if (NOT_PROVISIONED.includes(error.code)) return { data: [], missing: true }
      throw error
    }
    return { data: (data ?? []) as SalesRepPerformanceRow[], missing: false }
  },
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
