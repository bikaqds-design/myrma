import { describe, it, expect, vi, beforeEach } from 'vitest'

// BUG-074: the automation rule actions ignored every write result, and the
// "create notification" action called .catch() on a Supabase query builder —
// which has `then` but no `catch` — so it threw before sending anything and
// the error was swallowed. This double behaves like the real builder: thenable,
// no catch.
const calls = []
const captured = []
let ticketRows = [{ id: 't1' }]

function builder(result, record) {
  const b = {
    update(v) { record.op = 'update'; record.values = v; return b },
    insert(v) { record.op = 'insert'; record.values = v; return b },
    eq() { return b },
    select(sel) { if (sel === 'config_value') return b; return b },
    single() { return b },
    // A request only goes out when the builder is awaited.
    then(resolve, reject) { record.sent = true; return Promise.resolve(result()).then(resolve, reject) },
  }
  return b
}

vi.mock('../api/client.js', () => ({
  supabase: {
    from(table) {
      const record = { table }
      calls.push(record)
      if (table === 'rma_config') {
        return builder(() => ({
          data: {
            config_value: [
              {
                name: 'r1',
                enabled: true,
                trigger: 'ticket_created',
                conditions: [],
                actions: [
                  { type: 'change_priority', value: 'High' },
                  { type: 'create_notification', value: 'hello', title: 'T' },
                ],
              },
            ],
          },
          error: null,
        }), record)
      }
      if (table === 'rma_tickets') return builder(() => ({ data: ticketRows, error: null }), record)
      return builder(() => ({ data: null, error: null }), record)
    },
  },
}))
vi.mock('../lib/sentry.js', () => ({ captureException: (e, ctx) => captured.push({ e, ctx }) }))

const { automationRules } = await import('../api/db/system.ts')

beforeEach(() => {
  calls.length = 0
  captured.length = 0
  ticketRows = [{ id: 't1' }]
})

describe('automation rule actions', () => {
  it('actually sends the notification insert', async () => {
    await automationRules.evaluate('ticket_created', { id: 't1' })
    const inserts = calls.filter((c) => c.table === 'notifications' && c.op === 'insert' && c.sent)
    expect(inserts).toHaveLength(1)
    expect(captured).toEqual([])
  })

  it('reports a ticket update that changed nothing instead of staying silent', async () => {
    ticketRows = []
    await automationRules.evaluate('ticket_created', { id: 't1' })
    expect(captured).toHaveLength(1)
    expect(captured[0].e.message).toMatch(/change_priority.*did not apply/)
  })
})
