// @vitest-environment node
/**
 * inventoryUnitsClientWrites.test.js — BL-03 / I-03: nothing in the browser
 * writes inventory_units directly.
 *
 * Before 20260877 any signed-in non-viewer could INSERT a sellable unit and
 * UPDATE its status with no stock_moves row. The database now refuses both
 * (proven against a real database in supabase/tests/lock_inventory_unit_writes.sql).
 * What is pinned here is what that file cannot see: that no source file tries,
 * so a future change fails in CI instead of failing in front of a user, and that
 * the migration keeps the pieces that make the refusal hold.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync('supabase/migrations/20260877_lock_inventory_unit_writes.sql', 'utf8')

function sourceFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === 'test' || name === 'node_modules') continue
      out.push(...sourceFiles(path))
    } else if (/\.(js|jsx|ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
      out.push(path)
    }
  }
  return out
}

// Read once: re-reading the tree per test case is what made earlier guards flaky.
const files = sourceFiles('src').map((path) => ({ path, text: readFileSync(path, 'utf8') }))

/** Every `.from('inventory_units')` in src, with the chain that follows it. */
function chainsOnInventoryUnits() {
  const chains = []
  for (const { path, text } of files) {
    let at = text.indexOf("from('inventory_units')")
    while (at >= 0) {
      const next = text.indexOf('.from(', at + 1)
      const end = Math.min(next < 0 ? text.length : next, at + 400)
      chains.push({ path, chain: text.slice(at, end) })
      at = text.indexOf("from('inventory_units')", at + 1)
    }
  }
  return chains
}

describe('no browser path writes inventory_units', () => {
  const chains = chainsOnInventoryUnits()

  it('finds the reads it is meant to be scanning (guards against a vacuous pass)', () => {
    expect(chains.length).toBeGreaterThan(0)
  })

  it('has no insert, update, upsert or delete on the table', () => {
    const writes = chains.filter(({ chain }) => /\.(insert|update|upsert|delete)\(/.test(chain))
    expect(writes.map((w) => w.path)).toEqual([])
  })

  it('creates units through the RPC, and only through it', () => {
    const api = files.find((f) => f.path.replace(/\\/g, '/') === 'src/api/db/inventory.ts').text
    expect(api).toContain("supabase.rpc('rma_create_units_from_ticket'")
  })
})

describe('the migration keeps what makes the refusal hold', () => {
  it('drops the client INSERT policy and revokes the INSERT grant', () => {
    expect(migration).toContain('DROP POLICY IF EXISTS staff_write ON public.inventory_units')
    expect(migration).toMatch(/REVOKE INSERT, TRUNCATE ON public\.inventory_units FROM authenticated, anon/)
  })

  it('guards status as a ledger column', () => {
    expect(migration).toMatch(/c_guarded constant text\[\] := ARRAY\[\s*'status',/)
  })

  it('checks status against the four real values, and refuses NULL', () => {
    // NULL would pass a bare IN (...) and also drops the row out of the serial
    // unique index (status <> 'closed' is NULL), silently disabling it.
    expect(migration).toMatch(
      /CHECK \(status IS NOT NULL AND status IN \('active_rma', 'company_stock', 'sent_to_manufacturer', 'closed'\)\)/
    )
  })

  it('also guards the columns that move a unit, attach it, or decide which one a sale consumes', () => {
    for (const column of [
      'manufacturer_batch_id',
      'warehouse_id',
      'rma_ticket_id',
      'resolution_type',
      'resolved_date',
      'created_date',
    ]) {
      expect(migration).toContain(`'${column}'`)
    }
  })

  it('only lets RMA units into a manufacturer batch (the batch RPCs change status as the owner)', () => {
    expect(migration).toMatch(/status IS DISTINCT FROM 'active_rma' OR reservation_status IS DISTINCT FROM 'available'/)
  })

  it('caps the intake RPC, restricts it to the ticket creator/assignee/manager, and pins pg_temp last', () => {
    expect(migration).toContain('jsonb_array_length(p_units) > 200')
    expect(migration).toMatch(/v_creator = public\.rma_current_user_email\(\)/)
    expect(migration).toMatch(/rma_create_units_from_ticket[\s\S]{0,200}SET search_path TO 'public', 'pg_temp'/)
  })

  it('does not swallow every error into a per-unit failure', () => {
    // A timeout or deadlock must abort the call, not read as "3 units failed".
    expect(migration).not.toMatch(/EXCEPTION WHEN OTHERS THEN\s+v_failed/)
    expect(migration).toContain('EXCEPTION WHEN unique_violation')
  })

  it('the intake RPC forces the status and is NULL-safe about who may call it', () => {
    expect(migration).toContain("'active_rma', 'available'")
    // rma_user_role() is NULL for a role-less caller; a bare IF NOT on it would
    // not fire (BUG-087), so the guard must be wrapped in COALESCE.
    expect(migration).toMatch(/IF NOT COALESCE\(\(public\.rma_is_staff\(\) AND public\.rma_user_role\(\) <> 'viewer'\), false\)/)
  })

  it('writes a stock_moves receive row per created unit', () => {
    expect(migration).toMatch(/INSERT INTO public\.stock_moves[\s\S]{0,400}'receive'/)
  })
})
