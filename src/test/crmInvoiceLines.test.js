// @vitest-environment node
/**
 * crmInvoiceLines.test.js — W2 / L-01, third document type (20260885).
 *
 * Proven against a real database in supabase/tests/crm_invoice_lines.sql
 * (24/24 on staging with 20260886) and crm_invoice_lines_backfill.sql (7/7).
 * Pinned here: what makes a sales invoice's lines guarded, the one-transaction
 * conversion from an order, and the client contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260885_crm_invoice_lines.sql', 'utf8')

function fn(name) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(')
  expect(start, name + ' not found').toBeGreaterThan(-1)
  return sql.slice(start, sql.indexOf('$function$;', sql.indexOf('AS $function$', start)))
}

describe('the crm_invoice_lines table', () => {
  it('references its invoice and the real product, with per-line checks', () => {
    expect(sql).toMatch(/crm_invoice_id\s+uuid NOT NULL REFERENCES public\.crm_invoices\(id\) ON DELETE CASCADE/)
    for (const c of ['qty >= 1', 'unit_price >= 0', 'UNIQUE (crm_invoice_id, line_no)']) expect(sql, c).toContain(c)
  })

  it('is readable exactly when its invoice is, and written only by the RPCs', () => {
    expect(sql).toContain('USING (EXISTS (SELECT 1 FROM public.crm_invoices i WHERE i.id = crm_invoice_lines.crm_invoice_id))')
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.crm_invoice_lines FROM authenticated')
  })
})

describe('the client surface of crm_invoices', () => {
  const body = fn('rma_guard_crm_invoice_client_writes')

  it('cannot INSERT an invoice', () => {
    expect(sql).toContain('REVOKE INSERT ON TABLE public.crm_invoices FROM authenticated')
    expect(fn('create_crm_invoice')).not.toContain('so_id')
  })

  it('may change directly only what cancelDraft and archiving change', () => {
    expect(body).toContain("v_open text[] := ARRAY['doc_status', 'void_reason', 'archived', 'archived_at', 'archived_by', 'updated_at']")
    expect(body).toMatch(/IF \(to_jsonb\(NEW\) - v_open\) IS DISTINCT FROM \(to_jsonb\(OLD\) - v_open\) THEN\s+RAISE EXCEPTION/)
  })

  it('leaves stored generated columns out (cogs_complete reads as NULL in a BEFORE trigger)', () => {
    expect(body).toContain("a.attgenerated <> ''")
    expect(body.indexOf('a.attgenerated')).toBeLessThan(body.indexOf('IF (to_jsonb(NEW) - v_open)'))
  })
})

describe('the RPCs', () => {
  it('follow the replaced policies (20260781), COALESCE-wrapped, actor from the login', () => {
    expect(fn('create_crm_invoice')).toContain("IF NOT COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep', false) THEN")
    expect(fn('update_crm_invoice')).toMatch(/AND \(v_inv\.assigned_rep = v_actor OR v_inv\.created_by = v_actor\)\s+AND \(v_rep = v_actor OR v_inv\.created_by = v_actor\)\),\s+false\) THEN/)
    for (const name of ['create_crm_invoice', 'update_crm_invoice', 'convert_so_to_invoice']) {
      expect(fn(name), name).toMatch(/v_actor\s+text := public\.rma_current_user_email\(\)/)
    }
  })

  it('edit a draft only, and never the products, quantities or prices of an order\'s invoice', () => {
    const upd = fn('update_crm_invoice')
    expect(upd).toContain("IF v_inv.doc_status <> 'draft' THEN")
    expect(upd).toContain('IF v_inv.so_id IS NOT NULL AND p_lines IS NOT NULL THEN')
    expect(upd).toContain('made from a sales order')
  })

  it('require every line to be a catalogue product, and total from the stored rows', () => {
    const w = fn('_crm_invoice_write_lines')
    expect(w).toContain('an invoice line must be a catalogue product')
    expect(w).toContain('FROM public.crm_invoice_lines l WHERE l.crm_invoice_id = p_inv_id) b')
    expect(sql).toContain('REVOKE ALL ON FUNCTION public._crm_invoice_write_lines(uuid, jsonb) FROM PUBLIC, anon, authenticated')
  })
})

describe('convert_so_to_invoice', () => {
  const body = fn('convert_so_to_invoice')

  it('locks the order before checking it has not been invoiced, so two clicks cannot make two invoices', () => {
    const lock = body.indexOf('FROM public.sales_orders WHERE id = p_so_id FOR UPDATE')
    const dup = body.indexOf('already been converted to an invoice')
    expect(lock).toBeGreaterThan(-1)
    expect(dup).toBeGreaterThan(lock)
  })

  it('invoices only a confirmed or delivered order, owned by the rep (or any, for a manager)', () => {
    expect(body).toContain("IF v_so.status NOT IN ('confirmed', 'delivered') THEN")
    expect(body).toMatch(/OR \(public\.rma_user_role\(\) = 'sales_rep'\s+AND \(v_so\.assigned_rep = v_actor OR v_so\.created_by = v_actor\)\),\s+false\) THEN/)
  })

  it("builds the invoice's rows from the order's rows, and its mirror and totals from its own", () => {
    expect(body).toContain('FROM public.sales_order_lines l WHERE l.sales_order_id = p_so_id;')
    expect(body).toContain('public._crm_invoice_write_lines(v_id, COALESCE(v_src, v_so.line_items))')
  })
})

describe('the backfill', () => {
  it('its probe runs the migration text, byte for byte', () => {
    const probe = readFileSync('supabase/tests/crm_invoice_lines_backfill.sql', 'utf8').replace(/\r\n/g, '\n')
    const begin = '-- BEGIN copy of 20260885 sections 7-8\n'
    const copy = probe.slice(probe.indexOf(begin) + begin.length, probe.indexOf('-- END copy of 20260885 sections 7-8'))
    const m = sql.replace(/\r\n/g, '\n')
    const section = m.slice(m.indexOf('CREATE OR REPLACE FUNCTION pg_temp.inv_bf_num'), m.indexOf('-- ── guard ─'))
    expect(copy.length).toBeGreaterThan(1000)
    expect(copy).toBe(section)
  })

  it('rebuilds only DRAFT invoices from their rows; posted ones keep their figures', () => {
    expect(sql).toContain("WHERE i.id = r.id AND i.doc_status = 'draft'")
  })

  it('reports a present value it could not read', () => {
    expect(sql).toContain('IF v_unread OR v_qty <> round(v_qty)')
  })
})

// ── the browser client ──────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({ rpc: [], writes: [], result: { data: { id: 'i1' }, error: null } }))

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
        eq: () => c, neq: () => c, limit: () => Promise.resolve({ data: [], error: null }),
        select: () => c, single: () => Promise.resolve({ data: { id: 'x' }, error: null }),
      }
      return c
    },
  },
}))

const { crmInvoices } = await import('../api/db/crmInvoices')
const { salesOrders } = await import('../api/db/salesOrders')

describe('invoice client', () => {
  beforeEach(() => {
    mocks.rpc.length = 0
    mocks.writes.length = 0
    mocks.result = { data: { id: 'i1' }, error: null }
  })
  const lines = [{ product_id: 'p1', product_name: 'x', qty: 1, unit_price: 5 }]

  it('creates a manual invoice through create_crm_invoice, with no direct insert', async () => {
    await crmInvoices.create({ customer_id: 'c1', line_items: lines, created_by: 'a@b.c', due_date: '2026-11-01' })
    expect(mocks.writes).toEqual([])
    expect(mocks.rpc[0]).toMatchObject({ name: 'create_crm_invoice', args: { p_customer_id: 'c1', p_lines: lines, p_due_date: '2026-11-01' } })
  })

  it('updates through update_crm_invoice, sending only the fields given', async () => {
    await crmInvoices.update('i1', { notes: 'n' }, 'a@b.c')
    expect(mocks.writes).toEqual([])
    expect(mocks.rpc[0]).toEqual({ name: 'update_crm_invoice', args: { p_id: 'i1', p_lines: null, p_fields: { notes: 'n' }, p_actor_email: 'a@b.c' } })
  })

  it('converts an order in one call to convert_so_to_invoice — no browser read-check-insert', async () => {
    mocks.result = { data: 'inv-9', error: null }
    await expect(salesOrders.convertToInvoice('so-1', 'a@b.c')).resolves.toBe('inv-9')
    expect(mocks.writes).toEqual([])
    expect(mocks.rpc).toEqual([{ name: 'convert_so_to_invoice', args: { p_so_id: 'so-1', p_actor_email: 'a@b.c' } }])
  })

  it('throws the database refusal', async () => {
    mocks.result = { data: null, error: { code: 'P0001', message: 'This sales order has already been converted to an invoice' } }
    await expect(salesOrders.convertToInvoice('so-1', 'a@b.c')).rejects.toMatchObject({ code: 'P0001' })
  })
})
