/**
 * purchasingPaging.test.js — BUG-066, phase 5d: the Purchasing page, its graph
 * and pivot, the Vendors tab and Vendor Details.
 *
 * Purchasing loaded every purchase document and every brand and did the tab
 * split, counts, search, filters, sort, paging, spend chart and pivot in the
 * browser, past the Data API's 1 000-row cap; Vendor Details loaded every
 * document to keep one vendor's. What is pinned:
 *
 *  - documents: one page from v_purchase_documents_list with the tab, status,
 *    vendor and search applied in the database, sorted by the column's key and
 *    tie-broken by type then id; an export reads every matching row;
 *  - counts and spend: one call each, the spend already in base currency, and
 *    the chart/pivot/Vendor Details totals are sums of those rows with
 *    cancelled documents left out of spend;
 *  - vendors: a page of v_vendors_list, searched and sorted with blanks last,
 *    and a single brand read by id instead of the whole table.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
let responses = []

function builder(target, args) {
  const b = {}
  calls.push([target, 'call', ...args])
  for (const method of ['select', 'eq', 'in', 'or', 'order', 'range', 'maybeSingle']) {
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

const { purchaseDocuments, purchaseOrders, applyPurchaseDocFilters, resolvePurchaseDocSort } = await import('../api/db/purchasing')
const { brands } = await import('../api/db/catalog')
const { dimensionKey, groupBuckets, summarizeBuckets } = await import('../pages/Purchasing/_shared.js')

beforeEach(() => {
  calls.length = 0
  responses = []
})

const on = (target, method) => calls.filter((c) => c[0] === target && c[1] === method).map((c) => c.slice(2))
const thousand = () => Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}` }))

function recorder() {
  const log = []
  const q = {
    eq: (...a) => (log.push(['eq', ...a]), q),
    or: (...a) => (log.push(['or', ...a]), q),
  }
  return { q, log }
}

describe('applyPurchaseDocFilters', () => {
  it('holds the active documents on All and one type on a type tab', () => {
    let r = recorder()
    applyPurchaseDocFilters(r.q, { tab: 'all' })
    expect(r.log).toEqual([['eq', 'archived', false]])
    r = recorder()
    applyPurchaseDocFilters(r.q, { tab: 'vendor_invoice' })
    expect(r.log).toEqual([['eq', 'archived', false], ['eq', 'doc_type', 'vendor_invoice']])
  })

  it('holds only archived documents on Archive, and every document for "any"', () => {
    let r = recorder()
    applyPurchaseDocFilters(r.q, { tab: 'archive' })
    expect(r.log).toEqual([['eq', 'archived', true]])
    r = recorder()
    applyPurchaseDocFilters(r.q, { tab: 'any', vendorId: 'v1' })
    expect(r.log).toEqual([['eq', 'vendor_id', 'v1']])
  })

  it('adds status, vendor and a literal search over code and vendor name', () => {
    const r = recorder()
    applyPurchaseDocFilters(r.q, { tab: 'all', status: 'approved', vendorId: 'v9', search: ' 50%_x ' })
    expect(r.log).toEqual([
      ['eq', 'archived', false],
      ['eq', 'doc_status', 'approved'],
      ['eq', 'vendor_id', 'v9'],
      ['or', 'doc_code.ilike."%50\\\\%\\\\_x%",vendor_name.ilike."%50\\\\%\\\\_x%"'],
    ])
  })
})

describe('resolvePurchaseDocSort', () => {
  it('sorts totals in base currency and vendors with nameless rows last', () => {
    expect(resolvePurchaseDocSort({ key: 'total', direction: 'asc' })).toEqual({ column: 'total_base_value', ascending: true, nullsFirst: true })
    expect(resolvePurchaseDocSort({ key: 'vendor', direction: 'asc' })).toEqual({ column: 'vendor_sort', ascending: true, nullsFirst: false })
    expect(resolvePurchaseDocSort({ key: 'vendor', direction: 'desc' })).toEqual({ column: 'vendor_sort', ascending: false, nullsFirst: true })
  })

  it('sorts codes case-insensitively and missing dates first ascending', () => {
    expect(resolvePurchaseDocSort({ key: 'doc_code', direction: 'asc' }).column).toBe('doc_code_sort')
    expect(resolvePurchaseDocSort({ key: 'type_specific_date', direction: 'asc' })).toEqual({ column: 'type_specific_date', ascending: true, nullsFirst: true })
  })

  it('falls back to newest first for an unknown key', () => {
    expect(resolvePurchaseDocSort({ key: 'nope', direction: 'asc' })).toEqual({ column: 'created_at', ascending: false, nullsFirst: false })
    expect(resolvePurchaseDocSort()).toEqual({ column: 'created_at', ascending: false, nullsFirst: false })
  })
})

describe('purchaseDocuments', () => {
  it('listPage reads one page of the list view with an exact count and a stable order', async () => {
    responses = [{ data: [{ id: 'd1' }], error: null, count: 31 }]
    const res = await purchaseDocuments.listPage({ tab: 'purchase_order' }, { key: 'vendor', direction: 'asc' }, 2, 25)
    expect(on('v_purchase_documents_list', 'select')).toEqual([['*', { count: 'exact' }]])
    expect(on('v_purchase_documents_list', 'order')).toEqual([
      ['vendor_sort', { ascending: true, nullsFirst: false }],
      ['doc_type', { ascending: true }],
      ['id', { ascending: true }],
    ])
    expect(on('v_purchase_documents_list', 'range')).toEqual([[25, 49]])
    expect(res.count).toBe(31)
    expect(res.data).toEqual([{ id: 'd1' }])
  })

  it('listAllMatching walks past 1 000 rows for an export', async () => {
    responses = [{ data: thousand(), error: null }, { data: [{ id: 'last' }], error: null }, { data: [], error: null }]
    const rows = await purchaseDocuments.listAllMatching({ tab: 'any' }, { key: 'created_at', direction: 'desc' })
    expect(rows).toHaveLength(1001)
    expect(on('v_purchase_documents_list', 'eq')).toEqual([])
  })

  it('summary is one call and returns numbers', async () => {
    responses = [{ data: { counts: { all: '9', purchase_order: 5, vendor_invoice: 4, archive: 0, total: 9 }, statuses: ['approved'] }, error: null }]
    const s = await purchaseDocuments.summary('vendor_invoice')
    expect(on('rma_purchase_document_summary', 'call')).toEqual([[{ p_tab: 'vendor_invoice' }]])
    expect(s).toEqual({ counts: { all: 9, purchase_order: 5, vendor_invoice: 4, archive: 0, total: 9 }, statuses: ['approved'] })
  })

  it('buckets passes the list filters and the viewer’s time zone, reads every row, returns numbers', async () => {
    responses = [
      { data: [{ doc_type: 'vendor_invoice', doc_status: 'approved', vendor_id: 'v1', vendor_name: 'ASRock', created_month: '2026-07', doc_count: '1', spend: '181875.00' }], error: null },
      { data: [], error: null },
    ]
    const rows = await purchaseDocuments.buckets({ tab: 'all', status: '', vendorId: 'v1', search: ' asr ' })
    const [args] = on('rma_purchase_document_buckets', 'call')[0]
    expect(args).toEqual({
      p_tab: 'all',
      p_status: null,
      p_vendor_id: 'v1',
      p_term: 'asr',
      p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    })
    expect(rows).toEqual([{ doc_type: 'vendor_invoice', doc_status: 'approved', vendor_id: 'v1', vendor_name: 'ASRock', created_month: '2026-07', doc_count: 1, spend: 181875 }])
  })

  it('purchaseOrders.list reads every row', async () => {
    responses = [{ data: thousand(), error: null }, { data: [{ id: 'z' }], error: null }, { data: [], error: null }]
    expect(await purchaseOrders.list()).toHaveLength(1001)
    expect(on('purchase_orders', 'order')[1]).toEqual(['id', { ascending: true }])
  })
})

describe('vendors', () => {
  it('listVendorsPage searches name, contact, email and phone and sorts blanks last', async () => {
    responses = [{ data: [{ id: 'b1' }], error: null, count: 14 }]
    const res = await brands.listVendorsPage(' acer ', { key: 'contact_person', direction: 'desc' }, 1, 10)
    expect(on('v_vendors_list', 'or')).toEqual([
      ['brand_name.ilike."%acer%",contact_person.ilike."%acer%",email.ilike."%acer%",phone.ilike."%acer%"'],
    ])
    expect(on('v_vendors_list', 'order')).toEqual([
      ['contact_person_sort', { ascending: false, nullsFirst: false }],
      ['id', { ascending: true }],
    ])
    expect(on('v_vendors_list', 'range')).toEqual([[0, 9]])
    expect(res.count).toBe(14)
  })

  it('listVendorsPage ignores an unknown sort key and a blank search', async () => {
    await brands.listVendorsPage('  ', { key: 'id; drop', direction: 'asc' }, 1, 25)
    expect(on('v_vendors_list', 'or')).toEqual([])
    expect(on('v_vendors_list', 'order')[0]).toEqual(['brand_name_sort', { ascending: true, nullsFirst: false }])
  })

  it('get reads one brand by id', async () => {
    responses = [{ data: { id: 'b7', brand_name: 'XPG' }, error: null }]
    expect(await brands.get('b7')).toEqual({ id: 'b7', brand_name: 'XPG' })
    expect(on('brands', 'eq')).toEqual([['id', 'b7']])
    expect(on('brands', 'maybeSingle')).toEqual([[]])
  })
})

describe('bucket arithmetic', () => {
  const t = (k) => ({ 'purchasing.st_approved': 'Approved', 'common.unknown': 'Unknown' }[k] ?? k)
  const buckets = [
    { doc_type: 'purchase_order', doc_status: 'confirmed', vendor_id: 'a', vendor_name: 'ASRock', created_month: '2026-07', doc_count: 2, spend: 100 },
    { doc_type: 'vendor_invoice', doc_status: 'approved', vendor_id: 'a', vendor_name: 'ASRock', created_month: '2026-08', doc_count: 1, spend: 50 },
    { doc_type: 'purchase_order', doc_status: 'cancelled', vendor_id: 'b', vendor_name: 'XPG', created_month: '2026-08', doc_count: 4, spend: 999 },
    { doc_type: 'purchase_order', doc_status: 'draft', vendor_id: null, vendor_name: null, created_month: null, doc_count: 1, spend: 7 },
  ]

  it('summarizeBuckets counts every document but leaves cancelled ones out of spend', () => {
    expect(summarizeBuckets(buckets)).toEqual({ documents: 8, liveDocuments: 4, spend: 157, vendors: 1 })
    expect(summarizeBuckets([])).toEqual({ documents: 0, liveDocuments: 0, spend: 0, vendors: 0 })
  })

  it('groupBuckets sums count and spend per group over live rows only', () => {
    const byVendor = groupBuckets(buckets, 'vendor', t)
    expect(Object.fromEntries(byVendor)).toEqual({ ASRock: { count: 3, spend: 150 }, '—': { count: 1, spend: 7 } })
    const byMonth = groupBuckets(buckets, 'month', t)
    expect(Object.fromEntries(byMonth)).toEqual({ '2026-07': { count: 2, spend: 100 }, '2026-08': { count: 1, spend: 50 }, Unknown: { count: 1, spend: 7 } })
  })

  it('dimensionKey names the vendor, status, type and month a row falls in', () => {
    expect(dimensionKey(buckets[1], 'status', t)).toBe('Approved')
    expect(dimensionKey(buckets[3], 'vendor', t)).toBe('—')
    expect(dimensionKey(buckets[0], 'month', t)).toBe('2026-07')
  })
})
