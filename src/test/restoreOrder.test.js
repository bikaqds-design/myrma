/**
 * restoreOrder.test.js — keep the SQL restore-order check honest.
 *
 * supabase/manual/20260825_verify_restore_order.sql validates BACKUP_TABLES
 * against every foreign key the live database has. To do that it embeds the
 * manifest order as a VALUES list, because SQL cannot import a JS array.
 *
 * An embedded copy of a live list is exactly the pattern that produced several
 * findings in this review — a snapshot that was right when written and silently
 * wrong later. This test is the lock: change BACKUP_TABLES without regenerating
 * the SQL and it fails here, rather than the SQL quietly validating an order
 * the code no longer uses.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { BACKUP_TABLES } from '../api/backup.js'

const SQL_PATH = 'supabase/manual/20260825_verify_restore_order.sql'

/** The (ord, 'table') pairs from the VALUES list in the SQL file. */
function embeddedOrder() {
  const sql = readFileSync(SQL_PATH, 'utf8')
  const block = sql.slice(sql.indexOf('WITH manifest(ord, tbl) AS ('), sql.indexOf('),\nfk AS ('))
  return [...block.matchAll(/\(\s*(\d+),\s*'([a-z_]+)'\)/g)].map((m) => ({
    ord: Number(m[1]),
    tbl: m[2],
  }))
}

describe('restore order SQL', () => {
  const embedded = embeddedOrder()
  const manifest = BACKUP_TABLES.map((s) => s.table)

  it('embeds every table in the manifest, in the same order', () => {
    expect(embedded.map((e) => e.tbl)).toEqual(manifest)
  })

  it('numbers them 1..n with no gaps', () => {
    expect(embedded.map((e) => e.ord)).toEqual(manifest.map((_, i) => i + 1))
  })

  // If the extraction silently matched nothing, the two assertions above would
  // still pass on an empty manifest. They cannot both be empty in practice, but
  // a parser that can return nothing is a parser that can pass for the wrong
  // reason — the recurring failure this whole review kept running into.
  it('actually parsed something', () => {
    expect(embedded.length).toBeGreaterThan(40)
  })
})
