// P-04b (20260901): paying for goods that have not arrived is a prepayment, and
// supplier payments can wait for a second manager. Pins the shape of the
// migration and the screens; the behavioural reference is
// supabase/tests/vendor_payment_controls.sql (staging, rolled back).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const sql = readFileSync('supabase/migrations/20260901_vendor_payment_controls.sql', 'utf8')
const fn = (name) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return sql.slice(start, sql.indexOf('$fn$;', start))
}
const src = (p) => readFileSync(p, 'utf8')

describe('20260901 vendor payment controls', () => {
  it('goods outstanding = a stock line received less than billed and not billed from a receipt', () => {
    const f = fn('rma_vi_goods_outstanding')
    expect(f).toContain("COALESCE(p.product_type, 'hardware') <> 'service'")
    expect(f).toContain('COALESCE(l.qty_received, 0) < l.qty_ordered')
    expect(f).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.vendor_invoice_receipt_lines k/)
  })

  it('recording and applying both refuse paying for outstanding goods unless it is a prepayment', () => {
    const alloc = fn('_vendor_payment_allocate')
    expect(alloc).toMatch(/IF NOT COALESCE\(p_is_prepayment, false\) AND public\.rma_vi_goods_outstanding\(v_inv\.id\) THEN/)
    // the apply RPC gets the same rule, inserted exactly once before its INSERT
    expect(sql).toContain('EXECUTE replace(v_def, v_old, v_ins || v_old)')
    expect(sql).toContain('<> 1 THEN')
    expect(sql).toContain('AND public.rma_vi_goods_outstanding(p_invoice_id) THEN')
  })

  it('with approval on, a payment is stored pending: no number, nothing applied, allocations kept', () => {
    const rec = fn('record_vendor_payment')
    expect(rec).toContain("CASE WHEN v_pending THEN NULL ELSE public.nextval_for_type('vendor_payment') END")
    expect(rec).toContain("CASE WHEN v_pending THEN 'pending_approval' ELSE 'active' END")
    // checked at once even when pending, applied only when not
    expect(rec).toMatch(/COALESCE\(p_is_prepayment, false\), v_actor, NOT v_pending\)/)
    expect(fn('rma_vendor_payment_approval_required')).toMatch(/COALESCE\([\s\S]*'vendor_payment_approval'\), false\)/)
  })

  it('approval: a manager who did not record it, pending only, allocations checked again', () => {
    const ap = fn('approve_vendor_payment')
    expect(ap).toContain('v_actor IS NULL OR NOT COALESCE(public.rma_is_manager_or_above(), false)')
    expect(ap).toContain("v_pay.status <> 'pending_approval'")
    expect(ap).toContain('lower(v_actor) = lower(v_pay.created_by)')
    expect(ap).toMatch(/_vendor_payment_allocate\([\s\S]*v_pay\.pending_allocations, v_pay\.is_prepayment, v_actor, true\)/)
  })

  it('no client calls the allocator, and anon reaches nothing new', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\._vendor_payment_allocate\([^)]*\) FROM PUBLIC, anon, authenticated;/)
    for (const f of ['rma_vendor_payment_approval_required()', 'rma_vi_goods_outstanding(uuid)', 'approve_vendor_payment(uuid, text)']) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon;`)
    }
    // the rebuilt list view would otherwise be granted to anon by default privileges
    expect(sql).toContain('REVOKE ALL ON public.v_vendor_payments_list FROM PUBLIC, anon;')
    expect(sql).toMatch(/CHECK \(status IN \('pending_approval', 'active', 'voided'\)\)/)
  })

  it('the client sends the flag, approves by RPC and names a bill without our code by the supplier number', () => {
    const api = src('src/api/db/vendorPayments.ts')
    expect(api).toContain('p_is_prepayment: input.isPrepayment ?? false')
    expect(api).toContain("supabase.rpc('approve_vendor_payment'")
    expect(src('src/pages/Purchasing/_modals.jsx')).toContain("{inv.vi_code || inv.supplier_invoice_no || '—'}")
    // the recorder is not offered their own approval (the database refuses it too)
    expect(src('src/pages/Accounting/index.jsx')).toMatch(/\(p\.created_by \|\| ''\)\.toLowerCase\(\) !== \(currentUserEmail \|\| ''\)\.toLowerCase\(\)/)
  })
})

// ── the Control Panel switch ─────────────────────────────────────────────────
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k) => k }) }))
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../lib/sentry', () => ({ captureException: vi.fn() }))

const cfg = { value: false, writes: [], hold: null }
vi.mock('../api/supabaseClient', () => ({
  db: {
    rmaConfig: {
      getAll: async () => {
        if (cfg.hold) await cfg.hold
        return { missing: false, data: [{ config_key: 'vendor_payment_approval', config_value: cfg.value }] }
      },
      set: async (key, value) => {
        if (key === 'vendor_payment_approval') { cfg.writes.push(value); cfg.value = value }
      },
    },
  },
}))

describe('Supplier payment approval switch', () => {
  afterEach(() => { cleanup(); cfg.value = false; cfg.writes = []; cfg.hold = null })

  it('turns off on the second click, even one made while the saved value is being re-read', async () => {
    const { default: RegionalSettings } = await import('../pages/cp/setup/RegionalSettings')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><RegionalSettings currentUserEmail="m@x.test" /></QueryClientProvider>)
    const sw = await screen.findByRole('switch', { name: 'cp.setup.vpApprovalTitle' })
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'))

    // Hold the re-read open: the write has landed, the screen has not heard yet.
    let release
    cfg.hold = new Promise((r) => { release = r })
    fireEvent.click(sw)
    await waitFor(() => expect(cfg.writes).toEqual([true]))
    fireEvent.click(sw) // must not write the stale "off → on" again
    expect(cfg.writes).toEqual([true])

    cfg.hold = null
    await act(async () => { release() })
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'))
    await waitFor(() => expect(sw).not.toBeDisabled())
    fireEvent.click(sw)
    await waitFor(() => expect(cfg.writes).toEqual([true, false]))
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'))
  })
})
