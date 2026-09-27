import { supabase } from '../client.js'
import { fetchAllRows } from './_paging.js'

// Goods receipts (P-03a, 20260897) and invoicing what they brought in
// (P-03b, 20260898). Every write is an RPC: the tables are procedure-only.
// Managers and above create, confirm and cancel a receipt and raise the
// supplier invoice; the database enforces that and every quantity rule.

export interface GoodsReceiptLineRow {
  id: string
  goods_receipt_id: string
  line_no: number
  purchase_order_line_id: string
  product_id: string | null
  product_name: string
  qty: number
  warehouse_id: string
  serials: string[] | null
}

export interface GoodsReceiptRow {
  id: string
  grn_code: string | null
  purchase_order_id: string
  vendor_id: string
  status: 'draft' | 'confirmed' | 'cancelled'
  supplier_ref: string | null
  notes: string | null
  created_by: string
  created_at: string
  confirmed_by: string | null
  confirmed_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  goods_receipt_lines: GoodsReceiptLineRow[]
}

/** One line of a new receipt: which order line, how many, where, and (serialized) the serials. */
export interface GoodsReceiptLineInput {
  purchase_order_line_id: string
  qty: number
  warehouse_id: string
  serials?: string[]
}

// Cost (unit_cost_base) is not selected: the screen does not show it.
const RECEIPT_SELECT =
  'id, grn_code, purchase_order_id, vendor_id, status, supplier_ref, notes, created_by, created_at, confirmed_by, confirmed_at, cancelled_by, cancelled_at, ' +
  'goods_receipt_lines(id, goods_receipt_id, line_no, purchase_order_line_id, product_id, product_name, qty, warehouse_id, serials)'

const sortLines = (r: GoodsReceiptRow): GoodsReceiptRow => ({
  ...r,
  goods_receipt_lines: [...(r.goods_receipt_lines || [])].sort((a, b) => a.line_no - b.line_no),
})

export const goodsReceipts = {
  /** Every receipt of one purchase order, oldest first, with its lines. */
  async listForOrder(purchaseOrderId: string): Promise<GoodsReceiptRow[]> {
    const rows = await fetchAllRows<GoodsReceiptRow>((from, to) =>
      supabase
        .from('goods_receipts')
        .select(RECEIPT_SELECT)
        .eq('purchase_order_id', purchaseOrderId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    )
    return rows.map(sortLines)
  },

  /**
   * The receipt lines of one order already billed by a live supplier invoice
   * (P-03b), as receipt line id -> invoice id.
   */
  async billedLines(purchaseOrderId: string): Promise<Record<string, string>> {
    const rows = await fetchAllRows<{ goods_receipt_line_id: string; vendor_invoice_id: string }>((from, to) =>
      supabase
        .from('vendor_invoice_receipt_lines')
        .select('goods_receipt_line_id, vendor_invoice_id, vi:vendor_invoices!inner(status, purchase_order_id)')
        .eq('vi.purchase_order_id', purchaseOrderId)
        .neq('vi.status', 'cancelled')
        .order('vendor_invoice_id', { ascending: true })
        .order('line_no', { ascending: true })
        .range(from, to)
    )
    return Object.fromEntries(rows.map((r) => [r.goods_receipt_line_id, r.vendor_invoice_id]))
  },

  /** Whether a supplier invoice was raised from receipts (then it is never "received" itself). */
  async isReceiptInvoice(vendorInvoiceId: string): Promise<boolean> {
    const { count, error } = await supabase
      .from('vendor_invoice_receipt_lines')
      .select('line_no', { count: 'exact', head: true })
      .eq('vendor_invoice_id', vendorInvoiceId)
    if (error) throw error
    return (count || 0) > 0
  },

  /** A draft receipt (never more than a line still has open). */
  async create(
    purchaseOrderId: string,
    lines: GoodsReceiptLineInput[],
    fields: { supplier_ref?: string | null; notes?: string | null },
    actorEmail: string
  ): Promise<GoodsReceiptRow> {
    const { data, error } = await supabase.rpc('create_goods_receipt', {
      p_po_id: purchaseOrderId,
      p_lines: lines,
      p_fields: fields,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    return data as GoodsReceiptRow
  },

  /** The goods are in: stock and cost move now, and the receipt gets its GRN- code. */
  async confirm(receiptId: string, actorEmail: string): Promise<GoodsReceiptRow> {
    const { data, error } = await supabase.rpc('confirm_goods_receipt', { p_receipt_id: receiptId, p_actor_email: actorEmail })
    if (error) throw error
    return data as GoodsReceiptRow
  },

  /** A draft only; its quantities and serials are free again. */
  async cancel(receiptId: string, actorEmail: string): Promise<GoodsReceiptRow> {
    const { data, error } = await supabase.rpc('cancel_goods_receipt', { p_receipt_id: receiptId, p_actor_email: actorEmail })
    if (error) throw error
    return data as GoodsReceiptRow
  },

  /**
   * A draft supplier invoice for the confirmed receipt lines not yet billed —
   * all of them, or those of the receipts named. Returns the invoice.
   */
  async invoice(purchaseOrderId: string, receiptIds: string[] | null, actorEmail: string): Promise<{ id: string; total: number }> {
    const { data, error } = await supabase.rpc('create_vendor_invoice_from_receipts', {
      p_po_id: purchaseOrderId,
      p_receipt_ids: receiptIds,
      p_actor_email: actorEmail,
    })
    if (error) throw error
    return data as { id: string; total: number }
  },
}
