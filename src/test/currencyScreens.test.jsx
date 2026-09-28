/**
 * currencyScreens.test.jsx — the currency screens (A-05b over 20260912).
 *
 * The assistant cannot sign in to the app, so the render tests are the screen
 * check: Accounting › Exchange rates shows the rate in force per currency,
 * finance adds rates (a bad one refused before the round trip) and managers
 * only read; a document shows its currency, rate and base total, and offers the
 * change only on a draft whose currency is not fixed by its source. i18n echoes
 * the key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { readFileSync } from 'node:fs'
import { currencyLock, latestByCurrency, toBase, validateRate } from '../pages/Accounting/_currency'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key), i18n: { language: 'en' } }),
}))
const toastError = vi.fn()
vi.mock('react-hot-toast', () => ({ default: { error: (...a) => toastError(...a), success: vi.fn() } }))
vi.mock('../hooks/useBaseCurrency', () => ({ useBaseCurrency: () => 'EGP' }))
vi.mock('../hooks/useCurrencyOptions', () => ({
  useCurrencyOptions: () => [
    { code: 'EGP', name: 'Egyptian Pound' }, { code: 'USD', name: 'US Dollar' }, { code: 'SAR', name: 'Saudi Riyal' },
  ],
}))

const read = (f) => readFileSync(f, 'utf8')

describe('currency helpers', () => {
  it('the rate in force is the latest per currency', () => {
    const rows = [
      { currency: 'USD', rate_date: '2026-09-01', rate: 50 },
      { currency: 'USD', rate_date: '2026-09-20', rate: 52 },
      { currency: 'SAR', rate_date: '2026-09-10', rate: 13.3 },
    ]
    expect(latestByCurrency(rows)).toEqual({
      USD: { currency: 'USD', rate_date: '2026-09-20', rate: 52 },
      SAR: { currency: 'SAR', rate_date: '2026-09-10', rate: 13.3 },
    })
  })

  it('a rate is checked the way the database checks it', () => {
    const ok = { currency: 'USD', rateDate: '2026-09-28', rate: '52.5', baseCurrency: 'EGP' }
    expect(validateRate(ok)).toBeNull()
    expect(validateRate({ ...ok, currency: '' })).toMatchObject({ field: 'currency' })
    expect(validateRate({ ...ok, currency: 'EGP' })).toMatchObject({ key: 'accounting.fxErrBase' })
    expect(validateRate({ ...ok, rateDate: '' })).toMatchObject({ field: 'date' })
    expect(validateRate({ ...ok, rate: '0' })).toMatchObject({ field: 'rate' })
    expect(validateRate({ ...ok, rate: '-1' })).toMatchObject({ field: 'rate' })
  })

  it('a base amount is rounded to cents as the ledger posts it', () => {
    expect(toBase(114, 51)).toBe(5814)
    expect(toBase(0.335, 3)).toBe(1.01)
    expect(toBase(10, null)).toBe(10)
  })

  it('a document made from another keeps its currency; a credit note on an invoice its rate too', () => {
    expect(currencyLock('credit_note', { source_invoice_id: 'i' })).toBe('both')
    expect(currencyLock('sales_order', { quotation_id: 'q' })).toBe('currency')
    expect(currencyLock('invoice', { so_id: 's' })).toBe('currency')
    expect(currencyLock('quotation', {})).toBe('none')
  })
})

describe('wiring', () => {
  it('payments carry their currency and rate to record_payment', () => {
    const api = read('src/api/db/payments.ts')
    expect(api).toContain('p_currency: input.currency ?? null,')
    expect(api).toContain('p_exchange_rate: input.exchange_rate ?? null,')
    expect(read('src/pages/SalesDocuments/SalesDocumentDetail.jsx')).toContain('currency: doc.currency || null,')
    const acct = read('src/pages/Accounting/_modals.jsx')
    expect(acct).toContain('const inCurrency = openInvoices.filter((inv) => (inv.currency || baseCurrency) === payCurrency)')
    expect(acct).toContain('currency: cx.payload.currency,')
  })

  it('choosing a foreign currency fills the rate from the table, purchasing included', () => {
    expect(read('src/hooks/useDocumentCurrency.js')).toContain('.rateFor(next)')
  })

  it('a customer\'s default currency is saved from both forms', () => {
    expect(read('src/pages/Customers/index.jsx')).toContain('currency: customerForm.currency || null,')
    expect(read('src/pages/CustomerDetails.jsx')).toContain('currency: editForm.currency || null,')
  })

  it('documents print in their own currency; a foreign tax invoice states its rate and the tax in base', () => {
    expect(read('src/lib/quotationPdf.js')).toContain('const currency = quotation.currency || layout.currency ||')
    expect(read('src/lib/salesOrderPdf.js')).toContain('const currency = salesOrder.currency || layout.currency ||')
    const inv = read('src/lib/taxInvoicePdf.js')
    expect(inv).toContain("label: 'Exchange rate'")
    expect(inv).toContain('Tax in ${esc(baseCurrency)} at ${esc(rate)}')
  })

  it('every string exists in both languages', () => {
    const en = JSON.parse(read('src/locales/en.json'))
    const ar = JSON.parse(read('src/locales/ar.json'))
    const used = []
    for (const f of ['src/pages/Accounting/ExchangeRatesTab.jsx', 'src/pages/SalesDocuments/DocCurrencyPanel.jsx', 'src/pages/Accounting/_currency.js']) {
      for (const m of read(f).matchAll(/'((accounting|salesDocuments)\.fx[A-Za-z]*|accounting\.tabRates)'/g)) used.push(m[1])
    }
    used.push('customerModal.currency', 'customerModal.currencyBase')
    for (const k of used) {
      const [sec, key] = k.split('.')
      expect(en[sec][key], `en ${k}`).toBeTruthy()
      expect(ar[sec][key], `ar ${k}`).toBeTruthy()
    }
  })
})

// ── rendered ──────────────────────────────────────────────────────────────────
const api = {
  list: vi.fn(() => Promise.resolve([
    { currency: 'USD', rate_date: '2026-09-20', rate: 52, note: 'CBE', created_by: 'a', created_at: '' },
    { currency: 'USD', rate_date: '2026-09-01', rate: 50, note: null, created_by: 'a', created_at: '' },
  ])),
  save: vi.fn(() => Promise.resolve()),
  remove: vi.fn(() => Promise.resolve()),
  rateFor: vi.fn(() => Promise.resolve(52)),
  setDocumentCurrency: vi.fn(() => Promise.resolve({ currency: 'USD', exchange_rate: 51 })),
}
vi.mock('../api/supabaseClient', () => ({ db: { exchangeRates: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }) } }))
const { default: ExchangeRatesTab } = await import('../pages/Accounting/ExchangeRatesTab.jsx')
const { default: DocCurrencyPanel } = await import('../pages/SalesDocuments/DocCurrencyPanel.jsx')

const wrap = (ui) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

describe('Accounting › Exchange rates', () => {
  beforeEach(() => { Object.values(api).forEach((f) => f.mockClear()); toastError.mockClear() })
  afterEach(cleanup)

  it('shows the rate in force and every rate', async () => {
    wrap(<ExchangeRatesTab currentUserRole="manager" />)
    expect(await screen.findByText(/accounting\.fxLatest/)).toBeTruthy()
    expect(screen.getByText('52.00 EGP')).toBeTruthy()
    expect(screen.getByText('CBE')).toBeTruthy()
    // a manager reads only
    expect(screen.queryByRole('form')).toBeNull()
    expect(screen.queryByRole('button', { name: 'accounting.fxDelete' })).toBeNull()
  })

  it('an accountant adds a rate; a bad one is refused before the round trip', async () => {
    wrap(<ExchangeRatesTab currentUserRole="accountant" />)
    await screen.findByText(/accounting\.fxLatest/)
    fireEvent.change(document.getElementById('fx-currency'), { target: { value: 'SAR' } })
    fireEvent.change(document.getElementById('fx-rate'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'accounting.fxSave' }))
    expect(await screen.findByText(/accounting\.fxErrRate/)).toBeTruthy()
    expect(api.save).not.toHaveBeenCalled()
    fireEvent.change(document.getElementById('fx-rate'), { target: { value: '13.2' } })
    fireEvent.click(screen.getByRole('button', { name: 'accounting.fxSave' }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ currency: 'SAR', rate: 13.2 })))
  })

  it('a delete asks first', async () => {
    wrap(<ExchangeRatesTab currentUserRole="admin" />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'accounting.fxDelete' }))[0])
    expect(api.remove).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(dialog.querySelectorAll('button')[dialog.querySelectorAll('button').length - 1])
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('USD', '2026-09-20'))
  })
})

describe('a document\'s currency', () => {
  afterEach(cleanup)
  const usdDraft = { id: 'd1', currency: 'USD', exchange_rate: 51, total: 114 }

  it('a foreign document shows its rate and its total in the base currency', () => {
    wrap(<DocCurrencyPanel docType="invoice" doc={usdDraft} status="draft" canEdit={false} />)
    expect(screen.getByText(/salesDocuments\.fxTotalInBase/).textContent).toContain('EGP 5,814.00')
    expect(screen.queryByRole('button', { name: 'salesDocuments.fxChange' })).toBeNull()
  })

  it('its author changes the rate on a draft', async () => {
    wrap(<DocCurrencyPanel docType="quotation" doc={usdDraft} status="draft" canEdit onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'salesDocuments.fxChange' }))
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(api.setDocumentCurrency).toHaveBeenCalledWith('quotation', 'd1', 'USD', 51))
  })

  it('no change once posted, nor on a credit note against an invoice', () => {
    wrap(<DocCurrencyPanel docType="invoice" doc={usdDraft} status="posted" canEdit />)
    expect(screen.queryByRole('button', { name: 'salesDocuments.fxChange' })).toBeNull()
    cleanup()
    wrap(<DocCurrencyPanel docType="credit_note" doc={{ ...usdDraft, source_invoice_id: 'i1' }} status="draft" canEdit />)
    expect(screen.queryByRole('button', { name: 'salesDocuments.fxChange' })).toBeNull()
  })
})
