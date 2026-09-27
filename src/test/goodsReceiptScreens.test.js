// P-03c: the goods-receipt screens. The pure helpers behind the panel, how the
// purchase order and supplier invoice pages use them, and 20260899 (an invoice
// from receipts is numbered at approval). The panel itself is rendered in
// GoodsReceiptsPanel.test.jsx; the database side in supabase/tests/receipt_invoicing.sql.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { receiptProgress, parseSerials, validateReceipt, unbilledLines, receivableWarehouses } from '../pages/Purchasing/_receipts.js'

const PRODUCTS = {
  S: { id: 'S', product_type: 'hardware', stock_tracking_mode: 'serialized' },
  B: { id: 'B', product_type: 'hardware', stock_tracking_mode: 'bulk' },
  V: { id: 'V', product_type: 'service' },
}
const LINES = [
  { id: 'L1', product_id: 'S', qty_ordered: 5 },
  { id: 'L2', product_id: 'B', qty_ordered: 10 },
  { id: 'L3', product_id: 'V', qty_ordered: 1 },
]

describe('receiptProgress', () => {
  it('counts confirmed as received and drafts as held; cancelled receipts count for nothing', () => {
    const receipts = [
      { status: 'confirmed', goods_receipt_lines: [{ purchase_order_line_id: 'L1', qty: 2 }] },
      { status: 'draft', goods_receipt_lines: [{ purchase_order_line_id: 'L1', qty: 1 }, { purchase_order_line_id: 'L2', qty: 4 }] },
      { status: 'cancelled', goods_receipt_lines: [{ purchase_order_line_id: 'L2', qty: 6 }] },
    ]
    const p = receiptProgress(LINES, receipts, PRODUCTS)
    expect(p.map((x) => [x.line.id, x.serialized, x.received, x.onDraft, x.open])).toEqual([
      ['L1', true, 2, 1, 2],
      ['L2', false, 0, 4, 6],
    ])
  })
  it('leaves a line out until its product is known', () => {
    expect(receiptProgress(LINES, [], { B: PRODUCTS.B }).map((x) => x.line.id)).toEqual(['L2'])
  })
})

describe('parseSerials', () => {
  it('splits on lines, commas, tabs and semicolons and drops blanks', () => {
    expect(parseSerials(' A1 \n\nB2,C3\tD4; ')).toEqual(['A1', 'B2', 'C3', 'D4'])
    expect(parseSerials(undefined)).toEqual([])
  })
})

describe('validateReceipt', () => {
  const row = (o) => ({ lineId: 'L1', open: 3, qty: '1', warehouseId: 'W', serialized: false, ...o })
  it('accepts whole numbers up to what is open, skipping empty lines', () => {
    expect(validateReceipt([row({ qty: '3' }), row({ lineId: 'L2', qty: '' })])).toEqual({
      lines: [{ purchase_order_line_id: 'L1', qty: 3, warehouse_id: 'W' }],
    })
  })
  it.each([['4'], ['1.5'], ['-1'], ['1e1'], ['x']])('refuses %s, naming the line', (qty) => {
    expect(validateReceipt([row({ qty })])).toEqual({ error: 'purchasing.grnQtyInvalidLine', lineId: 'L1' })
  })
  it('needs a warehouse on every line received', () => {
    expect(validateReceipt([row({ warehouseId: '' })])).toEqual({ error: 'purchasing.grnWarehouseMissing', lineId: 'L1' })
  })
  it('needs one serial per unit, never the same serial twice in a receipt (case ignored)', () => {
    expect(validateReceipt([row({ serialized: true, qty: '2', serialsText: 'A' })]).error).toBe('purchasing.grnSerialCount')
    expect(validateReceipt([
      row({ serialized: true, qty: '1', serialsText: 'A1' }),
      row({ lineId: 'L2', serialized: true, qty: '1', serialsText: 'a1' }),
    ])).toEqual({ error: 'purchasing.grnSerialDuplicate', lineId: 'L2', serial: 'a1' })
    expect(validateReceipt([row({ serialized: true, qty: '2', serialsText: 'A1\nA2' })]).lines[0].serials).toEqual(['A1', 'A2'])
  })
  it('refuses an empty receipt', () => {
    expect(validateReceipt([row({ qty: '0' })])).toEqual({ error: 'purchasing.grnQtyNone' })
  })
})

describe('unbilledLines / receivableWarehouses', () => {
  it('only confirmed receipt lines not on a live invoice are to bill', () => {
    const receipts = [
      { status: 'confirmed', goods_receipt_lines: [{ id: 'R1' }, { id: 'R2' }] },
      { status: 'draft', goods_receipt_lines: [{ id: 'R3' }] },
    ]
    expect(unbilledLines(receipts, { R1: 'VI' }).map((l) => l.id)).toEqual(['R2'])
  })
  it('main, branch and untyped active warehouses; never system, archived or other types', () => {
    const ws = [
      { id: 'm', warehouse_type: 'main', is_active: true },
      { id: 'b', warehouse_type: 'branch', is_active: true },
      { id: 'u', warehouse_type: null, is_active: true },
      { id: 's', warehouse_type: 'rma', is_active: true, is_system: true },
      { id: 'x', warehouse_type: 'branch', is_active: false },
      { id: 't', warehouse_type: 'transit', is_active: true },
    ]
    expect(receivableWarehouses(ws).map((w) => w.id)).toEqual(['m', 'b', 'u'])
  })
})

describe('the pages', () => {
  const page = readFileSync('src/pages/Purchasing/PurchaseDocumentDetail.jsx', 'utf8')
  it('an order with receipts is never converted whole or amended from the screen', () => {
    expect(page).toMatch(/!poIsConverted && !hasReceipts && !receiptsLoading && \['confirmed', 'partially_completed'\]\.includes\(doc\.status\) && \(\s*<Button[^>]*onClick=\{handleConvertToVI\}/)
    expect(page).toMatch(/!poIsConverted && !hasReceipts && !receiptsLoading && doc\.status === 'confirmed' && \(\s*<Button[^>]*onClick=\{\(\) => setShowAmend\(true\)\}/)
  })
  it('an invoice from receipts offers no receive, and no cancel once approved', () => {
    const receive = page.indexOf('setShowReceive(true)')
    expect(page.lastIndexOf("{!isReceiptInvoice && ['approved', 'partially_received'].includes(doc.status) && (", receive)).toBeGreaterThan(receive - 200)
    expect(page).toContain("(isReceiptInvoice ? ['draft', 'pending_approval'] : ['draft', 'pending_approval', 'approved']).includes(doc.status)")
  })
})

describe('purchase history entries are readable', () => {
  it('every purchase log kind the page writes has an English and an Arabic sentence', () => {
    const page = readFileSync('src/pages/Purchasing/PurchaseDocumentDetail.jsx', 'utf8')
    const chatter = readFileSync('src/components/ActivityChatter.jsx', 'utf8')
    const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8')).activityChatter
    const ar = JSON.parse(readFileSync('src/locales/ar.json', 'utf8')).activityChatter
    const kinds = [...new Set([...page.matchAll(/log(?:PO|VI)\('([a-z_]+)'\)/g)].map((m) => m[1]))]
    expect(kinds).toContain('po_invoiced_from_receipts')
    for (const kind of kinds) {
      const key = chatter.match(new RegExp(`${kind}: 'activityChatter\\.(\\w+)'`))?.[1]
      expect(key, kind).toBeTruthy()
      expect(en[key], kind).toContain('{{code}}')
      expect(ar[key], kind).toContain('{{code}}')
    }
  })
})

describe('20260899 — an invoice from receipts is numbered at approval', () => {
  const sql = readFileSync('supabase/migrations/20260899_receipt_invoice_code.sql', 'utf8')
  it('takes the gapless VI- counter, only for an invoice from receipts, never twice, not during a restore', () => {
    expect(sql).toContain("NEW.vi_code := public.nextval_for_type('vendor_invoice')")
    expect(sql).toContain('AND NEW.vi_code IS NULL')
    expect(sql).toContain('FROM public.vendor_invoice_receipt_lines WHERE vendor_invoice_id = NEW.id')
    expect(sql).toContain("current_setting('rma.audit_suspended', true) = 'on'")
  })
  it('fires after every other BEFORE trigger, and nobody can call it', () => {
    // BEFORE triggers run in name order: the guards must see the row unchanged
    expect(sql).toMatch(/CREATE TRIGGER trg_vendor_invoices_zz_receipt_code\s+BEFORE UPDATE OF status ON public\.vendor_invoices/)
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.rma_receipt_invoice_code_on_approval() FROM PUBLIC, anon, authenticated;')
  })
})
