import { supabase } from '../client.js'
import type { TableResult } from './types.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface VendorRow {
  id: string
  name: string
  contact_person: string | null
  email: string | null
  phone: string | null
  tax_id: string | null
  payment_terms: string | null
  created_by: string
  created_at: string
  updated_at: string | null
}

export interface PurchaseLine {
  product_id: string
  product_name: string
  qty_ordered: number
  qty_received?: number
  unit_cost: number
}

export interface ProformaInvoiceRow {
  id: string
  pi_code: string
  vendor_id: string
  status: 'draft' | 'sent' | 'accepted' | 'cancelled'
  line_items: PurchaseLine[]
  total: number
  notes: string | null
  created_by: string
  created_at: string
  updated_at: string | null
}

export interface PurchaseOrderRow {
  id: string
  po_code: string
  vendor_id: string
  proforma_invoice_id: string | null
  status: 'draft' | 'sent' | 'confirmed' | 'cancelled'
  line_items: PurchaseLine[]
  total: number
  expected_delivery_date: string | null
  notes: string | null
  created_by: string
  created_at: string
  updated_at: string | null
}

export interface VendorInvoiceRow {
  id: string
  vi_code: string | null
  purchase_order_id: string | null
  vendor_id: string
  status: 'draft' | 'confirmed' | 'partially_received' | 'received' | 'cancelled'
  line_items: PurchaseLine[]
  total: number
  invoice_date: string | null
  notes: string | null
  created_by: string
  created_at: string
  confirmed_at: string | null
  received_at: string | null
}

export type PurchaseDocType = 'proforma_invoice' | 'purchase_order' | 'vendor_invoice'

export interface PurchaseDocumentRow {
  id: string
  doc_type: PurchaseDocType
  doc_code: string | null
  vendor_id: string
  created_by: string
  doc_status: string
  total: number
  created_at: string
  updated_at: string | null
  type_specific_date: string | null
  type_specific_date_label: string | null
}

function computeTotal(lines: PurchaseLine[]): number {
  return lines.reduce((sum, l) => sum + l.qty_ordered * l.unit_cost, 0)
}

// ── Vendors ───────────────────────────────────────────────────────────────────

export const vendors = {
  async list(): Promise<VendorRow[]> {
    const { data, error } = await supabase.from('vendors').select('*').order('name', { ascending: true })
    if (error) throw error
    return data || []
  },
  async get(id: string): Promise<VendorRow> {
    const { data, error } = await supabase.from('vendors').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(vendor: Omit<VendorRow, 'id' | 'created_at' | 'updated_at'>): Promise<VendorRow> {
    const { data, error } = await supabase.from('vendors').insert([vendor]).select()
    if (error) throw error
    return data[0]
  },
  async update(id: string, vendor: Partial<VendorRow>): Promise<VendorRow> {
    const { data, error } = await supabase
      .from('vendors')
      .update({ ...vendor, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
    if (error) throw error
    return data[0]
  },
}

// ── Proforma Invoices ─────────────────────────────────────────────────────────

export const proformaInvoices = {
  async list(): Promise<ProformaInvoiceRow[]> {
    const { data, error } = await supabase
      .from('proforma_invoices')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },
  async get(id: string): Promise<ProformaInvoiceRow> {
    const { data, error } = await supabase.from('proforma_invoices').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(input: {
    vendorId: string
    lineItems: PurchaseLine[]
    notes?: string
    createdBy: string
  }): Promise<ProformaInvoiceRow> {
    const { data, error } = await supabase.rpc('generate_doc_code', { p_prefix: 'PI' })
    if (error) throw error
    const { data: row, error: insertErr } = await supabase
      .from('proforma_invoices')
      .insert([
        {
          pi_code: data,
          vendor_id: input.vendorId,
          line_items: input.lineItems,
          total: computeTotal(input.lineItems),
          notes: input.notes || null,
          created_by: input.createdBy,
        },
      ])
      .select()
    if (insertErr) throw insertErr
    return row[0]
  },
  async update(id: string, fields: Partial<ProformaInvoiceRow>): Promise<ProformaInvoiceRow> {
    const patch = { ...fields } as Partial<ProformaInvoiceRow>
    if (patch.line_items) patch.total = computeTotal(patch.line_items)
    const { data, error } = await supabase.from('proforma_invoices').update(patch).eq('id', id).select()
    if (error) throw error
    return data[0]
  },
  async markSent(id: string): Promise<void> {
    const { error } = await supabase.from('proforma_invoices').update({ status: 'sent' }).eq('id', id)
    if (error) throw error
  },
  async markAccepted(id: string): Promise<void> {
    const { error } = await supabase.from('proforma_invoices').update({ status: 'accepted' }).eq('id', id)
    if (error) throw error
  },
  async cancel(id: string): Promise<void> {
    const { error } = await supabase.from('proforma_invoices').update({ status: 'cancelled' }).eq('id', id)
    if (error) throw error
  },
}

// ── Purchase Orders ───────────────────────────────────────────────────────────

export const purchaseOrders = {
  async list(): Promise<PurchaseOrderRow[]> {
    const { data, error } = await supabase
      .from('purchase_orders')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },
  async get(id: string): Promise<PurchaseOrderRow> {
    const { data, error } = await supabase.from('purchase_orders').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(input: {
    vendorId: string
    proformaInvoiceId?: string
    lineItems: PurchaseLine[]
    expectedDeliveryDate?: string
    notes?: string
    createdBy: string
  }): Promise<PurchaseOrderRow> {
    const { data: code, error: codeErr } = await supabase.rpc('generate_doc_code', { p_prefix: 'PO' })
    if (codeErr) throw codeErr
    const { data: row, error } = await supabase
      .from('purchase_orders')
      .insert([
        {
          po_code: code,
          vendor_id: input.vendorId,
          proforma_invoice_id: input.proformaInvoiceId || null,
          line_items: input.lineItems,
          total: computeTotal(input.lineItems),
          expected_delivery_date: input.expectedDeliveryDate || null,
          notes: input.notes || null,
          created_by: input.createdBy,
        },
      ])
      .select()
    if (error) throw error
    return row[0]
  },
  async update(id: string, fields: Partial<PurchaseOrderRow>): Promise<PurchaseOrderRow> {
    const patch = { ...fields } as Partial<PurchaseOrderRow>
    if (patch.line_items) patch.total = computeTotal(patch.line_items)
    const { data, error } = await supabase.from('purchase_orders').update(patch).eq('id', id).select()
    if (error) throw error
    return data[0]
  },
  async markSent(id: string): Promise<void> {
    const { error } = await supabase.from('purchase_orders').update({ status: 'sent' }).eq('id', id)
    if (error) throw error
  },
  async markConfirmed(id: string): Promise<void> {
    const { error } = await supabase.from('purchase_orders').update({ status: 'confirmed' }).eq('id', id)
    if (error) throw error
  },
  async cancel(id: string): Promise<void> {
    const { error } = await supabase.from('purchase_orders').update({ status: 'cancelled' }).eq('id', id)
    if (error) throw error
  },
  async convertToVendorInvoice(poId: string, createdBy: string): Promise<VendorInvoiceRow> {
    const po = await purchaseOrders.get(poId)
    const { data, error } = await supabase
      .from('vendor_invoices')
      .insert([
        {
          purchase_order_id: poId,
          vendor_id: po.vendor_id,
          line_items: po.line_items.map((l) => ({ ...l, qty_received: 0 })),
          total: po.total,
          created_by: createdBy,
        },
      ])
      .select()
    if (error) throw error
    return data[0]
  },
}

// ── Vendor Invoices ───────────────────────────────────────────────────────────

export const vendorInvoices = {
  async list(): Promise<VendorInvoiceRow[]> {
    const { data, error } = await supabase
      .from('vendor_invoices')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },
  async get(id: string): Promise<VendorInvoiceRow> {
    const { data, error } = await supabase.from('vendor_invoices').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },
  async create(input: {
    vendorId: string
    purchaseOrderId?: string
    lineItems: PurchaseLine[]
    invoiceDate?: string
    notes?: string
    createdBy: string
  }): Promise<VendorInvoiceRow> {
    const { data, error } = await supabase
      .from('vendor_invoices')
      .insert([
        {
          purchase_order_id: input.purchaseOrderId || null,
          vendor_id: input.vendorId,
          line_items: input.lineItems.map((l) => ({ ...l, qty_received: l.qty_received ?? 0 })),
          total: computeTotal(input.lineItems),
          invoice_date: input.invoiceDate || null,
          notes: input.notes || null,
          created_by: input.createdBy,
        },
      ])
      .select()
    if (error) throw error
    return data[0]
  },
  async update(id: string, fields: Partial<VendorInvoiceRow>): Promise<VendorInvoiceRow> {
    const patch = { ...fields } as Partial<VendorInvoiceRow>
    if (patch.line_items) patch.total = computeTotal(patch.line_items)
    const { data, error } = await supabase.from('vendor_invoices').update(patch).eq('id', id).select()
    if (error) throw error
    return data[0]
  },
  async markConfirmed(id: string): Promise<void> {
    const { error } = await supabase
      .from('vendor_invoices')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error
  },
  async cancel(id: string): Promise<void> {
    const { error } = await supabase.from('vendor_invoices').update({ status: 'cancelled' }).eq('id', id)
    if (error) throw error
  },
  /**
   * receive — the atomic receipt path (Sprint 9). p_receipt_lines shape:
   * serialized: { productId, warehouseId, serials: string[] }
   * bulk:       { productId, warehouseId, qty: number }
   */
  async receive(
    viId: string,
    receiptLines: Array<{ productId: string; warehouseId: string; serials?: string[]; qty?: number }>,
    actorEmail: string
  ): Promise<void> {
    const { error } = await supabase.rpc('receive_vendor_invoice', {
      p_vi_id: viId,
      p_receipt_lines: receiptLines.map((l) => ({
        product_id: l.productId,
        warehouse_id: l.warehouseId,
        serials: l.serials,
        qty: l.qty,
      })),
      p_actor_email: actorEmail,
    })
    if (error) throw error
  },
}

// ── Unified "All" view ────────────────────────────────────────────────────────

export const purchaseDocuments = {
  async listAll(): Promise<TableResult<PurchaseDocumentRow[]>> {
    try {
      const { data, error } = await supabase
        .from('v_purchase_documents')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },
}
