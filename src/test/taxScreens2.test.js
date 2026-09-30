// @vitest-environment node
/**
 * taxScreens2.test.js — tax screens, part 2 (A-04b over 20260911).
 *
 * A line's code is proposed from the product's usual code and the customer's
 * or supplier's tax status; customers, suppliers and products carry those
 * fields; printed documents show the company's tax registration number and the
 * buyer's tax ID; posted invoices and issued credit notes print as tax
 * documents with each line's rate and the tax by rate.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('../api/supabaseClient', () => ({ db: {}, branding: {} }))
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn() } }))

const { proposeTaxCode, TAX_STATUSES } = await import('../pages/Accounting/_tax')
const { lineAmounts, vatBreakdown, isPrintable } = await import('../lib/taxInvoicePdf')
const { buildDocumentHTML, PDF_LAYOUT_DEFAULT } = await import('../lib/documentPdf')

const CODES = [
  { code: 'VAT14', kind: 'standard', rate: 14, is_default: true, is_active: true },
  { code: 'VAT5', kind: 'reduced', rate: 5, is_default: true, is_active: true },
  { code: 'OLD', kind: 'reduced', rate: 7, is_default: false, is_active: false },
  { code: 'ZERO', kind: 'zero', rate: 0, is_default: true, is_active: true },
  { code: 'EXEMPT', kind: 'exempt', rate: 0, is_default: false, is_active: true },
  { code: 'OOS', kind: 'out_of_scope', rate: 0, is_default: false, is_active: true },
]
const read = (f) => readFileSync(f, 'utf8')

describe('proposing a line\'s tax code', () => {
  it('the product\'s usual code, when it is active', () => {
    expect(proposeTaxCode(CODES, { productCode: 'VAT5' })).toEqual({ tax_code: 'VAT5', tax_pct: 5 })
    expect(proposeTaxCode(CODES, { productCode: 'OLD' })).toBeNull()
    expect(proposeTaxCode(CODES, {})).toBeNull()
  })

  it('an exempt customer or supplier makes the line exempt, whatever the product', () => {
    expect(proposeTaxCode(CODES, { productCode: 'VAT14', partyStatus: 'exempt' })).toEqual({ tax_code: 'EXEMPT', tax_pct: 0 })
    expect(proposeTaxCode(CODES, { productCode: 'VAT14', partyStatus: 'exempt', side: 'purchase' })).toEqual({ tax_code: 'EXEMPT', tax_pct: 0 })
  })

  it('a foreign customer is an export (zero-rated); a foreign supplier is out of scope', () => {
    expect(proposeTaxCode(CODES, { productCode: 'VAT14', partyStatus: 'foreign', side: 'sales' })).toEqual({ tax_code: 'ZERO', tax_pct: 0 })
    expect(proposeTaxCode(CODES, { productCode: 'VAT14', partyStatus: 'foreign', side: 'purchase' })).toEqual({ tax_code: 'OOS', tax_pct: 0 })
  })

  it('a registered or unregistered party leaves it to the product', () => {
    for (const s of ['registered', 'unregistered', null]) {
      expect(proposeTaxCode(CODES, { productCode: 'VAT14', partyStatus: s })).toEqual({ tax_code: 'VAT14', tax_pct: 14 })
    }
  })

  it('with no code of the kind needed, it falls back to the product', () => {
    const noExempt = CODES.filter((c) => c.kind !== 'exempt')
    expect(proposeTaxCode(noExempt, { productCode: 'VAT14', partyStatus: 'exempt' })).toEqual({ tax_code: 'VAT14', tax_pct: 14 })
  })

  it('the four statuses are the database\'s', () => {
    const sql = read('supabase/migrations/20260911_tax_codes.sql')
    expect(sql).toContain(`CHECK (tax_status IN (${TAX_STATUSES.map((s) => `'${s}'`).join(', ')}))`)
  })
})

describe('the screens propose and store it', () => {
  it('every line editor proposes the code when a product is picked, from the right party', () => {
    expect(read('src/pages/SalesDocuments/SalesDocumentForm.jsx')).toMatch(/proposeTaxCode\(taxCodes, \{ productCode: product\.tax_code, partyStatus: selectedCustomer\?\.tax_status, side: 'sales' \}\)/)
    expect(read('src/pages/Pipeline/DealDetail.jsx')).toMatch(/proposeTaxCode\(taxCodes, \{ productCode: product\.tax_code, partyStatus: customer\?\.tax_status, side: 'sales' \}\)/)
    expect(read('src/pages/Purchasing/_modals.jsx')).toMatch(/proposeTaxCode\(taxCodes, \{ productCode: p\.tax_code, partyStatus: vendor\?\.tax_status, side: 'purchase' \}\)/)
  })

  it('customers, suppliers and products save the new fields', () => {
    expect(read('src/pages/Customers/index.jsx')).toContain('tax_status: customerForm.tax_status || null,')
    expect(read('src/pages/CustomerDetails.jsx')).toContain('tax_status: editForm.tax_status || null,')
    expect(read('src/pages/Products/index.jsx')).toContain('tax_status: brandForm.tax_status || null,')
    expect(read('src/pages/Products/index.jsx')).toContain('tax_code: productForm.tax_code || null,')
    expect(read('src/pages/Purchasing/_modals.jsx')).toContain("onChange={(e) => onChange({ tax_status: e.target.value || null })}")
  })

  it('every string exists in both languages', () => {
    const en = JSON.parse(read('src/locales/en.json'))
    const ar = JSON.parse(read('src/locales/ar.json'))
    const keys = [
      ['customerModal', 'taxStatus'], ['customerModal', 'taxStatusNone'],
      ...TAX_STATUSES.map((s) => ['customerModal', `taxStatus_${s}`]),
      ['products', 'taxCode'], ['products', 'taxCodeNone'], ['products', 'taxCodeHint'],
    ]
    for (const [sec, k] of keys) {
      expect(en[sec][k], `en ${sec}.${k}`).toBeTruthy()
      expect(ar[sec][k], `ar ${sec}.${k}`).toBeTruthy()
    }
  })
})

describe('printed documents', () => {
  it('show the company\'s tax registration number and the buyer\'s tax ID', () => {
    const html = buildDocumentHTML({
      layout: { ...PDF_LAYOUT_DEFAULT, companyName: 'Seller Co', taxNumber: '100-200-300' },
      billTo: 'Buyer Co',
      billToDetails: { taxId: 'EG-555' },
    })
    expect(html).toContain('Tax Reg. No. 100-200-300')
    expect(html).toContain('Tax ID: EG-555')
    const none = buildDocumentHTML({ layout: { ...PDF_LAYOUT_DEFAULT, companyName: 'Seller Co' }, billTo: 'Buyer Co' })
    expect(none).not.toContain('Tax Reg. No.')
    expect(none).not.toContain('Tax ID:')
  })

  it('quotes and orders pass the buyer\'s tax ID', () => {
    for (const f of ['src/lib/quotationPdf.js', 'src/lib/salesOrderPdf.js']) {
      expect(read(f), f).toContain('taxId: customer?.tax_id || null,')
    }
  })

  it('a tax invoice sums the tax by code and rate from its lines', () => {
    const lines = [
      { tax_code: 'VAT14', tax_pct: 14, qty: 2, unit_price: 100, discount_pct: 10 },
      { tax_code: 'VAT14', tax_pct: 14, qty: 1, unit_price: 50, discount_pct: 0 },
      { tax_code: 'EXEMPT', tax_pct: 0, qty: 1, unit_price: 30, discount_pct: 0 },
      { tax_code: 'VAT14', tax_pct: 15, qty: 1, unit_price: 10, discount_pct: 0 },
    ]
    const a = lineAmounts(lines[0])   // unrounded; printed through formatMoney
    expect(a.net).toBe(180)
    expect(a.tax).toBeCloseTo(25.2, 10)
    expect(a.total).toBeCloseTo(205.2, 10)
    expect(vatBreakdown(lines, { VAT14: 'Standard', EXEMPT: 'Exempt' })).toEqual([
      { code: 'VAT14', rate: 15, name: 'Standard', net: 10, tax: 1.5 },
      { code: 'VAT14', rate: 14, name: 'Standard', net: 230, tax: 32.2 },
      { code: 'EXEMPT', rate: 0, name: 'Exempt', net: 30, tax: 0 },
    ])
  })

  it('only a posted invoice or an issued credit note prints', () => {
    expect(isPrintable('invoice', { doc_status: 'posted' })).toBe(true)
    expect(isPrintable('invoice', { doc_status: 'draft' })).toBe(false)
    expect(isPrintable('credit_note', { status: 'issued' })).toBe(true)
    expect(isPrintable('credit_note', { status: 'applied' })).toBe(true)
    expect(isPrintable('credit_note', { status: 'pending_approval' })).toBe(false)
    expect(isPrintable('invoice', null)).toBe(false)
  })

  it('the invoice and credit note pages offer the print for those', () => {
    const page = read('src/pages/SalesDocuments/SalesDocumentDetail.jsx')
    // an opening-balance invoice (20260921) has no lines to print
    expect(page).toContain("isPrintable('invoice', doc) && !doc.is_opening && (")
    expect(page).toContain("isPrintable('credit_note', doc) && (")
  })
})
