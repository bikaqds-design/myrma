// @vitest-environment node
/**
 * salesOrderLifecycle.test.js — BL-04 / I-04.
 *
 * The behaviour is proven against a real database in
 * supabase/tests/sales_order_lifecycle.sql (61/61 on staging, and 24 of its
 * checks failed before 20260879 existed). What is pinned here is what that
 * reference script cannot do in CI: that the migration keeps the properties
 * that make each fix hold, and that the browser client agrees with them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const migration = readFileSync('supabase/migrations/20260879_sales_order_lifecycle.sql', 'utf8')

/** The body of one CREATE OR REPLACE FUNCTION, so an assertion cannot be met by a comment elsewhere. */
function fn(name) {
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(')
  expect(start, name + ' not found').toBeGreaterThan(-1)
  const end = migration.indexOf('$function$;', migration.indexOf('AS $function$', start))
  return migration.slice(start, end)
}

describe('reject_sales_order', () => {
  const body = fn('reject_sales_order')

  it('locks the row and refuses anything but an order awaiting approval', () => {
    expect(body).toMatch(/FOR UPDATE/)
    expect(body).toMatch(/v_so\.status <> 'sent'/)
  })

  it('never writes a status without having checked the current one', () => {
    expect(body.indexOf("v_so.status <> 'sent'")).toBeLessThan(body.indexOf("SET status = 'declined'"))
  })
})

describe('cancel_sales_order', () => {
  const body = fn('cancel_sales_order')

  it('releases bulk reservations as well as serialized units, before the status changes', () => {
    expect(body).toContain("release_units('sales_order'")
    expect(body).toContain("release_warehouse_stock('sales_order'")
    expect(body.indexOf('release_warehouse_stock')).toBeLessThan(body.indexOf("SET status = 'cancelled'"))
  })
})

describe('approve_sales_order', () => {
  const body = fn('approve_sales_order')

  it('confirms; it does not claim a delivery', () => {
    expect(body).toContain("status       = 'confirmed'")
    // Comments in the function talk about delivery; the UPDATE must not set it.
    const update = body.slice(body.indexOf('UPDATE public.sales_orders'))
    expect(update).not.toMatch(/delivered_at/)
    expect(update).not.toMatch(/status\s*=\s*'delivered'/)
  })

  it('refuses a line with no usable quantity instead of skipping it', () => {
    expect(body).toContain('has no valid quantity')
  })

  it('judges the quantity as text BEFORE casting it', () => {
    // NaN and Infinity are valid numerics that pass a range test, and "abc"
    // would escape as a raw cast error rather than the clear message.
    expect(body.indexOf('!~')).toBeGreaterThan(-1)
    expect(body.indexOf('!~')).toBeLessThan(body.indexOf('::numeric'))
  })
})

describe('the invoice precondition', () => {
  it('is enforced by a trigger, not only by the browser', () => {
    expect(migration).toMatch(/CREATE TRIGGER trg_crm_invoices_from_approved_order\s+BEFORE INSERT OR UPDATE OF so_id ON public\.crm_invoices/)
    expect(fn('rma_sales_order_can_be_invoiced')).toMatch(/v_status IN \('confirmed', 'delivered'\)/)
  })

  it('polices the client surface only, with no administrator exemption', () => {
    // Backup & Restore is rma_restore_apply, a SECURITY DEFINER RPC (the owner),
    // so an admin needs no bypass. Keeping one would let an admin invoice a
    // declined or cancelled order from the UI.
    const body = fn('rma_guard_invoice_from_order')
    expect(body).toMatch(/current_user NOT IN \('authenticated', 'anon'\)/)
    expect(body).not.toMatch(/rma_is_admin/)
  })

  it('stays SECURITY INVOKER: inside a definer function current_user is the owner and the client test would never fire', () => {
    // The function's HEADER (its attributes), not its body: the body's comments mention it.
    const whole = fn('rma_guard_invoice_from_order')
    const header = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.rma_guard_invoice_from_order('),
      migration.indexOf('AS $function$', migration.indexOf('CREATE OR REPLACE FUNCTION public.rma_guard_invoice_from_order(')))
    expect(whole.length).toBeGreaterThan(0)
    expect(header).not.toMatch(/SECURITY DEFINER/)
  })

  it('looks the order up through a definer helper, because a sales rep cannot read another rep\'s order', () => {
    // A lookup run as the caller saw "not found" for a colleague's draft and let
    // the invoice through -- for the one non-manager role that can insert one.
    const helper = fn('rma_sales_order_can_be_invoiced')
    expect(helper).toMatch(/SECURITY DEFINER/)
    expect(helper).toMatch(/FOR SHARE/)
    expect(fn('rma_guard_invoice_from_order')).toContain('rma_sales_order_can_be_invoiced(NEW.so_id)')
  })
})

describe('document codes', () => {
  it('never pulls a counter back to an earlier year, and uses the wall clock', () => {
    const body = fn('nextval_for_type')
    expect(body).toContain('clock_timestamp()')
    expect(body).toMatch(/seq_year\s*=\s*GREATEST\(seq_year, v_clock\)/)
    expect(body).toMatch(/RETURNING last_value, seq_year INTO v_next, v_year/)
  })

  it('maps QT, SO and PO to their own sequences', () => {
    const body = fn('generate_doc_code')
    expect(body).toMatch(/WHEN 'QT' THEN 'quotation'/)
    expect(body).toMatch(/WHEN 'SO' THEN 'sales_order'/)
    expect(body).toMatch(/WHEN 'PO' THEN 'purchase_order'/)
  })

  it('creates a missing sequence row without ever resetting a running one', () => {
    const body = fn('generate_doc_code')
    expect(body).toMatch(/ON CONFLICT \(seq_type\) DO NOTHING/)
    expect(body).not.toMatch(/DO UPDATE/)
  })

  it('keeps the existing prefixes for invoices, credit notes, payments and vendor documents', () => {
    const body = fn('nextval_for_type')
    for (const [type, prefix] of [
      ['invoice', 'INV'],
      ['credit_note', 'CN'],
      ['payment', 'PAY'],
      ['vendor_invoice', 'VI'],
      ['vendor_payment', 'VP'],
    ]) {
      expect(body).toContain(`WHEN '${type}'`)
      expect(body).toContain(`THEN '${prefix}'`)
    }
  })

  it('does not let a viewer consume numbers, and fails closed on a role-less caller', () => {
    expect(fn('generate_doc_code')).toMatch(/COALESCE\(\(public\.rma_is_staff\(\) AND public\.rma_user_role\(\) <> 'viewer'\), false\)/)
  })
})

describe('every function the migration adds or replaces', () => {
  it('pins pg_temp last in search_path', () => {
    for (const name of [
      'reject_sales_order',
      'cancel_sales_order',
      'approve_sales_order',
      'rma_guard_invoice_from_order',
      'rma_sales_order_can_be_invoiced',
      'nextval_for_type',
      'generate_doc_code',
      'rma_reservation_integrity',
      'rma_data_integrity_issues',
    ]) {
      expect(fn(name), name).toMatch(/SET search_path TO 'public', 'pg_temp'/)
    }
  })

  it('does not leave the two new report functions executable by anon', () => {
    // The production security-invariant count of anon-executable functions is
    // pinned at 2 (tests/integration/security-invariants.test.ts).
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.rma_reservation_integrity\(\) FROM PUBLIC, anon/)
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.rma_data_integrity_issues\(\) FROM PUBLIC, anon/)
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.rma_guard_invoice_from_order\(\) FROM PUBLIC, anon/)
  })
})

describe('the integrity reports', () => {
  it('count a product with no type as stockable, like funnel_reserve_line does', () => {
    expect(fn('rma_reservation_integrity')).toContain("p.product_type IS DISTINCT FROM 'service'")
  })

  it('do not report an order whose invoice was voided', () => {
    // void_invoice leaves the order confirmed with nothing held: the documented normal state.
    const body = fn('rma_reservation_integrity')
    expect(body).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.crm_invoices i WHERE i\.so_id = so\.id\)/)
  })

  it('are for administrators, and a JWT-less job (owner / service_role) still passes', () => {
    for (const name of ['rma_reservation_integrity', 'rma_data_integrity_issues']) {
      const body = fn(name)
      expect(body, name).toMatch(/auth\.role\(\) IN \('authenticated', 'anon'\)/)
      expect(body, name).toMatch(/NOT COALESCE\(public\.rma_is_admin\(\), false\)/)
    }
  })

  it('close the raw findings function to clients', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.rma_data_integrity_issues_unguarded\(\) FROM PUBLIC, anon, authenticated/)
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.rma_data_integrity_issues_unguarded\(\) TO service_role/)
  })
})

// ── The browser client agrees ───────────────────────────────────────────────
const mocks = vi.hoisted(() => ({ so: null, inserted: [] }))

vi.mock('../api/client.js', () => ({
  supabase: {
    rpc: vi.fn(),
    from: (table) => {
      if (table === 'sales_orders') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: mocks.so, error: null }), single: () => Promise.resolve({ data: mocks.so, error: null }) }) }) }
      }
      if (table === 'crm_invoices') {
        return {
          select: () => ({ eq: () => ({ neq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }),
          insert: (row) => {
            mocks.inserted.push(row)
            return { select: () => ({ single: () => Promise.resolve({ data: { id: 'inv-1' }, error: null }) }) }
          },
        }
      }
      throw new Error('unexpected table ' + table)
    },
  },
}))

const { salesOrders } = await import('../api/db/salesOrders')

describe('salesOrders.convertToInvoice', () => {
  beforeEach(() => {
    mocks.inserted.length = 0
  })

  const so = (status) => ({ id: 'so-1', status, customer_id: 'c1', line_items: [], subtotal: 0, discount_amount: 0, tax_amount: 0, total: 0 })

  it.each(['draft', 'sent', 'accepted', 'declined', 'cancelled'])('refuses a %s order before any insert', async (status) => {
    mocks.so = so(status)
    await expect(salesOrders.convertToInvoice('so-1', 'a@b.c')).rejects.toThrow()
    expect(mocks.inserted).toEqual([])
  })

  it('explains what to do, rather than surfacing a database error', async () => {
    mocks.so = so('sent')
    await expect(salesOrders.convertToInvoice('so-1', 'a@b.c')).rejects.toThrow(/Approve the sales order before invoicing/)
  })

  it.each(['confirmed', 'delivered'])('lets a %s order through', async (status) => {
    mocks.so = so(status)
    await salesOrders.convertToInvoice('so-1', 'a@b.c').catch(() => {})
    expect(mocks.inserted.length).toBe(1)
  })
})
