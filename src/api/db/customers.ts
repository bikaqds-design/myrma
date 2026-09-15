import { supabase } from '../client.js'
import { assertUpdated, assertAffected, assertAllAffected } from './_assertUpdated.js'
import { fetchPage, fetchAllRows, chunksOf } from './_paging.js'
import type { PagedResult as ServerPage } from './types.js'
import { orIlike } from '../../lib/searchPattern.js'
import { mobileKey } from '../../lib/customerDuplicates.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface CustomerRow {
  id: string
  customer_type: 'B2B' | 'B2C'
  customer_status: string
  contact_person: string
  company_name: string | null
  account_manager: string | null
  mobile: string
  landline: string | null
  email: string | null
  address: string | null
  cr_number: string | null
  tax_id: string | null
  credit_limit: number | null
  notes: string | null
  attachments: unknown[] | null
  created_date: string
  updated_date: string | null
  created_by: string | null
}

export interface CustomerNoteRow {
  id: string
  customer_id: string
  note_text: string
  note_type: string | null
  created_by: string | null
  created_date: string
}

export interface PagedResult<T> {
  data: T[]
  count: number
  page: number
  pageSize: number
  totalPages: number
}

/**
 * What the Customers list is narrowed by. Every field is optional; all given
 * ones must hold (AND). Text matches are case-insensitive substrings, taken
 * literally (see searchPattern).
 */
export interface CustomerFilters {
  /** Matched against name, company, email, mobile, landline and code. */
  search?: string
  status?: string
  type?: string
  /** Matched against contact person and company name only. */
  contactOrCompany?: string
}

/** Columns the list may be sorted by. Anything else falls back to newest first. */
export const CUSTOMER_SORT_COLUMNS = [
  'customer_code',
  'contact_person',
  'company_name',
  'customer_type',
  'mobile',
  'email',
  'customer_status',
  'created_date',
] as const
export type CustomerSortColumn = (typeof CUSTOMER_SORT_COLUMNS)[number]

export interface CustomerSort {
  column: string
  ascending: boolean
}

export interface CustomerPageQuery extends CustomerFilters {
  /** 1-based. */
  page: number
  pageSize: number
  sort?: CustomerSort
}

const SEARCH_COLUMNS = ['contact_person', 'company_name', 'email', 'mobile', 'customer_code', 'landline']

/** The filter methods used here; PostgREST builders return themselves from each. */
interface Filterable<Q> {
  or(filters: string): Q
  eq(column: string, value: unknown): Q
}

function applyCustomerFilters<Q extends Filterable<Q>>(query: Q, filters: CustomerFilters): Q {
  let q = query
  const search = filters.search?.trim()
  if (search) q = q.or(orIlike(SEARCH_COLUMNS, search))
  if (filters.status) q = q.eq('customer_status', filters.status)
  if (filters.type) q = q.eq('customer_type', filters.type)
  const who = filters.contactOrCompany?.trim()
  // A second .or() is a separate query parameter, which PostgREST ANDs with the
  // first — so search and this filter narrow together rather than widening.
  if (who) q = q.or(orIlike(['company_name', 'contact_person'], who))
  return q
}

/**
 * A sort the database can apply. Unknown columns fall back to newest first:
 * the column name reaches the query string, so it is checked, not trusted.
 *
 * Empty values sort first ascending and last descending, which is where the
 * old in-browser sort put them (it compared a missing value as '').
 */
export function resolveCustomerSort(sort?: CustomerSort): { column: CustomerSortColumn; ascending: boolean } {
  const column = (CUSTOMER_SORT_COLUMNS as readonly string[]).includes(sort?.column ?? '')
    ? (sort!.column as CustomerSortColumn)
    : 'created_date'
  const ascending = column === (sort?.column ?? '') ? Boolean(sort?.ascending) : false
  return { column, ascending }
}

// ── Customers ─────────────────────────────────────────────────────────────────

/** A ticket as the Customer Details RMA History tab lists it. */
export interface CustomerTicketRow {
  id: string
  rma_number: string | null
  customer_name: string | null
  customer_id: string | null
  ticket_status: string | null
  priority: string | null
  general_description: string | null
  created_date: string | null
  due_date: string | null
  products: unknown
  assigned_technician: string | null
}

const CUSTOMER_TICKET_COLUMNS =
  'id, rma_number, customer_name, customer_id, ticket_status, priority, general_description, created_date, due_date, products, assigned_technician'

/** One Customer Details activity-log entry (v_customer_activity, 20260865). */
export interface CustomerActivityRow {
  customer_id: string
  event_type: 'ticket' | 'note' | 'created'
  ref_id: string
  event_at: string
  code: string | null
  detail: string | null
  actor: string | null
}

export const customers = {
  /**
   * One page of customers, filtered and sorted in the database, with the exact
   * number that match. What the Customers screen shows. (BUG-066.)
   */
  async listPage(query: CustomerPageQuery): Promise<ServerPage<CustomerRow>> {
    const { column, ascending } = resolveCustomerSort(query.sort)
    return fetchPage<CustomerRow>(
      (from, to) => {
        const base = supabase.from('customers').select('*', { count: 'exact' })
        return applyCustomerFilters(base, query)
          .order(column, { ascending, nullsFirst: ascending })
          .order('id', { ascending: true })
          .range(from, to)
      },
      query.page,
      query.pageSize
    )
  },

  /**
   * Every customer matching the filters, in the list's sort order. For export,
   * where "all" has to mean all — read in chunks, never capped.
   */
  async listAllMatching(filters: CustomerFilters = {}, sort?: CustomerSort): Promise<CustomerRow[]> {
    const { column, ascending } = resolveCustomerSort(sort)
    return fetchAllRows<CustomerRow>((from, to) => {
      // Built in two steps: inlining the select into the generic filter call
      // sends the type checker into TS2589 on supabase-js's builder types.
      const base = supabase.from('customers').select('*')
      return applyCustomerFilters(base, filters)
        .order(column, { ascending, nullsFirst: ascending })
        .order('id', { ascending: true })
        .range(from, to)
    })
  },

  /**
   * Customers for a picker: matching `term` (name, company, email, mobile,
   * landline, code), alphabetical, at most `limit`. A blank term returns the
   * first `limit` alphabetically. Pickers used to filter the whole customer
   * list in the browser, which the Data API caps at 1 000 rows. (BUG-066.)
   */
  async search(term = '', limit = 20): Promise<CustomerRow[]> {
    const page = await customers.listPage({
      search: term,
      page: 1,
      pageSize: limit,
      sort: { column: 'contact_person', ascending: true },
    })
    return page.data
  },

  /** These customers, by id, in one request per 100 ids. Missing ids are simply absent. */
  async getMany(ids: string[]): Promise<CustomerRow[]> {
    const rows: CustomerRow[] = []
    for (const chunk of chunksOf([...new Set(ids.filter(Boolean))], 100)) {
      const { data, error } = await supabase.from('customers').select('*').in('id', chunk)
      if (error) throw error
      rows.push(...((data || []) as CustomerRow[]))
    }
    return rows
  },

  /** How many customers exist, without reading any. */
  async count(): Promise<number> {
    const { count, error } = await supabase.from('customers').select('id', { count: 'exact', head: true })
    if (error) throw error
    return count ?? 0
  },

  /**
   * Which of these company names and contact names are already in use,
   * compared trimmed and case-insensitively — how the CSV importer decides a
   * row with no mobile is a duplicate.
   *
   * The importer used to build these sets from the list the page had loaded,
   * which is capped (BUG-066), so past the cap a name already on file was
   * imported again. This asks the database. A substring match fetches
   * candidates and the exact comparison happens here, because the database
   * cannot trim a value inside a PostgREST filter.
   *
   * @returns the matching names, lower-cased and trimmed
   */
  async findExistingNames(
    companies: string[],
    contacts: string[]
  ): Promise<{ companies: Set<string>; contacts: Set<string> }> {
    const norm = (v: string | null | undefined) => String(v ?? '').trim().toLowerCase()
    const found = { companies: new Set<string>(), contacts: new Set<string>() }
    const lookups: Array<[keyof typeof found, string[]]> = [
      ['companies', [...new Set(companies.map(norm).filter(Boolean))]],
      ['contacts', [...new Set(contacts.map(norm).filter(Boolean))]],
    ]
    for (const [kind, names] of lookups) {
      const column = kind === 'companies' ? 'company_name' : 'contact_person'
      for (const chunk of chunksOf(names, 25)) {
        const wanted = new Set(chunk)
        const filter = chunk.map((name) => orIlike([column], name)).join(',')
        const rows = await fetchAllRows<Record<string, string | null>>((from, to) =>
          supabase.from('customers').select(`id, ${column}`).or(filter).order('id', { ascending: true }).range(from, to)
        )
        for (const row of rows) {
          const name = norm(row[column])
          if (wanted.has(name)) found[kind].add(name)
        }
      }
    }
    return found
  },

  /**
   * @deprecated Loads the whole table, and the Data API returns at most 1 000
   * rows, so past that it is silently incomplete (BUG-066). Still used by the
   * screens not yet moved to server-side paging; do not add callers.
   */
  async get(id: string): Promise<CustomerRow> {
    const { data, error } = await supabase.from('customers').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(customer: Partial<CustomerRow>): Promise<CustomerRow | undefined> {
    const { data, error } = await supabase.from('customers').insert([customer]).select()
    if (error) throw error
    return data?.[0]
  },
  /**
   * Which of these phone numbers already belong to somebody.
   *
   * Asked of the database rather than of the list a page happens to hold. That
   * list is capped at 5 000 rows, so a check built from it is correct only
   * while the table stays under the cap, and then goes quiet without saying so.
   *
   * Matching is on the last nine digits (see mobileKey), so `+20 100 123 4567`
   * and `0100 123 4567` meet. The database cannot compute that key, so this
   * asks for a substring match on each key and compares the tails here.
   * `orIlike` does the escaping: a stored number containing a comma or bracket
   * would otherwise break the filter string outright (BUG-060).
   *
   * Sent in chunks, because the whole filter goes into a URL.
   *
   * @returns a Map from mobile key to the customers holding it
   */
  async findByMobileKeys(keys: string[]): Promise<Map<string, Partial<CustomerRow>[]>> {
    const found = new Map<string, Partial<CustomerRow>[]>()
    const unique = [...new Set(keys.filter(Boolean))]
    const CHUNK = 25
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK)
      const filter = chunk.map((key) => orIlike(['mobile'], key)).join(',')
      const { data, error } = await supabase
        .from('customers')
        .select('id, customer_code, contact_person, company_name, mobile')
        .or(filter)
      if (error) throw error
      for (const row of (data || []) as Partial<CustomerRow>[]) {
        // A substring match is not yet a match: those nine digits also appear
        // inside longer numbers that are not the same phone. The key decides.
        const key = mobileKey(row.mobile)
        if (!key || !chunk.includes(key)) continue
        const bucket = found.get(key)
        if (bucket) bucket.push(row)
        else found.set(key, [row])
      }
    }
    return found
  },
  async bulkCreate(customersData: Partial<CustomerRow>[]): Promise<CustomerRow[]> {
    const { data, error } = await supabase.from('customers').insert(customersData).select()
    if (error) throw error
    return data || []
  },
  async update(id: string, customer: Partial<CustomerRow>): Promise<CustomerRow | undefined> {
    const { data, error } = await supabase.from('customers').update(customer).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Customer')
  },
  async delete(id: string): Promise<void> {
    // Atomic cascade delete via server-side RPC (H-8 fix).
    const { error } = await supabase.rpc('delete_customer_cascade', { p_customer_id: id })
    if (error) {
      if (error.code === 'PGRST202')
        throw new Error(
          'delete_customer_cascade RPC not found. Run supabase/migrations/20260524_customer_cascade_delete.sql first.'
        )
      throw error
    }
  },
  async bulkDelete(ids: string[]): Promise<void> {
    const { error } = await supabase.rpc('delete_customers_cascade', { p_customer_ids: ids })
    if (error) {
      if (error.code === 'PGRST202')
        throw new Error(
          'delete_customers_cascade RPC not found. Run supabase/migrations/20260524_customer_cascade_delete.sql first.'
        )
      throw error
    }
  },
  async bulkUpdateStatus(ids: string[], status: string): Promise<void> {
    const { data, error } = await supabase
      .from('customers')
      .update({ customer_status: status, updated_date: new Date().toISOString() })
      .in('id', ids)
      .select('id')
    if (error) throw error
    assertAllAffected(data, ids, 'customer')
  },
  /**
   * Tickets belonging to a customer, matched by the foreign key ONLY.
   *
   * This used to run a second query matching `customer_name` against a list of
   * the customer's names and merge the results (BUG-040). Names are not
   * identities: two customers called "Ahmed Ali" — and there are already 14
   * duplicate mobile numbers in this data — each saw the other's RMA history,
   * including the description of the fault and the products involved. Renaming
   * a customer also detached the history that was linked only by name.
   *
   * The fallback existed for tickets predating the FK. There is exactly one
   * ticket without a `customer_id` today, RMA-06082026-0001 "QA Walk-in No CRM
   * Link" — a deliberate walk-in with no customer record, which should not
   * appear under anybody. So the name query matched nothing legitimate and
   * could only ever produce cross-exposure.
   *
   * The `customerNames` parameter is kept in the signature and ignored, so the
   * call site in CustomerDetails.jsx needs no coordinated change.
   */
  /**
   * One page of the customer's tickets, newest first, with how many there are.
   * The Customer Details RMA History tab. (BUG-066: it read them all, capped.)
   */
  async relatedTicketsPage(customerId: string, page: number, pageSize: number): Promise<ServerPage<CustomerTicketRow>> {
    return fetchPage<CustomerTicketRow>((from, to) =>
      supabase
        .from('rma_tickets')
        .select(CUSTOMER_TICKET_COLUMNS, { count: 'exact' })
        .eq('customer_id', customerId)
        .order('created_date', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to),
      page, pageSize)
  },
  /** How many tickets the customer has, and how many are open (Open, In Progress, On Hold). */
  async relatedTicketCounts(customerId: string): Promise<{ total: number; open: number }> {
    const head = () => supabase.from('rma_tickets').select('id', { count: 'exact', head: true }).eq('customer_id', customerId)
    const [all, open] = await Promise.all([head(), head().in('ticket_status', ['Open', 'In Progress', 'On Hold'])])
    if (all.error) throw all.error
    if (open.error) throw open.error
    return { total: all.count ?? 0, open: open.count ?? 0 }
  },
  /** One page of the customer's activity log (v_customer_activity, 20260865), newest first. */
  async activityPage(customerId: string, page: number, pageSize: number): Promise<ServerPage<CustomerActivityRow>> {
    return fetchPage<CustomerActivityRow>((from, to) =>
      supabase
        .from('v_customer_activity')
        .select('*', { count: 'exact' })
        .eq('customer_id', customerId)
        .order('event_at', { ascending: false })
        .order('event_type', { ascending: true })
        .order('ref_id', { ascending: true })
        .range(from, to),
      page, pageSize)
  },
  async uploadPhoto(file: File, customerId: string): Promise<string> {
    const fileExt = file.name.split('.').pop()
    const fileName = `customers/customer-${customerId}-${Date.now()}.${fileExt}`
    const { error: uploadError } = await supabase.storage
      .from('rma-attachments')
      .upload(fileName, file, { upsert: true })
    if (uploadError) throw uploadError
    const { data } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return data.publicUrl
  },
}

// ── Customer Notes ────────────────────────────────────────────────────────────

export const customerNotes = {
  /** Every note on the customer, newest first — not the first 1 000. (BUG-066.) */
  async list(customerId: string): Promise<CustomerNoteRow[]> {
    return fetchAllRows<CustomerNoteRow>((from, to) =>
      supabase
        .from('customer_notes')
        .select('*')
        .eq('customer_id', customerId)
        .order('created_date', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
    )
  },
  async create(note: Partial<CustomerNoteRow>): Promise<CustomerNoteRow | undefined> {
    const { data, error } = await supabase.from('customer_notes').insert([note]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, note: Partial<CustomerNoteRow>): Promise<CustomerNoteRow | undefined> {
    const { data, error } = await supabase.from('customer_notes').update(note).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Customer note')
  },
  async delete(id: string): Promise<void> {
    const { data, error } = await supabase.from('customer_notes').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Note')
  },
}
