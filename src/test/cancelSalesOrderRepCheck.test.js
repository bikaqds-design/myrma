// 20260895: cancel_sales_order's own-order check for a sales rep fails closed.
// A bare (manager OR assigned_rep = me OR created_by = me) is NULL for an
// order with no assigned rep, and IF NOT NULL lets any rep cancel it.
// supabase/tests/cancel_sales_order_rep_check.sql is the rolled-back probe.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260895_cancel_sales_order_rep_check.sql', 'utf8')
const probe = readFileSync('supabase/tests/cancel_sales_order_rep_check.sql', 'utf8')
const block = sql.slice(sql.indexOf('DO $$\nDECLARE'), sql.indexOf('END $$;') + 'END $$;'.length)

describe('20260895 cancel_sales_order rep check', () => {
  it('wraps the own-order check in COALESCE(…, false)', () => {
    expect(sql).toContain(
      String.raw`IF NOT COALESCE(public.rma_is_manager_or_above()\n          OR v_so.assigned_rep = v_email\n          OR v_so.created_by  = v_email, false) THEN`,
    )
  })

  it('rewrites only a single bare check, and is a no-op where the fix is in place', () => {
    expect(block).toMatch(/IF v_have <> 1 THEN\s+RAISE EXCEPTION 'Refusing to apply/)
    expect(block).toMatch(/IF strpos\(v_def, v_new\) > 0 THEN\s+RETURN;/)
    // live definitions applied from a CRLF file keep their CRs
    expect(block).toContain(String.raw`E'\r\n', E'\n'`)
  })

  it('the probe runs the migration block verbatim', () => {
    expect(block.length).toBeGreaterThan(200)
    expect(probe).toContain(block)
  })
})
