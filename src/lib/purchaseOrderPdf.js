import { getPdfLayout, buildDocumentHTML, openPrint, formatMoney, escapeHtml as esc } from './documentPdf'
import { nameFromEmail } from './quotationPdf'

/**
 * downloadPOPDF — renders a Purchase Order through the shared document engine
 * (the same one quotations/sales orders use). Reuses the 'sales_doc_layout'
 * Control Panel config for company identity — no separate PDFLayout tab for
 * Purchasing; the document itself uses 'Vendor:' instead of 'Bill To:' and
 * adds the PO-specific meta/terms/signature rows.
 */
export async function downloadPOPDF({ purchaseOrder, vendor }) {
  if (!purchaseOrder) return

  const { layout, logoUrl } = await getPdfLayout()
  const currency = purchaseOrder.currency || layout.currency || 'EGP'
  const vendorName = vendor?.brand_name || '—'
  const issuedBy = nameFromEmail(purchaseOrder.created_by)

  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : 'N/A')

  // ── Body: line items + totals ────────────────────────────────────────────
  const lineRows = (purchaseOrder.line_items || [])
    .map((l) => {
      const base = (l.qty_ordered || 0) * (l.unit_cost || 0)
      const net = base - base * ((l.discount_pct || 0) / 100)
      const total = net + net * ((l.tax_pct || 0) / 100)
      return `<tr>
        <td>${esc(l.product_name)}${l.description ? `<br><span class="muted" style="font-size:0.85em">${esc(l.description)}</span>` : ''}</td>
        <td class="center">${l.qty_ordered}</td>
        <td class="right">${formatMoney(l.unit_cost, currency)}</td>
        <td class="center">${l.discount_pct ? l.discount_pct + '%' : '—'}</td>
        <td class="center">${l.tax_pct ? l.tax_pct + '%' : '—'}</td>
        <td class="right">${formatMoney(total, currency)}</td>
      </tr>`
    })
    .join('')

  const discRow =
    purchaseOrder.discount_amount > 0
      ? `<tr class="sub"><td colspan="5" class="right muted">Discount</td><td class="right muted">-${formatMoney(purchaseOrder.discount_amount, currency)}</td></tr>`
      : ''
  const taxRow =
    purchaseOrder.tax_amount > 0
      ? `<tr class="sub"><td colspan="5" class="right muted">Tax</td><td class="right muted">+${formatMoney(purchaseOrder.tax_amount, currency)}</td></tr>`
      : ''

  const bodyHtml = `<table class="lines">
    <thead><tr>
      <th>Product / Service</th>
      <th class="center">Qty</th>
      <th class="right">Unit Price</th>
      <th class="center">Disc%</th>
      <th class="center">Tax%</th>
      <th class="right">Total</th>
    </tr></thead>
    <tbody>
      ${lineRows}
      ${discRow}${taxRow}
      <tr class="grand">
        <td colspan="5" class="right">Total</td>
        <td class="right">${formatMoney(purchaseOrder.total ?? 0, currency)}</td>
      </tr>
    </tbody>
  </table>`

  // ── Extra: addresses + terms + notes + signatures ────────────────────────
  const addressBlock =
    purchaseOrder.shipping_address || purchaseOrder.billing_address
      ? `<div class="notes" style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
          ${purchaseOrder.shipping_address ? `<div><div class="nl">Ship To</div><div class="nt">${esc(purchaseOrder.shipping_address)}</div></div>` : '<div></div>'}
          ${purchaseOrder.billing_address ? `<div><div class="nl">Bill To</div><div class="nt">${esc(purchaseOrder.billing_address)}</div></div>` : ''}
        </div>`
      : ''
  const termsHtml = purchaseOrder.terms_conditions
    ? `<div class="notes"><div class="nl">Terms &amp; Conditions</div><div class="nt">${esc(purchaseOrder.terms_conditions)}</div></div>`
    : ''
  const notesHtml = purchaseOrder.notes
    ? `<div class="notes"><div class="nl">Notes</div><div class="nt">${esc(purchaseOrder.notes)}</div></div>`
    : ''

  const extraHtml = `${addressBlock}${termsHtml}${notesHtml}
    <div class="sign">
      <div class="sign-col"><div class="sl">Issued By</div><div class="sv">${esc(issuedBy)}</div></div>
      <div class="sign-col"><div class="sl">Approved By</div><div class="sv"></div></div>
      <div class="sign-col"><div class="sl">Vendor Acknowledgement</div><div class="sv"></div></div>
    </div>`

  const html = buildDocumentHTML({
    layout,
    logoUrl,
    title: `Purchase Order ${purchaseOrder.po_code}`,
    documentName: 'Purchase Order',
    docCode: purchaseOrder.po_code,
    billTo: vendorName,
    billToLabel: 'Vendor:',
    billToDetails: {
      name: vendor?.contact_person || null,
      address: null,
      mobile: vendor?.phone || null,
      email: vendor?.email || null,
    },
    metaRows: [
      { label: 'Issue Date',       value: fmtDate(purchaseOrder.issue_date) },
      { label: 'Expected Delivery', value: fmtDate(purchaseOrder.expected_delivery_date) },
      { label: 'Currency',         value: currency },
      { label: 'Payment Terms',    value: purchaseOrder.payment_terms || 'N/A' },
      { label: 'Delivery Terms',   value: purchaseOrder.delivery_terms || 'N/A' },
    ],
    balanceLabel: 'Order Total',
    balanceValue: formatMoney(purchaseOrder.total ?? 0, currency),
    bodyHtml,
    extraHtml,
  })

  openPrint(html)
}
