import { supabase } from '../client.js'
import { assertAffected } from './_assertUpdated.js'

// ── Row type ────────────────────────────────────────────────────────────────
// Mirrors the v_sales_documents view (20260720_sales_documents_view.sql):
// a UNION of quotations / sales_orders / crm_invoices / credit_notes with a
// doc_type discriminator. Powers the "All" tab of the Sales Documents page.

export type SalesDocType = 'quotation' | 'sales_order' | 'invoice' | 'credit_note'

export interface SalesDocumentRow {
  id: string
  doc_type: SalesDocType
  doc_code: string | null
  customer_id: string
  assigned_rep: string | null
  created_by: string | null
  doc_status: string
  payment_status: string | null
  total: number | null
  created_at: string
  updated_at: string | null
  type_specific_date: string | null
  type_specific_date_label: string | null
  archived: boolean
  archived_at: string | null
}

// Maps the view's doc_type discriminator back to its source table.
const DOC_TABLE: Record<SalesDocType, string> = {
  quotation: 'quotations',
  sales_order: 'sales_orders',
  invoice: 'crm_invoices',
  credit_note: 'credit_notes',
}

// ── Module ──────────────────────────────────────────────────────────────────

export const salesDocuments = {
  /**
   * listAll — every sales document across all four tables, newest first.
   * RLS is inherited from the underlying tables (the view is not SECURITY
   * DEFINER), so staff see only their own rows and manager+ see everything.
   * Returns [] when the view is missing (42P01) so a deployment without the
   * Sprint 6 migrations degrades gracefully instead of throwing.
   */
  async listAll(filters?: { assignedRep?: string }): Promise<SalesDocumentRow[]> {
    let q = supabase
      .from('v_sales_documents')
      .select('*')
      .order('created_at', { ascending: false })
    if (filters?.assignedRep) q = q.eq('assigned_rep', filters.assignedRep)
    const { data, error } = await q
    if (error) {
      if (error.code === '42P01') return []
      throw error
    }
    return (data ?? []) as SalesDocumentRow[]
  },

  /**
   * setArchived — archive (or restore) a document. Documents are never deleted;
   * archiving only flips a flag so the row leaves the main tabs and appears in
   * the Archive tab. Writes archived_at/archived_by for the audit trail.
   */
  async setArchived(docType: SalesDocType, id: string, archived: boolean, actorEmail: string): Promise<void> {
    const table = DOC_TABLE[docType]
    if (!table) throw new Error(`Unknown document type: ${docType}`)
    const { data, error } = await supabase
      .from(table)
      .update({
        archived,
        archived_at: archived ? new Date().toISOString() : null,
        archived_by: archived ? actorEmail : null,
      })
      .eq('id', id)
      .select('id')
    if (error) throw error
    assertAffected(data, 'Document')
  },
}
