import { db } from '../api/supabaseClient'
import { getPdfLayout, buildDocumentHTML, openPrint, formatMoney, escapeHtml as esc } from './documentPdf'

// A-04b: the tax invoice and the credit note. A VAT-registered seller must show
// its tax registration number, the buyer's tax ID where it has one, each line's
// rate and the tax by rate. Every figure comes from the stored lines, whose
// rate is the one they were posted at (20260911), so a later rate change never
// changes a reprint. English, like the other documents.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const rateText = (r) => `${String(Number(r) || 0)}%`

/** One line's net (after its discount), tax and total. */
export function lineAmounts(l) {
  const base = (Number(l.qty) || 0) * (Number(l.unit_price) || 0)
  const net = base - base * ((Number(l.discount_pct) || 0) / 100)
  const tax = net * ((Number(l.tax_pct) || 0) / 100)
  return { net, tax, total: net + tax }
}

/**
 * The tax by code and rate across the lines, highest rate first: what a tax
 * invoice's VAT summary shows. `names` maps a code to its printed name.
 */
export function vatBreakdown(lines, names = {}) {
  const groups = new Map()
  for (const l of lines || []) {
    const code = l.tax_code || ''
    const rate = Number(l.tax_pct) || 0
    const key = `${code}|${rate}`
    const g = groups.get(key) || { code, rate, name: names[code] || '', net: 0, tax: 0 }
    const a = lineAmounts(l)
    g.net += a.net
    g.tax += a.tax
    groups.set(key, g)
  }
  return [...groups.values()]
    .map((g) => ({ ...g, net: round2(g.net), tax: round2(g.tax) }))
    .sort((a, b) => b.rate - a.rate || a.code.localeCompare(b.code))
}

/** Can this document be printed as a tax document yet? Drafts never are. */
export function isPrintable(kind, doc) {
  if (!doc) return false
  if (kind === 'invoice') return doc.doc_status === 'posted'
  return ['issued', 'applied'].includes(doc.status)
}

/**
 * Opens the print view of a posted invoice (kind 'invoice') or an issued credit
 * note (kind 'credit_note'). Returns false when it is not printable yet.
 */
export async function downloadTaxDocumentPDF({ kind, doc, customer }) {
  if (!isPrintable(kind, doc)) return false
  const [{ layout, logoUrl }, codes] = await Promise.all([
    getPdfLayout(),
    db.taxCodes.list().catch(() => []),
  ])
  // the document's own currency; a foreign one also states its rate and the
  // tax in the base currency, as a VAT invoice must (A-05)
  const baseCurrency = layout.currency || 'EGP'
  const currency = doc.currency || baseCurrency
  const rate = Number(doc.exchange_rate) || 1
  const foreign = currency !== baseCurrency
  const names = Object.fromEntries((codes || []).map((c) => [c.code, c.name]))
  const lines = doc.line_items || []
  const isInvoice = kind === 'invoice'
  const code = isInvoice ? doc.inv_code : doc.cn_code
  const registered = Boolean(layout.taxNumber)
  const docName = isInvoice ? (registered ? 'Tax Invoice' : 'Invoice') : (registered ? 'Tax Credit Note' : 'Credit Note')
  const fmt = (v) => formatMoney(v, currency)
  const dateOf = (v) => (v ? new Date(v).toLocaleDateString() : '—')

  const rows = lines
    .map((l) => {
      const a = lineAmounts(l)
      return `<tr>
        <td>${esc(l.product_name)}${l.description ? `<div class="muted">${esc(l.description)}</div>` : ''}</td>
        <td class="center">${esc(l.qty)}</td>
        <td class="right">${fmt(l.unit_price)}</td>
        <td class="center">${l.discount_pct ? esc(l.discount_pct) + '%' : '—'}</td>
        <td class="center">${esc(l.tax_code || '—')}<div class="muted">${rateText(l.tax_pct)}</div></td>
        <td class="right">${fmt(a.net)}</td>
        <td class="right">${fmt(a.total)}</td>
      </tr>`
    })
    .join('')

  const summary = vatBreakdown(lines, names)
  const summaryRows = summary
    .map((g) => `<tr>
      <td>${esc(g.code || '—')}${g.name ? ` · ${esc(g.name)}` : ''}</td>
      <td class="center">${rateText(g.rate)}</td>
      <td class="right">${fmt(g.net)}</td>
      <td class="right">${fmt(g.tax)}</td>
    </tr>`)
    .join('')

  const bodyHtml = `<table class="lines">
    <thead><tr>
      <th>Product / Service</th>
      <th class="center">Qty</th>
      <th class="right">Unit Price</th>
      <th class="center">Disc%</th>
      <th class="center">Tax</th>
      <th class="right">Net</th>
      <th class="right">Total</th>
    </tr></thead>
    <tbody>
      ${rows}
      ${doc.discount_amount > 0 ? `<tr class="sub"><td colspan="6" class="right muted">Discount</td><td class="right muted">-${fmt(doc.discount_amount)}</td></tr>` : ''}
      <tr class="sub"><td colspan="6" class="right muted">Total before tax</td><td class="right muted">${fmt((doc.subtotal ?? 0) - (doc.discount_amount ?? 0))}</td></tr>
      <tr class="sub"><td colspan="6" class="right muted">Tax</td><td class="right muted">${fmt(doc.tax_amount ?? 0)}</td></tr>
      <tr class="grand"><td colspan="6" class="right">${isInvoice ? 'Total due' : 'Total credited'}</td><td class="right">${fmt(doc.total ?? 0)}</td></tr>
    </tbody>
  </table>
  <table class="lines" style="margin-top:18px">
    <thead><tr><th>Tax summary</th><th class="center">Rate</th><th class="right">Net</th><th class="right">Tax</th></tr></thead>
    <tbody>${summaryRows}${foreign ? `<tr class="sub"><td colspan="3" class="right muted">Tax in ${esc(baseCurrency)} at ${esc(rate)}</td><td class="right muted">${formatMoney(Math.round((Number(doc.tax_amount) || 0) * rate * 100) / 100, baseCurrency)}</td></tr>` : ''}</tbody>
  </table>`

  const notes = isInvoice ? doc.notes : [doc.reason, doc.notes].filter(Boolean).join('\n')
  const extraHtml = notes
    ? `<div class="notes"><div class="nl">${isInvoice ? 'Notes &amp; Terms' : 'Reason'}</div><div class="nt">${esc(notes)}</div></div>`
    : ''

  const rateRow = foreign ? [{ label: 'Exchange rate', value: `1 ${currency} = ${rate} ${baseCurrency}` }] : []
  const metaRows = isInvoice
    ? [
        { label: 'Invoice date', value: dateOf(doc.posted_at) },
        { label: 'Due date', value: dateOf(doc.due_date) },
        { label: 'Payment Terms', value: doc.payment_terms || 'N/A' },
        { label: 'PO Number', value: doc.reference_po || 'N/A' },
        ...rateRow,
      ]
    : [
        { label: 'Date', value: dateOf(doc.issued_at) },
        { label: 'Against invoice', value: doc.source_invoice_number || 'N/A' },
        ...rateRow,
      ]

  const html = buildDocumentHTML({
    layout,
    logoUrl,
    title: `${docName} ${code || ''}`.trim(),
    documentName: docName,
    docCode: code || '',
    billTo: customer?.company_name || customer?.contact_person || '—',
    billToDetails: {
      name: customer?.company_name && customer?.contact_person ? customer.contact_person : null,
      address: customer?.address || null,
      mobile: customer?.mobile || null,
      email: customer?.email || null,
      taxId: customer?.tax_id || null,
    },
    metaRows,
    balanceLabel: isInvoice ? 'Balance due' : 'Credit',
    balanceValue: fmt(isInvoice ? (doc.total ?? 0) - (doc.amount_paid ?? 0) : doc.total ?? 0),
    bodyHtml,
    extraHtml,
  })
  return openPrint(html)
}
