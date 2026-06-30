import toast from 'react-hot-toast'
import { db, branding } from '../api/supabaseClient'

// ── Unified document PDF engine ──────────────────────────────────────────────
// One layout, shared by every printable document in the system (quotations,
// sales orders, invoices, credit notes, RMA tickets, and future documents).
// The look is driven entirely by the `pdf_layout` config managed in
// Control Panel → PDF Layout, so the company controls the style in one place.

export const PDF_LAYOUT_DEFAULT = {
  companyName: '',        // filled once in Control Panel (falls back to branding)
  companyAddress: '',     // the address line under the company name
  companyPhone: '',       // the phone line under the address
  currency: 'EGP',        // default currency code shown on money values
  primaryColor: '#4338ca',
  font: 'Arial, sans-serif',
  fontSize: 12,
  footerText: '',
  showGeneratedDate: true,
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Loads the shared PDF layout config + logo (branding). Never throws. */
export async function getPdfLayout() {
  const layout = { ...PDF_LAYOUT_DEFAULT }
  let logoUrl = null
  try {
    const [cfgResult, brd] = await Promise.all([db.rmaConfig.getAll(), branding.getBranding()])
    // Sales documents use their own layout config, separate from the RMA
    // ticket layout (config_key 'pdf_layout'), since the two look nothing alike.
    let saved = null
    if (!cfgResult.missing) {
      const row = cfgResult.data.find((r) => r.config_key === 'sales_doc_layout')
      if (row?.config_value) {
        saved = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
      }
    }
    if (saved) Object.assign(layout, saved)
    if (brd) {
      logoUrl = brd.logo_url || null
      if (!layout.companyName) layout.companyName = brd.company_name || ''
      if (!saved?.primaryColor && brd.primary_color) layout.primaryColor = brd.primary_color
    }
  } catch {
    // Defaults are fine if config/branding are unavailable.
  }
  return { layout, logoUrl }
}

/** Format a money value with the configured currency code, e.g. "EGP 104,834.22". */
export function formatMoney(value, currency = 'EGP') {
  const n = (Number(value) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${currency} ${n}`
}

/**
 * buildDocumentHTML — renders the shared layout. Each document supplies its own
 * body (`bodyHtml`) and meta; the engine owns the header, identity bar, Bill-To,
 * the top-right title/code/meta/balance block, theming and the footer.
 */
export function buildDocumentHTML({
  layout = PDF_LAYOUT_DEFAULT,
  logoUrl = null,
  title = 'Document',
  documentName = '',          // big top-right name e.g. "Price Quotation"
  docCode = '',               // shown as "# <code>"
  billTo = '',
  billToDetails = null,       // { name?, address?, mobile?, email? } — extra lines under company
  metaRows = [],              // [{ label, value }]
  balanceLabel = '',
  balanceValue = '',
  bodyHtml = '',
  extraHtml = '',             // signatures / stamp / notes appended after the body
}) {
  const color = layout.primaryColor || '#4338ca'
  const font = layout.font || 'Arial, sans-serif'
  const fs = Number(layout.fontSize) || 12
  const dateStr = new Date().toLocaleDateString()

  const metaHtml = metaRows
    .map((r) => `<tr><td class="ml">${esc(r.label)}:</td><td class="mv">${esc(r.value)}</td></tr>`)
    .join('')

  const identityLines = [layout.companyAddress, layout.companyPhone]
    .filter(Boolean)
    .map((l) => `<div class="cl">${esc(l)}</div>`)
    .join('')

  const footerBits = [layout.footerText || layout.companyName, layout.showGeneratedDate ? `Generated ${dateStr}` : '']
    .filter(Boolean)
    .map(esc)
    .join(' · ')

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(title)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:${font};font-size:${fs}px;color:#1a1a1a;padding:40px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:32px;margin-bottom:30px}
  .head-left{max-width:55%}
  .logo{max-height:64px;max-width:200px;object-fit:contain;display:block;margin-bottom:12px}
  .cn{font-weight:bold;font-size:${fs + 1}px;color:#211f1b;text-transform:uppercase;letter-spacing:.2px}
  .cl{font-size:${fs - 1}px;color:#3a3a3a;margin-top:1px}
  .bill{margin-top:16px}
  .bl{font-size:${fs - 2}px;text-transform:uppercase;letter-spacing:.05em;color:#9aa0a6}
  .bn{font-weight:bold;font-size:${fs + 1}px;color:#211f1b;margin-top:2px}
  .head-right{text-align:right;min-width:42%}
  .dn{font-size:${fs + 14}px;font-weight:300;color:#5a5f66;line-height:1.1}
  .dc{font-size:${fs - 1}px;color:#9aa0a6;margin-top:2px;margin-bottom:14px}
  table.meta{margin-left:auto;border-collapse:collapse}
  table.meta td{padding:3px 0;font-size:${fs - 1}px;vertical-align:top}
  .ml{color:#9aa0a6;text-align:right;padding-right:18px;white-space:nowrap}
  .mv{color:#211f1b;font-weight:600;text-align:right;white-space:nowrap}
  .balance{margin-top:10px;margin-left:auto;display:flex;justify-content:space-between;gap:24px;
    background:#f1f2f4;border-radius:6px;padding:8px 14px;min-width:240px}
  .bal-l{font-weight:bold;color:#211f1b;font-size:${fs}px}
  .bal-v{font-weight:bold;color:${color};font-size:${fs}px}
  table.lines{width:100%;border-collapse:collapse;margin-top:8px}
  table.lines th{background:#f4f6f9;text-align:left;padding:8px 10px;font-size:${fs - 2}px;text-transform:uppercase;color:#6c6760;border-bottom:2px solid ${color}44}
  table.lines td{padding:8px 10px;border-bottom:1px solid #f0f2f6}
  table.lines tr.sub td{border-bottom:none;padding:3px 10px}
  table.lines tr.grand td{border-top:2px solid #e6e9ef;padding-top:10px;font-size:${fs + 2}px;font-weight:bold;color:${color}}
  .right{text-align:right}.center{text-align:center}.muted{color:#6c6760}
  .notes{margin-top:26px;padding-top:14px;border-top:1px solid #e6e9ef}
  .nl{font-size:${fs - 2}px;text-transform:uppercase;color:#6c6760;margin-bottom:6px}
  .nt{font-size:${fs - 1}px;white-space:pre-wrap;line-height:1.6;color:#3a3a3a}
  .sign{position:relative;display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:40px;padding-top:18px;border-top:1px solid #e6e9ef}
  .sign-col .sl{font-size:${fs - 2}px;text-transform:uppercase;color:#6c6760;margin-bottom:4px}
  .sign-col .sv{font-weight:600;font-size:${fs - 1}px;padding-bottom:6px;border-bottom:1px solid #cfd4dd;min-height:22px}
  .stamp{position:absolute;right:8px;top:-18px;transform:rotate(-13deg);border:3px double #16a34a;color:#16a34a;padding:6px 16px;border-radius:8px;text-align:center;opacity:.9}
  .stamp .st{font-size:${fs + 12}px;font-weight:800;letter-spacing:3px;line-height:1}
  .stamp .ss{font-size:${fs - 4}px;font-weight:600;letter-spacing:.4px;margin-top:3px}
  .foot{margin-top:36px;text-align:center;font-size:${fs - 2}px;color:#a09d99}
  @media print{body{padding:20px}}
</style></head><body>
<div class="head">
  <div class="head-left">
    ${logoUrl ? `<img class="logo" src="${esc(logoUrl)}">` : ''}
    <div class="cn">${esc(layout.companyName)}</div>
    ${identityLines}
    ${billTo ? `<div class="bill">
      <div class="bl">Bill To:</div>
      <div class="bn">${esc(billTo)}</div>
      ${billToDetails?.name ? `<div class="cl">${esc(billToDetails.name)}</div>` : ''}
      ${billToDetails?.address ? `<div class="cl">${esc(billToDetails.address)}</div>` : ''}
      ${billToDetails?.mobile ? `<div class="cl">Tel: ${esc(billToDetails.mobile)}</div>` : ''}
      ${billToDetails?.email ? `<div class="cl">Email: ${esc(billToDetails.email)}</div>` : ''}
    </div>` : ''}
  </div>
  <div class="head-right">
    <div class="dn">${esc(documentName)}</div>
    ${docCode ? `<div class="dc"># ${esc(docCode)}</div>` : ''}
    <table class="meta">${metaHtml}</table>
    ${balanceLabel ? `<div class="balance"><span class="bal-l">${esc(balanceLabel)}:</span><span class="bal-v">${esc(balanceValue)}</span></div>` : ''}
  </div>
</div>
${bodyHtml}
${extraHtml}
${footerBits ? `<div class="foot">${footerBits}</div>` : ''}
</body></html>`
}

/** Opens the HTML in a print window. Returns false (and toasts) if popups blocked. */
export function openPrint(html) {
  const win = window.open('', '_blank')
  if (!win) { toast.error('Allow popups to download the PDF'); return false }
  win.document.write(html)
  win.document.close()
  win.focus()
  setTimeout(() => win.print(), 400)
  return true
}

export { esc as escapeHtml }
