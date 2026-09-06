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
  'deleted_at',
  'deleted_by',
].join(', ')

/** How long a trashed document stays recoverable before it is purged for good. */
export const TRASH_RETENTION_DAYS = 5

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
  /** Only documents that are NOT readable — the coverage-gap worklist. */
  notSearchableOnly?: boolean
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
  if (filters?.notSearchableOnly) q = q.neq('extraction_status', 'ok')
  return q
}

export const productDocuments = {
  async listForProduct(productId: string): Promise<ProductDocumentRow[]> {
    const { data, error } = await supabase
      .from('product_documents')
      .select(DOC_COLUMNS)
      .eq('product_id', productId)
      .is('deleted_at', null)
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
      supabase.from('product_documents').select(WITH_PRODUCT).is('deleted_at', null),
      filters
    ).order('created_at', { ascending: false })
    if (error) {
      if (NOT_PROVISIONED.includes(error.code)) return { data: [], missing: true }
      throw error
    }
    return { data: (data ?? []) as ProductDocumentRow[], missing: false }
  },

  /**
   * Full-text search across titles, descriptions and document bodies —
   * PLUS the product a document is filed under, which `search_vector` does
   * not and cannot cover (it is a generated column on `product_documents`
   * itself; Postgres generated columns can only read their own row, not a
   * join). Confirmed empirically: searching a product's own SKU returned
   * nothing, even though the document is filed right under it and the whole
   * point of this page is "someone who knows a part number should find it."
   *
   * websearch_to_tsquery and not plainto_tsquery: it understands quoted phrases
   * and OR, which is how people actually type into a search box, and it never
   * throws on odd punctuation — plainto_ would reject a query containing a
   * part number with a colon in it.
   *
   * The product-name/SKU match runs as two independent `ilike` calls rather
   * than one `.or('sku.ilike...,product_name.ilike...')`: PostgREST's `.or()`
   * takes a raw string DSL that splits on commas, so a search containing a
   * comma (a plausible thing to type — "Dell, HP") would corrupt the filter
   * instead of matching literally.
   */
  async search(
    query: string,
    filters?: DocumentFilters
  ): Promise<{ data: ProductDocumentRow[]; missing: boolean }> {
    const q = query.trim()
    if (!q) return productDocuments.listAll(filters)

    // A literal % or _ in the query is a plausible thing to type (a part
    // number, a percentage) and must not act as an ilike wildcard.
    const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`

    const [textRes, skuRes, nameRes] = await Promise.all([
      applyFilters(
        supabase
          .from('product_documents')
          // The body comes back here and only here, to build the snippet that
          // shows why each result matched.
          .select(WITH_PRODUCT_AND_TEXT)
          .is('deleted_at', null)
          .textSearch('search_vector', q, { type: 'websearch', config: 'simple' }),
        filters
      ).limit(100),
      supabase.from('products').select('id').ilike('sku', pattern).limit(50),
      supabase.from('products').select('id').ilike('product_name', pattern).limit(50),
    ])

    if (textRes.error) {
      if (NOT_PROVISIONED.includes(textRes.error.code)) return { data: [], missing: true }
      throw textRes.error
    }

    const matchedProductIds = [
      ...new Set([...(skuRes.data ?? []), ...(nameRes.data ?? [])].map((p) => p.id)),
    ]

    // Merge by id — a document whose product AND body both matched must not
    // appear twice.
    const byId = new Map<string, ProductDocumentRow>()
    for (const d of (textRes.data ?? []) as ProductDocumentRow[]) byId.set(d.id, d)

    if (matchedProductIds.length > 0) {
      const { data: byProduct, error } = await applyFilters(
        supabase
          .from('product_documents')
          .select(WITH_PRODUCT_AND_TEXT)
          .is('deleted_at', null)
          .in('product_id', matchedProductIds),
        filters
      )
      if (error) throw error
      for (const d of (byProduct ?? []) as ProductDocumentRow[]) {
        if (!byId.has(d.id)) byId.set(d.id, d)
      }
    }

    return { data: [...byId.values()], missing: false }
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

  /** The hard-delete primitive. Only the purge sweep calls this directly. */
  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('product_documents').delete().eq('id', id)
    if (error) throw error
  },

  /**
   * Moves a document to Trash. Every user-facing delete goes through this —
   * there is deliberately no other path to removing a document, so "it's
   * recoverable for 5 days" is true everywhere, not just in the screen that
   * happened to be rewritten for it.
   */
  async trash(id: string, deletedBy: string): Promise<void> {
    const { error } = await supabase
      .from('product_documents')
      .update({ deleted_at: new Date().toISOString(), deleted_by: deletedBy })
      .eq('id', id)
    if (error) throw error
  },

  async restore(id: string): Promise<void> {
    const { error } = await supabase
      .from('product_documents')
      .update({ deleted_at: null, deleted_by: null })
      .eq('id', id)
    if (error) throw error
  },

  /**
   * Everything currently in Trash and still within its retention window.
   * Excludes anything past the cutoff even if a purge sweep has not run yet
   * — Trash should never claim more time is left than actually is.
   */
  async listTrash(): Promise<ProductDocumentRow[]> {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 86_400_000).toISOString()
    const { data, error } = await supabase
      .from('product_documents')
      .select(WITH_PRODUCT)
      .not('deleted_at', 'is', null)
      .gt('deleted_at', cutoff)
      .order('deleted_at', { ascending: false })
    if (error) {
      if (NOT_PROVISIONED.includes(error.code)) return []
      throw error
    }
    return (data ?? []) as ProductDocumentRow[]
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
    const { data, error } = await supabase
      .from('product_documents')
      .select(DOC_COLUMNS)
      .not('deleted_at', 'is', null)
      .lte('deleted_at', cutoff)
    if (error) {
      if (NOT_PROVISIONED.includes(error.code)) return []
      throw error
    }
    return (data ?? []) as ProductDocumentRow[]
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

  /** How many documents each product has, for the product list. */
  async countsByProduct(): Promise<Record<string, number>> {
    const { data, error } = await supabase
      .from('product_documents')
      .select('product_id')
      .is('deleted_at', null)
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
