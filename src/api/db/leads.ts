import { supabase } from '../client.js'
import { activities } from './activities.js'
import { assertUpdated, assertAllAffected } from './_assertUpdated.js'

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

// ── Leads ─────────────────────────────────────────────────────────────────────
// Once converted_at is set, a lead is immutable except for notes — convert()
// is the only path that sets the converted_* fields. See data-model.md.

export const leads = {
  async list(filters?: { status?: string; assignedRep?: string }): Promise<LeadRow[]> {
    let query = supabase.from('leads').select('*').order('created_at', { ascending: false })
    if (filters?.status) query = query.eq('status', filters.status)
    if (filters?.assignedRep) query = query.eq('assigned_rep', filters.assignedRep)
    const { data, error } = await query
    if (error) throw error
    return data || []
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
