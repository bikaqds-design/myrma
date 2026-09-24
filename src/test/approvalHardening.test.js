// @vitest-environment node
/**
 * approvalHardening.test.js — 20260892 (purchase delete guard) and 20260893
 * (a quote awaiting approval goes back to draft when its offer changes).
 *
 * Proven on staging in supabase/tests/purchase_delete_guard.sql (6/6; 3 failed
 * before) and quote_edit_while_awaiting_approval.sql (7/7; 4 failed before).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const del = readFileSync('supabase/migrations/20260892_purchase_delete_guard.sql', 'utf8')
const qt = readFileSync('supabase/migrations/20260893_quote_edit_while_awaiting_approval.sql', 'utf8')

describe('purchase documents past draft cannot be deleted', () => {
  for (const [table, trg] of [['purchase_orders', 'trg_purchase_orders_lock_settled_delete'], ['vendor_invoices', 'trg_vendor_invoices_lock_settled_delete']]) {
    it(`${table} uses 20260875's settled-document guard before delete`, () => {
      expect(del).toContain(`CREATE TRIGGER ${trg}\n  BEFORE DELETE ON public.${table}\n  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_settled_document('status');`.replace(/\n/g, del.includes('\r\n') ? '\r\n' : '\n'))
    })
  }
})

describe('a quote awaiting approval', () => {
  it('goes back to draft when its lines, total, validity date or payment terms change', () => {
    for (const s of [
      "WHEN v_qt.status = ''sent''",
      'v_items IS DISTINCT FROM v_qt.line_items',
      'v_tot IS DISTINCT FROM v_qt.total',
      "v_f ? ''validity_until'' AND v_valid IS DISTINCT FROM v_qt.validity_until",
      "v_f ? ''payment_terms'' AND (v_f->>''payment_terms'') IS DISTINCT FROM v_qt.payment_terms",
      "THEN ''draft'' ELSE status END",
    ]) expect(qt, s).toContain(s)
  })

  it('closes the approval request raised when it was sent, so it cannot approve the changed offer later', () => {
    expect(qt).toContain("IF v_qt.status = ''sent'' AND v_row.status = ''draft'' THEN")
    expect(qt).toContain("AND title LIKE ''approval|quotation|'' || p_id::text || ''|%''")
    expect(qt).toContain('AND completed_at IS NULL')
  })

  it('the rewrite is counted before it is applied, and the migration checks the result', () => {
    expect(qt).toContain("IF v_have <> 1 THEN")
    expect(qt).toContain("does not send a changed sent quotation back to draft")
  })
})
