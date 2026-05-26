import { supabase } from '../client.js'

export const customers = {
  async list() {
    // Capped at 500 rows — use listPaged() for server-side pagination (H-4)
    const { data, error } = await supabase.from('customers').select('*').order('created_date', { ascending: false }).limit(500)
    if (error) throw error
    return data || []
  },
  async listPaged(page = 0, pageSize = 50) {
    const from = page * pageSize
    const { data, count, error } = await supabase
      .from('customers')
      .select('*', { count: 'exact' })
      .order('created_date', { ascending: false })
      .range(from, from + pageSize - 1)
    if (error) throw error
    return { data: data || [], count: count || 0, page, pageSize, totalPages: Math.ceil((count || 0) / pageSize) }
  },
  async get(id) {
    const { data, error } = await supabase.from('customers').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(customer) {
    const { data, error } = await supabase.from('customers').insert([customer]).select()
    if (error) throw error
    return data?.[0]
  },
  async bulkCreate(customers) {
    const { data, error } = await supabase.from('customers').insert(customers).select()
    if (error) throw error
    return data || []
  },
  async update(id, customer) {
    const { data, error } = await supabase.from('customers').update(customer).eq('id', id).select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id) {
    // Atomic cascade delete via server-side RPC (H-8 fix).
    // delete_customer_cascade runs in a single transaction — no partial state possible.
    const { error } = await supabase.rpc('delete_customer_cascade', { p_customer_id: id })
    if (error) {
      if (error.code === 'PGRST202') throw new Error('delete_customer_cascade RPC not found. Run supabase/migrations/20260524_customer_cascade_delete.sql first.')
      throw error
    }
  },
  async bulkDelete(ids) {
    // Atomic cascade bulk delete via server-side RPC (H-8 fix).
    // delete_customers_cascade runs in a single transaction — no partial state possible.
    const { error } = await supabase.rpc('delete_customers_cascade', { p_customer_ids: ids })
    if (error) {
      if (error.code === 'PGRST202') throw new Error('delete_customers_cascade RPC not found. Run supabase/migrations/20260524_customer_cascade_delete.sql first.')
      throw error
    }
  },
  async bulkUpdateStatus(ids, status) {
    const { error } = await supabase.from('customers').update({ customer_status: status, updated_date: new Date().toISOString() }).in('id', ids)
    if (error) throw error
  },
  async getRelatedTickets(customerId) {
    const { data, error } = await supabase.from('rma_tickets').select('*').eq('customer_id', customerId).order('created_date', { ascending: false })
    if (error) throw error
    return data || []
  },
  async uploadPhoto(file, customerId) {
    const fileExt = file.name.split('.').pop()
    const fileName = `customers/customer-${customerId}-${Date.now()}.${fileExt}`
    const { error: uploadError } = await supabase.storage.from('rma-attachments').upload(fileName, file, { upsert: true })
    if (uploadError) throw uploadError
    const { data } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return data.publicUrl
  }
}

export const customerNotes = {
  async list(customerId) {
    const { data, error } = await supabase.from('customer_notes').select('*').eq('customer_id', customerId).order('created_date', { ascending: false })
    if (error) throw error
    return data || []
  },
  async create(note) {
    const { data, error } = await supabase.from('customer_notes').insert([note]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id, note) {
    const { data, error } = await supabase.from('customer_notes').update(note).eq('id', id).select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id) {
    const { error } = await supabase.from('customer_notes').delete().eq('id', id)
    if (error) throw error
  }
}
