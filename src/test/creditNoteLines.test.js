// @vitest-environment node
/**
 * creditNoteLines.test.js — W2 / L-01, fourth document type (20260887).
 *
 * Proven against a real database in supabase/tests/credit_note_lines.sql
 * (34/34 on staging; with the new guard dropped, the two "money = lines" checks
 * fail, and the four review-finding checks failed before their fix) and credit_note_lines_backfill.sql (7/7). Pinned here: what makes a
 * credit note's credited amount equal its lines, and the client contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260887_credit_note_lines.sql', 'utf8')

function fn(name) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(')
  expect(start, name + ' not found').toBeGreaterThan(-1)
  return sql.slice(start, sql.indexOf('$function$;', sql.indexOf('AS $function$', start)))
}

describe('the credit_note_lines table', () => {
  it('references its note, optionally a real product and a warehouse, with per-line checks', () => {
    expect(sql).toMatch(/credit_note_id\s+uuid NOT NULL REFERENCES public\.credit_notes\(id\) ON DELETE CASCADE/)
    expect(sql).toMatch(/product_id\s+uuid REFERENCES public\.products\(id\),\s+-- nullable/)
    expect(sql).toMatch(/warehouse_id\s+uuid REFERENCES public\.warehouses\(id\)/)
    expect(sql).toMatch(/restock\s+boolean NOT NULL DEFAULT false/)
    for (const c of ['qty >= 1', 'unit_price >= 0', 'UNIQUE (credit_note_id, line_no)']) expect(sql, c).toContain(c)
  })

  it('is readable exactly when its note is, and written only by the RPCs', () => {
    expect(sql).toContain('USING (EXISTS (SELECT 1 FROM public.credit_notes c WHERE c.id = credit_note_lines.credit_note_id))')
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.credit_note_lines FROM authenticated')
  })
})

describe('the credited amount is the lines', () => {
  it('no client can INSERT a note or write its lines or total directly', () => {
    expect(sql).toContain('REVOKE INSERT ON TABLE public.credit_notes FROM authenticated')
    const g = fn('rma_guard_credit_note_allowlist')
    expect(g).toContain("v_open text[] := ARRAY['restock_status', 'archived', 'archived_at', 'archived_by', 'updated_at']")
    expect(g).toContain("a.attgenerated <> ''")
    expect(g).toMatch(/IF \(to_jsonb\(NEW\) - v_open\) IS DISTINCT FROM \(to_jsonb\(OLD\) - v_open\) THEN\s+RAISE EXCEPTION/)
  })

  it('totals come from the rows as stored', () => {
    expect(fn('_credit_note_write_lines')).toContain('FROM public.credit_note_lines l WHERE l.credit_note_id = p_cn_id) b')
  })
})

describe('writing the lines', () => {
  const w = fn('_credit_note_write_lines')

  it('allows a free-text line, but a named product or warehouse must exist', () => {
    expect(w).toContain("IF v_pid <> '' THEN")
    expect(w).toContain('that product does not exist')
    expect(w).toContain('that warehouse does not exist')
  })

  it('takes restock only as a real boolean', () => {
    expect(w).toContain("jsonb_typeof(v_line->'restock') NOT IN ('boolean', 'null')")
  })

  it('is internal', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public._credit_note_write_lines(uuid, jsonb) FROM PUBLIC, anon, authenticated')
  })
})

describe('create_credit_note and update_credit_note', () => {
  it('follow the replaced policies (20260781), COALESCE-wrapped, actor from the login', () => {
    expect(fn('create_credit_note')).toContain("IF NOT COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep', false) THEN")
    expect(fn('update_credit_note')).toMatch(/AND \(v_cn\.assigned_rep = v_actor OR v_cn\.created_by = v_actor\)\s+AND \(v_rep = v_actor OR v_cn\.created_by = v_actor\)\),\s+false\) THEN/)
    for (const name of ['create_credit_note', 'update_credit_note']) {
      expect(fn(name), name).toMatch(/v_actor\s+text := public\.rma_current_user_email\(\)/)
    }
  })

  it('copy the invoice number from the invoice, which must be the customer\'s own', () => {
    const c = fn('create_credit_note')
    expect(c).not.toContain('p_source_invoice_number')
    expect(c).toContain('v_inv.customer_id IS DISTINCT FROM p_customer_id')
    expect(c).toContain('p_source_invoice_id, v_inv.inv_code, p_ticket_id')
  })

  it("accept only the customer's own ticket, and an invoice the caller can read", () => {
    const c = fn('create_credit_note')
    expect(c).toContain('WHERE t.id = p_ticket_id AND t.customer_id = p_customer_id')
    expect(c).toMatch(/OR NOT COALESCE\(public\.rma_is_manager_or_above\(\)\s+OR v_inv\.assigned_rep = v_actor OR v_inv\.created_by = v_actor, false\)/)
  })

  it('refuse an RMA return with neither ticket nor invoice (it would skip approval and caps)', () => {
    expect(fn('create_credit_note')).toContain("IF p_type = 'rma_return' AND p_ticket_id IS NULL AND p_source_invoice_id IS NULL THEN")
  })

  it('rebuild the mirror and total from the rows on a header-only edit', () => {
    const u = fn('update_credit_note')
    expect(u).toContain('IF p_lines IS NULL THEN')
    expect(u).toContain('INTO p_lines FROM public.credit_note_lines l WHERE l.credit_note_id = p_id')
  })

  it('edit a draft only — a note awaiting approval is fingerprinted', () => {
    expect(fn('update_credit_note')).toContain("IF v_cn.status <> 'draft' THEN")
  })
})

describe('the backfill', () => {
  it('its probe runs the migration text, byte for byte', () => {
    const probe = readFileSync('supabase/tests/credit_note_lines_backfill.sql', 'utf8').replace(/\r\n/g, '\n')
    const begin = '-- BEGIN copy of 20260887 sections 7-8\n'
    const copy = probe.slice(probe.indexOf(begin) + begin.length, probe.indexOf('-- END copy of 20260887 sections 7-8'))
    const m = sql.replace(/\r\n/g, '\n')
    const section = m.slice(m.indexOf('CREATE OR REPLACE FUNCTION pg_temp.cn_bf_num'), m.indexOf('-- ── guard ─'))
    expect(copy.length).toBeGreaterThan(1000)
    expect(copy).toBe(section)
  })

  it('re-syncs only DRAFTS: a pending note keeps its fingerprinted figures, an issued one its credited ones', () => {
    expect(sql).toContain("WHERE c.id = r.id AND c.status = 'draft'")
  })
})

// ── the browser client ──────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({ rpc: [], writes: [], result: { data: { id: 'cn1' }, error: null } }))

vi.mock('../api/client.js', () => ({
  supabase: {
    rpc: (name, args) => {
      mocks.rpc.push({ name, args })
      return Promise.resolve(mocks.result)
    },
    from: (table) => {
      mocks.writes.push(table)
      const c = { insert: () => c, update: () => c, eq: () => c, select: () => Promise.resolve({ data: [{ id: 'cn1' }], error: null }) }
      return c
    },
  },
}))

const { creditNotes } = await import('../api/db/creditNotes')

describe('creditNotes client', () => {
  beforeEach(() => {
    mocks.rpc.length = 0
    mocks.writes.length = 0
    mocks.result = { data: { id: 'cn1' }, error: null }
  })
  const lines = [{ product_name: 'Goodwill', qty: 1, unit_price: 5, restock: false }]

  it('creates through create_credit_note — no direct insert, no browser total, no client invoice number', async () => {
    await creditNotes.create({
      type: 'rebate', customer_id: 'c1', reason: 'r', reason_code: 'goodwill', created_by: 'a@b.c',
      line_items: lines, source_invoice_id: 'inv-1', source_invoice_number: 'INV-FORGED',
    })
    expect(mocks.writes).toEqual([])
    expect(mocks.rpc[0].name).toBe('create_credit_note')
    expect(mocks.rpc[0].args).toMatchObject({ p_type: 'rebate', p_customer_id: 'c1', p_lines: lines, p_source_invoice_id: 'inv-1' })
    expect(JSON.stringify(mocks.rpc[0].args)).not.toContain('INV-FORGED')
  })

  it('updates through update_credit_note, sending only the fields given', async () => {
    await creditNotes.update('cn1', { reason: 'new reason' }, 'a@b.c')
    expect(mocks.writes).toEqual([])
    expect(mocks.rpc[0]).toEqual({ name: 'update_credit_note', args: { p_id: 'cn1', p_lines: null, p_fields: { reason: 'new reason' }, p_actor_email: 'a@b.c' } })
  })

  it('throws the database refusal', async () => {
    mocks.result = { data: null, error: { code: 'P0001', message: 'This credit note is pending_approval and can no longer be edited' } }
    await expect(creditNotes.update('cn1', { reason: 'x' })).rejects.toMatchObject({ code: 'P0001' })
  })
})
