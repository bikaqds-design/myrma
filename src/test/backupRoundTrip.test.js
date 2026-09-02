/**
 * backupRoundTrip.test.js — exercise the real export and restore logic.
 *
 * A true drill needs a signed-in session against the live project, which this
 * cannot have. What it can do is run the actual code in src/api/backup.js
 * against a stand-in PostgREST client, which is where the logic that would
 * break a real restore lives: the pagination loop, the chunked writes, the
 * foreign-key ordering, the legacy-format mapping, and what happens when a
 * write fails halfway.
 *
 * Each of those was a defect in the previous version — reads were unbounded and
 * silently truncated past PostgREST's row cap, writes went out as one request
 * per table, and a failure aborted the rest without saying what had already
 * landed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// A stand-in for the Supabase client. Records every call so the test can assert
// on how the module talked to the database, not merely on what it returned.
const state = {
  rows: {},          // table -> array of rows the "database" holds
  rpcs: [],          // names of SECURITY DEFINER functions called
  missing: new Set(), // tables that answer 42P01
  failWrites: new Set(),
  reads: [],         // { table, from, to }
  writes: [],        // { table, count }
}

vi.mock('../api/client.js', () => ({
  supabase: {
    // document_sequences refuses client SELECT, so the export reads the
    // counters through rma_document_counters(). Without this the fake database
    // has no such function and the table drops out of the backup.
    rpc(fn) {
      state.rpcs.push(fn)
      if (state.missing.has(fn)) {
        return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'no function' } })
      }
      return Promise.resolve({ data: state.rows[fn] || [], error: null })
    },
    from(table) {
      return {
        select(sel) {
          this._sel = sel
          return this
        },
        range(from, to) {
          state.reads.push({ table, from, to })
          if (state.missing.has(table)) {
            return Promise.resolve({ data: null, error: { code: '42P01', message: 'missing' } })
          }
          const all = state.rows[table] || []
          return Promise.resolve({ data: all.slice(from, to + 1), error: null })
        },
        upsert(rows) {
          state.writes.push({ table, count: rows.length })
          if (state.failWrites.has(table)) {
            return Promise.resolve({ error: { message: `write refused for ${table}` } })
          }
          return Promise.resolve({ error: null })
        },
      }
    },
  },
}))

const { backup, BACKUP_TABLES } = await import('../api/backup.js')

const manifest = BACKUP_TABLES.map((s) => s.table)
const restorable = BACKUP_TABLES.filter((s) => s.restore !== false).map((s) => s.table)

beforeEach(() => {
  state.rows = {}
  state.missing = new Set()
  state.failWrites = new Set()
  state.reads = []
  state.writes = []
  state.rpcs = []
})

describe('exportAll', () => {
  it('covers every table in the manifest', async () => {
    const out = await backup.exportAll()
    expect(Object.keys(out.data).sort()).toEqual([...manifest].sort())
    expect(out.tables).toEqual(manifest)
  })

  // The defect this replaced: one unbounded select per table. PostgREST caps
  // rows per response, so anything past the cap vanished with no error — a
  // backup that grew quietly less complete as the business did.
  it('pages through a table larger than one response', async () => {
    state.rows.customers = Array.from({ length: 2500 }, (_, i) => ({ id: i }))
    const out = await backup.exportAll()
    expect(out.data.customers).toHaveLength(2500)

    const customerReads = state.reads.filter((r) => r.table === 'customers')
    expect(customerReads).toHaveLength(3)
    expect(customerReads[0]).toMatchObject({ from: 0, to: 999 })
    expect(customerReads[2]).toMatchObject({ from: 2000, to: 2999 })
  })

  it('stops paging when a page comes back short', async () => {
    state.rows.brands = Array.from({ length: 10 }, (_, i) => ({ id: i }))
    await backup.exportAll()
    expect(state.reads.filter((r) => r.table === 'brands')).toHaveLength(1)
  })

  // A backup should not fail because one optional feature was never provisioned.
  it('records a missing table as skipped rather than throwing', async () => {
    state.missing.add('webhooks')
    const out = await backup.exportAll()
    expect(out.skipped_tables).toContain('webhooks')
    expect(out.data.webhooks).toBeUndefined()
  })

  it('reports counts and a total', async () => {
    state.rows.customers = [{ id: 1 }, { id: 2 }]
    state.rows.products = [{ id: 1 }]
    const out = await backup.exportAll()
    expect(out.counts.customers).toBe(2)
    expect(out.total_rows).toBe(3)
  })

  // H-6: api_key, smtp_password, smtp_user and webhook_secret must never leave
  // the server. The select is column-limited; this is the second line of it.
  it('never emits an email_settings secret', async () => {
    state.rows.email_settings = [
      { id: 1, provider: 'resend', api_key: 'sk-real', smtp_password: 'hunter2' },
    ]
    const out = await backup.exportAll()
    const serialized = JSON.stringify(out.data.email_settings)
    expect(serialized).not.toContain('sk-real')
    expect(serialized).not.toContain('hunter2')
    expect(serialized).toContain('REDACTED')
  })
})

describe('importAll', () => {
  const payload = (data) => ({ version: '2.0', data })

  it('rejects a file with no data', async () => {
    await expect(backup.importAll({})).rejects.toThrow('Invalid backup file')
  })

  // The property a restore into an empty database depends on: parents first.
  it('writes tables in manifest order', async () => {
    const data = {}
    for (const t of restorable) data[t] = [{ id: 1 }]
    await backup.importAll(payload(data))

    const written = state.writes.map((w) => w.table)
    const expectedOrder = restorable.filter((t) => written.includes(t))
    expect(written).toEqual(expectedOrder)
  })

  it('chunks large tables instead of sending one huge request', async () => {
    await backup.importAll(payload({ customers: Array.from({ length: 1200 }, (_, i) => ({ id: i })) }))
    const writes = state.writes.filter((w) => w.table === 'customers')
    expect(writes.map((w) => w.count)).toEqual([500, 500, 200])
  })

  it('skips empty tables entirely', async () => {
    await backup.importAll(payload({ customers: [], products: [{ id: 1 }] }))
    expect(state.writes.map((w) => w.table)).toEqual(['products'])
  })

  // Version 1.0 files keyed the payload by label rather than table name.
  it('restores a legacy 1.0 export', async () => {
    const out = await backup.importAll({
      version: '1.0',
      data: { tickets: [{ id: 1 }], comments: [{ id: 2 }], users: [{ id: 3 }] },
    })
    const written = state.writes.map((w) => w.table)
    expect(written).toContain('rma_tickets')
    expect(written).toContain('ticket_comments')
    expect(written).toContain('user_roles')
    expect(out.rowsRestored).toBe(3)
  })

  it('does not write the export-only tables, and says why', async () => {
    const out = await backup.importAll(
      payload({ notification_queue: [{ id: 1 }], email_settings: [{ id: 2 }] })
    )
    expect(state.writes).toHaveLength(0)
    const skipped = out.results.filter((r) => r.skipped)
    expect(skipped.map((r) => r.table).sort()).toEqual(['email_settings', 'notification_queue'])
    for (const r of skipped) expect(r.why).toBeTruthy()
  })

  // A restore that dies halfway has still written everything before the
  // failure. Reporting only "failed" invites a second restore on top of
  // half-written data.
  it('preserves what landed when a table fails', async () => {
    state.failWrites.add('customers')
    let caught
    try {
      await backup.importAll(payload({ brands: [{ id: 1 }], customers: [{ id: 2 }] }))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(caught.message).toContain('customers')
    expect(caught.summary.tablesRestored).toBe(1)
    expect(caught.summary.rowsRestored).toBe(1)
  })

  it('reports tables and rows restored on success', async () => {
    const out = await backup.importAll(payload({ brands: [{ id: 1 }], products: [{ id: 2 }, { id: 3 }] }))
    expect(out.success).toBe(true)
    expect(out.tablesRestored).toBe(2)
    expect(out.rowsRestored).toBe(3)
  })
})

describe('round trip', () => {
  // Export a populated database, restore the result, and confirm every
  // restorable table arrives with the row count it started with.
  it('exports and restores without losing rows', async () => {
    state.rows.brands = [{ id: 'b1' }, { id: 'b2' }]
    state.rows.customers = Array.from({ length: 1100 }, (_, i) => ({ id: `c${i}` }))
    state.rows.products = [{ id: 'p1' }]
    state.rows.notification_queue = [{ id: 'q1' }] // export-only

    const exported = await backup.exportAll()
    state.writes = []
    const restored = await backup.importAll(exported)

    const byTable = Object.fromEntries(
      state.writes.reduce((acc, w) => {
        acc.set(w.table, (acc.get(w.table) || 0) + w.count)
        return acc
      }, new Map())
    )
    expect(byTable.brands).toBe(2)
    expect(byTable.customers).toBe(1100)
    expect(byTable.products).toBe(1)
    expect(byTable.notification_queue).toBeUndefined()
    expect(restored.rowsRestored).toBe(1103)
  })
})
