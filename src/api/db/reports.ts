import { supabase } from '../client.js'
import { fetchPage, fetchAllRows } from './_paging.js'
import type { PagedResult } from './types.js'
import type { RMATicketRow } from './tickets.js'

// ── Reports (BUG-066) ─────────────────────────────────────────────────────────
// The Reports page loaded every ticket, customer, time entry, invoice,
// quotation, order, payment, deal and lead and filtered them to the date range
// in the browser — past the Data API's 1 000-row cap, part of the business
// reported as all of it. Each tab now reads its figures from 20260864 and pages
// its tables in the database.
//
// A range is the viewer's local start of `from` to local end of `to`, as ISO
// instants — reportRange() builds it exactly as the page's inRange() did.

export interface ReportRange {
  from: string
  to: string
}

/** Local start of the first day and local end of the last, as instants. */
export function reportRange(fromYmd: string, toYmd: string): ReportRange {
  const from = new Date(fromYmd)
  from.setHours(0, 0, 0, 0)
  const to = new Date(toYmd)
  to.setHours(23, 59, 59, 999)
  return { from: from.toISOString(), to: to.toISOString() }
}

export interface ReportTicketFilters {
  status?: string
  priority?: string
  technician?: string
}

export interface ReportTicketSummary {
  total: number
  completed: number
  /** Mean of each Completed ticket's resolution hours (one decimal); null when none. */
  avg_resolution_hours: number | null
  completed_with_due: number
  sla_met: number
  overdue: number
  statuses: string[]
  priorities: string[]
  technicians: string[]
}

export interface ReportCustomerRow {
  id: string
  contact_person: string | null
  company_name: string | null
  customer_status: string | null
  created_date: string | null
  total_tickets: number
  open_tickets: number
  last_activity: string | null
}

export interface ReportTechnicianRow {
  email: string
  assigned: number
  completed: number
  avg_resolution_hours: number | null
  hours_logged: number
}

export interface ReportPipeline {
  deal_groups: Array<{ pipeline_id: string | null; stage: string | null; status: string | null; rep: string | null; count: number; value: number }>
  open_age_days_sum: number
  won_cycle: { count: number; days_sum: number }
  lost_reasons: Array<{ reason: string | null; count: number }>
  lead_sources: Array<{ source: string | null; total: number; converted: number }>
}

interface CountValue {
  count: number
  value: number
}

export interface ReportSales {
  quotations: CountValue & { won: number; lost: number }
  invoiced: CountValue
  collected: CountValue
  funnel_orders: CountValue
  funnel_invoices: CountValue
  standalone_orders: number
  standalone_invoices: number
  by_rep: Array<{ rep: string | null; raised: number; won: number; lost: number; value: number; won_value: number }>
}

export interface ReportFinancial {
  invoices: number
  total_invoiced: number
  total_paid: number
  outstanding: number
  quotes_value: number
}

export interface ReportInvoiceRow {
  id: string
  inv_code: string | null
  customer_id: string
  customer_name: string | null
  doc_status: string | null
  payment_status: string | null
  total: number | null
  amount_paid: number | null
  due_date: string | null
  created_at: string
}

const n = (v: unknown) => Number(v) || 0
const nOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v))
const cv = (v: unknown): CountValue => {
  const o = (v ?? {}) as Partial<CountValue>
  return { count: n(o.count), value: n(o.value) }
}

/** The range's tickets, narrowed by the report's filters, newest first, for rows `from`..`to`. */
function ticketReportQuery(range: ReportRange, f: ReportTicketFilters, withCount: boolean, from: number, to: number) {
  let q = supabase
    .from('rma_tickets')
    .select('*', withCount ? { count: 'exact' } : undefined)
    .gte('created_date', range.from)
    .lte('created_date', range.to)
  if (f.status) q = q.eq('ticket_status', f.status)
  if (f.priority) q = q.eq('priority', f.priority)
  if (f.technician) q = q.eq('assigned_technician', f.technician)
  return q.order('created_date', { ascending: false }).order('id', { ascending: true }).range(from, to)
}

async function rpcJson<T>(fn: string, args: Record<string, unknown>): Promise<Partial<T>> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw error
  return (data ?? {}) as Partial<T>
}

export const reports = {
  // ── Tickets ────────────────────────────────────────────────────────────────
  async ticketSummary(range: ReportRange, filters: ReportTicketFilters = {}, now: Date = new Date()): Promise<ReportTicketSummary> {
    const s = await rpcJson<ReportTicketSummary>('rma_report_ticket_summary', {
      p_from: range.from,
      p_to: range.to,
      p_status: filters.status || null,
      p_priority: filters.priority || null,
      p_technician: filters.technician || null,
      p_now: now.toISOString(),
    })
    return {
      total: n(s.total),
      completed: n(s.completed),
      avg_resolution_hours: nOrNull(s.avg_resolution_hours),
      completed_with_due: n(s.completed_with_due),
      sla_met: n(s.sla_met),
      overdue: n(s.overdue),
      statuses: s.statuses ?? [],
      priorities: s.priorities ?? [],
      technicians: s.technicians ?? [],
    }
  },

  /** One page of the range's tickets, newest first, as the report lists them. */
  async ticketsPage(range: ReportRange, filters: ReportTicketFilters, page: number, pageSize: number): Promise<PagedResult<RMATicketRow>> {
    return fetchPage<RMATicketRow>((from, to) => ticketReportQuery(range, filters, true, from, to), page, pageSize)
  },

  /** Every ticket the report matches — for its export. */
  async ticketsAll(range: ReportRange, filters: ReportTicketFilters): Promise<RMATicketRow[]> {
    return fetchAllRows<RMATicketRow>((from, to) => ticketReportQuery(range, filters, false, from, to))
  },

  // ── Customers ──────────────────────────────────────────────────────────────
  async customerSummary(range: ReportRange): Promise<{ customers: number; active: number; returning: number; tickets: number }> {
    const s = await rpcJson<{ customers: number; active: number; returning: number; tickets: number }>(
      'rma_report_customer_summary', { p_from: range.from, p_to: range.to })
    return { customers: n(s.customers), active: n(s.active), returning: n(s.returning), tickets: n(s.tickets) }
  },

  /** Customers created in the range, most tickets first, then newest. */
  async customersPage(range: ReportRange, page: number, pageSize: number): Promise<PagedResult<ReportCustomerRow>> {
    const res = await fetchPage<ReportCustomerRow>((from, to) =>
      supabase
        .rpc('rma_report_customers', { p_from: range.from, p_to: range.to }, { count: 'exact' })
        .order('total_tickets', { ascending: false })
        .order('created_date', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
        .range(from, to),
      page, pageSize)
    return { ...res, data: res.data.map(toCustomerRow) }
  },

  async customersAll(range: ReportRange): Promise<ReportCustomerRow[]> {
    const rows = await fetchAllRows<ReportCustomerRow>((from, to) =>
      supabase
        .rpc('rma_report_customers', { p_from: range.from, p_to: range.to })
        .order('total_tickets', { ascending: false })
        .order('created_date', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
        .range(from, to))
    return rows.map(toCustomerRow)
  },

  // ── Technicians ────────────────────────────────────────────────────────────
  /** One row per technician assigned a ticket in the range, most assigned first. */
  async technicians(range: ReportRange): Promise<ReportTechnicianRow[]> {
    const rows = await fetchAllRows<ReportTechnicianRow>((from, to) =>
      supabase
        .rpc('rma_report_technicians', { p_from: range.from, p_to: range.to })
        .order('assigned', { ascending: false })
        .order('last_assigned', { ascending: false, nullsFirst: false })
        .order('email', { ascending: true })
        .range(from, to))
    return rows.map((r) => ({
      email: r.email,
      assigned: n(r.assigned),
      completed: n(r.completed),
      avg_resolution_hours: nOrNull(r.avg_resolution_hours),
      hours_logged: n(r.hours_logged),
    }))
  },

  // ── CRM tabs ───────────────────────────────────────────────────────────────
  async pipeline(range: ReportRange, now: Date = new Date()): Promise<ReportPipeline> {
    const s = await rpcJson<ReportPipeline>('rma_report_pipeline', { p_from: range.from, p_to: range.to, p_now: now.toISOString() })
    const wc = (s.won_cycle ?? {}) as Partial<ReportPipeline['won_cycle']>
    return {
      deal_groups: (s.deal_groups ?? []).map((g) => ({ ...g, count: n(g.count), value: n(g.value) })),
      open_age_days_sum: n(s.open_age_days_sum),
      won_cycle: { count: n(wc.count), days_sum: n(wc.days_sum) },
      lost_reasons: (s.lost_reasons ?? []).map((r) => ({ reason: r.reason ?? null, count: n(r.count) })),
      lead_sources: (s.lead_sources ?? []).map((r) => ({ source: r.source ?? null, total: n(r.total), converted: n(r.converted) })),
    }
  },

  async sales(range: ReportRange): Promise<ReportSales> {
    const s = await rpcJson<ReportSales>('rma_report_sales', { p_from: range.from, p_to: range.to })
    const q = (s.quotations ?? {}) as Partial<ReportSales['quotations']>
    return {
      quotations: { count: n(q.count), value: n(q.value), won: n(q.won), lost: n(q.lost) },
      invoiced: cv(s.invoiced),
      collected: cv(s.collected),
      funnel_orders: cv(s.funnel_orders),
      funnel_invoices: cv(s.funnel_invoices),
      standalone_orders: n(s.standalone_orders),
      standalone_invoices: n(s.standalone_invoices),
      by_rep: (s.by_rep ?? []).map((r) => ({
        rep: r.rep ?? null, raised: n(r.raised), won: n(r.won), lost: n(r.lost), value: n(r.value), won_value: n(r.won_value),
      })),
    }
  },

  async financial(range: ReportRange): Promise<ReportFinancial> {
    const s = await rpcJson<ReportFinancial>('rma_report_financial', { p_from: range.from, p_to: range.to })
    return {
      invoices: n(s.invoices),
      total_invoiced: n(s.total_invoiced),
      total_paid: n(s.total_paid),
      outstanding: n(s.outstanding),
      quotes_value: n(s.quotes_value),
    }
  },

  /** One page of the range's invoices (every status), newest first, with the customer name. */
  async invoicesPage(range: ReportRange, page: number, pageSize: number): Promise<PagedResult<ReportInvoiceRow>> {
    return fetchPage<ReportInvoiceRow>((from, to) =>
      supabase
        .from('v_report_invoices')
        .select('*', { count: 'exact' })
        .gte('created_at', range.from)
        .lte('created_at', range.to)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to),
      page, pageSize)
  },

  async invoicesAll(range: ReportRange): Promise<ReportInvoiceRow[]> {
    return fetchAllRows<ReportInvoiceRow>((from, to) =>
      supabase
        .from('v_report_invoices')
        .select('*')
        .gte('created_at', range.from)
        .lte('created_at', range.to)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to))
  },
}

function toCustomerRow(r: ReportCustomerRow): ReportCustomerRow {
  return { ...r, total_tickets: n(r.total_tickets), open_tickets: n(r.open_tickets) }
}
