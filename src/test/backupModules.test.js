/**
 * backupModules.test.js — the modules must account for the whole system.
 *
 * The screen used to offer three exports (products, customers, RMA tickets)
 * against sixty tables, and the two lists were maintained by hand and by
 * accident. Modules replace that, and the risk moves with them: a table added
 * to BACKUP_TABLES but to no module would be absent from every module export
 * while the screen still claimed to cover the system. Nothing would say so.
 *
 * So the partition is asserted, not assumed. Every table exactly once.
 *
 * The second property is the one that made the old buttons useless: a module
 * export must be the SAME file format as a complete backup. The per-entity
 * exports wrote a bare JSON array, the restore required a version+data
 * envelope, and no test compared them — so all three produced files that could
 * not be restored.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const from = vi.fn()
const rpc = vi.fn()
vi.mock('../api/client.js', () => ({
  supabase: { from: (...a) => from(...a), rpc: (...a) => rpc(...a) },
}))

const { backup, BACKUP_TABLES, BACKUP_MODULES } = await import('../api/backup.js')

const manifest = BACKUP_TABLES.map((s) => s.table)
const assigned = BACKUP_MODULES.flatMap((m) => m.tables)

function stubEverything() {
  rpc.mockImplementation(async () => ({ data: [{ seq_type: 'invoice', last_value: 1 }], error: null }))
  from.mockImplementation((table) => ({
    select: () => ({ range: async () => ({ data: [{ id: `${table}-1` }], error: null }) }),
  }))
}

beforeEach(() => {
  from.mockReset()
  rpc.mockReset()
  stubEverything()
})

describe('the modules partition the manifest', () => {
  it('covers every table in the manifest', () => {
    const missing = manifest.filter((t) => !assigned.includes(t))
    // Named rather than counted, so a failure says which table to go and place.
    expect(missing).toEqual([])
  })

  it('never places a table in two modules', () => {
    const seen = new Set()
    const twice = assigned.filter((t) => (seen.has(t) ? true : (seen.add(t), false)))
    expect(twice).toEqual([])
  })

  it('never names a table that is not in the manifest', () => {
    expect(assigned.filter((t) => !manifest.includes(t))).toEqual([])
  })

  it('accounts for all sixty tables exactly once', () => {
    expect(assigned).toHaveLength(manifest.length)
  })

  it('gives every module a stable id and at least one table', () => {
    for (const m of BACKUP_MODULES) {
      expect(m.id).toMatch(/^[a-z]+$/)
      expect(m.tables.length).toBeGreaterThan(0)
    }
    expect(new Set(BACKUP_MODULES.map((m) => m.id)).size).toBe(BACKUP_MODULES.length)
  })
})

describe('a module export', () => {
  it('is the same envelope a restore reads, not a bare array', async () => {
    const out = await backup.exportModule('crm')
    // The exact defect in the buttons this replaced: they returned an array,
    // and handleFileUpload rejects anything without version + data.
    expect(Array.isArray(out)).toBe(false)
    expect(out.version).toBe('2.0')
    expect(out.data).toBeTypeOf('object')
    expect(out.complete).toBe(true)
  })

  it('contains its own tables and nothing else', async () => {
    const out = await backup.exportModule('purchasing')
    const purchasing = BACKUP_MODULES.find((m) => m.id === 'purchasing').tables
    expect(Object.keys(out.data).sort()).toEqual([...purchasing].sort())
    expect(out.data.customers).toBeUndefined()
    expect(out.data.products).toBeUndefined()
  })

  it('says which module it holds, so a file is identifiable months later', async () => {
    expect((await backup.exportModule('inventory')).module).toBe('inventory')
    // A complete backup is not a module and must not claim to be one.
    expect((await backup.exportAll()).module).toBeNull()
  })

  it('keeps foreign-key order within the module', async () => {
    const out = await backup.exportModule('sales')
    const order = out.tables
    // Inherited from BACKUP_TABLES rather than restated, so this checks the
    // inheritance actually happened.
    const expected = manifest.filter((t) => order.includes(t))
    expect(order).toEqual(expected)
  })

  it('refuses an unknown module rather than exporting nothing', async () => {
    await expect(backup.exportModule('nope')).rejects.toThrow(/Unknown module/)
  })

  it('reads only the tables it needs', async () => {
    await backup.exportModule('rma')
    const read = from.mock.calls.map((c) => c[0])
    expect(read).toContain('rma_tickets')
    expect(read).not.toContain('customers')
    expect(read).not.toContain('invoices')
  })
})

describe('restoring a module file', () => {
  it('goes through the same path as a complete backup', async () => {
    const writes = []
    from.mockImplementation((table) => ({
      select: () => ({ range: async () => ({ data: [{ id: `${table}-1` }], error: null }) }),
      upsert: async (rows) => {
        writes.push({ table, count: rows.length })
        return { error: null }
      },
    }))

    const file = await backup.exportModule('catalogue')
    const summary = await backup.importAll(file)

    expect(summary.success).toBe(true)
    // Every catalogue table is restorable, so all of them should be written.
    const catalogue = BACKUP_MODULES.find((m) => m.id === 'catalogue').tables
    expect(writes.map((w) => w.table).sort()).toEqual([...catalogue].sort())
  })

  it('does not touch tables outside the file', async () => {
    const writes = []
    from.mockImplementation((table) => ({
      select: () => ({ range: async () => ({ data: [{ id: `${table}-1` }], error: null }) }),
      upsert: async () => {
        writes.push(table)
        return { error: null }
      },
    }))

    await backup.importAll(await backup.exportModule('rma'))
    expect(writes).not.toContain('customers')
    expect(writes).not.toContain('products')
  })
})
