// P-05b (20260903): a return's credit note is made from the return. Pins the
// shape of the migration; supabase/tests/return_credit_notes.sql is the
// behavioural reference script (run against staging, rolled back).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260903_return_credit_notes.sql', 'utf8')
const fn = (name) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return sql.slice(start, sql.indexOf('$fn$;', start))
}

describe('20260903 return credit notes', () => {
  it('only managers and above, only a confirmed return, one live note per return', () => {
    const f = fn('create_credit_note_from_return')
    expect(f).toMatch(/v_actor IS NULL OR NOT COALESCE\(public\.rma_is_manager_or_above\(\), false\)/)
    expect(f).toContain("IF v_r.status <> 'confirmed' THEN")
    expect(f).toContain("WHERE customer_return_id = p_return_id AND status <> 'voided'")
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS credit_notes_one_live_per_return_idx[\s\S]*?status <> 'voided'/)
  })

  it('credits exactly what came back, at the order line price, against the delivery invoice, through create_credit_note', () => {
    const f = fn('create_credit_note_from_return')
    expect(f).toContain("'qty', rl.qty, 'unit_price', sol.unit_price, 'discount_pct', sol.discount_pct, 'tax_pct', sol.tax_pct")
    expect(f).toContain("WHERE delivery_id = v_r.delivery_id AND doc_status = 'posted'")
    // the caps and approval rules of 20260880 apply because it goes through create_credit_note
    expect(f).toMatch(/v_cn := public\.create_credit_note\(\s*'rma_return'/)
    expect(f).toContain("'return', v_lines, v_inv.id, NULL")
    // the goods are already back: nothing asks for a restock
    expect(f).toContain("'restock', false")
    expect(f).toContain("restock_status = 'restocked'")
  })

  it('goods first: a hand-made return credit note on a delivery invoice is refused, a ticket\'s is not', () => {
    expect(sql).toContain("IF p_type = ''rma_return'' AND p_ticket_id IS NULL AND v_inv.delivery_id IS NOT NULL")
    expect(sql).toContain("current_setting(''rma.cn_from_return'', true) IS DISTINCT FROM ''on''")
    const f = fn('create_credit_note_from_return')
    expect(f.indexOf("set_config('rma.cn_from_return', 'on', true)")).toBeLessThan(f.indexOf('public.create_credit_note('))
    expect(f.indexOf("set_config('rma.cn_from_return', 'off', true)")).toBeGreaterThan(f.indexOf('public.create_credit_note('))
  })

  it('a return\'s note keeps its lines; both rewrites refuse unless they find their anchor exactly once', () => {
    expect(sql).toContain('IF v_cn.customer_return_id IS NOT NULL AND v_sent THEN')
    expect(sql).toMatch(/Refusing to apply: create_credit_note holds its INSERT/)
    expect(sql).toMatch(/Refusing to apply: update_credit_note holds its line reread/)
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.create_credit_note_from_return(uuid, text) FROM PUBLIC, anon;")
  })
})
