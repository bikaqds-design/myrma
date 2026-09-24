// @vitest-environment node
/**
 * convertPoToViCurrency.test.js — live bug on main: "Create vendor invoice"
 * from a purchase order inserted a vendor invoice without a currency, and
 * vendor_invoices.currency is NOT NULL with no default (20260792), so it
 * always failed. The invoice now takes the order's currency and rate.
 * (On the next line the whole conversion is the convert_po_to_vendor_invoice
 * RPC, 20260889.)
 */
import { describe, it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ inserted: [] }))

vi.mock('../api/client.js', () => ({
  supabase: {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({
            data: {
              id: 'po1', vendor_id: 'v1', currency: 'USD', exchange_rate: 48.5, notes: 'po notes',
              line_items: [{ product_id: 'p1', product_name: 'Router', qty_ordered: 2, unit_cost: 10 }],
            },
            error: null,
          }),
        }),
      }),
      insert: (rows) => {
        mocks.inserted.push({ table, rows })
        return { select: () => Promise.resolve({ data: rows, error: null }) }
      },
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}))

const { purchaseOrders } = await import('../api/db/purchasing')

describe('purchaseOrders.convertToVendorInvoice', () => {
  it("inserts the vendor invoice in the order's currency and at its rate", async () => {
    await purchaseOrders.convertToVendorInvoice('po1', 'a@b.c')
    const row = mocks.inserted.find((i) => i.table === 'vendor_invoices').rows[0]
    expect(row).toMatchObject({ purchase_order_id: 'po1', vendor_id: 'v1', currency: 'USD', exchange_rate: 48.5 })
  })
})
