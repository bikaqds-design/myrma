// @vitest-environment node
/**
 * moneyTablesProcedureOnly.test.js — the money and stock ledgers take no direct client writes.
 *
 * 20260850 (BUG-073) made payments, the three application tables and
 * warehouse_stock procedure-only, but left vendor_payments — the AP twin of
 * payments — with admin write policies and table grants. 20260872 closed it.
 * Production behaviour is checked by supabase/tests/authenticated_role_probes.sql;
 * this pins the migrations and that the app still only reads these tables.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const m850 = read('supabase/migrations/20260850_money_tables_procedure_only.sql')
const m872 = read('supabase/migrations/20260872_vendor_payments_procedure_only.sql')

const PROCEDURE_ONLY = [
  'payments', 'payment_applications', 'credit_note_applications',
  'vendor_payments', 'vendor_payment_applications', 'warehouse_stock',
]

describe('every money and stock ledger table is closed to client writes', () => {
  it.each(PROCEDURE_ONLY)('%s has its write grants revoked by a migration', (table) => {
    const revoked = [m850, m872].some((sql) => {
      const stmt = sql.match(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES\s+ON ([^;]+?)\s+FROM authenticated/)
      return stmt && stmt[1].split(',').map((s) => s.trim()).includes(`public.${table}`)
    })
    expect(revoked).toBe(true)
  })

  it('drops all three admin write policies on vendor_payments', () => {
    for (const op of ['insert', 'update', 'delete']) {
      expect(m872).toContain(`DROP POLICY IF EXISTS admin_${op}_vendor_payments ON public.vendor_payments;`)
    }
  })
})

describe('the app only reads these tables', () => {
  const files = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(js|jsx|ts|tsx)$/.test(e.name) && !p.includes(`${join('src', 'test')}`)) files.push(p)
    }
  }
  walk('src')

  it.each(PROCEDURE_ONLY)('no direct insert/update/delete/upsert on %s', (table) => {
    const pattern = new RegExp(String.raw`from\('${table}'\)\s*\.(insert|update|delete|upsert)\(`)
    const offenders = files.filter((f) => pattern.test(read(f)))
    expect(offenders).toEqual([])
  })
})
