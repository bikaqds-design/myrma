// 20260911: tax codes, per-line tax snapshots and the VAT return (A-04a).
// Pins the shape of the migration; the behaviour is supabase/tests/tax_codes.sql
// (32 checks on staging, rolled back).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// line endings normalised: a Windows checkout stores the file with CRLF
const sql = readFileSync('supabase/migrations/20260911_tax_codes.sql', 'utf8').replace(/\r\n/g, '\n')
const fn = (name) => {
  const at = sql.indexOf(`FUNCTION public.${name}(`)
  return sql.slice(at, sql.indexOf('$fn$;', sql.indexOf('$fn$', at) + 4))
}
const LINE_TABLES = ['quotation_lines', 'sales_order_lines', 'crm_invoice_lines', 'credit_note_lines', 'purchase_order_lines', 'vendor_invoice_lines']

describe('20260911 — tax codes', () => {
  it('every document line carries a code, and the code sets the rate it is written at', () => {
    for (const t of LINE_TABLES) {
      expect(sql, t).toContain(`ALTER TABLE public.${t}`)
    }
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS tax_code text REFERENCES public\.tax_codes\(code\)/)
    expect(sql).toContain('CREATE TRIGGER trg_%s_tax_snapshot BEFORE INSERT OR UPDATE OF tax_code, tax_pct ON public.%I')
    const snap = fn('rma_line_tax_snapshot')
    expect(snap).toContain('NEW.tax_pct := v_code.rate;')
    // a credit note or a supplier bill may keep any rate its code has had
    expect(snap).toMatch(/TG_TABLE_NAME IN \('credit_note_lines', 'vendor_invoice_lines'\)/)
    expect(snap).toContain('FROM public.tax_code_rates WHERE code = NEW.tax_code AND rate = NEW.tax_pct')
  })

  it('the writers store the code and keep a line\'s code when a screen resends it at the same rate', () => {
    expect(sql).toContain("'v_dpct::numeric, v_tpct::numeric, public._rma_line_tax_code(v_line, v_no, v_tpct::numeric)'")
    expect(sql).toContain("'discount_pct, tax_pct', 'discount_pct, tax_pct, tax_code'")
    const pick = fn('_rma_line_tax_code')
    expect(pick).toContain("current_setting('rma.prev_tax_codes', true)")
    expect(pick).toContain('(v_prev->>1)::numeric = p_rate')
  })

  it('the conversions carry the code to the new document', () => {
    for (const f of ['convert_quotation_to_so(uuid,text,text)', 'convert_so_to_invoice(uuid,text)', 'create_invoice_from_delivery(uuid,text)',
      'convert_po_to_vendor_invoice(uuid,text)', 'create_vendor_invoice_from_receipts(uuid,uuid[],text)', 'create_credit_note_from_return(uuid,text)']) {
      expect(sql, f).toContain(`public.${f}`)
    }
    expect(sql).toContain('Refusing to finish: % does not carry the tax code')
  })

  it('posting, issuing and approving are refused while a line has no code; an invoice is taxed at today\'s rate', () => {
    const g = fn('rma_guard_tax_codes_on_posting')
    expect(g).toContain('no tax code has the rate')
    expect(g).toContain('Save the invoice again')
    for (const t of ['crm_invoices', 'credit_notes', 'vendor_invoices']) {
      expect(sql).toMatch(new RegExp(`CREATE TRIGGER trg_${t}_tax_codes BEFORE UPDATE OF (doc_status|status) ON public\\.${t}`))
    }
  })

  it('finance writes the codes; a used code keeps its code and kind; rate history is kept', () => {
    expect(sql).toMatch(/CREATE POLICY "finance_write_tax_codes" ON public\.tax_codes FOR ALL\s+USING \(COALESCE\(public\.rma_is_finance\(\), false\)\)/)
    const guard = fn('rma_guard_tax_code')
    expect(guard).toContain('cannot be deleted')
    expect(guard).toContain('its kind cannot change')
    expect(sql).toContain('CREATE TRIGGER trg_tax_codes_rate_history AFTER INSERT OR UPDATE OF rate ON public.tax_codes')
    expect(sql).toContain('CREATE TRIGGER trg_audit_tax_codes')
  })

  it('the VAT return reads what the ledger posted, and can be tied to the VAT accounts', () => {
    const r = fn('rma_vat_return')
    expect(r).toMatch(/IF NOT COALESCE\(public\.rma_can_handle_cash\(\), false\) THEN/)
    for (const ev of ["('crm_invoice', 'posted')", "('crm_invoice', 'voided')", "('credit_note', 'issued')", "('credit_note', 'voided')",
      "('vendor_invoice', 'approved')", "('vendor_invoice', 'cancelled')"]) {
      expect(r).toContain(ev)
    }
    expect(r).toContain('COALESCE(NULLIF(vi.exchange_rate, 0), 1)')
    expect(fn('rma_vat_return_ledger')).toContain("r.role IN ('sales_tax_payable', 'purchase_tax_receivable')")
  })

  it('nothing new is callable by anon; the internals by no client', () => {
    for (const sig of ['rma_vat_return(date, date)', 'rma_vat_return_ledger(date, date)', 'rma_default_tax_code(numeric)', 'rma_fmt_rate(numeric)']) {
      expect(sql, sig).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon`)
    }
    for (const sig of ['rma_line_tax_snapshot()', 'rma_guard_tax_code()', 'rma_tax_code_rate_history()', 'rma_guard_tax_codes_on_posting()',
      'rma_tax_code_used(text)', '_rma_line_tax_code(jsonb, integer, numeric)']) {
      expect(sql, sig).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated`)
    }
  })

  it('tax codes are backed up before the products and lines that name them', () => {
    const backup = readFileSync('src/api/backup.js', 'utf8')
    const at = (t) => backup.indexOf(`{ table: '${t}' }`)
    expect(at('tax_codes')).toBeGreaterThan(at('posting_rules'))
    expect(at('tax_code_rates')).toBeGreaterThan(at('tax_codes'))
    expect(at('products')).toBeGreaterThan(at('tax_code_rates'))
    expect(sql).toContain("'posting_rules',\n    'tax_codes', 'tax_code_rates',")
  })
})
