/**
 * DeliveriesPanel.test.jsx — the Deliveries panel on a sales order, rendered.
 *
 * The assistant cannot sign in to the app, so this is the screen check: a
 * manager sees what is still to ship and can prepare, confirm and cancel a
 * delivery; a sales rep sees the same but cannot; a confirmed delivery is
 * invoiced once and then links to its invoice. i18n echoes the key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key) }),
}))
const toastError = vi.fn()
vi.mock('react-hot-toast', () => ({ default: { error: (...a) => toastError(...a), success: vi.fn() } }))

const SO_LINES = [
  { id: 'L1', product_id: 'P-ser', product_name: 'Router', qty: 3, line_no: 1 },
  { id: 'L2', product_id: 'P-blk', product_name: 'Cable', qty: 10, line_no: 2 },
  { id: 'L3', product_id: 'P-svc', product_name: 'Install', qty: 1, line_no: 3 },
]
const PRODUCTS = [
  { id: 'P-ser', product_type: 'hardware' },
  { id: 'P-blk', product_type: 'hardware' },
  { id: 'P-svc', product_type: 'service' },
]
let deliveriesData = []
let invoicesData = []
const api = {
  create: vi.fn(() => Promise.resolve({ id: 'D9' })),
  confirm: vi.fn(() => Promise.resolve({ id: 'D1' })),
  cancel: vi.fn(() => Promise.resolve({ id: 'D1' })),
  invoice: vi.fn(() => Promise.resolve('INV-NEW')),
}

vi.mock('../api/supabaseClient', () => ({
  db: {
    salesOrders: { lines: () => Promise.resolve(SO_LINES) },
    products: { getMany: () => Promise.resolve(PRODUCTS) },
    crmInvoices: { list: () => Promise.resolve(invoicesData) },
    deliveries: {
      listForOrder: () => Promise.resolve(deliveriesData),
      create: (...a) => api.create(...a),
      confirm: (...a) => api.confirm(...a),
      cancel: (...a) => api.cancel(...a),
      invoice: (...a) => api.invoice(...a),
    },
  },
}))

const { default: DeliveriesPanel } = await import('../pages/SalesDocuments/DeliveriesPanel.jsx')

function renderPanel(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DeliveriesPanel
          so={{ id: 'SO1', status: 'confirmed' }}
          isManager
          canInvoice
          currentUserEmail="mgr@x"
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  deliveriesData = []
  invoicesData = []
  Object.values(api).forEach((f) => f.mockClear())
  toastError.mockClear()
})
afterEach(cleanup)

describe('DeliveriesPanel', () => {
  it('shows what is still to ship per stock line, and that services are billed separately', async () => {
    deliveriesData = [
      { id: 'D1', delivery_code: 'DN-2026-00001', status: 'confirmed', created_at: '2026-09-24', confirmed_at: '2026-09-24',
        delivery_lines: [{ sales_order_line_id: 'L1', qty: 1, product_name: 'Router', line_no: 1 }] },
    ]
    renderPanel()
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3)) // header + 2 stock lines, once products load
    const row = (await screen.findAllByText('Router')).find((el) => el.tagName === 'TD').closest('tr')
    expect(within(row).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Router', '3', '1', '—', '2'])
    expect(screen.queryByRole('cell', { name: 'Install' })).toBeNull()
    expect(screen.getByText('salesDocuments.dlvServicesNote')).toBeTruthy()
  })

  it('a manager prepares a delivery; the form starts at everything open and sends what was typed', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'salesDocuments.dlvNew' }))
    const router = await screen.findByLabelText('salesDocuments.dlvQtyToShip — Router')
    expect(router.value).toBe('3')
    expect(screen.getByLabelText('salesDocuments.dlvQtyToShip — Cable').value).toBe('10')
    fireEvent.change(router, { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('salesDocuments.dlvQtyToShip — Cable'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'salesDocuments.dlvCreate' }))
    await waitFor(() => expect(api.create).toHaveBeenCalledWith('SO1', [{ sales_order_line_id: 'L1', qty: 1 }], null, 'mgr@x'))
  })

  it('refuses more than is open without calling the database', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'salesDocuments.dlvNew' }))
    fireEvent.change(await screen.findByLabelText('salesDocuments.dlvQtyToShip — Router'), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'salesDocuments.dlvCreate' }))
    expect((await screen.findByRole('alert')).textContent).toBe('salesDocuments.dlvQtyInvalid')
    expect(api.create).not.toHaveBeenCalled()
  })

  it('a sales rep cannot prepare, confirm or cancel a delivery', async () => {
    deliveriesData = [
      { id: 'D1', delivery_code: null, status: 'draft', created_at: '2026-09-24', delivery_lines: [{ sales_order_line_id: 'L1', qty: 1, product_name: 'Router', line_no: 1 }] },
    ]
    renderPanel({ isManager: false })
    const btn = await screen.findByRole('button', { name: 'salesDocuments.dlvNew' })
    expect(btn.disabled).toBe(true)
    expect(screen.getByText('salesDocuments.dlvManagersOnly')).toBeTruthy() // said on screen, not only in a tooltip
    expect(screen.queryByText('salesDocuments.dlvStatus_draft', { selector: '.font-mono' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'salesDocuments.dlvConfirm' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'salesDocuments.dlvCancel' })).toBeNull()
  })

  it('a manager confirms a draft after saying yes', async () => {
    deliveriesData = [
      { id: 'D1', delivery_code: null, status: 'draft', created_at: '2026-09-24', delivery_lines: [{ sales_order_line_id: 'L1', qty: 1, product_name: 'Router', line_no: 1 }] },
    ]
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'salesDocuments.dlvConfirm' }))
    expect(api.confirm).not.toHaveBeenCalled()
    await screen.findByText('salesDocuments.dlvConfirmMsg')
    const buttons = screen.getAllByRole('button', { name: 'salesDocuments.dlvConfirm' })
    fireEvent.click(buttons[buttons.length - 1]) // the dialog's, rendered last
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith('D1', 'mgr@x'))
  })

  it('a confirmed delivery is invoiced once, then links to its invoice', async () => {
    deliveriesData = [
      { id: 'D1', delivery_code: 'DN-2026-00001', status: 'confirmed', created_at: '2026-09-24', confirmed_at: '2026-09-24', delivery_lines: [] },
      { id: 'D2', delivery_code: 'DN-2026-00002', status: 'confirmed', created_at: '2026-09-24', confirmed_at: '2026-09-24', delivery_lines: [] },
    ]
    invoicesData = [{ id: 'I1', inv_code: 'INV-2026-00007', delivery_id: 'D1', doc_status: 'posted' }]
    const onInvoiceCreated = vi.fn()
    renderPanel({ onInvoiceCreated })
    const link = await screen.findByRole('link', { name: 'salesDocuments.dlvViewInvoice:{"code":"INV-2026-00007"}' })
    expect(link.getAttribute('href')).toBe('/sales/invoice/I1')
    const buttons = screen.getAllByRole('button', { name: 'salesDocuments.dlvInvoice' })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    await waitFor(() => expect(api.invoice).toHaveBeenCalledWith('D2', 'mgr@x'))
    await waitFor(() => expect(onInvoiceCreated).toHaveBeenCalledWith('INV-NEW', expect.objectContaining({ id: 'D2' })))
  })

  it('offers no new delivery once everything is delivered or on a draft', async () => {
    deliveriesData = [
      { id: 'D1', delivery_code: 'DN-1', status: 'confirmed', created_at: '2026-09-24', delivery_lines: [
        { sales_order_line_id: 'L1', qty: 3, product_name: 'Router', line_no: 1 },
        { sales_order_line_id: 'L2', qty: 10, product_name: 'Cable', line_no: 2 }] },
    ]
    renderPanel()
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3))
    expect(screen.queryByRole('button', { name: 'salesDocuments.dlvNew' })).toBeNull()
  })

  it('after invoicing, the delivery shows its invoice instead of the button', async () => {
    deliveriesData = [
      { id: 'D2', delivery_code: 'DN-2026-00002', status: 'confirmed', created_at: '2026-09-24', confirmed_at: '2026-09-24', delivery_lines: [] },
    ]
    api.invoice.mockImplementationOnce(() => {
      invoicesData = [{ id: 'I2', inv_code: null, delivery_id: 'D2', doc_status: 'draft' }]
      return Promise.resolve('I2')
    })
    renderPanel({ onInvoiceCreated: vi.fn() })
    fireEvent.click(await screen.findByRole('button', { name: 'salesDocuments.dlvInvoice' }))
    expect(await screen.findByRole('link', { name: 'salesDocuments.dlvInvoiceDraft' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'salesDocuments.dlvInvoice' })).toBeNull()
  })

  it('a refusal from the database is shown, and nothing moves on', async () => {
    deliveriesData = [
      { id: 'D2', delivery_code: 'DN-2026-00002', status: 'confirmed', created_at: '2026-09-24', confirmed_at: '2026-09-24', delivery_lines: [] },
    ]
    api.invoice.mockImplementationOnce(() => Promise.reject(new Error('This delivery has already been invoiced')))
    const onInvoiceCreated = vi.fn()
    renderPanel({ onInvoiceCreated })
    fireEvent.click(await screen.findByRole('button', { name: 'salesDocuments.dlvInvoice' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('This delivery has already been invoiced'))
    expect(onInvoiceCreated).not.toHaveBeenCalled()
  })

  it('a second click while invoicing does not invoice twice', async () => {
    deliveriesData = [
      { id: 'D2', delivery_code: 'DN-2026-00002', status: 'confirmed', created_at: '2026-09-24', confirmed_at: '2026-09-24', delivery_lines: [] },
    ]
    let release
    api.invoice.mockImplementationOnce(() => new Promise((res) => { release = () => res('I2') }))
    renderPanel({ onInvoiceCreated: vi.fn() })
    const btn = await screen.findByRole('button', { name: 'salesDocuments.dlvInvoice' })
    fireEvent.click(btn)
    fireEvent.click(btn)
    release()
    await waitFor(() => expect(api.invoice).toHaveBeenCalledTimes(1))
  })
})
