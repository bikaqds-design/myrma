import { supabase } from '../client.js'
import { activities } from './activities.js'
import { assertUpdated, assertAllAffected } from './_assertUpdated.js'
import { fetchPage, fetchAllRows, chunksOf } from './_paging.js'
import type { PagedResult } from './types.js'
import { orIlike } from '../../lib/searchPattern.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface LeadRow {
  id: string
  lead_code: string | null
  full_name: string
  company_name: string | null
  phone: string | null
  email: string | null
  source: string
  status: string
  assigned_rep: string | null
  notes: string | null
  converted_at: string | null
  converted_customer_id: string | null
  converted_deal_id: string | null
  created_at: string
  created_by: string | null
  updated_at: string | null
}

// ── Paged reads (BUG-066) ─────────────────────────────────────────────────────
// The Leads screen loaded every lead and filtered, sorted and paged in the
// browser; past the Data API's 1 000-row cap the list, its tab counts and its
// Kanban were silently incomplete. These read `v_leads_list` (20260857), which
// is `leads` plus the Name-column sort key.

/** The status tabs: `active` is everything not converted or disqualified. */
export type LeadTab = 'all' | 'active' | 'converted' | 'disqualified'

export interface LeadFilters {
  tab?: LeadTab
  statuses?: string[]
  sources?: string[]
  reps?: string[]
  /** Name, company, email, phone or lead code. */
  search?: string
  /** A rep scoped to their own leads (RLS enforces it too). */
  ownerEmail?: string | null
}

/** Sortable columns → the column ordered on. The Name column sorts by what it shows. */
export const LEAD_SORT_COLUMNS: Record<string, string> = {
  full_name: 'sort_name',
  source: 'source',
  status: 'status',
  assigned_rep: 'assigned_rep',
  created_at: 'created_at',
}

export interface LeadSort {
  key: string
  direction: 'asc' | 'desc'
}

const LEAD_SEARCH_COLUMNS = ['full_name', 'company_name', 'email', 'phone', 'lead_code']

/** Values for PostgREST's `in.(…)` inside an `or`/`not`: each double-quoted. */
function inList(values: string[]): string {
  return `(${values.map((v) => `"${String(v).replace(/[\\"]/g, (c) => `\\${c}`)}"`).join(',')})`
}

interface Filterable<Q> {
  or(filters: string): Q
  eq(column: string, value: unknown): Q
  in(column: string, values: readonly unknown[]): Q
  not(column: string, operator: string, value: unknown): Q
}

export function applyLeadFilters<Q extends Filterable<Q>>(query: Q, f: LeadFilters): Q {
  let q = query
  if (f.ownerEmail) q = q.eq('assigned_rep', f.ownerEmail)
  if (f.tab === 'converted') q = q.eq('status', 'converted')
  else if (f.tab === 'disqualified') q = q.eq('status', 'disqualified')
  else if (f.tab === 'active') q = q.or('status.is.null,status.not.in.(converted,disqualified)')
  if (f.statuses?.length) q = q.in('status', f.statuses)
  if (f.sources?.length) q = q.in('source', f.sources)
  if (f.reps?.length) q = q.in('assigned_rep', f.reps)
  const search = f.search?.trim()
  // Another .or() is ANDed with the tab's by PostgREST.
  if (search) q = q.or(orIlike(LEAD_SEARCH_COLUMNS, search))
  return q
}

export function resolveLeadSort(sort?: LeadSort): { column: string; ascending: boolean } {
  const column = (sort && LEAD_SORT_COLUMNS[sort.key]) || 'created_at'
  const ascending = sort && LEAD_SORT_COLUMNS[sort.key] ? sort.direction === 'asc' : false
  return { column, ascending }
}

// ── Leads ─────────────────────────────────────────────────────────────────────
// Once converted_at is set, a lead is immutable except for notes — convert()
// is the only path that sets the converted_* fields. See data-model.md.

export const leads = {
  /** One page of leads, filtered and sorted in the database, with the exact number that match. */
  async listPage(filters: LeadFilters, sort: LeadSort | undefined, page: number, pageSize: number): Promise<PagedResult<LeadRow>> {
    const { column, ascending } = resolveLeadSort(sort)
    return fetchPage<LeadRow>((from, to) => {
      const base = supabase.from('v_leads_list').select('*', { count: 'exact' })
      return applyLeadFilters(base, filters)
        .order(column, { ascending, nullsFirst: ascending })
        .order('id', { ascending: true })
        .range(from, to)
    }, page, pageSize)
  },

  /** Every lead matching the filters, in the list's order — for an export. */
  async listAllMatching(filters: LeadFilters, sort?: LeadSort): Promise<LeadRow[]> {
    const { column, ascending } = resolveLeadSort(sort)
    return fetchAllRows<LeadRow>((from, to) => {
      const base = supabase.from('v_leads_list').select('*')
      return applyLeadFilters(base, filters)
        .order(column, { ascending, nullsFirst: ascending })
        .order('id', { ascending: true })
        .range(from, to)
    })
  },

  /**
   * One Kanban column: the first `limit` leads in `status` and how many there
   * are. The first column also collects leads whose status is not a known one,
   * as the whole-list board did.
   */
  async listColumn(
    status: string,
    knownStatuses: string[],
    filters: LeadFilters,
    sort: LeadSort | undefined,
    limit: number
  ): Promise<{ data: LeadRow[]; count: number }> {
    const { column, ascending } = resolveLeadSort(sort)
    const collectsUnknown = status === knownStatuses[0]
    const result = await fetchPage<LeadRow>((from, to) => {
      const base = supabase.from('v_leads_list').select('*', { count: 'exact' })
      const inColumn = collectsUnknown
        ? base.or(`status.eq.${status},status.is.null,status.not.in.${inList(knownStatuses)}`)
        : base.eq('status', status)
      return applyLeadFilters(inColumn, filters)
        .order(column, { ascending, nullsFirst: ascending })
        .order('id', { ascending: true })
        .range(from, to)
    }, 1, limit)
    return { data: result.data, count: result.count }
  },

  /** How many leads each status tab holds, for a rep's own leads or all. */
  async tabCounts(ownerEmail?: string | null): Promise<Record<LeadTab, number>> {
    const count = async (tab: LeadTab) => {
      const base = supabase.from('leads').select('id', { count: 'exact', head: true })
      const { count: n, error } = await applyLeadFilters(base, { tab, ownerEmail })
      if (error) throw error
      return n ?? 0
    }
    const [all, active, converted, disqualified] = await Promise.all([
      count('all'),
      count('active'),
      count('converted'),
      count('disqualified'),
    ])
    return { all, active, converted, disqualified }
  },

  /** Leads by id, in URL-safe chunks — the rows a selection export needs. */
  async getMany(ids: string[]): Promise<LeadRow[]> {
    const unique = [...new Set(ids.filter(Boolean))]
    const out: LeadRow[] = []
    for (const chunk of chunksOf(unique, 100)) {
      const { data, error } = await supabase.from('leads').select('*').in('id', chunk)
      if (error) throw error
      out.push(...((data ?? []) as LeadRow[]))
    }
    return out
  },

  async get(id: string): Promise<LeadRow> {
    const { data, error } = await supabase.from('leads').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(
    lead: Omit<
      LeadRow,
      'id' | 'created_at' | 'converted_at' | 'converted_customer_id' | 'converted_deal_id'
    >
  ): Promise<LeadRow> {
    const { data, error } = await supabase.from('leads').insert([lead]).select()
    if (error) throw error
    return data[0]
  },
  /**
   * Insert many leads in chunks rather than one request per row (BUG-045).
   *
   * The CSV importer ran `for (const lead of toImport) await db.leads.create(lead)`,
   * so a 2,000-row file made 2,000 sequential round trips — slow, and a failure
   * part-way left an unreported partial import. Chunked rather than one giant
   * statement so a large file does not exceed the request size limit.
   *
   * Returns what was inserted; throws on the first failing chunk, so the caller
   * can report how many rows landed before it stopped.
   */
  async bulkCreate(leads: Array<Partial<LeadRow>>, chunkSize = 200): Promise<LeadRow[]> {
    const created: LeadRow[] = []
    for (let i = 0; i < leads.length; i += chunkSize) {
      const chunk = leads.slice(i, i + chunkSize)
      const { data, error } = await supabase.from('leads').insert(chunk).select()
      if (error) {
        ;(error as { insertedBefore?: number }).insertedBefore = created.length
        throw error
      }
      created.push(...((data ?? []) as LeadRow[]))
    }
    return created
  },
  async update(id: string, lead: Partial<LeadRow>): Promise<LeadRow> {
    const { data: existing, error: fetchError } = await supabase
      .from('leads')
      .select('converted_at')
      .eq('id', id)
      .single()
    if (fetchError) throw fetchError
    if (existing.converted_at) {
      const touchesOtherFields = Object.keys(lead).some((key) => key !== 'notes')
      if (touchesOtherFields) {
        throw new Error('Converted leads are immutable except for notes')
      }
    }
    const { data, error } = await supabase.from('leads').update(lead).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Lead')
  },
  /**
   * updateStatus — change a lead's status and auto-log the transition to the
   * activities feed (Odoo-style field tracking). Used by the inline status
   * dropdown and the detail-page stepper. The status-immutability rule on
   * converted leads is enforced by update() above. The audit log is non-fatal:
   * a failed log never blocks the status change.
   */
  async updateStatus(id: string, newStatus: string, actorEmail: string | null): Promise<LeadRow> {
    const { data: current, error: fetchError } = await supabase
      .from('leads')
      .select('status')
      .eq('id', id)
      .single()
    if (fetchError) throw fetchError
    if (current.status === newStatus) return this.get(id)
    const updated = await this.update(id, { status: newStatus })
    try {
      await activities.logSystem('lead', id, `status_changed|${current.status}|${newStatus}`, actorEmail)
    } catch {
      /* non-fatal — status change already persisted */
    }
    return updated
  },
  async bulkDelete(ids: string[]): Promise<void> {
    if (!ids.length) return
    // Same polymorphic-parent problem as deals.bulkDelete: no foreign key
    // protects activities.related_id, so the logs have to go explicitly.
    await activities.deleteForRelated('lead', ids)
    const { data, error } = await supabase.from('leads').delete().in('id', ids).select('id')
    if (error) throw error
    assertAllAffected(data, ids, 'lead')
  },
  /**
   * bulkUpdate — apply status/source to many leads at once.
   *
   * Status transitions are auto-logged here, exactly as updateStatus() does for
   * a single lead. Without this the bulk path was a silent hole in the audit
   * trail: Sprint 2.5 Phase B promises "every status change auto-logs a
   * type:'log' activity", but the bulk action wrote none, so a lead's history
   * could show a transition *to* a status it was no longer in with nothing
   * explaining the change (found in manual QA 2026-08-08 — a lead sat at "New"
   * whose newest log entry read "changed to Disqualified").
   *
   * One log row per lead that actually changed; leads already on the target
   * status are skipped, matching updateStatus()'s no-op-if-same behaviour.
   * Logging is non-fatal — a failed log never rolls back a persisted change.
   */
  async bulkUpdate(
    ids: string[],
    fields: Partial<Pick<LeadRow, 'status' | 'source'>>,
    actorEmail: string | null = null
  ): Promise<void> {
    if (!ids.length) return
    // Mirror the single-row update() guard: block if any selected lead is
    // converted. `status` is selected too so the transition can be logged.
    const { data: existing, error: fetchErr } = await supabase
      .from('leads')
      .select('id, status, converted_at')
      .in('id', ids)
    if (fetchErr) throw fetchErr
    const converted = (existing ?? []).filter((r) => r.converted_at !== null)
    if (converted.length > 0) {
      throw new Error(`Cannot bulk-edit ${converted.length} converted lead(s)`)
    }
    const { data: updated, error } = await supabase.from('leads').update(fields).in('id', ids).select('id')
    if (error) throw error
    assertAllAffected(updated, ids, 'lead')

    if (fields.status) {
      const changed = (existing ?? []).filter((r) => r.status !== fields.status)
      await Promise.allSettled(
        changed.map((r) =>
          activities.logSystem(
            'lead',
            r.id,
            `status_changed|${r.status}|${fields.status}`,
            actorEmail
          )
        )
      )
    }
  },
  /**
   * Atomic conversion — calls the crm_convert_lead SECURITY DEFINER RPC
   * (supabase/migrations/20260626_crm_leads_convert_rpc.sql). See research.md
   * §1 for why this must be one DB transaction, not a client-side sequence.
   */
  async convert(
    leadId: string,
    dealInput: { title: string; pipelineId: string; value?: number },
    existingCustomerId?: string
  ): Promise<{ customer: { id: string }; deal: { id: string } }> {
    const { data, error } = await supabase.rpc('crm_convert_lead', {
      p_lead_id: leadId,
      p_deal_title: dealInput.title,
      p_pipeline_id: dealInput.pipelineId,
      p_deal_value: dealInput.value ?? null,
      p_existing_customer_id: existingCustomerId ?? null,
    })
    if (error) {
      if (error.code === 'PGRST202')
        throw new Error(
          'crm_convert_lead RPC not found. Run supabase/migrations/20260626_crm_leads_convert_rpc.sql first.'
        )
      throw error
    }
    const row = data?.[0]
    if (!row) throw new Error('Lead conversion did not return a result')
    return { customer: { id: row.customer_id }, deal: { id: row.deal_id } }
  },
}
