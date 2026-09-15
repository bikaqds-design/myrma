/**
 * pipelinePaging.test.js — BUG-066, phase 5c: the Pipeline's list, Kanban,
 * graph, pivot and activity views.
 *
 * The screen used to load every deal in a pipeline (and every open activity on
 * them) and do everything in the browser, past the Data API's 1 000-row cap.
 * What is pinned here is the request each view now makes, and the arithmetic
 * that turns the database's grouped rows back into the numbers on screen:
 *
 *  - the search goes to rma_deals_matching with the pipeline; stage, rep and
 *    owner are column filters on top, and "open only" is the Activity view's;
 *  - each list column sorts by what it shows, and an unknown sort falls back to
 *    newest first;
 *  - a Kanban column asks for its own stage, newest first, with a count;
 *  - an export reads every row in board order;
 *  - bucket reads walk past the row cap and never narrow activity rows by status;
 *  - activities for many deals go out 100 ids at a time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
let responses = []

function builder(target, args) {
  const b = {}
  calls.push([target, 'call', ...args])
  for (const method of ['select', 'eq', 'in', 'is', 'order', 'range']) {
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

const { deals, applyDealFilters, resolveDealSort, DEAL_SORT_COLUMNS } = await import('../api/db/deals')
const { activities } = await import('../api/db/activities')
const { monthLabel, bucketTotals, stageTotals, stageActivityValues, activityTypeStats, groupBuckets } =
  await import('../lib/pipelineBuckets')

beforeEach(() => {
  calls.length = 0
  responses = []
})

const on = (target, method) => calls.filter((c) => c[0] === target && c[1] === method).map((c) => c.slice(2))

function recorder() {
  const seen = []
  const q = {}
  for (const m of ['eq', 'in']) {
    q[m] = (...args) => {
      seen.push([m, ...args])
      return q
    }
  }
  return { q, seen }
}

const PIPE = 'pipe-1'

describe('applyDealFilters', () => {
  it('adds nothing with no filters', () => {
    const r = recorder()
    applyDealFilters(r.q, {})
    expect(r.seen).toEqual([])
  })

  it('narrows by owner, stages, reps and open status', () => {
    const r = recorder()
    applyDealFilters(r.q, { ownerEmail: 'rep@x.com', stages: ['won'], reps: ['a@x.com'], openOnly: true })
    expect(r.seen).toEqual([
      ['eq', 'assigned_rep', 'rep@x.com'],
      ['in', 'stage', ['won']],
      ['in', 'assigned_rep', ['a@x.com']],
      ['eq', 'status', 'open'],
    ])
  })
})

describe('resolveDealSort', () => {
  it.each([
    ['title', 'title_sort'],
    ['customer_id', 'customer_sort'],
    ['stage', 'stage_order'],
    ['value', 'value_sort'],
    ['assigned_rep', 'assigned_rep'],
    ['created_at', 'created_at'],
  ])('the %s column sorts by %s', (key, column) => {
    expect(resolveDealSort({ key, direction: 'asc' })).toEqual({ column, ascending: true })
    expect(DEAL_SORT_COLUMNS[key]).toBe(column)
  })

  it('falls back to newest first for an unknown or missing sort', () => {
    expect(resolveDealSort({ key: 'nope', direction: 'asc' })).toEqual({ column: 'created_at', ascending: false })
    expect(resolveDealSort(undefined)).toEqual({ column: 'created_at', ascending: false })
  })
})

describe('deals.listPage', () => {
  it('searches through rma_deals_matching with an exact count, filters, sorts and ranges', async () => {
    responses = [{ data: [{ id: 'd1' }], error: null, count: 31 }]
    const result = await deals.listPage(
      { pipelineId: PIPE, search: '  acme ', stages: ['won'], reps: [], ownerEmail: null },
      { key: 'value', direction: 'desc' },
      2,
      25
    )
    expect(on('rma_deals_matching', 'call')).toEqual([[{ p_pipeline_id: PIPE, p_term: 'acme' }, { count: 'exact' }]])
    expect(on('rma_deals_matching', 'in')).toEqual([['stage', ['won']]])
    expect(on('rma_deals_matching', 'order')).toEqual([
      ['value_sort', { ascending: false, nullsFirst: false }],
      ['id', { ascending: true }],
    ])
    expect(on('rma_deals_matching', 'range')).toEqual([[25, 49]])
    expect(result.count).toBe(31)
    expect(result.totalPages).toBe(2)
  })

  it('an empty search sends an empty term, which matches the whole pipeline', async () => {
    await deals.listPage({ pipelineId: PIPE }, undefined, 1, 10)
    expect(on('rma_deals_matching', 'call')[0][0]).toEqual({ p_pipeline_id: PIPE, p_term: '' })
  })
})

describe('deals.listColumn', () => {
  it('reads one stage, newest first, with its count', async () => {
    responses = [{ data: [{ id: 'a' }, { id: 'b' }], error: null, count: 120 }]
    const col = await deals.listColumn('quote_sent', { pipelineId: PIPE, reps: ['r@x.com'] }, 50)
    expect(on('rma_deals_matching', 'eq')).toEqual([['stage', 'quote_sent']])
    expect(on('rma_deals_matching', 'in')).toEqual([['assigned_rep', ['r@x.com']]])
    expect(on('rma_deals_matching', 'order')).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: true }],
    ])
    expect(on('rma_deals_matching', 'range')).toEqual([[0, 49]])
    expect(col).toEqual({ data: [{ id: 'a' }, { id: 'b' }], count: 120 })
  })
})

describe('deals.listAllMatching', () => {
  it('reads every row in board order, in chunks until an empty one', async () => {
    const chunk = Array.from({ length: 1000 }, (_, i) => ({ id: `d${i}` }))
    responses = [
      { data: chunk, error: null },
      { data: [{ id: 'last' }], error: null },
      { data: [], error: null },
    ]
    const rows = await deals.listAllMatching({ pipelineId: PIPE })
    expect(rows).toHaveLength(1001)
    expect(on('rma_deals_matching', 'order').slice(0, 3)).toEqual([
      ['stage_order', { ascending: true, nullsFirst: false }],
      ['created_at', { ascending: false }],
      ['id', { ascending: true }],
    ])
    expect(on('rma_deals_matching', 'range')).toEqual([
      [0, 999],
      [1000, 1999],
      [1001, 2000],
    ])
  })
})

describe('deals.getMany', () => {
  it('reads v_deals_list 100 ids at a time and returns board order', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id${i}`)
    responses = [
      {
        data: [
          { id: 'id1', stage_order: 2, created_at: '2026-01-01' },
          { id: 'id0', stage_order: 1, created_at: '2026-01-01' },
        ],
        error: null,
      },
      { data: [{ id: 'id2', stage_order: 1, created_at: '2026-03-01' }], error: null },
    ]
    const rows = await deals.getMany(ids)
    const chunks = on('v_deals_list', 'in')
    expect(chunks.map((c) => c[1].length)).toEqual([100, 50])
    expect(rows.map((r) => r.id)).toEqual(['id2', 'id0', 'id1'])
  })
})

describe('bucket reads', () => {
  it('buckets pass the viewer time zone, filter on top, and return numbers', async () => {
    responses = [
      { data: [{ stage: 'won', status: 'won', deal_count: '3', value_sum: '1500.5' }], error: null },
      { data: [], error: null },
    ]
    const rows = await deals.buckets({ pipelineId: PIPE, search: 'x', stages: ['won'] })
    const [args] = on('rma_deal_buckets', 'call')[0]
    expect(args.p_pipeline_id).toBe(PIPE)
    expect(args.p_term).toBe('x')
    expect(typeof args.p_tz).toBe('string')
    // Two requests (the rows, then the empty chunk that ends the read), each filtered.
    expect(on('rma_deal_buckets', 'in')).toEqual([
      ['stage', ['won']],
      ['stage', ['won']],
    ])
    expect(rows).toEqual([{ stage: 'won', status: 'won', deal_count: 3, value_sum: 1500.5 }])
  })

  it('activity rows are never narrowed by deal status (they have none)', async () => {
    await deals.activityValues({ pipelineId: PIPE, openOnly: true })
    await deals.activityTypeCounts({ pipelineId: PIPE, openOnly: true })
    expect(on('rma_deal_activity_values', 'eq')).toEqual([])
    expect(on('rma_deal_activity_type_counts', 'eq')).toEqual([])
    const [args] = on('rma_deal_activity_values', 'call')[0]
    expect(new Date(args.p_today_end) >= new Date(args.p_now)).toBe(true)
  })

  it('countInPipeline is a head count, scoped to an owner', async () => {
    responses = [{ data: null, error: null, count: 56 }]
    expect(await deals.countInPipeline(PIPE, 'rep@x.com')).toBe(56)
    expect(on('deals', 'select')).toEqual([['id', { count: 'exact', head: true }]])
    expect(on('deals', 'eq')).toEqual([
      ['pipeline_id', PIPE],
      ['assigned_rep', 'rep@x.com'],
    ])
  })
})

describe('activities.listForRelated', () => {
  it('sends ids 100 at a time and reads each chunk in full', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `d${i}`)
    responses = [
      { data: [{ id: 'a1' }], error: null },
      { data: [], error: null },
      { data: [{ id: 'a2' }], error: null },
      { data: [], error: null },
      { data: [], error: null },
    ]
    const rows = await activities.listForRelated('deal', ids)
    // Each chunk is read until an empty response: rows then empty, rows then empty, empty.
    expect(on('activities', 'in').map((c) => c[1].length)).toEqual([100, 100, 100, 100, 1])
    expect(new Set(on('activities', 'in').map((c) => c[1][0]))).toEqual(new Set(['d0', 'd100', 'd200']))
    expect(rows.map((r) => r.id)).toEqual(['a1', 'a2'])
    expect(await activities.listForRelated('deal', [])).toEqual([])
  })
})

describe('pipelineBuckets', () => {
  const buckets = [
    { stage: 'new', assigned_rep: 'a', status: 'open', created_month: '2026-08', close_month: null, deal_count: 2, value_sum: 100 },
    { stage: 'won', assigned_rep: 'a', status: 'won', created_month: '2026-09', close_month: '2026-10', deal_count: 1, value_sum: 400 },
    { stage: 'new', assigned_rep: null, status: 'open', created_month: '2026-09', close_month: null, deal_count: 3, value_sum: 0 },
  ]

  it('monthLabel turns YYYY-MM into the short label, and nothing into null', () => {
    expect(monthLabel('2026-09')).toBe('Sep 2026')
    expect(monthLabel(null)).toBeNull()
    expect(monthLabel('garbage')).toBeNull()
  })

  it('bucketTotals sums counts and values, and the won part', () => {
    expect(bucketTotals(buckets)).toEqual({ count: 6, value: 500, wonCount: 1, wonValue: 400 })
  })

  it('stageTotals sums per stage', () => {
    expect(stageTotals(buckets)).toEqual({ new: { count: 5, value: 100 }, won: { count: 1, value: 400 } })
  })

  it('groupBuckets merges buckets with the same label', () => {
    expect(groupBuckets(buckets, (b) => monthLabel(b.created_month))).toEqual([
      { name: 'Aug 2026', count: 2, revenue: 100 },
      { name: 'Sep 2026', count: 4, revenue: 400 },
    ])
  })

  it('stageActivityValues sums value per state per stage', () => {
    expect(
      stageActivityValues([
        { stage: 'new', activity_state: 'overdue', value_sum: 10 },
        { stage: 'new', activity_state: 'overdue', value_sum: 5 },
        { stage: 'new', activity_state: 'planned', value_sum: 1 },
      ])
    ).toEqual({ new: { overdue: 15, today: 0, planned: 1 } })
  })

  it('activityTypeStats counts done and total for the listed types only', () => {
    expect(
      activityTypeStats(
        [
          { activity_type: 'call', activity_count: 4, done_count: 1 },
          { activity_type: 'call', activity_count: 2, done_count: 2 },
          { activity_type: 'log', activity_count: 9, done_count: 9 },
        ],
        ['call', 'meeting']
      )
    ).toEqual({ call: { done: 3, total: 6 }, meeting: { done: 0, total: 0 } })
  })
})
