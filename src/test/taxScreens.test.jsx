/**
 * taxScreens.test.jsx — the tax screens (A-04b over 20260911).
 *
 * The assistant cannot sign in to the app, so the render tests are the screen
 * check: a line's tax code sets its rate; Accounting › Tax shows the VAT return
 * by side, code and rate with its payable figure and whether it ties to the
 * ledger; administrators and accountants add and edit codes, a rate change asks
 * first, and the database's refusal is shown as it is. i18n echoes the key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { readFileSync } from 'node:fs'
import { applyTaxCode, codeOptions, lastMonth, validateTaxCode, vatSummary } from '../pages/Accounting/_tax'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key), i18n: { language: 'en' } }),
}))
const toastError = vi.fn()
vi.mock('react-hot-toast', () => ({ default: { error: (...a) => toastError(...a), success: vi.fn() } }))

const CODES = [
  { code: 'EXEMPT', name: 'Exempt', name_ar: 'معفى', kind: 'exempt', rate: 0, is_default: false, is_active: true },
  { code: 'OLD5', name: 'Old reduced', name_ar: null, kind: 'reduced', rate: 5, is_default: false, is_active: false },
  { code: 'VAT14', name: 'Standard rate 14%', name_ar: null, kind: 'standard', rate: 14, is_default: true, is_active: true },
  { code: 'ZERO', name: 'Zero-rated', name_ar: null, kind: 'zero', rate: 0, is_default: true, is_active: true },
]

describe('tax helpers', () => {
  it('a line is offered the active codes, highest rate first, plus its own code if inactive', () => {
    expect(codeOptions(CODES, null).map((c) => c.code)).toEqual(['VAT14', 'EXEMPT', 'ZERO'])
    expect(codeOptions(CODES, 'OLD5').map((c) => c.code)).toEqual(['VAT14', 'OLD5', 'EXEMPT', 'ZERO'])
  })

  it('picking a code sets the line\'s rate; clearing it leaves the rate', () => {
    expect(applyTaxCode(CODES, 'VAT14')).toEqual({ tax_code: 'VAT14', tax_pct: 14 })
    expect(applyTaxCode(CODES, 'EXEMPT')).toEqual({ tax_code: 'EXEMPT', tax_pct: 0 })
    expect(applyTaxCode(CODES, '')).toEqual({ tax_code: null })
  })

  it('a new code is checked the way the database checks it', () => {
    expect(validateTaxCode({ code: 'VAT15', name: 'Fifteen', kind: 'standard', rate: '15' })).toBeNull()
    expect(validateTaxCode({ code: 'vat 15', name: 'x', kind: 'standard', rate: '15' })).toMatchObject({ field: 'code' })
    expect(validateTaxCode({ code: 'VAT15', name: ' ', kind: 'standard', rate: '15' })).toMatchObject({ field: 'name' })
    expect(validateTaxCode({ code: 'ZERO5', name: 'x', kind: 'zero', rate: '5' })).toMatchObject({ key: 'accounting.taxErrZeroRate' })
    expect(validateTaxCode({ code: 'STD0', name: 'x', kind: 'standard', rate: '0' })).toMatchObject({ key: 'accounting.taxErrPositiveRate' })
    expect(validateTaxCode({ code: 'X', name: 'x', kind: 'standard', rate: '101' })).toMatchObject({ field: 'rate' })
    expect(validateTaxCode({ code: 'X', name: 'x', kind: 'standard', rate: '' })).toMatchObject({ field: 'rate' })
  })

  it('the return sums each side to the cent, and ties to the ledger or says by how much it does not', () => {
    const rows = [
      { side: 'output', net_amount: 190, tax_amount: 26.6 },
      { side: 'output', net_amount: 90, tax_amount: 13.5 },
      { side: 'input', net_amount: 200, tax_amount: 30 },
    ]
    const tied = vatSummary(rows, { output_tax: 40.1, input_tax: 30 })
    expect(tied.output).toEqual({ net: 280, tax: 40.1 })
    expect(tied.payable).toBe(10.1)
    expect(tied.tie).toMatchObject({ output: true, input: true })
    const off = vatSummary(rows, { output_tax: 40.11, input_tax: 30 })
    expect(off.tie).toMatchObject({ output: false, outputDiff: 0.01, input: true })
    expect(vatSummary(rows, undefined).tie).toBeNull()
  })

  it('the default period is last month', () => {
    expect(lastMonth(new Date(2026, 8, 28))).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    expect(lastMonth(new Date(2026, 0, 5))).toEqual({ from: '2025-12-01', to: '2025-12-31' })
  })
})

describe('the line editors send the code', () => {
  it('sales form, purchase lines and deal quotation lines use the tax code picker', () => {
    for (const f of ['src/pages/SalesDocuments/SalesDocumentForm.jsx', 'src/pages/Purchasing/_modals.jsx', 'src/pages/Pipeline/DealDetail.jsx']) {
      expect(readFileSync(f, 'utf8'), f).toContain('<TaxCodeSelect value=')
    }
    expect(readFileSync('src/pages/SalesDocuments/SalesDocumentForm.jsx', 'utf8')).toContain('tax_code: l.tax_code || null,')
  })

  it('a credit note made from an invoice keeps each line\'s code', () => {
    expect(readFileSync('src/pages/SalesDocuments/_modals.jsx', 'utf8')).toContain('tax_code: l.tax_code ?? null,')
  })

  it('the screens read the tax code on every line, so a save keeps it', () => {
    expect(readFileSync('src/api/db/_rowLines.ts', 'utf8').match(/tax_code: l\.tax_code \?\? null,/g)).toHaveLength(2)
  })

  it('the API writes codes only through the table (RLS) and reads the return through its functions', () => {
    const api = readFileSync('src/api/db/taxCodes.ts', 'utf8')
    expect(api).toContain("rpc('rma_vat_return'")
    expect(api).toContain("rpc('rma_vat_return_ledger'")
    expect(api).not.toMatch(/from\('tax_code_rates'\)/)
  })

  it('every string exists in both languages', () => {
    const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8')).accounting
    const ar = JSON.parse(readFileSync('src/locales/ar.json', 'utf8')).accounting
    const used = new Set()
    for (const f of ['src/pages/Accounting/TaxTab.jsx', 'src/components/TaxCodeSelect.jsx', 'src/pages/Accounting/_tax.js']) {
      for (const m of readFileSync(f, 'utf8').matchAll(/accounting\.(tax[A-Za-z_]*|tabTax)/g)) used.add(m[1])
    }
    for (const k of ['standard', 'reduced', 'zero', 'exempt', 'out_of_scope']) used.add(`taxKind_${k}`)
    used.delete('taxKind_')
    for (const k of used) {
      expect(en[k], `en ${k}`).toBeTruthy()
      expect(ar[k], `ar ${k}`).toBeTruthy()
    }
  })
})

// ── rendered ──────────────────────────────────────────────────────────────────
const api = {
  list: vi.fn(() => Promise.resolve(CODES)),
  create: vi.fn(() => Promise.resolve({})),
  update: vi.fn(() => Promise.resolve({})),
  vatReturn: vi.fn(() => Promise.resolve([
    { side: 'output', tax_code: 'VAT14', name: 'Standard rate 14%', name_ar: null, kind: 'standard', rate: 14, net_amount: 200, tax_amount: 28, documents: 1 },
    { side: 'output', tax_code: 'EXEMPT', name: 'Exempt', name_ar: 'معفى', kind: 'exempt', rate: 0, net_amount: 50, tax_amount: 0, documents: 1 },
    { side: 'input', tax_code: 'VAT14', name: 'Standard rate 14%', name_ar: null, kind: 'standard', rate: 14, net_amount: 100, tax_amount: 14, documents: 2 },
  ])),
  vatLedger: vi.fn(() => Promise.resolve({ output_tax: 28, input_tax: 14 })),
}
vi.mock('../api/supabaseClient', () => ({ db: { taxCodes: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }) } }))
const { default: TaxTab } = await import('../pages/Accounting/TaxTab.jsx')
const { default: TaxCodeSelect } = await import('../components/TaxCodeSelect.jsx')

const wrap = (ui) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
)

describe('TaxCodeSelect', () => {
  afterEach(cleanup)
  it('offers the active codes and hands back the code with its rate', async () => {
    const onChange = vi.fn()
    wrap(<TaxCodeSelect value={null} rate={14} onChange={onChange} />)
    const select = await screen.findByLabelText('accounting.taxCode')
    await within(select).findByText(/^VAT14/)
    expect(within(select).queryByText(/^OLD5/)).toBeNull()
    fireEvent.change(select, { target: { value: 'EXEMPT' } })
    expect(onChange).toHaveBeenCalledWith({ tax_code: 'EXEMPT', tax_pct: 0 })
  })
})

describe('Accounting › Tax', () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockClear())
    toastError.mockClear()
  })
  afterEach(cleanup)

  it('shows the return by side and code, what is payable, and that it ties to the ledger', async () => {
    wrap(<TaxTab currentUserRole="accountant" />)
    expect(await screen.findByText('accounting.taxLedgerTies')).toBeTruthy()
    expect(screen.getByText('accounting.taxOutput')).toBeTruthy()
    expect(screen.getByText('accounting.taxInput')).toBeTruthy()
    expect(screen.getAllByText('28.00').length).toBeGreaterThan(0)
    // 28 output less 14 input
    const payable = screen.getByText('accounting.taxPayable').closest('tr')
    expect(within(payable).getByText('14.00')).toBeTruthy()
    expect(api.vatReturn).toHaveBeenCalledTimes(1)
  })

  it('says when the return does not tie to the ledger', async () => {
    api.vatLedger.mockResolvedValueOnce({ output_tax: 30, input_tax: 14 })
    wrap(<TaxTab currentUserRole="manager" />)
    const alert = await screen.findByText(/accounting\.taxLedgerDiff/)
    expect(alert.textContent).toContain('"output":"2.00"')
  })

  it('a manager reads the codes but cannot add or edit them', async () => {
    wrap(<TaxTab currentUserRole="manager" />)
    await screen.findAllByText('VAT14')
    expect(screen.queryByRole('button', { name: /accounting\.taxAdd/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'accounting.taxEdit' })).toBeNull()
  })

  it('an accountant adds a code; a bad one is refused before the round trip', async () => {
    wrap(<TaxTab currentUserRole="accountant" />)
    fireEvent.click(await screen.findByRole('button', { name: /accounting\.taxAdd/ }))
    const field = (id) => document.getElementById(id)
    fireEvent.change(field('tc-code'), { target: { value: 'vat5' } })
    fireEvent.change(field('tc-name'), { target: { value: 'Reduced 5%' } })
    fireEvent.change(field('tc-kind'), { target: { value: 'zero' } })
    fireEvent.change(field('tc-rate'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'accounting.taxSave' }))
    expect(await screen.findByText('accounting.taxErrZeroRate')).toBeTruthy()
    expect(api.create).not.toHaveBeenCalled()
    fireEvent.change(field('tc-kind'), { target: { value: 'reduced' } })
    fireEvent.click(screen.getByRole('button', { name: 'accounting.taxSave' }))
    await waitFor(() => expect(api.create).toHaveBeenCalledWith({
      code: 'VAT5', name: 'Reduced 5%', name_ar: null, kind: 'reduced', rate: 5, is_default: false, is_active: true,
    }))
  })

  it('changing a rate asks first, then saves; the database\'s refusal is shown as it is', async () => {
    api.update.mockRejectedValueOnce(new Error('Tax code VAT14 has been used: its kind cannot change.'))
    wrap(<TaxTab currentUserRole="admin" />)
    await screen.findAllByRole('button', { name: 'accounting.taxEdit' })
    const row = screen.getAllByText('VAT14').map((n) => n.closest('tr')).find((tr) => within(tr).queryByRole('button'))
    fireEvent.click(within(row).getByRole('button', { name: 'accounting.taxEdit' }))
    fireEvent.change(document.getElementById('tc-rate'), { target: { value: '15' } })
    fireEvent.click(screen.getByRole('button', { name: 'accounting.taxSave' }))
    const dialog = await screen.findByRole('dialog', { name: /accounting\.taxRateChangeTitle/ })
    expect(api.update).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'accounting.taxSave' }))
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('VAT14', expect.objectContaining({ rate: 15 })))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Tax code VAT14 has been used: its kind cannot change.', expect.anything()))
  })
})
