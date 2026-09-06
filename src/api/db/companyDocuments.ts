import { supabase } from '../client.js'

/**
 * Company documents — reference material that belongs to the business as a
 * whole, not to any one product (20260809).
 *
 * A deliberately separate table and module from product_documents, not a
 * nullable product_id on it: product_documents.product_id is NOT NULL so
 * that every document is reachable from the catalogue tree that indexes it,
 * and weakening that for a handful of unrelated documents would be the wrong
 * trade. Mirrors product_documents wherever the same reasoning applies
 * (search, staff-only RLS, trash) and drops what does not — there is no
 * brand, category or product to file one under.
 */

export type ExtractionStatus = 'pending' | 'ok' | 'empty' | 'failed' | 'unsupported'

export interface CompanyDocumentRow {
  id: string
  title: string
  description: string | null
  file_name: string
  file_url: string
  storage_path: string
  file_size: number | null
  mime_type: string | null
  extracted_text: string | null
  extraction_status: ExtractionStatus
  page_count: number | null
  uploaded_by: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_by: string | null
}

const NOT_PROVISIONED = ['42P01', 'PGRST205']

/** Everything except the document body — see documents.ts for why that split exists. */
const DOC_COLUMNS = [
  'id',
  'title',
  'description',
  'file_name',
  'file_url',
  'storage_path',
  'file_size',
  'mime_type',
  'extraction_status',
  'page_count',
  'uploaded_by',
  'created_at',
  'updated_at',
  'deleted_at',
  'deleted_by',
].join(', ')

const WITH_TEXT = `${DOC_COLUMNS}, extracted_text`

export const TRASH_RETENTION_DAYS = 5

export const companyDocuments = {
  async listAll(): Promise<{ data: CompanyDocumentRow[]; missing: boolean }> {
    const { data, error } = await supabase
      .from('company_documents')
      .select(DOC_COLUMNS)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
    if (error) {
      if (NOT_PROVISIONED.includes(error.code)) return { data: [], missing: true }
      throw error
    }
    return { data: (data ?? []) as CompanyDocumentRow[], missing: false }
  },

  /** Full-text search across title, description and the document body. */
  async search(query: string): Promise<{ data: CompanyDocumentRow[]; missing: boolean }> {
    const q = query.trim()
    if (!q) return companyDocuments.listAll()

    const { data, error } = await supabase
      .from('company_documents')
      .select(WITH_TEXT)
      .is('deleted_at', null)
      .textSearch('search_vector', q, { type: 'websearch', config: 'simple' })
      .limit(100)
    if (error) {
      if (NOT_PROVISIONED.includes(error.code)) return { data: [], missing: true }
      throw error
    }
    return { data: (data ?? []) as CompanyDocumentRow[], missing: false }
  },

  async create(input: {
    title: string
    description?: string | null
    fileName: string
    fileUrl: string
    storagePath: string
    fileSize?: number | null
    mimeType?: string | null
    extractedText?: string | null
    extractionStatus: ExtractionStatus
    pageCount?: number | null
    uploadedBy: string
  }): Promise<CompanyDocumentRow> {
    const { data, error } = await supabase
      .from('company_documents')
      .insert({
        title: input.title.trim(),
        description: input.description?.trim() || null,
        file_name: input.fileName,
        file_url: input.fileUrl,
        storage_path: input.storagePath,
        file_size: input.fileSize ?? null,
        mime_type: input.mimeType ?? null,
        extracted_text: input.extractedText || null,
        extraction_status: input.extractionStatus,
        page_count: input.pageCount ?? null,
        uploaded_by: input.uploadedBy,
      })
      .select()
      .single()
    if (error) throw error
    return data as CompanyDocumentRow
  },

  /** The hard-delete primitive. Only the purge sweep calls this directly. */
  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('company_documents').delete().eq('id', id)
    if (error) throw error
  },

  async trash(id: string, deletedBy: string): Promise<void> {
    const { error } = await supabase
      .from('company_documents')
      .update({ deleted_at: new Date().toISOString(), deleted_by: deletedBy })
      .eq('id', id)
    if (error) throw error
  },

  async restore(id: string): Promise<void> {
    const { error } = await supabase
      .from('company_documents')
      .update({ deleted_at: null, deleted_by: null })
      .eq('id', id)
    if (error) throw error
  },

  async listTrash(): Promise<CompanyDocumentRow[]> {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 86_400_000).toISOString()
    const { data, error } = await supabase
      .from('company_documents')
      .select(DOC_COLUMNS)
      .not('deleted_at', 'is', null)
      .gt('deleted_at', cutoff)
      .order('deleted_at', { ascending: false })
    if (error) {
      if (NOT_PROVISIONED.includes(error.code)) return []
      throw error
    }
    return (data ?? []) as CompanyDocumentRow[]
  },

  /** Trashed past the retention window. See src/lib/documentTrash.js for the sweep. */
  async listExpiredTrash(): Promise<CompanyDocumentRow[]> {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 86_400_000).toISOString()
    const { data, error } = await supabase
      .from('company_documents')
      .select(DOC_COLUMNS)
      .not('deleted_at', 'is', null)
      .lte('deleted_at', cutoff)
    if (error) {
      if (NOT_PROVISIONED.includes(error.code)) return []
      throw error
    }
    return (data ?? []) as CompanyDocumentRow[]
  },
}
