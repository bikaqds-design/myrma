import { supabase } from '../client.js'
import { assertUpdated, assertAffected } from './_assertUpdated.js'
import { orIlike } from '../../lib/searchPattern.js'

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

// ── Products ──────────────────────────────────────────────────────────────────

export const products = {
  async list(): Promise<ProductRow[]> {
    // 5 000-row cap — Products page filters/sorts client-side.
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
   * getStockSummary — so a product whose units are all sold/scrapped is still
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
    const { error } = await supabase.from('products').delete().in('id', ids)
    if (error) throw error
  },
  async bulkUpdateStatus(ids: string[], status: string): Promise<void> {
    const { error } = await supabase
      .from('products')
      .update({ status, updated_date: new Date().toISOString() })
      .in('id', ids)
    if (error) throw error
  },
  async search(query: string): Promise<ProductRow[]> {
    const { data, error } = await supabase
      .from('products')
      .select(
        '*, brand:brands(id, brand_name, brand_logo_url), category:categories(id, category_name), subcategory:subcategories(id, subcategory_name)'
      )
      // Quoted and LIKE-escaped (BUG-060). This used to delete ( ) , and " from the
      // query, so "Dell, HP" silently searched for "Dell HP".
      .or(orIlike(['product_name', 'sku', 'product_description'], query))
      .order('created_date', { ascending: false })
    if (error) throw error
    return data || []
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
