/**
 * deliveryNotePdf.test.js — the printable delivery note (P-01).
 *
 * What the customer signs for: the delivery's number, who it goes to, which
 * order it belongs to, each product and quantity that left — with the serial
 * numbers when the printer may read them — and no prices. A draft (no number,
 * nothing shipped) is never printed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const serials = vi.fn()
const openPrint = vi.fn()
vi.mock('../api/supabaseClient', () => ({ db: { deliveries: { serials: (...a) => serials(...a) } } }))
vi.mock('../lib/documentPdf', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, getPdfLayout: async () => ({ layout: real.PDF_LAYOUT_DEFAULT, logoUrl: null }), openPrint: (...a) => openPrint(...a) }
})

const { buildDeliveryNoteHTML, downloadDeliveryNotePDF } = await import('../lib/deliveryNotePdf.js')
const { PDF_LAYOUT_DEFAULT } = await import('../lib/documentPdf.js')

const delivery = {
  id: 'D1',
  delivery_code: 'DN-2026-00001',
  status: 'confirmed',
  confirmed_at: '2026-09-25T08:00:00Z',
  confirmed_by: 'warehouse.lead@example.com',
  notes: 'Gate 3 <leave with security>',
  delivery_lines: [
    { id: 'DL1', product_name: 'Router X1', qty: 2 },
    { id: 'DL2', product_name: 'Cable 5m', qty: 4 },
  ],
}
const salesOrder = { so_code: 'SO-2026-00001', reference_po: 'PO-778', total: 2000 }
const customer = { company_name: 'Delivery Test Co', contact_person: 'Mona', address: '12 Nile St' }

beforeEach(() => {
  serials.mockReset()
  openPrint.mockReset()
})

describe('buildDeliveryNoteHTML', () => {
  const html = buildDeliveryNoteHTML({
    layout: PDF_LAYOUT_DEFAULT,
    logoUrl: null,
    delivery,
    salesOrder,
    customer,
    serialsByLine: { DL1: ['SN-001', 'SN-002'] },
  })

  it('names the delivery, the customer it goes to, and the order it belongs to', () => {
    expect(html).toContain('Delivery Note')
    expect(html).toContain('DN-2026-00001')
    expect(html).toContain('Deliver To:')
    expect(html).toContain('Delivery Test Co')
    expect(html).toContain('SO-2026-00001')
    expect(html).toContain('PO-778')
  })

  it('lists each product with the quantity that left, the serials that shipped, and the unit total', () => {
    expect(html).toMatch(/Router X1[\s\S]*S\/N: SN-001, SN-002[\s\S]*<td class="center">2<\/td>/)
    expect(html).toMatch(/Cable 5m<\/td>\s*<td class="center">4<\/td>/)
    expect(html).toMatch(/Total units<\/td>\s*<td class="center">6<\/td>/)
  })

  it('carries no prices — the invoice does', () => {
    expect(html).not.toContain('2,000')
    expect(html).not.toMatch(/Unit Price|Order Total|EGP/)
  })

  it('has room for the customer to sign, and escapes what people typed', () => {
    expect(html).toContain('Received By')
    expect(html).toContain('Gate 3 &lt;leave with security&gt;')
    expect(html).not.toContain('<leave with security>')
  })
})

describe('downloadDeliveryNotePDF', () => {
  it('prints a confirmed delivery with its serials', async () => {
    serials.mockResolvedValue({ DL1: ['SN-9'] })
    await downloadDeliveryNotePDF({ delivery, salesOrder, customer })
    expect(serials).toHaveBeenCalledWith('D1')
    expect(openPrint).toHaveBeenCalledTimes(1)
    expect(openPrint.mock.calls[0][0]).toContain('S/N: SN-9')
  })

  it('still prints, quantities only, when the serials cannot be read (not a manager)', async () => {
    serials.mockRejectedValue(new Error('permission denied'))
    await downloadDeliveryNotePDF({ delivery, salesOrder, customer })
    expect(openPrint).toHaveBeenCalledTimes(1)
    expect(openPrint.mock.calls[0][0]).not.toContain('S/N:')
  })

  it('never prints a draft', async () => {
    await downloadDeliveryNotePDF({ delivery: { ...delivery, delivery_code: null, status: 'draft' }, salesOrder, customer })
    expect(openPrint).not.toHaveBeenCalled()
  })
})
