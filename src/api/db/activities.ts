import { supabase } from '../client.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface ActivityRow {
  id: string
  related_type: 'lead' | 'deal' | 'customer' | 'contact'
  related_id: string
  type: string
  title: string
  due_date: string | null
  completed_at: string | null
  assigned_rep: string | null
  outcome_notes: string | null
  created_at: string
  created_by: string | null
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
  async list(
    relatedType: ActivityRow['related_type'],
    relatedId: string
  ): Promise<ActivityRow[]> {
    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .eq('related_type', relatedType)
      .eq('related_id', relatedId)
      .order('due_date', { ascending: true, nullsFirst: false })
    if (error) throw error
    return data || []
  },
  async create(
    activity: Omit<ActivityRow, 'id' | 'created_at' | 'completed_at'>
  ): Promise<ActivityRow> {
    await assertRelatedExists(activity.related_type, activity.related_id)
    const { data, error } = await supabase.from('activities').insert([activity]).select()
    if (error) throw error
    return data[0]
  },
  async complete(id: string, outcomeNotes?: string): Promise<ActivityRow> {
    const updates: Partial<ActivityRow> = { completed_at: new Date().toISOString() }
    if (outcomeNotes !== undefined) updates.outcome_notes = outcomeNotes
    const { data, error } = await supabase.from('activities').update(updates).eq('id', id).select()
    if (error) throw error
    return data[0]
  },
  // RLS already scopes results to what the caller can see (manager+ sees
  // all, sales_rep sees only their own assigned_rep rows).
  async listOverdue(): Promise<ActivityRow[]> {
    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .lt('due_date', new Date().toISOString())
      .is('completed_at', null)
      .order('due_date', { ascending: true })
    if (error) throw error
    return data || []
  },
}
