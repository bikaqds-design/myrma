/**
 * goodsReceiptNotePdf.test.js — the printable goods received note (P-03c).
 *
 * What arrived on one confirmed receipt: its GRN number, the supplier, the
 * order and the supplier's own delivery-note number, each product with the
 * warehouse it went into and the serials scanned — and no prices. A draft (no
 * number, nothing in stock yet) is never printed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const openPrint = vi.fn()
vi.mock('../lib/documentPdf', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, getPdfLayout: async () => ({ layout: real.PDF_LAYOUT_DEFAULT, logoUrl: null }), openPrint: (...a) => openPrint(...a) }
})

const { buildGoodsReceiptNoteHTML, downloadGoodsReceiptNotePDF } = await import('../lib/goodsReceiptNotePdf.js')
const { PDF_LAYOUT_DEFAULT } = await import('../lib/documentPdf.js')

const receipt = {
  id: 'G1',
  grn_code: 'GRN-2026-00001',
  status: 'confirmed',
  confirmed_at: '2026-09-26T08:00:00Z',
  confirmed_by: 'store.keeper@example.com',
  supplier_ref: 'DN-<778>',
  notes: 'Two cartons dented',
  goods_receipt_lines: [
    { id: 'R1', product_name: 'Router X1', qty: 2, warehouse_id: 'W1', serials: ['SN-1', 'SN-2'] },
    { id: 'R2', product_name: 'Cable 5m', qty: 6, warehouse_id: 'W2', serials: [] },
  ],
}
const purchaseOrder = { po_code: 'PO-2026-00001', total: 350 }
const vendor = { brand_name: 'Acme Supply', contact_person: 'Omar', phone: '0100', email: 'sales@acme.test' }
const warehouseNames = { W1: 'Main', W2: 'Branch East' }

beforeEach(() => openPrint.mockReset())

describe('buildGoodsReceiptNoteHTML', () => {
  const html = buildGoodsReceiptNoteHTML({ layout: PDF_LAYOUT_DEFAULT, logoUrl: null, receipt, purchaseOrder, vendor, warehouseNames })

  it('names the receipt, the supplier, the order and the supplier note (escaped)', () => {
    expect(html).toContain('Goods Received Note')
    expect(html).toContain('GRN-2026-00001')
    expect(html).toContain('Acme Supply')
    expect(html).toContain('PO-2026-00001')
    expect(html).toContain('DN-&lt;778&gt;')
    expect(html).not.toContain('DN-<778>')
  })
  it('lists each product with its warehouse, quantity and the serials scanned, and the total units', () => {
    expect(html).toMatch(/Router X1[\s\S]*S\/N: SN-1, SN-2[\s\S]*Main[\s\S]*>2</)
    expect(html).toMatch(/Cable 5m[\s\S]*Branch East[\s\S]*>6</)
    expect(html).toMatch(/Total units[\s\S]*>8</)
  })
  it('carries no prices', () => {
    expect(html).not.toContain('350')
    expect(html).not.toMatch(/Unit Cost|Price|Amount/i)
  })
})

describe('downloadGoodsReceiptNotePDF', () => {
  it('prints a confirmed receipt', async () => {
    await downloadGoodsReceiptNotePDF({ receipt, purchaseOrder, vendor, warehouseNames })
    expect(openPrint).toHaveBeenCalledTimes(1)
  })
  it('never prints a draft', async () => {
    await downloadGoodsReceiptNotePDF({ receipt: { ...receipt, grn_code: null, status: 'draft' }, purchaseOrder, vendor, warehouseNames })
    expect(openPrint).not.toHaveBeenCalled()
  })
})
