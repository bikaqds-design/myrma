/**
 * backupResilience.test.js — one bad table must not cost the whole backup.
 *
 * Written after a drill found that "Export Complete Backup" produced nothing at
 * all. The email_settings allowlist named smtp_host, smtp_port and smtp_secure,
 * none of which exist in the table; PostgREST rejected the select, readAll
 * threw, and exportAll abandoned every remaining table. The screen said
 * "Failed to export" and named neither the table nor the reason, so the
 * business had no backup and no way to find out why.
 *
 * Two properties are pinned here. The first is that a failing table degrades
 * the backup instead of destroying it. The second is that the degradation is
 * never silent — a partial backup that looks complete is more dangerous than
 * no backup, because it is trusted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const from = vi.fn()
const rpc = vi.fn()
vi.mock('../api/client.js', () => ({
  supabase: { from: (...a) => from(...a), rpc: (...a) => rpc(...a) },
}))

const { backup, BACKUP_TABLES } = await import('../api/backup.js')

/**
 * A stubbed PostgREST. `failures` maps a table to the error it should raise;
 * every other table returns one row.
 */
function stubTables({ failures = {}, missing = [] } = {}) {
  // document_sequences is read through a SECURITY DEFINER RPC, because the
  // table itself refuses client SELECT.
  rpc.mockImplementation(async (fn) => {
    if (failures[fn]) return { data: null, error: { message: failures[fn], code: '42883' } }
    return { data: [{ seq_type: 'invoice', last_value: 42, seq_year: 2026 }], error: null }
  })
  from.mockImplementation((table) => ({
    select: () => ({
      range: async () => {
        if (failures[table]) return { data: null, error: { message: failures[table], code: '42703' } }
        if (missing.includes(table)) return { data: null, error: { code: '42P01', message: 'no table' } }
        return { data: [{ id: `${table}-1` }], error: null }
      },
    }),
  }))
}

beforeEach(() => {
  from.mockReset()
  rpc.mockReset()
})

describe('when one table cannot be read', () => {
  it('still exports every other table', async () => {
    stubTables({ failures: { email_settings: 'column email_settings.smtp_host does not exist' } })
    const result = await backup.exportAll()

    // The exact regression: this used to throw and produce no file at all.
    expect(Object.keys(result.data).length).toBe(BACKUP_TABLES.length - 1)
    expect(result.data.products).toBeDefined()
    expect(result.data.customers).toBeDefined()
  })

  it('says plainly that the backup is not complete', async () => {
    stubTables({ failures: { email_settings: 'column does not exist' } })
    const result = await backup.exportAll()

    expect(result.complete).toBe(false)
    expect(result.failed_tables).toHaveLength(1)
    expect(result.failed_tables[0].table).toBe('email_settings')
    // The reason travels with the file, so a restore months later can tell why
    // a table is absent rather than guessing.
    expect(result.failed_tables[0].error).toContain('column does not exist')
  })

  it('leaves the failed table out of the data rather than writing it empty', async () => {
    stubTables({ failures: { customers: 'boom' } })
    const result = await backup.exportAll()
    // An empty array would restore as "this table legitimately has no rows".
    expect('customers' in result.data).toBe(false)
    expect(result.counts.customers).toBeUndefined()
  })

  it('keeps going when several tables fail', async () => {
    stubTables({ failures: { customers: 'a', products: 'b', invoices: 'c' } })
    const result = await backup.exportAll()
    expect(result.failed_tables.map((f) => f.table).sort()).toEqual([
      'customers',
      'invoices',
      'products',
    ])
    expect(result.complete).toBe(false)
    expect(Object.keys(result.data).length).toBe(BACKUP_TABLES.length - 3)
  })
})

describe('a healthy backup', () => {
  it('reports itself complete', async () => {
    stubTables()
    const result = await backup.exportAll()
    expect(result.complete).toBe(true)
    expect(result.failed_tables).toEqual([])
    expect(Object.keys(result.data).length).toBe(BACKUP_TABLES.length)
  })

  it('counts every row it wrote', async () => {
    stubTables()
    const result = await backup.exportAll()
    // One row per table, the counters included.
    expect(result.total_rows).toBe(BACKUP_TABLES.length)
  })

  /**
   * The gap the drill found. document_sequences refuses client SELECT, so a
   * plain read returned an empty array and the file quietly lacked the one
   * thing a restore cannot rebuild: where invoice numbering had reached.
   */
  it('exports the document counters through the RPC, not an empty select', async () => {
    stubTables()
    const result = await backup.exportAll()
    expect(result.data.document_sequences).toHaveLength(1)
    expect(result.data.document_sequences[0]).toMatchObject({ seq_type: 'invoice', last_value: 42 })
    // And it must not have been fetched as a table.
    expect(from.mock.calls.map((c) => c[0])).not.toContain('document_sequences')
  })
})

/**
 * A table that was never provisioned is a different thing from one that failed:
 * nothing is wrong, there is simply no such table in this deployment. Conflating
 * the two would either cry wolf on every backup or hide a real fault.
 */
describe('a table that does not exist in this deployment', () => {
  it('is skipped, not failed, and the backup stays complete', async () => {
    stubTables({ missing: ['whatsapp_templates'] })
    const result = await backup.exportAll()
    expect(result.skipped_tables).toContain('whatsapp_templates')
    expect(result.failed_tables).toEqual([])
    expect(result.complete).toBe(true)
  })
})

/**
 * The allowlist that caused the outage. It cannot be checked against the live
 * schema from here, but it CAN be checked for the shape of the mistake: naming
 * a column that the redaction list also calls a secret would mean exporting
 * something the allowlist exists to withhold.
 */
describe('the email_settings allowlist', () => {
  it('never names a column that is treated as a secret', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/api/backup.js', 'utf8')
    )
    const safe = source.match(/EMAIL_SETTINGS_SAFE_COLUMNS\s*=\s*\n?\s*'([^']+)'/)[1]
    const secrets = source.match(/EMAIL_SETTINGS_SECRET_FIELDS = \[([^\]]+)\]/)[1]
    const secretNames = [...secrets.matchAll(/'([^']+)'/g)].map((m) => m[1])
    const safeNames = safe.split(',').map((c) => c.trim())

    for (const secret of secretNames) {
      expect(safeNames).not.toContain(secret)
    }
  })
})
