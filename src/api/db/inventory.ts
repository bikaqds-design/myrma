import { supabase } from '../client.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface InventoryUnitRow {
  id: string
  rma_ticket_id: string | null
  rma_number: string | null
  product_name: string
  serial_number: string | null
  warranty_status: string | null
  status: string
  resolution_type: string | null
  resolved_date: string | null
  notes: string | null
  warehouse_id: string | null
  manufacturer_batch_id: string | null
  created_date: string
}

export interface ManufacturerBatchRow {
  id: string
  batch_number: string
  manufacturer_name: string
  status: string
  unit_count: number
  sent_date: string | null
  tracking_number: string | null
  resolution_type: string | null
  resolution_date: string | null
  resolution_notes: string | null
  created_date: string
  created_by: string | null
}

export interface WarehouseRow {
  id: string
  name: string
  code: string | null
  location: string | null
  description: string | null
  is_active: boolean
  created_date: string
}

export interface PartRow {
  id: string
  part_name: string
  part_number: string | null
  quantity: number
  unit_cost: number | null
  supplier: string | null
  reorder_level: number | null
  location: string | null
  notes: string | null
  created_date: string
  updated_date: string | null
}

export interface TicketPartRow {
  id: string
  ticket_id: string
  part_id: string
  quantity: number
  unit_cost: number | null
  notes: string | null
  added_by: string | null
  created_date: string
  part?: Pick<PartRow, 'part_name' | 'part_number'>
}

export interface TimeEntryRow {
  id: string
  ticket_id: string
  technician_email: string
  description: string | null
  duration_min: number | null
  started_at: string | null
  ended_at: string | null
  created_date: string
}

export interface InvoiceRow {
  id: string
  type: 'invoice' | 'quote'
  invoice_number: string
  customer_name: string
  customer_email: string | null
  rma_number_ref: string | null
  ticket_id: string | null
  lineItems: unknown[]
  labour_hours: number | null
  labour_rate: number | null
  tax_pct: number | null
  notes: string | null
  due_date: string | null
  status: string
  created_date: string
  updated_date: string | null
}

export interface InventoryStatsRow {
  active_rma: number
  company_stock: number
  sent_to_manufacturer: number
  closed: number
  total: number
}

interface TicketProductInput {
  product_name?: string
  serial_number?: string
  warranty_status?: string
}

// ── Inventory Units ───────────────────────────────────────────────────────────

export const inventory = {
  async createUnitsFromTicket(
    ticketId: string,
    rmaNumber: string,
    products: TicketProductInput[]
  ): Promise<InventoryUnitRow[]> {
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

  async listUnits(): Promise<{ missing: boolean; data: InventoryUnitRow[] }> {
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

  async resolveUnits(
    ids: string[],
    resolutionType: string,
    notes?: string
  ): Promise<InventoryUnitRow[]> {
    const status = resolutionType === 'return_to_customer' ? 'closed' : 'company_stock'
    const { data, error } = await supabase
      .from('inventory_units')
      .update({ status, resolution_type: resolutionType, resolved_date: new Date().toISOString(), notes: notes || null })
      .in('id', ids)
      .select()
    if (error) throw error
    return data || []
  },

  async listBatches(): Promise<{ missing: boolean; data: ManufacturerBatchRow[] }> {
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

  async createBatch(
    unitIds: string[],
    manufacturerName: string,
    userEmail: string
  ): Promise<ManufacturerBatchRow> {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const { count } = await supabase
      .from('manufacturer_batches')
      .select('*', { count: 'exact', head: true })
    const batchNumber = `BATCH-${dateStr}-${String((count || 0) + 1).padStart(3, '0')}`
    const { data: batch, error: batchErr } = await supabase
      .from('manufacturer_batches')
      .insert([{ batch_number: batchNumber, manufacturer_name: manufacturerName, status: 'draft', unit_count: unitIds.length, created_date: new Date().toISOString(), created_by: userEmail }])
      .select()
    if (batchErr) throw batchErr
    const batchId = batch[0].id
    await supabase.from('inventory_units').update({ manufacturer_batch_id: batchId }).in('id', unitIds)
    return batch[0]
  },

  async markBatchSent(
    batchId: string,
    sentDate: string,
    trackingNumber: string
  ): Promise<ManufacturerBatchRow | undefined> {
    const { data, error } = await supabase
      .from('manufacturer_batches')
      .update({ status: 'sent', sent_date: sentDate, tracking_number: trackingNumber })
      .eq('id', batchId)
      .select()
    if (error) throw error
    await supabase.from('inventory_units').update({ status: 'sent_to_manufacturer' }).eq('manufacturer_batch_id', batchId)
    return data?.[0]
  },

  async markBatchResolved(
    batchId: string,
    resolutionType: string,
    resolutionDate: string,
    notes?: string
  ): Promise<ManufacturerBatchRow | undefined> {
    const { data, error } = await supabase
      .from('manufacturer_batches')
      .update({ status: 'resolved', resolution_type: resolutionType, resolution_date: resolutionDate, resolution_notes: notes })
      .eq('id', batchId)
      .select()
    if (error) throw error
    await supabase.from('inventory_units').update({ status: 'closed' }).eq('manufacturer_batch_id', batchId)
    return data?.[0]
  },

  async getStats(): Promise<InventoryStatsRow | null> {
    try {
      const { data, error } = await supabase.from('inventory_units').select('status')
      if (error) {
        if (error.code === '42P01') return null
        return null
      }
      const counts: InventoryStatsRow = { active_rma: 0, company_stock: 0, sent_to_manufacturer: 0, closed: 0, total: 0 }
      data.forEach((u: { status: string }) => {
        if (u.status in counts) (counts as Record<string, number>)[u.status]++
      })
      counts.total = data.length
      return counts
    } catch {
      return null
    }
  },

  async transferUnits(unitIds: string[], warehouseId: string | null): Promise<void> {
    if (!unitIds.length) throw new Error('No unit IDs provided')
    const { error } = await supabase
      .from('inventory_units')
      .update({ warehouse_id: warehouseId || null })
      .in('id', unitIds)
    if (error) throw error
  },
}

// ── Warehouses ────────────────────────────────────────────────────────────────

export const warehouses = {
  async list(): Promise<{ missing: boolean; data: WarehouseRow[] }> {
    try {
      const { data, error } = await supabase.from('warehouses').select('*').order('name', { ascending: true })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async create(warehouse: Partial<WarehouseRow>): Promise<WarehouseRow | undefined> {
    const { data, error } = await supabase.from('warehouses').insert([warehouse]).select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, warehouse: Partial<WarehouseRow>): Promise<WarehouseRow | undefined> {
    const { data, error } = await supabase.from('warehouses').update(warehouse).eq('id', id).select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('warehouses').delete().eq('id', id)
    if (error) throw error
  },
}

// ── Parts ─────────────────────────────────────────────────────────────────────

export const parts = {
  async list(): Promise<{ missing: boolean; data: PartRow[] }> {
    try {
      const { data, error } = await supabase.from('parts').select('*').order('part_name', { ascending: true })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },
  async get(id: string): Promise<PartRow> {
    const { data, error } = await supabase.from('parts').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(part: Partial<PartRow>): Promise<PartRow | undefined> {
    const { data, error } = await supabase
      .from('parts')
      .insert([{ ...part, created_date: new Date().toISOString(), updated_date: new Date().toISOString() }])
      .select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, part: Partial<PartRow>): Promise<PartRow | undefined> {
    const { data, error } = await supabase
      .from('parts')
      .update({ ...part, updated_date: new Date().toISOString() })
      .eq('id', id)
      .select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('parts').delete().eq('id', id)
    if (error) throw error
  },
  async adjustQuantity(id: string, delta: number): Promise<PartRow | undefined> {
    // Atomic RPC — no read-modify-write race condition (H-3 fix)
    const { data, error } = await supabase.rpc('adjust_part_quantity', { p_id: id, p_delta: delta })
    if (error) throw error
    return data?.[0]
  },
}

// ── Ticket Parts ──────────────────────────────────────────────────────────────

export const ticketParts = {
  async list(ticketId: string): Promise<{ missing: boolean; data: TicketPartRow[] }> {
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
  async add(
    ticketId: string,
    partId: string,
    quantity: number,
    unitCost: number | null,
    notes: string | null,
    addedBy: string | null
  ): Promise<TicketPartRow | undefined> {
    await parts.adjustQuantity(partId, -quantity)
    const { data, error } = await supabase
      .from('ticket_parts')
      .insert([{ ticket_id: ticketId, part_id: partId, quantity, unit_cost: unitCost, notes: notes || null, added_by: addedBy || null, created_date: new Date().toISOString() }])
      .select('*, part:parts(part_name, part_number)')
    if (error) throw error
    return data?.[0]
  },
  async remove(id: string, partId: string, quantity: number): Promise<void> {
    await parts.adjustQuantity(partId, quantity)
    const { error } = await supabase.from('ticket_parts').delete().eq('id', id)
    if (error) throw error
  },
}

// ── Time Tracking ─────────────────────────────────────────────────────────────

export const timeEntries = {
  async list(ticketId: string): Promise<{ missing: boolean; data: TimeEntryRow[] }> {
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
  async listAll(): Promise<{ missing: boolean; data: unknown[] }> {
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
  async create(entry: Partial<TimeEntryRow>): Promise<TimeEntryRow | undefined> {
    const { data, error } = await supabase
      .from('time_entries')
      .insert([{ ...entry, created_date: new Date().toISOString() }])
      .select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, updates: Partial<TimeEntryRow>): Promise<TimeEntryRow | undefined> {
    const { data, error } = await supabase.from('time_entries').update(updates).eq('id', id).select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('time_entries').delete().eq('id', id)
    if (error) throw error
  },
  async getTotalMinutes(ticketId: string): Promise<number> {
    try {
      const { data, error } = await supabase
        .from('time_entries')
        .select('duration_min')
        .eq('ticket_id', ticketId)
        .not('duration_min', 'is', null)
      if (error) return 0
      return (data || []).reduce((sum, e: { duration_min: number | null }) => sum + (e.duration_min || 0), 0)
    } catch {
      return 0
    }
  },
}

// ── Invoices / Quotes ─────────────────────────────────────────────────────────

export const invoices = {
  async list(): Promise<{ missing: boolean; data: InvoiceRow[] }> {
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
  async get(id: string): Promise<InvoiceRow> {
    const { data, error } = await supabase.from('invoices').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(invoice: Partial<InvoiceRow>): Promise<InvoiceRow | undefined> {
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('invoices')
      .insert([{ ...invoice, created_date: now, updated_date: now }])
      .select()
    if (error) throw error
    return data?.[0]
  },
  async update(id: string, updates: Partial<InvoiceRow>): Promise<InvoiceRow | undefined> {
    const { data, error } = await supabase
      .from('invoices')
      .update({ ...updates, updated_date: new Date().toISOString() })
      .eq('id', id)
      .select()
    if (error) throw error
    return data?.[0]
  },
  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('invoices').delete().eq('id', id)
    if (error) throw error
  },
  async generateNumber(existingInvoices: Array<{ invoice_number: string }> = []): Promise<string> {
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
