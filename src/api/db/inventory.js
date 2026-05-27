import { supabase } from '../client.js'

export const inventory = {
  async createUnitsFromTicket(ticketId, rmaNumber, products) {
    if (!products?.length) return []
    const units = products
      .filter((p) => p.product_name || p.serial_number)
      .map((p) => ({
        rma_ticket_id: ticketId,
        rma_number: rmaNumber,
        product_name: p.product_name || '',
        serial_number: p.serial_number || '',
        warranty_status: p.warranty_status || '',
        status: 'active_rma',
        created_date: new Date().toISOString(),
      }))
    if (!units.length) return []
    const { data, error } = await supabase.from('inventory_units').insert(units).select()
    if (error) {
      if (error.code === '42P01') return []
      return []
    }
    return data || []
  },

  async listUnits() {
    try {
      const { data, error } = await supabase
        .from('inventory_units')
        .select('*')
        .order('created_date', { ascending: false })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },

  async resolveUnits(ids, resolutionType, notes) {
    const status = resolutionType === 'return_to_customer' ? 'closed' : 'company_stock'
    const { data, error } = await supabase
      .from('inventory_units')
      .update({
        status,
        resolution_type: resolutionType,
        resolved_date: new Date().toISOString(),
        notes: notes || null,
      })
      .in('id', ids)
      .select()
    if (error) throw error
    return data || []
  },

  async listBatches() {
    try {
      const { data, error } = await supabase
        .from('manufacturer_batches')
        .select('*')
        .order('created_date', { ascending: false })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },

  async createBatch(unitIds, manufacturerName, userEmail) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const { count } = await supabase
      .from('manufacturer_batches')
      .select('*', { count: 'exact', head: true })
    const batchNumber = `BATCH-${dateStr}-${String((count || 0) + 1).padStart(3, '0')}`
    const { data: batch, error: batchErr } = await supabase
      .from('manufacturer_batches')
      .insert([
        {
          batch_number: batchNumber,
          manufacturer_name: manufacturerName,
          status: 'draft',
          unit_count: unitIds.length,
          created_date: new Date().toISOString(),
          created_by: userEmail,
        },
      ])
      .select()
    if (batchErr) throw batchErr
    const batchId = batch[0].id
    await supabase
      .from('inventory_units')
      .update({ manufacturer_batch_id: batchId })
      .in('id', unitIds)
    return batch[0]
  },

  async markBatchSent(batchId, sentDate, trackingNumber) {
    const { data, error } = await supabase
      .from('manufacturer_batches')
      .update({ status: 'sent', sent_date: sentDate, tracking_number: trackingNumber })
      .eq('id', batchId)
      .select()
    if (error) throw error
    await supabase
      .from('inventory_units')
      .update({ status: 'sent_to_manufacturer' })
      .eq('manufacturer_batch_id', batchId)
    return data?.[0]
  },

  async markBatchResolved(batchId, resolutionType, resolutionDate, notes) {
    const { data, error } = await supabase
      .from('manufacturer_batches')
      .update({
        status: 'resolved',
        resolution_type: resolutionType,
        resolution_date: resolutionDate,
        resolution_notes: notes,
      })
      .eq('id', batchId)
      .select()
    if (error) throw error
    await supabase
      .from('inventory_units')
      .update({ status: 'closed' })
      .eq('manufacturer_batch_id', batchId)
    return data?.[0]
  },

  async getStats() {
    try {
      const { data, error } = await supabase.from('inventory_units').select('status')
      if (error) {
        if (error.code === '42P01') return null
        return null
      }
      const counts = { active_rma: 0, company_stock: 0, sent_to_manufacturer: 0, closed: 0 }
      data.forEach((u) => {
        if (counts[u.status] !== undefined) counts[u.status]++
      })
      return { ...counts, total: data.length }
    } catch {
      return null
    }
  },

  async transferUnits(unitIds, warehouseId) {
    if (!unitIds.length) throw new Error('No unit IDs provided')
    const { error } = await supabase
      .from('inventory_units')
      .update({ warehouse_id: warehouseId || null })
      .in('id', unitIds)
    if (error) throw error
  },
}

export const warehouses = {
  async list() {
    try {
      const { data, error } = await supabase
        .from('warehouses')
        .select('*')
        .order('name', { ascending: true })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async create(warehouse) {
    const { data, error } = await supabase.from('warehouses').insert([warehouse]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id, warehouse) {
    const { data, error } = await supabase
      .from('warehouses')
      .update(warehouse)
      .eq('id', id)
      .select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id) {
    const { error } = await supabase.from('warehouses').delete().eq('id', id)
    if (error) throw error
  },
}

// ── Parts / Components Inventory ───────────────────────────────────────────
// parts is defined as a named const so ticketParts can reference it directly.
export const parts = {
  async list() {
    try {
      const { data, error } = await supabase
        .from('parts')
        .select('*')
        .order('part_name', { ascending: true })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async get(id) {
    const { data, error } = await supabase.from('parts').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(part) {
    const { data, error } = await supabase
      .from('parts')
      .insert([
        { ...part, created_date: new Date().toISOString(), updated_date: new Date().toISOString() },
      ])
      .select()
    if (error) throw error
    return data?.[0]
  },
  async update(id, part) {
    const { data, error } = await supabase
      .from('parts')
      .update({ ...part, updated_date: new Date().toISOString() })
      .eq('id', id)
      .select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id) {
    const { error } = await supabase.from('parts').delete().eq('id', id)
    if (error) throw error
  },
  async adjustQuantity(id, delta) {
    // Atomic RPC — no read-modify-write race condition (H-3 fix)
    const { data, error } = await supabase.rpc('adjust_part_quantity', { p_id: id, p_delta: delta })
    if (error) throw error
    return data?.[0]
  },
}

export const ticketParts = {
  async list(ticketId) {
    try {
      const { data, error } = await supabase
        .from('ticket_parts')
        .select('*, part:parts(part_name, part_number)')
        .eq('ticket_id', ticketId)
        .order('created_date', { ascending: true })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async add(ticketId, partId, quantity, unitCost, notes, addedBy) {
    // Deduct from parts inventory
    await parts.adjustQuantity(partId, -quantity)
    const { data, error } = await supabase
      .from('ticket_parts')
      .insert([
        {
          ticket_id: ticketId,
          part_id: partId,
          quantity,
          unit_cost: unitCost,
          notes: notes || null,
          added_by: addedBy || null,
          created_date: new Date().toISOString(),
        },
      ])
      .select('*, part:parts(part_name, part_number)')
    if (error) throw error
    return data?.[0]
  },
  async remove(id, partId, quantity) {
    // Restore quantity to inventory
    await parts.adjustQuantity(partId, quantity)
    const { error } = await supabase.from('ticket_parts').delete().eq('id', id)
    if (error) throw error
  },
}

// ── Time Tracking ──────────────────────────────────────────────────────────
export const timeEntries = {
  async list(ticketId) {
    try {
      const { data, error } = await supabase
        .from('time_entries')
        .select('*')
        .eq('ticket_id', ticketId)
        .order('created_date', { ascending: false })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async listAll() {
    try {
      const { data, error } = await supabase
        .from('time_entries')
        .select('*, ticket:rma_tickets(rma_number, customer_name)')
        .order('created_date', { ascending: false })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async create(entry) {
    const { data, error } = await supabase
      .from('time_entries')
      .insert([{ ...entry, created_date: new Date().toISOString() }])
      .select()
    if (error) throw error
    return data?.[0]
  },
  async update(id, updates) {
    const { data, error } = await supabase
      .from('time_entries')
      .update(updates)
      .eq('id', id)
      .select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id) {
    const { error } = await supabase.from('time_entries').delete().eq('id', id)
    if (error) throw error
  },
  async getTotalMinutes(ticketId) {
    try {
      const { data, error } = await supabase
        .from('time_entries')
        .select('duration_min')
        .eq('ticket_id', ticketId)
        .not('duration_min', 'is', null)
      if (error) return 0
      return (data || []).reduce((sum, e) => sum + (e.duration_min || 0), 0)
    } catch {
      return 0
    }
  },
}

// ── Invoices / Quotes ──────────────────────────────────────────────────────
export const invoices = {
  async list() {
    try {
      const { data, error } = await supabase
        .from('invoices')
        .select('*')
        .order('created_date', { ascending: false })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async get(id) {
    const { data, error } = await supabase.from('invoices').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(invoice) {
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('invoices')
      .insert([{ ...invoice, created_date: now, updated_date: now }])
      .select()
    if (error) throw error
    return data?.[0]
  },
  async update(id, updates) {
    const { data, error } = await supabase
      .from('invoices')
      .update({ ...updates, updated_date: new Date().toISOString() })
      .eq('id', id)
      .select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id) {
    const { error } = await supabase.from('invoices').delete().eq('id', id)
    if (error) throw error
  },
  async generateNumber(existingInvoices = []) {
    const now = new Date()
    const prefix = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-`
    const serials = existingInvoices
      .map((i) => i.invoice_number)
      .filter((n) => n?.startsWith(prefix))
      .map((n) => parseInt(n.replace(prefix, ''), 10))
      .filter((n) => !isNaN(n))
    const next = serials.length > 0 ? Math.max(...serials) + 1 : 1
    return `${prefix}${String(next).padStart(4, '0')}`
  },
}
