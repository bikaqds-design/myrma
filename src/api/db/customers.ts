import { supabase } from '../client.js'
import { assertUpdated } from './_assertUpdated.js'

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
    const { error } = await supabase
      .from('customers')
      .update({ customer_status: status, updated_date: new Date().toISOString() })
      .in('id', ids)
    if (error) throw error
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
  async getRelatedTickets(customerId: string, _customerNames: string[] = []): Promise<unknown[]> {
    try {
      const { data, error } = await supabase
        .from('rma_tickets')
        .select(
          'id, rma_number, customer_name, customer_id, ticket_status, priority, general_description, created_date, due_date, products, assigned_technician'
        )
        .eq('customer_id', customerId)
        .order('created_date', { ascending: false })
      if (error) throw error
      return data || []
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
    return assertUpdated(data, 'Customer note')
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('customer_notes').delete().eq('id', id)
    if (error) throw error
  },
}
