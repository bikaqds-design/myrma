/**
 * returnNotePdf.test.js — the printable return note (P-05d).
 *
 * What both sides sign when goods come back: the return's number, who returned
 * it, the delivery and order it came from, each product and quantity with the
 * warehouse it went back into and the serial numbers of the units (when the
 * printer may read them), the reason, and no prices. A draft (no number,
 * nothing back yet) is never printed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const deliveredUnits = vi.fn()
const warehousesList = vi.fn()
const openPrint = vi.fn()
vi.mock('../api/supabaseClient', () => ({
  db: {
    customerReturns: { deliveredUnits: (...a) => deliveredUnits(...a) },
    warehouses: { list: (...a) => warehousesList(...a) },
  },
}))
vi.mock('../lib/documentPdf', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, getPdfLayout: async () => ({ layout: real.PDF_LAYOUT_DEFAULT, logoUrl: null }), openPrint: (...a) => openPrint(...a) }
})

const { buildReturnNoteHTML, downloadReturnNotePDF } = await import('../lib/returnNotePdf.js')
const { PDF_LAYOUT_DEFAULT } = await import('../lib/documentPdf.js')

const ret = {
  id: 'R1',
  return_code: 'RTN-2026-00001',
  delivery_id: 'D1',
  status: 'confirmed',
  confirmed_at: '2026-09-27T08:00:00Z',
  confirmed_by: 'store.manager@example.com',
  reason: 'Wrong model <ordered X2>',
  customer_return_lines: [
    { id: 'L1', product_name: 'Router X1', qty: 2, warehouse_id: 'W1', unit_ids: ['U1', 'U2'] },
    { id: 'L2', product_name: 'Cable 5m', qty: 3, warehouse_id: 'W2', unit_ids: [] },
  ],
}
const salesOrder = { so_code: 'SO-2026-00001', total: 2000 }
const customer = { company_name: 'Return Test Co', contact_person: 'Mona' }

beforeEach(() => {
  deliveredUnits.mockReset()
  warehousesList.mockReset()
  openPrint.mockReset()
})

describe('buildReturnNoteHTML', () => {
  const html = buildReturnNoteHTML({
    layout: PDF_LAYOUT_DEFAULT,
    logoUrl: null,
    ret,
    deliveryCode: 'DN-2026-00001',
    salesOrder,
    customer,
    serialByUnit: { U1: 'SN-A', U2: 'SN-B' },
    warehouseNames: { W1: 'Main', W2: 'Branch East' },
  })

  it('names the return, the customer, the delivery and the order', () => {
    expect(html).toContain('Return Note')
    expect(html).toContain('RTN-2026-00001')
    expect(html).toContain('Return Test Co')
    expect(html).toContain('DN-2026-00001')
    expect(html).toContain('SO-2026-00001')
  })

  it('lists each line with its warehouse, quantity and serials, and the total units', () => {
    expect(html).toContain('Router X1')
    expect(html).toContain('S/N: SN-A, SN-B')
    expect(html).toContain('Branch East')
    expect(html).toMatch(/Total units<\/td>\s*<td class="center">5</)
  })

  it('carries no prices and escapes the reason', () => {
    expect(html).not.toContain('2000')
    expect(html).toContain('Wrong model &lt;ordered X2&gt;')
    expect(html).not.toContain('<ordered X2>')
  })

  it('names who received it', () => {
    expect(html).toContain('Received By')
    expect(html.toLowerCase()).toContain('store')
  })
})

describe('downloadReturnNotePDF', () => {
  it('prints with the serials and warehouse names it can read', async () => {
    deliveredUnits.mockResolvedValue([
      { delivery_line_id: 'DL1', unit_id: 'U1', serial_number: 'SN-A' },
      { delivery_line_id: 'DL1', unit_id: 'U2', serial_number: 'SN-B' },
    ])
    warehousesList.mockResolvedValue({ data: [{ id: 'W1', name: 'Main' }] })
    await downloadReturnNotePDF({ ret, deliveryCode: 'DN-2026-00001', salesOrder, customer })
    expect(deliveredUnits).toHaveBeenCalledWith('D1')
    const html = openPrint.mock.calls[0][0]
    expect(html).toContain('S/N: SN-A, SN-B')
    expect(html).toContain('Main')
  })

  it('still prints, quantities only, when the serials are not readable for this role', async () => {
    deliveredUnits.mockRejectedValue(new Error('permission denied'))
    warehousesList.mockResolvedValue({ missing: true, data: [] })
    await downloadReturnNotePDF({ ret, deliveryCode: 'DN-2026-00001', salesOrder, customer })
    const html = openPrint.mock.calls[0][0]
    expect(html).toContain('Router X1')
    expect(html).not.toContain('S/N:')
  })

  it('never prints a draft', async () => {
    await downloadReturnNotePDF({ ret: { ...ret, return_code: null, status: 'draft' }, salesOrder, customer })
    expect(openPrint).not.toHaveBeenCalled()
    expect(deliveredUnits).not.toHaveBeenCalled()
  })
})
