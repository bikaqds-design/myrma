import { supabase } from '../client.js'
import { assertUpdated, assertAffected } from './_assertUpdated.js'
import { fetchPage, fetchAllRows, chunksOf } from './_paging.js'
import type { PagedResult } from './types.js'
import { orIlike } from '../../lib/searchPattern.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface ActivityAttachment {
  name: string
  url: string
  path: string
  size: number
  type: string
}

export interface ActivityRow {
  id: string
  related_type: 'lead' | 'deal' | 'customer' | 'contact' | 'purchase_order' | 'vendor_invoice'
  related_id: string
  type: string
  title: string
  due_date: string | null
  completed_at: string | null
  assigned_rep: string | null
  outcome_notes: string | null
  attachments: ActivityAttachment[]
  parent_id: string | null
  created_at: string
  created_by: string | null
}

// Fields the caller supplies on create — id/timestamps/completed_at are
// server-managed, attachments defaults to [], parent_id defaults to null
// (top-level entry; set it to thread a reply under an existing entry).
export type ActivityCreateInput = Omit<
  ActivityRow,
  'id' | 'created_at' | 'completed_at' | 'attachments' | 'parent_id'
> & { attachments?: ActivityAttachment[]; parent_id?: string | null }

// ── Paged reads (BUG-066) ─────────────────────────────────────────────────────
// The Activities page loaded every planned activity, every completed one, every
// lead and every deal, and named, searched, filtered, sorted, counted and paged
// in the browser — past the Data API's 1 000-row cap, part of the work shown as
// all of it. These read `v_activities_list` (20260859), which carries what the
// page shows for each row.

/** An activity as the Activities page lists it. */
export interface ActivityListRow extends ActivityRow {
  /** The document type for an approval, otherwise related_type. */
  source: string
  customer_name: string | null
  /** Lead / deal code, or the approval's document code. */
  source_code: string | null
  /** Whether the lead or deal the row links to exists (and is visible). */
  related_exists: boolean
}

/**
 * The page's tabs. `all`, `today` and `overdue` are planned work (open, dated,
 * not a system log); `logs` is completed work. Today and overdue compare the
 * due date's UTC calendar day with today's, as the page always has.
 */
export type ActivityTab = 'all' | 'today' | 'overdue' | 'logs'

export interface ActivityFilters {
  tab?: ActivityTab
  type?: string
  assignee?: string
  source?: string
  /** Title, customer name, assignee or record code. */
  search?: string
  /** A rep scoped to their own activities (RLS enforces it too). */
  ownerEmail?: string | null
}

export interface ActivitySort {
  key: string
  direction: 'asc' | 'desc'
}

const ACTIVITY_SEARCH_COLUMNS = ['title', 'customer_name', 'assigned_rep', 'source_code']

/** Midnight UTC today and tomorrow, as ISO strings. */
export function utcDayBounds(now: Date = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { start: start.toISOString(), end: end.toISOString() }
}

interface ActivityFilterable<Q> {
  eq(column: string, value: unknown): Q
  neq(column: string, value: unknown): Q
  is(column: string, value: null): Q
  not(column: string, operator: string, value: unknown): Q
  gte(column: string, value: unknown): Q
  lt(column: string, value: unknown): Q
  or(filters: string): Q
}

export function applyActivityFilters<Q extends ActivityFilterable<Q>>(query: Q, f: ActivityFilters, now: Date = new Date()): Q {
  let q = query.neq('type', 'log')
  if (f.tab === 'logs') {
    q = q.not('completed_at', 'is', null)
  } else {
    q = q.is('completed_at', null).not('due_date', 'is', null)
    const { start, end } = utcDayBounds(now)
    if (f.tab === 'today') q = q.gte('due_date', start).lt('due_date', end)
    else if (f.tab === 'overdue') q = q.lt('due_date', start)
  }
  if (f.ownerEmail) q = q.eq('assigned_rep', f.ownerEmail)
  if (f.type) q = q.eq('type', f.type)
  if (f.assignee) q = q.eq('assigned_rep', f.assignee)
  if (f.source) q = q.eq('source', f.source)
  const search = f.search?.trim()
  if (search) q = q.or(orIlike(ACTIVITY_SEARCH_COLUMNS, search))
  return q
}

/**
 * Sortable columns → the column ordered on. The date column is the due date,
 * or the completion date on the logs tab. A row with no customer sorts after
 * every name, as "—" did.
 */
export function resolveActivitySort(sort: ActivitySort | undefined, tab?: ActivityTab): { column: string; ascending: boolean; nullsFirst: boolean } {
  const ascending = sort ? sort.direction === 'asc' : true
  switch (sort?.key) {
    case 'related_type':
    case 'assigned_rep':
    case 'created_at':
      return { column: sort.key, ascending, nullsFirst: ascending }
    case 'title':
      return { column: 'title_sort', ascending, nullsFirst: ascending }
    case 'customer':
      return { column: 'customer_sort', ascending, nullsFirst: !ascending }
    default:
      return { column: tab === 'logs' ? 'completed_at' : 'due_date', ascending: sort?.key === 'due_date' ? ascending : true, nullsFirst: ascending }
  }
}

// ── Activities ────────────────────────────────────────────────────────────────
// related_id is polymorphic — no DB-level FK is possible across 4 different
// target tables, so create() verifies the referenced row exists before
// insert. See data-model.md.

const RELATED_TABLE: Record<ActivityRow['related_type'], string> = {
  lead: 'leads',
  deal: 'deals',
  customer: 'customers',
  contact: 'contacts',
  purchase_order: 'purchase_orders',
  vendor_invoice: 'vendor_invoices',
}

async function assertRelatedExists(
  relatedType: ActivityRow['related_type'],
  relatedId: string
): Promise<void> {
  const table = RELATED_TABLE[relatedType]
  const { data, error } = await supabase.from(table).select('id').eq('id', relatedId).maybeSingle()
  if (error) throw error
  if (!data) throw new Error(`No ${relatedType} found with id ${relatedId}`)
}

export const activities = {
  /** One page of the Activities list, filtered and sorted in the database, with the exact number that match. */
  async listPage(
    filters: ActivityFilters,
    sort: ActivitySort | undefined,
    page: number,
    pageSize: number,
    now: Date = new Date()
  ): Promise<PagedResult<ActivityListRow>> {
    const { column, ascending, nullsFirst } = resolveActivitySort(sort, filters.tab)
    return fetchPage<ActivityListRow>((from, to) => {
      const base = supabase.from('v_activities_list').select('*', { count: 'exact' })
      return applyActivityFilters(base, filters, now)
        .order(column, { ascending, nullsFirst })
        .order('id', { ascending: true })
        .range(from, to)
    }, page, pageSize)
  },

  /** How many activities each tab holds, for a rep's own work or everyone's. */
  async tabCounts(ownerEmail?: string | null, now: Date = new Date()): Promise<Record<ActivityTab, number>> {
    const count = async (tab: ActivityTab) => {
      const base = supabase.from('activities').select('id', { count: 'exact', head: true })
      const { count: n, error } = await applyActivityFilters(base, { tab, ownerEmail }, now)
      if (error) throw error
      return n ?? 0
    }
    const [all, today, overdue, logs] = await Promise.all([count('all'), count('today'), count('overdue'), count('logs')])
    return { all, today, overdue, logs }
  },

  /** The assignees of planned (or, on the logs tab, completed) activities, for the filter. */
  async assignees(completed: boolean, ownerEmail?: string | null): Promise<string[]> {
    const { data, error } = await supabase.rpc('rma_activity_assignees', {
      p_completed: completed,
      p_owner: ownerEmail || null,
    })
    if (error) throw error
    return (data ?? []) as string[]
  },

  /** How many open activities are past due — the sidebar badge. RLS scopes it. */
  async countOverdue(now: Date = new Date()): Promise<number> {
    const { count, error } = await supabase
      .from('activities')
      .select('id', { count: 'exact', head: true })
      .lt('due_date', now.toISOString())
      .is('completed_at', null)
    if (error) throw error
    return count ?? 0
  },

  /**
   * Planned activities due in [from, to) — one Tech Calendar week — optionally
   * for one assignee. Every row in the range, however many.
   */
  async listPlannedBetween(from: string, to: string, assignee?: string | null): Promise<ActivityRow[]> {
    return fetchAllRows<ActivityRow>((rangeFrom, rangeTo) => {
      let q = supabase
        .from('activities')
        .select('*')
        .is('completed_at', null)
        .neq('type', 'log')
        .gte('due_date', from)
        .lt('due_date', to)
      if (assignee) q = q.eq('assigned_rep', assignee)
      return q.order('due_date', { ascending: true }).order('id', { ascending: true }).range(rangeFrom, rangeTo)
    })
  },

  /** Ticket technicians and reps with planned activities, for the Tech Calendar's picker. */
  async calendarAssignees(): Promise<string[]> {
    const { data, error } = await supabase.rpc('rma_calendar_assignees')
    if (error) throw error
    return (data ?? []) as string[]
  },

  // Bulk variant for board/list views that need open-activity state (overdue/
  // today/planned) for many records at once without one query per card.
  async listForRelated(
    relatedType: ActivityRow['related_type'],
    relatedIds: string[]
  ): Promise<ActivityRow[]> {
    // Ids go into the URL, so they are sent 100 at a time, and each chunk's
    // activities are read in full rather than up to the Data API's row cap.
    // (BUG-066.)
    const unique = [...new Set(relatedIds.filter(Boolean))]
    const out: ActivityRow[] = []
    for (const chunk of chunksOf(unique, 100)) {
      const rows = await fetchAllRows<ActivityRow>((from, to) =>
        supabase
          .from('activities')
          .select('*')
          .eq('related_type', relatedType)
          .in('related_id', chunk)
          .is('completed_at', null)
          .order('id', { ascending: true })
          .range(from, to)
      )
      out.push(...rows)
    }
    return out
  },
  /** One record's whole history (chatter, comments, approvals) — every row, not the first 1 000. */
  async list(
    relatedType: ActivityRow['related_type'],
    relatedId: string
  ): Promise<ActivityRow[]> {
    return fetchAllRows<ActivityRow>((from, to) =>
      supabase
        .from('activities')
        .select('*')
        .eq('related_type', relatedType)
        .eq('related_id', relatedId)
        .order('due_date', { ascending: true, nullsFirst: false })
        .order('id', { ascending: true })
        .range(from, to)
    )
  },
  async create(activity: ActivityCreateInput): Promise<ActivityRow> {
    await assertRelatedExists(activity.related_type, activity.related_id)
    const row = { attachments: [], parent_id: null, ...activity }
    const { data, error } = await supabase.from('activities').insert([row]).select()
    if (error) throw error
    return data[0]
  },
  /**
   * logSystem — record a system-generated audit entry (type 'log') such as a
   * status change or conversion. The message is stored pipe-encoded
   * (e.g. 'status_changed|new|qualified') so the UI can translate it at render
   * time — see ActivityChatter.jsx renderLogTitle(). Non-fatal by contract: callers
   * wrap in try/catch so a failed log never blocks the primary mutation.
   */
  async logSystem(
    relatedType: ActivityRow['related_type'],
    relatedId: string,
    message: string,
    actorEmail: string | null
  ): Promise<ActivityRow> {
    return this.create({
      related_type: relatedType,
      related_id: relatedId,
      type: 'log',
      title: message,
      due_date: null,
      assigned_rep: null,
      outcome_notes: null,
      created_by: actorEmail,
    })
  },
  async complete(id: string, outcomeNotes?: string): Promise<ActivityRow> {
    const updates: Partial<ActivityRow> = { completed_at: new Date().toISOString() }
    if (outcomeNotes !== undefined) updates.outcome_notes = outcomeNotes
    const { data, error } = await supabase.from('activities').update(updates).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Activity')
  },
  // reopen — undo a Mark Done, moving the activity back to Planned.
  async reopen(id: string): Promise<ActivityRow> {
    const { data, error } = await supabase
      .from('activities')
      .update({ completed_at: null })
      .eq('id', id)
      .select()
    if (error) throw error
    assertAffected(data, 'Activity')
    return data[0]
  },
  // reschedule — change a planned activity's due date.
  async reschedule(id: string, dueDate: string): Promise<ActivityRow> {
    const { data, error } = await supabase
      .from('activities')
      .update({ due_date: dueDate })
      .eq('id', id)
      .select()
    if (error) throw error
    assertAffected(data, 'Activity')
    return data[0]
  },
  async delete(id: string): Promise<void> {
    const { data, error } = await supabase.from('activities').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Activity')
  },
  /**
   * deleteForRelated — remove every activity belonging to deleted parents.
   *
   * `related_id` is polymorphic (it points at a deal, lead, customer, purchase
   * order or vendor invoice depending on `related_type`), so Postgres cannot
   * put a foreign key on it and nothing stops a parent being deleted out from
   * under its own history. Deleting a deal used to leave its stage-change and
   * won/lost logs behind as rows pointing at nothing: invisible in the UI,
   * counted by every `select * from activities`, and impossible to attribute.
   *
   * Callers must invoke this *before* deleting the parents, while the ids are
   * still known.
   */
  async deleteForRelated(relatedType: ActivityRow['related_type'], ids: string[]): Promise<void> {
    if (!ids.length) return
    const { error } = await supabase
      .from('activities')
      .delete()
      .eq('related_type', relatedType)
      .in('related_id', ids)
    if (error) throw error
  },
  // RLS already scopes results to what the caller can see (manager+ sees
  // all, sales_rep sees only their own assigned_rep rows).
  // The first `limit` open activities past due, oldest first — the Dashboard's
  // list. How many there are is countOverdue(). (BUG-066.)
  async listOverdueFirst(limit: number, now: Date = new Date()): Promise<ActivityRow[]> {
    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .lt('due_date', now.toISOString())
      .is('completed_at', null)
      .order('due_date', { ascending: true })
      .order('id', { ascending: true })
      .range(0, Math.max(0, limit - 1))
    if (error) throw error
    return (data ?? []) as ActivityRow[]
  },
}
