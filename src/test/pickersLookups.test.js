/**
 * pickersLookups.test.js — BUG-066, phase 4: pickers and name lookups.
 *
 * Pickers used to filter the whole customer or product table in the browser,
 * and name columns indexed it — both capped by the Data API at 1 000 rows. They
 * now ask the database. What is pinned is the request, where a mistake still
 * returns rows, just the wrong ones:
 *
 *  - a picker search is bounded and alphabetical;
 *  - a vendor's products are that brand's only, and "no services" keeps a
 *    product whose type is empty;
 *  - lookups by id ask only for the ids given, de-duplicated, in URL-safe chunks;
 *  - a lookup by name resolves repeated names to the newest product, as the old
 *    newest-first list did.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
let byTable = {}

function builder(table) {
  const b = {}
  for (const method of ['select', 'or', 'eq', 'neq', 'ilike', 'in', 'order', 'range', 'limit']) {
    b[method] = (...args) => {
      calls.push([table, method, ...args])
      return b
    }
  }
  b.then = (resolve, reject) =>
    Promise.resolve((byTable[table] || []).shift() ?? { data: [], error: null, count: 0 }).then(resolve, reject)
  return b
}

vi.mock('../api/client.js', () => ({
  supabase: { from: (table) => builder(table), rpc: () => builder('rpc') },
}))

const { customers } = await import('../api/db/customers')
const { products } = await import('../api/db/catalog')

beforeEach(() => {
  calls.length = 0
  byTable = {}
})

const on = (table, method) => calls.filter((c) => c[0] === table && c[1] === method).map((c) => c.slice(2))

describe('customers.search', () => {
  it('is one bounded, alphabetical page of matches', async () => {
    byTable.customers = [{ data: [{ id: 'c1' }], error: null, count: 3 }]
    const rows = await customers.search('mona', 8)
    expect(rows).toEqual([{ id: 'c1' }])
    expect(on('customers', 'range')).toEqual([[0, 7]])
    expect(on('customers', 'order')[0]).toEqual(['contact_person', { ascending: true, nullsFirst: true }])
    expect(on('customers', 'or')[0][0]).toContain('company_name.ilike."%mona%"')
  })

  it('with nothing typed, lists the first page alphabetically', async () => {
    await customers.search('', 50)
    expect(on('customers', 'or')).toEqual([])
    expect(on('customers', 'range')).toEqual([[0, 49]])
  })
})

describe('customers.getMany', () => {
  it('asks only for the ids given, de-duplicated, 100 per request', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id${i}`)
    await customers.getMany([...ids, 'id0', '', null])
    const ins = on('customers', 'in')
    expect(ins.map(([, chunk]) => chunk.length)).toEqual([100, 50])
    expect(new Set(ins.flatMap(([, chunk]) => chunk)).size).toBe(150)
  })

  it('makes no request for an empty list', async () => {
    expect(await customers.getMany([])).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('products.search', () => {
  it('limits to one brand when given a vendor', async () => {
    await products.search('ssd', { limit: 8, brandId: 'brand-xpg' })
    expect(on('products', 'eq')).toEqual([['brand_id', 'brand-xpg']])
    expect(on('products', 'range')).toEqual([[0, 7]])
    expect(on('products', 'order')[0]).toEqual(['product_name', { ascending: true, nullsFirst: true }])
  })

  it('leaves out services but keeps a product with no type', async () => {
    await products.search('', { excludeService: true })
    expect(on('products', 'or')).toEqual([['product_type.is.null,product_type.neq.service']])
  })
})

describe('products.findByNames', () => {
  it('resolves a repeated name to the newest product', async () => {
    byTable.products = [
      {
        data: [
          { id: 'new', product_name: 'Widget', created_date: '2026-09-01' },
          { id: 'old', product_name: 'Widget', created_date: '2026-01-01' },
          { id: 'g', product_name: 'Gadget', created_date: '2026-02-01' },
        ],
        error: null,
      },
    ]
    const byName = await products.findByNames(['Widget', 'Gadget', 'Widget', ''])
    expect(on('products', 'in')).toEqual([['product_name', ['Widget', 'Gadget']]])
    expect(on('products', 'order')).toEqual([['created_date', { ascending: false }]])
    expect(byName.Widget.id).toBe('new')
    expect(byName.Gadget.id).toBe('g')
  })
})
