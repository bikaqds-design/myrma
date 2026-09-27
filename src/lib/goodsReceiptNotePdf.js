import { getPdfLayout, buildDocumentHTML, openPrint, escapeHtml as esc } from './documentPdf'
import { nameFromEmail } from './quotationPdf'

/**
 * The goods received note (P-03c): what arrived on one confirmed receipt, by
 * product, with the warehouse it went into and the serials scanned. No
 * prices — the supplier's invoice carries them. Same engine and Control Panel
 * layout as the other documents.
 */
export function buildGoodsReceiptNoteHTML({ layout, logoUrl, receipt, purchaseOrder, vendor, warehouseNames = {} }) {
  const receivedOn = receipt.confirmed_at ? new Date(receipt.confirmed_at).toLocaleDateString() : '—'
  const lines = receipt.goods_receipt_lines || []

  const lineRows = lines
    .map((l) => {
      const serials = Array.isArray(l.serials) ? l.serials : []
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
      <th>Warehouse</th>
      <th class="center">Qty Received</th>
    </tr></thead>
    <tbody>
      ${lineRows}
      <tr class="grand">
        <td class="right" colspan="2">Total units</td>
        <td class="center">${totalUnits}</td>
      </tr>
    </tbody>
  </table>`

  const notesHtml = receipt.notes
    ? `<div class="notes"><div class="nl">Notes</div><div class="nt">${esc(receipt.notes)}</div></div>`
    : ''
  const extraHtml = `${notesHtml}
    <div class="sign">
      <div class="sign-col"><div class="sl">Received By</div><div class="sv">${esc(nameFromEmail(receipt.confirmed_by))}</div></div>
      <div class="sign-col"><div class="sl">Checked By (name &amp; signature)</div><div class="sv">&nbsp;</div></div>
      <div class="sign-col"><div class="sl">Date</div><div class="sv">&nbsp;</div></div>
    </div>`

  return buildDocumentHTML({
    layout,
    logoUrl,
    title: `Goods Received Note ${receipt.grn_code}`,
    documentName: 'Goods Received Note',
    docCode: receipt.grn_code,
    billTo: vendor?.brand_name || '—',
    billToLabel: 'Supplier:',
    billToDetails: {
      name: vendor?.contact_person || null,
      address: null,
      mobile: vendor?.phone || null,
      email: vendor?.email || null,
    },
    metaRows: [
      { label: 'Received On', value: receivedOn },
      { label: 'Purchase Order', value: purchaseOrder?.po_code || '—' },
      { label: 'Supplier Delivery Note', value: receipt.supplier_ref || 'N/A' },
    ],
    bodyHtml,
    extraHtml,
  })
}

export async function downloadGoodsReceiptNotePDF({ receipt, purchaseOrder, vendor, warehouseNames }) {
  if (!receipt?.grn_code) return // a draft has no number and nothing has arrived on it
  const { layout, logoUrl } = await getPdfLayout()
  openPrint(buildGoodsReceiptNoteHTML({ layout, logoUrl, receipt, purchaseOrder, vendor, warehouseNames }))
}
