// 20260912: foreign currency on sales documents and realised exchange
// differences (A-05a). Pins the shape of the migration; the behaviour is
// supabase/tests/multi_currency_sales.sql (25 checks on staging, rolled back).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { POSTING_ROLES } from '../pages/Accounting/_ledger'

// line endings normalised: a Windows checkout stores the file with CRLF
const sql = readFileSync('supabase/migrations/20260912_multi_currency_sales.sql', 'utf8').replace(/\r\n/g, '\n')
const fn = (name) => {
  const at = sql.indexOf(`FUNCTION public.${name}(`)
  return sql.slice(at, sql.indexOf('END $fn$', at))
}
const DOCS = ['quotations', 'sales_orders', 'crm_invoices', 'credit_notes', 'payments', 'customer_refunds']

describe('20260912 — foreign currency on sales', () => {
  it('rates are a table finance writes; the rate for a day is the latest on or before it', () => {
    expect(sql).toMatch(/CREATE POLICY "finance_write_exchange_rates" ON public\.exchange_rates FOR ALL\s+USING \(COALESCE\(public\.rma_is_finance\(\), false\)\)/)
    expect(fn('rma_exchange_rate')).toContain('r.rate_date <= COALESCE(p_date, public.rma_today())')
    expect(fn('rma_exchange_rate')).toContain('ORDER BY r.rate_date DESC LIMIT 1')
    expect(fn('rma_guard_exchange_rate')).toContain('is the base currency: its rate is always 1')
  })

  it('every sales document, payment and refund carries a currency and a positive rate, filled on insert', () => {
    expect(sql).toContain(`FOREACH t IN ARRAY ARRAY[${DOCS.map((d) => `'${d}'`).join(', ')}] LOOP`)
    expect(sql).toContain("EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (exchange_rate > 0)', t, t || '_exchange_rate_positive')")
    const d = fn('rma_doc_currency_defaults')
    expect(d).toContain("(SELECT c.currency FROM public.customers c WHERE c.id = NEW.customer_id)")
    expect(d).toContain('There is no exchange rate for % on or before %.')
    // a credit note and a refund reverse exactly what was booked
    expect(d).toMatch(/TG_TABLE_NAME = 'credit_notes'[\s\S]*?v_fixed := true/)
    // a backup taken before this migration restores in the base currency
    expect(d).toMatch(/audit_suspended[\s\S]*?NEW\.currency := COALESCE\(NEW\.currency, v_base\)/)
  })

  it('a draft\'s currency or rate changes only through set_document_currency, by whoever may edit it', () => {
    const s = fn('set_document_currency')
    expect(s).toContain("Only a draft''s currency or rate can change.")
    expect(s).toMatch(/IF NOT COALESCE\(public\.rma_is_manager_or_above\(\)/)
    expect(s).toContain("A credit note against an invoice keeps the invoice''s rate.")
  })

  it('a payment or credit note settles only invoices in its own currency', () => {
    expect(fn('rma_guard_application_currency')).toContain('settles invoices in its own currency')
    expect(sql).toContain('CREATE TRIGGER trg_payment_applications_currency BEFORE INSERT ON public.payment_applications')
    expect(sql).toContain('CREATE TRIGGER trg_credit_note_applications_currency BEFORE INSERT ON public.credit_note_applications')
  })

  it('the ledger posts in the base currency at each document\'s rate', () => {
    for (const f of ['rma_gl_post_crm_invoice', 'rma_gl_post_credit_note', 'rma_gl_post_payment', 'rma_gl_post_customer_refund']) {
      expect(fn(f), f).toMatch(/round\(COALESCE\(NEW\.(total|amount), 0\) \* COALESCE\(NEW\.exchange_rate, 1\), 2\)/)
    }
    // cash and bank stay split (20260909)
    expect(fn('rma_gl_post_payment')).toContain('public.rma_gl_money_role(NEW.method)')
    expect(fn('rma_gl_post_customer_refund')).toContain('public.rma_gl_money_role(NEW.method)')
  })

  it('settling at another rate posts the difference to exchange gains or losses, for customers and suppliers', () => {
    expect(fn('rma_gl_post_ar_fx')).toContain("'fx_loss', 'debit', v_diff")
    expect(fn('rma_gl_post_ar_fx')).toContain("'fx_gain', 'credit', -v_diff")
    expect(fn('rma_gl_post_ap_fx')).toContain("'fx_gain', 'credit', v_diff")
    expect(fn('rma_gl_post_ap_fx')).toContain("'fx_loss', 'debit', -v_diff")
    for (const t of ['payment_applications', 'credit_note_applications', 'vendor_payment_applications']) {
      expect(sql).toContain(`CREATE TRIGGER trg_${t}_fx AFTER INSERT ON public.${t}`)
    }
    expect(POSTING_ROLES).toEqual(expect.arrayContaining(['fx_gain', 'fx_loss']))
  })

  it('the VAT return converts output tax at each document\'s rate', () => {
    expect(fn('rma_vat_return')).toContain('COALESCE(NULLIF(i.exchange_rate, 0), 1)')
    expect(fn('rma_vat_return')).toContain('COALESCE(NULLIF(c.exchange_rate, 0), 1)')
  })

  it('record_payment takes an optional currency and rate, and anon runs nothing new', () => {
    expect(sql).toContain("p_currency text DEFAULT NULL, p_exchange_rate numeric DEFAULT NULL)")
    for (const sig of ['rma_exchange_rate(char, date)', 'set_document_currency(text, uuid, text, numeric)',
      'record_payment(uuid, numeric, text, text, date, text, text, jsonb, text, numeric)', 'rma_base_currency()']) {
      expect(sql, sig).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon`)
    }
  })

  it('exchange rates are backed up after the currencies they name', () => {
    const backup = readFileSync('src/api/backup.js', 'utf8')
    expect(backup.indexOf("{ table: 'exchange_rates' }")).toBeGreaterThan(backup.indexOf("{ table: 'tax_code_rates' }"))
    expect(sql).toContain("'tax_codes', 'tax_code_rates', 'exchange_rates',")
  })
})
