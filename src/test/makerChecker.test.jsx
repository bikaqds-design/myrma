/**
 * makerChecker.test.jsx — S-02 (20260915): the creator of a quotation, sales
 * order, invoice, purchase order or supplier invoice cannot approve it while
 * rma_config 'separation_of_duties' is on (off by default; administrators
 * exempt — owner decisions 2026-09-28), and Control Panel lists who could
 * approve their own documents.
 *
 * supabase/tests/maker_checker.sql (16 checks) is the rolled-back reference
 * script for the database half; this pins the migration's shape, the report
 * and the card.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { readFileSync } from 'node:fs'
import { sodConflicts } from '../lib/permissions'

const read = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
const SQL = read('supabase/migrations/20260915_maker_checker.sql')

describe('the migration', () => {
  it('guards the approving step of all five document types', () => {
    for (const [table, col] of [['quotations', 'status'], ['sales_orders', 'status'], ['crm_invoices', 'doc_status'],
      ['purchase_orders', 'status'], ['vendor_invoices', 'status']]) {
      expect(SQL).toContain(`CREATE TRIGGER trg_${table}_maker_checker BEFORE UPDATE OF ${col} ON public.${table}`)
    }
    expect(SQL).toContain("v_approved := NEW.doc_status = 'posted' AND OLD.doc_status IS DISTINCT FROM 'posted';")
  })

  it('is off unless switched on, exempts administrators and fails closed on a missing role', () => {
    expect(SQL).toMatch(/COALESCE\(\(SELECT lower\(c\.config_value #>> '\{\}'\) = 'true'[\s\S]*'separation_of_duties'\), false\)/)
    expect(SQL).toContain('IF COALESCE(public.rma_is_admin(), false) THEN RETURN NEW; END IF;')
    expect(SQL).toContain('IF NOT COALESCE(v_approved, false) THEN RETURN NEW; END IF;')
  })

  it('stands aside for a restore and for the database itself', () => {
    expect(SQL).toContain("IF current_setting('rma.audit_suspended', true) = 'on' THEN RETURN NEW; END IF;")
    expect(SQL).toContain("IF v_me IS NULL OR v_me = '' THEN RETURN NEW; END IF;")
  })

  it('exposes nothing to anon, and the guard to no client', () => {
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public.rma_separation_of_duties() FROM PUBLIC, anon;')
    expect(SQL).toContain('REVOKE ALL ON FUNCTION public.rma_guard_maker_checker() FROM PUBLIC, anon, authenticated;')
  })
})

describe('the conflict report', () => {
  const user = (user_email, role, permissions = null, status = 'active') => ({ user_email, role, permissions, status })

  it('a manager on the defaults can create and approve quotations, orders and invoices', () => {
    expect(sodConflicts([user('m@x', 'manager')])).toEqual([{ email: 'm@x', role: 'manager', pairs: ['quotations', 'sales_orders', 'invoices'] }])
  })

  it('an override narrows it; reps, accountants, admins and suspended users are not listed', () => {
    const list = sodConflicts([
      user('m2@x', 'manager', { sales: { approve: false } }),
      user('rep@x', 'sales_rep'),
      user('acc@x', 'accountant'),
      user('ad@x', 'admin'),
      user('old@x', 'manager', null, 'suspended'),
    ])
    expect(list).toEqual([{ email: 'm2@x', role: 'manager', pairs: ['quotations', 'invoices'] }])
  })
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, vars) => (vars && !('defaultValue' in vars) ? `${key}:${JSON.stringify(vars)}` : key) }),
}))
vi.mock('../api/supabaseClient', () => ({
  db: { userRoles: { listAllRoles: () => Promise.resolve([
    { user_email: 'mgr@x', role: 'manager', permissions: null, status: 'active' },
    { user_email: 'acc@x', role: 'accountant', permissions: null, status: 'active' },
  ]) } },
}))
const { default: SeparationOfDuties } = await import('../pages/cp/setup/SeparationOfDuties.jsx')
const wrap = (ui) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

describe('Control Panel card', () => {
  afterEach(cleanup)

  it('off: says who can approve their own documents; the switch turns it on', async () => {
    const onToggle = vi.fn()
    wrap(<SeparationOfDuties enabled={false} busy={false} onToggle={onToggle} />)
    expect(await screen.findByText(/mgr@x/)).toBeTruthy()
    expect(screen.queryByText(/acc@x/)).toBeNull()
    expect(screen.getByText('cp.setup.sodConflictsOff')).toBeTruthy()
    const sw = screen.getByRole('switch', { name: 'cp.setup.sodTitle' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('on: the same people, now held to the rule', async () => {
    wrap(<SeparationOfDuties enabled busy={false} onToggle={() => {}} />)
    expect(await screen.findByText(/mgr@x/)).toBeTruthy()
    expect(screen.getByText('cp.setup.sodConflictsOn')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'cp.setup.sodTitle' }).getAttribute('aria-checked')).toBe('true')
  })

  it('every string exists in both languages', () => {
    const en = JSON.parse(read('src/locales/en.json')).cp.setup
    const ar = JSON.parse(read('src/locales/ar.json')).cp.setup
    const keys = [...read('src/pages/cp/setup/SeparationOfDuties.jsx').matchAll(/'cp\.setup\.(sod\w+)'/g)].map((m) => m[1])
      .concat(['sodPair_quotations', 'sodPair_sales_orders', 'sodPair_invoices'])
    for (const k of keys) {
      expect(en[k], `en ${k}`).toBeTruthy()
      expect(ar[k], `ar ${k}`).toBeTruthy()
    }
  })
})
