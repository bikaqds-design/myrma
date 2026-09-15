import { supabase } from '../client.js'
import type { TableResult } from './types.js'
import { captureException } from '../../lib/sentry.js'
import { assertUpdated, assertAffected, assertAllAffected } from './_assertUpdated.js'
import { fetchPage, fetchAllRows, chunksOf } from './_paging.js'
import type { PagedResult as ServerPage } from './types.js'
import { quoteOrValue } from '../../lib/searchPattern.js'
import { TICKET_STATUS_RESOLVED } from '../../lib/constants.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface TicketProductItem {
  product_name?: string | null
  serial_number?: string | null
  product_status?: string | null
  warranty_status?: string | null
  issue_description?: string | null
}

export interface RMATicketRow {
  id: string
  rma_number: string
  customer_name: string
  customer_id: string | null
  customer_email: string | null
  customer_phone: string | null
  ticket_status: string
  priority: string
  assigned_technician: string | null
  due_date: string | null
  general_description: string | null
  internal_notes: string | null
  accessories_received: string | null
  attachments: unknown[] | null
  products: TicketProductItem[] | null
  carrier: string | null
  tracking_number: string | null
  shipping_label_url: string | null
  created_date: string
  updated_date: string | null
  created_by: string | null
}

export interface TicketActivityRow {
  id: string
  ticket_id: string
  action_type: string
  details: string | null
  user_email: string | null
  created_date: string
}

export interface TicketCommentRow {
  id: string
  ticket_id: string
  comment_text: string
  user_email: string
  author_name: string
  is_internal: boolean
  parent_comment_id: string | null
  attachments: unknown[]
  is_customer_comment: boolean
  created_date: string
}

export interface PagedResult<T> {
  data: T[]
  count: number
  page: number
  pageSize: number
  totalPages: number
}

// ── Server-side list (BUG-066) ────────────────────────────────────────────────

/**
 * What the RMA Tickets list is narrowed by. All given fields must hold (AND).
 *
 * `search` goes to rma_tickets_matching() (20260852), because it also matches
 * product serials and names inside the `products` jsonb array, which a
 * PostgREST filter cannot reach. Everything else is a plain column filter.
 */
export interface TicketFilters {
  search?: string
  status?: string
  priority?: string
  /** Exact assigned_technician. */
  assigned?: string
  /** Exact customer_name. */
  customer?: string
  /** Past due and not resolved. */
  overdue?: boolean
}

export const TICKET_SORT_COLUMNS = [
  'rma_number',
  'customer_name',
  'ticket_status',
  'priority',
  'assigned_technician',
  'created_date',
  'due_date',
  'updated_date',
] as const
export type TicketSortColumn = (typeof TICKET_SORT_COLUMNS)[number]

export interface TicketSort {
  column: string
  ascending: boolean
}

export interface TicketPageQuery extends TicketFilters {
  /** 1-based. */
  page: number
  pageSize: number
  sort?: TicketSort
}

/** An unknown sort column falls back to newest first; the name reaches the URL. */
export function resolveTicketSort(sort?: TicketSort): { column: TicketSortColumn; ascending: boolean } {
  const known = (TICKET_SORT_COLUMNS as readonly string[]).includes(sort?.column ?? '')
  return known
    ? { column: sort!.column as TicketSortColumn, ascending: Boolean(sort!.ascending) }
    : { column: 'created_date', ascending: false }
}

/**
 * Today's date in UTC, as YYYY-MM-DD.
 *
 * The old in-browser rule was `new Date(due_date) < now`. A date-only value
 * parses as UTC midnight, so that is true exactly when due_date is today or
 * earlier in UTC — which `due_date <= todayUtc` reproduces.
 */
export function overdueCutoff(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

interface TicketFilterable<Q> {
  eq(column: string, value: unknown): Q
  lte(column: string, value: unknown): Q
  or(filters: string): Q
}

function applyTicketFilters<Q extends TicketFilterable<Q>>(query: Q, filters: TicketFilters, now?: Date): Q {
  let q = query
  if (filters.status) q = q.eq('ticket_status', filters.status)
  if (filters.priority) q = q.eq('priority', filters.priority)
  if (filters.assigned) q = q.eq('assigned_technician', filters.assigned)
  if (filters.customer) q = q.eq('customer_name', filters.customer)
  if (filters.overdue) {
    const resolved = TICKET_STATUS_RESOLVED.map(quoteOrValue).join(',')
    // A ticket with no status is not resolved; `not in` alone would drop it.
    q = q.lte('due_date', overdueCutoff(now)).or(`ticket_status.is.null,ticket_status.not.in.(${resolved})`)
  }
  return q
}

/** The matching-tickets function, with an exact count when asked for. */
function matching(filters: TicketFilters, count: boolean) {
  const term = filters.search?.trim() || null
  return supabase.rpc('rma_tickets_matching', { p_term: term }, count ? { count: 'exact' } : {})
}

// ── RMA Tickets ───────────────────────────────────────────────────────────────

export const rmaTickets = {
  /** One page of tickets, filtered and sorted in the database, with the exact number that match. */
  async listPage(query: TicketPageQuery): Promise<ServerPage<RMATicketRow>> {
    const { column, ascending } = resolveTicketSort(query.sort)
    return fetchPage<RMATicketRow>(
      (from, to) => {
        const base = matching(query, true)
        return applyTicketFilters(base, query)
          .order(column, { ascending, nullsFirst: ascending })
          .order('id', { ascending: true })
          .range(from, to)
      },
      query.page,
      query.pageSize
    )
  },

  /** Every ticket matching the filters, in the list's order. For export. */
  async listAllMatching(filters: TicketFilters = {}, sort?: TicketSort): Promise<RMATicketRow[]> {
    const { column, ascending } = resolveTicketSort(sort)
    return fetchAllRows<RMATicketRow>((from, to) => {
      const base = matching(filters, false)
      return applyTicketFilters(base, filters)
        .order(column, { ascending, nullsFirst: ascending })
        .order('id', { ascending: true })
        .range(from, to)
    })
  },

  /**
   * One Kanban column: the first `limit` tickets with this status under the
   * filters, and how many there are in all — so the column header is a real
   * count even when only some cards are loaded.
   */
  async listColumn(
    status: string,
    filters: TicketFilters = {},
    limit = 50
  ): Promise<{ data: RMATicketRow[]; count: number }> {
    const page = await fetchPage<RMATicketRow>(
      (from, to) => {
        const base = matching({ ...filters, status }, true)
        return applyTicketFilters(base, { ...filters, status })
          .order('created_date', { ascending: false, nullsFirst: false })
          .order('id', { ascending: true })
          .range(from, to)
      },
      1,
      limit
    )
    return { data: page.data, count: page.count }
  },

  /** Statuses and technicians in use, for the filters and Kanban columns. */
  async filterOptions(): Promise<{ statuses: string[]; technicians: string[] }> {
    const { data, error } = await supabase.rpc('rma_ticket_filter_options')
    if (error) throw error
    const opts = (data ?? {}) as { statuses?: string[]; technicians?: string[] }
    return { statuses: opts.statuses ?? [], technicians: opts.technicians ?? [] }
  },

  /** Customer names on tickets containing `term`, for the customer filter. */
  async customerNames(term = '', limit = 20): Promise<string[]> {
    const { data, error } = await supabase.rpc('rma_ticket_customer_names', { p_term: term, p_limit: limit })
    if (error) throw error
    return ((data ?? []) as unknown[]).map(String)
  },

  /** The RMA number a ticket saved now would get. A preview; the insert trigger assigns the real one. */
  async peekNextNumber(): Promise<string | null> {
    const { data, error } = await supabase.rpc('rma_peek_next_ticket_number')
    if (error) throw error
    return typeof data === 'string' ? data : null
  },

  /** How many tickets exist, without reading any. */
  async count(): Promise<number> {
    const { count, error } = await supabase.from('rma_tickets').select('id', { count: 'exact', head: true })
    if (error) throw error
    return count ?? 0
  },

  /**
   * Tickets due on a day in [fromDate, toDate] (inclusive 'YYYY-MM-DD'), for one
   * Tech Calendar week, optionally one technician's. Every row in the range.
   */
  async listDueBetween(fromDate: string, toDate: string, technician?: string | null): Promise<RMATicketRow[]> {
    return fetchAllRows<RMATicketRow>((from, to) => {
      let q = supabase.from('rma_tickets').select('*').gte('due_date', fromDate).lte('due_date', toDate)
      if (technician) q = q.eq('assigned_technician', technician)
      return q.order('due_date', { ascending: true }).order('id', { ascending: true }).range(from, to)
    })
  },

  /**
   * Open tickets with no due date — the calendar's "unscheduled" panel: the
   * newest `limit` and how many there are.
   */
  async listUnscheduled(technician: string | null | undefined, limit: number): Promise<{ data: RMATicketRow[]; count: number }> {
    const result = await fetchPage<RMATicketRow>((from, to) => {
      let q = supabase
        .from('rma_tickets')
        .select('*', { count: 'exact' })
        .is('due_date', null)
        .not('ticket_status', 'in', '("Completed","Cancelled")')
      if (technician) q = q.eq('assigned_technician', technician)
      return q.order('created_date', { ascending: false }).order('id', { ascending: true }).range(from, to)
    }, 1, limit)
    return { data: result.data, count: result.count }
  },

  /**
   * @deprecated Loads the whole table, and the Data API returns at most 1 000
   * rows, so past that it is silently incomplete (BUG-066). Still used by
   * screens not yet moved to server-side paging; do not add callers.
   */
  async get(id: string): Promise<RMATicketRow> {
    const { data, error } = await supabase.from('rma_tickets').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(ticket: Partial<RMATicketRow>): Promise<RMATicketRow | undefined> {
    const { data, error } = await supabase.from('rma_tickets').insert([ticket]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, ticket: Partial<RMATicketRow>): Promise<RMATicketRow | undefined> {
    const { data, error } = await supabase.from('rma_tickets').update(ticket).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Ticket')
  },
  async delete(id: string): Promise<void> {
    // Cascade is enforced by ON DELETE CASCADE FKs on inventory_units,
    // ticket_comments, ticket_activity → rma_tickets (migration 20260528).
    const { data, error } = await supabase.from('rma_tickets').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Ticket')
  },
  // One statement instead of N, so a bulk cleanup either applies or fails as a
  // unit rather than part-way through. Data Cleanup previously fanned out N
  // individual deletes and did not await them (BUG-012).
  async bulkDelete(ids: string[]): Promise<void> {
    if (!ids.length) return
    // In chunks: one request naming thousands of ids overflows the URL, and the
    // deleted rows it returns would be capped at 1 000. (BUG-066.)
    for (const chunk of chunksOf(ids, 100)) {
      const { data, error } = await supabase.from('rma_tickets').delete().in('id', chunk).select('id')
      if (error) throw error
      assertAllAffected(data, chunk, 'ticket')
    }
  },
  /**
   * Ids of tickets in `status` last updated before `before` — Data Cleanup's
   * stale tickets, every one of them. (BUG-066.)
   */
  async staleIds(status: string, before: string): Promise<string[]> {
    const rows = await fetchAllRows<{ id: string }>((from, to) =>
      supabase
        .from('rma_tickets')
        .select('id')
        .eq('ticket_status', status)
        .not('updated_date', 'is', null)
        .lt('updated_date', before)
        .order('id', { ascending: true })
        .range(from, to)
    )
    return rows.map((r) => r.id)
  },
}

// ── Ticket Activity ───────────────────────────────────────────────────────────

export const ticketActivity = {
  /** A ticket's whole history — every row, not the first 1 000. (BUG-066.) */
  async list(ticketId: string): Promise<TicketActivityRow[]> {
    return fetchAllRows<TicketActivityRow>((from, to) =>
      supabase
        .from('ticket_activity')
        .select('*')
        .eq('ticket_id', ticketId)
        .order('created_date', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
    )
  },
  async create(activityData: Partial<TicketActivityRow>): Promise<TicketActivityRow | undefined> {
    const { data, error } = await supabase.from('ticket_activity').insert([activityData]).select()
    if (error) throw error
    return data?.[0]
  },
  async log(ticketId: string, actionType: string, details: string | null, userEmail: string | null): Promise<TicketActivityRow | undefined> {
    const { data, error } = await supabase
      .from('ticket_activity')
      .insert([{ ticket_id: ticketId, action_type: actionType, details, user_email: userEmail, created_date: new Date().toISOString() }])
      .select()
    if (error) {
      captureException(error, { context: 'ticketActivity.log', ticketId, actionType })
      return undefined
    }
    return data?.[0]
  },
}

// ── Ticket Comments ───────────────────────────────────────────────────────────

export const ticketComments = {
  /** A ticket's whole comment thread — every row, not the first 1 000. (BUG-066.) */
  async list(ticketId: string): Promise<TableResult<TicketCommentRow[]>> {
    try {
      const data = await fetchAllRows<TicketCommentRow>((from, to) =>
        supabase
          .from('ticket_comments')
          .select('*')
          .eq('ticket_id', ticketId)
          .order('created_date', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)
      )
      return { missing: false, data }
    } catch (error) {
      if ((error as { code?: string })?.code === '42P01') return { missing: true, data: [] }
      throw error
    }
  },
  async create(dto: {
    ticketId: string
    commentText: string
    authorEmail: string
    authorName?: string
    isInternal?: boolean
    parentCommentId?: string | null
    attachments?: unknown[]
    isCustomerComment?: boolean
  }): Promise<TicketCommentRow | undefined> {
    const {
      ticketId,
      commentText,
      authorEmail,
      authorName,
      isInternal = false,
      parentCommentId = null,
      attachments = [],
      isCustomerComment = false,
    } = dto
    const { data, error } = await supabase
      .from('ticket_comments')
      .insert([
        {
          ticket_id: ticketId,
          comment_text: commentText,
          user_email: authorEmail,
          author_name: authorName || authorEmail,
          is_internal: isInternal,
          parent_comment_id: parentCommentId || null,
          attachments: attachments || [],
          is_customer_comment: isCustomerComment,
          created_date: new Date().toISOString(),
        },
      ])
      .select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    const { data, error } = await supabase.from('ticket_comments').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Comment')
  },
}

// ── Public Tracker ────────────────────────────────────────────────────────────
// All calls go through the public-track Edge Function.
// Anon role has NO direct DB access; the Edge Function uses service_role
// server-side and enforces rate limiting + input validation.

export const rmaTracker = {
  async getTicketByRmaNumber(rmaNumber: string): Promise<unknown | null> {
    try {
      const { data, error } = await supabase.functions.invoke('public-track', {
        body: { action: 'lookup', rmaNumber: rmaNumber.trim() },
      })
      if (error) return null
      if (data?.error) return null
      return data?.ticket || null
    } catch (err) {
      captureException(err, { context: 'rmaTracker.getTicketByRmaNumber' })
      return null
    }
  },
  /** A ticket's public comments. The RMA number is required with the id (BUG-023). */
  async getPublicComments(ticketId: string, rmaNumber: string): Promise<unknown[]> {
    try {
      const { data, error } = await supabase.functions.invoke('public-track', {
        body: { action: 'comments', ticketId, rmaNumber },
      })
      if (error || data?.error) return []
      return data?.comments || []
    } catch (err) {
      captureException(err, { context: 'rmaTracker.getPublicComments' })
      return []
    }
  },
  /** Post a customer comment. The RMA number is required with the id (BUG-023). */
  async addComment(
    ticketId: string,
    rmaNumber: string,
    authorName: string,
    authorEmail: string,
    commentText: string,
    parentCommentId: string | null = null,
    attachments: unknown[] = []
  ): Promise<unknown> {
    const { data, error } = await supabase.functions.invoke('public-track', {
      body: {
        action: 'addComment',
        comment: { ticketId, rmaNumber, authorName, authorEmail, commentText, parentCommentId, attachments: attachments || [] },
      },
    })
    if (error) throw new Error(error.message || 'Failed to send message')
    if (data?.error) throw new Error(data.error)
    return data?.comment
  },
}

// ── Device Serial History ─────────────────────────────────────────────────────

export const serialHistory = {
  async getBySerial(serialNumber: string): Promise<Partial<RMATicketRow>[]> {
    if (!serialNumber?.trim()) return []
    const { data, error } = await supabase
      .rpc('rma_search_by_serial', { serial: serialNumber.trim() })
    if (error) {
      captureException(error, { context: 'serialHistory.getBySerial' })
      return []
    }
    return data || []
  },
}

// ── Ticket Resolutions ────────────────────────────────────────────────────────

export interface TicketResolutionRow {
  id: string
  ticket_id: string
  type: 'replacement' | 'exchange' | 'credit_note' | 'refund'
  replacement_product_name: string | null
  replacement_serial: string | null
  amount: number | null
  currency: string | null
  reason: string | null
  reference_number: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export const ticketResolutions = {
  async get(ticketId: string): Promise<TicketResolutionRow | null> {
    const { data, error } = await supabase
      .from('ticket_resolutions')
      .select('*')
      .eq('ticket_id', ticketId)
      .maybeSingle()
    if (error?.code === '42P01') return null
    if (error) throw error
    return data
  },

  async upsert(ticketId: string, payload: Omit<TicketResolutionRow, 'id' | 'ticket_id' | 'created_at' | 'updated_at'>): Promise<TicketResolutionRow> {
    const { data, error } = await supabase
      .from('ticket_resolutions')
      .upsert({ ...payload, ticket_id: ticketId, updated_at: new Date().toISOString() }, { onConflict: 'ticket_id' })
      .select()
      .single()
    if (error) throw error
    return data
  },

  async remove(id: string): Promise<void> {
    const { data, error } = await supabase.from('ticket_resolutions').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Resolution')
  },
}
