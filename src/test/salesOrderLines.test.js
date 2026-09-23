// @vitest-environment node
/**
 * salesOrderLines.test.js — W2 / L-01, second document type (20260884).
 *
 * Proven against a real database in supabase/tests/sales_order_lines.sql
 * (37/37 on staging; with the new guard dropped and INSERT re-granted, the
 * three checks it exists for fail, and the review-finding checks fail against
 * the pre-fix migration) and sales_order_lines_backfill.sql (9/9).
 * Pinned here: what makes a sales order's lines guarded, and the client
 * contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260884_sales_order_lines.sql', 'utf8')

function fn(name) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(')
  expect(start, name + ' not found').toBeGreaterThan(-1)
  return sql.slice(start, sql.indexOf('$function$;', sql.indexOf('AS $function$', start)))
}

describe('the sales_order_lines table', () => {
  it('references its order and the real product, with per-line checks', () => {
    expect(sql).toMatch(/sales_order_id\s+uuid NOT NULL REFERENCES public\.sales_orders\(id\) ON DELETE CASCADE/)
    expect(sql).toMatch(/product_id\s+uuid REFERENCES public\.products\(id\)/)
    for (const c of ['qty >= 1', 'unit_price >= 0', 'discount_pct >= 0 AND discount_pct <= 100', 'UNIQUE (sales_order_id, line_no)']) {
      expect(sql, c).toContain(c)
    }
  })

  it('is readable exactly when its order is, and written by nobody but the RPCs', () => {
    expect(sql).toContain('USING (EXISTS (SELECT 1 FROM public.sales_orders o WHERE o.id = sales_order_lines.sales_order_id))')
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.sales_order_lines FROM authenticated')
  })
})

describe('the client surface of sales_orders', () => {
  it('cannot INSERT an order, so none can be linked to a quotation past convert_quotation_to_so', () => {
    expect(sql).toContain('REVOKE INSERT ON TABLE public.sales_orders FROM authenticated')
    expect(fn('create_sales_order')).not.toContain('quotation_id')
  })

  it('refuses any direct update beyond status and the archive flag — a confirmed order holds stock for its lines', () => {
    const body = fn('rma_guard_sales_order_client_writes')
    expect(body).toMatch(/current_user NOT IN \('authenticated', 'anon'\)/)
    expect(body).toContain("v_open text[] := ARRAY['status', 'archived', 'archived_at', 'archived_by', 'updated_at']")
    expect(body).toMatch(/IF \(to_jsonb\(NEW\) - v_open\) IS DISTINCT FROM \(to_jsonb\(OLD\) - v_open\) THEN\s+RAISE EXCEPTION/)
  })
})

describe('writing the lines', () => {
  const body = fn('_sales_order_write_lines')

  it('requires every line to be an existing catalogue product, whose name fills a missing one', () => {
    expect(body).toContain('a sales order line must be a catalogue product')
    expect(body).toContain('that product does not exist')
    expect(body).toContain("v_name := COALESCE(NULLIF(v_name, ''), NULLIF(btrim(v_cat), ''), '(unnamed product)')")
  })

  it('computes totals from the rows as stored', () => {
    expect(body).toContain('FROM public.sales_order_lines l WHERE l.sales_order_id = p_so_id) b')
  })

  it('is internal', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public._sales_order_write_lines(uuid, jsonb) FROM PUBLIC, anon, authenticated')
  })
})

describe('create_sales_order and update_sales_order', () => {
  it('follow the policies they replace (20260781), COALESCE-wrapped, with the actor from the login', () => {
    expect(fn('create_sales_order')).toContain("IF NOT COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep', false) THEN")
    const upd = fn('update_sales_order')
    expect(upd).toMatch(/AND \(v_so\.assigned_rep = v_actor OR v_so\.created_by = v_actor\)\s+AND \(v_rep = v_actor OR v_so\.created_by = v_actor\)\),\s+false\) THEN/)
    for (const name of ['create_sales_order', 'update_sales_order']) {
      expect(fn(name), name).toMatch(/v_actor\s+text := public\.rma_current_user_email\(\)/)
    }
  })

  it('edit a draft only', () => {
    expect(fn('update_sales_order')).toContain("IF v_so.status <> 'draft' THEN")
  })

  it('never change the products, quantities or prices of an order converted from a quotation', () => {
    const upd = fn('update_sales_order')
    expect(upd).toContain('IF v_so.quotation_id IS NOT NULL AND p_lines IS NOT NULL THEN')
    expect(upd).toContain('IF v_new IS DISTINCT FROM v_old THEN')
    expect(upd).toContain('converted from a quotation')
  })

  it('set only the fields sent, and keep the lines when none are sent', () => {
    const upd = fn('update_sales_order')
    expect(upd).toContain("v_allowed text[] := ARRAY['delivery_date', 'payment_terms', 'reference_po', 'notes', 'assigned_rep']")
    expect(upd).toMatch(/IF p_lines IS NOT NULL THEN\s+SELECT w\.line_items/)
  })
})

describe('convert_quotation_to_so', () => {
  const body = fn('convert_quotation_to_so')

  it("builds the order's rows from the quotation's rows (raw line_items only as a fallback), right after creating it", () => {
    const insert = body.indexOf('RETURNING id INTO v_so_id;')
    expect(insert).toBeGreaterThan(-1)
    expect(body.indexOf('FROM public.quotation_lines l WHERE l.quotation_id = p_quotation_id;')).toBeGreaterThan(insert)
    expect(body).toContain('public._sales_order_write_lines(v_so_id, COALESCE(v_src, v_qt.line_items))')
  })

  it("takes the order's mirror and totals from its own rows, so they always agree", () => {
    expect(body).toMatch(/UPDATE public\.sales_orders SET\s+line_items\s+= v_w\.line_items,[\s\S]*total\s+= v_w\.total\s+WHERE id = v_so_id;/)
  })

  it('takes the actor from the login only, and lets a sales rep convert only a quotation they own', () => {
    expect(body).toMatch(/v_actor\s+text := public\.rma_current_user_email\(\);/)
    expect(body).not.toContain('COALESCE(public.rma_current_user_email(), p_actor_email)')
    expect(body).toMatch(/IF NOT COALESCE\(public\.rma_is_manager_or_above\(\)\s+OR \(v_qt\.assigned_rep = v_actor OR v_qt\.created_by = v_actor\), false\) THEN/)
  })

  it('keeps every rule it already had (accepted only; expired needs a manager and a reason; no free-text lines)', () => {
    expect(body).toContain('have no product')
    expect(body).toContain("'Quotation already converted to a sales order'")
    expect(body).toMatch(/p_override_reason/)
  })
})

describe('the backfill probe tests the real backfill', () => {
  it('its copy of sections 7-8 is the migration text, byte for byte', () => {
    const probe = readFileSync('supabase/tests/sales_order_lines_backfill.sql', 'utf8').replace(/\r\n/g, '\n')
    const begin = '-- BEGIN copy of 20260884 sections 7-8\n'
    const copy = probe.slice(probe.indexOf(begin) + begin.length, probe.indexOf('-- END copy of 20260884 sections 7-8'))
    const m = sql.replace(/\r\n/g, '\n')
    const section = m.slice(m.indexOf('CREATE OR REPLACE FUNCTION pg_temp.so_bf_num'), m.indexOf('-- ── guard: nothing new is reachable by anon'))
    expect(copy.length).toBeGreaterThan(1000)
    expect(copy).toBe(section)
  })

  it('reads each element by its real column name', () => {
    expect(sql).toContain('FOR v_t IN SELECT e.l FROM jsonb_array_elements(v_o.line_items) AS e(l)')
  })

  it('reports a present value it could not read, instead of defaulting it silently', () => {
    expect(sql).toContain("v_unread := EXISTS (SELECT 1 FROM unnest(ARRAY['qty', 'unit_price', 'discount_pct', 'tax_pct']) k")
    expect(sql).toContain('IF v_unread OR v_qty <> round(v_qty)')
  })

  it('rebuilds only unsettled documents (draft, sent) from their rows', () => {
    expect(sql).toContain("WHERE o.id = r.id AND o.status IN ('draft', 'sent')")
    expect(sql).toContain("WHERE q.id = r.id AND q.status IN ('draft', 'sent')")
  })
})

// ── the browser client ──────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({ rpc: [], writes: [], result: { data: { id: 'so1' }, error: null } }))

vi.mock('../api/client.js', () => ({
  supabase: {
    rpc: (name, args) => {
      mocks.rpc.push({ name, args })
      return Promise.resolve(mocks.result)
    },
    from: () => {
      const c = {
        insert: (r) => { mocks.writes.push(['insert', r]); return c },
        update: (r) => { mocks.writes.push(['update', r]); return c },
        eq: () => c,
        select: () => Promise.resolve({ data: [{ id: 'so1' }], error: null }),
      }
      return c
    },
  },
}))

const { salesOrders } = await import('../api/db/salesOrders')

describe('salesOrders client', () => {
  beforeEach(() => {
    mocks.rpc.length = 0
    mocks.writes.length = 0
    mocks.result = { data: { id: 'so1' }, error: null }
  })
  const lines = [{ product_id: 'p1', product_name: 'x', qty: 1, unit_price: 5 }]

  it('creates through create_sales_order, with no direct insert, code or browser totals', async () => {
    await salesOrders.create({ customer_id: 'c1', line_items: lines, created_by: 'a@b.c', delivery_date: '2026-10-01' })
    expect(mocks.writes).toEqual([])
    expect(mocks.rpc.map((c) => c.name)).toEqual(['create_sales_order'])
    expect(mocks.rpc[0].args).toMatchObject({ p_customer_id: 'c1', p_lines: lines, p_delivery_date: '2026-10-01' })
  })

  it('updates through update_sales_order, sending only the fields given', async () => {
    await salesOrders.update('so1', { line_items: lines, notes: 'n' }, 'a@b.c')
    expect(mocks.writes).toEqual([])
    expect(mocks.rpc[0]).toEqual({ name: 'update_sales_order', args: { p_id: 'so1', p_lines: lines, p_fields: { notes: 'n' }, p_actor_email: 'a@b.c' } })
  })

  it('without lines keeps them (p_lines null)', async () => {
    await salesOrders.update('so1', { payment_terms: 'Net 60' })
    expect(mocks.rpc[0].args).toMatchObject({ p_lines: null, p_fields: { payment_terms: 'Net 60' } })
  })

  it('throws the database refusal', async () => {
    mocks.result = { data: null, error: { code: 'P0001', message: 'This sales order is confirmed and can no longer be edited' } }
    await expect(salesOrders.update('so1', { notes: 'x' })).rejects.toMatchObject({ code: 'P0001' })
  })
})
