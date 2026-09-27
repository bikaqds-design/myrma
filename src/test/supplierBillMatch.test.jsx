// P-04 (20260900): a supplier bill is matched against its purchase order and
// the goods received before approval. Pins the shape of the migration and the
// screens; the behaviour is supabase/tests/supplier_bill_match.sql (staging,
// rolled back), the panel is rendered below.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const sql = readFileSync('supabase/migrations/20260900_supplier_bill_match.sql', 'utf8')
const fnBody = (name) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return sql.slice(start, sql.indexOf('$fn$;', start))
}

describe('20260900 — the match', () => {
  it('purchase prices are for managers and accountants; the database itself may always ask', () => {
    expect(fnBody('rma_vendor_invoice_match')).toMatch(
      /rma_current_user_email\(\) IS NOT NULL\s+AND NOT COALESCE\(public\.rma_is_manager_or_above\(\) OR public\.rma_user_role\(\) = 'accountant', false\)/)
  })
  it('compares net of discount, per order line when known, and flags the three issues', () => {
    const m = fnBody('rma_vendor_invoice_match')
    expect(m).toContain('l.unit_cost * (1 - COALESCE(l.discount_pct, 0) / 100)')
    expect(m).toContain('COALESCE(gl.purchase_order_line_id,')
    for (const issue of ["'not_on_order'", "'over_billed'", "'price_above'"]) expect(m).toContain(issue)
    expect(m).toContain('j.diff_pct > v_tol')
  })
  it('a tolerance that is unset or not a plain number counts as 0 — never a cast error', () => {
    const tol = fnBody('rma_purchase_price_tolerance_pct')
    expect(tol).toContain("IF v_text IS NULL OR btrim(v_text) !~ '^[0-9]+(\\.[0-9]+)?$' THEN")
    expect(tol).toContain('RETURN 0;')
  })
})

describe('20260900 — the check at submit', () => {
  const g = fnBody('rma_guard_vendor_invoice_match')
  it('refuses over-billing outright and asks for a 10-character reason otherwise, only at submit', () => {
    expect(g).toContain("IF NOT (OLD.status = 'draft' AND NEW.status = 'pending_approval')")
    expect(g).toContain("WHERE m.issue = 'over_billed'")
    expect(g).toContain("length(COALESCE(NEW.price_variance_reason, '')) < 10")
  })
  it('the reason is written on a draft only, and a restore is left alone', () => {
    expect(g).toContain("NEW.price_variance_reason IS DISTINCT FROM OLD.price_variance_reason AND OLD.status <> 'draft'")
    expect(g).toContain("current_setting('rma.audit_suspended', true) = 'on'")
  })
  it('nobody calls the trigger function, and the allowlist opens only the reason', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.rma_guard_vendor_invoice_match() FROM PUBLIC, anon, authenticated;')
    expect(sql).toContain("'duplicate_override_reason', 'price_variance_reason',")
    expect(sql).toMatch(/CREATE TRIGGER trg_vendor_invoices_match\s+BEFORE UPDATE OF status, price_variance_reason/)
  })
})

describe('the screens', () => {
  const page = readFileSync('src/pages/Purchasing/PurchaseDocumentDetail.jsx', 'utf8')
  const api = readFileSync('src/api/db/purchasing.ts', 'utf8')
  it('submitting asks for the price reason when the database wants one, keeping a duplicate reason already given', () => {
    expect(page).toMatch(/\/does not match its purchase order\/i\.test/)
    expect(page).toContain('submitVI({ ...prev, price: reason })')
    expect(page).toContain('submitVI({ ...prev, duplicate: reason })')
    expect(api).toContain('if (priceVarianceReason?.trim()) patch.price_variance_reason = priceVarianceReason.trim()')
  })
  it('a draft is named in the history by the supplier number, never its internal id', () => {
    expect(page).toContain('`${kind}|${doc.vi_code || doc.supplier_invoice_no || \'—\'}`')
  })
  it('the tolerance is set in Control Panel with the same rules as the credit-note limit', () => {
    const cp = readFileSync('src/pages/cp/setup/RegionalSettings.jsx', 'utf8')
    expect(cp).toContain("useConfigValue('purchase_price_tolerance_pct', null)")
    expect(cp).toContain("write('purchase_price_tolerance_pct', toleranceBlank ? '' : toleranceNumber)")
  })
  it('every string is in English and Arabic', () => {
    const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8'))
    const ar = JSON.parse(readFileSync('src/locales/ar.json', 'utf8'))
    const keys = ['matchTitle', 'matchIssues', 'matchOk', 'matchIssue_over_billed', 'matchIssue_price_above', 'matchIssue_not_on_order',
      'matchLineOk', 'matchHint', 'priceReasonTitle', 'priceReason', 'priceReasonPlaceholder', 'priceReasonGiven']
    for (const k of keys) { expect(en.purchasing[k], k).toBeTruthy(); expect(ar.purchasing[k], k).toBeTruthy() }
    for (const k of ['toleranceTitle', 'toleranceHint', 'tolerancePct', 'toleranceInvalid']) {
      expect(en.cp.setup[k], k).toBeTruthy(); expect(ar.cp.setup[k], k).toBeTruthy()
    }
  })
})

// ── the panel, rendered ─────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key) }),
}))
let matchRows = []
let matchFails = false
vi.mock('../api/supabaseClient', () => ({
  db: { vendorInvoices: { match: () => (matchFails ? Promise.reject(new Error('Not authorized')) : Promise.resolve(matchRows)) } },
}))
const { default: BillMatch } = await import('../pages/Purchasing/_BillMatch.jsx')
const renderPanel = (vi) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><BillMatch vendorInvoice={vi} fmtMoney={(n) => String(n)} /></QueryClientProvider>)
}

describe('BillMatch panel', () => {
  it('shows each line against the order, flags the mismatch and shows the reason given', async () => {
    matchFails = false
    matchRows = [
      { line_no: 0, product_name: 'Router', ordered_qty: 3, received_qty: 1, billed_qty: 1, order_unit_net: 100, billed_unit_net: 100, price_diff_pct: 0, issue: null },
      { line_no: 1, product_name: 'Cable', ordered_qty: 10, received_qty: 4, billed_qty: 4, order_unit_net: 5, billed_unit_net: 5.5, price_diff_pct: 10, issue: 'price_above' },
    ]
    renderPanel({ id: 'VI1', purchase_order_id: 'PO1', price_variance_reason: 'Copper surcharge agreed' })
    expect(await screen.findByText('purchasing.matchIssues:{"count":1}')).toBeTruthy()
    expect(screen.getByText('purchasing.matchIssue_price_above:{"pct":10}')).toBeTruthy()
    expect(screen.getByText('Copper surcharge agreed')).toBeTruthy()
    expect(screen.getByText('purchasing.matchColReceived')).toBeTruthy() // a bill from receipts shows what arrived
    cleanup()
  })
  it('is hidden for a bill with no order, and for anyone who may not see purchase prices', async () => {
    renderPanel({ id: 'VI2', purchase_order_id: null })
    expect(screen.queryByText('purchasing.matchTitle')).toBeNull()
    cleanup()
    matchFails = true
    renderPanel({ id: 'VI3', purchase_order_id: 'PO1' })
    await waitFor(() => expect(screen.queryByText('purchasing.matchTitle')).toBeNull())
    cleanup()
  })
})
