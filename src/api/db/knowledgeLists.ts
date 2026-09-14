/**
 * Paged reads for the Knowledge Center's Vault tab. (Audit finding BUG-066,
 * phase 5b.)
 *
 * The tab loaded the whole catalogue and every document, built the folder tree
 * in the browser and paged the result there — past the Data API's 1 000-row
 * cap, folders silently lost products and the documents under them. These read
 * the views of `20260855_knowledge_explorer_views.sql` a folder, or a page, at
 * a time; the placement and roll-up rules live there.
 */
import { supabase } from '../client.js'
import { fetchPage, fetchAllRows, pageBounds } from './_paging.js'
import type { RangeResponse } from './_paging.js'
import type { PagedResult } from './types.js'
import type { DocType, ProductDocumentRow } from './documents.js'
import { TRASH_RETENTION_DAYS } from './documents.js'

export const KNOWLEDGE_ROOT = '__root__'

const NOT_PROVISIONED = ['42P01', 'PGRST205']

// ── Row types ─────────────────────────────────────────────────────────────────

export type KnowledgeNodeKind = 'brand' | 'category' | 'subcategory' | 'product'

export interface KnowledgeNodeRow {
  id: string
  kind: KnowledgeNodeKind
  kind_rank: number
  name: string
  parent_id: string
  /** Ancestor folder ids from the brand down, this folder included; the root is not listed. */
  path: string[]
  sku: string | null
  logo_url: string | null
  image_url: string | null
  doc_count: number
  doc_bytes: number
  modified: string | null
  child_count: number
}

/** A document as the Vault shows it: the product joined on, and where it is filed. */
export interface KnowledgeDocumentRow extends ProductDocumentRow {
  path: string[]
  /** "Brand / Category / Subcategory / Product". */
  folder_path: string
}

export type BrowseRow =
  | { id: string; kind: 'folder'; node: KnowledgeNodeRow }
  | { id: string; kind: 'document'; doc: KnowledgeDocumentRow }

export interface FolderStats {
  total: number
  unsearchable: number
  by_type: Partial<Record<DocType, number>>
}

export interface VaultFilters {
  /** The folder searched or filtered within; the root (or nothing) is the whole library. */
  folderId?: string | null
  /** Text search. When set, documents match on their text or their product's SKU or name. */
  query?: string | null
  docType?: DocType | null
  /** Only documents whose text was readable. */
  searchableOnly?: boolean
  /** Only documents whose text was not readable. */
  notSearchableOnly?: boolean
}

// Everything but the document body, which only a search shows (for its snippet).
const DOC_COLUMNS = [
  'id', 'product_id', 'title', 'doc_type', 'description', 'file_name', 'file_url', 'storage_path',
  'file_size', 'mime_type', 'extraction_status', 'page_count', 'uploaded_by', 'created_at', 'updated_at',
  'deleted_at', 'deleted_by', 'product_sku', 'product_name', 'product_brand_id', 'product_category_id',
  'product_subcategory_id', 'path', 'folder_path',
].join(', ')
const DOC_COLUMNS_WITH_TEXT = `${DOC_COLUMNS}, extracted_text`

type ViewDocument = Omit<KnowledgeDocumentRow, 'product'> & {
  product_sku: string | null
  product_name: string | null
  product_brand_id: string | null
  product_category_id: string | null
  product_subcategory_id: string | null
}

/** The view flattens the product; the document components expect it nested. */
export function toDocument(row: ViewDocument): KnowledgeDocumentRow {
  const { product_sku, product_name, product_brand_id, product_category_id, product_subcategory_id, ...doc } = row
  return {
    ...doc,
    product: {
      id: doc.product_id,
      sku: product_sku ?? '',
      product_name: product_name ?? '',
      brand_id: product_brand_id,
      category_id: product_category_id,
      subcategory_id: product_subcategory_id,
    },
  }
}

interface Filterable<Q> {
  eq(column: string, value: unknown): Q
  neq(column: string, value: unknown): Q
  contains(column: string, value: unknown): Q
}

/**
 * Scope and filters shared by the document page and, through the same folder
 * rule, the sidebar counts: a folder is everything whose path contains it.
 */
export function applyVaultFilters<Q extends Filterable<Q>>(query: Q, f: VaultFilters): Q {
  let q = query
  if (f.folderId && f.folderId !== KNOWLEDGE_ROOT) q = q.contains('path', [f.folderId])
  if (f.docType) q = q.eq('doc_type', f.docType)
  if (f.searchableOnly) q = q.eq('extraction_status', 'ok')
  if (f.notSearchableOnly) q = q.neq('extraction_status', 'ok')
  return q
}

function orderFolders<Q extends { order(column: string, options?: { ascending?: boolean }): Q }>(q: Q): Q {
  return q.order('kind_rank', { ascending: true }).order('name', { ascending: true }).order('id', { ascending: true })
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export const knowledgeLists = {
  /** Whether the library is provisioned, without reading it. */
  async isProvisioned(): Promise<boolean> {
    const { error } = await supabase.from('product_documents').select('id', { count: 'exact', head: true })
    if (!error) return true
    if (NOT_PROVISIONED.includes(error.code ?? '')) return false
    throw error
  },

  /** One folder, or null for the root and for an id that is not a folder. */
  async folder(id: string | null | undefined): Promise<KnowledgeNodeRow | null> {
    if (!id || id === KNOWLEDGE_ROOT) return null
    const { data, error } = await supabase.from('v_knowledge_nodes').select('*').eq('id', id).maybeSingle()
    if (error) throw error
    return (data as KnowledgeNodeRow | null) ?? null
  },

  /** The folders on a path, in path order. */
  async foldersOnPath(path: string[]): Promise<KnowledgeNodeRow[]> {
    if (!path.length) return []
    const { data, error } = await supabase.from('v_knowledge_nodes').select('*').in('id', path)
    if (error) throw error
    const byId = new Map(((data ?? []) as KnowledgeNodeRow[]).map((n) => [n.id, n]))
    return path.map((id) => byId.get(id)).filter((n): n is KnowledgeNodeRow => Boolean(n))
  },

  /** A folder's first `limit` child folders and how many there are, for the sidebar tree. */
  async childFolders(parentId: string, limit: number): Promise<{ data: KnowledgeNodeRow[]; count: number }> {
    const { data, error, count } = await orderFolders(
      supabase.from('v_knowledge_nodes').select('*', { count: 'exact' }).eq('parent_id', parentId)
    ).range(0, Math.max(0, limit - 1))
    if (error) throw error
    return { data: (data ?? []) as KnowledgeNodeRow[], count: count ?? 0 }
  },

  /** Every child folder of a kind — the brand and category pickers. */
  async allChildFolders(parentId: string, kind: KnowledgeNodeKind): Promise<KnowledgeNodeRow[]> {
    return fetchAllRows<KnowledgeNodeRow>((from, to) =>
      orderFolders(supabase.from('v_knowledge_nodes').select('*').eq('parent_id', parentId).eq('kind', kind)).range(from, to)
    )
  },

  /**
   * One page of a folder's contents: its child folders first, then the live
   * documents filed directly in it, as the tree listed them.
   */
  async browsePage(folderId: string, page: number, pageSize: number): Promise<PagedResult<BrowseRow>> {
    const { from, to } = pageBounds(page, pageSize)
    const size = to - from + 1

    const folderQuery = supabase
      .from('v_knowledge_nodes')
      .select('*', { count: 'exact' })
      .eq('parent_id', folderId)
    const folders = await orderFolders(folderQuery).range(from, to)
    // Past the last folder PostgREST answers 416; the folders are simply done.
    if (folders.error && folders.error.code !== 'PGRST103') throw folders.error
    let folderCount = folders.count ?? 0
    if (folders.error) {
      const head = await supabase.from('v_knowledge_nodes').select('id', { count: 'exact', head: true }).eq('parent_id', folderId)
      if (head.error) throw head.error
      folderCount = head.count ?? 0
    }
    const folderRows = folders.error ? [] : ((folders.data ?? []) as KnowledgeNodeRow[])

    // Only product folders hold documents.
    const docFrom = Math.max(0, from - folderCount)
    const docSlots = size - folderRows.length
    let docRows: KnowledgeDocumentRow[] = []
    let docCount = 0
    if (folderId !== KNOWLEDGE_ROOT) {
      const docs = await supabase
        .from('v_knowledge_documents')
        .select(DOC_COLUMNS, { count: 'exact' })
        .eq('product_id', folderId)
        .is('deleted_at', null)
        .order('title', { ascending: true })
        .order('id', { ascending: true })
        .range(docFrom, docFrom + Math.max(0, docSlots - 1))
      if (docs.error && docs.error.code !== 'PGRST103') throw docs.error
      docCount = docs.count ?? 0
      if (docs.error) {
        const head = await supabase
          .from('v_knowledge_documents')
          .select('id', { count: 'exact', head: true })
          .eq('product_id', folderId)
          .is('deleted_at', null)
        if (head.error) throw head.error
        docCount = head.count ?? 0
      }
      if (!docs.error && docSlots > 0) docRows = ((docs.data ?? []) as unknown as ViewDocument[]).map(toDocument)
    }

    const total = folderCount + docCount
    return {
      missing: false,
      data: [
        ...folderRows.map((node): BrowseRow => ({ id: node.id, kind: 'folder', node })),
        ...docRows.map((doc): BrowseRow => ({ id: doc.id, kind: 'document', doc })),
      ],
      count: total,
      page: Math.max(1, Math.floor(page) || 1),
      pageSize: size,
      totalPages: Math.ceil(total / size),
    }
  },

  /** One page of live documents matching a search or filters within a folder, by title. */
  async documentsPage(filters: VaultFilters, page: number, pageSize: number): Promise<PagedResult<KnowledgeDocumentRow>> {
    const term = filters.query?.trim()
    const result = await fetchPage<ViewDocument>((from, to): PromiseLike<RangeResponse> => {
      if (term) {
        // The body comes back only for a search, to build the snippet showing why each result matched.
        const matching = supabase
          .rpc('rma_knowledge_documents_matching', { p_term: term }, { count: 'exact' })
          .select(DOC_COLUMNS_WITH_TEXT)
        return applyVaultFilters(matching.is('deleted_at', null), filters)
          .order('title', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to) as unknown as PromiseLike<RangeResponse>
      }
      const browse = supabase.from('v_knowledge_documents').select(DOC_COLUMNS, { count: 'exact' })
      return applyVaultFilters(browse.is('deleted_at', null), filters)
        .order('title', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    }, page, pageSize)
    return { ...result, data: result.data.map(toDocument) }
  },

  /** Live documents beneath a folder: total, not searchable, and per type. */
  async folderStats(folderId: string | null | undefined): Promise<FolderStats> {
    const { data, error } = await supabase.rpc('rma_knowledge_folder_stats', { p_folder: folderId || KNOWLEDGE_ROOT })
    if (error) throw error
    const stats = (data ?? {}) as Partial<FolderStats>
    return { total: Number(stats.total ?? 0), unsearchable: Number(stats.unsearchable ?? 0), by_type: stats.by_type ?? {} }
  },

  /** The most recently changed live documents. */
  async recent(limit: number): Promise<KnowledgeDocumentRow[]> {
    const { data, error } = await supabase
      .from('v_knowledge_documents')
      .select(DOC_COLUMNS)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(limit)
    if (error) throw error
    return ((data ?? []) as unknown as ViewDocument[]).map(toDocument)
  },

  /** Everything in Trash within its retention window, newest first — all of it, in chunks. */
  async trash(): Promise<KnowledgeDocumentRow[]> {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 86_400_000).toISOString()
    const rows = await fetchAllRows<ViewDocument>((from, to) =>
      supabase
        .from('v_knowledge_documents')
        .select(DOC_COLUMNS)
        .not('deleted_at', 'is', null)
        .gt('deleted_at', cutoff)
        .order('deleted_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
    )
    return rows.map(toDocument)
  },
}
