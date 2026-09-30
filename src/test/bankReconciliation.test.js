/**
 * bankReconciliation.test.js — A-07a (20260920). Owner decisions 2026-09-30:
 * any bank or cash account can be reconciled; the statement comes in as a
 * CSV; a line with no entry yet is booked from the line; accountants and
 * administrators reconcile. supabase/tests/bank_reconciliation.sql (25 checks,
 * rolled back) is the database half; this pins the migration's shape.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SQL = readFileSync('supabase/migrations/20260920_bank_reconciliation.sql', 'utf8').replace(/\r\n/g, '\n')

describe('bank reconciliation', () => {
  it('works on accounts marked as bank or cash, and marks the cash and bank role accounts', () => {
    expect(SQL).toContain('ALTER TABLE public.gl_accounts ADD COLUMN IF NOT EXISTS is_bank boolean NOT NULL DEFAULT false;')
    expect(SQL).toContain("IF NEW.role IN ('cash', 'bank') THEN")
    expect(SQL).toContain("IF NOT FOUND OR NOT v_acc.is_bank OR NOT v_acc.is_postable THEN")
  })

  it('is finance-only to change and readable by managers and accountants', () => {
    expect(SQL).toContain('IF NOT COALESCE(public.rma_is_finance(), false) THEN')
    expect(SQL).toContain('TO authenticated USING (COALESCE(public.rma_can_handle_cash(), false));')
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public._rma_bank_open_statement(uuid) FROM PUBLIC, anon, authenticated;')
  })

  it('matches a line to one journal line on the account with the same signed amount', () => {
    expect(SQL).toContain('journal_line_id uuid UNIQUE REFERENCES public.journal_lines(id)')
    expect(SQL).toContain('IF (v_jl.debit - v_jl.credit) <> v_line.amount THEN')
  })

  it('books an unmatched line to a chosen account through the ledger engine, dated on the line', () => {
    expect(SQL).toContain("v_entry := public._gl_post('bank_statement_line', v_line.id, 'booked', v_line.txn_date,")
  })

  it('completes only when every line is matched, the statement adds up and it opens where the last closed', () => {
    expect(SQL).toContain('statement lines are not matched yet')
    expect(SQL).toContain('The statement does not add up')
    expect(SQL).toContain("The opening balance % is not the previous statement''s closing %.")
  })

  it('the month-end checklist counts unreconciled bank accounts, and the tables are backed up', () => {
    expect(SQL).toContain("WHERE s.account_id = a.id AND s.status = ''completed'' AND s.statement_date >= v_end)),")
    expect(SQL).toContain("'fx_revaluations', 'fx_revaluation_lines', 'bank_statements', 'bank_statement_lines',")
  })
})
