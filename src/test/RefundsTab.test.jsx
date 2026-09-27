/**
 * RefundsTab.test.jsx — Accounting › Refunds, rendered (P-05d over 20260904).
 *
 * The assistant cannot sign in to the app, so this is the screen check: a
 * manager records a refund from a customer's credit note or overpayment; the
 * manager who recorded it is never offered its approval (a second manager
 * approves, owner decision); a waiting refund is rejected with a reason; a
 * sales rep records nothing. i18n echoes the key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key) }),
}))
const toastError = vi.fn()
vi.mock('react-hot-toast', () => ({ default: { error: (...a) => toastError(...a), success: vi.fn() } }))

let rows = []
const api = {
  record: vi.fn(() => Promise.resolve({ id: 'RF9' })),
  approve: vi.fn(() => Promise.resolve({ id: 'RF1' })),
  reject: vi.fn(() => Promise.resolve({ id: 'RF1' })),
}
vi.mock('../api/supabaseClient', () => ({
  db: {
    customerRefunds: {
      listPage: () => Promise.resolve({ data: rows, count: rows.length }),
      sources: () => Promise.resolve([
        { type: 'credit_note', id: 'CN1', code: 'CN-2026-00001', balance: 300 },
        { type: 'payment', id: 'PAY1', code: 'PAY-2026-00001', balance: 200 },
      ]),
      record: (...a) => api.record(...a),
      approve: (...a) => api.approve(...a),
      reject: (...a) => api.reject(...a),
    },
    customers: {
      search: () => Promise.resolve([{ id: 'C1', company_name: 'Acme' }]),
      get: () => Promise.resolve({ id: 'C1', company_name: 'Acme' }),
    },
  },
}))

const { default: RefundsTab } = await import('../pages/Accounting/RefundsTab.jsx')

const WAITING = {
  id: 'RF1', refund_code: null, customer_id: 'C1', credit_note_id: 'CN1', payment_id: null, amount: 150, method: 'bank_transfer',
  refund_date: '2026-09-27', status: 'pending_approval', created_by: 'mgr1@x', customer: { company_name: 'Acme' },
  credit_note: { cn_code: 'CN-2026-00001' }, payment: null,
}

function renderTab(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RefundsTab currentUserEmail="mgr2@x" currentUserRole="manager" perPage={25} setPerPage={() => {}} {...props} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  rows = []
  Object.values(api).forEach((f) => f.mockClear())
  toastError.mockClear()
})
afterEach(cleanup)

describe('RefundsTab', () => {
  it('a manager records a refund from a customer\'s credit note', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '+ accounting.rfRecord' }))
    fireEvent.change(screen.getByLabelText(/^salesDocuments\.fCustomer/), { target: { value: 'Ac' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Acme' }))
    await screen.findByRole('option', { name: /CN-2026-00001/ })
    fireEvent.change(screen.getByLabelText(/^accounting\.rfSource/), { target: { value: 'credit_note:CN1' } })
    fireEvent.change(screen.getByLabelText(/^accounting\.amount/), { target: { value: '120.50' } })
    fireEvent.change(screen.getByLabelText('accounting.reference'), { target: { value: 'TRX-9' } })
    fireEvent.click(screen.getByRole('button', { name: 'accounting.rfRecordSubmit' }))
    await waitFor(() => expect(api.record).toHaveBeenCalledWith({
      sourceType: 'credit_note', sourceId: 'CN1', amount: 120.5, method: 'bank_transfer',
      referenceNumber: 'TRX-9', refundDate: null, notes: null, actorEmail: 'mgr2@x',
    }))
  })

  it('more than the source has left is refused before the round trip', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '+ accounting.rfRecord' }))
    fireEvent.change(screen.getByLabelText(/^salesDocuments\.fCustomer/), { target: { value: 'Ac' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Acme' }))
    await screen.findByRole('option', { name: /PAY-2026-00001/ })
    fireEvent.change(screen.getByLabelText(/^accounting\.rfSource/), { target: { value: 'payment:PAY1' } })
    fireEvent.change(screen.getByLabelText(/^accounting\.amount/), { target: { value: '250' } })
    fireEvent.click(screen.getByRole('button', { name: 'accounting.rfRecordSubmit' }))
    expect((await screen.findByRole('alert')).textContent).toBe('accounting.rfErrTooMuch:{"balance":"200.00"}')
    expect(api.record).not.toHaveBeenCalled()
  })

  it('another manager approves a waiting refund', async () => {
    rows = [WAITING]
    renderTab()
    const row = (await screen.findByText('Acme')).closest('tr')
    fireEvent.click(within(row).getByRole('button', { name: 'accounting.rfApprove' }))
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith('RF1', 'mgr2@x'))
  })

  it('the manager who recorded it is not offered its approval, but may withdraw it with a reason', async () => {
    rows = [WAITING]
    renderTab({ currentUserEmail: 'MGR1@x' })
    const row = (await screen.findByText('Acme')).closest('tr')
    expect(within(row).queryByRole('button', { name: 'accounting.rfApprove' })).toBeNull()
    expect(within(row).getByText('accounting.rfAwaitingOther')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'accounting.rfReject' }))
    const confirmBtn = screen.getAllByRole('button', { name: 'accounting.rfReject' }).at(-1)
    expect(confirmBtn.disabled).toBe(true) // a reason first
    fireEvent.change(screen.getByLabelText(/^accounting\.rfRejectReason/), { target: { value: 'Customer asked for store credit' } })
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(api.reject).toHaveBeenCalledWith('RF1', 'Customer asked for store credit', 'MGR1@x'))
  })

  it('a sales rep sees refunds but cannot record, approve or reject one', async () => {
    rows = [WAITING]
    renderTab({ currentUserRole: 'sales_rep' })
    await screen.findByText('Acme')
    expect(screen.queryByRole('button', { name: '+ accounting.rfRecord' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'accounting.rfApprove' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'accounting.rfReject' })).toBeNull()
  })

  it('the database\'s refusal is shown as it is', async () => {
    rows = [WAITING]
    api.approve.mockImplementationOnce(() => Promise.reject(new Error('Only 20.00 is left to refund from this source now')))
    renderTab()
    const row = (await screen.findByText('Acme')).closest('tr')
    fireEvent.click(within(row).getByRole('button', { name: 'accounting.rfApprove' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Only 20.00 is left to refund from this source now', { duration: 7000 }))
  })
})
