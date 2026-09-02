/**
 * landedCost.test.js — the costing rules, and the guards that keep them true.
 *
 * The arithmetic itself lives in SQL (rma_vi_landed_unit_costs), so the pure
 * checks here mirror it against a reference implementation. That is deliberate:
 * a second implementation that agrees on worked examples is what catches a
 * silent edit to the apportionment, and the examples are the ones a person can
 * check by hand.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { apportion } from '../lib/money.js'
import { CHARGE_TYPES } from '../pages/Purchasing/_shared.js'

const SQL = readFileSync('supabase/migrations/20260794_landed_cost.sql', 'utf8')

/**
 * Reference implementation of the same rule the SQL applies, so the two can be
 * compared on worked examples.
 */
function landedUnitCosts(lines, charges, rate, taxInCost = false) {
  const values = lines.map(
    (l) => l.qty * l.unitCost * (1 - (l.discountPct ?? 0) / 100)
  )
  const totalValue = values.reduce((a, b) => a + b, 0)
  return lines.map((l, i) => {
    const perUnit =
      l.unitCost *
      (1 - (l.discountPct ?? 0) / 100) *
      (taxInCost ? 1 + (l.taxPct ?? 0) / 100 : 1)
    const share = totalValue > 0 && l.qty > 0 ? (charges * (values[i] / totalValue)) / l.qty : 0
    return Math.round((perUnit + share) * rate * 10_000) / 10_000
  })
}

describe('landed unit cost', () => {
  it('is the line price when there is nothing else', () => {
    expect(landedUnitCosts([{ qty: 10, unitCost: 100 }], 0, 1)).toEqual([100])
  })

  it('applies the line discount', () => {
    expect(landedUnitCosts([{ qty: 10, unitCost: 100, discountPct: 10 }], 0, 1)).toEqual([90])
  })

  // The default, and the one that matters most: VAT on a purchase for resale is
  // recoverable, so including it would overstate cost and understate margin on
  // every single line.
  it('excludes tax by default and includes it when configured', () => {
    const line = [{ qty: 10, unitCost: 100, taxPct: 14 }]
    expect(landedUnitCosts(line, 0, 1)).toEqual([100])
    expect(landedUnitCosts(line, 0, 1, true)).toEqual([114])
  })

  it('converts to base currency at the invoice rate', () => {
    expect(landedUnitCosts([{ qty: 5, unitCost: 200 }], 0, 48.5)).toEqual([9700])
  })

  // A worked example anyone can check: 10 units at 100 and 10 at 300 are worth
  // 1,000 and 3,000, so freight of 400 splits 100 / 300, or 10 and 30 per unit.
  it('apportions charges by line value, not by unit count', () => {
    const lines = [
      { qty: 10, unitCost: 100 },
      { qty: 10, unitCost: 300 },
    ]
    expect(landedUnitCosts(lines, 400, 1)).toEqual([110, 330])
    // Splitting by unit count instead would give 120 and 320 — the cheap item
    // carrying as much freight as the expensive one.
    expect(landedUnitCosts(lines, 400, 1)).not.toEqual([120, 320])
  })

  it('apportions on the discounted value, not the list value', () => {
    const lines = [
      { qty: 10, unitCost: 100, discountPct: 50 }, // worth 500
      { qty: 10, unitCost: 100 }, // worth 1,000
    ]
    // 300 of freight over 1,500 of value: 100 to the first, 200 to the second.
    expect(landedUnitCosts(lines, 300, 1)).toEqual([60, 120])
  })

  // The rule that makes partial receipts safe. The per-unit share must not
  // depend on how much of the shipment has arrived.
  it('gives the same per-unit charge whether goods arrive at once or in parts', () => {
    const lines = [{ qty: 100, unitCost: 10 }]
    const all = landedUnitCosts(lines, 500, 1)
    // Receiving 40 now and 60 later reads the same invoice both times, so the
    // computation is unchanged — the charge is spread over qty_ordered, never
    // over what happened to turn up.
    expect(all).toEqual([15])
    expect(landedUnitCosts(lines, 500, 1)).toEqual(all)
  })

  it('does not divide by zero on an invoice with no value', () => {
    expect(landedUnitCosts([{ qty: 0, unitCost: 0 }], 500, 1)).toEqual([0])
    expect(landedUnitCosts([], 500, 1)).toEqual([])
  })

  it('handles charges with no lines to carry them without producing NaN', () => {
    const out = landedUnitCosts([{ qty: 5, unitCost: 0 }], 100, 48.5)
    expect(out.every(Number.isFinite)).toBe(true)
  })

  // apportion() is the shared helper; it must agree with the by-value split.
  it('agrees with the shared apportion helper', () => {
    const [a, b] = apportion(400, [1000, 3000])
    expect(a + b).toBeCloseTo(400, 6)
    expect(a).toBeCloseTo(100, 6)
    expect(b).toBeCloseTo(300, 6)
  })
})

describe('the migration states the rules it claims', () => {
  it('apportions by line value, discounted, excluding tax', () => {
    // The apportionment base must not include the tax multiplier; the pre-tax
    // value is what was actually bought.
    const base = SQL.slice(SQL.indexOf('INTO v_line_value'))
    expect(SQL).toContain("(1 - COALESCE((l->>'discount_pct')::numeric, 0) / 100)")
    expect(base.slice(0, 40)).not.toContain('tax_pct')
  })

  it('defaults purchase tax to excluded from cost', () => {
    expect(SQL).toContain("VALUES ('purchase_tax_in_cost', 'false'::jsonb)")
  })

  it('guards the definer costing function against non-staff callers', () => {
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.rma_vi_landed_unit_costs'))
    expect(fn.slice(0, fn.indexOf('$fn$;'))).toContain('rma_is_staff()')
  })

  it('derives the average cost rather than storing it writably', () => {
    expect(SQL).toMatch(/avg_cost_base numeric\(14,4\)\s*\n?\s*GENERATED ALWAYS AS/)
  })

  it('guards against division by zero in the generated average', () => {
    expect(SQL).toContain('CASE WHEN quantity > 0')
  })
})

describe('cost survives stock movement', () => {
  it('holds unit cost constant when quantity moves without a stated cost', () => {
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.rma_hold_unit_cost'))
    const body = fn.slice(0, fn.indexOf('$fn$;'))
    // Both halves of the condition matter. Without the second, a receipt that
    // sets its own cost would be overwritten by the trigger.
    expect(body).toContain('NEW.quantity IS DISTINCT FROM OLD.quantity')
    expect(body).toContain('NEW.total_cost_base IS NOT DISTINCT FROM OLD.total_cost_base')
  })

  it('fires before update so it can still change the row', () => {
    expect(SQL).toMatch(/BEFORE UPDATE ON public\.warehouse_stock/)
  })

  it('carries value between warehouses on a transfer', () => {
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.transfer_stock'))
    expect(fn).toContain('total_cost_base - v_moved')
    expect(fn).toContain('total_cost_base + v_moved')
  })

  it('never lets a stock value go negative', () => {
    expect(SQL).toContain('GREATEST(total_cost_base - v_moved, 0)')
  })
})

/**
 * transfer_stock was rewritten to carry cost. A rewrite is exactly where a
 * guard silently disappears — the first draft of this migration dropped the
 * system-warehouse assertions, the reservation check and the tracking-mode
 * branch, and replaced the stock_moves rows with invented move types. These
 * pin every protection that existed before.
 */
describe('transfer_stock kept every guard it had', () => {
  const fn = SQL.slice(SQL.indexOf('FUNCTION public.transfer_stock'))
  const body = fn.slice(0, fn.indexOf('END;\n$$;'))

  it.each([
    ['refuses a system warehouse as destination', "assert_not_system_warehouse(p_to_warehouse_id, 'destination')"],
    ['refuses a system warehouse as source', "assert_not_system_warehouse(p_from_warehouse_id, 'source')"],
    ['branches on the product tracking mode', "v_tracking_mode = 'bulk'"],
    ['refuses to move a reserved unit', "v_unit.reservation_status != 'available'"],
    ['checks the unit is in the source warehouse', 'v_unit.warehouse_id IS DISTINCT FROM p_from_warehouse_id'],
    ['requires a unit id for serialised stock', 'A unit id is required to transfer serialized stock'],
    ['checks available stock, not just quantity', 'v_src.quantity - v_src.reserved_quantity'],
  ])('%s', (_name, needle) => {
    expect(body).toContain(needle)
  })

  it('still logs transfers with the original move type', () => {
    // 'transfer_out'/'transfer_in' were invented in a draft and do not exist
    // anywhere else in the schema; the real rows are doc_type 'manual',
    // move_type 'transfer'.
    expect(body).toContain("'manual', NULL, 'transfer'")
    expect(body).not.toContain('transfer_out')
    expect(body).not.toContain('transfer_in')
  })
})

describe('charges', () => {
  it('offers exactly the kinds the database constraint allows', () => {
    // A kind the CHECK rejects fails on save as a database error rather than a
    // form message, so the two lists have to agree.
    const constraint = readFileSync('supabase/migrations/20260792_purchasing_currency.sql', 'utf8')
    const match = constraint.match(/charge_type\s+text\s+NOT NULL CHECK \(charge_type IN\s*\n?\s*\(([^)]*)\)/)
    expect(match, 'could not find the charge_type constraint').toBeTruthy()
    const allowed = [...match[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
    expect([...CHARGE_TYPES].sort()).toEqual([...allowed].sort())
  })

  it('cannot be changed once the goods are received', () => {
    expect(SQL).toContain('trg_charges_before_receipt')
    const fn = SQL.slice(SQL.indexOf('FUNCTION public.rma_guard_charges_before_receipt'))
    const body = fn.slice(0, fn.indexOf('$fn$;'))
    expect(body).toContain("v_status IN ('partially_received', 'received')")
    // DELETE passes NULL as NEW, so the row has to be resolved from either.
    expect(body).toContain('COALESCE(NEW.vendor_invoice_id, OLD.vendor_invoice_id)')
    expect(body).toContain('RETURN COALESCE(NEW, OLD)')
  })

  it('is locked in the UI on exactly the statuses the database refuses', () => {
    const detail = readFileSync('src/pages/Purchasing/PurchaseDocumentDetail.jsx', 'utf8')
    expect(detail).toContain("locked={['partially_received', 'received'].includes(doc.status)}")
  })
})

/**
 * Stage 3b — an unknown cost stops behaving like a cost of zero.
 *
 * Measured on live data by the dry run: 4 units received at a real landed cost
 * of E£5,335 into a bin already holding 6 uncosted units produced an average of
 * E£2,134, 60% low. `total_cost_base / quantity` cannot tell a missing cost
 * from a cost of nothing, so the margin it produces reads as profit.
 */
const SQL_3B = readFileSync('supabase/migrations/20260795_uncosted_stock.sql', 'utf8')

/** The new rule, as a reference implementation. */
function avgCostBase({ quantity, uncosted, value }) {
  const costed = quantity - uncosted
  if (costed <= 0) return null
  return Math.round((value / costed) * 10_000) / 10_000
}

describe('the average covers only the costed units', () => {
  it('reproduces the dilution the old formula produced', () => {
    // 4 costed at 5,335 plus 6 unknown. Dividing by all ten is where 2,134
    // came from; dividing by the four that have a cost gives the truth.
    const value = 4 * 5335
    expect(value / 10).toBe(2134)
    expect(avgCostBase({ quantity: 10, uncosted: 6, value })).toBe(5335)
  })

  it('does not move when uncosted stock sits beside costed stock', () => {
    const value = 4 * 5335
    expect(avgCostBase({ quantity: 10, uncosted: 6, value })).toBe(
      avgCostBase({ quantity: 400, uncosted: 396, value })
    )
  })

  // The distinction the whole change exists to make.
  it('is null, not zero, when nothing has a known cost', () => {
    expect(avgCostBase({ quantity: 6, uncosted: 6, value: 0 })).toBeNull()
    expect(avgCostBase({ quantity: 0, uncosted: 0, value: 0 })).toBeNull()
  })

  it('is a real zero only if something genuinely cost nothing', () => {
    // A costed unit recorded at 0 is a claim someone made; it is not the same
    // as never having recorded one, and the two must not collapse together.
    expect(avgCostBase({ quantity: 4, uncosted: 0, value: 0 })).toBe(0)
  })
})

describe('depleting a partly-unknown bin', () => {
  /** What the trigger does: preserve the unknown share. */
  const deplete = (quantity, uncosted, value, newQty) => {
    const newUncosted = Math.min(newQty, Math.max(0, Math.round((uncosted * newQty) / quantity)))
    const costedOld = quantity - uncosted
    const avg = costedOld > 0 ? value / costedOld : 0
    return { newQty, newUncosted, newValue: Math.round(avg * (newQty - newUncosted) * 10_000) / 10_000 }
  }

  it('removes unknown and costed units in proportion', () => {
    // 10 units, 6 unknown, 4 costed at 100 each. Ship 5 -> 3 unknown and 2
    // costed leave. Nothing records which physical units went, so taking them
    // all from one side would assert something the data cannot support.
    const r = deplete(10, 6, 400, 5)
    expect(r.newUncosted).toBe(3)
    expect(r.newValue).toBe(200)
  })

  it('leaves the average of the costed units unchanged', () => {
    const before = avgCostBase({ quantity: 10, uncosted: 6, value: 400 })
    const r = deplete(10, 6, 400, 5)
    expect(avgCostBase({ quantity: r.newQty, uncosted: r.newUncosted, value: r.newValue })).toBe(before)
  })

  it('empties both sides together', () => {
    const r = deplete(10, 6, 400, 0)
    expect(r).toEqual({ newQty: 0, newUncosted: 0, newValue: 0 })
  })

  it('never lets the unknown count exceed what is on hand', () => {
    for (const newQty of [0, 1, 2, 3, 7, 10]) {
      const r = deplete(10, 6, 400, newQty)
      expect(r.newUncosted).toBeLessThanOrEqual(newQty)
      expect(r.newUncosted).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('the 3b migration states its rules', () => {
  it('divides by the costed units in the generated column', () => {
    expect(SQL_3B).toContain('round(total_cost_base / (quantity - uncosted_quantity), 4)')
  })

  it('returns NULL rather than 0 for a fully uncosted bin', () => {
    const gen = SQL_3B.slice(SQL_3B.indexOf('ADD COLUMN avg_cost_base'))
    expect(gen.slice(0, gen.indexOf('STORED'))).toContain('ELSE NULL')
  })

  it('constrains the unknown count to what is on hand', () => {
    expect(SQL_3B).toContain('uncosted_quantity >= 0 AND uncosted_quantity <= quantity')
  })

  it('backfills existing valueless stock as unknown', () => {
    expect(SQL_3B).toMatch(/SET uncosted_quantity = quantity\s*\n\s*WHERE quantity > 0 AND total_cost_base = 0/)
  })

  it('lets the trigger stand aside when a caller states the count', () => {
    expect(SQL_3B).toContain('NEW.uncosted_quantity IS NOT DISTINCT FROM OLD.uncosted_quantity')
  })

  it('adds manually received stock as uncosted rather than at the bin average', () => {
    const fn = SQL_3B.slice(SQL_3B.indexOf('FUNCTION public.receive_stock'))
    expect(fn).toContain('uncosted_quantity = uncosted_quantity + p_qty')
  })

  it('carries the unknown units along on a transfer', () => {
    const fn = SQL_3B.slice(SQL_3B.indexOf('FUNCTION public.transfer_stock'))
    expect(fn).toContain('uncosted_quantity = GREATEST(uncosted_quantity - v_unk_moved, 0)')
    expect(fn).toContain('uncosted_quantity = uncosted_quantity + v_unk_moved')
  })

  it('refuses an opening cost of zero', () => {
    // Valuing stock at zero to clear the flag would defeat the whole point:
    // it converts an honest unknown into a confident and wrong number.
    const fn = SQL_3B.slice(SQL_3B.indexOf('FUNCTION public.rma_set_opening_cost'))
    expect(fn.slice(0, fn.indexOf('$fn$;'))).toContain('p_unit_cost <= 0')
  })

  it('sets value and clears the unknown count in one statement', () => {
    const fn = SQL_3B.slice(SQL_3B.indexOf('FUNCTION public.rma_set_opening_cost'))
    const body = fn.slice(0, fn.indexOf('$fn$;'))
    expect(body).toContain('total_cost_base   = total_cost_base + round(p_unit_cost * v_row.uncosted_quantity, 4)')
    expect(body).toContain('uncosted_quantity = 0')
  })
})

// transfer_stock has now been rewritten twice. Same guards, checked again
// against the newer file — the first rewrite silently dropped four of them.
describe('transfer_stock kept every guard through the second rewrite', () => {
  const fn = SQL_3B.slice(SQL_3B.indexOf('FUNCTION public.transfer_stock'))
  const body = fn.slice(0, fn.indexOf('END;\n$$;'))

  it.each([
    ['refuses a system warehouse as destination', "assert_not_system_warehouse(p_to_warehouse_id, 'destination')"],
    ['refuses a system warehouse as source', "assert_not_system_warehouse(p_from_warehouse_id, 'source')"],
    ['branches on the product tracking mode', "v_tracking_mode = 'bulk'"],
    ['refuses to move a reserved unit', "v_unit.reservation_status != 'available'"],
    ['checks the unit is in the source warehouse', 'v_unit.warehouse_id IS DISTINCT FROM p_from_warehouse_id'],
    ['checks available stock, not just quantity', 'v_src.quantity - v_src.reserved_quantity'],
    ['logs with the original move type', "'manual', NULL, 'transfer'"],
  ])('%s', (_name, needle) => {
    expect(body).toContain(needle)
  })
})

/**
 * Opening valuation of stock that predates costing (20260796).
 *
 * The report found 401 serialised units in stock with no cost and none costed.
 * 20260795 could only value bulk stock, leaving 401 hand-written UPDATEs — a
 * procedure nobody performs, which is the same as no valuation at all.
 */
const SQL_OPEN = readFileSync('supabase/migrations/20260796_opening_cost_serialised.sql', 'utf8')

describe('rma_set_opening_cost', () => {
  it('values serialised units as well as bulk', () => {
    expect(SQL_OPEN).toContain('UPDATE public.inventory_units')
    expect(SQL_OPEN).toContain('uncosted_quantity = 0')
  })

  // The line that keeps an estimate from destroying a fact.
  it('never overwrites a cost that came from a vendor invoice', () => {
    expect(SQL_OPEN).toContain('AND unit_cost_base IS NULL')
    expect(SQL_OPEN).toContain("AND status         = 'company_stock'")
  })

  it('refuses zero, so the flag cannot be cleared by lying about the cost', () => {
    expect(SQL_OPEN).toContain('p_unit_cost <= 0')
  })

  it('requires manager or above', () => {
    expect(SQL_OPEN).toContain('rma_is_manager_or_above()')
  })

  // A mistyped id that quietly matched nothing would report success.
  it('raises rather than silently doing nothing', () => {
    expect(SQL_OPEN).toContain('v_units = 0 AND v_bulk = 0')
  })

  it('returns a description of what it valued', () => {
    expect(SQL_OPEN).toMatch(/RETURNS text/)
    expect(SQL_OPEN).toContain('valued %s serialised unit(s) and %s bulk unit(s)')
  })

  it('is not callable by the public role', () => {
    expect(SQL_OPEN).toContain('REVOKE ALL ON FUNCTION public.rma_set_opening_cost')
    expect(SQL_OPEN).toContain('GRANT EXECUTE ON FUNCTION public.rma_set_opening_cost')
  })
})

/**
 * The Supabase SQL editor shows only the LAST statement's result. A report
 * written as several statements silently loses all but the final one — which
 * is what happened here: two of three sections ran and were never seen.
 */
describe('manual reports return everything they compute', () => {
  it.each([
    'supabase/manual/20260836_uncosted_stock_report.sql',
    'supabase/manual/20260830_verify_landed_cost.sql',
    'supabase/manual/20260837_verify_uncosted_stock.sql',
    'supabase/manual/20260828_verify_vendor_payment_currency.sql',
  ])('%s is a single statement', (path) => {
    const sql = readFileSync(path, 'utf8')
      // strip comments and string literals before counting statement ends
      .replace(/--[^\n]*/g, '')
      .replace(/'(?:[^']|'')*'/g, "''")
    const statements = sql.split(';').filter((chunk) => chunk.trim().length > 0)
    expect(statements.length, `found ${statements.length} statements; all but the last would be invisible`).toBe(1)
  })

  // `check` is reserved in a column-reference position and broke 20260828 on
  // its first run. No report should reintroduce it.
  it.each([
    'supabase/manual/20260836_uncosted_stock_report.sql',
    'supabase/manual/20260837_verify_uncosted_stock.sql',
    'supabase/manual/20260838_verify_opening_cost.sql',
  ])('%s avoids the reserved word as a column reference', (path) => {
    expect(readFileSync(path, 'utf8')).not.toMatch(/END AS result, check\b/)
  })
})

/**
 * Stage 4 — cost of goods sold, captured at posting (20260797).
 *
 * Also closes a defect found while building it: deliver_warehouse_stock and
 * release_warehouse_stock have existed since 20260741 with NO CALLER anywhere.
 * Bulk stock was reserved on sales-order approval and never delivered, so the
 * customer was billed and the quantity never left the warehouse, while
 * reserved_quantity climbed on every sale until no further bulk sale of that
 * product could be reserved at all.
 */
const SQL_COGS = readFileSync('supabase/migrations/20260797_cogs_at_posting.sql', 'utf8')

const fnBody = (sql, name) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`)
  const body = sql.slice(start)
  const end = body.indexOf('END;\n$$;')
  return body.slice(0, end === -1 ? body.indexOf('$fn$;') : end)
}

describe('bulk stock finally leaves the warehouse', () => {
  it('posting delivers bulk stock as well as serialised units', () => {
    const body = fnBody(SQL_COGS, 'post_invoice')
    expect(body).toContain("deliver_units('sales_order'")
    expect(body).toContain("deliver_warehouse_stock('sales_order'")
  })

  it('voiding gives bulk stock back as well as serialised units', () => {
    const body = fnBody(SQL_COGS, 'void_invoice')
    expect(body).toContain('restore_units(')
    expect(body).toContain('restore_warehouse_stock(')
  })

  // Symmetry is the property worth pinning: an operation that removes stock
  // and its inverse that does not is how quantity leaks permanently.
  it('delivers and restores through the same doc_type', () => {
    expect(fnBody(SQL_COGS, 'void_invoice')).toContain("sm.doc_type  = 'sales_order'")
  })
})

describe('cost of goods sold', () => {
  // The ordering bug that would be invisible: delivering first destroys the
  // reservations and the averages the cost is read from, so COGS would come
  // out as zero on every invoice and look like a 100% margin.
  it('is read before the stock moves, not after', () => {
    const body = fnBody(SQL_COGS, 'post_invoice')
    // Match the CALL SITES, not the bare names. The first mention of
    // deliver_units in this function is inside a comment ("rolls back if
    // deliver_units fails below"), and matching that made this assertion
    // compare a comment against a call and fail on correct code.
    const cogsAt = body.indexOf('FROM public.rma_invoice_cogs(')
    const unitsAt = body.indexOf('PERFORM public.deliver_units(')
    const bulkAt = body.indexOf('PERFORM public.deliver_warehouse_stock(')
    expect(cogsAt).toBeGreaterThan(-1)
    expect(unitsAt).toBeGreaterThan(-1)
    expect(bulkAt).toBeGreaterThan(-1)
    expect(cogsAt).toBeLessThan(unitsAt)
    expect(cogsAt).toBeLessThan(bulkAt)
  })

  it('is stored on the invoice rather than derived later', () => {
    expect(SQL_COGS).toContain('ADD COLUMN IF NOT EXISTS cogs_base numeric(12,2)')
    expect(fnBody(SQL_COGS, 'post_invoice')).toContain('SET cogs_base       = COALESCE(v_cogs, 0)')
  })

  it('counts units of unknown cost instead of treating them as free', () => {
    const body = fnBody(SQL_COGS, 'rma_invoice_cogs')
    expect(body).toContain('FILTER (WHERE u.unit_cost_base IS NULL)')
    expect(body).toContain('FILTER (WHERE ws.avg_cost_base IS NULL)')
  })

  it('only sums bulk cost where an average actually exists', () => {
    // Without the FILTER, a NULL average makes the whole SUM null and the
    // invoice reports no cost at all rather than a partial one.
    expect(fnBody(SQL_COGS, 'rma_invoice_cogs'))
      .toContain('FILTER (WHERE ws.avg_cost_base IS NOT NULL)')
  })

  it('computes bulk reservations the same way delivery does', () => {
    // If the two disagree, the quantity costed is not the quantity shipped.
    const body = fnBody(SQL_COGS, 'rma_invoice_cogs')
    expect(body).toContain("SUM(CASE WHEN sm.move_type = 'reserve' THEN sm.qty ELSE 0 END)")
    expect(body).toContain("SUM(CASE WHEN sm.move_type IN ('release', 'deliver') THEN sm.qty ELSE 0 END)")
  })

  it('is cleared on void, so a cancelled sale leaves no margin behind', () => {
    expect(fnBody(SQL_COGS, 'void_invoice')).toContain('cogs_base        = NULL')
  })

  it('is guarded, since cost is commercially sensitive', () => {
    expect(fnBody(SQL_COGS, 'rma_invoice_cogs')).toContain('rma_is_staff()')
    expect(SQL_COGS).toContain('REVOKE ALL ON FUNCTION public.rma_invoice_cogs(uuid) FROM PUBLIC')
  })

  // cogs_complete must require BOTH — a cost that exists AND nothing unknown.
  // Either half alone lets an invoice claim a complete cost it does not have.
  it('reports completeness only when the cost covers everything shipped', () => {
    expect(SQL_COGS).toContain(
      'GENERATED ALWAYS AS (cogs_base IS NOT NULL AND cogs_unknown_qty = 0) STORED'
    )
  })
})

/**
 * post_invoice and void_invoice were both rewritten. Every guard they had must
 * survive — the first transfer_stock rewrite silently dropped four.
 */
describe('the rewritten invoice functions kept every guard', () => {
  it.each([
    ['post_invoice', 'rma_is_manager_or_above()'],
    ['post_invoice', "v_inv.doc_status <> 'draft'"],
    ['post_invoice', "p.stock_tracking_mode = 'serialized'"],
    ['post_invoice', 'v_reserved < v_expected'],
    ['post_invoice', "nextval_for_type('invoice')"],
    ['void_invoice', 'rma_is_manager_or_above()'],
    ['void_invoice', "trim(p_reason) = ''"],
    ['void_invoice', "v_inv.doc_status <> 'posted'"],
    ['void_invoice', 'Reverse payments before voiding'],
    ['void_invoice', 'Reverse credit notes before voiding'],
    ['void_invoice', 'restore_units('],
  ])('%s still has: %s', (fn, needle) => {
    expect(fnBody(SQL_COGS, fn)).toContain(needle)
  })
})
