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
let returnsData = []
let returnNotes = []
const DELIVERED_UNITS = [
  { delivery_line_id: 'DL1', unit_id: 'U1', serial_number: 'SN-1' },
  { delivery_line_id: 'DL1', unit_id: 'U2', serial_number: 'SN-2' },
]
const rtn = {
  create: vi.fn(() => Promise.resolve({ id: 'R9' })),
  confirm: vi.fn(() => Promise.resolve({ id: 'R1' })),
  cancel: vi.fn(() => Promise.resolve({ id: 'R1' })),
  creditNote: vi.fn(() => Promise.resolve('CN-NEW')),
}
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
    customerReturns: {
      listForOrder: () => Promise.resolve(returnsData),
      creditNotesFor: () => Promise.resolve(returnNotes),
      deliveredUnits: () => Promise.resolve(DELIVERED_UNITS),
      create: (...a) => rtn.create(...a),
      confirm: (...a) => rtn.confirm(...a),
      cancel: (...a) => rtn.cancel(...a),
      creditNote: (...a) => rtn.creditNote(...a),
    },
    warehouses: {
      list: () => Promise.resolve({ missing: false, data: [
        { id: 'W1', name: 'Main', warehouse_type: 'main', is_active: true },
        { id: 'WS', name: 'Scrap', warehouse_type: 'virtual', is_system: true, is_active: true },
      ] }),
    },
  },
}))

const navigateTo = vi.fn()
vi.mock('react-router-dom', async (orig) => ({ ...(await orig()), useNavigate: () => navigateTo }))

const printNote = vi.fn(() => Promise.resolve())
vi.mock('../lib/deliveryNotePdf', () => ({ downloadDeliveryNotePDF: (...a) => printNote(...a) }))

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
  returnsData = []
  returnNotes = []
  Object.values(api).forEach((f) => f.mockClear())
  Object.values(rtn).forEach((f) => f.mockClear())
  navigateTo.mockClear()
  toastError.mockClear()
  printNote.mockClear()
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
    // the message names the line, and that input is marked
    expect((await screen.findByRole('alert')).textContent).toBe('salesDocuments.dlvQtyInvalidLine:{"product":"Router","open":3}')
    expect(screen.getByLabelText('salesDocuments.dlvQtyToShip — Router').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByLabelText('salesDocuments.dlvQtyToShip — Cable').getAttribute('aria-invalid')).toBeNull()
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
    // a normal step: the dialog uses the accent colour, not the red delete style
    expect(screen.getByRole('dialog').querySelector('.bg-indigo-100')).not.toBeNull()
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

  it('a confirmed delivery can be printed as a note; a draft cannot', async () => {
    deliveriesData = [
      { id: 'D1', delivery_code: 'DN-2026-00001', status: 'confirmed', created_at: '2026-09-24', confirmed_at: '2026-09-24', delivery_lines: [] },
      { id: 'D2', delivery_code: null, status: 'draft', created_at: '2026-09-24', delivery_lines: [] },
    ]
    const customer = { company_name: 'Acme' }
    renderPanel({ customer })
    const buttons = await screen.findAllByRole('button', { name: 'salesDocuments.dlvPrintNote' })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    expect(printNote).toHaveBeenCalledWith({ delivery: expect.objectContaining({ id: 'D1' }), salesOrder: expect.objectContaining({ id: 'SO1' }), customer })
  })

  // ── returns (P-05d) ────────────────────────────────────────────────────────
  const SHIPPED = {
    id: 'D1', delivery_code: 'DN-2026-00001', status: 'confirmed', created_at: '2026-09-24', confirmed_at: '2026-09-24',
    delivery_lines: [
      { id: 'DL1', sales_order_line_id: 'L1', qty: 2, product_name: 'Router', line_no: 0 },
      { id: 'DL2', sales_order_line_id: 'L2', qty: 10, product_name: 'Cable', line_no: 1 },
    ],
  }

  it('goods come back only from a delivery whose invoice is posted, and only for a manager', async () => {
    deliveriesData = [SHIPPED]
    invoicesData = [{ id: 'I1', delivery_id: 'D1', doc_status: 'draft', inv_code: null }]
    const { unmount } = renderPanel()
    await screen.findByText('DN-2026-00001')
    expect(screen.queryByRole('button', { name: 'salesDocuments.rtnRecord' })).toBeNull()
    unmount()

    invoicesData = [{ id: 'I1', delivery_id: 'D1', doc_status: 'posted', inv_code: 'INV-2026-00001' }]
    const rep = renderPanel({ isManager: false })
    await screen.findByText('DN-2026-00001')
    await waitFor(() => expect(screen.getByText('salesDocuments.dlvViewInvoice:{"code":"INV-2026-00001"}')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'salesDocuments.rtnRecord' })).toBeNull()
    rep.unmount()

    renderPanel()
    expect(await screen.findByRole('button', { name: 'salesDocuments.rtnRecord' })).toBeTruthy()
  })

  it('records a return: the ticked units and the typed quantity, into a sellable warehouse', async () => {
    deliveriesData = [SHIPPED]
    invoicesData = [{ id: 'I1', delivery_id: 'D1', doc_status: 'posted', inv_code: 'INV-2026-00001' }]
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'salesDocuments.rtnRecord' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'SN-2' }))
    fireEvent.change(screen.getByLabelText('salesDocuments.rtnQty'), { target: { value: '4' } })
    // the scrap location is never offered (back to stock only)
    expect(screen.queryByRole('option', { name: 'Scrap' })).toBeNull()
    fireEvent.change(screen.getByLabelText('salesDocuments.rtnReason'), { target: { value: 'Wrong model' } })
    fireEvent.click(screen.getByRole('button', { name: 'salesDocuments.rtnCreate' }))
    await waitFor(() => expect(rtn.create).toHaveBeenCalledWith('D1', [
      { delivery_line_id: 'DL1', unit_ids: ['U2'], warehouse_id: 'W1' },
      { delivery_line_id: 'DL2', qty: 4, warehouse_id: 'W1' },
    ], { reason: 'Wrong model' }, 'mgr@x'))
  })

  it('refuses more than can come back without calling the database, and offers only units still out', async () => {
    deliveriesData = [SHIPPED]
    invoicesData = [{ id: 'I1', delivery_id: 'D1', doc_status: 'posted', inv_code: 'INV-2026-00001' }]
    returnsData = [{ id: 'R1', delivery_id: 'D1', status: 'confirmed', return_code: 'RTN-2026-00001', created_at: '2026-09-25',
      customer_return_lines: [{ delivery_line_id: 'DL1', qty: 1, unit_ids: ['U1'], product_name: 'Router', line_no: 0 },
                              { delivery_line_id: 'DL2', qty: 3, unit_ids: [], product_name: 'Cable', line_no: 1 }] }]
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'salesDocuments.rtnRecord' }))
    await screen.findByRole('checkbox', { name: 'SN-2' })
    expect(screen.queryByRole('checkbox', { name: 'SN-1' })).toBeNull() // already back
    fireEvent.change(screen.getByLabelText('salesDocuments.rtnQty'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: 'salesDocuments.rtnCreate' }))
    expect((await screen.findByRole('alert')).textContent).toBe('salesDocuments.rtnQtyInvalidLine:{"product":"Cable","left":7}')
    expect(rtn.create).not.toHaveBeenCalled()
  })

  it('a draft return is confirmed after saying yes; a confirmed one is credited and opens its credit note', async () => {
    deliveriesData = [SHIPPED]
    invoicesData = [{ id: 'I1', delivery_id: 'D1', doc_status: 'posted', inv_code: 'INV-2026-00001' }]
    returnsData = [
      { id: 'R1', delivery_id: 'D1', status: 'draft', return_code: null, created_at: '2026-09-25',
        customer_return_lines: [{ delivery_line_id: 'DL2', qty: 2, unit_ids: [], product_name: 'Cable', line_no: 0 }] },
      { id: 'R2', delivery_id: 'D1', status: 'confirmed', return_code: 'RTN-2026-00002', created_at: '2026-09-25',
        customer_return_lines: [{ delivery_line_id: 'DL2', qty: 1, unit_ids: [], product_name: 'Cable', line_no: 0 }] },
    ]
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'salesDocuments.rtnConfirm' }))
    expect(rtn.confirm).not.toHaveBeenCalled()
    await screen.findByText('salesDocuments.rtnConfirmMsg')
    const buttons = screen.getAllByRole('button', { name: 'salesDocuments.rtnConfirm' })
    fireEvent.click(buttons[buttons.length - 1]) // the dialog's, rendered last
    await waitFor(() => expect(rtn.confirm).toHaveBeenCalledWith('R1', 'mgr@x'))

    fireEvent.click(screen.getByRole('button', { name: 'salesDocuments.rtnCreditNote' }))
    await waitFor(() => expect(rtn.creditNote).toHaveBeenCalledWith('R2', 'mgr@x'))
    expect(navigateTo).toHaveBeenCalledWith('/sales/credit_note/CN-NEW')
  })

  it('a return that already has its credit note links to it instead', async () => {
    deliveriesData = [SHIPPED]
    invoicesData = [{ id: 'I1', delivery_id: 'D1', doc_status: 'posted', inv_code: 'INV-2026-00001' }]
    returnsData = [{ id: 'R2', delivery_id: 'D1', status: 'confirmed', return_code: 'RTN-2026-00002', created_at: '2026-09-25',
      customer_return_lines: [{ delivery_line_id: 'DL2', qty: 1, unit_ids: [], product_name: 'Cable', line_no: 0 }] }]
    returnNotes = [{ id: 'CN1', cn_code: null, status: 'draft', customer_return_id: 'R2' }]
    renderPanel()
    const link = await screen.findByRole('link', { name: 'salesDocuments.rtnCreditNoteDraft' })
    expect(link.getAttribute('href')).toBe('/sales/credit_note/CN1')
    expect(screen.queryByRole('button', { name: 'salesDocuments.rtnCreditNote' })).toBeNull()
  })
})
