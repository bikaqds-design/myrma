import { supabase } from '../client.js'
import { fetchAllRows } from './_paging.js'

// Customer returns (P-05a, 20260902) and the credit note made from one
// (P-05b, 20260903). Every write is an RPC: the tables are procedure-only.
// Managers and above record, confirm and cancel a return and credit it; the
// database enforces that and every quantity rule.

export interface CustomerReturnLineRow {
  id: string
  customer_return_id: string
  line_no: number
  delivery_line_id: string
  product_id: string
  product_name: string
  qty: number
  warehouse_id: string
  unit_ids: string[]
}

export interface CustomerReturnRow {
  id: string
  return_code: string | null
  delivery_id: string
  sales_order_id: string
  customer_id: string
  status: 'draft' | 'confirmed' | 'cancelled'
  reason: string | null
  notes: string | null
  created_by: string
  created_at: string
  confirmed_at: string | null
  customer_return_lines: CustomerReturnLineRow[]
}

/** One line of a new return: which delivery line, how many (bulk) or which units (serialized), into which warehouse. */
export interface CustomerReturnLineInput {
  delivery_line_id: string
  warehouse_id: string
  qty?: number
  unit_ids?: string[]
}

/** A unit that left on a delivery line, as a return form offers it. */
export interface DeliveredUnit {
  delivery_line_id: string
  unit_id: string
  serial_number: string | null
}

/** The live credit note of a return, if it has one. */
export interface ReturnCreditNote {
  id: string
  cn_code: string | null
  status: string
  customer_return_id: string
}

const RETURN_SELECT =
  'id, return_code, delivery_id, sales_order_id, customer_id, status, reason, notes, created_by, created_at, confirmed_at, ' +
  'customer_return_lines(id, customer_return_id, line_no, delivery_line_id, product_id, product_name, qty, warehouse_id, unit_ids)'

const sortLines = (r: CustomerReturnRow): CustomerReturnRow => ({
  ...r,
  customer_return_lines: [...(r.customer_return_lines || [])].sort((a, b) => a.line_no - b.line_no),
})

export const customerReturns = {
  /** Every return from one order's deliveries, oldest first, with its lines. */
  async listForOrder(salesOrderId: string): Promise<CustomerReturnRow[]> {
    const rows = await fetchAllRows<CustomerReturnRow>((from, to) =>
      supabase
        .from('customer_returns')
        .select(RETURN_SELECT)
        .eq('sales_order_id', salesOrderId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    )
    return rows.map(sortLines)
  },

  /**
   * The serialized units that left on a delivery, by line, so a return can
   * name them. The rows are readable by managers and accountants only (they
   * carry cost; cost is not selected) — the same people who record a return.
   */
  async deliveredUnits(deliveryId: string): Promise<DeliveredUnit[]> {
    const rows = await fetchAllRows<{ delivery_line_id: string; unit_id: string; unit: { serial_number: string | null } | null }>((from, to) =>
      supabase
        .from('delivery_line_units')
        .select('delivery_line_id, unit_id, unit:inventory_units(serial_number), delivery_line:delivery_lines!inner(delivery_id)')
        .eq('delivery_line.delivery_id', deliveryId)
        .order('delivery_line_id', { ascending: true })
        .order('unit_id', { ascending: true })
        .range(from, to)
    )
    return rows.map((r) => ({ delivery_line_id: r.delivery_line_id, unit_id: r.unit_id, serial_number: r.unit?.serial_number ?? null }))
  },

  /** The credit notes (not voided) made from these returns. */
  async creditNotesFor(returnIds: string[]): Promise<ReturnCreditNote[]> {
    if (returnIds.length === 0) return []
    const rows = await fetchAllRows<ReturnCreditNote>((from, to) =>
      supabase
        .from('credit_notes')
        .select('id, cn_code, status, customer_return_id')
        .in('customer_return_id', returnIds)
        .neq('status', 'voided')
        .order('id', { ascending: true })
        .range(from, to)
    )
    return rows
  },

  /** A draft return (never more than a delivery line has left, drafts counted). */
  async create(
    deliveryId: string,
    lines: CustomerReturnLineInput[],
    fields: { reason?: string | null; notes?: string | null },
    actorEmail: string
  ): Promise<CustomerReturnRow> {
    const { data, error } = await supabase.rpc('create_customer_return', {
      p_delivery_id: deliveryId,
      p_lines: lines,
      p_fields: fields,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    return data as CustomerReturnRow
  },

  /** The goods are back in stock now, at the cost they left with; the return gets its RTN- code. */
  async confirm(returnId: string, actorEmail: string): Promise<CustomerReturnRow> {
    const { data, error } = await supabase.rpc('confirm_customer_return', { p_return_id: returnId, p_actor_email: actorEmail })
    if (error) throw error
    return data as CustomerReturnRow
  },

  /** A draft only; its quantities and units are free again. */
  async cancel(returnId: string, actorEmail: string): Promise<CustomerReturnRow> {
    const { data, error } = await supabase.rpc('cancel_customer_return', { p_return_id: returnId, p_actor_email: actorEmail })
    if (error) throw error
    return data as CustomerReturnRow
  },

  /** A draft credit note for exactly what a confirmed return brought back; returns its id. */
  async creditNote(returnId: string, actorEmail: string): Promise<string> {
    const { data, error } = await supabase.rpc('create_credit_note_from_return', {
      p_return_id: returnId,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    return (data as { id: string }).id
  },
}
