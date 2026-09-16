// @vitest-environment node
/**
 * migrationDrift.test.js — BUG-014: the migration ledger must match the files.
 *
 * The comparison rules are pure (scripts/migration-drift.mjs), so they are
 * pinned here without a database. The live comparison runs in the
 * migration-drift workflow against production.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { versionOf, compareMigrations, formatReport } from '../../scripts/migration-drift.mjs'

describe('versionOf', () => {
  it('is everything before the first underscore', () => {
    expect(versionOf('20260866_transfer_units_ledger.sql')).toBe('20260866')
    expect(versionOf('20260524000001_features.sql')).toBe('20260524000001')
    expect(versionOf('00000000_baseline_schema.sql')).toBe('00000000')
  })

  it('has no version for a name that does not follow the convention', () => {
    expect(versionOf('fix_something.sql')).toBeNull()
    expect(versionOf('20260866.sql')).toBeNull()
  })
})

describe('compareMigrations', () => {
  const files = ['20260865_a.sql', '20260866_b.sql', '20260867_c.sql']

  it('reports no drift when every file is applied under its own version', () => {
    const r = compareMigrations(files, ['20260865', '20260866', '20260867'])
    expect(r.ok).toBe(true)
  })

  it('flags a file production has not recorded', () => {
    const r = compareMigrations(files, ['20260865', '20260866'])
    expect(r.ok).toBe(false)
    expect(r.unapplied).toEqual(['20260867_c.sql'])
  })

  it('flags the exact failure seen live: a row left under a generated timestamp', () => {
    // apply_migration recorded 20260866 as 20260916084108. That is BOTH a file
    // with no row and a row with no file, and must be reported as both.
    const r = compareMigrations(files, ['20260865', '20260916084108', '20260867'])
    expect(r.unapplied).toEqual(['20260866_b.sql'])
    expect(r.unknown).toEqual(['20260916084108'])
  })

  it('flags two files sharing a version — only one could ever be recorded', () => {
    const r = compareMigrations(['20260604_x.sql', '20260604_y.sql'], ['20260604'])
    expect(r.duplicates).toEqual([{ version: '20260604', files: ['20260604_x.sql', '20260604_y.sql'] }])
    expect(r.ok).toBe(false)
  })

  it('flags a badly named file and ignores non-SQL files', () => {
    const r = compareMigrations(['20260865_a.sql', 'notes.md', 'oops.sql'], ['20260865'])
    expect(r.unversioned).toEqual(['oops.sql'])
    expect(r.unapplied).toEqual([])
  })

  it('names every problem in the report', () => {
    const r = compareMigrations(files, ['20260865', '20260916084108'])
    const text = formatReport(r, { files: 3, applied: 2 })
    expect(text).toContain('NOT APPLIED  20260866_b.sql')
    expect(text).toContain('NOT APPLIED  20260867_c.sql')
    expect(text).toContain('NO FILE      20260916084108')
  })
})

describe('the repository itself', () => {
  it('has no duplicate or badly named migration files right now', () => {
    const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql'))
    const r = compareMigrations(files, files.map(versionOf).filter(Boolean))
    expect(r.duplicates).toEqual([])
    expect(r.unversioned).toEqual([])
  })
})

describe('the function CI reads', () => {
  const sql = readFileSync('supabase/migrations/20260868_applied_migration_versions.sql', 'utf8')

  it('returns one array — the 1 000-row Data API cap can never truncate it', () => {
    expect(sql).toMatch(/RETURNS text\[\]/)
    expect(sql).toContain('array_agg(m.version ORDER BY m.version)')
  })

  it('exposes versions only, and grants anon explicitly against the 20260841 default', () => {
    expect(sql).not.toMatch(/m\.(name|statements|created_by)/)
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.rma_applied_migration_versions() TO anon')
    expect(sql).toMatch(/has_function_privilege\('anon'[\s\S]{0,120}RAISE EXCEPTION/)
  })
})

describe('the workflow', () => {
  const wf = readFileSync('.github/workflows/migration-drift.yml', 'utf8')

  it('runs on main, daily and on demand — not on PRs, where new migrations are legitimately unapplied', () => {
    expect(wf).toMatch(/push:\s*\n\s*branches:\s*\[main\]/)
    expect(wf).toMatch(/schedule:/)
    expect(wf).toMatch(/workflow_dispatch:/)
    expect(wf).not.toMatch(/pull_request/)
  })

  it('runs the script with the integration tier’s existing secrets and no database password', () => {
    expect(wf).toContain('node scripts/migration-drift.mjs')
    expect(wf).toContain('secrets.VITE_SUPABASE_URL')
    expect(wf).toContain('secrets.VITE_SUPABASE_ANON_KEY')
    expect(wf).not.toMatch(/DB_PASSWORD|DATABASE_URL|SERVICE_ROLE/i)
  })
})
