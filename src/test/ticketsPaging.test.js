/**
 * ticketsPaging.test.js — BUG-066, the RMA Tickets list and board.
 *
 * The screen asks the database for one page (or one board column) instead of
 * loading every ticket. Pinned here is the query, because a wrong one still
 * returns tickets — just not the right ones:
 *
 *  - the search box goes to rma_tickets_matching(), which also searches product
 *    serials inside the products array; everything else is a column filter;
 *  - "overdue" keeps the old rule exactly: due today or earlier (UTC), and not
 *    resolved — with a ticket that has no status counted as unresolved;
 *  - a board column is its status plus the same filters, newest first;
 *  - the sort column is checked against a list, with id as the tiebreak.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
let responses = []

function builder() {
  const b = {}
  for (const method of ['select', 'or', 'eq', 'lte', 'order', 'range']) {
    b[method] = (...args) => {
      calls.push([method, ...args])
      return b
    }
  }
  b.then = (resolve, reject) =>
    Promise.resolve(responses.shift() ?? { data: [], error: null, count: 0 }).then(resolve, reject)
  return b
}

vi.mock('../api/client.js', () => ({
  supabase: {
    rpc: (fn, args, opts) => (calls.push(['rpc', fn, args, opts]), builder()),
    from: (table) => (calls.push(['from', table]), builder()),
  },
}))

const { rmaTickets, resolveTicketSort, overdueCutoff } = await import('../api/db/tickets')

beforeEach(() => {
  calls.length = 0
  responses = []
})

const methodCalls = (name) => calls.filter((c) => c[0] === name).map((c) => c.slice(1))

describe('rmaTickets.listPage', () => {
  it('searches through rma_tickets_matching and asks for one page with an exact count', async () => {
    responses = [{ data: [{ id: 't1' }], error: null, count: 60 }]
    const page = await rmaTickets.listPage({ page: 2, pageSize: 25, search: '  SN-123 ' })
    expect(methodCalls('rpc')).toEqual([['rma_tickets_matching', { p_term: 'SN-123' }, { count: 'exact' }]])
    expect(methodCalls('range')).toEqual([[25, 49]])
    expect(page).toMatchObject({ count: 60, page: 2, totalPages: 3 })
  })

  it('sends no term for a blank search, so every ticket matches', async () => {
    await rmaTickets.listPage({ page: 1, pageSize: 25, search: '   ' })
    expect(methodCalls('rpc')[0][1]).toEqual({ p_term: null })
  })

  it('applies status, priority, technician and customer as exact matches', async () => {
    await rmaTickets.listPage({
      page: 1,
      pageSize: 25,
      status: 'Open',
      priority: 'High',
      assigned: 'tech@qds.eg',
      customer: 'Acme, Ltd',
    })
    expect(methodCalls('eq')).toEqual([
      ['ticket_status', 'Open'],
      ['priority', 'High'],
      ['assigned_technician', 'tech@qds.eg'],
      ['customer_name', 'Acme, Ltd'],
    ])
  })

  it('keeps the overdue rule: due by today and not resolved, a missing status counting as unresolved', async () => {
    const realNow = Date.now
    Date.now = () => new Date('2026-09-14T10:00:00Z').getTime()
    try {
      await rmaTickets.listPage({ page: 1, pageSize: 25, overdue: true })
    } finally {
      Date.now = realNow
    }
    const [[, cutoff]] = methodCalls('lte')
    expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(methodCalls('or')).toEqual([
      ['ticket_status.is.null,ticket_status.not.in.("Completed","Closed","Cancelled")'],
    ])
  })

  it('orders by the chosen column, then by id', async () => {
    await rmaTickets.listPage({ page: 1, pageSize: 25, sort: { column: 'priority', ascending: false } })
    expect(methodCalls('order')).toEqual([
      ['priority', { ascending: false, nullsFirst: false }],
      ['id', { ascending: true }],
    ])
  })
})

describe('overdueCutoff', () => {
  it('is the UTC date, matching the old `new Date(due_date) < now`', () => {
    // 01:30 in Cairo is still the previous day in UTC: a ticket due "today" in
    // Cairo was not yet overdue under the old rule, and must not be now.
    expect(overdueCutoff(new Date('2026-09-13T23:30:00Z'))).toBe('2026-09-13')
    expect(overdueCutoff(new Date('2026-09-14T00:00:01Z'))).toBe('2026-09-14')
  })
})

describe('resolveTicketSort', () => {
  it('falls back to newest first for an unknown column', () => {
    expect(resolveTicketSort({ column: 'products', ascending: true })).toEqual({
      column: 'created_date',
      ascending: false,
    })
  })
})

describe('rmaTickets.listColumn', () => {
  it('is the status plus the shared filters, newest first, first `limit` cards and a full count', async () => {
    responses = [{ data: [{ id: 'a' }, { id: 'b' }], error: null, count: 140 }]
    const col = await rmaTickets.listColumn('In Progress', { search: 'dell', priority: 'High' }, 50)
    expect(methodCalls('rpc')[0].slice(0, 2)).toEqual(['rma_tickets_matching', { p_term: 'dell' }])
    expect(methodCalls('eq')).toEqual([
      ['ticket_status', 'In Progress'],
      ['priority', 'High'],
    ])
    expect(methodCalls('order')[0]).toEqual(['created_date', { ascending: false, nullsFirst: false }])
    expect(methodCalls('range')).toEqual([[0, 49]])
    expect(col).toEqual({ data: [{ id: 'a' }, { id: 'b' }], count: 140 })
  })
})

describe('rmaTickets.listAllMatching', () => {
  it('reads every matching ticket in chunks until an empty one', async () => {
    const chunk = (n, start) => Array.from({ length: n }, (_, i) => ({ id: `t${start + i}` }))
    responses = [
      { data: chunk(1000, 0), error: null },
      { data: chunk(20, 1000), error: null },
      { data: [], error: null },
    ]
    const rows = await rmaTickets.listAllMatching({ status: 'Open' })
    expect(rows).toHaveLength(1020)
    expect(methodCalls('rpc').every(([fn, , opts]) => fn === 'rma_tickets_matching' && !opts?.count)).toBe(true)
  })
})

describe('filter options and the number preview', () => {
  it('returns statuses and technicians, empty when the database has none', async () => {
    responses = [{ data: { statuses: ['Open'], technicians: ['a@b.c'] }, error: null }]
    expect(await rmaTickets.filterOptions()).toEqual({ statuses: ['Open'], technicians: ['a@b.c'] })
    responses = [{ data: null, error: null }]
    expect(await rmaTickets.filterOptions()).toEqual({ statuses: [], technicians: [] })
  })

  it('asks the database for the next RMA number', async () => {
    responses = [{ data: 'RMA-14092026-0007', error: null }]
    expect(await rmaTickets.peekNextNumber()).toBe('RMA-14092026-0007')
    expect(methodCalls('rpc')).toEqual([['rma_peek_next_ticket_number', undefined, undefined]])
  })
})
