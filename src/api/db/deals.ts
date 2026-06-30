import { supabase } from '../client.js'
import { activities } from './activities.js'
import type { PipelineStage } from './pipelines.js'

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
  async list(filters?: {
    pipelineId?: string
    status?: string
    assignedRep?: string
  }): Promise<DealRow[]> {
    let query = supabase.from('deals').select('*').order('created_at', { ascending: false })
    if (filters?.pipelineId) query = query.eq('pipeline_id', filters.pipelineId)
    if (filters?.status) query = query.eq('status', filters.status)
    if (filters?.assignedRep) query = query.eq('assigned_rep', filters.assignedRep)
    const { data, error } = await query
    if (error) throw error
    return data || []
  },
  async listForCustomer(customerId: string): Promise<DealRow[]> {
    const { data, error } = await supabase
      .from('deals')
      .select('*')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
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
    return data[0]
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
    if (current.stage !== stage) {
      activities
        .logSystem('deal', id, `stage_changed|${stageName(stages, current.stage)}|${stageName(stages, stage)}`, actorEmail)
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
    activities.logSystem('deal', id, `lost|${reason}`, actorEmail).catch(() => {})
    return data[0]
  },
  async bulkDelete(ids: string[]): Promise<void> {
    if (!ids.length) return
    const { error } = await supabase.from('deals').delete().in('id', ids)
    if (error) throw error
  },
  async bulkMoveStage(ids: string[], stageId: string): Promise<void> {
    if (!ids.length) return
    const { error } = await supabase
      .from('deals')
      .update({ stage: stageId, updated_at: new Date().toISOString() })
      .in('id', ids)
    if (error) throw error
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
    activities
      .logSystem('deal', id, `reopened|${current.status}|${stageName(stages, stageId)}`, actorEmail)
      .catch(() => {})
    return data[0]
  },
}
