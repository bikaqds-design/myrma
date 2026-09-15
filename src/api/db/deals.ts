import { supabase } from '../client.js'
import { activities } from './activities.js'
import type { PipelineStage } from './pipelines.js'
import { assertUpdated, assertAffected, assertAllAffected } from './_assertUpdated.js'
import { fetchPage, fetchAllRows, chunksOf } from './_paging.js'
import type { PagedResult } from './types.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface DealProductLine {
  product_id: string
  product_name: string
  qty: number
  unit_price: number
}

export interface DealRow {
  id: string
  deal_code: string | null
  title: string
  customer_id: string
  contact_id: string | null
  pipeline_id: string
  stage: string
  value: number | null
  probability: number
  expected_close_date: string | null
  assigned_rep: string | null
  product_lines: DealProductLine[]
  status: 'open' | 'won' | 'lost'
  lost_reason: string | null
  won_at: string | null
  lost_at: string | null
  notes: string | null
  created_at: string
  created_by: string | null
  updated_at: string | null
}

// ── Paged reads (BUG-066) ─────────────────────────────────────────────────────
// The Pipeline loaded every deal in a pipeline, and every open activity on
// them, and filtered, sorted, paged, grouped and summed in the browser; past the
// Data API's 1 000-row cap every view was silently incomplete. These read
// through 20260858: `rma_deals_matching` (the search, over `v_deals_list`) for
// rows, and the bucket functions for anything that is a count or a sum.

/** A deal as the Pipeline lists it: the row plus its customer's name and its stage's position. */
export interface DealListRow extends DealRow {
  customer_name: string | null
  stage_order: number | null
}

export interface DealFilters {
  pipelineId: string
  /** Title, deal code, rep or customer name. */
  search?: string
  stages?: string[]
  reps?: string[]
  /** A rep scoped to their own deals (RLS enforces it too). */
  ownerEmail?: string | null
  /** Open deals only (the Activity view). */
  openOnly?: boolean
}

/** Sortable list columns → the column ordered on. Each sorts by what the column shows. */
export const DEAL_SORT_COLUMNS: Record<string, string> = {
  title: 'title_sort',
  customer_id: 'customer_sort',
  stage: 'stage_order',
  value: 'value_sort',
  assigned_rep: 'assigned_rep',
  created_at: 'created_at',
}

export interface DealSort {
  key: string
  direction: 'asc' | 'desc'
}

export function resolveDealSort(sort?: DealSort): { column: string; ascending: boolean } {
  const known = !!(sort && DEAL_SORT_COLUMNS[sort.key])
  return {
    column: known ? DEAL_SORT_COLUMNS[sort!.key] : 'created_at',
    ascending: known ? sort!.direction === 'asc' : false,
  }
}

interface Filterable<Q> {
  eq(column: string, value: unknown): Q
  in(column: string, values: readonly unknown[]): Q
}

/** The column filters, on deals or on any bucket function's rows (they carry stage and assigned_rep). */
export function applyDealFilters<Q extends Filterable<Q>>(query: Q, f: Omit<DealFilters, 'pipelineId' | 'search'>): Q {
  let q = query
  if (f.ownerEmail) q = q.eq('assigned_rep', f.ownerEmail)
  if (f.stages?.length) q = q.in('stage', f.stages)
  if (f.reps?.length) q = q.in('assigned_rep', f.reps)
  if (f.openOnly) q = q.eq('status', 'open')
  return q
}

function searchArgs(f: DealFilters) {
  return { p_pipeline_id: f.pipelineId, p_term: f.search?.trim() ?? '' }
}

/** Deal count and value for one combination of stage, rep, status and months. */
export interface DealBucket {
  stage: string
  assigned_rep: string | null
  status: DealRow['status']
  /** 'YYYY-MM' in the viewer's time zone. */
  created_month: string | null
  /** 'YYYY-MM' of expected_close_date. */
  close_month: string | null
  deal_count: number
  value_sum: number
}

export interface DealActivityValue {
  stage: string
  assigned_rep: string | null
  activity_state: 'overdue' | 'today' | 'planned'
  deal_count: number
  value_sum: number
}

export interface DealActivityTypeCount {
  stage: string
  assigned_rep: string | null
  activity_type: string
  activity_count: number
  done_count: number
}

function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

// ── Deals ─────────────────────────────────────────────────────────────────────
// stage is validated against the deal's pipeline's stages array on every
// write path that can set it (create, update, moveStage) — not just
// moveStage — see research.md §4 and FR-011. product_lines is always read/
// written as an array, never spread into a keyed object (CONSTITUTION.md §7.5a).

async function getPipelineStages(pipelineId: string): Promise<PipelineStage[]> {
  const { data, error } = await supabase
    .from('pipelines')
    .select('stages')
    .eq('id', pipelineId)
    .single()
  if (error) throw error
  return data.stages
}

async function getDealPipelineId(dealId: string): Promise<string> {
  const { data, error } = await supabase
    .from('deals')
    .select('pipeline_id')
    .eq('id', dealId)
    .single()
  if (error) throw error
  return data.pipeline_id
}

async function assertValidStage(pipelineId: string, stage: string): Promise<void> {
  const stages = await getPipelineStages(pipelineId)
  if (!stages.some((s) => s.id === stage)) {
    throw new Error(`Stage "${stage}" is not valid for this pipeline`)
  }
}

function stageName(stages: PipelineStage[], stageId: string): string {
  return stages.find((s) => s.id === stageId)?.name ?? stageId
}

export const deals = {
  /** One page of deals, filtered and sorted in the database, with the exact number that match. */
  async listPage(filters: DealFilters, sort: DealSort | undefined, page: number, pageSize: number): Promise<PagedResult<DealListRow>> {
    const { column, ascending } = resolveDealSort(sort)
    return fetchPage<DealListRow>((from, to) => {
      const base = supabase.rpc('rma_deals_matching', searchArgs(filters), { count: 'exact' })
      return applyDealFilters(base, filters)
        .order(column, { ascending, nullsFirst: ascending })
        .order('id', { ascending: true })
        .range(from, to)
    }, page, pageSize)
  },

  /**
   * Every deal matching the filters — for an export. In board order: by stage,
   * newest first within a stage.
   */
  async listAllMatching(filters: DealFilters): Promise<DealListRow[]> {
    return fetchAllRows<DealListRow>((from, to) => {
      const base = supabase.rpc('rma_deals_matching', searchArgs(filters))
      return applyDealFilters(base, filters)
        .order('stage_order', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
    })
  },

  /** One Kanban column: the newest `limit` deals in `stage` and how many there are. */
  async listColumn(stage: string, filters: DealFilters, limit: number): Promise<{ data: DealListRow[]; count: number }> {
    const result = await fetchPage<DealListRow>((from, to) => {
      const base = supabase.rpc('rma_deals_matching', searchArgs(filters), { count: 'exact' }).eq('stage', stage)
      return applyDealFilters(base, filters)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
    }, 1, limit)
    return { data: result.data, count: result.count }
  },

  /** Deals by id, in URL-safe chunks, in board order — the rows a selection export needs. */
  async getMany(ids: string[]): Promise<DealListRow[]> {
    const unique = [...new Set(ids.filter(Boolean))]
    const out: DealListRow[] = []
    for (const chunk of chunksOf(unique, 100)) {
      const { data, error } = await supabase.from('v_deals_list').select('*').in('id', chunk)
      if (error) throw error
      out.push(...((data ?? []) as DealListRow[]))
    }
    return out.sort(
      (a, b) =>
        (a.stage_order ?? Infinity) - (b.stage_order ?? Infinity) ||
        String(b.created_at).localeCompare(String(a.created_at))
    )
  },

  /** How many deals a pipeline holds, for a rep's own deals or all. */
  async countInPipeline(pipelineId: string, ownerEmail?: string | null): Promise<number> {
    const base = supabase.from('deals').select('id', { count: 'exact', head: true }).eq('pipeline_id', pipelineId)
    const { count, error } = await applyDealFilters(base, { ownerEmail })
    if (error) throw error
    return count ?? 0
  },

  /** Count and value of the matching deals, per stage × rep × status × created month × close month. */
  async buckets(filters: DealFilters): Promise<DealBucket[]> {
    const rows = await fetchAllRows<DealBucket>((from, to) => {
      const base = supabase.rpc('rma_deal_buckets', { ...searchArgs(filters), p_tz: viewerTimeZone() })
      return applyDealFilters(base, filters)
        .order('stage', { ascending: true })
        .order('assigned_rep', { ascending: true })
        .order('status', { ascending: true })
        .order('created_month', { ascending: true })
        .order('close_month', { ascending: true })
        .range(from, to)
    })
    return rows.map((r) => ({ ...r, deal_count: Number(r.deal_count), value_sum: Number(r.value_sum) }))
  },

  /**
   * Value of the matching deals by their worst open activity (overdue / today /
   * planned), per stage × rep. "Today" is the viewer's.
   */
  async activityValues(filters: DealFilters): Promise<DealActivityValue[]> {
    const now = new Date()
    const todayEnd = new Date(now)
    todayEnd.setHours(23, 59, 59, 999)
    const rows = await fetchAllRows<DealActivityValue>((from, to) => {
      const base = supabase.rpc('rma_deal_activity_values', {
        ...searchArgs(filters),
        p_now: now.toISOString(),
        p_today_end: todayEnd.toISOString(),
      })
      return applyDealFilters(base, { ...filters, openOnly: false })
        .order('stage', { ascending: true })
        .order('assigned_rep', { ascending: true })
        .order('activity_state', { ascending: true })
        .range(from, to)
    })
    return rows.map((r) => ({ ...r, deal_count: Number(r.deal_count), value_sum: Number(r.value_sum) }))
  },

  /** Activities and completed activities per type on the matching open deals, per stage × rep. */
  async activityTypeCounts(filters: DealFilters): Promise<DealActivityTypeCount[]> {
    const rows = await fetchAllRows<DealActivityTypeCount>((from, to) => {
      const base = supabase.rpc('rma_deal_activity_type_counts', searchArgs(filters))
      return applyDealFilters(base, { ...filters, openOnly: false })
        .order('stage', { ascending: true })
        .order('assigned_rep', { ascending: true })
        .order('activity_type', { ascending: true })
        .range(from, to)
    })
    return rows.map((r) => ({ ...r, activity_count: Number(r.activity_count), done_count: Number(r.done_count) }))
  },

  /** The reps with deals in a pipeline, for the rep filter. */
  async repsInPipeline(pipelineId: string): Promise<string[]> {
    const { data, error } = await supabase.rpc('rma_deal_reps', { p_pipeline_id: pipelineId })
    if (error) throw error
    return (data ?? []) as string[]
  },

  /** One page of a customer's deals, newest first, with how many there are. (BUG-066.) */
  async listPageForCustomer(customerId: string, page: number, pageSize: number): Promise<PagedResult<DealRow>> {
    return fetchPage<DealRow>((from, to) =>
      supabase
        .from('deals')
        .select('*', { count: 'exact' })
        .eq('customer_id', customerId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to),
      page, pageSize)
  },
  /** Deals per pipeline × stage, every deal on a pipeline (rma_pipeline_stage_counts, 20260863). */
  async stageCounts(): Promise<Array<{ pipeline_id: string; stage: string | null; deal_count: number }>> {
    const rows = await fetchAllRows<{ pipeline_id: string; stage: string | null; deal_count: number }>((from, to) =>
      supabase
        .rpc('rma_pipeline_stage_counts')
        .order('pipeline_id', { ascending: true })
        .order('stage', { ascending: true })
        .range(from, to)
    )
    return rows.map((r) => ({ ...r, deal_count: Number(r.deal_count) || 0 }))
  },
  /** Ids of every deal on a pipeline's stage (a null stage matches deals with none). */
  async idsOnStage(pipelineId: string, stage: string | null): Promise<string[]> {
    const rows = await fetchAllRows<{ id: string }>((from, to) => {
      const q = supabase.from('deals').select('id').eq('pipeline_id', pipelineId)
      return (stage === null ? q.is('stage', null) : q.eq('stage', stage))
        .order('id', { ascending: true })
        .range(from, to)
    })
    return rows.map((r) => r.id)
  },
  async get(id: string): Promise<DealRow> {
    const { data, error } = await supabase.from('deals').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(
    deal: Omit<DealRow, 'id' | 'created_at' | 'won_at' | 'lost_at' | 'status'>
  ): Promise<DealRow> {
    await assertValidStage(deal.pipeline_id, deal.stage)
    const { data, error } = await supabase.from('deals').insert([deal]).select()
    if (error) throw error
    return data[0]
  },
  async update(id: string, deal: Partial<DealRow>): Promise<DealRow> {
    if (deal.stage) {
      const pipelineId = deal.pipeline_id ?? (await getDealPipelineId(id))
      await assertValidStage(pipelineId, deal.stage)
    }
    const { data, error } = await supabase.from('deals').update(deal).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Deal')
  },
  /**
   * moveStage — used by both the Kanban drag-drop and the deal detail page.
   * Auto-logs a 'log' activity with the human-readable stage names baked in
   * at write time (stage names are admin-configured business data, not app
   * chrome, so there's no i18n key to resolve them by later — unlike lead
   * status, which has a fixed translatable enum). Logging is non-fatal: a
   * failed log never blocks the stage change itself.
   */
  async moveStage(id: string, stage: string, actorEmail: string | null = null): Promise<DealRow> {
    const { data: current, error: fetchError } = await supabase
      .from('deals')
      .select('pipeline_id, stage')
      .eq('id', id)
      .single()
    if (fetchError) throw fetchError
    const stages = await getPipelineStages(current.pipeline_id)
    if (!stages.some((s) => s.id === stage)) {
      throw new Error(`Stage "${stage}" is not valid for this pipeline`)
    }
    const { data, error } = await supabase
      .from('deals')
      .update({ stage, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
    if (error) throw error
    assertAffected(data, 'Deal')
    if (current.stage !== stage) {
      activities
        .logSystem('deal', id, `stage_changed|${stageName(stages, current.stage)}|${stageName(stages, stage)}`, actorEmail)
        .catch(() => {})
    }
    return data[0]
  },

  /**
   * Move a deal to a different pipeline. Stages belong to a pipeline, so the deal's
   * current stage is meaningless in the destination — the caller must supply a stage
   * from the target pipeline, and both columns are written in one update so the deal
   * is never left pointing at a stage that doesn't exist in its pipeline.
   *
   * Separate from moveStage(), which deliberately validates against the deal's
   * CURRENT pipeline and so can never express a cross-pipeline move.
   */
  async movePipeline(
    id: string,
    pipelineId: string,
    stage: string,
    actorEmail: string | null = null
  ): Promise<DealRow> {
    const { data: current, error: fetchError } = await supabase
      .from('deals')
      .select('pipeline_id, stage')
      .eq('id', id)
      .single()
    if (fetchError) throw fetchError

    const targetStages = await getPipelineStages(pipelineId)
    if (!targetStages.some((s) => s.id === stage)) {
      throw new Error(`Stage "${stage}" is not valid for the destination pipeline`)
    }

    const { data, error } = await supabase
      .from('deals')
      .update({ pipeline_id: pipelineId, stage, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
    if (error) throw error
    assertAffected(data, 'Deal')

    if (current.pipeline_id !== pipelineId) {
      const fromStages = await getPipelineStages(current.pipeline_id).catch(() => [])
      activities
        .logSystem(
          'deal',
          id,
          `stage_changed|${stageName(fromStages, current.stage)}|${stageName(targetStages, stage)}`,
          actorEmail
        )
        .catch(() => {})
    }
    return data[0]
  },

  async markWon(id: string, actorEmail: string | null = null): Promise<DealRow> {
    const pipelineId = await getDealPipelineId(id)
    const stages = await getPipelineStages(pipelineId)
    const wonStage = stages.find((s) => s.is_won)
    if (!wonStage) throw new Error("This deal's pipeline has no is_won stage")
    const { data, error } = await supabase
      .from('deals')
      .update({
        status: 'won',
        stage: wonStage.id,
        probability: 100,
        won_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
    if (error) throw error
    assertAffected(data, 'Deal')
    activities.logSystem('deal', id, 'won', actorEmail).catch(() => {})
    return data[0]
  },
  async markLost(id: string, reason: string, actorEmail: string | null = null): Promise<DealRow> {
    if (!reason?.trim()) throw new Error('A reason is required when marking a deal as lost')
    const pipelineId = await getDealPipelineId(id)
    const stages = await getPipelineStages(pipelineId)
    const lostStage = stages.find((s) => s.is_lost)
    if (!lostStage) throw new Error("This deal's pipeline has no is_lost stage")
    const { data, error } = await supabase
      .from('deals')
      .update({
        status: 'lost',
        stage: lostStage.id,
        lost_reason: reason,
        lost_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
    if (error) throw error
    assertAffected(data, 'Deal')
    activities.logSystem('deal', id, `lost|${reason}`, actorEmail).catch(() => {})
    return data[0]
  },
  async bulkDelete(ids: string[]): Promise<void> {
    if (!ids.length) return
    // Take the history with them. activities.related_id is polymorphic, so no
    // foreign key protects it and the logs would otherwise survive as rows
    // pointing at a deal that no longer exists.
    await activities.deleteForRelated('deal', ids)
    const { data, error } = await supabase.from('deals').delete().in('id', ids).select('id')
    if (error) throw error
    assertAllAffected(data, ids, 'deal')
  },
  async bulkMoveStage(ids: string[], stageId: string): Promise<void> {
    if (!ids.length) return
    // Validate stage is present in every pipeline represented by the selection.
    // Read and written in chunks: a selection can be thousands of deals, more
    // than one URL or one 1 000-row response holds. (BUG-066.)
    const dealList: Array<{ id: string; pipeline_id: string; status: string }> = []
    for (const chunk of chunksOf(ids, 100)) {
      const { data: dealRows, error: fetchErr } = await supabase
        .from('deals')
        .select('id, pipeline_id, status')
        .in('id', chunk)
      if (fetchErr) throw fetchErr
      dealList.push(...((dealRows ?? []) as Array<{ id: string; pipeline_id: string; status: string }>))
    }
    const pipelineIds = [...new Set(dealList.map((d) => d.pipeline_id))]
    const { data: pipelineRows, error: pipeErr } = await supabase
      .from('pipelines')
      .select('id, stages')
      .in('id', pipelineIds)
    if (pipeErr) throw pipeErr
    for (const p of (pipelineRows ?? []) as Array<{ id: string; stages: PipelineStage[] }>) {
      if (!p.stages.some((s) => s.id === stageId)) {
        throw new Error(`Stage "${stageId}" is not valid for all selected deals' pipelines`)
      }
    }
    for (const chunk of chunksOf(ids, 100)) {
      const { data: moved, error } = await supabase
        .from('deals')
        .update({ stage: stageId, updated_at: new Date().toISOString() })
        .in('id', chunk)
        .select('id')
      if (error) throw error
      assertAllAffected(moved, chunk, 'deal')
    }
    // Reset won/lost terminal fields for any deals that were in a terminal state.
    const terminalIds = dealList.filter((d) => d.status === 'won' || d.status === 'lost').map((d) => d.id)
    for (const chunk of chunksOf(terminalIds, 100)) {
      const { data: reopened, error: termErr } = await supabase
        .from('deals')
        .update({ status: 'open', won_at: null, lost_at: null, lost_reason: null })
        .in('id', chunk)
        .select('id')
      if (termErr) throw termErr
      assertAllAffected(reopened, chunk, 'deal')
    }
  },
  async reopen(id: string, stageId: string, actorEmail: string | null = null): Promise<DealRow> {
    const { data: current, error: fetchError } = await supabase
      .from('deals')
      .select('pipeline_id, status')
      .eq('id', id)
      .single()
    if (fetchError) throw fetchError
    const stages = await getPipelineStages(current.pipeline_id)
    const targetStage = stages.find((s) => s.id === stageId)
    if (!targetStage) throw new Error(`Stage "${stageId}" is not valid for this pipeline`)
    if (targetStage.is_won || targetStage.is_lost) {
      throw new Error('Cannot reopen a deal directly into a terminal stage')
    }
    const { data, error } = await supabase
      .from('deals')
      .update({
        status: 'open',
        stage: stageId,
        won_at: null,
        lost_at: null,
        lost_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
    if (error) throw error
    assertAffected(data, 'Deal')
    activities
      .logSystem('deal', id, `reopened|${current.status}|${stageName(stages, stageId)}`, actorEmail)
      .catch(() => {})
    return data[0]
  },
}
