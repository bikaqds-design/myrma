/**
 * margin.test.js — profit is never claimed for a sale nobody can cost.
 *
 * This is the rule every earlier stage was built to make possible. Stages 1-3
 * went to real trouble to keep "unknown cost" distinct from "zero cost";
 * summarising them back together with a `|| 0` would undo all of it in one
 * character.
 *
 * The failure is not loud. An invoice for E£100,000 of goods whose cost was
 * never recorded reports E£100,000 of margin — a perfect sale, indistinguishable
 * from a genuinely excellent one, and enough to carry a rep's whole quarter.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { summariseMargin } from '../api/db/margin.ts'

const SQL = readFileSync('supabase/migrations/20260798_margin_reporting.sql', 'utf8')

/** A costed invoice. */
const costed = (revenue, cogs) => ({
  revenue_base: revenue,
  cogs_base: cogs,
  cogs_unknown_qty: 0,
  cogs_complete: true,
  margin_base: revenue - cogs,
})

/** One shipped with units whose cost was never recorded. */
const uncosted = (revenue, unknownUnits = 1) => ({
  revenue_base: revenue,
  cogs_base: null,
  cogs_unknown_qty: unknownUnits,
  cogs_complete: false,
  margin_base: null,
})

describe('summariseMargin', () => {
  it('is all zeros and no percentage on an empty set', () => {
    const s = summariseMargin([])
    expect(s.invoices).toBe(0)
    expect(s.marginBase).toBe(0)
    // Not 0%: with nothing to measure there is no rate, and 0% would read as
    // "we sold at cost".
    expect(s.marginPct).toBeNull()
  })

  it('computes margin on a fully costed set', () => {
    const s = summariseMargin([costed(1000, 600), costed(500, 300)])
    expect(s.revenueBase).toBe(1500)
    expect(s.costedRevenueBase).toBe(1500)
    expect(s.cogsBase).toBe(900)
    expect(s.marginBase).toBe(600)
    expect(s.marginPct).toBe(40)
  })

  // The one that matters. Without it the uncosted sale is pure profit.
  it('excludes an uncosted invoice from margin entirely', () => {
    const s = summariseMargin([costed(1000, 600), uncosted(100_000)])
    expect(s.revenueBase).toBe(101_000)
    expect(s.costedRevenueBase).toBe(1000) // the uncosted sale is not in here
    expect(s.marginBase).toBe(400) // and contributes nothing to profit
    expect(s.marginPct).toBe(40) // measured against 1,000, not 101,000
  })

  it('counts the uncosted invoices so the gap is reportable', () => {
    const s = summariseMargin([costed(1000, 600), uncosted(100_000), uncosted(50)])
    expect(s.invoices).toBe(3)
    expect(s.invoicesCosted).toBe(1)
    expect(s.invoicesCostUnknown).toBe(2)
    // The revenue that cannot be costed is recoverable as the difference.
    expect(s.revenueBase - s.costedRevenueBase).toBe(100_050)
  })

  it('reports no margin percentage when nothing can be costed', () => {
    const s = summariseMargin([uncosted(5000), uncosted(3000)])
    expect(s.revenueBase).toBe(8000)
    expect(s.costedRevenueBase).toBe(0)
    expect(s.marginBase).toBe(0)
    // NOT 0% — that would say these sales made no profit, when the truth is
    // that nobody knows what they made.
    expect(s.marginPct).toBeNull()
  })

  // Defence against a `|| 0` creeping in: a row that claims completeness but
  // carries a null margin must still be treated as uncostable.
  it('ignores a row that claims completeness but has no margin', () => {
    const contradictory = {
      revenue_base: 900,
      cogs_base: null,
      cogs_unknown_qty: 0,
      cogs_complete: true,
      margin_base: null,
    }
    const s = summariseMargin([costed(1000, 600), contradictory])
    expect(s.costedRevenueBase).toBe(1000)
    expect(s.marginBase).toBe(400)
    expect(s.invoicesCostUnknown).toBe(1)
  })

  it('handles a genuine loss without treating it as missing data', () => {
    // Sold below cost. That is a real negative margin, not an unknown.
    const s = summariseMargin([costed(500, 800)])
    expect(s.marginBase).toBe(-300)
    expect(s.marginPct).toBe(-60)
  })

  it('reports no percentage on a costed invoice with no revenue', () => {
    const s = summariseMargin([costed(0, 0)])
    expect(s.costedRevenueBase).toBe(0)
    expect(s.marginPct).toBeNull()
  })

  it('rounds money to two places and the rate to two', () => {
    const s = summariseMargin([costed(1000.005, 333.333)])
    expect(Number.isInteger(s.marginBase * 100)).toBe(true)
    expect(Number.isInteger(Math.round(s.marginPct * 100))).toBe(true)
  })
})

describe('the views enforce the same rule', () => {
  it('keeps security_invoker on both, so a rep cannot read another rep', () => {
    const created = SQL.match(/CREATE VIEW public\.v_\w+ WITH \(security_invoker = true\)/g)
    expect(created).toHaveLength(2)
    expect(SQL.match(/CREATE VIEW public\.v_\w+/g)).toHaveLength(2)
  })

  it('returns NULL margin, not zero, where the cost is incomplete', () => {
    expect(SQL).toContain('CASE WHEN i.cogs_complete THEN round(i.total - i.cogs_base, 2) END')
  })

  // Dividing by total revenue would understate the rate by whatever could not
  // be costed, and would move a rep's percentage when an unrelated invoice of
  // theirs got a cost.
  it('measures the rate against costed revenue, not total revenue', () => {
    const view = SQL.slice(SQL.indexOf('CREATE VIEW public.v_sales_rep_performance'))
    expect(view).toContain('SUM(m.revenue_base) FILTER (WHERE m.cogs_complete)')
  })

  it('reports both revenues, so the gap is never invisible', () => {
    const view = SQL.slice(SQL.indexOf('CREATE VIEW public.v_sales_rep_performance'))
    expect(view).toContain('AS revenue_base')
    expect(view).toContain('AS costed_revenue_base')
    expect(view).toContain('AS invoices_cost_unknown')
  })

  it('counts only posted invoices', () => {
    expect(SQL).toContain("WHERE i.doc_status = 'posted'")
  })

  it('re-grants SELECT on both views', () => {
    expect(SQL).toContain('GRANT SELECT ON public.v_invoice_margin')
    expect(SQL).toContain('GRANT SELECT ON public.v_sales_rep_performance')
  })

  it('refuses to apply if an uncosted invoice can report a margin', () => {
    expect(SQL).toContain('NOT cogs_complete AND margin_base IS NOT NULL')
  })
})

describe('the screen does not undo the rule', () => {
  const src = readFileSync('src/pages/_ProfitabilityTab.jsx', 'utf8')

  it('never coalesces a null margin to zero', () => {
    expect(src).not.toMatch(/margin_base\s*\|\|\s*0/)
    expect(src).not.toMatch(/margin_base\s*\?\?\s*0/)
  })

  it('shows an uncosted invoice as unknown rather than as a figure', () => {
    expect(src).toContain('i.cogs_complete ? (')
    expect(src).toContain('reports.marginUnknown')
  })

  it('says plainly how much revenue is excluded', () => {
    expect(src).toContain('reports.marginIncompleteTitle')
    expect(src).toContain('totals.revenueBase - totals.costedRevenueBase')
  })

  it('tells the user when the migration is not applied yet', () => {
    // An empty table would otherwise read as "no sales", which is a different
    // and much more alarming statement than "not set up".
    expect(src).toContain('reports.marginNotProvisioned')
  })
})

/**
 * Named imports from the api barrel must actually exist in it.
 *
 * src/api/supabaseClient.js re-exports NAMESPACES (db, auth, storage, …), not
 * loose helpers. Importing `summariseMargin` from it passed ESLint and passed
 * the whole test suite, then failed the production build — `import//no-unresolved`
 * checks the module, not the binding, and Vitest resolves the barrel's
 * re-exports at runtime differently from Rollup's static analysis.
 *
 * This is the same blind spot that let a missing `captureException` import
 * through earlier in this project. Cheap to detect, and the failure is a broken
 * build rather than a wrong number, so it is worth a test rather than care.
 */
describe('imports from the api barrel resolve', () => {
  // Read the source tree once, outside the timed test case: re-reading it inside
  // the case took up to 1.7 s on a busy Windows machine (Vitest's limit is 5 s).
  const walkSources = (dir) => {
    const out = []
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        if (entry !== 'test') out.push(...walkSources(path))
      } else if (/\.(jsx?|tsx?)$/.test(entry)) out.push([path, readFileSync(path, 'utf8')])
    }
    return out
  }
  const sources = walkSources('src')

  it('every named import exists in supabaseClient.js', () => {
    const barrel = readFileSync('src/api/supabaseClient.js', 'utf8')
    const exported = new Set()
    for (const m of barrel.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const name of m[1].split(',')) {
        const clean = name.trim().split(/\s+as\s+/).pop().trim()
        if (clean) exported.add(clean)
      }
    }
    expect(exported.size, 'could not parse the barrel exports').toBeGreaterThan(3)

    const bad = []
    for (const [file, src] of sources) {
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*supabaseClient['"]/g)) {
        for (const name of m[1].split(',')) {
          const clean = name.trim().split(/\s+as\s+/)[0].trim()
          if (clean && !exported.has(clean)) bad.push(`${file}: ${clean}`)
        }
      }
    }
    expect(bad, `not exported by supabaseClient.js: ${bad.join(', ')}`).toEqual([])
  })
})
