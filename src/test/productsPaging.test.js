/**
 * productsPaging.test.js — BUG-066, the Products list.
 *
 * The screen asks the database for one page instead of loading every product.
 * The parts where a wrong query still returns products, just the wrong ones:
 *
 *  - search covers brand and category NAMES, which live in other tables, so the
 *    matching ids are looked up first and OR-ed with the product's own columns;
 *  - the brand/category filters match a name exactly, and a name nobody has
 *    must show nothing (not everything);
 *  - sorting by brand or category orders through the embedded relation;
 *  - the CSV importer's duplicate check is an exact, case-insensitive SKU match
 *    with LIKE wildcards taken literally.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
let byTable = {}

function builder(table) {
  const b = {}
  for (const method of ['select', 'or', 'eq', 'ilike', 'in', 'order', 'range']) {
    b[method] = (...args) => {
      calls.push([table, method, ...args])
      return b
    }
  }
  b.then = (resolve, reject) => {
    const queue = byTable[table] || []
    return Promise.resolve(queue.shift() ?? { data: [], error: null, count: 0 }).then(resolve, reject)
  }
  return b
}

vi.mock('../api/client.js', () => ({
  supabase: {
    from: (table) => builder(table),
    rpc: (fn) => (calls.push(['rpc', fn]), builder('rpc')),
  },
}))

const { products, resolveProductSort } = await import('../api/db/catalog')

beforeEach(() => {
  calls.length = 0
  byTable = {}
})

const on = (table, method) => calls.filter((c) => c[0] === table && c[1] === method).map((c) => c.slice(2))

describe('products.listPage', () => {
  it('asks for one page with an exact count, newest first by default', async () => {
    byTable.products = [{ data: [{ id: 'p1' }], error: null, count: 406 }]
    const page = await products.listPage({ page: 3, pageSize: 25 })
    expect(on('products', 'range')).toEqual([[50, 74]])
    expect(on('products', 'order')[0]).toEqual(['created_date', { ascending: false, nullsFirst: false }])
    expect(page).toMatchObject({ count: 406, totalPages: 17 })
  })

  it('searches product columns and the ids of brands and categories whose names match', async () => {
    byTable.brands = [{ data: [{ id: 'b-acer' }], error: null }, { data: [], error: null }]
    byTable.categories = [{ data: [{ id: 'c1' }, { id: 'c2' }], error: null }, { data: [], error: null }]
    await products.listPage({ page: 1, pageSize: 25, search: 'acer' })
    expect(on('brands', 'ilike')[0]).toEqual(['brand_name', '%acer%'])
    expect(on('categories', 'ilike')[0]).toEqual(['category_name', '%acer%'])
    const [[orFilter]] = on('products', 'or')
    expect(orFilter).toContain('product_name.ilike."%acer%"')
    expect(orFilter).toContain('sku.ilike."%acer%"')
    expect(orFilter).toContain('product_description.ilike."%acer%"')
    expect(orFilter).toContain('brand_id.in.(b-acer)')
    expect(orFilter).toContain('category_id.in.(c1,c2)')
  })

  it('leaves the id parts out when no brand or category name matches', async () => {
    await products.listPage({ page: 1, pageSize: 25, search: 'zz' })
    const [[orFilter]] = on('products', 'or')
    expect(orFilter).not.toContain('brand_id.in')
    expect(orFilter).not.toContain('category_id.in')
  })

  it('filters brand and category by exact name through their ids', async () => {
    byTable.brands = [{ data: [{ id: 'b1' }, { id: 'b2' }], error: null }, { data: [], error: null }]
    byTable.categories = [{ data: [{ id: 'c9' }], error: null }, { data: [], error: null }]
    await products.listPage({ page: 1, pageSize: 25, brandName: 'Acer', categoryName: 'Laptops', status: 'active' })
    expect(on('brands', 'eq')[0]).toEqual(['brand_name', 'Acer'])
    expect(on('products', 'in')).toEqual([
      ['brand_id', ['b1', 'b2']],
      ['category_id', ['c9']],
    ])
    expect(on('products', 'eq')).toEqual([['status', 'active']])
  })

  it('shows nothing, not everything, for a brand name nobody has', async () => {
    await products.listPage({ page: 1, pageSize: 25, brandName: 'Nonexistent' })
    expect(on('products', 'in')).toEqual([['brand_id', []]])
  })

  it('sorts by brand and category through the embedded relation', async () => {
    await products.listPage({ page: 1, pageSize: 25, sort: { column: 'brand', ascending: true } })
    expect(on('products', 'order')).toEqual([
      ['brand(brand_name)', { ascending: true, nullsFirst: true }],
      ['id', { ascending: true }],
    ])
  })
})

describe('resolveProductSort', () => {
  it('maps the screen keys and falls back to newest first', () => {
    expect(resolveProductSort({ column: 'category', ascending: false })).toEqual({
      column: 'category(category_name)',
      ascending: false,
    })
    expect(resolveProductSort({ column: 'product_description', ascending: true })).toEqual({
      column: 'created_date',
      ascending: false,
    })
  })
})

describe('products.findExistingSkus', () => {
  it('matches SKUs exactly and case-insensitively, with wildcards literal', async () => {
    byTable.products = [
      { data: [{ id: '1', sku: 'AB_12' }, { id: '2', sku: 'ab-12x' }], error: null },
      { data: [], error: null },
    ]
    const found = await products.findExistingSkus(['ab_12', ' AB_12 ', 'NEW-1'])
    const [[orFilter]] = on('products', 'or')
    expect(orFilter).toBe('sku.ilike."ab\\\\_12",sku.ilike."new-1"')
    expect([...found]).toEqual(['ab_12'])
  })
})

describe('products.hierarchyCounts', () => {
  it('reads totals from the database function', async () => {
    byTable.rpc = [{ data: { total: 406, by_brand: { b1: 300 }, by_category: { c1: 12 } }, error: null }]
    expect(await products.hierarchyCounts()).toEqual({ total: 406, byBrand: { b1: 300 }, byCategory: { c1: 12 } })
  })
})
