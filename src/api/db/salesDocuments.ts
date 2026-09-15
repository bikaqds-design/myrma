import { supabase } from '../client.js'
import { assertAffected } from './_assertUpdated.js'
import { fetchPage, fetchAllRows } from './_paging.js'
import type { PagedResult } from './types.js'
import { orIlike, quoteOrValue } from '../../lib/searchPattern.js'

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

/** A document as the Sales Documents page lists it (v_sales_documents_list, 20260860). */
export interface SalesDocumentListRow extends SalesDocumentRow {
  customer_name: string | null
}

// ── Paged reads (BUG-066) ─────────────────────────────────────────────────────
// The page loaded every document and did the tab split, counts, search,
// filters, sort and paging in the browser — past the Data API's 1 000-row cap,
// part of the documents shown as all of them.

/** 'all' and the four types are the active documents; 'archive' the archived ones. */
export type SalesDocTab = 'all' | SalesDocType | 'archive'

export interface SalesDocFilters {
  tab?: SalesDocTab
  status?: string
  rep?: string
  /** Code, customer name or rep. */
  search?: string
  /** A rep scoped to their own documents: assigned to them or raised by them. */
  ownerEmail?: string | null
}

export interface SalesDocSort {
  key: string
  direction: 'asc' | 'desc'
}

export interface SalesDocSummary {
  counts: Record<SalesDocTab, number>
  statuses: string[]
  reps: string[]
}

interface SalesDocFilterable<Q> {
  eq(column: string, value: unknown): Q
  or(filters: string): Q
}

export function applySalesDocFilters<Q extends SalesDocFilterable<Q>>(query: Q, f: SalesDocFilters): Q {
  let q = query
  if (f.tab === 'archive') q = q.eq('archived', true)
  else {
    q = q.eq('archived', false)
    if (f.tab && f.tab !== 'all') q = q.eq('doc_type', f.tab)
  }
  if (f.ownerEmail) {
    const owner = quoteOrValue(f.ownerEmail)
    q = q.or(`assigned_rep.eq.${owner},created_by.eq.${owner}`)
  }
  if (f.status) q = q.eq('doc_status', f.status)
  if (f.rep) q = q.eq('assigned_rep', f.rep)
  const search = f.search?.trim()
  // A second .or() is ANDed with the owner's by PostgREST.
  if (search) q = q.or(orIlike(['doc_code', 'customer_name', 'assigned_rep'], search))
  return q
}

/**
 * Sortable columns → the column ordered on. Codes, customers and reps sort
 * case-insensitively; a row with no customer sorts after every name; a missing
 * date sorts first, as the page's `new Date(0)` did.
 */
export function resolveSalesDocSort(sort?: SalesDocSort): { column: string; ascending: boolean; nullsFirst: boolean } {
  const ascending = sort ? sort.direction === 'asc' : false
  switch (sort?.key) {
    case 'doc_type':
    case 'doc_status':
    case 'type_specific_date':
      return { column: sort.key, ascending, nullsFirst: ascending }
    case 'doc_code':
      return { column: 'doc_code_sort', ascending, nullsFirst: ascending }
    case 'assigned_rep':
      return { column: 'rep_sort', ascending, nullsFirst: ascending }
    case 'customer':
      return { column: 'customer_sort', ascending, nullsFirst: !ascending }
    case 'total':
      return { column: 'total_sort', ascending, nullsFirst: ascending }
    case 'created_at':
      return { column: 'created_at', ascending, nullsFirst: ascending }
    default:
      return { column: 'created_at', ascending: false, nullsFirst: false }
  }
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
   * One page of documents, filtered and sorted in the database, with the exact
   * number that match. RLS is inherited from the underlying tables (the views
   * are security invoker), so staff see only their own rows and manager+ see
   * everything. The same row can exist once per document table, so the tie
   * breaker is type then id.
   */
  async listPage(filters: SalesDocFilters, sort: SalesDocSort | undefined, page: number, pageSize: number): Promise<PagedResult<SalesDocumentListRow>> {
    const { column, ascending, nullsFirst } = resolveSalesDocSort(sort)
    return fetchPage<SalesDocumentListRow>((from, to) => {
      const base = supabase.from('v_sales_documents_list').select('*', { count: 'exact' })
      return applySalesDocFilters(base, filters)
        .order(column, { ascending, nullsFirst })
        .order('doc_type', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    }, page, pageSize)
  },

  /** Every document matching the filters, in the list's order — for an export. */
  async listAllMatching(filters: SalesDocFilters, sort?: SalesDocSort): Promise<SalesDocumentListRow[]> {
    const { column, ascending, nullsFirst } = resolveSalesDocSort(sort)
    return fetchAllRows<SalesDocumentListRow>((from, to) => {
      const base = supabase.from('v_sales_documents_list').select('*')
      return applySalesDocFilters(base, filters)
        .order(column, { ascending, nullsFirst })
        .order('doc_type', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    })
  },

  /** Tab counts, the statuses present in `tab`, and every rep — for one owner or all. */
  async summary(tab: SalesDocTab, ownerEmail?: string | null): Promise<SalesDocSummary> {
    const { data, error } = await supabase.rpc('rma_sales_document_summary', {
      p_tab: tab,
      p_owner: ownerEmail || null,
    })
    if (error) throw error
    const s = (data ?? {}) as Partial<SalesDocSummary>
    const counts = (s.counts ?? {}) as Partial<Record<SalesDocTab, number>>
    return {
      counts: {
        all: Number(counts.all ?? 0),
        quotation: Number(counts.quotation ?? 0),
        sales_order: Number(counts.sales_order ?? 0),
        invoice: Number(counts.invoice ?? 0),
        credit_note: Number(counts.credit_note ?? 0),
        archive: Number(counts.archive ?? 0),
      },
      statuses: s.statuses ?? [],
      reps: s.reps ?? [],
    }
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
