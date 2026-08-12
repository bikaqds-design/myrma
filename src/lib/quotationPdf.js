import { db } from '../api/supabaseClient'
import { getPdfLayout, buildDocumentHTML, openPrint, formatMoney, escapeHtml as esc } from './documentPdf'
import { nameFromEmail } from './utils'

// Re-exported so the PDF modules that have always imported it from here keep
// working; it lives in utils now because it is a plain string helper.
export { nameFromEmail }


/**
 * downloadQuotationPDF — renders a quotation through the shared document engine
 * (Control Panel → PDF Layout controls the look). `relatedType`/`relatedId`
 * point at the activity context where the approval lives ('deal' + deal id, or
 * 'customer' + customer id for standalone quotes) so the approver can be read
 * from the completed approval activity.
 */
export async function downloadQuotationPDF({ quotation, customer, relatedType, relatedId }) {
  if (!quotation) return

  const { layout, logoUrl } = await getPdfLayout()
  const currency = layout.currency || 'EGP'

  const customerName = customer?.company_name || customer?.contact_person || '—'
  const validityStr = quotation.validity_until ? new Date(quotation.validity_until).toLocaleDateString() : 'N/A'

  // Issued-by (who drafted) and account manager (who owns the customer) are
  // deliberately separate — same person or technical-team-drafts both happen.
  const issuedBy = nameFromEmail(quotation.created_by)
  const accountManager = nameFromEmail(customer?.account_manager || quotation.assigned_rep)

  // Approved-by + when from the completed approval activity for this quotation.
  let approvedBy = '—'
  let approvedDate = ''
  if (relatedType && relatedId) {
    try {
      const acts = await db.activities.list(relatedType, relatedId)
      const appr = acts
        .filter((a) => a.type === 'approval' && a.completed_at && (a.outcome_notes || '').toLowerCase().startsWith('approved'))
        .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at))
        .find((a) => (a.title || '').split('|')[2] === quotation.id) ||
        acts.find((a) => a.type === 'approval' && a.completed_at && (a.outcome_notes || '').toLowerCase().startsWith('approved'))
      if (appr) {
        approvedBy = nameFromEmail((appr.outcome_notes || '').replace(/^approved by\s+/i, '').trim())
        approvedDate = new Date(appr.completed_at).toLocaleDateString()
      }
    } catch {}
  }
  const isApproved = quotation.status === 'accepted'

  // ── Body: line items + totals ──────────────────────────────────────────────
  const lineRows = (quotation.line_items || []).map((l) => {
    const base = l.qty * l.unit_price
    const net = base - base * ((l.discount_pct || 0) / 100)
    const total = net + net * ((l.tax_pct || 0) / 100)
    return `<tr>
      <td>${esc(l.product_name)}</td>
      <td class="center">${l.qty}</td>
      <td class="right">${formatMoney(l.unit_price, currency)}</td>
      <td class="center">${l.discount_pct ? l.discount_pct + '%' : '—'}</td>
      <td class="center">${l.tax_pct ? l.tax_pct + '%' : '—'}</td>
      <td class="right">${formatMoney(total, currency)}</td>
    </tr>`
  }).join('')

  const discRow = quotation.discount_amount > 0
    ? `<tr class="sub"><td colspan="5" class="right muted">Discount</td><td class="right muted">-${formatMoney(quotation.discount_amount, currency)}</td></tr>` : ''
  const taxRow = quotation.tax_amount > 0
    ? `<tr class="sub"><td colspan="5" class="right muted">Tax</td><td class="right muted">+${formatMoney(quotation.tax_amount, currency)}</td></tr>` : ''

  const bodyHtml = `<table class="lines">
    <thead><tr><th>Product / Service</th><th class="center">Qty</th><th class="right">Unit Price</th><th class="center">Disc%</th><th class="center">Tax%</th><th class="right">Total</th></tr></thead>
    <tbody>
      ${lineRows}
      ${discRow}${taxRow}
      <tr class="grand"><td colspan="5" class="right">Total</td><td class="right">${formatMoney(quotation.total ?? 0, currency)}</td></tr>
    </tbody>
  </table>`

  // ── Extra: notes + signatures + approval stamp ─────────────────────────────
  const notesHtml = quotation.notes
    ? `<div class="notes"><div class="nl">Notes &amp; Terms</div><div class="nt">${esc(quotation.notes)}</div></div>` : ''
  const stampHtml = isApproved
    ? `<div class="stamp"><div class="st">APPROVED</div><div class="ss">${esc(approvedBy)}${approvedDate ? ' · ' + approvedDate : ''}</div></div>` : ''
  const extraHtml = `${notesHtml}
    <div class="sign">
      <div class="sign-col"><div class="sl">Issued By</div><div class="sv">${esc(issuedBy)}</div></div>
      <div class="sign-col"><div class="sl">Account Manager</div><div class="sv">${esc(accountManager)}</div></div>
      <div class="sign-col"><div class="sl">Approved By</div><div class="sv">${esc(approvedBy)}</div></div>
      ${stampHtml}
    </div>`

  const html = buildDocumentHTML({
    layout,
    logoUrl,
    title: `Quotation ${quotation.qt_code}`,
    documentName: 'Quotation',
    docCode: quotation.qt_code,
    billTo: customerName,
    billToDetails: {
      name: customer?.company_name && customer?.contact_person ? customer.contact_person : null,
      address: customer?.address || null,
      mobile: customer?.mobile || null,
      email: customer?.email || null,
    },
    metaRows: [
      { label: 'Date', value: new Date().toLocaleDateString() },
      { label: 'Payment Terms', value: quotation.payment_terms || 'N/A' },
      { label: 'Valid Until', value: validityStr },
      { label: 'PO Number', value: quotation.reference_po || 'N/A' },
    ],
    balanceLabel: 'Balance Due',
    balanceValue: formatMoney(quotation.total ?? 0, currency),
    bodyHtml,
    extraHtml,
  })

  openPrint(html)
}
