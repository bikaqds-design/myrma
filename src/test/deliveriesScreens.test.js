/**
 * deliveriesScreens.test.js — P-01b / P-02b: deliveries on the sales-order page.
 *
 * Pinned:
 *  - the progress table's arithmetic (ordered / delivered / on a draft / still
 *    to ship; services are not delivered; cancelled deliveries count for
 *    nothing);
 *  - the new-delivery form accepts only whole numbers up to what is open;
 *  - db.deliveries calls the four RPCs with their parameter names and reads an
 *    order's deliveries in chunks;
 *  - the sales-order page keeps the two invoicing paths apart and never offers
 *    to cancel an order whose goods have left;
 *  - every new string exists in English and Arabic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const calls = []
let responses = []

function builder(target, args) {
  const b = {}
  calls.push([target, 'call', ...args])
  for (const method of ['select', 'eq', 'in', 'order', 'range']) {
    b[method] = (...a) => {
      calls.push([target, method, ...a])
      return b
    }
  }
  b.then = (resolve, reject) => Promise.resolve(responses.shift() ?? { data: [], error: null }).then(resolve, reject)
  return b
}

vi.mock('../api/client.js', () => ({
  supabase: {
    from: (table) => builder(table, []),
    rpc: (fn, ...args) => builder(fn, args),
  },
}))

const { deliveries } = await import('../api/db/deliveries.ts')
const { deliveryProgress, validateDeliveryQuantities, raiseDeliveryInvoiceApproval } = await import('../pages/SalesDocuments/_deliveries.js')

beforeEach(() => {
  calls.length = 0
  responses = []
})

describe('deliveryProgress', () => {
  const soLines = [
    { id: 'L1', product_id: 'P-ser', product_name: 'Router', qty: 3 },
    { id: 'L2', product_id: 'P-blk', product_name: 'Cable', qty: 10 },
    { id: 'L3', product_id: 'P-svc', product_name: 'Install', qty: 1 },
  ]
  const products = { 'P-ser': { product_type: 'hardware' }, 'P-blk': { product_type: 'hardware' }, 'P-svc': { product_type: 'service' } }
  const dels = [
    { status: 'confirmed', delivery_lines: [{ sales_order_line_id: 'L1', qty: 1 }, { sales_order_line_id: 'L2', qty: 4 }] },
    { status: 'draft', delivery_lines: [{ sales_order_line_id: 'L2', qty: 2 }] },
    { status: 'cancelled', delivery_lines: [{ sales_order_line_id: 'L1', qty: 2 }] },
  ]

  it('counts confirmed as delivered, drafts as held, cancelled as nothing; services are left out', () => {
    const p = deliveryProgress(soLines, dels, products)
    expect(p.map((x) => [x.line.id, x.ordered, x.delivered, x.onDraft, x.open])).toEqual([
      ['L1', 3, 1, 0, 2],
      ['L2', 10, 4, 2, 4],
    ])
  })

  it('never shows a negative quantity still to ship', () => {
    const over = [{ status: 'confirmed', delivery_lines: [{ sales_order_line_id: 'L1', qty: 5 }] }]
    expect(deliveryProgress(soLines, over, products)[0].open).toBe(0)
  })
})

describe('validateDeliveryQuantities', () => {
  const rows = (a, b) => [{ lineId: 'L1', open: 2, qty: a }, { lineId: 'L2', open: 4, qty: b }]

  it('sends only the lines with a quantity', () => {
    expect(validateDeliveryQuantities(rows('2', '0'))).toEqual({ lines: [{ sales_order_line_id: 'L1', qty: 2 }] })
    expect(validateDeliveryQuantities(rows('', '3'))).toEqual({ lines: [{ sales_order_line_id: 'L2', qty: 3 }] })
  })

  it('refuses fractions, negatives, text and more than is open', () => {
    for (const bad of ['1.5', '-1', 'abc', '1e1', '3']) {
      expect(validateDeliveryQuantities(rows(bad, '0')), bad).toEqual({ error: 'salesDocuments.dlvQtyInvalidLine', lineId: 'L1' })
    }
  })

  it('refuses a delivery of nothing', () => {
    expect(validateDeliveryQuantities(rows('0', '')).error).toBe('salesDocuments.dlvQtyNone')
  })
})

describe('db.deliveries', () => {
  it('calls the RPCs with their parameter names', async () => {
    responses = [{ data: { id: 'D1' }, error: null }, { data: { id: 'D1' }, error: null }, { data: { id: 'D1' }, error: null }, { data: 'INV1', error: null }]
    await deliveries.create('SO1', [{ sales_order_line_id: 'L1', qty: 1 }], 'n', 'me@x')
    await deliveries.confirm('D1', 'me@x')
    await deliveries.cancel('D1', 'me@x')
    const id = await deliveries.invoice('D1', 'me@x')
    const rpcs = calls.filter((c) => c[1] === 'call')
    expect(rpcs).toEqual([
      ['create_delivery', 'call', { p_so_id: 'SO1', p_lines: [{ sales_order_line_id: 'L1', qty: 1 }], p_notes: 'n', p_actor_email: 'me@x' }],
      ['confirm_delivery', 'call', { p_delivery_id: 'D1', p_actor_email: 'me@x' }],
      ['cancel_delivery', 'call', { p_delivery_id: 'D1', p_actor_email: 'me@x' }],
      ['create_invoice_from_delivery', 'call', { p_delivery_id: 'D1', p_actor_email: 'me@x' }],
    ])
    expect(id).toBe('INV1')
  })

  it('surfaces a refusal from the database', async () => {
    responses = [{ data: null, error: { message: 'Only managers and above can confirm a delivery' } }]
    await expect(deliveries.confirm('D1', 'me@x')).rejects.toMatchObject({ message: /managers/ })
  })

  it("reads one order's deliveries in chunks, lines in order", async () => {
    responses = [
      { data: [{ id: 'D1', delivery_lines: [{ line_no: 2 }, { line_no: 1 }] }], error: null },
      { data: [], error: null },
    ]
    const rows = await deliveries.listForOrder('SO1')
    expect(calls).toContainEqual(['deliveries', 'eq', 'sales_order_id', 'SO1'])
    expect(calls.some((c) => c[0] === 'deliveries' && c[1] === 'range')).toBe(true)
    expect(rows[0].delivery_lines.map((l) => l.line_no)).toEqual([1, 2])
  })
})

describe('raiseDeliveryInvoiceApproval', () => {
  const delivery = { id: 'D2', delivery_code: 'DN-2026-00002' }

  it("raises the request with the invoice's own total and the delivery's code", async () => {
    const createApproval = vi.fn()
    await raiseDeliveryInvoiceApproval({ invoiceId: 'I9', delivery, fallbackCode: 'SO-1', getInvoice: async () => ({ total: 572 }), createApproval })
    expect(createApproval).toHaveBeenCalledWith('I9', 'DN-2026-00002', 572)
  })

  it('reads the invoice again once if the first read fails', async () => {
    const createApproval = vi.fn()
    const getInvoice = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ total: 80 })
    await raiseDeliveryInvoiceApproval({ invoiceId: 'I9', delivery, fallbackCode: 'SO-1', getInvoice, createApproval })
    expect(getInvoice).toHaveBeenCalledTimes(2)
    expect(createApproval).toHaveBeenCalledWith('I9', 'DN-2026-00002', 80)
  })

  it('never leaves the invoice without a request, even when it cannot be read', async () => {
    const createApproval = vi.fn()
    await raiseDeliveryInvoiceApproval({ invoiceId: 'I9', delivery: {}, fallbackCode: 'SO-1', getInvoice: async () => { throw new Error('rls') }, createApproval })
    expect(createApproval).toHaveBeenCalledWith('I9', 'SO-1', 0)
  })
})

describe('sales-order page', () => {
  const page = readFileSync('src/pages/SalesDocuments/SalesDocumentDetail.jsx', 'utf8')

  it('offers the whole-order invoice only while the order has no delivery', () => {
    expect(page).toMatch(/!soIsInvoiced && !soShipsByDeliveries && \['confirmed', 'delivered'\]\.includes\(n\.status\)[\s\S]{0,120}handleConvertToInvoice/)
    expect(page).toContain("inv.doc_status !== 'cancelled' && !inv.delivery_id")
  })

  it('does not offer to cancel an order whose goods have left', () => {
    expect(page).toMatch(/!soIsInvoiced && !soHasShipped && \[[^\]]+\]\.includes\(n\.status\)[\s\S]{0,140}handleCancelSO/)
  })

  it('shows the deliveries panel on an approved order that was not invoiced whole', () => {
    expect(page).toMatch(/isSO && !doc\.archived && !soIsInvoiced && \['confirmed', 'delivered'\]\.includes\(n\.status\) && \(\s*<DeliveriesPanel/)
  })

  it("lets the order's own rep invoice a delivery, as the database does", () => {
    expect(page).toContain('canInvoice={canInvoiceDelivery}')
    expect(page).toContain('[doc.assigned_rep, doc.created_by].includes(currentUserEmail)')
    expect(page).toContain('currentUserRole === ROLES.SALES_REP')
  })
})

describe('strings', () => {
  const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8')).salesDocuments
  const ar = JSON.parse(readFileSync('src/locales/ar.json', 'utf8')).salesDocuments
  const used = [...readFileSync('src/pages/SalesDocuments/DeliveriesPanel.jsx', 'utf8').matchAll(/salesDocuments\.(dlv[A-Za-z_]+)/g)]
    .map((m) => m[1])
    .filter((k) => !k.endsWith('_')) // `dlvStatus_${status}` — the three statuses are listed below

  it('every delivery string used on screen exists in both languages', () => {
    expect(used.length).toBeGreaterThan(20)
    for (const k of new Set([...used, 'dlvStatus_draft', 'dlvStatus_confirmed', 'dlvStatus_cancelled'])) {
      expect(en[k], `en ${k}`).toBeTruthy()
      expect(ar[k], `ar ${k}`).toBeTruthy()
    }
  })
})
