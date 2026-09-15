import { supabase } from '../client.js'
import { assertUpdated, assertAffected } from './_assertUpdated.js'
import { fetchAllRows } from './_paging.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface ContactRow {
  id: string
  customer_id: string
  full_name: string
  title: string | null
  phone: string | null
  email: string | null
  is_primary: boolean
  notes: string | null
  created_at: string
  created_by: string | null
}

// ── Contacts ──────────────────────────────────────────────────────────────────
// Single-primary-per-account is an application-layer invariant (see
// data-model.md), not a DB constraint — create()/update() with is_primary:
// true must first unset any prior primary contact for the same customer_id.

async function clearExistingPrimary(customerId: string, excludeId?: string): Promise<void> {
  let query = supabase
    .from('contacts')
    .update({ is_primary: false })
    .eq('customer_id', customerId)
    .eq('is_primary', true)
  if (excludeId) query = query.neq('id', excludeId)
  const { error } = await query
  if (error) throw error
}

export const contacts = {
  /** Every contact of the customer, newest first — not the first 1 000. (BUG-066.) */
  async list(customerId: string): Promise<ContactRow[]> {
    return fetchAllRows<ContactRow>((from, to) =>
      supabase
        .from('contacts')
        .select('*')
        .eq('customer_id', customerId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to)
    )
  },
  async create(contact: Omit<ContactRow, 'id' | 'created_at'>): Promise<ContactRow> {
    if (contact.is_primary) await clearExistingPrimary(contact.customer_id)
    const { data, error } = await supabase.from('contacts').insert([contact]).select()
    if (error) throw error
    return data[0]
  },
  async update(id: string, contact: Partial<ContactRow>): Promise<ContactRow> {
    if (contact.is_primary) {
      const { data: existing, error: fetchError } = await supabase
        .from('contacts')
        .select('customer_id')
        .eq('id', id)
        .single()
      if (fetchError) throw fetchError
      await clearExistingPrimary(existing.customer_id, id)
    }
    const { data, error } = await supabase.from('contacts').update(contact).eq('id', id).select()
    if (error) throw error
    return assertUpdated(data, 'Contact')
  },
  async delete(id: string): Promise<void> {
    const { data, error } = await supabase.from('contacts').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Contact')
  },
}
