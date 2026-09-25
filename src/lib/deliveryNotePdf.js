import { db } from '../api/supabaseClient'
import { getPdfLayout, buildDocumentHTML, openPrint, escapeHtml as esc } from './documentPdf'
import { nameFromEmail } from './quotationPdf'

/**
 * The delivery note (P-01): what left the warehouse on one confirmed delivery,
 * for the customer to sign. Quantities only — no prices (the invoice carries
 * them) — and the serial numbers that shipped when the printer may read them
 * (managers and accountants; see db.deliveries.serials). Same engine and
 * Control Panel layout as the other sales documents.
 */
export function buildDeliveryNoteHTML({ layout, logoUrl, delivery, salesOrder, customer, serialsByLine = {} }) {
  const customerName = customer?.company_name || customer?.contact_person || '—'
  const shippedOn = delivery.confirmed_at ? new Date(delivery.confirmed_at).toLocaleDateString() : '—'

  const lineRows = (delivery.delivery_lines || [])
    .map((l) => {
      const serials = serialsByLine[l.id] || []
      const serialHtml = serials.length
        ? `<div class="muted" style="font-size:11px;margin-top:2px">S/N: ${serials.map(esc).join(', ')}</div>`
        : ''
      return `<tr>
        <td>${esc(l.product_name)}${serialHtml}</td>
        <td class="center">${Number(l.qty) || 0}</td>
      </tr>`
    })
    .join('')
  const totalUnits = (delivery.delivery_lines || []).reduce((s, l) => s + (Number(l.qty) || 0), 0)

  const bodyHtml = `<table class="lines">
    <thead><tr>
      <th style="width:75%">Product</th>
      <th class="center">Qty Delivered</th>
    </tr></thead>
    <tbody>
      ${lineRows}
      <tr class="grand">
        <td class="right">Total units</td>
        <td class="center">${totalUnits}</td>
      </tr>
    </tbody>
  </table>`

  const notesHtml = delivery.notes
    ? `<div class="notes"><div class="nl">Notes</div><div class="nt">${esc(delivery.notes)}</div></div>`
    : ''
  const extraHtml = `${notesHtml}
    <div class="sign">
      <div class="sign-col"><div class="sl">Shipped By</div><div class="sv">${esc(nameFromEmail(delivery.confirmed_by))}</div></div>
      <div class="sign-col"><div class="sl">Received By (name &amp; signature)</div><div class="sv">&nbsp;</div></div>
      <div class="sign-col"><div class="sl">Date Received</div><div class="sv">&nbsp;</div></div>
    </div>`

  return buildDocumentHTML({
    layout,
    logoUrl,
    title: `Delivery Note ${delivery.delivery_code}`,
    documentName: 'Delivery Note',
    docCode: delivery.delivery_code,
    billTo: customerName,
    billToLabel: 'Deliver To:',
    billToDetails: {
      name: customer?.company_name && customer?.contact_person ? customer.contact_person : null,
      address: customer?.address || null,
      mobile: customer?.mobile || null,
      email: customer?.email || null,
    },
    metaRows: [
      { label: 'Shipped On', value: shippedOn },
      { label: 'Sales Order', value: salesOrder?.so_code || '—' },
      { label: 'Customer PO', value: salesOrder?.reference_po || 'N/A' },
    ],
    bodyHtml,
    extraHtml,
  })
}

export async function downloadDeliveryNotePDF({ delivery, salesOrder, customer }) {
  if (!delivery?.delivery_code) return // a draft has no number and has not shipped
  const { layout, logoUrl } = await getPdfLayout()
  let serialsByLine = {}
  try {
    serialsByLine = await db.deliveries.serials(delivery.id)
  } catch {
    // not readable for this role — the note lists quantities only
  }
  openPrint(buildDeliveryNoteHTML({ layout, logoUrl, delivery, salesOrder, customer, serialsByLine }))
}
