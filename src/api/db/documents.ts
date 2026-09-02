import { supabase } from '../client.js'

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
 * Product fields joined onto a document, so results can name what they
 * describe — and so they can be filtered by brand or category.
 *
 * `!inner` matters: without it PostgREST performs a left join and a filter on
 * a product column silently returns every document with a null product instead
 * of narrowing anything. With it, filtering on product.brand_id works as
 * written.
 */
const PRODUCT_JOIN =
  'product:products!inner(id, sku, product_name, brand_id, category_id, subcategory_id)'

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
].join(', ')

const WITH_PRODUCT = `${DOC_COLUMNS}, ${PRODUCT_JOIN}`
const WITH_PRODUCT_AND_TEXT = `${DOC_COLUMNS}, extracted_text, ${PRODUCT_JOIN}`

export interface DocumentFilters {
  brandId?: string | null
  categoryId?: string | null
  subcategoryId?: string | null
  docType?: DocType | null
  productId?: string | null
  /** Only documents whose text was actually readable. */
  searchableOnly?: boolean
}

/** Apply the filter set to a query. Kept in one place so browse and search agree. */
function applyFilters(query: ReturnType<typeof supabase.from>, filters?: DocumentFilters) {
  let q = query
  if (filters?.brandId) q = q.eq('product.brand_id', filters.brandId)
  if (filters?.categoryId) q = q.eq('product.category_id', filters.categoryId)
  if (filters?.subcategoryId) q = q.eq('product.subcategory_id', filters.subcategoryId)
  if (filters?.productId) q = q.eq('product_id', filters.productId)
  if (filters?.docType) q = q.eq('doc_type', filters.docType)
  // A document whose text could not be read will never match a content search,
  // so this only changes what browsing shows — which is exactly where someone
  // hunting for gaps wants it.
  if (filters?.searchableOnly) q = q.eq('extraction_status', 'ok')
  return q
}

export const productDocuments = {
  async listForProduct(productId: string): Promise<ProductDocumentRow[]> {
    const { data, error } = await supabase
      .from('product_documents')
      .select(DOC_COLUMNS)
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
    if (error) {
      if (NOT_PROVISIONED.includes(error.code)) return []
      throw error
    }
    return (data ?? []) as ProductDocumentRow[]
  },

  async listAll(
    filters?: DocumentFilters
  ): Promise<{ data: ProductDocumentRow[]; missing: boolean }> {
    const { data, error } = await applyFilters(
      supabase.from('product_documents').select(WITH_PRODUCT),
      filters
    ).order('created_at', { ascending: false })
    if (error) {
      if (NOT_PROVISIONED.includes(error.code)) return { data: [], missing: true }
      throw error
    }
    return { data: (data ?? []) as ProductDocumentRow[], missing: false }
  },

  /**
   * Full-text search across titles, descriptions and document bodies.
   *
   * websearch_to_tsquery and not plainto_tsquery: it understands quoted phrases
   * and OR, which is how people actually type into a search box, and it never
   * throws on odd punctuation — plainto_ would reject a query containing a
   * part number with a colon in it.
   */
  async search(
    query: string,
    filters?: DocumentFilters
  ): Promise<{ data: ProductDocumentRow[]; missing: boolean }> {
    const q = query.trim()
    if (!q) return productDocuments.listAll(filters)

    const { data, error } = await applyFilters(
      supabase
        .from('product_documents')
        // The body comes back here and only here, to build the snippet that
        // shows why each result matched.
        .select(WITH_PRODUCT_AND_TEXT)
        .textSearch('search_vector', q, { type: 'websearch', config: 'simple' }),
      filters
    ).limit(100)
    if (error) {
      if (NOT_PROVISIONED.includes(error.code)) return { data: [], missing: true }
      throw error
    }
    return { data: (data ?? []) as ProductDocumentRow[], missing: false }
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
    const { error } = await supabase
      .from('product_documents')
      .update({
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.docType !== undefined ? { doc_type: patch.docType } : {}),
        ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
      })
      .eq('id', id)
    if (error) throw error
  },

  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('product_documents').delete().eq('id', id)
    if (error) throw error
  },

  /** How many documents each product has, for the product list. */
  async countsByProduct(): Promise<Record<string, number>> {
    const { data, error } = await supabase.from('product_documents').select('product_id')
    if (error) {
      if (NOT_PROVISIONED.includes(error.code)) return {}
      throw error
    }
    const counts: Record<string, number> = {}
    for (const row of data ?? []) {
      counts[(row as { product_id: string }).product_id] =
        (counts[(row as { product_id: string }).product_id] ?? 0) + 1
    }
    return counts
  },
}
