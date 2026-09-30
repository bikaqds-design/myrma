/**
 * depositsScreens.test.jsx — A-06b: deposits on a sales order, using a deposit
 * or payment against an invoice, the credit status panel and the over-limit
 * approval. The database (20260919, deposits_credit_limits.sql) enforces the
 * rules; the assistant cannot sign in, so the render tests are the screen check.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { readFileSync } from 'node:fs'
import { defaultApplyAmount, isCreditLimitError, overrideDocType, validateDepositAmount, validateOverrideReason } from '../pages/SalesDocuments/_credit'

const read = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')

describe('helpers', () => {
  it('recognise the database\'s credit-limit refusal', () => {
    expect(isCreditLimitError({ hint: 'credit_limit: a manager can approve it with a reason.' })).toBe(true)
    expect(isCreditLimitError({ message: 'This invoice takes Acme over its credit limit: …' })).toBe(true)
    expect(isCreditLimitError({ message: 'Only posted invoices can be voided.' })).toBe(false)
    expect(overrideDocType('sales_order')).toBe('sales_order')
    expect(overrideDocType('invoice')).toBe('invoice')
    expect(overrideDocType('quotation')).toBeNull()
  })

  it('check a reason and an amount as the database does', () => {
    expect(validateOverrideReason('ok')).toBe('salesDocuments.credOverrideReasonShort')
    expect(validateOverrideReason('paying Friday, confirmed')).toBeNull()
    expect(validateDepositAmount('500')).toBeNull()
    expect(validateDepositAmount('12.345')).toBe('salesDocuments.depErrAmount')
    expect(validateDepositAmount('0')).toBe('salesDocuments.depErrAmount')
    expect(defaultApplyAmount(500, 200)).toBe(200)
    expect(defaultApplyAmount(150.1, 200)).toBe(150.1)
  })
})

describe('wiring', () => {
  it('the API calls the deposit, status and override functions', () => {
    expect(read('src/api/db/payments.ts')).toContain("supabase.rpc('record_customer_deposit', {")
    const cc = read('src/api/db/creditControl.ts')
    expect(cc).toContain("supabase.rpc('rma_customer_credit_status', { p_customer_id: customerId })")
    expect(cc).toContain("supabase.rpc('approve_credit_override', { p_doc_type: docType, p_doc_id: docId, p_reason: reason })")
  })

  it('the approval inbox offers a manager the override, then approves again', () => {
    const a = read('src/pages/Activities/index.jsx')
    expect(a).toContain('if (isCreditLimitError(err) && overrideDocType(docType)')
    expect(a).toContain('await db.creditControl.approveOverride(overrideDocType(creditOverride.docType), creditOverride.docId, reason)')
    expect(a).toContain('await handleApproveActivity(activity)')
  })

  it('the order page shows deposits; the invoice page offers to use one; the customer page the credit panel', () => {
    const d = read('src/pages/SalesDocuments/SalesDocumentDetail.jsx')
    expect(d).toContain('<OrderDepositsPanel')
    expect(d).toContain('<ApplyPaymentModal')
    expect(read('src/pages/CustomerDetails.jsx')).toContain('<CreditStatusPanel customerId={customer.id} />')
  })

  it('every string exists in both languages', () => {
    const en = JSON.parse(read('src/locales/en.json'))
    const ar = JSON.parse(read('src/locales/ar.json'))
    const files = ['src/pages/SalesDocuments/OrderDepositsPanel.jsx', 'src/pages/SalesDocuments/ApplyPaymentModal.jsx',
      'src/pages/SalesDocuments/_credit.js', 'src/components/CreditOverrideModal.jsx', 'src/components/CreditStatusPanel.jsx']
    const keys = new Set()
    for (const f of files) for (const m of read(f).matchAll(/'((salesDocuments|customerDetails|accounting)\.[A-Za-z_]+)'/g)) keys.add(m[1])
    for (const k of keys) {
      const [sec, key] = k.split('.')
      expect(en[sec][key], `en ${k}`).toBeTruthy()
      expect(ar[sec][key], `ar ${k}`).toBeTruthy()
    }
  })
})

// ── rendered ──────────────────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key), i18n: { language: 'en' } }),
}))
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }))
vi.mock('../hooks/useBaseCurrency', () => ({ useBaseCurrency: () => 'EGP' }))
let deposits = []
let unapplied = []
let status = null
const api = {
  depositsForOrder: vi.fn(() => Promise.resolve(deposits)),
  recordDeposit: vi.fn(() => Promise.resolve({ id: 'd9', payment_code: 'PAY-2026-00009' })),
  unappliedForCustomer: vi.fn(() => Promise.resolve(unapplied)),
  applyToInvoice: vi.fn(() => Promise.resolve({ id: 'a1' })),
}
const cc = { status: vi.fn(() => Promise.resolve(status)) }
vi.mock('../api/supabaseClient', () => ({
  db: {
    payments: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }),
    creditControl: new Proxy({}, { get: (_, k) => (...a) => cc[k](...a) }),
    exchangeRates: { rateFor: () => Promise.resolve(50) },
  },
}))
const { default: OrderDepositsPanel } = await import('../pages/SalesDocuments/OrderDepositsPanel.jsx')
const { default: ApplyPaymentModal } = await import('../pages/SalesDocuments/ApplyPaymentModal.jsx')
const { default: CreditStatusPanel } = await import('../components/CreditStatusPanel.jsx')
const { default: CreditOverrideModal } = await import('../components/CreditOverrideModal.jsx')

const wrap = (ui) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const SO = { id: 'so1', customer_id: 'c1', currency: 'EGP', exchange_rate: 1, status: 'sent' }

describe('deposits on an order', () => {
  beforeEach(() => { deposits = []; Object.values(api).forEach((f) => f.mockClear()) })
  afterEach(cleanup)

  it('lists them with what is left to use', async () => {
    deposits = [
      { id: 'd1', payment_code: 'PAY-2026-00001', payment_date: '2026-09-20', amount: 500, unapplied_amount: 300, status: 'active', is_deposit: true },
      { id: 'd2', payment_code: 'PAY-2026-00002', payment_date: '2026-09-21', amount: 100, unapplied_amount: 0, status: 'active', is_deposit: true },
    ]
    wrap(<OrderDepositsPanel so={SO} canRecord currentUserEmail="acc@x" />)
    expect(await screen.findByText('PAY-2026-00001')).toBeTruthy()
    expect(screen.getByText('salesDocuments.depSummary:{"taken":"600.00","left":"300.00","currency":"EGP"}')).toBeTruthy()
    expect(screen.getByText('salesDocuments.depUsed')).toBeTruthy()
  })

  it('takes a deposit in the order\'s currency; a bad amount is refused first', async () => {
    wrap(<OrderDepositsPanel so={SO} canRecord currentUserEmail="acc@x" />)
    fireEvent.click(await screen.findByRole('button', { name: 'salesDocuments.depTake' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/salesDocuments\.depAmount/), { target: { value: '12.345' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'salesDocuments.depSave' }))
    expect(await within(dialog).findByText('salesDocuments.depErrAmount')).toBeTruthy()
    expect(api.recordDeposit).not.toHaveBeenCalled()
    fireEvent.change(within(dialog).getByLabelText(/salesDocuments\.depAmount/), { target: { value: '500' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'salesDocuments.depSave' }))
    await waitFor(() => expect(api.recordDeposit).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'c1', amount: 500, sales_order_id: 'so1', currency: 'EGP', exchange_rate: null, created_by: 'acc@x',
    })))
  })

  it('someone without the payment permission sees them but cannot take one', async () => {
    wrap(<OrderDepositsPanel so={SO} canRecord={false} currentUserEmail="rep@x" />)
    expect(await screen.findByText('salesDocuments.depNone')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'salesDocuments.depTake' })).toBeNull()
  })
})

describe('using a deposit on an invoice', () => {
  beforeEach(() => { unapplied = []; Object.values(api).forEach((f) => f.mockClear()) })
  afterEach(cleanup)
  const INV = { id: 'i1', customer_id: 'c1', total: 600, amount_paid: 400 }

  it('offers the customer\'s money in the invoice\'s currency, defaulting to what the invoice still needs', async () => {
    unapplied = [{ id: 'd1', payment_code: 'PAY-2026-00001', payment_date: '2026-09-20', unapplied_amount: 300, is_deposit: true }]
    wrap(<ApplyPaymentModal invoice={INV} currency="EGP" currentUserEmail="acc@x" onClose={() => {}} onApplied={() => {}} />)
    fireEvent.click(await screen.findByRole('radio'))
    expect(screen.getByLabelText(/salesDocuments\.apAmount/).value).toBe('200')
    expect(api.unappliedForCustomer).toHaveBeenCalledWith('c1', 'EGP')
    fireEvent.change(screen.getByLabelText(/salesDocuments\.apAmount/), { target: { value: '250' } })
    fireEvent.click(screen.getByRole('button', { name: 'salesDocuments.apApply' }))
    expect(await screen.findByText('salesDocuments.apErrAmount:{"max":"200.00"}')).toBeTruthy()
    expect(api.applyToInvoice).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(/salesDocuments\.apAmount/), { target: { value: '200' } })
    fireEvent.click(screen.getByRole('button', { name: 'salesDocuments.apApply' }))
    await waitFor(() => expect(api.applyToInvoice).toHaveBeenCalledWith({ paymentId: 'd1', invoiceId: 'i1', amount: 200, actorEmail: 'acc@x' }))
  })
})

describe('credit', () => {
  afterEach(cleanup)

  it('the panel shows what counts against the limit, and how far over it is', async () => {
    status = { credit_limit: 1000, open_invoices: 1100, open_orders: 300, unused_credits: 200, exposure: 1200, available: -200, currency: 'EGP' }
    wrap(<CreditStatusPanel customerId="c1" />)
    expect(await screen.findByText('customerDetails.credOver')).toBeTruthy()
    expect(screen.getByText('−200.00')).toBeTruthy()
    expect(screen.getByText('1,200.00')).toBeTruthy()
  })

  it('no limit says so', async () => {
    status = { credit_limit: null, open_invoices: 50, open_orders: 0, unused_credits: 0, exposure: 50, available: null, currency: 'EGP' }
    wrap(<CreditStatusPanel customerId="c2" />)
    expect(await screen.findByText('customerDetails.credNoLimit')).toBeTruthy()
    expect(screen.queryByText('customerDetails.credAvailable')).toBeNull()
  })

  it('the override needs a reason of ten characters, then approves', async () => {
    const onApprove = vi.fn(() => Promise.resolve())
    wrap(<CreditOverrideModal message="This invoice takes Acme over its credit limit" onCancel={() => {}} onApprove={onApprove} />)
    expect(screen.getByText('This invoice takes Acme over its credit limit')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/salesDocuments\.credOverrideReason/), { target: { value: 'ok' } })
    fireEvent.click(screen.getByRole('button', { name: 'salesDocuments.credOverrideApprove' }))
    expect(await screen.findByText('salesDocuments.credOverrideReasonShort')).toBeTruthy()
    expect(onApprove).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(/salesDocuments\.credOverrideReason/), { target: { value: 'regular customer, paying Friday' } })
    fireEvent.click(screen.getByRole('button', { name: 'salesDocuments.credOverrideApprove' }))
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith('regular customer, paying Friday'))
  })
})
