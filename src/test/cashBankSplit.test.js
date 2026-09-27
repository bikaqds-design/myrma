// 20260909: cash and bank post to separate accounts (owner decision
// 2026-09-27). Pins the shape of the migration; the behaviour is
// supabase/tests/cash_and_bank.sql (staging, rolled back).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { POSTING_ROLES } from '../pages/Accounting/_ledger'

const sql = readFileSync('supabase/migrations/20260909_cash_and_bank.sql', 'utf8')

describe('20260909 — cash and bank', () => {
  it('only the cash method posts to cash; every other method goes through the bank', () => {
    expect(sql).toContain("SELECT CASE WHEN lower(btrim(COALESCE(p_method, ''))) = 'cash' THEN 'cash' ELSE 'bank' END")
  })

  it('payments, refunds and supplier payments choose their account by method', () => {
    for (const fn of ['rma_gl_post_payment', 'rma_gl_post_customer_refund', 'rma_gl_post_vendor_payment']) {
      expect(sql).toContain(`'public.${fn}'`)
    }
    expect(sql.match(/rma_gl_money_role\(NEW\.method\)/g)).toHaveLength(3)
    // and it refuses to finish while any of them still names the cash role directly
    expect(sql).toContain('Refusing to finish: a payment posting still names the cash role directly')
  })

  it('bank takes the account money already went to, so a transfer lands where it always did', () => {
    expect(sql).toMatch(/INSERT INTO public\.posting_rules \(role, account_id\) VALUES \('bank', v_cash_acct\)/)
  })

  it('the country templates put cash on 1110 and bank on 1130', () => {
    expect(sql).toContain("UPDATE public.gl_chart_templates SET role = 'bank' WHERE code = '1130'")
    expect(sql).toContain("UPDATE public.gl_chart_templates SET role = 'cash' WHERE code = '1110'")
  })

  it('the Control Panel offers the bank role, with a label in both languages', () => {
    expect(POSTING_ROLES).toContain('bank')
    for (const lang of ['en', 'ar']) {
      const t = JSON.parse(readFileSync(`src/locales/${lang}.json`, 'utf8')).accounting
      expect(t.glRole_bank, lang).toBeTruthy()
      expect(t.glRole_cash, lang).toBeTruthy()
    }
  })
})
