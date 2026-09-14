import { supabase } from '../client.js'
import { assertAffected } from './_assertUpdated.js'
import { fetchAllRows } from './_paging.js'

/**
 * Product documents — the Knowledge Center's contents (20260801).
 *
 * Staff-only by policy. The file itself lives in the existing storage bucket,
 * which is public by design for this module (vendor datasheets are published
 * material); this table holds what the document is and the text read out of it.
 */

export type DocType = 'datasheet' | 'manual' | 'warranty' | 'certificate' | 'drawing' | 'other'
export type ExtractionStatus = 'pending' | 'ok' | 'empty' | 'failed' | 'unsupported'

export interface ProductDocumentRow {
  id: string
  product_id: string
  title: string
  doc_type: DocType
  description: string | null
  file_name: string
  file_url: string
  storage_path: string
  file_size: number | null
  mime_type: string | null
  extracted_text: string | null
  /** Whether the text could be read — and so whether this is searchable. */
  extraction_status: ExtractionStatus
  page_count: number | null
  uploaded_by: string | null
  created_at: string
  updated_at: string
  /** Set when the document is in Trash; null for a live document. */
  deleted_at: string | null
  deleted_by: string | null
  /** Present on joined reads. */
  product?: {
    id: string
    sku: string
    product_name: string
    brand_id: string | null
    category_id: string | null
    subcategory_id: string | null
  } | null
}

const NOT_PROVISIONED = ['42P01', 'PGRST205']

/**
 * Everything except the document body.
 *
 * `extracted_text` holds the entire contents of a PDF — tens of kilobytes per
 * row, and up to a hundred rows come back at a time. Browsing never renders a
 * word of it, so selecting it there was megabytes over the wire to be thrown
 * away. Only the search asks for it, because only the search shows a snippet.
 */
const DOC_COLUMNS = [
  'id',
  'product_id',
  'title',
  'doc_type',
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

/** How long a trashed document stays recoverable before it is purged for good. */
export const TRASH_RETENTION_DAYS = 5

export const productDocuments = {
  /** Every live document of one product, newest first — read in chunks, so none is cut off. (BUG-066.) */
  async listForProduct(productId: string): Promise<ProductDocumentRow[]> {
    try {
      return await fetchAllRows<ProductDocumentRow>((from, to) =>
        supabase
          .from('product_documents')
          .select(DOC_COLUMNS)
          .eq('product_id', productId)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to)
      )
    } catch (error) {
      if (NOT_PROVISIONED.includes((error as { code?: string })?.code ?? '')) return []
      throw error
    }
  },

  async create(input: {
    productId: string
    title: string
    docType: DocType
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
  }): Promise<ProductDocumentRow> {
    const { data, error } = await supabase
      .from('product_documents')
      .insert({
        product_id: input.productId,
        title: input.title.trim(),
        doc_type: input.docType,
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
    return data as ProductDocumentRow
  },

  async update(id: string, patch: { title?: string; docType?: DocType; description?: string | null }) {
    const { data, error } = await supabase
      .from('product_documents')
      .update({
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.docType !== undefined ? { doc_type: patch.docType } : {}),
        ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
      })
      .eq('id', id)
      .select('id')
    if (error) throw error
    assertAffected(data, 'Document')
  },

  /** The hard-delete primitive. Only the purge sweep calls this directly. */
  async remove(id: string): Promise<void> {
    const { data, error } = await supabase.from('product_documents').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Document')
  },

  /**
   * Moves a document to Trash. Every user-facing delete goes through this —
   * there is deliberately no other path to removing a document, so "it's
   * recoverable for 5 days" is true everywhere, not just in the screen that
   * happened to be rewritten for it.
   */
  async trash(id: string, deletedBy: string): Promise<void> {
    const { data, error } = await supabase
      .from('product_documents')
      .update({ deleted_at: new Date().toISOString(), deleted_by: deletedBy })
      .eq('id', id)
      .select('id')
    if (error) throw error
    assertAffected(data, 'Document')
  },

  async restore(id: string): Promise<void> {
    const { data, error } = await supabase
      .from('product_documents')
      .update({ deleted_at: null, deleted_by: null })
      .eq('id', id)
      .select('id')
    if (error) throw error
    assertAffected(data, 'Document')
  },

  /**
   * Trashed past the retention window — due for permanent removal. Returns
   * the rows rather than deleting them itself, because deleting the row is
   * only half the job: the storage file has to go too, and that needs the
   * `storage` module, which this file deliberately does not import (kept
   * database and storage concerns separated, matching the rest of this
   * module). See `src/lib/documentTrash.js` for the orchestration.
   */
  async listExpiredTrash(): Promise<ProductDocumentRow[]> {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 86_400_000).toISOString()
    // All of them, in chunks: a purge that stopped at the Data API's row cap
    // would leave the rest in Trash past their date. (BUG-066.)
    try {
      return await fetchAllRows<ProductDocumentRow>((from, to) =>
        supabase
          .from('product_documents')
          .select(DOC_COLUMNS)
          .not('deleted_at', 'is', null)
          .lte('deleted_at', cutoff)
          .order('id', { ascending: true })
          .range(from, to)
      )
    } catch (error) {
      if (NOT_PROVISIONED.includes((error as { code?: string })?.code ?? '')) return []
      throw error
    }
  },

  /**
   * Any existing document — live or trashed — of the same type already
   * filed under this product. Uploading a second one of the same kind is
   * either a genuine duplicate or a re-upload of something just trashed;
   * either way the uploader should be told before it happens quietly.
   */
  async findByProductAndType(
    productId: string,
    docType: DocType
  ): Promise<Pick<ProductDocumentRow, 'id' | 'title' | 'deleted_at'>[]> {
    const { data, error } = await supabase
      .from('product_documents')
      .select('id, title, deleted_at')
      .eq('product_id', productId)
      .eq('doc_type', docType)
    if (error) {
      if (NOT_PROVISIONED.includes(error.code)) return []
      throw error
    }
    return data ?? []
  },

}
