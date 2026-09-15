import { supabase } from '../client.js'
import { assertUpdated } from './_assertUpdated.js'
import { fetchAllRows } from './_paging.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface PipelineStage {
  id: string
  name: string
  order: number
  probability_default: number
  is_won: boolean
  is_lost: boolean
}

export interface PipelineRow {
  id: string
  name: string
  stages: PipelineStage[]
  is_active: boolean
  created_at: string
}

// ── Pipelines ─────────────────────────────────────────────────────────────────
// stages is always read/written as an array — never spread into a keyed
// object. See CONSTITUTION.md §7.5a / research.md §3 on JSONB key-order loss.

function validateStages(stages: PipelineStage[]): void {
  const wonCount = stages.filter((s) => s.is_won).length
  const lostCount = stages.filter((s) => s.is_lost).length
  if (wonCount !== 1) throw new Error('Pipeline stages must contain exactly one is_won stage')
  if (lostCount !== 1) throw new Error('Pipeline stages must contain exactly one is_lost stage')
  const ids = stages.map((s) => s.id)
  if (new Set(ids).size !== ids.length) throw new Error('Pipeline stage ids must be unique')
}

export const pipelines = {
  /** Every pipeline, by name. (BUG-066: read in full.) */
  async list(): Promise<PipelineRow[]> {
    return fetchAllRows<PipelineRow>((from, to) =>
      supabase.from('pipelines').select('*').order('name').order('id', { ascending: true }).range(from, to)
    )
  },
  async get(id: string): Promise<PipelineRow> {
    const { data, error } = await supabase.from('pipelines').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  // admin-only at the RLS layer — write attempts from non-admin roles fail server-side
  async update(id: string, pipeline: Partial<PipelineRow>): Promise<PipelineRow> {
    if (pipeline.stages) validateStages(pipeline.stages)
    const { data, error } = await supabase.from('pipelines').update(pipeline).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Pipeline')
  },
}
