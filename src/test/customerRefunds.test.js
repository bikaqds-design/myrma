// P-05c (20260904): refunds, always approved by a second manager. Pins the
// shape of the migration; supabase/tests/customer_refunds.sql is the
// behavioural reference script (run against staging, rolled back).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { BACKUP_TABLES } from '../api/backup.js'

const sql = readFileSync('supabase/migrations/20260904_customer_refunds.sql', 'utf8')
const fn = (name) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return sql.slice(start, sql.indexOf('$fn$;', start))
}

describe('20260904 customer refunds', () => {
  it('managers record, approve and reject; fails closed', () => {
    for (const f of ['record_customer_refund', 'approve_customer_refund', 'reject_customer_refund']) {
      expect(fn(f)).toMatch(/v_actor IS NULL OR NOT COALESCE\(public\.rma_is_manager_or_above\(\), false\)/)
    }
  })

  it('every refund needs a second manager, and approval checks the source again under its lock', () => {
    const ap = fn('approve_customer_refund')
    expect(ap).toContain('lower(v_actor) = lower(v_r.created_by)')
    expect(ap.indexOf('FOR UPDATE')).toBeLessThan(ap.indexOf('_rma_refund_room'))
    expect(ap).toContain("v_room := public._rma_refund_room(v_r.credit_note_id, v_r.payment_id, v_r.id)")
    expect(ap).toContain("refund_code = public.nextval_for_type('customer_refund')")
  })

  it('never more than the source has left after refunds already waiting; whole cents only', () => {
    const rec = fn('record_customer_refund')
    expect(rec).toContain('p_amount <> round(p_amount, 2)')
    expect(rec).toContain('v_room := public._rma_refund_room(v_cn_id, v_pay_id, NULL)')
    expect(fn('_rma_refund_room')).toContain("r.status = 'pending_approval'")
  })

  it('balances subtract approved refunds, through the existing triggers; payments stay unclamped', () => {
    expect(fn('rma_credit_note_resync')).toContain('GREATEST(v_total - v_applied - v_refunded, 0)')
    const pay = fn('rma_payment_resync')
    expect(pay).toContain('unapplied_amount = v_amount - v_applied - v_refunded')
    expect(pay).not.toContain('GREATEST')
    expect(fn('sync_credit_note_balance')).toContain('PERFORM public.rma_credit_note_resync(')
    expect(fn('sync_payment_balance')).toContain('PERFORM public.rma_payment_resync(')
  })

  it('a refunded payment or credit note is not voided; an approved refund is not rejected', () => {
    expect(sql).toContain('This payment has a refund; it cannot be voided')
    expect(sql).toContain('This credit note has a refund; it cannot be voided')
    expect(fn('reject_customer_refund')).toContain("IF v_r.status <> 'pending_approval' THEN")
  })

  it('procedure-only, managers and accountants read, on the statement and in Backup & Restore', () => {
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.customer_refunds FROM authenticated;')
    expect(sql).toMatch(/CREATE POLICY "read_customer_refunds"[\s\S]*?rma_is_manager_or_above\(\) OR public\.rma_user_role\(\) = 'accountant'/)
    for (const f of ['rma_credit_note_resync(uuid)', 'rma_payment_resync(uuid)']) expect(sql).toContain(`'${f}'`)
    expect(sql).toContain("REVOKE ALL ON FUNCTION public._rma_refund_room(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;")
    expect(sql).toMatch(/'refund'::text AS entry_type[\s\S]*?WHERE customer_refunds\.status = 'approved'/)
    const tables = BACKUP_TABLES.map((t) => t.table)
    expect(tables.indexOf('customer_refunds')).toBeGreaterThan(tables.indexOf('credit_note_applications'))
  })
})
