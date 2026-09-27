import { destinationWarehouses } from '../../lib/warehouseDestinations'

// Pure helpers behind the Goods Receipts panel (P-03c), kept apart from the
// component so they can be tested and so fast refresh keeps working. The
// database (20260897) enforces every rule here again; these only let the form
// point at the line that is wrong before the round trip.

/** Per order line: ordered, received (confirmed), on a draft, still to receive. */
export function receiptProgress(poLines, receipts, productsById) {
  const byLine = {}
  for (const r of receipts) {
    if (r.status === 'cancelled') continue
    for (const l of r.goods_receipt_lines || []) {
      const p = (byLine[l.purchase_order_line_id] ||= { received: 0, onDraft: 0 })
      if (r.status === 'confirmed') p.received += Number(l.qty) || 0
      else p.onDraft += Number(l.qty) || 0
    }
  }
  return poLines
    // Only once the product is known: a service is never received into stock,
    // and until the product loads it could look like stock.
    .filter((l) => l.product_id && productsById[l.product_id] && productsById[l.product_id].product_type !== 'service')
    .map((l) => {
      const p = byLine[l.id] || { received: 0, onDraft: 0 }
      const ordered = Number(l.qty_ordered) || 0
      const product = productsById[l.product_id]
      return {
        line: l,
        serialized: (product.stock_tracking_mode || 'serialized') !== 'bulk',
        ordered,
        received: p.received,
        onDraft: p.onDraft,
        open: Math.max(ordered - p.received - p.onDraft, 0),
      }
    })
}

/** Serial numbers typed or scanned one per line (commas and tabs also separate). */
export function parseSerials(text) {
  return String(text ?? '')
    .split(/[\n,\t;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * rows: { lineId, open, qty, warehouseId, serialized, serialsText }.
 * Whole numbers from 0 to what is open; a warehouse on every line received;
 * for a serialized product exactly one serial per unit, none repeated anywhere
 * in the receipt (compared without case, as the database does).
 */
export function validateReceipt(rows) {
  const lines = []
  const seen = new Set()
  for (const r of rows) {
    const raw = String(r.qty ?? '').trim()
    if (raw === '' || raw === '0') continue
    if (!/^\d+$/.test(raw) || Number(raw) > r.open) return { error: 'purchasing.grnQtyInvalidLine', lineId: r.lineId }
    if (!r.warehouseId) return { error: 'purchasing.grnWarehouseMissing', lineId: r.lineId }
    const qty = Number(raw)
    const line = { purchase_order_line_id: r.lineId, qty, warehouse_id: r.warehouseId }
    if (r.serialized) {
      const serials = parseSerials(r.serialsText)
      if (serials.length !== qty) return { error: 'purchasing.grnSerialCount', lineId: r.lineId, count: serials.length }
      for (const s of serials) {
        const k = s.toLowerCase()
        if (seen.has(k)) return { error: 'purchasing.grnSerialDuplicate', lineId: r.lineId, serial: s }
        seen.add(k)
      }
      line.serials = serials
    }
    lines.push(line)
  }
  if (lines.length === 0) return { error: 'purchasing.grnQtyNone' }
  return { lines }
}

/** Confirmed receipt lines not yet on a live supplier invoice. */
export function unbilledLines(receipts, billed) {
  return receipts
    .filter((r) => r.status === 'confirmed')
    .flatMap((r) => r.goods_receipt_lines || [])
    .filter((l) => !billed[l.id])
}

/**
 * Warehouses goods may be received into: the manual-destination rule (active,
 * not a system location) plus a sellable type — main, branch or the legacy
 * untyped kind — as confirm_goods_receipt checks.
 */
export function receivableWarehouses(warehouses) {
  return destinationWarehouses(warehouses).filter((w) => w.warehouse_type == null || ['main', 'branch'].includes(w.warehouse_type))
}
