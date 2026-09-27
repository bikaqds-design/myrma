/**
 * GoodsReceiptsPanel.test.jsx — the Goods Receipts panel on a purchase order,
 * rendered (P-03c).
 *
 * The screen check: a manager sees what is still to receive, records a receipt
 * (bulk by count, serialized by the serials scanned) into a sellable warehouse,
 * confirms or cancels a draft, and raises the supplier invoice for what arrived;
 * anyone else sees the same but cannot. i18n echoes the key.
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

const PO_LINES = [
  { id: 'L1', product_id: 'P-ser', product_name: 'Router', qty_ordered: 3, line_no: 0 },
  { id: 'L2', product_id: 'P-blk', product_name: 'Cable', qty_ordered: 10, line_no: 1 },
  { id: 'L3', product_id: 'P-svc', product_name: 'Install', qty_ordered: 1, line_no: 2 },
]
const PRODUCTS = [
  { id: 'P-ser', product_type: 'hardware', stock_tracking_mode: 'serialized' },
  { id: 'P-blk', product_type: 'hardware', stock_tracking_mode: 'bulk' },
  { id: 'P-svc', product_type: 'service', stock_tracking_mode: 'serialized' },
]
const WAREHOUSES = [
  { id: 'W-main', name: 'Main', warehouse_type: 'main', is_active: true, is_system: false },
  { id: 'W-rma', name: 'RMA Received', warehouse_type: 'rma', is_active: true, is_system: true },
  { id: 'W-old', name: 'Old branch', warehouse_type: 'branch', is_active: false, is_system: false },
]
let receiptsData = []
let billedData = {}
const api = {
  create: vi.fn(() => Promise.resolve({ id: 'G9' })),
  confirm: vi.fn(() => Promise.resolve({ id: 'G1' })),
  cancel: vi.fn(() => Promise.resolve({ id: 'G1' })),
  invoice: vi.fn(() => Promise.resolve({ id: 'VI-NEW', total: 10 })),
}

vi.mock('../api/supabaseClient', () => ({
  db: {
    purchaseOrders: { lines: () => Promise.resolve(PO_LINES) },
    products: { getMany: () => Promise.resolve(PRODUCTS) },
    warehouses: { list: () => Promise.resolve({ data: WAREHOUSES }) },
    goodsReceipts: {
      listForOrder: () => Promise.resolve(receiptsData),
      billedLines: () => Promise.resolve(billedData),
      create: (...a) => api.create(...a),
      confirm: (...a) => api.confirm(...a),
      cancel: (...a) => api.cancel(...a),
      invoice: (...a) => api.invoice(...a),
    },
  },
}))

const printNote = vi.fn(() => Promise.resolve())
vi.mock('../lib/goodsReceiptNotePdf', () => ({ downloadGoodsReceiptNotePDF: (...a) => printNote(...a) }))

const { default: GoodsReceiptsPanel } = await import('../pages/Purchasing/GoodsReceiptsPanel.jsx')

function renderPanel(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <GoodsReceiptsPanel po={{ id: 'PO1', status: 'confirmed' }} vendor={{ brand_name: 'Acme' }} isManager currentUserEmail="mgr@x" {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const confirmedReceipt = (id, lines) => ({
  id, grn_code: `GRN-2026-0000${id.slice(-1)}`, status: 'confirmed', created_at: '2026-09-26', confirmed_at: '2026-09-26', goods_receipt_lines: lines,
})

beforeEach(() => {
  receiptsData = []
  billedData = {}
  Object.values(api).forEach((f) => f.mockClear())
  toastError.mockClear()
  printNote.mockClear()
})
afterEach(cleanup)

describe('GoodsReceiptsPanel', () => {
  it('shows what is still to receive per stock line; services are left out', async () => {
    receiptsData = [confirmedReceipt('G1', [{ id: 'R1', purchase_order_line_id: 'L1', qty: 1, product_name: 'Router', warehouse_id: 'W-main', line_no: 0 }])]
    renderPanel()
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3)) // header + 2 stock lines
    const row = screen.getAllByText('Router').find((el) => el.tagName === 'TD').closest('tr')
    expect(within(row).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Router', '3', '1', '—', '2'])
    expect(screen.getByText('purchasing.grnServicesNote')).toBeTruthy()
  })

  it('records a receipt: bulk by count, serialized by the serials scanned, into a sellable warehouse only', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'purchasing.grnNew' }))
    const whSelect = await screen.findByLabelText('purchasing.grnWarehouse', { selector: '#grn-wh-L1' })
    // system and archived locations are not offered
    expect([...whSelect.options].map((o) => o.value)).toEqual(['', 'W-main'])
    expect(whSelect.value).toBe('W-main')
    expect(screen.getByLabelText('purchasing.grnQtyReceived').value).toBe('10')
    fireEvent.change(screen.getByLabelText('purchasing.grnSerials'), { target: { value: 'SN-1\nSN-2\n' } })
    expect(screen.getByText('purchasing.grnSerialQty:{"count":2}')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('purchasing.grnSupplierRef'), { target: { value: ' DN-778 ' } })
    fireEvent.click(screen.getByRole('button', { name: 'purchasing.grnCreate' }))
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        'PO1',
        [
          { purchase_order_line_id: 'L1', qty: 2, warehouse_id: 'W-main', serials: ['SN-1', 'SN-2'] },
          { purchase_order_line_id: 'L2', qty: 10, warehouse_id: 'W-main' },
        ],
        { supplier_ref: 'DN-778', notes: null },
        'mgr@x',
      ))
  })

  it('refuses a serial scanned twice, naming it, without calling the database', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'purchasing.grnNew' }))
    fireEvent.change(await screen.findByLabelText('purchasing.grnSerials'), { target: { value: 'SN-1\nsn-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'purchasing.grnCreate' }))
    expect((await screen.findByRole('alert')).textContent).toContain('purchasing.grnSerialDuplicate')
    expect(screen.getByRole('alert').textContent).toContain('"serial":"sn-1"')
    expect(screen.getByLabelText('purchasing.grnSerials').getAttribute('aria-invalid')).toBe('true')
    expect(api.create).not.toHaveBeenCalled()
  })

  it('refuses more than is open', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'purchasing.grnNew' }))
    fireEvent.change(await screen.findByLabelText('purchasing.grnQtyReceived'), { target: { value: '11' } })
    fireEvent.click(screen.getByRole('button', { name: 'purchasing.grnCreate' }))
    expect((await screen.findByRole('alert')).textContent).toBe('purchasing.grnQtyInvalidLine:{"product":"Cable","open":10}')
    expect(api.create).not.toHaveBeenCalled()
  })

  it('anyone but a manager sees the receipts but cannot record, confirm or cancel one', async () => {
    receiptsData = [{ id: 'G1', grn_code: null, status: 'draft', created_at: '2026-09-26', goods_receipt_lines: [] }]
    renderPanel({ isManager: false })
    expect((await screen.findByRole('button', { name: 'purchasing.grnNew' })).disabled).toBe(true)
    expect(screen.getByText('purchasing.grnManagersOnly')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'purchasing.grnConfirm' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'purchasing.grnCancel' })).toBeNull()
  })

  it('a manager confirms a draft after saying yes', async () => {
    receiptsData = [{ id: 'G1', grn_code: null, status: 'draft', created_at: '2026-09-26', goods_receipt_lines: [] }]
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'purchasing.grnConfirm' }))
    expect(api.confirm).not.toHaveBeenCalled()
    await screen.findByText('purchasing.grnConfirmMsg')
    const buttons = screen.getAllByRole('button', { name: 'purchasing.grnConfirm' })
    fireEvent.click(buttons[buttons.length - 1])
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith('G1', 'mgr@x'))
  })

  it('raises one supplier invoice for what arrived and is not yet billed, once', async () => {
    receiptsData = [
      confirmedReceipt('G1', [{ id: 'R1', purchase_order_line_id: 'L2', qty: 4, product_name: 'Cable', warehouse_id: 'W-main', line_no: 0 }]),
      confirmedReceipt('G2', [{ id: 'R2', purchase_order_line_id: 'L2', qty: 2, product_name: 'Cable', warehouse_id: 'W-main', line_no: 0 }]),
    ]
    billedData = { R1: 'VI-OLD' }
    const onInvoiceCreated = vi.fn()
    renderPanel({ onInvoiceCreated })
    // the billed receipt links to its invoice
    expect((await screen.findByRole('link', { name: 'purchasing.grnViewInvoice' })).getAttribute('href')).toBe('/purchasing/vendor_invoice/VI-OLD')
    const btn = screen.getByRole('button', { name: 'purchasing.grnInvoice:{"count":1}' })
    fireEvent.click(btn)
    fireEvent.click(btn)
    await waitFor(() => expect(onInvoiceCreated).toHaveBeenCalledWith({ id: 'VI-NEW', total: 10 }))
    expect(api.invoice).toHaveBeenCalledTimes(1)
    expect(api.invoice).toHaveBeenCalledWith('PO1', null, 'mgr@x')
  })

  it('prints the note of a confirmed receipt only', async () => {
    receiptsData = [
      confirmedReceipt('G1', []),
      { id: 'G2', grn_code: null, status: 'draft', created_at: '2026-09-26', goods_receipt_lines: [] },
    ]
    renderPanel()
    const buttons = await screen.findAllByRole('button', { name: 'purchasing.grnPrintNote' })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    expect(printNote).toHaveBeenCalledWith(expect.objectContaining({ receipt: expect.objectContaining({ id: 'G1' }), warehouseNames: expect.objectContaining({ 'W-main': 'Main' }) }))
  })

  it('offers no new receipt once the order is fully received', async () => {
    receiptsData = [confirmedReceipt('G1', [
      { id: 'R1', purchase_order_line_id: 'L1', qty: 3, product_name: 'Router', warehouse_id: 'W-main', line_no: 0 },
      { id: 'R2', purchase_order_line_id: 'L2', qty: 10, product_name: 'Cable', warehouse_id: 'W-main', line_no: 1 },
    ])]
    renderPanel({ po: { id: 'PO1', status: 'completed' } })
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3))
    expect(screen.queryByRole('button', { name: 'purchasing.grnNew' })).toBeNull()
  })
})
