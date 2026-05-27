import { supabase } from '../client.js'

export const brands = {
  async list() {
    const { data, error } = await supabase
      .from('brands')
      .select('*')
      .order('brand_name', { ascending: true })
    if (error) throw error
    return data || []
  },
  async create(brand) {
    const { data, error } = await supabase.from('brands').insert([brand]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id, brand) {
    const { data, error } = await supabase.from('brands').update(brand).eq('id', id).select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id) {
    const { error } = await supabase.from('brands').delete().eq('id', id)
    if (error) throw error
  },
}

export const categories = {
  async list() {
    const { data, error } = await supabase
      .from('categories')
      .select('*, brand:brands(id, brand_name)')
      .order('category_name', { ascending: true })
    if (error) throw error
    return data || []
  },
  async listByBrand(brandId) {
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .eq('brand_id', brandId)
      .order('category_name', { ascending: true })
    if (error) throw error
    return data || []
  },
  async create(category) {
    const { data, error } = await supabase.from('categories').insert([category]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id, category) {
    const { data, error } = await supabase.from('categories').update(category).eq('id', id).select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id) {
    const { error } = await supabase.from('categories').delete().eq('id', id)
    if (error) throw error
  },
}

export const subcategories = {
  async list() {
    const { data, error } = await supabase
      .from('subcategories')
      .select('*, category:categories(id, category_name, brand_id)')
      .order('subcategory_name', { ascending: true })
    if (error) throw error
    return data || []
  },
  async listByCategory(categoryId) {
    const { data, error } = await supabase
      .from('subcategories')
      .select('*')
      .eq('category_id', categoryId)
      .order('subcategory_name', { ascending: true })
    if (error) throw error
    return data || []
  },
  async create(subcategory) {
    const { data, error } = await supabase.from('subcategories').insert([subcategory]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id, subcategory) {
    const { data, error } = await supabase
      .from('subcategories')
      .update(subcategory)
      .eq('id', id)
      .select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id) {
    const { error } = await supabase.from('subcategories').delete().eq('id', id)
    if (error) throw error
  },
}

export const products = {
  async list() {
    // Capped at 500 rows — use listPaged() for server-side pagination (H-4)
    const { data, error } = await supabase
      .from('products')
      .select(
        '*, brand:brands(id, brand_name, brand_logo_url), category:categories(id, category_name), subcategory:subcategories(id, subcategory_name)'
      )
      .order('created_date', { ascending: false })
      .limit(500)
    if (error) throw error
    return data || []
  },
  async listPaged(page = 0, pageSize = 50) {
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
  async get(id) {
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
  async create(product) {
    const { data, error } = await supabase.from('products').insert([product]).select()
    if (error) throw error
    return data?.[0]
  },
  async bulkCreate(products) {
    const { data, error } = await supabase.from('products').insert(products).select()
    if (error) throw error
    return data || []
  },
  async update(id, product) {
    const { data, error } = await supabase.from('products').update(product).eq('id', id).select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id) {
    const { error } = await supabase.from('products').delete().eq('id', id)
    if (error) throw error
  },
  async bulkDelete(ids) {
    const { error } = await supabase.from('products').delete().in('id', ids)
    if (error) throw error
  },
  async bulkUpdateStatus(ids, status) {
    const { error } = await supabase
      .from('products')
      .update({ status, updated_date: new Date().toISOString() })
      .in('id', ids)
    if (error) throw error
  },
  async search(query) {
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
  async getRelatedTickets(productId) {
    const { data, error } = await supabase
      .from('rma_tickets')
      .select('*')
      .eq('product_id', productId)
      .order('created_date', { ascending: false })
    if (error) throw error
    return data || []
  },
}
