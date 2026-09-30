// generalLedger.test.js — A-01a (20260905). Pins the shape of the migration;
// supabase/tests/general_ledger.sql is the rolled-back reference script that
// runs it (39 checks on staging).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { BACKUP_TABLES, BACKUP_MODULES } from '../api/backup.js'

const sql = readFileSync('supabase/migrations/20260905_general_ledger.sql', 'utf8')
const fn = (name) => {
  const at = sql.indexOf(`FUNCTION public.${name}(`)
  expect(at, `${name} is defined`).toBeGreaterThan(-1)
  return sql.slice(at, sql.indexOf('$fn$;', at))
}

describe('general ledger (A-01a)', () => {
  it('numbers entries JE- from a gapless counter, and the reconciler knows it', () => {
    expect(sql).toContain(`WHEN ''journal_entry''   THEN ''JE''`)
    expect(sql).toContain(`(''journal_entry'',   ''journal_entries'',      ''entry_no'',       ''JE'')`)
    expect(fn('_gl_post')).toContain(`public.nextval_for_type('journal_entry')`)
  })

  it('keeps a line to one positive side, and an entry to one per source and event', () => {
    expect(sql).toContain('CONSTRAINT journal_lines_one_side CHECK ((debit > 0) <> (credit > 0))')
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS journal_entries_source_event_uniq\s+ON public\.journal_entries \(source_type, source_id, event\)/)
    expect(fn('_gl_post')).toMatch(/SELECT id INTO v_id FROM public\.journal_entries\s+WHERE source_type = p_source_type AND source_id = p_source_id AND event = p_event;\s+IF FOUND THEN\s+RETURN v_id;/)
  })

  it('refuses an entry that does not balance, in the engine and again at commit', () => {
    expect(fn('_gl_post')).toMatch(/IF v_sum_dr <> v_sum_cr OR v_n < 2 THEN/)
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER trg_journal_lines_balanced AFTER INSERT ON public\.journal_lines\s+DEFERRABLE INITIALLY DEFERRED/)
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER trg_journal_entries_balanced AFTER INSERT ON public\.journal_entries\s+DEFERRABLE INITIALLY DEFERRED/)
  })

  it('reads the entry id per table (a CASE read NEW.entry_id on journal_entries and failed every entry)', () => {
    const body = fn('rma_assert_journal_balanced')
    expect(body).not.toMatch(/CASE WHEN TG_TABLE_NAME/)
    expect(body).toMatch(/IF TG_TABLE_NAME = 'journal_entries' THEN\s+v_entry := NEW\.id;\s+ELSE\s+v_entry := NEW\.entry_id;/)
  })

  it('never changes or deletes a journal, except a restore writing it back', () => {
    const body = fn('rma_guard_journal_immutable')
    expect(body).toContain(`IF TG_OP <> 'TRUNCATE' AND current_setting('rma.audit_suspended', true) = 'on' THEN`)
    for (const t of ['journal_entries', 'journal_lines']) {
      expect(sql).toMatch(new RegExp(`BEFORE UPDATE OR DELETE ON public\\.${t}\\s+FOR EACH ROW EXECUTE FUNCTION public\\.rma_guard_journal_immutable\\(\\)`))
      expect(sql).toMatch(new RegExp(`BEFORE TRUNCATE ON public\\.${t}\\s+FOR EACH STATEMENT EXECUTE FUNCTION public\\.rma_guard_journal_immutable\\(\\)`))
    }
  })

  it('fails a posting whose role has no account, and never posts to a header or inactive account', () => {
    const body = fn('_gl_post')
    expect(body).toContain('No account is set for')
    expect(body).toContain('WHERE id = v_acct AND is_postable AND is_active')
  })

  it('lets no client write a journal or run the engine; journals are for managers and accountants', () => {
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.journal_entries, public.journal_lines FROM authenticated;')
    expect(sql).toContain('REVOKE ALL ON FUNCTION public._gl_post(text, uuid, text, date, text, text, jsonb) FROM PUBLIC, anon, authenticated;')
    expect(sql).toContain('REVOKE ALL ON FUNCTION public._gl_reverse(text, uuid, text, text, date, text) FROM PUBLIC, anon, authenticated;')
    expect(sql).toMatch(/CREATE POLICY "read_journal_entries"[\s\S]*?COALESCE\(public\.rma_can_handle_cash\(\), false\)/)
    expect(sql).toMatch(/CREATE POLICY "admin_write_gl_accounts"[\s\S]*?COALESCE\(public\.rma_is_admin\(\), false\)/)
    expect(fn('rma_trial_balance')).toContain('IF NOT COALESCE(public.rma_can_handle_cash(), false) THEN')
  })

  it('seeds the chart with ids from the code, so a restore onto a new tenant matches them', () => {
    expect(sql).toContain(`md5('gl_account:' || code)::uuid`)
    expect(sql).toContain(`md5('gl_account:' || c.code)::uuid`)
    for (const code of ['1200', '1300', '2100', '2150', '2200', '4100', '5100']) expect(sql).toContain(`('${code}',`)
  })

  it('backs the ledger up and restores it: chart first, journals after every document', () => {
    const tables = BACKUP_TABLES.map((t) => t.table)
    expect(tables.indexOf('gl_accounts')).toBe(tables.indexOf('rma_config') + 1)
    expect(tables.indexOf('posting_rules')).toBe(tables.indexOf('gl_accounts') + 1)
    expect(tables.indexOf('journal_entries')).toBe(tables.indexOf('customer_refunds') + 1)
    expect(tables.indexOf('journal_lines')).toBe(tables.indexOf('journal_entries') + 1)
    expect(BACKUP_MODULES.find((m) => m.id === 'ledger').tables).toEqual([
      'gl_accounts', 'posting_rules', 'tax_codes', 'tax_code_rates', 'exchange_rates', 'journal_entries', 'journal_lines',
      'accounting_periods', 'period_reopen_requests', // A-03 (20260910)
      'fx_revaluations', 'fx_revaluation_lines', // A-08c (20260918)
      'bank_statements', 'bank_statement_lines', // A-07 (20260920)
    ])
  })
})
