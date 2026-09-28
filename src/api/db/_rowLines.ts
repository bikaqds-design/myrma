// W2 / L-02 step 2 — documents are read WITH their line rows (20260883-20260889)
// and `line_items` is rebuilt from those rows, so every screen, form and PDF
// that reads `line_items` now shows the real rows without changing. The stored
// `line_items` copy is used only for a document with no rows at all (written
// outside the RPCs, e.g. restored from a backup taken before 20260883) — the
// same rule the database readers follow (20260890's rma_<doc>_lines_json).

type Row = Record<string, unknown>

const num = (v: unknown): number => (v == null ? 0 : Number(v))

function salesItem(l: Row): Row {
  return {
    product_id: l.product_id ?? null,
    product_name: l.product_name,
    description: l.description ?? null,
    qty: num(l.qty),
    unit_price: num(l.unit_price),
    discount_pct: num(l.discount_pct),
    tax_pct: num(l.tax_pct),
    // the line's tax code (20260911): kept on the screen so a save keeps it
    tax_code: l.tax_code ?? null,
  }
}

function purchaseItem(l: Row): Row {
  return {
    product_id: l.product_id ?? null,
    product_name: l.product_name,
    description: l.description ?? null,
    qty_ordered: num(l.qty_ordered),
    unit_cost: num(l.unit_cost),
    discount_pct: num(l.discount_pct),
    tax_pct: num(l.tax_pct),
    // the line's tax code (20260911): kept on the screen so a save keeps it
    tax_code: l.tax_code ?? null,
  }
}

export interface LineSource {
  /** PostgREST select: the document's columns and its embedded line rows. */
  select: string
  /** The embedded relation's key in the returned row. */
  embed: string
  toItem: (l: Row) => Row
}

// Typed as LineSource (not `satisfies`) so each select stays a plain string:
// supabase-js would otherwise parse the literal against its generated types.
export const ROW_LINES: Record<'quotation' | 'salesOrder' | 'crmInvoice' | 'creditNote' | 'purchaseOrder' | 'vendorInvoice', LineSource> = {
  quotation: { select: '*, quotation_lines(*)', embed: 'quotation_lines', toItem: salesItem },
  salesOrder: { select: '*, sales_order_lines(*)', embed: 'sales_order_lines', toItem: salesItem },
  crmInvoice: { select: '*, crm_invoice_lines(*)', embed: 'crm_invoice_lines', toItem: salesItem },
  creditNote: {
    select: '*, credit_note_lines(*)',
    embed: 'credit_note_lines',
    toItem: (l: Row) => ({ ...salesItem(l), restock: l.restock === true, warehouse_id: l.warehouse_id ?? null }),
  },
  purchaseOrder: { select: '*, purchase_order_lines(*)', embed: 'purchase_order_lines', toItem: purchaseItem },
  vendorInvoice: {
    select: '*, vendor_invoice_lines(*)',
    embed: 'vendor_invoice_lines',
    toItem: (l: Row) => ({ ...purchaseItem(l), qty_received: num(l.qty_received) }),
  },
}

/**
 * Replaces `line_items` with the document's rows (in `line_no` order) and
 * drops the embedded relation, so the row has exactly the shape it had before.
 */
export function withRowLines<T>(row: T, src: LineSource): T {
  if (!row || typeof row !== 'object') return row
  const r = row as Row
  const rows = r[src.embed]
  const out: Row = { ...r }
  delete out[src.embed]
  if (Array.isArray(rows) && rows.length > 0) {
    out.line_items = [...(rows as Row[])]
      .sort((a, b) => num(a.line_no) - num(b.line_no))
      .map(src.toItem)
  }
  return out as T
}
