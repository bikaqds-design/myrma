import { supabase } from '../client.js'
import { todayLocalISO } from '../../lib/dates.js'
import type { RMATicketRow } from './tickets.js'

// ── Dashboard reads (BUG-066) ─────────────────────────────────────────────────
// The Dashboard loaded every ticket, inventory unit, deal, lead and overdue
// activity and did all of its counting in the browser — past the Data API's
// 1 000-row cap, part of the business reported as all of it. Every figure now
// comes from 20260863's functions or from a short, ordered query.

/** Statuses that mean a ticket is no longer being worked. */
export const RESOLVED_TICKET_STATUSES = ['Completed', 'Closed', 'Cancelled'] as const

export interface DashboardTicketSummary {
  total: number
  resolved: number
  overdue: number
  /** Tickets with a due date that are not cancelled — the SLA denominator. */
  tracked: number
  /** In the order the page met them: the status of the newest ticket first. */
  status_counts: Array<{ status: string; count: number }>
  priority_counts: Record<string, number>
  /** tech is null for unassigned tickets; newest-ticket order. */
  technicians: Array<{ tech: string | null; total: number; closed: number }>
  /** Tickets created per UTC day, last 31 days. */
  daily_created: Record<string, number>
  products: { received: number; under_repair: number; repaired: number; cant_repair: number; rma_stock: number }
  /** Every ticket, not only the range. */
  top_issues: Array<{ issue: string; count: number }>
}

export interface DashboardCrm {
  open_value: number
  open_count: number
  won_this_month: number
  leads_this_month: number
  open_by_stage: Array<{ stage: string | null; count: number; value: number }>
  /** rep is null for won deals with no rep. */
  won_by_rep: Array<{ rep: string | null; count: number; value: number }>
}

export type DashboardTicketRow = Pick<
  RMATicketRow,
  'id' | 'rma_number' | 'customer_name' | 'ticket_status' | 'priority' | 'assigned_technician' | 'created_date' | 'due_date'
>

const TICKET_ROW_COLUMNS = 'id, rma_number, customer_name, ticket_status, priority, assigned_technician, created_date, due_date'

function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const toNumberMap = (m: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries((m ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 0]))

/** The `not in resolved` filter value PostgREST takes. */
const RESOLVED_IN = `(${RESOLVED_TICKET_STATUSES.map((s) => `"${s}"`).join(',')})`

export const dashboard = {
  /** Ticket figures for tickets created since `since` (every ticket when null). */
  async ticketSummary(since: string | null, now: Date = new Date()): Promise<DashboardTicketSummary> {
    const { data, error } = await supabase.rpc('rma_dashboard_ticket_summary', {
      p_since: since,
      p_now: now.toISOString(),
      p_tz: viewerTimeZone(),
    })
    if (error) throw error
    const s = (data ?? {}) as Partial<DashboardTicketSummary>
    const p = (s.products ?? {}) as Partial<DashboardTicketSummary['products']>
    return {
      total: Number(s.total) || 0,
      resolved: Number(s.resolved) || 0,
      overdue: Number(s.overdue) || 0,
      tracked: Number(s.tracked) || 0,
      status_counts: (s.status_counts ?? []).map((x) => ({ status: String(x.status), count: Number(x.count) || 0 })),
      priority_counts: toNumberMap(s.priority_counts),
      technicians: (s.technicians ?? []).map((x) => ({ tech: x.tech ?? null, total: Number(x.total) || 0, closed: Number(x.closed) || 0 })),
      daily_created: toNumberMap(s.daily_created),
      products: {
        received: Number(p.received) || 0,
        under_repair: Number(p.under_repair) || 0,
        repaired: Number(p.repaired) || 0,
        cant_repair: Number(p.cant_repair) || 0,
        rma_stock: Number(p.rma_stock) || 0,
      },
      top_issues: (s.top_issues ?? []).map((x) => ({ issue: String(x.issue), count: Number(x.count) || 0 })),
    }
  },

  /** CRM figures; "this month" starts at `monthStart` (the viewer's local month start). */
  async crm(monthStart: string): Promise<DashboardCrm> {
    const { data, error } = await supabase.rpc('rma_dashboard_crm', { p_month_start: monthStart })
    if (error) throw error
    const s = (data ?? {}) as Partial<DashboardCrm>
    return {
      open_value: Number(s.open_value) || 0,
      open_count: Number(s.open_count) || 0,
      won_this_month: Number(s.won_this_month) || 0,
      leads_this_month: Number(s.leads_this_month) || 0,
      open_by_stage: (s.open_by_stage ?? []).map((x) => ({ stage: x.stage ?? null, count: Number(x.count) || 0, value: Number(x.value) || 0 })),
      won_by_rep: (s.won_by_rep ?? []).map((x) => ({ rep: x.rep ?? null, count: Number(x.count) || 0, value: Number(x.value) || 0 })),
    }
  },

  /** The newest tickets. */
  async recentTickets(limit: number): Promise<DashboardTicketRow[]> {
    const { data, error } = await supabase
      .from('rma_tickets')
      .select(TICKET_ROW_COLUMNS)
      .order('created_date', { ascending: false })
      .order('id', { ascending: true })
      .range(0, Math.max(0, limit - 1))
    if (error) throw error
    return (data ?? []) as DashboardTicketRow[]
  },

  /**
   * The first overdue tickets created since `since`, newest first: not resolved
   * and due before the viewer's local today (a ticket due today is not overdue
   * until the day ends). The count is the summary's `overdue`.
   */
  async overdueTickets(since: string | null, limit: number, today: string = todayLocalISO()): Promise<DashboardTicketRow[]> {
    let q = supabase
      .from('rma_tickets')
      .select(TICKET_ROW_COLUMNS)
      .or(`ticket_status.is.null,ticket_status.not.in.${RESOLVED_IN}`)
      .lt('due_date', today)
    if (since) q = q.gte('created_date', since)
    const { data, error } = await q
      .order('created_date', { ascending: false })
      .order('id', { ascending: true })
      .range(0, Math.max(0, limit - 1))
    if (error) throw error
    return (data ?? []) as DashboardTicketRow[]
  },

  /** A technician's open tickets — soonest due first, undated ones after — and how many there are. */
  async myOpenTickets(email: string, limit: number): Promise<{ data: DashboardTicketRow[]; count: number }> {
    const { data, error, count } = await supabase
      .from('rma_tickets')
      .select(TICKET_ROW_COLUMNS, { count: 'exact' })
      .eq('assigned_technician', email)
      .or(`ticket_status.is.null,ticket_status.not.in.${RESOLVED_IN}`)
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('created_date', { ascending: false })
      .order('id', { ascending: true })
      .range(0, Math.max(0, limit - 1))
    if (error) throw error
    return { data: (data ?? []) as DashboardTicketRow[], count: count ?? 0 }
  },
}
