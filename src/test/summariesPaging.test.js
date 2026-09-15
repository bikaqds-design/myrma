/**
 * summariesPaging.test.js — BUG-066, phases 5d/6: Dashboard, Reports,
 * Profitability, Customer/Product Details and the Control Panel.
 *
 * Those screens loaded whole tables and counted, summed and paged them in the
 * browser, past the Data API's 1 000-row cap. What is pinned here is the
 * browser half of the replacement: each helper asks the database the right
 * question (function, arguments, filters, order, row range) and hands back
 * numbers, and the few rules still applied on the page (margin rounding,
 * duplicate grouping, chunking long id lists) behave as the old code did.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
let responses = []

function builder(target, args) {
  const b = {}
  calls.push([target, 'call', ...args])
  for (const method of ['select', 'eq', 'neq', 'in', 'or', 'not', 'is', 'lt', 'gte', 'lte', 'order', 'range', 'maybeSingle', 'delete', 'update']) {
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

const { dashboard } = await import('../api/db/dashboard')
const { reports, reportRange } = await import('../api/db/reports')
const { margin, marginTotalsFromRaw, summariseMargin } = await import('../api/db/margin')
const { controlPanel, dataCleanup } = await import('../api/db/system')
const { deals } = await import('../api/db/deals')
const { customers } = await import('../api/db/customers')
const { products } = await import('../api/db/catalog')
const { rmaTickets } = await import('../api/db/tickets')
const { inventory } = await import('../api/db/inventory')
const { activities } = await import('../api/db/activities')
const { salesOrders } = await import('../api/db/salesOrders')

beforeEach(() => {
  calls.length = 0
  responses = []
})

const on = (target, method) => calls.filter((c) => c[0] === target && c[1] === method).map((c) => c.slice(2))
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

describe('dashboard', () => {
  it('ticketSummary sends the range start, now and the viewer’s time zone, and returns numbers', async () => {
    responses = [{
      data: {
        total: '13', resolved: 4, overdue: 9, tracked: 13,
        status_counts: [{ status: 'Open', count: '5' }, { status: 'Closed', count: 2 }],
        priority_counts: { Medium: '11' },
        technicians: [{ tech: null, total: 2, closed: 1 }],
        daily_created: { '2026-09-14': '3' },
        products: { received: '11', under_repair: 1, repaired: 1, cant_repair: 1, rma_stock: 1 },
        top_issues: [{ issue: 'No power', count: '2' }],
      },
      error: null,
    }]
    const now = new Date('2026-09-15T10:00:00Z')
    const s = await dashboard.ticketSummary('2026-08-16T00:00:00.000Z', now)
    expect(on('rma_dashboard_ticket_summary', 'call')).toEqual([[{ p_since: '2026-08-16T00:00:00.000Z', p_now: now.toISOString(), p_tz: tz() }]])
    expect(s.total).toBe(13)
    expect(s.status_counts).toEqual([{ status: 'Open', count: 5 }, { status: 'Closed', count: 2 }])
    expect(s.priority_counts).toEqual({ Medium: 11 })
    expect(s.technicians).toEqual([{ tech: null, total: 2, closed: 1 }])
    expect(s.daily_created).toEqual({ '2026-09-14': 3 })
    expect(s.products.received).toBe(11)
    expect(s.top_issues).toEqual([{ issue: 'No power', count: 2 }])
  })

  it('overdueTickets keeps tickets with no status, filters to unresolved past due, newest first, first N', async () => {
    await dashboard.overdueTickets('2026-08-16T00:00:00.000Z', 8, '2026-09-15')
    expect(on('rma_tickets', 'or')).toEqual([['ticket_status.is.null,ticket_status.not.in.("Completed","Closed","Cancelled")']])
    expect(on('rma_tickets', 'lt')).toEqual([['due_date', '2026-09-15']])
    expect(on('rma_tickets', 'gte')).toEqual([['created_date', '2026-08-16T00:00:00.000Z']])
    expect(on('rma_tickets', 'order')[0]).toEqual(['created_date', { ascending: false }])
    expect(on('rma_tickets', 'range')).toEqual([[0, 7]])
  })

  it('overdueTickets for "All" adds no created_date bound', async () => {
    await dashboard.overdueTickets(null, 8, '2026-09-15')
    expect(on('rma_tickets', 'gte')).toEqual([])
  })

  it('myOpenTickets counts and orders soonest due first, undated after, then newest', async () => {
    responses = [{ data: [{ id: 't1' }], error: null, count: 14 }]
    const res = await dashboard.myOpenTickets('tech@x.com', 6)
    expect(on('rma_tickets', 'eq')).toEqual([['assigned_technician', 'tech@x.com']])
    expect(on('rma_tickets', 'order')).toEqual([
      ['due_date', { ascending: true, nullsFirst: false }],
      ['created_date', { ascending: false }],
      ['id', { ascending: true }],
    ])
    expect(on('rma_tickets', 'range')).toEqual([[0, 5]])
    expect(res).toEqual({ data: [{ id: 't1' }], count: 14 })
  })

  it('crm returns numbers for every figure', async () => {
    responses = [{ data: { open_value: '1934779.09', open_count: 41, won_this_month: '0', leads_this_month: 2, open_by_stage: [{ stage: 'contacted', count: '13', value: '691846.65' }], won_by_rep: [] }, error: null }]
    const c = await dashboard.crm('2026-09-01T00:00:00.000Z')
    expect(on('rma_dashboard_crm', 'call')).toEqual([[{ p_month_start: '2026-09-01T00:00:00.000Z' }]])
    expect(c.open_value).toBe(1934779.09)
    expect(c.open_by_stage).toEqual([{ stage: 'contacted', count: 13, value: 691846.65 }])
  })

  it('inventory.getStats counts in the database instead of reading every unit', async () => {
    responses = [{ data: { active_rma: '17', company_stock: 424, sent_to_manufacturer: 0, closed: 0, total: '441' }, error: null }]
    expect(await inventory.getStats()).toEqual({ active_rma: 17, company_stock: 424, sent_to_manufacturer: 0, closed: 0, total: 441 })
    expect(on('inventory_units', 'select')).toEqual([])
  })

  it('activities.listOverdueFirst reads only the first N, oldest due first', async () => {
    const now = new Date('2026-09-15T10:00:00Z')
    await activities.listOverdueFirst(8, now)
    expect(on('activities', 'lt')).toEqual([['due_date', now.toISOString()]])
    expect(on('activities', 'order')[0]).toEqual(['due_date', { ascending: true }])
    expect(on('activities', 'range')).toEqual([[0, 7]])
  })
})

describe('reports', () => {
  it('reportRange is the local start of the first day to the local end of the last', () => {
    const { from, to } = reportRange('2026-09-01', '2026-09-15')
    const f = new Date(from)
    const t = new Date(to)
    expect([f.getHours(), f.getMinutes(), f.getSeconds(), f.getMilliseconds()]).toEqual([0, 0, 0, 0])
    expect([t.getHours(), t.getMinutes(), t.getSeconds(), t.getMilliseconds()]).toEqual([23, 59, 59, 999])
  })

  const range = { from: '2026-08-31T21:00:00.000Z', to: '2026-09-15T20:59:59.999Z' }

  it('ticketSummary passes the range and filters, blank filters as null', async () => {
    responses = [{ data: { total: 13, completed: 2, avg_resolution_hours: '93.25', completed_with_due: 2, sla_met: 1, overdue: 11, statuses: ['Open'], priorities: [], technicians: [] }, error: null }]
    const now = new Date('2026-09-15T10:00:00Z')
    const s = await reports.ticketSummary(range, { status: 'Open', priority: '', technician: undefined }, now)
    expect(on('rma_report_ticket_summary', 'call')).toEqual([[{
      p_from: range.from, p_to: range.to, p_status: 'Open', p_priority: null, p_technician: null, p_now: now.toISOString(),
    }]])
    expect(s.avg_resolution_hours).toBe(93.25)
    expect(s.statuses).toEqual(['Open'])
  })

  it('ticketSummary keeps "no average" as null, not 0', async () => {
    responses = [{ data: { total: 0, avg_resolution_hours: null }, error: null }]
    expect((await reports.ticketSummary(range)).avg_resolution_hours).toBeNull()
  })

  it('ticketsPage filters the range in the database and pages newest first', async () => {
    responses = [{ data: [{ id: 't' }], error: null, count: 30 }]
    const res = await reports.ticketsPage(range, { priority: 'High' }, 2, 25)
    expect(on('rma_tickets', 'gte')).toEqual([['created_date', range.from]])
    expect(on('rma_tickets', 'lte')).toEqual([['created_date', range.to]])
    expect(on('rma_tickets', 'eq')).toEqual([['priority', 'High']])
    expect(on('rma_tickets', 'range')).toEqual([[25, 49]])
    expect(res.count).toBe(30)
  })

  it('customersPage sorts by ticket count, then newest, then id', async () => {
    responses = [{ data: [{ id: 'c', total_tickets: '3', open_tickets: '1' }], error: null, count: 888 }]
    const res = await reports.customersPage(range, 1, 25)
    expect(on('rma_report_customers', 'call')).toEqual([[{ p_from: range.from, p_to: range.to }, { count: 'exact' }]])
    expect(on('rma_report_customers', 'order')).toEqual([
      ['total_tickets', { ascending: false }],
      ['created_date', { ascending: false, nullsFirst: false }],
      ['id', { ascending: true }],
    ])
    expect(res.data).toEqual([{ id: 'c', total_tickets: 3, open_tickets: 1 }])
  })

  it('technicians reads every row, most assigned first', async () => {
    responses = [{ data: [{ email: 'a@x', assigned: '13', completed: '2', avg_resolution_hours: null, hours_logged: '0.5' }], error: null }, { data: [], error: null }]
    expect(await reports.technicians(range)).toEqual([{ email: 'a@x', assigned: 13, completed: 2, avg_resolution_hours: null, hours_logged: 0.5 }])
    expect(on('rma_report_technicians', 'order')[0]).toEqual(['assigned', { ascending: false }])
  })

  it('pipeline and sales return numbers', async () => {
    responses = [{ data: { deal_groups: [{ pipeline_id: 'p', stage: 's', status: 'open', rep: null, count: '2', value: '10.5' }], open_age_days_sum: '40', won_cycle: { count: '1', days_sum: '9' }, lost_reasons: [{ reason: null, count: '1' }], lead_sources: [{ source: 'web', total: '3', converted: '1' }] }, error: null }]
    const p = await reports.pipeline(range, new Date('2026-09-15T10:00:00Z'))
    expect(p.deal_groups[0]).toEqual({ pipeline_id: 'p', stage: 's', status: 'open', rep: null, count: 2, value: 10.5 })
    expect(p.won_cycle).toEqual({ count: 1, days_sum: 9 })
    responses = [{ data: { quotations: { count: '38', value: '1', won: '31', lost: 3 }, invoiced: { count: 20, value: '303045.69' }, by_rep: [{ rep: 'r', raised: '5', won: 4, lost: 1, value: '1', won_value: '2' }] }, error: null }]
    const s = await reports.sales(range)
    expect(s.quotations).toEqual({ count: 38, value: 1, won: 31, lost: 3 })
    expect(s.invoiced).toEqual({ count: 20, value: 303045.69 })
    expect(s.collected).toEqual({ count: 0, value: 0 })
    expect(s.by_rep[0].won_value).toBe(2)
  })

  it('invoicesPage pages the report view by creation date', async () => {
    await reports.invoicesPage(range, 1, 10)
    expect(on('v_report_invoices', 'gte')).toEqual([['created_at', range.from]])
    expect(on('v_report_invoices', 'order')).toEqual([['created_at', { ascending: false }], ['id', { ascending: true }]])
  })
})

describe('profitability', () => {
  const costed = (rev, cogs) => ({ revenue_base: rev, cogs_base: cogs, cogs_complete: true, margin_base: rev - cogs })
  const uncosted = (rev) => ({ revenue_base: rev, cogs_base: null, cogs_complete: false, margin_base: null })

  it('marginTotalsFromRaw rounds exactly as summariseMargin does', () => {
    const rows = [costed(1000.005, 333.333), uncosted(100_000), costed(500, 800)]
    const raw = {
      invoices: 3,
      invoices_costed: 2,
      revenue_base: rows.reduce((a, r) => a + r.revenue_base, 0),
      costed_revenue_base: 1000.005 + 500,
      cogs_base: 333.333 + 800,
      margin_base: 1000.005 - 333.333 + (500 - 800),
    }
    expect(marginTotalsFromRaw(raw)).toEqual(summariseMargin(rows))
  })

  it('totals() is null when the margin views are missing', async () => {
    responses = [{ data: null, error: { code: '42P01' } }]
    expect(await margin.totals()).toBeNull()
  })

  it('byInvoicePage pages most recently posted first', async () => {
    await margin.byInvoicePage(3, 20)
    expect(on('v_invoice_margin', 'order')).toEqual([['posted_at', { ascending: false }], ['id', { ascending: true }]])
    expect(on('v_invoice_margin', 'range')).toEqual([[40, 59]])
  })
})

describe('customer and product details', () => {
  it('relatedTicketsPage pages the customer’s tickets newest first', async () => {
    await customers.relatedTicketsPage('c1', 2, 10)
    expect(on('rma_tickets', 'eq')).toEqual([['customer_id', 'c1']])
    expect(on('rma_tickets', 'range')).toEqual([[10, 19]])
  })

  it('relatedTicketCounts counts all and open in the database', async () => {
    responses = [{ count: 7, error: null }, { count: 3, error: null }]
    expect(await customers.relatedTicketCounts('c1')).toEqual({ total: 7, open: 3 })
    expect(on('rma_tickets', 'in')).toEqual([['ticket_status', ['Open', 'In Progress', 'On Hold']]])
  })

  it('activityPage pages v_customer_activity newest first with a stable tie-break', async () => {
    await customers.activityPage('c1', 1, 25)
    expect(on('v_customer_activity', 'order')).toEqual([
      ['event_at', { ascending: false }],
      ['event_type', { ascending: true }],
      ['ref_id', { ascending: true }],
    ])
  })

  it('deals.listPageForCustomer pages a customer’s deals', async () => {
    responses = [{ data: [], error: null, count: 4 }]
    expect((await deals.listPageForCustomer('c1', 1, 25)).count).toBe(4)
    expect(on('deals', 'eq')).toEqual([['customer_id', 'c1']])
  })

  it('products.relatedTicketsPage pages rma_product_tickets with a count', async () => {
    await products.relatedTicketsPage('p1', 1, 25)
    expect(on('rma_product_tickets', 'call')).toEqual([[{ p_product_id: 'p1' }, { count: 'exact' }]])
  })

  it('unit linking looks up only the typed names, trimmed and lower-cased, not the whole catalog', async () => {
    responses = [{ data: [{ id: 'p1', product_name: 'ASRock Z490' }], error: null }, { data: [], error: null }]
    const out = await inventory.listCatalogForUnitLinking([' ASRock Z490 ', 'asrock z490', '', null])
    expect(on('rma_products_by_name_keys', 'call')[0]).toEqual([{ p_keys: ['asrock z490'] }])
    expect(on('products', 'select')).toEqual([])
    expect(out).toEqual([{ id: 'p1', product_name: 'ASRock Z490' }])
  })
})

describe('control panel', () => {
  it('stats is one call and returns numbers', async () => {
    responses = [{ data: { open_tickets: '8', overdue: 11, customers: '888', users: 17, open_deals: 41, open_deal_value: '1934779.09', mis_staged: 0 }, error: null }]
    const s = await controlPanel.stats(new Date('2026-09-15T10:00:00Z'))
    expect(s).toEqual({ open_tickets: 8, overdue: 11, customers: 888, users: 17, open_deals: 41, open_deal_value: 1934779.09, mis_staged: 0 })
  })

  it('deals.stageCounts returns numbers per pipeline × stage', async () => {
    responses = [{ data: [{ pipeline_id: 'p', stage: 'won', deal_count: '11' }], error: null }, { data: [], error: null }]
    expect(await deals.stageCounts()).toEqual([{ pipeline_id: 'p', stage: 'won', deal_count: 11 }])
  })

  it('deals.idsOnStage matches a missing stage with IS NULL', async () => {
    responses = [{ data: [{ id: 'd1' }], error: null }, { data: [], error: null }]
    expect(await deals.idsOnStage('p', null)).toEqual(['d1'])
    expect(on('deals', 'is')[0]).toEqual(['stage', null])
    calls.length = 0
    await deals.idsOnStage('p', 'quote_sent')
    expect(on('deals', 'eq')).toContainEqual(['stage', 'quote_sent'])
  })

  it('dataCleanup.duplicateGroups groups consecutive rows by their key', async () => {
    responses = [{ data: [
      { group_key: 'acme', id: '1' }, { group_key: 'acme', id: '2' },
      { group_key: 'zeta', id: '3' }, { group_key: 'zeta', id: '4' }, { group_key: 'zeta', id: '5' },
    ], error: null }, { data: [], error: null }]
    const groups = await dataCleanup.duplicateGroups()
    expect(groups.map((g) => g.map((r) => r.id))).toEqual([['1', '2'], ['3', '4', '5']])
  })

  it('rmaTickets.bulkDelete deletes in chunks of 100', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `t${i}`)
    responses = [
      { data: ids.slice(0, 100).map((id) => ({ id })), error: null },
      { data: ids.slice(100, 200).map((id) => ({ id })), error: null },
      { data: ids.slice(200).map((id) => ({ id })), error: null },
    ]
    await rmaTickets.bulkDelete(ids)
    expect(on('rma_tickets', 'in').map((c) => c[1].length)).toEqual([100, 100, 50])
  })

  it('rmaTickets.staleIds reads every matching id before the cut-off', async () => {
    responses = [{ data: [{ id: 'a' }], error: null }, { data: [], error: null }]
    expect(await rmaTickets.staleIds('Completed', '2026-06-17T00:00:00.000Z')).toEqual(['a'])
    expect(on('rma_tickets', 'lt')[0]).toEqual(['updated_date', '2026-06-17T00:00:00.000Z'])
  })

  it('salesOrders.list asks for a long quotationIds list in chunks', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `q${i}`)
    await salesOrders.list({ quotationIds: ids })
    expect(on('sales_orders', 'in').map((c) => c[1].length).sort((a, b) => a - b)).toEqual([50, 100])
  })
})
