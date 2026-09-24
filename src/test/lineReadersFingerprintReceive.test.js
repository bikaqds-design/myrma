// @vitest-environment node
/**
 * lineReadersFingerprintReceive.test.js — W2 / L-02 step 3 (20260891).
 *
 * Proven against a real database in
 * supabase/tests/line_readers_fingerprint_receive.sql (6/6 on staging; before
 * the migration a pending credit note whose rows changed behind it was issued,
 * and receiving followed a tampered copy). Pinned here: what moved and how.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260891_line_readers_fingerprint_receive.sql', 'utf8')

describe('the credit-note approval fingerprint', () => {
  it('is taken over the rows at submit', () => {
    expect(sql).toContain("jsonb_build_array('submit_credit_note_for_approval',")
    expect(sql).toContain('public.rma_credit_note_lines_json(v_cn.id)::text)),')
  })

  it('at issue accepts the rows\' fingerprint, or a pre-20260891 copy fingerprint only while the copy equals the rows', () => {
    const at = sql.indexOf("jsonb_build_array('issue_credit_note',")
    const rule = sql.slice(at, sql.indexOf("-- receive: read the rows once", at))
    expect(rule).toContain('public.rma_credit_note_lines_json(v_cn.id)::text))')
    expect(rule).toContain('AND NOT (v_cn.line_items IS NOT DISTINCT FROM public.rma_credit_note_lines_json(v_cn.id)')
  })

  it('the migration refuses to finish while submit still fingerprints the copy', () => {
    expect(sql).toContain("still fingerprints the line_items copy")
  })
})

describe('receive_vendor_invoice', () => {
  it('reads the lines once from the rows and nowhere from the copy', () => {
    expect(sql).toContain("v_items := public.rma_vendor_invoice_lines_json(p_vi_id);")
    expect(sql).toContain("jsonb_build_array('receive_vendor_invoice', 'v_vi.line_items', 'v_items', 5)")
    expect(sql).toContain("IF v_def ~ 'v_vi\\.line_items' THEN")
  })

  it('each rewrite is counted before anything is replaced', () => {
    expect(sql).toContain("RAISE EXCEPTION 'Refusing to apply: % holds \"%\" % time(s), expected %'")
    expect(sql.indexOf('EXECUTE v_defs->>v_fn')).toBeGreaterThan(sql.indexOf('v_defs := jsonb_set(v_defs, ARRAY[v_fn]'))
  })
})
