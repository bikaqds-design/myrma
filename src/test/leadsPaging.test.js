/**
 * leadsPaging.test.js — BUG-066, phase 5c: the Leads list, its tabs and its Kanban.
 *
 * The screen used to load every lead and filter, sort and page in the browser,
 * past the Data API's 1 000-row cap. What is pinned is the request:
 *
 *  - each tab means what the in-browser partition meant — `active` is anything
 *    not converted or disqualified, including a lead with no status;
 *  - the Name column sorts by the name shown (sort_name), and an unknown sort
 *    falls back to newest first;
 *  - the first Kanban column also collects leads whose status is not a known
 *    one, as the grouped board did;
 *  - tab counts respect a rep's own-leads scope.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
let responses = []

function builder(target) {
  const b = {}
  for (const method of ['select', 'eq', 'in', 'or', 'not', 'order', 'range']) {
    b[method] = (...args) => {
      calls.push([target, method, ...args])
      return b
    }
  }
  b.then = (resolve, reject) =>
    Promise.resolve(responses.shift() ?? { data: [], error: null, count: 0 }).then(resolve, reject)
  return b
}

vi.mock('../api/client.js', () => ({
  supabase: { from: (table) => builder(table), rpc: (fn) => builder(fn) },
}))

const { leads, applyLeadFilters, resolveLeadSort } = await import('../api/db/leads')
const { LEAD_STATUS_LIST } = await import('../lib/constants')

beforeEach(() => {
  calls.length = 0
  responses = []
})

const on = (target, method) => calls.filter((c) => c[0] === target && c[1] === method).map((c) => c.slice(2))

function recorder() {
  const seen = []
  const q = {}
  for (const m of ['or', 'eq', 'in', 'not']) {
    q[m] = (...args) => {
      seen.push([m, ...args])
      return q
    }
  }
  return { q, seen }
}

describe('applyLeadFilters', () => {
  it.each([
    ['all', []],
    ['converted', [['eq', 'status', 'converted']]],
    ['disqualified', [['eq', 'status', 'disqualified']]],
    ['active', [['or', 'status.is.null,status.not.in.(converted,disqualified)']]],
  ])('the %s tab filters as the in-browser partition did', (tab, expected) => {
    const r = recorder()
    applyLeadFilters(r.q, { tab })
    expect(r.seen).toEqual(expected)
  })

  it('narrows by owner, status, source and rep, and searches the five text columns', () => {
    const r = recorder()
    applyLeadFilters(r.q, {
      ownerEmail: 'rep@x.com',
      statuses: ['new'],
      sources: ['phone'],
      reps: ['a@x.com'],
      search: 'acme',
    })
    expect(r.seen.slice(0, 4)).toEqual([
      ['eq', 'assigned_rep', 'rep@x.com'],
      ['in', 'status', ['new']],
      ['in', 'source', ['phone']],
      ['in', 'assigned_rep', ['a@x.com']],
    ])
    const [, filter] = r.seen[4]
    for (const column of ['full_name', 'company_name', 'email', 'phone', 'lead_code']) {
      expect(filter).toContain(`${column}.ilike."%acme%"`)
    }
  })
})

describe('resolveLeadSort', () => {
  it('sorts the Name column by the name shown', () => {
    expect(resolveLeadSort({ key: 'full_name', direction: 'asc' })).toEqual({ column: 'sort_name', ascending: true })
  })

  it('falls back to newest first for a column it does not know', () => {
    expect(resolveLeadSort({ key: 'notes', direction: 'asc' })).toEqual({ column: 'created_at', ascending: false })
  })
})

describe('leads.listPage', () => {
  it('reads the list view a page at a time, id last', async () => {
    await leads.listPage({ tab: 'all' }, { key: 'created_at', direction: 'desc' }, 3, 25)
    expect(on('v_leads_list', 'order')).toEqual([
      ['created_at', { ascending: false, nullsFirst: false }],
      ['id', { ascending: true }],
    ])
    expect(on('v_leads_list', 'range')).toEqual([[50, 74]])
  })
})

describe('leads.listColumn', () => {
  it('puts leads with an unknown status in the first column', async () => {
    await leads.listColumn(LEAD_STATUS_LIST[0], LEAD_STATUS_LIST, { tab: 'all' }, undefined, 50)
    const [filter] = on('v_leads_list', 'or')[0]
    expect(filter).toContain(`status.eq.${LEAD_STATUS_LIST[0]}`)
    expect(filter).toContain('status.is.null')
    expect(filter).toContain('status.not.in.("new","contacted"')
  })

  it('reads any other column by its status only', async () => {
    await leads.listColumn('qualified', LEAD_STATUS_LIST, { tab: 'all' }, undefined, 50)
    expect(on('v_leads_list', 'eq')).toEqual([['status', 'qualified']])
    expect(on('v_leads_list', 'range')).toEqual([[0, 49]])
  })
})

describe('leads.tabCounts', () => {
  it('counts each tab without reading rows, within a rep scope', async () => {
    responses = [
      { data: null, error: null, count: 10 },
      { data: null, error: null, count: 7 },
      { data: null, error: null, count: 2 },
      { data: null, error: null, count: 1 },
    ]
    const counts = await leads.tabCounts('rep@x.com')
    expect(counts).toEqual({ all: 10, active: 7, converted: 2, disqualified: 1 })
    expect(on('leads', 'select')).toEqual(Array(4).fill(['id', { count: 'exact', head: true }]))
    expect(on('leads', 'eq').filter(([col]) => col === 'assigned_rep')).toHaveLength(4)
  })
})
