// @vitest-environment node
/**
 * purchaseOrderLines.test.js — W2 / L-01, fifth document type (20260888).
 *
 * Proven against a real database in supabase/tests/purchase_order_lines.sql
 * (30/30 on staging; with the new guard dropped and INSERT re-granted, the
 * three checks it exists for fail) and purchase_order_lines_backfill.sql (8/8).
 * Pinned here: what makes a purchase order's figures equal its lines, and the
 * client contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260888_purchase_order_lines.sql', 'utf8')

function fn(name) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(')
  expect(start, name + ' not found').toBeGreaterThan(-1)
  return sql.slice(start, sql.indexOf('$function$;', sql.indexOf('AS $function$', start)))
}

describe('the purchase_order_lines table', () => {
  it('references its order and a real product, with per-line checks', () => {
    expect(sql).toMatch(/purchase_order_id\s+uuid NOT NULL REFERENCES public\.purchase_orders\(id\) ON DELETE CASCADE/)
    expect(sql).toMatch(/product_id\s+uuid REFERENCES public\.products\(id\)/)
    for (const c of ['qty_ordered >= 1', 'unit_cost >= 0', 'UNIQUE (purchase_order_id, line_no)']) expect(sql, c).toContain(c)
  })

  it('is readable exactly when its order is, and written only by the RPCs', () => {
    expect(sql).toContain('USING (EXISTS (SELECT 1 FROM public.purchase_orders o WHERE o.id = purchase_order_lines.purchase_order_id))')
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.purchase_order_lines FROM authenticated')
  })
})

describe('the figures are the lines', () => {
  it('no client can INSERT an order or write its lines or totals directly', () => {
    expect(sql).toContain('REVOKE INSERT ON TABLE public.purchase_orders FROM authenticated')
    const g = fn('rma_guard_purchase_order_allowlist')
    expect(g).toMatch(/current_user NOT IN \('authenticated', 'anon'\)/)
    expect(g).toContain("v_open text[] := ARRAY['status', 'archived', 'archived_at', 'archived_by', 'updated_at']")
    expect(g).toContain("a.attgenerated <> ''")
    expect(g).toMatch(/IF \(to_jsonb\(NEW\) - v_open\) IS DISTINCT FROM \(to_jsonb\(OLD\) - v_open\) THEN\s+RAISE EXCEPTION/)
  })

  it('totals come from the rows as stored', () => {
    expect(fn('_purchase_order_write_lines')).toContain('FROM public.purchase_order_lines l WHERE l.purchase_order_id = p_po_id) b')
  })

  it('every line is a catalogue product with a whole quantity', () => {
    const w = fn('_purchase_order_write_lines')
    expect(w).toContain('a purchase order line must be a catalogue product')
    expect(w).toContain("IF v_qty !~ '^[0-9]{1,9}$' OR v_qty::integer < 1 THEN")
  })

  it('the internals are not client-callable', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public._purchase_order_write_lines(uuid, jsonb) FROM PUBLIC, anon, authenticated')
    expect(sql).toContain('REVOKE ALL ON FUNCTION public._purchase_order_check_fields(jsonb, text[]) FROM PUBLIC, anon, authenticated')
  })
})

describe('create, update and amend', () => {
  it('are manager+ (manager_write_purchase_orders), COALESCE-wrapped, actor from the login only', () => {
    for (const name of ['create_purchase_order', 'update_purchase_order', 'amend_purchase_order']) {
      const body = fn(name)
      expect(body, name).toContain('COALESCE(public.rma_is_manager_or_above(), false)')
      expect(body, name).toMatch(/v_actor\s+text := public\.rma_current_user_email\(\);/)
      expect(body, name).not.toContain('p_actor_email)')
    }
  })

  it('update edits a draft only — a sent or pending order awaits confirmation of exactly these figures', () => {
    expect(fn('update_purchase_order')).toContain("IF v_po.status <> 'draft' THEN")
  })

  it('amend writes the rows and judges a new price against the old rows', () => {
    const a = fn('amend_purchase_order')
    expect(a).toContain("FROM public._purchase_order_write_lines(p_po_id, p_changes -> 'line_items') w")
    expect(a).toContain('INTO v_old FROM public.purchase_order_lines l WHERE l.purchase_order_id = p_po_id')
    // typed comparison: jsonb array containment is recursive and would match a partial tuple
    expect(a).toContain("(o->>'t')::numeric = l.tax_pct")
    expect(a).not.toContain('v_old @>')
  })
})

describe('the backfill', () => {
  it('its probe runs the migration text, byte for byte', () => {
    const probe = readFileSync('supabase/tests/purchase_order_lines_backfill.sql', 'utf8').replace(/\r\n/g, '\n')
    const begin = '-- BEGIN copy of 20260888 sections 8-9\n'
    const copy = probe.slice(probe.indexOf(begin) + begin.length, probe.indexOf('-- END copy of 20260888 sections 8-9'))
    const m = sql.replace(/\r\n/g, '\n')
    const section = m.slice(m.indexOf('CREATE OR REPLACE FUNCTION pg_temp.po_bf_num'), m.indexOf('-- ── guard ─'))
    expect(copy.length).toBeGreaterThan(1000)
    expect(copy).toBe(section)
  })

  it('re-syncs only DRAFTS', () => {
    expect(sql).toContain("WHERE o.id = r.id AND o.status = 'draft'")
  })
})

// ── the browser client ──────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({ rpc: [], writes: [], result: { data: { id: 'po1' }, error: null } }))

vi.mock('../api/client.js', () => ({
  supabase: {
    rpc: (name, args) => {
      mocks.rpc.push({ name, args })
      return Promise.resolve(mocks.result)
    },
    from: (table) => {
      mocks.writes.push(table)
      const c = { insert: () => c, update: () => c, eq: () => c, select: () => Promise.resolve({ data: [{ id: 'po1' }], error: null }) }
      return c
    },
  },
}))

const { purchaseOrders } = await import('../api/db/purchasing')

describe('purchaseOrders client', () => {
  beforeEach(() => {
    mocks.rpc.length = 0
    mocks.writes.length = 0
    mocks.result = { data: { id: 'po1' }, error: null }
  })
  const lines = [{ product_id: 'p1', product_name: 'Router', qty_ordered: 2, unit_cost: 10 }]

  it('creates through create_purchase_order — no direct insert, no code or totals from the browser', async () => {
    await purchaseOrders.create({ vendorId: 'v1', lineItems: lines, currency: 'EGP', notes: 'n', createdBy: 'a@b.c' })
    expect(mocks.writes).toEqual([])
    expect(mocks.rpc.map((c) => c.name)).toEqual(['create_purchase_order'])
    expect(mocks.rpc[0].args).toMatchObject({ p_vendor_id: 'v1', p_lines: lines, p_fields: { currency: 'EGP', exchange_rate: 1, notes: 'n' } })
    expect(JSON.stringify(mocks.rpc[0].args)).not.toMatch(/subtotal|"total"/)
  })

  it('updates through update_purchase_order, sending only the fields given', async () => {
    await purchaseOrders.update('po1', { notes: null, delivery_terms: 'FOB' }, 'a@b.c')
    expect(mocks.writes).toEqual([])
    expect(mocks.rpc[0]).toEqual({
      name: 'update_purchase_order',
      args: { p_id: 'po1', p_lines: null, p_fields: { notes: null, delivery_terms: 'FOB' }, p_actor_email: 'a@b.c' },
    })
  })

  it('throws the database refusal', async () => {
    mocks.result = { data: null, error: { code: 'P0001', message: 'This purchase order is sent and can no longer be edited' } }
    await expect(purchaseOrders.update('po1', { notes: 'x' })).rejects.toMatchObject({ code: 'P0001' })
  })
})
