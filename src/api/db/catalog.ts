import { supabase } from '../client.js'
import { assertUpdated, assertAffected, assertAllAffected } from './_assertUpdated.js'
import { orIlike, escapeLike, quoteOrValue, containsPattern } from '../../lib/searchPattern.js'
import { fetchPage, fetchAllRows, chunksOf } from './_paging.js'
import type { PagedResult as ServerPage } from './types.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface BrandRow {
  id: string
  brand_name: string
  brand_description: string | null
  brand_logo_url: string | null
  status: 'active' | 'inactive' | null
  created_date: string | null
  created_by: string | null
  updated_date: string | null
  updated_by: string | null
  // Vendor fields (Purchasing redesign — Brands ARE the vendors, 20260756).
  contact_person: string | null
  email: string | null
  phone: string | null
  tax_id: string | null
  payment_terms: string | null
}

export interface CategoryRow {
  id: string
  brand_id: string
  category_name: string
  created_date: string
  brand?: Pick<BrandRow, 'id' | 'brand_name'>
}

export interface SubcategoryRow {
  id: string
  category_id: string
  subcategory_name: string
  created_date: string
  category?: Pick<CategoryRow, 'id' | 'category_name' | 'brand_id'>
}

export interface ProductRow {
  id: string
  sku: string
  product_name: string
  brand_id: string | null
  category_id: string | null
  subcategory_id: string | null
  product_type: string
  stock_tracking_mode: 'serialized' | 'bulk'
  status: string
  warranty_months: number | null
  product_description: string | null
  product_link: string | null
  product_image_url: string | null
  updated_by: string | null
  updated_date: string | null
  created_date: string
  brand?: Pick<BrandRow, 'id' | 'brand_name' | 'brand_logo_url'>
  category?: Pick<CategoryRow, 'id' | 'category_name'>
  subcategory?: Pick<SubcategoryRow, 'id' | 'subcategory_name'>
}

export interface PagedResult<T> {
  data: T[]
  count: number
  page: number
  pageSize: number
  totalPages: number
}

// ── Brands ────────────────────────────────────────────────────────────────────

export const brands = {
  async list(): Promise<BrandRow[]> {
    const { data, error } = await supabase
      .from('brands')
      .select('*')
      .order('brand_name', { ascending: true })
    if (error) throw error
    return data || []
  },
  async create(brand: Partial<BrandRow>): Promise<BrandRow | undefined> {
    const { data, error } = await supabase.from('brands').insert([brand]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, brand: Partial<BrandRow>): Promise<BrandRow | undefined> {
    const { data, error } = await supabase.from('brands').update(brand).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Brand')
  },
  async delete(id: string): Promise<void> {
    const { data, error } = await supabase.from('brands').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Brand')
  },
}

// ── Categories ────────────────────────────────────────────────────────────────

export const categories = {
  async list(): Promise<CategoryRow[]> {
    const { data, error } = await supabase
      .from('categories')
      .select('*, brand:brands(id, brand_name)')
      .order('category_name', { ascending: true })
    if (error) throw error
    return data || []
  },
  async listByBrand(brandId: string): Promise<CategoryRow[]> {
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .eq('brand_id', brandId)
      .order('category_name', { ascending: true })
    if (error) throw error
    return data || []
  },
  async create(category: Partial<CategoryRow>): Promise<CategoryRow | undefined> {
    const { data, error } = await supabase.from('categories').insert([category]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, category: Partial<CategoryRow>): Promise<CategoryRow | undefined> {
    const { data, error } = await supabase.from('categories').update(category).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Category')
  },
  async delete(id: string): Promise<void> {
    const { data, error } = await supabase.from('categories').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Category')
  },
}

// ── Subcategories ─────────────────────────────────────────────────────────────

export const subcategories = {
  async list(): Promise<SubcategoryRow[]> {
    const { data, error } = await supabase
      .from('subcategories')
      .select('*, category:categories(id, category_name, brand_id)')
      .order('subcategory_name', { ascending: true })
    if (error) throw error
    return data || []
  },
  async listByCategory(categoryId: string): Promise<SubcategoryRow[]> {
    const { data, error } = await supabase
      .from('subcategories')
      .select('*')
      .eq('category_id', categoryId)
      .order('subcategory_name', { ascending: true })
    if (error) throw error
    return data || []
  },
  async create(subcategory: Partial<SubcategoryRow>): Promise<SubcategoryRow | undefined> {
    const { data, error } = await supabase.from('subcategories').insert([subcategory]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, subcategory: Partial<SubcategoryRow>): Promise<SubcategoryRow | undefined> {
    const { data, error } = await supabase
      .from('subcategories')
      .update(subcategory)
      .eq('id', id)
      .select()
    if (error) throw error
    return assertUpdated(data, 'Subcategory')
  },
  async delete(id: string): Promise<void> {
    const { data, error } = await supabase.from('subcategories').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Subcategory')
  },
}

// ── Server-side product list (BUG-066) ────────────────────────────────────────

const PRODUCT_SELECT =
  '*, brand:brands(id, brand_name, brand_logo_url), category:categories(id, category_name), subcategory:subcategories(id, subcategory_name)'

/**
 * What the Products list is narrowed by. All given fields must hold (AND).
 *
 * Brand and category are filtered by NAME, as the screen always has — and two
 * brands can each have a category called "Laptops", so a name can mean several
 * ids. Names live in their own tables, which PostgREST cannot OR against a
 * product's columns, so the matching ids are looked up first and products are
 * filtered by id. Brands and categories are small lookup tables.
 */
export interface ProductFilters {
  /** Matched against name, SKU, description, brand name and category name. */
  search?: string
  /** Exact brand name. */
  brandName?: string
  /** Exact category name. */
  categoryName?: string
  status?: string
  /** One category, by id (the Hierarchy tab). */
  categoryId?: string
  /** One brand, by id (Purchasing: a vendor's products). */
  brandId?: string
  /** Leave out service products (they never hold stock). */
  excludeService?: boolean
}

export interface ProductSort {
  column: string
  ascending: boolean
}

export interface ProductPageQuery extends ProductFilters {
  /** 1-based. */
  page: number
  pageSize: number
  sort?: ProductSort
}

/**
 * Sort keys the screen uses, mapped to what PostgREST orders by. Brand and
 * category order through the embedded to-one relation — `brand(brand_name)` —
 * which the live API supports (checked 2026-09-14).
 */
const PRODUCT_SORT_COLUMNS: Record<string, string> = {
  sku: 'sku',
  product_name: 'product_name',
  brand: 'brand(brand_name)',
  category: 'category(category_name)',
  product_type: 'product_type',
  status: 'status',
  created_date: 'created_date',
}

export function resolveProductSort(sort?: ProductSort): { column: string; ascending: boolean } {
  const column = sort ? PRODUCT_SORT_COLUMNS[sort.column] : undefined
  return column ? { column, ascending: Boolean(sort!.ascending) } : { column: 'created_date', ascending: false }
}

/** Ids in `table` whose `column` matches: exactly (case-sensitive, as the filter always was) or containing `term`. */
async function idsWhere(table: 'brands' | 'categories', column: string, value: string, mode: 'exact' | 'contains'): Promise<string[]> {
  const rows = await fetchAllRows<{ id: string }>((from, to) => {
    const base = supabase.from(table).select('id')
    const filtered = mode === 'exact' ? base.eq(column, value) : base.ilike(column, containsPattern(value))
    return filtered.order('id', { ascending: true }).range(from, to)
  })
  return rows.map((r) => r.id)
}

/** The filter set as PostgREST operations, with names already resolved to ids. */
interface ResolvedProductFilters {
  searchOr: string | null
  brandIds: string[] | null
  categoryIds: string[] | null
  status: string | null
  categoryId: string | null
  brandId: string | null
  excludeService: boolean
}

async function resolveProductFilters(filters: ProductFilters): Promise<ResolvedProductFilters> {
  const term = filters.search?.trim() || ''
  let searchOr: string | null = null
  if (term) {
    const [brandIds, categoryIds] = await Promise.all([
      idsWhere('brands', 'brand_name', term, 'contains'),
      idsWhere('categories', 'category_name', term, 'contains'),
    ])
    const parts = [orIlike(['product_name', 'sku', 'product_description'], term)]
    if (brandIds.length) parts.push(`brand_id.in.(${brandIds.join(',')})`)
    if (categoryIds.length) parts.push(`category_id.in.(${categoryIds.join(',')})`)
    searchOr = parts.join(',')
  }
  const [brandIds, categoryIds] = await Promise.all([
    filters.brandName ? idsWhere('brands', 'brand_name', filters.brandName, 'exact') : Promise.resolve(null),
    filters.categoryName ? idsWhere('categories', 'category_name', filters.categoryName, 'exact') : Promise.resolve(null),
  ])
  return {
    searchOr,
    brandIds,
    categoryIds,
    status: filters.status || null,
    categoryId: filters.categoryId || null,
    brandId: filters.brandId || null,
    excludeService: Boolean(filters.excludeService),
  }
}

interface ProductFilterable<Q> {
  or(filters: string): Q
  eq(column: string, value: unknown): Q
  neq(column: string, value: unknown): Q
  in(column: string, values: unknown[]): Q
}

function applyProductFilters<Q extends ProductFilterable<Q>>(query: Q, f: ResolvedProductFilters): Q {
  let q = query
  if (f.searchOr) q = q.or(f.searchOr)
  // An unknown name resolves to no ids, and `in.()` matches nothing — which is
  // what filtering by a brand nobody has should show.
  if (f.brandIds) q = q.in('brand_id', f.brandIds)
  if (f.categoryIds) q = q.in('category_id', f.categoryIds)
  if (f.status) q = q.eq('status', f.status)
  if (f.categoryId) q = q.eq('category_id', f.categoryId)
  if (f.brandId) q = q.eq('brand_id', f.brandId)
  // A product with no type is not a service; neq alone would drop it.
  if (f.excludeService) q = q.or('product_type.is.null,product_type.neq.service')
  return q
}

export interface ProductHierarchyCounts {
  total: number
  byBrand: Record<string, number>
  byCategory: Record<string, number>
}

// ── Products ──────────────────────────────────────────────────────────────────

export const products = {
  /** One page of products, filtered and sorted in the database, with the exact number that match. */
  async listPage(query: ProductPageQuery): Promise<ServerPage<ProductRow>> {
    const resolved = await resolveProductFilters(query)
    const { column, ascending } = resolveProductSort(query.sort)
    return fetchPage<ProductRow>(
      (from, to) => {
        const base = supabase.from('products').select(PRODUCT_SELECT, { count: 'exact' })
        return applyProductFilters(base, resolved)
          .order(column, { ascending, nullsFirst: ascending })
          .order('id', { ascending: true })
          .range(from, to)
      },
      query.page,
      query.pageSize
    )
  },

  /** Every product matching the filters, in the list's order. For export. */
  async listAllMatching(filters: ProductFilters = {}, sort?: ProductSort): Promise<ProductRow[]> {
    const resolved = await resolveProductFilters(filters)
    const { column, ascending } = resolveProductSort(sort)
    return fetchAllRows<ProductRow>((from, to) => {
      const base = supabase.from('products').select(PRODUCT_SELECT)
      return applyProductFilters(base, resolved)
        .order(column, { ascending, nullsFirst: ascending })
        .order('id', { ascending: true })
        .range(from, to)
    })
  },

  /**
   * Products for a picker: matching `term` (name, SKU, description, brand or
   * category name), alphabetical, at most `limit`. Pickers used to filter the
   * whole product list in the browser, which the Data API caps. (BUG-066.)
   */
  async search(
    term = '',
    { limit = 8, brandId, excludeService }: { limit?: number; brandId?: string; excludeService?: boolean } = {}
  ): Promise<ProductRow[]> {
    const page = await products.listPage({
      search: term,
      brandId,
      excludeService,
      page: 1,
      pageSize: limit,
      sort: { column: 'product_name', ascending: true },
    })
    return page.data
  },

  /** These products, by id, in one request per 100 ids. */
  async getMany(ids: string[]): Promise<ProductRow[]> {
    const rows: ProductRow[] = []
    for (const chunk of chunksOf([...new Set(ids.filter(Boolean))], 100)) {
      const { data, error } = await supabase.from('products').select(PRODUCT_SELECT).in('id', chunk)
      if (error) throw error
      rows.push(...((data || []) as ProductRow[]))
    }
    return rows
  },

  /**
   * Products by exact name, as `{ [name]: product }`. Where names repeat, the
   * most recently created wins — what `.find()` over the old newest-first list
   * returned, so a lookup by name resolves to the same product it did.
   */
  async findByNames(names: string[]): Promise<Record<string, ProductRow>> {
    const byName: Record<string, ProductRow> = {}
    for (const chunk of chunksOf([...new Set(names.filter(Boolean))], 50)) {
      const { data, error } = await supabase
        .from('products')
        .select(PRODUCT_SELECT)
        .in('product_name', chunk)
        .order('created_date', { ascending: false })
      if (error) throw error
      for (const row of (data || []) as ProductRow[]) {
        if (row.product_name && !byName[row.product_name]) byName[row.product_name] = row
      }
    }
    return byName
  },

  /** How many products exist, without reading any. */
  async count(): Promise<number> {
    const { count, error } = await supabase.from('products').select('id', { count: 'exact', head: true })
    if (error) throw error
    return count ?? 0
  },

  /** Product totals overall, per brand and per category (20260853). */
  async hierarchyCounts(): Promise<ProductHierarchyCounts> {
    const { data, error } = await supabase.rpc('rma_product_hierarchy_counts')
    if (error) throw error
    const d = (data ?? {}) as { total?: number; by_brand?: Record<string, number>; by_category?: Record<string, number> }
    return { total: Number(d.total ?? 0), byBrand: d.by_brand ?? {}, byCategory: d.by_category ?? {} }
  },

  /**
   * Which of these SKUs already exist, compared case-insensitively — how the
   * CSV importer skips duplicates. It used to compare against the product list
   * the page had loaded, which is capped (BUG-066), so past the cap an existing
   * SKU was imported a second time.
   *
   * @returns the existing SKUs, lower-cased
   */
  async findExistingSkus(skus: string[]): Promise<Set<string>> {
    const wanted = [...new Set(skus.map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean))]
    const found = new Set<string>()
    for (const chunk of chunksOf(wanted, 50)) {
      // Case-insensitive exact match: ILIKE with the value escaped and no wildcards.
      const filter = chunk.map((sku) => `sku.ilike.${quoteOrValue(escapeLike(sku))}`).join(',')
      const rows = await fetchAllRows<{ sku: string | null }>((from, to) =>
        supabase.from('products').select('id, sku').or(filter).order('id', { ascending: true }).range(from, to)
      )
      for (const row of rows) {
        const sku = String(row.sku ?? '').trim().toLowerCase()
        if (chunk.includes(sku)) found.add(sku)
      }
    }
    return found
  },

  /**
   * @deprecated Loads the whole table, and the Data API returns at most 1 000
   * rows, so past that it is silently incomplete (BUG-066). Still used by
   * screens not yet moved to server-side paging; do not add callers.
   */
  async list(): Promise<ProductRow[]> {
    const { data, error } = await supabase
      .from('products')
      .select(
        '*, brand:brands(id, brand_name, brand_logo_url), category:categories(id, category_name), subcategory:subcategories(id, subcategory_name)'
      )
      .order('created_date', { ascending: false })
      .limit(5000)
    if (error) throw error
    return data || []
  },
  async listPaged(page = 0, pageSize = 50): Promise<PagedResult<ProductRow>> {
    const from = page * pageSize
    const { data, count, error } = await supabase
      .from('products')
      .select(
        '*, brand:brands(id, brand_name, brand_logo_url), category:categories(id, category_name), subcategory:subcategories(id, subcategory_name)',
        { count: 'exact' }
      )
      .order('created_date', { ascending: false })
      .range(from, from + pageSize - 1)
    if (error) throw error
    return {
      data: data || [],
      count: count || 0,
      page,
      pageSize,
      totalPages: Math.ceil((count || 0) / pageSize),
    }
  },
  async get(id: string): Promise<ProductRow> {
    const { data, error } = await supabase
      .from('products')
      .select(
        '*, brand:brands(id, brand_name, brand_logo_url), category:categories(id, category_name), subcategory:subcategories(id, subcategory_name)'
      )
      .eq('id', id)
      .single()
    if (error) throw error
    return data
  },
  async create(product: Partial<ProductRow>): Promise<ProductRow | undefined> {
    const { data, error } = await supabase.from('products').insert([product]).select()
    if (error) throw error
    return data?.[0]
  },

  /**
   * hasStock: does this product hold any stock under EITHER tracking model?
   *
   * Gates the `stock_tracking_mode` selector. The two models live in different
   * tables — serialized in `inventory_units`, bulk in `warehouse_stock` — and
   * every reader picks its table from the product's current mode. Flipping the
   * mode while stock exists therefore does not migrate anything: it just points
   * every view at the empty table, and the stock silently vanishes from the UI
   * while still sitting in the database.
   *
   * So the mode is editable only while both sides are empty. `20260772` enforces
   * the same rule in Postgres; this is the check that lets the form disable the
   * control and explain why, instead of waiting for the trigger to raise.
   *
   * Counts live units only (`company_stock`/`active_rma`) — matching
   * v_product_stock_summary — so a product whose units are all sold/scrapped is still
   * free to switch.
   */
  async hasStock(productId: string): Promise<boolean> {
    const [unitsRes, bulkRes] = await Promise.all([
      supabase
        .from('inventory_units')
        .select('id', { count: 'exact', head: true })
        .eq('product_id', productId)
        .in('status', ['company_stock', 'active_rma']),
      supabase
        .from('warehouse_stock')
        .select('id', { count: 'exact', head: true })
        .eq('product_id', productId)
        .gt('quantity', 0),
    ])
    if (unitsRes.error) throw unitsRes.error
    // warehouse_stock may not exist on an un-migrated database — treat as empty.
    if (bulkRes.error && bulkRes.error.code !== '42P01') throw bulkRes.error
    return (unitsRes.count ?? 0) > 0 || (bulkRes.count ?? 0) > 0
  },
  async bulkCreate(productsData: Partial<ProductRow>[]): Promise<ProductRow[]> {
    const { data, error } = await supabase.from('products').insert(productsData).select()
    if (error) throw error
    return data || []
  },
  async update(id: string, product: Partial<ProductRow>): Promise<ProductRow | undefined> {
    const { data, error } = await supabase.from('products').update(product).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Product')
  },
  async delete(id: string): Promise<void> {
    const { data, error } = await supabase.from('products').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Product')
  },
  async bulkDelete(ids: string[]): Promise<void> {
    const { data, error } = await supabase.from('products').delete().in('id', ids).select('id')
    if (error) throw error
    assertAllAffected(data, ids, 'product')
  },
  async bulkUpdateStatus(ids: string[], status: string): Promise<void> {
    const { data, error } = await supabase
      .from('products')
      .update({ status, updated_date: new Date().toISOString() })
      .in('id', ids)
      .select('id')
    if (error) throw error
    assertAllAffected(data, ids, 'product')
  },
  /**
   * Tickets that returned this product.
   *
   * This used to filter `rma_tickets.product_id`. The column exists, so the
   * query succeeded and returned nothing — every time, for every product,
   * because nothing writes it: all 13 tickets in the live data have it null.
   * The product page's RMA History tab therefore always read (0), while 11
   * products actually had history.
   *
   * A ticket carries its items in the `products` jsonb array, so there is no
   * single column to join on. The real link is inventory_units, which holds
   * both product_id and rma_ticket_id — one row per returned unit. Reading the
   * ticket ids from there and fetching those tickets follows the association
   * that the RMA flow genuinely creates.
   */
  async getRelatedTickets(productId: string): Promise<unknown[]> {
    const { data: units, error: unitErr } = await supabase
      .from('inventory_units')
      .select('rma_ticket_id')
      .eq('product_id', productId)
      .not('rma_ticket_id', 'is', null)
    if (unitErr) throw unitErr

    const ticketIds = [...new Set((units || []).map((u) => u.rma_ticket_id))]
    if (!ticketIds.length) return []

    const { data, error } = await supabase
      .from('rma_tickets')
      .select('*')
      .in('id', ticketIds)
      .order('created_date', { ascending: false })
    if (error) throw error
    return data || []
  },
}
