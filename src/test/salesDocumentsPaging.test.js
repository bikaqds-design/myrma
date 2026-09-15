/**
 * salesDocumentsPaging.test.js — BUG-066, phase 5d: the Sales Documents list.
 *
 * The page loaded every quotation, sales order, invoice and credit note and
 * did the tabs, counts, search, filters, sort and paging in the browser, past
 * the Data API's 1 000-row cap. What is pinned is the request:
 *
 *  - Archive holds the archived documents; every other tab the active ones,
 *    optionally of one type;
 *  - a rep's own documents are those assigned to them OR raised by them;
 *  - search covers code, customer name and rep; each column sorts by what it
 *    shows, a missing customer last;
 *  - an export reads every matching row; the summary is one call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
let responses = []

function builder(target, args) {
  const b = {}
  calls.push([target, 'call', ...args])
  for (const method of ['select', 'eq', 'or', 'order', 'range']) {
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

const { salesDocuments, applySalesDocFilters, resolveSalesDocSort } = await import('../api/db/salesDocuments')

beforeEach(() => {
  calls.length = 0
  responses = []
})

const on = (target, method) => calls.filter((c) => c[0] === target && c[1] === method).map((c) => c.slice(2))

function recorder() {
  const seen = []
  const q = {}
  for (const m of ['eq', 'or']) {
    q[m] = (...args) => {
      seen.push([m, ...args])
      return q
    }
  }
  return { q, seen }
}

describe('applySalesDocFilters', () => {
  it.each([
    ['all', [['eq', 'archived', false]]],
    ['invoice', [['eq', 'archived', false], ['eq', 'doc_type', 'invoice']]],
    ['archive', [['eq', 'archived', true]]],
  ])('the %s tab', (tab, expected) => {
    const r = recorder()
    applySalesDocFilters(r.q, { tab })
    expect(r.seen).toEqual(expected)
  })

  it('scopes an owner to assigned-or-raised, then status, rep and a search over code, customer and rep', () => {
    const r = recorder()
    applySalesDocFilters(r.q, { tab: 'quotation', ownerEmail: 'rep@x.com', status: 'sent', rep: 'a@x.com', search: ' acme ' })
    expect(r.seen).toEqual([
      ['eq', 'archived', false],
      ['eq', 'doc_type', 'quotation'],
      ['or', 'assigned_rep.eq."rep@x.com",created_by.eq."rep@x.com"'],
      ['eq', 'doc_status', 'sent'],
      ['eq', 'assigned_rep', 'a@x.com'],
      ['or', 'doc_code.ilike."%acme%",customer_name.ilike."%acme%",assigned_rep.ilike."%acme%"'],
    ])
  })
})

describe('resolveSalesDocSort', () => {
  it.each([
    ['doc_code', 'doc_code_sort'],
    ['assigned_rep', 'rep_sort'],
    ['total', 'total_sort'],
    ['doc_status', 'doc_status'],
    ['doc_type', 'doc_type'],
    ['type_specific_date', 'type_specific_date'],
    ['created_at', 'created_at'],
  ])('%s sorts by %s', (key, column) => {
    expect(resolveSalesDocSort({ key, direction: 'asc' })).toEqual({ column, ascending: true, nullsFirst: true })
  })

  it('a missing customer sorts after every name', () => {
    expect(resolveSalesDocSort({ key: 'customer', direction: 'asc' })).toEqual({ column: 'customer_sort', ascending: true, nullsFirst: false })
    expect(resolveSalesDocSort({ key: 'customer', direction: 'desc' })).toEqual({ column: 'customer_sort', ascending: false, nullsFirst: true })
  })

  it('falls back to newest first', () => {
    expect(resolveSalesDocSort(undefined)).toEqual({ column: 'created_at', ascending: false, nullsFirst: false })
    expect(resolveSalesDocSort({ key: 'bogus', direction: 'asc' }).column).toBe('created_at')
  })
})

describe('salesDocuments reads', () => {
  it('listPage reads one page of v_sales_documents_list with a count and a stable order', async () => {
    responses = [{ data: [{ id: 'q1' }], error: null, count: 71 }]
    const res = await salesDocuments.listPage({ tab: 'archive' }, { key: 'total', direction: 'desc' }, 3, 25)
    expect(on('v_sales_documents_list', 'select')).toEqual([['*', { count: 'exact' }]])
    expect(on('v_sales_documents_list', 'order')).toEqual([
      ['total_sort', { ascending: false, nullsFirst: false }],
      ['doc_type', { ascending: true }],
      ['id', { ascending: true }],
    ])
    expect(on('v_sales_documents_list', 'range')).toEqual([[50, 74]])
    expect(res.count).toBe(71)
  })

  it('listAllMatching reads past the row cap', async () => {
    const chunk = Array.from({ length: 1000 }, (_, i) => ({ id: `d${i}` }))
    responses = [{ data: chunk, error: null }, { data: [{ id: 'x' }], error: null }, { data: [], error: null }]
    expect(await salesDocuments.listAllMatching({ tab: 'all' })).toHaveLength(1001)
  })

  it('summary is one call and returns numbers', async () => {
    responses = [{ data: { counts: { all: '30', quotation: 8, sales_order: 7, invoice: 10, credit_note: 5, archive: 71 }, statuses: ['sent'], reps: ['a@x.com'] }, error: null }]
    expect(await salesDocuments.summary('quotation', 'rep@x.com')).toEqual({
      counts: { all: 30, quotation: 8, sales_order: 7, invoice: 10, credit_note: 5, archive: 71 },
      statuses: ['sent'],
      reps: ['a@x.com'],
    })
    expect(on('rma_sales_document_summary', 'call')).toEqual([[{ p_tab: 'quotation', p_owner: 'rep@x.com' }]])
  })
})
