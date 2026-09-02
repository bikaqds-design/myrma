import { getPdfLayout, buildDocumentHTML, formatMoney, openPrint, escapeHtml as esc } from './documentPdf'
import { nameFromEmail } from './quotationPdf'

/**
 * downloadVIPDF — renders a Vendor Invoice through the shared document engine,
 * the same one quotations, sales orders and purchase orders use.
 *
 * Mirrors purchaseOrderPdf.js, with the differences a payable actually needs:
 *
 *  - the line table shows Qty Received alongside Qty Ordered, because a vendor
 *    invoice can be partially received and the paperwork should say so;
 *  - the totals block carries Amount Paid and Amount Due. A PO is a commitment
 *    and has no payment state; an invoice is a debt, and printing one without
 *    the outstanding figure makes it useless for reconciliation.
 *
 * Reuses the 'sales_doc_layout' Control Panel config for company identity —
 * there is no separate purchasing layout — and the `billToLabel` override so the
 * party block reads "Vendor:" rather than "Bill To:".
 */
export async function downloadVIPDF({ vendorInvoice, vendor, purchaseOrder = null }) {
  if (!vendorInvoice) return

  const { layout, logoUrl } = await getPdfLayout()
  const currency = vendorInvoice.currency || layout.currency || 'EGP'
  const vendorName = vendor?.brand_name || '—'
  const issuedBy = nameFromEmail(vendorInvoice.created_by)

  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : 'N/A')

  const total = Number(vendorInvoice.total ?? 0)
  const paid = Number(vendorInvoice.amount_paid ?? 0)
  const due = Math.round((total - paid) * 100) / 100

  // A partially-received invoice should show it; a fully-received one adds noise.
  const anyPartial = (vendorInvoice.line_items || []).some(
    (l) => (l.qty_received ?? 0) < (l.qty_ordered ?? 0)
  )

  const lineRows = (vendorInvoice.line_items || [])
    .map((l) => {
      const base = (l.qty_ordered || 0) * (l.unit_cost || 0)
      const net = base - base * ((l.discount_pct || 0) / 100)
      const lineTotal = net + net * ((l.tax_pct || 0) / 100)
      return `<tr>
        <td>${esc(l.product_name)}${l.description ? `<br><span class="muted" style="font-size:0.85em">${esc(l.description)}</span>` : ''}</td>
        <td class="center">${l.qty_ordered ?? 0}</td>
        ${anyPartial ? `<td class="center">${l.qty_received ?? 0}</td>` : ''}
        <td class="right">${formatMoney(l.unit_cost, currency)}</td>
        <td class="center">${l.discount_pct ? l.discount_pct + '%' : '—'}</td>
        <td class="center">${l.tax_pct ? l.tax_pct + '%' : '—'}</td>
        <td class="right">${formatMoney(lineTotal, currency)}</td>
      </tr>`
    })
    .join('')

  // colspan has to track the optional Qty Received column or the totals rows
  // drift out of alignment with the header.
  const labelSpan = anyPartial ? 6 : 5

  const discRow =
    vendorInvoice.discount_amount > 0
      ? `<tr class="sub"><td colspan="${labelSpan}" class="right muted">Discount</td><td class="right muted">-${formatMoney(vendorInvoice.discount_amount, currency)}</td></tr>`
      : ''
  const taxRow =
    vendorInvoice.tax_amount > 0
      ? `<tr class="sub"><td colspan="${labelSpan}" class="right muted">Tax</td><td class="right muted">+${formatMoney(vendorInvoice.tax_amount, currency)}</td></tr>`
      : ''
  const paidRow =
    paid > 0
      ? `<tr class="sub"><td colspan="${labelSpan}" class="right muted">Amount Paid</td><td class="right muted">-${formatMoney(paid, currency)}</td></tr>`
      : ''

  const bodyHtml = `<table class="lines">
    <thead><tr>
      <th>Product / Service</th>
      <th class="center">Qty Ordered</th>
      ${anyPartial ? '<th class="center">Qty Received</th>' : ''}
      <th class="right">Unit Cost</th>
      <th class="center">Disc%</th>
      <th class="center">Tax%</th>
      <th class="right">Total</th>
    </tr></thead>
    <tbody>
      ${lineRows}
      ${discRow}${taxRow}
      <tr class="sub"><td colspan="${labelSpan}" class="right muted">Invoice Total</td><td class="right muted">${formatMoney(total, currency)}</td></tr>
      ${paidRow}
      <tr class="grand">
        <td colspan="${labelSpan}" class="right">Amount Due</td>
        <td class="right">${formatMoney(due, currency)}</td>
      </tr>
    </tbody>
  </table>`

  const notesHtml = vendorInvoice.notes
    ? `<div class="notes"><div class="nl">Notes</div><div class="nt">${esc(vendorInvoice.notes)}</div></div>`
    : ''

  const extraHtml = `${notesHtml}
    <div class="sign">
      <div class="sign-col"><div class="sl">Received By</div><div class="sv">${esc(issuedBy)}</div></div>
      <div class="sign-col"><div class="sl">Approved By</div><div class="sv"></div></div>
      <div class="sign-col"><div class="sl">Accounts Payable</div><div class="sv"></div></div>
    </div>`

  const metaRows = [
    { label: 'Invoice Date', value: fmtDate(vendorInvoice.invoice_date) },
    { label: 'Due Date', value: fmtDate(vendorInvoice.due_date) },
    { label: 'Currency', value: currency },
    { label: 'Payment Terms', value: vendorInvoice.payment_terms || 'N/A' },
  ]
  // On an import, the rate and what the invoice came to in base currency. This
  // is the number every unit cost and every margin figure downstream is derived
  // from, so the printed copy filed against the shipment should carry it —
  // otherwise reconciling the file against the books means re-deriving a rate
  // that was recorded months ago.
  const baseCurrency = layout.currency || 'EGP'
  if (currency !== baseCurrency) {
    const rate = Number(vendorInvoice.exchange_rate) || 0
    const totalBase =
      vendorInvoice.total_base != null ? Number(vendorInvoice.total_base) : (Number(total) || 0) * rate
    metaRows.push({ label: 'Exchange Rate', value: `1 ${currency} = ${rate} ${baseCurrency}` })
    metaRows.push({ label: `Total (${baseCurrency})`, value: formatMoney(totalBase, baseCurrency) })
  }
  // Only shown when the invoice actually came from a PO, so a standalone
  // invoice does not print an empty reference row.
  if (purchaseOrder?.po_code) {
    metaRows.push({ label: 'Purchase Order', value: purchaseOrder.po_code })
  }

  const html = buildDocumentHTML({
    layout,
    logoUrl,
    // vi_code is null until first receipt, so fall back rather than print "null".
    title: `Vendor Invoice ${vendorInvoice.vi_code || ''}`.trim(),
    documentName: 'Vendor Invoice',
    docCode: vendorInvoice.vi_code || '—',
    billTo: vendorName,
    billToLabel: 'Vendor:',
    billToDetails: {
      name: vendor?.contact_person || null,
      address: null,
      mobile: vendor?.phone || null,
      email: vendor?.email || null,
    },
    metaRows,
    balanceLabel: 'Amount Due',
    balanceValue: formatMoney(due, currency),
    bodyHtml,
    extraHtml,
  })

  openPrint(html)
}
