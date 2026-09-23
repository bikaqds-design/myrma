// @vitest-environment node
/**
 * vendorInvoiceLines.test.js — W2 / L-01, sixth document type (20260889).
 *
 * Proven against a real database in supabase/tests/vendor_invoice_lines.sql
 * (34/34 on staging; with the new guard dropped, INSERT re-granted and
 * receive_vendor_invoice put back to 20260882's text, the six checks for them
 * fail) and vendor_invoice_lines_backfill.sql (7/7). Pinned here: what makes a
 * vendor invoice's figures equal its lines, receiving keeping the rows in
 * step, and the client contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260889_vendor_invoice_lines.sql', 'utf8')

function fn(name) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(')
  expect(start, name + ' not found').toBeGreaterThan(-1)
  const open = sql.indexOf('AS $', start)
  const tag = sql.slice(open + 3, sql.indexOf('$', open + 4) + 1)
  return sql.slice(start, sql.indexOf(tag + ';', open + 3 + tag.length))
}

describe('the vendor_invoice_lines table', () => {
  it('references its invoice and a real product; what was received stays within what was ordered', () => {
    expect(sql).toMatch(/vendor_invoice_id\s+uuid NOT NULL REFERENCES public\.vendor_invoices\(id\) ON DELETE CASCADE/)
    for (const c of ['qty_ordered >= 1', 'qty_received >= 0 AND qty_received <= qty_ordered', 'unit_cost >= 0', 'UNIQUE (vendor_invoice_id, line_no)']) {
      expect(sql, c).toContain(c)
    }
  })

  it('is readable exactly when its invoice is, and written only by the RPCs', () => {
    expect(sql).toContain('USING (EXISTS (SELECT 1 FROM public.vendor_invoices v WHERE v.id = vendor_invoice_lines.vendor_invoice_id))')
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.vendor_invoice_lines FROM authenticated')
  })
})

describe('the figures are the lines', () => {
  it('no client can INSERT an invoice or write its lines or totals directly', () => {
    expect(sql).toContain('REVOKE INSERT ON TABLE public.vendor_invoices FROM authenticated')
    const g = fn('rma_guard_vendor_invoice_allowlist')
    expect(g).toMatch(/current_user NOT IN \('authenticated', 'anon'\)/)
    expect(g).toContain("ARRAY['status', 'approved_at', 'duplicate_override_reason',")
    expect(g).toContain("a.attgenerated <> ''")
    expect(g).toMatch(/IF \(to_jsonb\(NEW\) - v_open\) IS DISTINCT FROM \(to_jsonb\(OLD\) - v_open\) THEN\s+RAISE EXCEPTION/)
  })

  it('a client cannot set received, and each open column belongs to its own step (review)', () => {
    const g = fn('rma_guard_vendor_invoice_allowlist')
    expect(g).toContain("NEW.status IN ('partially_received', 'received')")
    expect(g).toContain("NEW.duplicate_override_reason IS DISTINCT FROM OLD.duplicate_override_reason AND OLD.status <> 'draft'")
    expect(g).toContain("AND NOT (OLD.status = 'pending_approval' AND NEW.status = 'approved')")
  })

  it('a supplier number of only invisible spaces is no number', () => {
    expect(fn('create_vendor_invoice')).toContain("COALESCE(public.rma_norm_supplier_no(v_f->>'supplier_invoice_no'), '') = ''")
  })

  it('totals come from the rows as stored', () => {
    expect(fn('_vendor_invoice_write_lines')).toContain('FROM public.vendor_invoice_lines l WHERE l.vendor_invoice_id = p_vi_id) b')
  })

  it('the internals are not client-callable', () => {
    for (const sig of ['_vendor_invoice_write_lines(uuid, jsonb)', '_vendor_invoice_check_fields(jsonb)', '_vendor_invoice_assert_supplier_no(public.vendor_invoices)']) {
      expect(sql, sig).toContain('REVOKE ALL ON FUNCTION public.' + sig + ' FROM PUBLIC, anon, authenticated')
    }
  })
})

describe('create, update and convert', () => {
  it('are manager+ (manager_write_vendor_invoices), COALESCE-wrapped, actor from the login only', () => {
    for (const name of ['create_vendor_invoice', 'update_vendor_invoice', 'convert_po_to_vendor_invoice']) {
      const body = fn(name)
      expect(body, name).toContain('COALESCE(public.rma_is_manager_or_above(), false)')
      expect(body, name).toMatch(/v_actor\s+text := public\.rma_current_user_email\(\);/)
    }
  })

  it('refuse a repeated supplier number by name BEFORE the write, so the unique index never answers first', () => {
    const c = fn('create_vendor_invoice')
    expect(c.indexOf('_vendor_invoice_assert_supplier_no(v_probe)')).toBeLessThan(c.indexOf('INSERT INTO public.vendor_invoices'))
    const u = fn('update_vendor_invoice')
    expect(u.indexOf('_vendor_invoice_assert_supplier_no(v_vi)')).toBeLessThan(u.indexOf('UPDATE public.vendor_invoices SET'))
  })

  it('update edits a draft only', () => {
    expect(fn('update_vendor_invoice')).toContain("IF v_vi.status <> 'draft' THEN")
  })

  it('convert locks the order first, takes its currency and rate, and allows one live invoice', () => {
    const c = fn('convert_po_to_vendor_invoice')
    expect(c.indexOf('FOR UPDATE')).toBeLessThan(c.indexOf("status <> 'cancelled'"))
    expect(c).toContain('v_po.currency, v_po.exchange_rate')
    expect(c).toContain("IF v_po.status NOT IN ('confirmed', 'partially_completed') THEN")
  })
})

describe('receive_vendor_invoice', () => {
  it('is 20260882\'s function plus exactly one block that moves the rows with the mirror', () => {
    const base = readFileSync('supabase/migrations/20260882_costing_cleanup.sql', 'utf8').replace(/\r\n/g, '\n')
    const a = base.indexOf('CREATE OR REPLACE FUNCTION public.receive_vendor_invoice(')
    const old = base.slice(a, base.indexOf('\n$$;', a) + 4)
    const now = fn('receive_vendor_invoice').replace(/\r\n/g, '\n') + '$$;'
    const block = now.slice(now.indexOf('  -- The rows move with the mirror'), now.indexOf('  IF v_vi.purchase_order_id IS NOT NULL THEN\n    SELECT status INTO v_po_status'))
    expect(block).toContain('SET qty_received = l.qty_received + (v_taken->>(l.line_no::text))::integer')
    expect(now.replace(block, '')).toBe(old)
  })
})

describe('the backfill', () => {
  it('its probe runs the migration text, byte for byte', () => {
    const probe = readFileSync('supabase/tests/vendor_invoice_lines_backfill.sql', 'utf8').replace(/\r\n/g, '\n')
    const begin = '-- BEGIN copy of 20260889 sections 9-10\n'
    const copy = probe.slice(probe.indexOf(begin) + begin.length, probe.indexOf('-- END copy of 20260889 sections 9-10'))
    const m = sql.replace(/\r\n/g, '\n')
    const section = m.slice(m.indexOf('CREATE OR REPLACE FUNCTION pg_temp.vi_bf_num'), m.indexOf('-- ── guard ─'))
    expect(copy.length).toBeGreaterThan(1000)
    expect(copy).toBe(section)
  })

  it('keeps what was received within what was ordered, and re-syncs only DRAFTS', () => {
    expect(sql).toContain('LEAST(v_q, GREATEST(0, round(v_rec)))::integer')
    expect(sql).toContain("WHERE i.id = r.id AND i.status = 'draft'")
  })
})

// ── the browser client ──────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({ rpc: [], writes: [], result: { data: { id: 'vi1' }, error: null } }))

vi.mock('../api/client.js', () => ({
  supabase: {
    rpc: (name, args) => {
      mocks.rpc.push({ name, args })
      return Promise.resolve(mocks.result)
    },
    from: (table) => {
      mocks.writes.push(table)
      const c = { insert: () => c, update: () => c, eq: () => c, select: () => Promise.resolve({ data: [{ id: 'x' }], error: null }), single: () => Promise.resolve({ data: { id: 'po1', line_items: [] }, error: null }) }
      return c
    },
  },
}))

const { vendorInvoices, purchaseOrders } = await import('../api/db/purchasing')

describe('vendorInvoices / convert client', () => {
  beforeEach(() => {
    mocks.rpc.length = 0
    mocks.writes.length = 0
    mocks.result = { data: { id: 'vi1' }, error: null }
  })
  const lines = [{ product_id: 'p1', product_name: 'Cable', qty_ordered: 2, unit_cost: 10 }]

  it('creates through create_vendor_invoice — no direct insert, no totals from the browser', async () => {
    await vendorInvoices.create({ vendorId: 'v1', lineItems: lines, currency: 'EGP', supplierInvoiceNo: 'A-1', createdBy: 'a@b.c' })
    expect(mocks.writes).toEqual([])
    expect(mocks.rpc[0].name).toBe('create_vendor_invoice')
    expect(mocks.rpc[0].args).toMatchObject({ p_vendor_id: 'v1', p_lines: lines, p_fields: { currency: 'EGP', exchange_rate: 1, supplier_invoice_no: 'A-1' } })
    expect(JSON.stringify(mocks.rpc[0].args)).not.toMatch(/subtotal|"total"|purchase_order_id/)
  })

  it('updates through update_vendor_invoice, sending only the fields given', async () => {
    await vendorInvoices.update('vi1', { notes: null, due_date: '2026-10-31' }, 'a@b.c')
    expect(mocks.writes).toEqual([])
    expect(mocks.rpc[0]).toEqual({
      name: 'update_vendor_invoice',
      args: { p_id: 'vi1', p_lines: null, p_fields: { notes: null, due_date: '2026-10-31' }, p_actor_email: 'a@b.c' },
    })
  })

  it('converts a purchase order in one call — no read-then-insert in the browser', async () => {
    await purchaseOrders.convertToVendorInvoice('po1', 'a@b.c')
    expect(mocks.writes).toEqual([])
    expect(mocks.rpc).toEqual([{ name: 'convert_po_to_vendor_invoice', args: { p_po_id: 'po1', p_actor_email: 'a@b.c' } }])
  })

  it('throws the database refusal', async () => {
    mocks.result = { data: null, error: { code: 'P0001', message: 'A vendor invoice has already been raised against this order' } }
    await expect(purchaseOrders.convertToVendorInvoice('po1', 'a@b.c')).rejects.toMatchObject({ code: 'P0001' })
  })
})
