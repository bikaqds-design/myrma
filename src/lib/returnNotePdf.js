import { db } from '../api/supabaseClient'
import { getPdfLayout, buildDocumentHTML, openPrint, escapeHtml as esc } from './documentPdf'
import { nameFromEmail } from './quotationPdf'

/**
 * The return note (P-05): what came back from a customer on one confirmed
 * return, for both sides to sign. Quantities only — no prices (the credit note
 * carries them) — the serial numbers that came back when the printer may read
 * them (managers and accountants, as the delivery note), and the warehouse each
 * line went back into. Same engine and Control Panel layout as the other
 * sales documents.
 */
export function buildReturnNoteHTML({ layout, logoUrl, ret, deliveryCode, salesOrder, customer, serialByUnit = {}, warehouseNames = {} }) {
  const customerName = customer?.company_name || customer?.contact_person || '—'
  const receivedOn = ret.confirmed_at ? new Date(ret.confirmed_at).toLocaleDateString() : '—'

  const lines = ret.customer_return_lines || []
  const lineRows = lines
    .map((l) => {
      const serials = (l.unit_ids || []).map((u) => serialByUnit[u]).filter(Boolean)
      const serialHtml = serials.length
        ? `<div class="muted" style="font-size:11px;margin-top:2px">S/N: ${serials.map(esc).join(', ')}</div>`
        : ''
      return `<tr>
        <td>${esc(l.product_name)}${serialHtml}</td>
        <td>${esc(warehouseNames[l.warehouse_id] || '—')}</td>
        <td class="center">${Number(l.qty) || 0}</td>
      </tr>`
    })
    .join('')
  const totalUnits = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0)

  const bodyHtml = `<table class="lines">
    <thead><tr>
      <th style="width:55%">Product</th>
      <th>Received Into</th>
      <th class="center">Qty Returned</th>
    </tr></thead>
    <tbody>
      ${lineRows}
      <tr class="grand">
        <td class="right" colspan="2">Total units</td>
        <td class="center">${totalUnits}</td>
      </tr>
    </tbody>
  </table>`

  const reasonHtml = ret.reason
    ? `<div class="notes"><div class="nl">Reason</div><div class="nt">${esc(ret.reason)}</div></div>`
    : ''
  const extraHtml = `${reasonHtml}
    <div class="sign">
      <div class="sign-col"><div class="sl">Returned By (name &amp; signature)</div><div class="sv">&nbsp;</div></div>
      <div class="sign-col"><div class="sl">Received By</div><div class="sv">${esc(nameFromEmail(ret.confirmed_by))}</div></div>
      <div class="sign-col"><div class="sl">Date</div><div class="sv">${esc(receivedOn)}</div></div>
    </div>`

  return buildDocumentHTML({
    layout,
    logoUrl,
    title: `Return Note ${ret.return_code}`,
    documentName: 'Return Note',
    docCode: ret.return_code,
    billTo: customerName,
    billToLabel: 'Returned By:',
    billToDetails: {
      name: customer?.company_name && customer?.contact_person ? customer.contact_person : null,
      address: customer?.address || null,
      mobile: customer?.mobile || null,
      email: customer?.email || null,
    },
    metaRows: [
      { label: 'Received On', value: receivedOn },
      { label: 'Delivery', value: deliveryCode || '—' },
      { label: 'Sales Order', value: salesOrder?.so_code || '—' },
    ],
    bodyHtml,
    extraHtml,
  })
}

export async function downloadReturnNotePDF({ ret, deliveryCode, salesOrder, customer }) {
  if (!ret?.return_code) return // a draft has no number and nothing has come back yet
  const { layout, logoUrl } = await getPdfLayout()
  let serialByUnit = {}
  try {
    const units = await db.customerReturns.deliveredUnits(ret.delivery_id)
    serialByUnit = Object.fromEntries(units.filter((u) => u.serial_number).map((u) => [u.unit_id, u.serial_number]))
  } catch {
    // not readable for this role — the note lists quantities only
  }
  let warehouseNames = {}
  try {
    const res = await db.warehouses.list()
    warehouseNames = Object.fromEntries((res.missing ? [] : res.data).map((w) => [w.id, w.name]))
  } catch {
    // the column shows a dash
  }
  openPrint(buildReturnNoteHTML({ layout, logoUrl, ret, deliveryCode, salesOrder, customer, serialByUnit, warehouseNames }))
}
