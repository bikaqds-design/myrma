import { supabase } from '../client.js'
import { assertUpdated, assertAffected } from './_assertUpdated.js'
import { fetchAllRows, chunksOf } from './_paging.js'

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
  // All open (non-completed, non-log) scheduled activities across all related
  // types. Used by the Activities page and for overdue-count badge derivation.
  async listAllPlanned(): Promise<ActivityRow[]> {
    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .is('completed_at', null)
      .neq('type', 'log')
      .not('due_date', 'is', null)
      .order('due_date', { ascending: true })
    if (error) throw error
    return data || []
  },
  // All completed (non-log) activities, newest first — used by Activity Logs tab.
  async listCompleted(): Promise<ActivityRow[]> {
    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .not('completed_at', 'is', null)
      .neq('type', 'log')
      .order('completed_at', { ascending: false })
    if (error) throw error
    return data || []
  },
}
