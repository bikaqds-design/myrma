// @vitest-environment node
/**
 * rowLinesReaders.test.js — W2 / L-02 step 2.
 *
 * Every document read (list + get of quotations, sales orders, invoices,
 * credit notes, purchase orders, vendor invoices) embeds its line rows and
 * rebuilds `line_items` from them, so screens, forms and PDFs show the real
 * rows without changing. The stored copy is used only when a document has no
 * rows. Each line table has exactly one foreign key to its document (checked
 * on staging), which is what PostgREST needs to resolve the embed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { ROW_LINES, withRowLines } from '../api/db/_rowLines'

describe('withRowLines', () => {
  it('rebuilds line_items from the rows in line_no order and drops the embed', () => {
    const doc = {
      id: 'q1',
      line_items: [{ product_name: 'stale copy', qty: 99 }],
      quotation_lines: [
        { line_no: 1, product_id: 'p2', product_name: 'B', description: null, qty: 1, unit_price: '5.0000', discount_pct: '0.00', tax_pct: '14.00', tax_code: 'VAT14' },
        { line_no: 0, product_id: 'p1', product_name: 'A', description: 'x', qty: 2, unit_price: 10, discount_pct: 10, tax_pct: 0 },
      ],
    }
    const out = withRowLines(doc, ROW_LINES.quotation)
    expect(out).not.toHaveProperty('quotation_lines')
    expect(out.line_items).toEqual([
      { product_id: 'p1', product_name: 'A', description: 'x', qty: 2, unit_price: 10, discount_pct: 10, tax_pct: 0, tax_code: null },
      { product_id: 'p2', product_name: 'B', description: null, qty: 1, unit_price: 5, discount_pct: 0, tax_pct: 14, tax_code: 'VAT14' },
    ])
  })

  it('keeps the stored copy for a document with no rows (written outside the RPCs)', () => {
    const copy = [{ product_name: 'old', qty: 1, unit_price: 1 }]
    const out = withRowLines({ id: 's1', line_items: copy, sales_order_lines: [] }, ROW_LINES.salesOrder)
    expect(out.line_items).toBe(copy)
    expect(out).not.toHaveProperty('sales_order_lines')
  })

  it('carries each document type\'s own fields', () => {
    const cn = withRowLines({ credit_note_lines: [{ line_no: 0, product_name: 'x', qty: 1, unit_price: 1, discount_pct: 0, tax_pct: 0, restock: true, warehouse_id: 'w1' }] }, ROW_LINES.creditNote)
    expect(cn.line_items[0]).toMatchObject({ restock: true, warehouse_id: 'w1' })
    const vi_ = withRowLines({ vendor_invoice_lines: [{ line_no: 0, product_id: 'p', product_name: 'x', qty_ordered: 3, qty_received: 2, unit_cost: '7.5000', discount_pct: 0, tax_pct: 0 }] }, ROW_LINES.vendorInvoice)
    expect(vi_.line_items[0]).toEqual({ product_id: 'p', product_name: 'x', description: null, qty_ordered: 3, qty_received: 2, unit_cost: 7.5, discount_pct: 0, tax_pct: 0, tax_code: null })
    const po = withRowLines({ purchase_order_lines: [{ line_no: 0, product_id: 'p', product_name: 'x', qty_ordered: 3, unit_cost: 2, discount_pct: 0, tax_pct: 0 }] }, ROW_LINES.purchaseOrder)
    expect(po.line_items[0]).not.toHaveProperty('qty_received')
  })

  // plus tax_code (20260911): the writers' copy predates it, and the screens need
  // it on each line so that saving a document keeps its lines' codes
  it('builds exactly the keys the database writers put in the copy, and the tax code', () => {
    const keys = (sqlFile, marker) => {
      const m = readFileSync('supabase/migrations/' + sqlFile, 'utf8')
      const at = m.indexOf(marker)
      return [...[...m.slice(at, m.indexOf('ORDER BY l.line_no', at)).matchAll(/'([a-z_]+)', l\./g)].map((x) => x[1]), 'tax_code'].sort()
    }
    const mk = (src, line) => Object.keys(withRowLines({ [src.embed]: [line] }, src).line_items[0]).sort()
    const base = { line_no: 0, product_id: 'p', product_name: 'x', qty: 1, unit_price: 1, discount_pct: 0, tax_pct: 0, qty_ordered: 1, qty_received: 0, unit_cost: 1, restock: false, warehouse_id: null }
    expect(mk(ROW_LINES.salesOrder, base)).toEqual(keys('20260884_sales_order_lines.sql', 'SELECT jsonb_agg(jsonb_build_object('))
    expect(mk(ROW_LINES.crmInvoice, base)).toEqual(keys('20260885_crm_invoice_lines.sql', 'SELECT jsonb_agg(jsonb_build_object('))
    expect(mk(ROW_LINES.creditNote, base)).toEqual(keys('20260887_credit_note_lines.sql', 'SELECT jsonb_agg(jsonb_build_object('))
    expect(mk(ROW_LINES.purchaseOrder, base)).toEqual(keys('20260888_purchase_order_lines.sql', 'SELECT jsonb_agg(jsonb_build_object('))
    expect(mk(ROW_LINES.vendorInvoice, base)).toEqual(keys('20260889_vendor_invoice_lines.sql', 'SELECT jsonb_agg(jsonb_build_object('))
  })
})

// ── every module reads through it ────────────────────────────────────────────
const mocks = vi.hoisted(() => ({ selects: [], row: {} }))

vi.mock('../api/client.js', () => {
  const chain = (table) => {
    const c = {
      select: (s) => { mocks.selects.push([table, s]); return c },
      eq: () => c, in: () => c, order: () => c,
      // one page, then an empty one: fetchAllRows reads until a page comes back empty
      range: (from) => Promise.resolve({ data: from === 0 ? [{ ...mocks.row }] : [], error: null }),
      single: () => Promise.resolve({ data: { ...mocks.row }, error: null }),
    }
    return c
  }
  return { supabase: { from: (t) => chain(t), rpc: () => Promise.resolve({ data: null, error: null }) } }
})

const { quotations } = await import('../api/db/quotations')
const { salesOrders } = await import('../api/db/salesOrders')
const { crmInvoices } = await import('../api/db/crmInvoices')
const { creditNotes } = await import('../api/db/creditNotes')
const { purchaseOrders, vendorInvoices } = await import('../api/db/purchasing')

describe('document reads embed their rows', () => {
  beforeEach(() => { mocks.selects.length = 0 })
  const cases = [
    ['quotations', quotations, 'quotation_lines', { line_no: 0, product_name: 'row', qty: 3, unit_price: 1 }],
    ['sales_orders', salesOrders, 'sales_order_lines', { line_no: 0, product_name: 'row', qty: 3, unit_price: 1 }],
    ['crm_invoices', crmInvoices, 'crm_invoice_lines', { line_no: 0, product_name: 'row', qty: 3, unit_price: 1 }],
    ['credit_notes', creditNotes, 'credit_note_lines', { line_no: 0, product_name: 'row', qty: 3, unit_price: 1 }],
    ['purchase_orders', purchaseOrders, 'purchase_order_lines', { line_no: 0, product_name: 'row', qty_ordered: 3, unit_cost: 1 }],
    ['vendor_invoices', vendorInvoices, 'vendor_invoice_lines', { line_no: 0, product_name: 'row', qty_ordered: 3, unit_cost: 1 }],
  ]
  for (const [table, mod, embed, line] of cases) {
    it(`${table}: get() and list() select the rows and show them, not the copy`, async () => {
      mocks.row = { id: 'd1', created_at: '2026-01-01', line_items: [{ product_name: 'stale copy' }], [embed]: [line] }
      const one = await mod.get('d1')
      const all = await mod.list()
      // get() once, list() once per page it reads — every one embeds the rows
      expect(mocks.selects.length).toBeGreaterThanOrEqual(2)
      for (const s of mocks.selects) expect(s).toEqual([table, `*, ${embed}(*)`])
      for (const doc of [one, all[0]]) {
        expect(doc.line_items[0].product_name).toBe('row')
        expect(doc).not.toHaveProperty(embed)
      }
    })
  }
})
