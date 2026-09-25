// Pure helpers behind the Deliveries panel (P-01b), kept apart from the
// component so they can be tested and so fast refresh keeps working.

/** Per order line: ordered, delivered (confirmed), on a draft, still to ship. */
export function deliveryProgress(soLines, deliveries, productsById) {
  const byLine = {}
  for (const d of deliveries) {
    if (d.status === 'cancelled') continue
    for (const l of d.delivery_lines || []) {
      const p = (byLine[l.sales_order_line_id] ||= { delivered: 0, onDraft: 0 })
      if (d.status === 'confirmed') p.delivered += Number(l.qty) || 0
      else p.onDraft += Number(l.qty) || 0
    }
  }
  return soLines
    // Only once the product is known: until then a service line would look like
    // stock and be offered for delivery (the database would refuse it).
    .filter((l) => l.product_id && productsById[l.product_id] && productsById[l.product_id].product_type !== 'service')
    .map((l) => {
      const p = byLine[l.id] || { delivered: 0, onDraft: 0 }
      const ordered = Number(l.qty) || 0
      return { line: l, ordered, delivered: p.delivered, onDraft: p.onDraft, open: Math.max(ordered - p.delivered - p.onDraft, 0) }
    })
}

/** Whole numbers from 0 to what the line still has open; at least one above 0. */
export function validateDeliveryQuantities(rows) {
  const lines = []
  for (const r of rows) {
    const raw = String(r.qty ?? '').trim()
    if (raw === '' || raw === '0') continue
    if (!/^\d+$/.test(raw) || Number(raw) > r.open) return { error: 'salesDocuments.dlvQtyInvalid' }
    lines.push({ sales_order_line_id: r.lineId, qty: Number(raw) })
  }
  if (lines.length === 0) return { error: 'salesDocuments.dlvQtyNone' }
  return { lines }
}

/**
 * Raise the approval request for an invoice just made from a delivery. The
 * invoice already exists when this runs, so it must never be left without one:
 * a draft invoice is posted only through its approval. The total on the request
 * is display-only (approving acts on the invoice id), so if the invoice cannot
 * be read back it is raised anyway, and the caller still moves on.
 */
export async function raiseDeliveryInvoiceApproval({ invoiceId, delivery, fallbackCode, getInvoice, createApproval }) {
  let total = null
  for (let attempt = 0; attempt < 2 && total == null; attempt++) {
    try {
      total = (await getInvoice(invoiceId))?.total ?? null
    } catch {
      // read again once; the request is raised either way
    }
  }
  await createApproval(invoiceId, delivery?.delivery_code || fallbackCode, total ?? 0)
}
