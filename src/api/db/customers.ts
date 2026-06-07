import { supabase } from '../client.js'

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

// ── Customers ─────────────────────────────────────────────────────────────────

export const customers = {
  async list(): Promise<CustomerRow[]> {
    // 5 000-row cap — the Customers page filters/sorts client-side so all rows
    // must be in memory. If the dataset ever exceeds 5 000, switch the page to
    // server-side pagination using listPaged().
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .order('created_date', { ascending: false })
      .limit(5000)
    if (error) throw error
    return data || []
  },
  async listPaged(page = 0, pageSize = 50): Promise<PagedResult<CustomerRow>> {
    const from = page * pageSize
    const { data, count, error } = await supabase
      .from('customers')
      .select('*', { count: 'exact' })
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
  async bulkCreate(customersData: Partial<CustomerRow>[]): Promise<CustomerRow[]> {
    const { data, error } = await supabase.from('customers').insert(customersData).select()
    if (error) throw error
    return data || []
  },
  async update(id: string, customer: Partial<CustomerRow>): Promise<CustomerRow | undefined> {
    const { data, error } = await supabase.from('customers').update(customer).eq('id', id).select()
    if (error) throw error
    return data?.[0]
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
    const { error } = await supabase
      .from('customers')
      .update({ customer_status: status, updated_date: new Date().toISOString() })
      .in('id', ids)
    if (error) throw error
  },
  async getRelatedTickets(customerId: string, customerNames: string[] = []): Promise<unknown[]> {
    // Tickets may be linked by UUID FK (customer_id) OR by name string (customer_name).
    try {
      const cols =
        'id, rma_number, customer_name, customer_id, ticket_status, priority, general_description, created_date, due_date, products, assigned_technician'
      const queries = [
        supabase
          .from('rma_tickets')
          .select(cols)
          .eq('customer_id', customerId)
          .order('created_date', { ascending: false }),
      ]
      const uniqueNames = [...new Set(customerNames.filter(Boolean))]
      if (uniqueNames.length > 0) {
        queries.push(
          supabase
            .from('rma_tickets')
            .select(cols)
            .in('customer_name', uniqueNames)
            .order('created_date', { ascending: false })
        )
      }
      const results = await Promise.all(queries)
      const seen = new Set<string>()
      const merged: unknown[] = []
      for (const { data, error } of results) {
        if (error) throw error
        for (const ticket of data || []) {
          if (!seen.has(ticket.id)) {
            seen.add(ticket.id)
            merged.push(ticket)
          }
        }
      }
      return merged.sort(
        (a, b) =>
          new Date((b as { created_date: string }).created_date).getTime() -
          new Date((a as { created_date: string }).created_date).getTime()
      )
    } catch (err) {
      if ((err as { code?: string })?.code === '42P01') return []
      throw err
    }
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
  async list(customerId: string): Promise<CustomerNoteRow[]> {
    const { data, error } = await supabase
      .from('customer_notes')
      .select('*')
      .eq('customer_id', customerId)
      .order('created_date', { ascending: false })
    if (error) throw error
    return data || []
  },
  async create(note: Partial<CustomerNoteRow>): Promise<CustomerNoteRow | undefined> {
    const { data, error } = await supabase.from('customer_notes').insert([note]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, note: Partial<CustomerNoteRow>): Promise<CustomerNoteRow | undefined> {
    const { data, error } = await supabase.from('customer_notes').update(note).eq('id', id).select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('customer_notes').delete().eq('id', id)
    if (error) throw error
  },
}
