// Pure helpers behind the Returns section of the Deliveries panel (P-05d),
// kept apart from the component so they can be tested and so fast refresh
// keeps working. The database (20260902) enforces every rule here again; these
// only let the form point at the line that is wrong before the round trip.

/** Per delivery line: delivered, already back or on a draft return, still returnable. */
export function returnableByLine(delivery, returns) {
  const used = {}
  const usedUnits = {}
  for (const r of returns) {
    if (r.delivery_id !== delivery.id || r.status === 'cancelled') continue
    for (const l of r.customer_return_lines || []) {
      used[l.delivery_line_id] = (used[l.delivery_line_id] || 0) + (Number(l.qty) || 0)
      for (const u of l.unit_ids || []) (usedUnits[l.delivery_line_id] ||= new Set()).add(u)
    }
  }
  return (delivery.delivery_lines || []).map((l) => {
    const delivered = Number(l.qty) || 0
    const back = used[l.id] || 0
    return { line: l, delivered, back, left: Math.max(delivered - back, 0), usedUnits: usedUnits[l.id] || new Set() }
  })
}

/**
 * The lines of a new return from what the form holds. A serialized line is the
 * units ticked; a bulk line a whole number from 0 to what is left. Every line
 * sent needs a warehouse. Names the line that is wrong.
 */
export function validateReturnLines(rows) {
  const lines = []
  for (const r of rows) {
    if (r.serialized) {
      const units = r.unitIds || []
      if (units.length === 0) continue
      if (!r.warehouseId) return { error: 'salesDocuments.rtnWarehouseMissing', lineId: r.lineId }
      lines.push({ delivery_line_id: r.lineId, unit_ids: units, warehouse_id: r.warehouseId })
      continue
    }
    const raw = String(r.qty ?? '').trim()
    if (raw === '' || raw === '0') continue
    if (!/^\d+$/.test(raw) || Number(raw) > r.left) return { error: 'salesDocuments.rtnQtyInvalidLine', lineId: r.lineId }
    if (!r.warehouseId) return { error: 'salesDocuments.rtnWarehouseMissing', lineId: r.lineId }
    lines.push({ delivery_line_id: r.lineId, qty: Number(raw), warehouse_id: r.warehouseId })
  }
  if (lines.length === 0) return { error: 'salesDocuments.rtnNothing' }
  return { lines }
}
