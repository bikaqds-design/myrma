import { supabase } from '../client.js'
import { assertAffected } from './_assertUpdated.js'
import { fetchPage, fetchAllRows } from './_paging.js'
import type { RangeResponse } from './_paging.js'
import type { PagedResult } from './types.js'

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
  /** Whether the table is provisioned, without reading it. */
  async isProvisioned(): Promise<boolean> {
    const { error } = await supabase.from('company_documents').select('id', { count: 'exact', head: true })
    if (!error) return true
    if (NOT_PROVISIONED.includes(error.code ?? '')) return false
    throw error
  },

  /**
   * One page of live documents, newest first, with the exact count — or, with a
   * query, of those whose title, description or body match it (websearch
   * syntax), with the body back for the result. The list used to load every
   * document, and the search to stop at 100, both then paged in the browser;
   * the Data API caps a read at 1 000 rows. (BUG-066.)
   */
  async listPage(query: string | null | undefined, page: number, pageSize: number): Promise<PagedResult<CompanyDocumentRow>> {
    const q = query?.trim()
    return fetchPage<CompanyDocumentRow>((from, to): PromiseLike<RangeResponse> => {
      const base = supabase
        .from('company_documents')
        .select(q ? WITH_TEXT : DOC_COLUMNS, { count: 'exact' })
        .is('deleted_at', null)
      const matching = q ? base.textSearch('search_vector', q, { type: 'websearch', config: 'simple' }) : base
      return matching
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<RangeResponse>
    }, page, pageSize)
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
    const { data, error } = await supabase.from('company_documents').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Document')
  },

  async trash(id: string, deletedBy: string): Promise<void> {
    const { data, error } = await supabase
      .from('company_documents')
      .update({ deleted_at: new Date().toISOString(), deleted_by: deletedBy })
      .eq('id', id)
      .select('id')
    if (error) throw error
    assertAffected(data, 'Document')
  },

  async restore(id: string): Promise<void> {
    const { data, error } = await supabase
      .from('company_documents')
      .update({ deleted_at: null, deleted_by: null })
      .eq('id', id)
      .select('id')
    if (error) throw error
    assertAffected(data, 'Document')
  },

  /** Everything in Trash within its retention window, newest first — all of it, in chunks. (BUG-066.) */
  async listTrash(): Promise<CompanyDocumentRow[]> {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 86_400_000).toISOString()
    try {
      return await fetchAllRows<CompanyDocumentRow>((from, to): PromiseLike<RangeResponse> =>
        supabase
          .from('company_documents')
          .select(DOC_COLUMNS)
          .not('deleted_at', 'is', null)
          .gt('deleted_at', cutoff)
          .order('deleted_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to) as unknown as PromiseLike<RangeResponse>
      )
    } catch (error) {
      if (NOT_PROVISIONED.includes((error as { code?: string })?.code ?? '')) return []
      throw error
    }
  },

  /** Trashed past the retention window. See src/lib/documentTrash.js for the sweep. */
  async listExpiredTrash(): Promise<CompanyDocumentRow[]> {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 86_400_000).toISOString()
    // All of them: a purge that stopped at the row cap would leave the rest in
    // Trash past their date. (BUG-066.)
    try {
      return await fetchAllRows<CompanyDocumentRow>((from, to): PromiseLike<RangeResponse> =>
        supabase
          .from('company_documents')
          .select(DOC_COLUMNS)
          .not('deleted_at', 'is', null)
          .lte('deleted_at', cutoff)
          .order('id', { ascending: true })
          .range(from, to) as unknown as PromiseLike<RangeResponse>
      )
    } catch (error) {
      if (NOT_PROVISIONED.includes((error as { code?: string })?.code ?? '')) return []
      throw error
    }
  },
}
