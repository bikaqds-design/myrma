/**
 * customersPaging.test.js — BUG-066, the Customers list.
 *
 * The screen now asks the database for one page instead of loading the table.
 * What is pinned is the query it sends, because a wrong query still returns
 * rows — just not the right ones:
 *
 *  - search and the contact/company filter must narrow TOGETHER (two separate
 *    `or` parameters, which PostgREST ANDs), not widen into one big OR;
 *  - typed text reaches the filter taken literally (commas, % and _);
 *  - the sort column is checked against a list, and a unique `id` order comes
 *    last so paging neither repeats nor skips a row;
 *  - the CSV importer's "is this name taken?" is exact after trimming, not the
 *    substring match used to fetch candidates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
let responses = []

function builder() {
  const b = {}
  for (const method of ['select', 'or', 'eq', 'order', 'range', 'in']) {
    b[method] = (...args) => {
      calls.push([method, ...args])
      return b
    }
  }
  b.then = (resolve, reject) => {
    const next = responses.shift() ?? { data: [], error: null, count: 0 }
    return Promise.resolve(next).then(resolve, reject)
  }
  return b
}

vi.mock('../api/client.js', () => ({
  supabase: { from: (table) => (calls.push(['from', table]), builder()) },
}))

const { customers, resolveCustomerSort } = await import('../api/db/customers')

beforeEach(() => {
  calls.length = 0
  responses = []
})

const methodCalls = (name) => calls.filter((c) => c[0] === name).map((c) => c.slice(1))

describe('customers.listPage', () => {
  it('asks for exactly one page with an exact count', async () => {
    responses = [{ data: [{ id: 'a' }], error: null, count: 888 }]
    const page = await customers.listPage({ page: 3, pageSize: 25 })
    expect(methodCalls('select')).toEqual([['*', { count: 'exact' }]])
    expect(methodCalls('range')).toEqual([[50, 74]])
    expect(page).toMatchObject({ count: 888, page: 3, totalPages: 36 })
  })

  it('narrows search and contact/company filter together, as two parameters', async () => {
    await customers.listPage({ page: 1, pageSize: 25, search: 'acme', contactOrCompany: 'mona' })
    const ors = methodCalls('or')
    expect(ors).toHaveLength(2)
    expect(ors[0][0]).toContain('contact_person.ilike."%acme%"')
    expect(ors[0][0]).toContain('landline.ilike."%acme%"')
    expect(ors[1][0]).toBe('company_name.ilike."%mona%",contact_person.ilike."%mona%"')
  })

  it('carries a comma and LIKE wildcards through literally', async () => {
    await customers.listPage({ page: 1, pageSize: 25, search: 'Dell, 50%_x' })
    expect(methodCalls('or')[0][0]).toContain('email.ilike."%Dell, 50\\\\%\\\\_x%"')
  })

  it('applies status and type as exact matches and ignores blanks', async () => {
    await customers.listPage({ page: 1, pageSize: 25, status: 'Active', type: '', search: '   ' })
    expect(methodCalls('eq')).toEqual([['customer_status', 'Active']])
    expect(methodCalls('or')).toEqual([])
  })

  it('orders by the chosen column, then by id', async () => {
    await customers.listPage({ page: 1, pageSize: 25, sort: { column: 'company_name', ascending: true } })
    expect(methodCalls('order')).toEqual([
      ['company_name', { ascending: true, nullsFirst: true }],
      ['id', { ascending: true }],
    ])
  })
})

describe('resolveCustomerSort', () => {
  it('falls back to newest first for a column that is not sortable', () => {
    expect(resolveCustomerSort({ column: 'notes;drop', ascending: true })).toEqual({
      column: 'created_date',
      ascending: false,
    })
    expect(resolveCustomerSort(undefined)).toEqual({ column: 'created_date', ascending: false })
  })

  it('keeps a valid column and direction', () => {
    expect(resolveCustomerSort({ column: 'mobile', ascending: true })).toEqual({ column: 'mobile', ascending: true })
  })
})

describe('customers.listAllMatching', () => {
  it('reads every matching row in chunks until an empty one', async () => {
    const chunk = (n, start) => Array.from({ length: n }, (_, i) => ({ id: String(start + i) }))
    responses = [
      { data: chunk(1000, 0), error: null },
      { data: chunk(300, 1000), error: null },
      { data: [], error: null },
    ]
    const rows = await customers.listAllMatching({ status: 'Active' })
    expect(rows).toHaveLength(1300)
    expect(methodCalls('range')).toEqual([[0, 999], [1000, 1999], [1300, 2299]])
    expect(methodCalls('eq')).toEqual([
      ['customer_status', 'Active'],
      ['customer_status', 'Active'],
      ['customer_status', 'Active'],
    ])
  })
})

describe('customers.findExistingNames', () => {
  it('matches trimmed, case-insensitive names exactly — not by substring', async () => {
    responses = [
      // company candidates for "acme"
      { data: [{ id: '1', company_name: '  ACME ' }, { id: '2', company_name: 'Acme Holdings' }], error: null },
      { data: [], error: null },
      // contact candidates for "mona"
      { data: [{ id: '3', contact_person: 'Mona Ali' }], error: null },
      { data: [], error: null },
    ]
    const found = await customers.findExistingNames(['Acme', ' acme', ''], ['Mona'])
    expect([...found.companies]).toEqual(['acme'])
    expect([...found.contacts]).toEqual([])
  })

  it('asks nothing when there are no names', async () => {
    const found = await customers.findExistingNames(['', '  '], [])
    expect(calls).toEqual([])
    expect(found.companies.size + found.contacts.size).toBe(0)
  })
})
