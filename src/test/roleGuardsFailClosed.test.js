// @vitest-environment node
/**
 * roleGuardsFailClosed.test.js — BUG-087: role guards must fail closed.
 *
 * rma_user_role() is NULL for a caller with no current role, and the helpers
 * used to pass that NULL on. In an RLS policy NULL means "no"; in plpgsql,
 * `IF NOT helper() THEN RAISE` is an IF on NULL and does not fire — so every
 * such guard let a suspended, expired or role-less caller straight through.
 *
 * The behaviour is proven against a real database in
 * supabase/tests/role_guards_fail_closed.sql. What this file guards is the
 * migration history: the defect comes back the moment a later migration
 * re-declares a helper, or copies an old function body, without the COALESCE.
 * So it reads every migration in order and checks the definition that wins.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

const DIR = 'supabase/migrations'
const FIX = '20260867_role_guards_fail_closed.sql'
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
const read = (f) => readFileSync(`${DIR}/${f}`, 'utf8')

/** The body of the LAST `CREATE OR REPLACE FUNCTION public.<name>()` across all migrations. */
function lastDefinition(name) {
  const re = new RegExp(
    // any dollar-quote tag ($$, $function$, $fn$…), so a later migration using
    // a different one is still the definition that wins
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\(\\s*\\)[\\s\\S]*?\\$(\\w*)\\$([\\s\\S]*?)\\$\\1\\$`,
    'gi'
  )
  let found = null
  for (const f of files) {
    for (const m of read(f).matchAll(re)) found = { file: f, body: m[2] }
  }
  return found
}

describe('the role helpers return false, never NULL', () => {
  it.each(['rma_is_staff', 'rma_is_admin', 'rma_is_manager_or_above', 'rma_can_handle_cash'])(
    '%s — its winning definition is wrapped in COALESCE(…, false)',
    (name) => {
      const def = lastDefinition(name)
      expect(def, `no definition of ${name} found`).not.toBeNull()
      expect(def.file >= FIX, `${name} was last defined by ${def.file}, before the fix`).toBe(true)
      expect(def.body.replace(/\s+/g, ' ')).toMatch(/^\s*SELECT COALESCE\(.*, false\)\s*$/)
    }
  )

  it('rma_user_role itself still returns NULL — a sentinel would widen `<> viewer` policies', () => {
    expect(read(FIX)).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.rma_user_role/i)
  })
})

describe('the direct role comparisons are wrapped', () => {
  const fix = read(FIX)

  it('rewrites all seven functions from their live bodies, refusing on a count mismatch', () => {
    for (const fn of [
      'cancel_sales_order',
      'convert_quotation_to_so',
      'crm_convert_lead',
      'adjust_part_quantity',
      'create_manufacturer_batch',
      'link_serial_to_rma_ticket',
      'move_rma_units',
    ]) {
      expect(fix).toContain(`('${fn}', 1)`)
    }
    expect(fix).toContain('pg_get_functiondef(v_fn.oid)')
    expect(fix).toMatch(/IF v_before <> v_fn\.expected THEN\s+RAISE EXCEPTION/)
  })

  it('refuses to finish while any SECURITY DEFINER function still has an unwrapped role guard', () => {
    expect(fix).toMatch(/p\.prosecdef[\s\S]{0,200}rma_user_role[\s\S]{0,200}Refusing to finish/)
  })

  it('no LATER migration adds a bare `IF NOT (… rma_user_role() …) THEN` guard', () => {
    const bare = /IF\s+NOT\s+\((?:[^;])*?rma_user_role\(\)(?:[^;])*?\)\s+THEN/i
    const offenders = files.filter((f) => f > FIX && bare.test(read(f)))
    expect(offenders).toEqual([])
  })
})

describe('the CI database job runs the SQL proof', () => {
  it('role_guards_fail_closed.sql is wired into ci.yml', () => {
    expect(readFileSync('.github/workflows/ci.yml', 'utf8')).toContain('supabase/tests/role_guards_fail_closed.sql')
  })
})
