import { supabase } from '../client.js'
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
  async moveStage(id: string, stage: string): Promise<DealRow> {
    const pipelineId = await getDealPipelineId(id)
    await assertValidStage(pipelineId, stage)
    const { data, error } = await supabase
      .from('deals')
      .update({ stage, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
    if (error) throw error
    return data[0]
  },
  async markWon(id: string): Promise<DealRow> {
    const pipelineId = await getDealPipelineId(id)
    const stages = await getPipelineStages(pipelineId)
    const wonStage = stages.find((s) => s.is_won)
    if (!wonStage) throw new Error("This deal's pipeline has no is_won stage")
    const { data, error } = await supabase
      .from('deals')
      .update({
        status: 'won',
        stage: wonStage.id,
        won_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
    if (error) throw error
    return data[0]
  },
  async markLost(id: string, reason: string): Promise<DealRow> {
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
    return data[0]
  },
}
