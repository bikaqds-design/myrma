/**
 * accountingPaging.test.js — BUG-066, phase 5d: the Accounting page and the
 * money lists behind it.
 *
 * The page loaded every payment, every vendor payment, every posted invoice,
 * every vendor invoice and every brand, and did the search, the paging and —
 * worse — the receivable and payable aging sums in the browser, past the Data
 * API's 1 000-row cap. What is pinned:
 *
 *  - payment lists: one page, searched over code, counterpart name and
 *    reference, newest first with a stable tie-break;
 *  - aging: one database call per report with the viewer's local today, every
 *    row read and returned as numbers;
 *  - the lists other screens still use (invoices, vendor invoices, brands,
 *    ledgers) read every row, and a vendor's payable invoices are narrowed in
 *    the database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
let responses = []

function builder(target, args) {
  const b = {}
  calls.push([target, 'call', ...args])
  for (const method of ['select', 'eq', 'in', 'or', 'order', 'range']) {
    b[method] = (...a) => {
      calls.push([target, method, ...a])
      return b
    }
  }
  b.then = (resolve, reject) =>
    Promise.resolve(responses.shift() ?? { data: [], error: null, count: 0 }).then(resolve, reject)
  return b
}

vi.mock('../api/client.js', () => ({
  supabase: {
    from: (table) => builder(table, []),
    rpc: (fn, ...args) => builder(fn, args),
  },
}))

const { payments } = await import('../api/db/payments')
const { vendorPayments } = await import('../api/db/vendorPayments')
const { customerLedger } = await import('../api/db/customerLedger')
const { vendorLedger } = await import('../api/db/vendorLedger')
const { crmInvoices } = await import('../api/db/crmInvoices')
const { vendorInvoices } = await import('../api/db/purchasing')
const { brands } = await import('../api/db/catalog')

beforeEach(() => {
  calls.length = 0
  responses = []
})

const on = (target, method) => calls.filter((c) => c[0] === target && c[1] === method).map((c) => c.slice(2))
const thousand = () => Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}` }))

describe('payment lists', () => {
  it('payments.listPage searches code, customer name and reference, newest first', async () => {
    responses = [{ data: [{ id: 'p1' }], error: null, count: 3 }]
    const res = await payments.listPage({ search: ' pay-1 ' }, 2, 10)
    expect(on('v_payments_list', 'select')).toEqual([['*', { count: 'exact' }]])
    expect(on('v_payments_list', 'or')).toEqual([
      ['payment_code.ilike."%pay-1%",customer_name.ilike."%pay-1%",reference_number.ilike."%pay-1%"'],
    ])
    expect(on('v_payments_list', 'order')).toEqual([
      ['payment_date', { ascending: false, nullsFirst: false }],
      ['created_at', { ascending: false }],
      ['id', { ascending: true }],
    ])
    expect(on('v_payments_list', 'range')).toEqual([[10, 19]])
    expect(res.count).toBe(3)
  })

  it('vendorPayments.listPage searches the vendor name; no search adds no filter', async () => {
    await vendorPayments.listPage({ search: 'xpg' }, 1, 25)
    expect(on('v_vendor_payments_list', 'or')).toEqual([
      ['payment_code.ilike."%xpg%",vendor_name.ilike."%xpg%",reference_number.ilike."%xpg%"'],
    ])
    calls.length = 0
    await vendorPayments.listPage({ search: '   ' }, 1, 25)
    expect(on('v_vendor_payments_list', 'or')).toEqual([])
  })
})

describe('aging reports', () => {
  it('arAging passes the viewer’s today, reads every row, returns numbers', async () => {
    responses = [
      { data: [{ customer_id: 'c1', customer_name: 'Acme', not_due: '10.50', d1_30: 0, d31_60: '0', d61_90: 0, d90_plus: 0, no_due_date: 5, total: '15.50' }], error: null },
      { data: [], error: null },
    ]
    const rows = await customerLedger.arAging('2026-09-15')
    // The rows, then the empty chunk that ends the read — both for the same day.
    expect(on('rma_ar_aging', 'call')).toEqual([[{ p_today: '2026-09-15' }], [{ p_today: '2026-09-15' }]])
    expect(on('rma_ar_aging', 'order').slice(0, 2)).toEqual([
      ['total', { ascending: false }],
      ['customer_id', { ascending: true }],
    ])
    expect(rows).toEqual([{ customer_id: 'c1', customer_name: 'Acme', not_due: 10.5, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, no_due_date: 5, total: 15.5 }])
  })

  it('arAging defaults today to the local calendar date', async () => {
    await customerLedger.arAging()
    const [{ p_today }] = on('rma_ar_aging', 'call')[0]
    const d = new Date()
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(p_today).toBe(local)
  })

  it('apAging reads past the row cap', async () => {
    responses = [{ data: thousand(), error: null }, { data: [{ id: 'x' }], error: null }, { data: [], error: null }]
    expect(await vendorLedger.apAging('2026-09-15')).toHaveLength(1001)
    expect(on('rma_ap_aging', 'call')[0]).toEqual([{ p_today: '2026-09-15' }])
  })
})

describe('lists that must hold every row', () => {
  it('crmInvoices.list walks past 1 000 and keeps its filters', async () => {
    responses = [{ data: thousand(), error: null }, { data: [{ id: 'last' }], error: null }, { data: [], error: null }]
    const rows = await crmInvoices.list({ customerId: 'c1', docStatus: 'posted' })
    expect(rows).toHaveLength(1001)
    expect(on('crm_invoices', 'eq').slice(0, 2)).toEqual([
      ['customer_id', 'c1'],
      ['doc_status', 'posted'],
    ])
  })

  it('crmInvoices.list still reports a missing table as empty', async () => {
    responses = [{ data: null, error: { code: '42P01' } }]
    expect(await crmInvoices.list()).toEqual([])
  })

  it('vendorInvoices.list narrows to one vendor and its payable statuses in the database', async () => {
    await vendorInvoices.list({ vendorId: 'v1', statuses: ['approved', 'received'] })
    expect(on('vendor_invoices', 'eq')).toEqual([['vendor_id', 'v1']])
    expect(on('vendor_invoices', 'in')).toEqual([['status', ['approved', 'received']]])
  })

  it('brands.list and the ledgers read in chunks with a stable order', async () => {
    responses = [{ data: thousand(), error: null }, { data: [], error: null }]
    expect(await brands.list()).toHaveLength(1000)
    expect(on('brands', 'order')[1]).toEqual(['id', { ascending: true }])

    await customerLedger.list('c1')
    expect(on('v_customer_ledger', 'order').slice(0, 3)).toEqual([
      ['entry_date', { ascending: true }],
      ['entry_type', { ascending: true }],
      ['id', { ascending: true }],
    ])
    await vendorLedger.list('v1')
    expect(on('v_vendor_ledger', 'eq')[0]).toEqual(['vendor_id', 'v1'])
  })

  it('payments.list and vendorPayments.list read every row', async () => {
    responses = [{ data: thousand(), error: null }, { data: [{ id: 'z' }], error: null }, { data: [], error: null }]
    expect(await payments.list()).toHaveLength(1001)
    responses = [{ data: [{ id: 'v' }], error: null }, { data: [], error: null }]
    expect(await vendorPayments.list({ vendorId: 'v1' })).toHaveLength(1)
  })
})
