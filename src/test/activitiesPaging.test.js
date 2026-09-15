/**
 * activitiesPaging.test.js — BUG-066, phase 5c: the Activities page, the Tech
 * Calendar, the sidebar badge and per-record histories.
 *
 * Each used to load whole tables (every planned and completed activity, every
 * lead, deal and ticket) past the Data API's 1 000-row cap. What is pinned is
 * the request each now makes:
 *
 *  - the tabs mean what the in-browser partition meant: planned = open, dated,
 *    not a log; today / overdue compare the due date's UTC day with today's;
 *    logs = completed, not a log;
 *  - each column sorts by what it shows; a missing customer sorts last;
 *  - the badge is a head count; the calendar asks for one week, one person;
 *  - a record's history and a ticket's comments are read in full.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
let responses = []

function builder(target, args) {
  const b = {}
  calls.push([target, 'call', ...args])
  for (const method of ['select', 'eq', 'neq', 'in', 'is', 'not', 'gte', 'lte', 'lt', 'or', 'order', 'range']) {
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

const { activities, applyActivityFilters, resolveActivitySort, utcDayBounds } = await import('../api/db/activities')
const { rmaTickets, ticketComments } = await import('../api/db/tickets')

beforeEach(() => {
  calls.length = 0
  responses = []
})

const on = (target, method) => calls.filter((c) => c[0] === target && c[1] === method).map((c) => c.slice(2))

function recorder() {
  const seen = []
  const q = {}
  for (const m of ['eq', 'neq', 'is', 'not', 'gte', 'lt', 'or']) {
    q[m] = (...args) => {
      seen.push([m, ...args])
      return q
    }
  }
  return { q, seen }
}

// 01:30 in Cairo on 15 Sep is still 14 Sep in UTC — the page has always used the UTC day.
const NOW = new Date('2026-09-14T22:30:00Z')

describe('utcDayBounds', () => {
  it('is midnight UTC today and tomorrow', () => {
    expect(utcDayBounds(NOW)).toEqual({ start: '2026-09-14T00:00:00.000Z', end: '2026-09-15T00:00:00.000Z' })
  })
})

describe('applyActivityFilters', () => {
  const PLANNED = [
    ['neq', 'type', 'log'],
    ['is', 'completed_at', null],
    ['not', 'due_date', 'is', null],
  ]

  it.each([
    ['all', PLANNED],
    ['today', [...PLANNED, ['gte', 'due_date', '2026-09-14T00:00:00.000Z'], ['lt', 'due_date', '2026-09-15T00:00:00.000Z']]],
    ['overdue', [...PLANNED, ['lt', 'due_date', '2026-09-14T00:00:00.000Z']]],
    ['logs', [['neq', 'type', 'log'], ['not', 'completed_at', 'is', null]]],
  ])('the %s tab filters as the in-browser partition did', (tab, expected) => {
    const r = recorder()
    applyActivityFilters(r.q, { tab }, NOW)
    expect(r.seen).toEqual(expected)
  })

  it('narrows by owner, type, assignee and source, and searches the four shown columns', () => {
    const r = recorder()
    applyActivityFilters(r.q, { tab: 'all', ownerEmail: 'rep@x.com', type: 'call', assignee: 'a@x.com', source: 'quotation', search: ' qt-1 ' }, NOW)
    expect(r.seen.slice(3)).toEqual([
      ['eq', 'assigned_rep', 'rep@x.com'],
      ['eq', 'type', 'call'],
      ['eq', 'assigned_rep', 'a@x.com'],
      ['eq', 'source', 'quotation'],
      ['or', 'title.ilike."%qt-1%",customer_name.ilike."%qt-1%",assigned_rep.ilike."%qt-1%",source_code.ilike."%qt-1%"'],
    ])
  })
})

describe('resolveActivitySort', () => {
  it('sorts the date column by due date, or completion date on the logs tab', () => {
    expect(resolveActivitySort({ key: 'due_date', direction: 'desc' }, 'all')).toEqual({ column: 'due_date', ascending: false, nullsFirst: false })
    expect(resolveActivitySort({ key: 'due_date', direction: 'asc' }, 'logs')).toEqual({ column: 'completed_at', ascending: true, nullsFirst: true })
  })

  it('sorts customer and title case-insensitively; a missing customer sorts last', () => {
    expect(resolveActivitySort({ key: 'customer', direction: 'asc' })).toEqual({ column: 'customer_sort', ascending: true, nullsFirst: false })
    expect(resolveActivitySort({ key: 'title', direction: 'asc' })).toEqual({ column: 'title_sort', ascending: true, nullsFirst: true })
  })

  it('falls back to due date ascending', () => {
    expect(resolveActivitySort(undefined, 'today')).toEqual({ column: 'due_date', ascending: true, nullsFirst: true })
    expect(resolveActivitySort({ key: 'bogus', direction: 'desc' }, 'all').column).toBe('due_date')
  })
})

describe('activities.listPage / tabCounts / countOverdue', () => {
  it('reads one page of v_activities_list with an exact count', async () => {
    responses = [{ data: [{ id: 'a1' }], error: null, count: 40 }]
    const result = await activities.listPage({ tab: 'overdue' }, { key: 'assigned_rep', direction: 'asc' }, 2, 25, NOW)
    expect(on('v_activities_list', 'select')).toEqual([['*', { count: 'exact' }]])
    expect(on('v_activities_list', 'lt')).toEqual([['due_date', '2026-09-14T00:00:00.000Z']])
    expect(on('v_activities_list', 'order')).toEqual([
      ['assigned_rep', { ascending: true, nullsFirst: true }],
      ['id', { ascending: true }],
    ])
    expect(on('v_activities_list', 'range')).toEqual([[25, 49]])
    expect(result.count).toBe(40)
  })

  it('counts each tab with a head request, scoped to an owner', async () => {
    responses = [
      { data: null, error: null, count: 6 },
      { data: null, error: null, count: 1 },
      { data: null, error: null, count: 3 },
      { data: null, error: null, count: 46 },
    ]
    expect(await activities.tabCounts('rep@x.com', NOW)).toEqual({ all: 6, today: 1, overdue: 3, logs: 46 })
    expect(on('activities', 'select')).toHaveLength(4)
    expect(on('activities', 'select')[0]).toEqual(['id', { count: 'exact', head: true }])
    expect(on('activities', 'eq').every((c) => c[0] === 'assigned_rep' && c[1] === 'rep@x.com')).toBe(true)
  })

  it('the badge is a head count of open activities past due', async () => {
    responses = [{ data: null, error: null, count: 7 }]
    expect(await activities.countOverdue(NOW)).toBe(7)
    expect(on('activities', 'select')).toEqual([['id', { count: 'exact', head: true }]])
    expect(on('activities', 'lt')).toEqual([['due_date', NOW.toISOString()]])
    expect(on('activities', 'is')).toEqual([['completed_at', null]])
  })

  it('asks for the assignees of planned or completed work', async () => {
    responses = [{ data: ['a@x.com'], error: null }]
    expect(await activities.assignees(true, null)).toEqual(['a@x.com'])
    expect(on('rma_activity_assignees', 'call')).toEqual([[{ p_completed: true, p_owner: null }]])
  })
})

describe('whole histories are read past the row cap', () => {
  it('activities.list walks every chunk of one record', async () => {
    const chunk = Array.from({ length: 1000 }, (_, i) => ({ id: `a${i}` }))
    responses = [{ data: chunk, error: null }, { data: [{ id: 'last' }], error: null }, { data: [], error: null }]
    const rows = await activities.list('deal', 'd1')
    expect(rows).toHaveLength(1001)
    expect(on('activities', 'eq').slice(0, 2)).toEqual([
      ['related_type', 'deal'],
      ['related_id', 'd1'],
    ])
  })

  it('ticketComments.list reads in full and still reports a missing table', async () => {
    responses = [{ data: [{ id: 'c1' }], error: null }, { data: [], error: null }]
    expect(await ticketComments.list('t1')).toEqual({ missing: false, data: [{ id: 'c1' }] })
    responses = [{ data: null, error: { code: '42P01', message: 'missing' } }]
    expect(await ticketComments.list('t1')).toEqual({ missing: true, data: [] })
  })
})

describe('Tech Calendar week reads', () => {
  it('planned activities: one week, one person, open, not logs', async () => {
    await activities.listPlannedBetween('2026-09-13T00:00:00.000Z', '2026-09-20T00:00:00.000Z', 'rep@x.com')
    expect(on('activities', 'is')).toEqual([['completed_at', null]])
    expect(on('activities', 'neq')).toEqual([['type', 'log']])
    expect(on('activities', 'gte')).toEqual([['due_date', '2026-09-13T00:00:00.000Z']])
    expect(on('activities', 'lt')).toEqual([['due_date', '2026-09-20T00:00:00.000Z']])
    expect(on('activities', 'eq')).toEqual([['assigned_rep', 'rep@x.com']])
  })

  it('tickets due in the week, inclusive, for all technicians when none is chosen', async () => {
    await rmaTickets.listDueBetween('2026-09-13', '2026-09-19', null)
    expect(on('rma_tickets', 'gte')).toEqual([['due_date', '2026-09-13']])
    expect(on('rma_tickets', 'lte')).toEqual([['due_date', '2026-09-19']])
    expect(on('rma_tickets', 'eq')).toEqual([])
  })

  it('unscheduled tickets: no due date, not completed or cancelled, newest first with a count', async () => {
    responses = [{ data: [{ id: 't1' }], error: null, count: 75 }]
    expect(await rmaTickets.listUnscheduled('tech@x.com', 60)).toEqual({ data: [{ id: 't1' }], count: 75 })
    expect(on('rma_tickets', 'is')).toEqual([['due_date', null]])
    expect(on('rma_tickets', 'not')).toEqual([['ticket_status', 'in', '("Completed","Cancelled")']])
    expect(on('rma_tickets', 'eq')).toEqual([['assigned_technician', 'tech@x.com']])
    expect(on('rma_tickets', 'range')).toEqual([[0, 59]])
  })
})
