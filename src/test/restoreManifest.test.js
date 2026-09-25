/**
 * restoreManifest.test.js — Backup & Restore can restore what it backs up.
 *
 * The browser stages every restorable BACKUP_TABLES entry, and the server's
 * rma_restore_stage refuses any table missing from rma_restore_manifest();
 * rma_restore_apply then writes in the MANIFEST's order. Until 20260897 the
 * manifest had none of the line tables, deliveries or receipts, so a backup
 * taken since 20260883 could not be restored at all — and nothing noticed.
 *
 * Pinned: the manifest in the latest migration that defines it equals the
 * restorable BACKUP_TABLES, in the same order. Adding a table to one without
 * the other fails here.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { BACKUP_TABLES } from '../api/backup.js'

function latestManifest() {
  const files = readdirSync('supabase/migrations').filter((f) => /^\d{8}_.*\.sql$/.test(f)).sort()
  let found = null
  for (const f of files) {
    const sql = readFileSync(`supabase/migrations/${f}`, 'utf8')
    const at = sql.lastIndexOf('FUNCTION public.rma_restore_manifest()')
    if (at < 0) continue
    const arr = sql.slice(at).match(/SELECT ARRAY\[([\s\S]*?)\]::text\[\]/)
    if (arr) found = { file: f, tables: [...arr[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) }
  }
  return found
}

describe('restore manifest', () => {
  const manifest = latestManifest()
  const restorable = BACKUP_TABLES.filter((t) => t.restore !== false).map((t) => t.table)

  it('is defined by a migration', () => {
    expect(manifest?.tables.length).toBeGreaterThan(50)
  })

  it('lists exactly the restorable backup tables, in the same (parents-first) order', () => {
    expect(manifest.tables, `latest definition: ${manifest.file}`).toEqual(restorable)
  })
})
