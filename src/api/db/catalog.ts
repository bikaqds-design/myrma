import { supabase } from '../client.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface BrandRow {
  id: string
  brand_name: string
  brand_logo_url: string | null
  created_date: string
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
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('brands').delete().eq('id', id)
    if (error) throw error
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
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('categories').delete().eq('id', id)
    if (error) throw error
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
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('subcategories').delete().eq('id', id)
    if (error) throw error
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
  async bulkCreate(productsData: Partial<ProductRow>[]): Promise<ProductRow[]> {
    const { data, error } = await supabase.from('products').insert(productsData).select()
    if (error) throw error
    return data || []
  },
  async update(id: string, product: Partial<ProductRow>): Promise<ProductRow | undefined> {
    const { data, error } = await supabase.from('products').update(product).eq('id', id).select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('products').delete().eq('id', id)
    if (error) throw error
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
    const safe = query.replace(/[%_\\]/g, '\\$&').replace(/[(),"]/g, '')
    const { data, error } = await supabase
      .from('products')
      .select(
        '*, brand:brands(id, brand_name, brand_logo_url), category:categories(id, category_name), subcategory:subcategories(id, subcategory_name)'
      )
      .or(`product_name.ilike.%${safe}%,sku.ilike.%${safe}%,product_description.ilike.%${safe}%`)
      .order('created_date', { ascending: false })
    if (error) throw error
    return data || []
  },
  async getRelatedTickets(productId: string): Promise<unknown[]> {
    const { data, error } = await supabase
      .from('rma_tickets')
      .select('*')
      .eq('product_id', productId)
      .order('created_date', { ascending: false })
    if (error) throw error
    return data || []
  },
}
