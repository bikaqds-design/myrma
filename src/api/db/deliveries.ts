import { supabase } from '../client.js'
import { fetchAllRows } from './_paging.js'

// Deliveries (P-01, 20260894) and invoicing them (P-02, 20260896).
// Every write is an RPC: the tables are procedure-only. Managers and above
// create, confirm and cancel a delivery; the order's rep may invoice one.

export interface DeliveryLineRow {
  id: string
  delivery_id: string
  line_no: number
  sales_order_line_id: string
  product_id: string | null
  product_name: string
  qty: number
}

export interface DeliveryRow {
  id: string
  delivery_code: string | null
  sales_order_id: string
  customer_id: string
  status: 'draft' | 'confirmed' | 'cancelled'
  notes: string | null
  created_by: string
  created_at: string
  confirmed_by: string | null
  confirmed_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  delivery_lines: DeliveryLineRow[]
}

/** One line of a new delivery: which order line, how many. */
export interface DeliveryLineInput {
  sales_order_line_id: string
  qty: number
}

const DELIVERY_SELECT =
  'id, delivery_code, sales_order_id, customer_id, status, notes, created_by, created_at, confirmed_by, confirmed_at, cancelled_by, cancelled_at, ' +
  'delivery_lines(id, delivery_id, line_no, sales_order_line_id, product_id, product_name, qty)'

const sortLines = (d: DeliveryRow): DeliveryRow => ({
  ...d,
  delivery_lines: [...(d.delivery_lines || [])].sort((a, b) => a.line_no - b.line_no),
})

export const deliveries = {
  /** Every delivery of one order, oldest first, with its lines. */
  async listForOrder(salesOrderId: string): Promise<DeliveryRow[]> {
    const rows = await fetchAllRows<DeliveryRow>((from, to) =>
      supabase
        .from('deliveries')
        .select(DELIVERY_SELECT)
        .eq('sales_order_id', salesOrderId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    )
    return rows.map(sortLines)
  },

  /** A draft delivery of the given quantities (never more than a line still has open). */
  async create(salesOrderId: string, lines: DeliveryLineInput[], notes: string | null, actorEmail: string): Promise<DeliveryRow> {
    const { data, error } = await supabase.rpc('create_delivery', {
      p_so_id: salesOrderId,
      p_lines: lines,
      p_notes: notes,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    return data as DeliveryRow
  },

  /** The goods leave: stock and cost move now, and the delivery gets its DN- code. */
  async confirm(deliveryId: string, actorEmail: string): Promise<DeliveryRow> {
    const { data, error } = await supabase.rpc('confirm_delivery', { p_delivery_id: deliveryId, p_actor_email: actorEmail })
    if (error) throw error
    return data as DeliveryRow
  },

  /** A draft only; its quantities are free again. */
  async cancel(deliveryId: string, actorEmail: string): Promise<DeliveryRow> {
    const { data, error } = await supabase.rpc('cancel_delivery', { p_delivery_id: deliveryId, p_actor_email: actorEmail })
    if (error) throw error
    return data as DeliveryRow
  },

  /** A draft invoice for what a confirmed delivery shipped; returns its id. */
  async invoice(deliveryId: string, actorEmail: string): Promise<string> {
    const { data, error } = await supabase.rpc('create_invoice_from_delivery', {
      p_delivery_id: deliveryId,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    return data as string
  },
}
