/**
 * inventoryLists.test.js — BUG-066, phase 5: the Inventory screen's reads.
 *
 * The tabs now page, filter and order in the database. What is pinned is the
 * request, since a wrong one still returns rows — just not the right ones:
 *
 *  - every list orders by a unique column last, so pages neither repeat nor skip;
 *  - each filter reaches the column it means (a stock filter on the right count,
 *    a status filter only on a real count column);
 *  - an unmatched product's units are found by grouping name, so
 *    "Unknown Product" resolves to its units;
 *  - a transfer of many units is sent in URL-safe chunks and still reports
 *    what did not change over the whole selection.
 * What the views compute is pinned in supabase/tests/inventory_list_views.sql.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
let responses = []

function builder(table) {
  const b = {}
  for (const method of ['select', 'or', 'eq', 'gt', 'is', 'in', 'order', 'range', 'update', 'maybeSingle']) {
    b[method] = (...args) => {
      calls.push([table, method, ...args])
      return b
    }
  }
  b.then = (resolve, reject) =>
    Promise.resolve(responses.shift() ?? { data: [], error: null, count: 0 }).then(resolve, reject)
  return b
}

vi.mock('../api/client.js', () => ({
  supabase: { from: (table) => builder(table), rpc: () => builder('rpc') },
}))

const { inventoryLists } = await import('../api/db/inventoryLists')
const { inventory } = await import('../api/db/inventory')

beforeEach(() => {
  calls.length = 0
  responses = []
})

const on = (table, method) => calls.filter((c) => c[0] === table && c[1] === method).map((c) => c.slice(2))

describe('stock summary page', () => {
  it('orders by physical stock, then name, then id, one page at a time', async () => {
    await inventoryLists.stockSummaryPage({}, 2, 25)
    expect(on('v_product_stock_summary', 'order')).toEqual([
      ['physical_total', { ascending: false }],
      ['product_name', { ascending: true }],
      ['product_id', { ascending: true }],
    ])
    expect(on('v_product_stock_summary', 'range')).toEqual([[25, 49]])
  })

  it.each([
    ['available', ['gt', 'available', 0]],
    ['reserved', ['gt', 'reserved', 0]],
    ['rma', ['gt', 'rma_total', 0]],
    ['out', ['eq', 'physical_total', 0]],
  ])('the "%s" stock filter tests the matching count', async (stock, [method, column, value]) => {
    await inventoryLists.stockSummaryPage({ stock }, 1, 25)
    expect(on('v_product_stock_summary', method)).toContainEqual([column, value])
  })
})

describe('product groups page', () => {
  it('filters a status only on a real count column', async () => {
    await inventoryLists.productGroupsPage({ status: 'company_stock' }, 1, 25)
    expect(on('v_inventory_product_groups', 'gt')).toEqual([['company_stock', 0]])

    calls.length = 0
    await inventoryLists.productGroupsPage({ status: 'product_name' }, 1, 25)
    expect(on('v_inventory_product_groups', 'gt')).toEqual([])
  })

  it('searches name or brand, and narrows by product name separately', async () => {
    await inventoryLists.productGroupsPage({ search: 'acer', product: 'nitro' }, 1, 25)
    const ors = on('v_inventory_product_groups', 'or').map(([f]) => f)
    expect(ors).toHaveLength(2)
    expect(ors[0]).toContain('brand.ilike."%acer%"')
    expect(ors[1]).toBe('product_name.ilike."%nitro%"')
  })

  it('orders by brand then product name, as the tab sorted', async () => {
    await inventoryLists.productGroupsPage({}, 1, 25)
    expect(on('v_inventory_product_groups', 'order')).toEqual([
      ['brand', { ascending: true }],
      ['product_name', { ascending: true }],
    ])
  })
})

describe('units', () => {
  it('finds an unmatched product by grouping name, not raw name', async () => {
    await inventoryLists.allUnits({ unmatchedName: 'Unknown Product', status: 'active_rma' })
    expect(on('v_inventory_units', 'is')).toEqual([['product_id', null]])
    expect(on('v_inventory_units', 'eq')).toEqual([
      ['group_name', 'Unknown Product'],
      ['status', 'active_rma'],
    ])
  })

  it('treats "off stock" as any status but stock and RMA, including none', async () => {
    await inventoryLists.allUnits({ productId: 'p1', offStock: true })
    expect(on('v_inventory_units', 'or')).toEqual([['status.is.null,status.not.in.(company_stock,active_rma)']])
  })

  it('searches a warehouse by product, serial, RMA number, brand and customer', async () => {
    await inventoryLists.unitsPage({ warehouseId: 'w1', search: 'x' }, 1, 100)
    const [filter] = on('v_inventory_units', 'or')[0]
    for (const column of ['product_name', 'serial_number', 'rma_number', 'brand_name', 'ticket_customer_name']) {
      expect(filter).toContain(`${column}.ilike.`)
    }
    expect(on('v_inventory_units', 'order').at(-1)).toEqual(['id', { ascending: true }])
  })

  it('reads every matching unit past the row cap', async () => {
    const chunk = (n, from) => Array.from({ length: n }, (_, i) => ({ id: `u${from + i}` }))
    responses = [
      { data: chunk(1000, 0), error: null },
      { data: chunk(400, 1000), error: null },
      { data: [], error: null },
    ]
    const rows = await inventoryLists.allUnits({ warehouseId: 'w1' })
    expect(rows).toHaveLength(1400)
    expect(on('v_inventory_units', 'range')).toEqual([
      [0, 999],
      [1000, 1999],
      [1400, 2399],
    ])
  })
})

describe('stock moves page', () => {
  it('searches the label and the actor, newest first', async () => {
    await inventoryLists.movesPage({ search: 'ssd', moveType: 'receive' }, 1, 25)
    expect(on('v_stock_moves_listing', 'eq')).toEqual([['move_type', 'receive']])
    expect(on('v_stock_moves_listing', 'or')[0][0]).toContain('ref_label.ilike."%ssd%"')
    expect(on('v_stock_moves_listing', 'order')).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: true }],
    ])
  })
})

describe('transferUnits', () => {
  it('sends ids 100 at a time', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `u${i}`)
    responses = [0, 100, 200].map((start) => ({
      data: ids.slice(start, start + 100).map((id) => ({ id })),
      error: null,
    }))
    await inventory.transferUnits(ids, 'w2')
    expect(on('inventory_units', 'in').map(([, chunk]) => chunk.length)).toEqual([100, 100, 50])
  })

  it('reports what did not change over the whole selection', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `u${i}`)
    responses = [
      { data: ids.slice(0, 100).map((id) => ({ id })), error: null },
      { data: ids.slice(100, 140).map((id) => ({ id })), error: null },
    ]
    await expect(inventory.transferUnits(ids, 'w2')).rejects.toMatchObject({
      code: 'RMA_NOT_ALL_UPDATED',
      total: 150,
      unchangedIds: ids.slice(140),
    })
  })
})
