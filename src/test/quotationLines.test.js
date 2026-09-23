// @vitest-environment node
/**
 * quotationLines.test.js — W2 / L-01, first document type (20260883).
 *
 * The behaviour is proven against a real database in
 * supabase/tests/quotation_lines.sql (44/44 on staging). Pinned here: the
 * migration keeps what makes quotation_lines the real, guarded source of
 * truth, and the browser client writes through the RPCs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260883_quotation_lines.sql', 'utf8')

function fn(name) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(')
  expect(start, name + ' not found').toBeGreaterThan(-1)
  return sql.slice(start, sql.indexOf('$function$;', sql.indexOf('AS $function$', start)))
}
const header = (name) => {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(')
  return sql.slice(start, sql.indexOf('AS $function$', start))
}

describe('the quotation_lines table', () => {
  it('references its quotation and the real product', () => {
    expect(sql).toMatch(/quotation_id\s+uuid NOT NULL REFERENCES public\.quotations\(id\) ON DELETE CASCADE/)
    expect(sql).toMatch(/product_id\s+uuid REFERENCES public\.products\(id\)/)
  })

  it('constrains every line in the database', () => {
    for (const c of ['qty >= 1', 'unit_price >= 0', 'discount_pct >= 0 AND discount_pct <= 100', 'tax_pct >= 0 AND tax_pct <= 100', 'UNIQUE (quotation_id, line_no)']) {
      expect(sql, c).toContain(c)
    }
  })

  it('is readable like its quotation and written by nobody but the RPCs', () => {
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.quotation_lines FROM PUBLIC, anon/)
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public\.quotation_lines FROM authenticated/)
    expect(sql).toMatch(/GRANT SELECT ON TABLE public\.quotation_lines TO authenticated/)
    expect(sql).toMatch(/CREATE POLICY "read_quotation_lines"[\s\S]{0,300}q\.assigned_rep = public\.rma_current_user_email\(\) OR q\.created_by = public\.rma_current_user_email\(\)/)
  })
})

describe('the client surface of quotations', () => {
  it('can no longer INSERT a quotation directly', () => {
    expect(sql).toMatch(/REVOKE INSERT ON TABLE public\.quotations FROM authenticated/)
  })

  it('pins the money and identity columns on any update that is not the RPC', () => {
    const body = fn('rma_guard_quotation_client_writes')
    expect(body).toMatch(/current_user NOT IN \('authenticated', 'anon'\)/)
    expect(header('rma_guard_quotation_client_writes')).not.toMatch(/SECURITY DEFINER/)
    for (const c of ['line_items', 'subtotal', 'discount_amount', 'tax_amount', 'total', 'customer_id', 'deal_id', 'qt_code', 'created_by']) {
      expect(body, c).toMatch(new RegExp('NEW\\.' + c + '\\s+:= OLD\\.' + c))
    }
    // status is not pinned: send/accept/decline/cancel/reopen are plain updates
    expect(body).not.toMatch(/NEW\.status\s+:=/)
  })
})

describe('writing the lines', () => {
  const body = fn('_quotation_write_lines')

  it('is internal: no client can call it', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\._quotation_write_lines\(uuid, jsonb\) FROM PUBLIC, anon, authenticated/)
  })

  it('computes totals with the same formula as the browser, rounding once at the end', () => {
    expect(body).toMatch(/v_disc := v_base \* v_dpct::numeric \/ 100/)
    expect(body).toMatch(/v_tsum := v_tsum \+ \(v_base - v_disc\) \* v_tpct::numeric \/ 100/)
    expect(body).toMatch(/round\(v_sub - v_dsum \+ v_tsum, 2\)/)
  })

  it('checks numbers as text first, so NaN and Infinity are refused', () => {
    expect(body).toMatch(/v_qty !~ '\^\[0-9\]\{1,9\}\$'/)
    expect(body).toMatch(/v_price !~ '\^\[0-9\]\{1,10\}\(\\\.\[0-9\]\+\)\?\$'/)
  })

  it('treats an empty price, discount or tax as 0, as the Deal screen always did', () => {
    expect(body).toMatch(/COALESCE\(NULLIF\(btrim\(COALESCE\(v_line->>'unit_price', ''\)\), ''\), '0'\)/)
  })

  it('writes line_items as a mirror of the rows, in line order', () => {
    expect(body).toMatch(/jsonb_agg\(jsonb_build_object\([\s\S]*ORDER BY l\.line_no\)/)
  })
})

describe('create_quotation and update_quotation', () => {
  it('take the actor from the login only', () => {
    for (const name of ['create_quotation', 'update_quotation']) {
      const body = fn(name)
      expect(body, name).toMatch(/v_actor\s+text := public\.rma_current_user_email\(\)/)
      expect(body, name).not.toMatch(/COALESCE\(public\.rma_current_user_email\(\), p_actor_email\)/)
    }
  })

  it('wraps the ownership check so an empty assigned_rep cannot let a caller through (BUG-087)', () => {
    expect(fn('update_quotation')).toMatch(/IF NOT COALESCE\(public\.rma_is_manager_or_above\(\)\s+OR v_qt\.assigned_rep = v_actor\s+OR v_qt\.created_by\s+= v_actor, false\) THEN/)
  })

  it('edits only a draft or sent quotation, under a row lock', () => {
    const body = fn('update_quotation')
    expect(body).toMatch(/FOR UPDATE/)
    expect(body).toMatch(/v_qt\.status NOT IN \('draft', 'sent'\)/)
  })

  it('sets only the header fields the caller sent, from a closed list', () => {
    const body = fn('update_quotation')
    expect(body).toMatch(/v_allowed text\[\] := ARRAY\['validity_until', 'payment_terms', 'reference_po', 'notes', 'assigned_rep'\]/)
    expect(body).toMatch(/reference_po\s+= CASE WHEN v_f \? 'reference_po'\s+THEN v_f->>'reference_po'\s+ELSE reference_po\s+END/)
  })

  it('pins pg_temp last and is not executable by anon', () => {
    expect(header('create_quotation')).toMatch(/SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/)
    expect(header('update_quotation')).toMatch(/SECURITY DEFINER\s+SET search_path TO 'public', 'pg_temp'/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.create_quotation\(uuid, uuid, jsonb, date, text, text, text, text, text\) FROM PUBLIC, anon/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.update_quotation\(uuid, jsonb, jsonb, text\) FROM PUBLIC, anon/)
    expect(sql).toContain('Refusing to finish')
  })

  it('backfills existing quotations one row at a time, skipping blobs that are not a list', () => {
    expect(sql).toMatch(/AND jsonb_typeof\(q\.line_items\) = 'array'/)
    expect(sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM public\.quotation_lines ql WHERE ql\.quotation_id = q\.id\)/)
  })
})

// ── the browser client ──────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({ rpc: [], updates: [], result: { data: { id: 'q1' }, error: null } }))

vi.mock('../api/client.js', () => ({
  supabase: {
    rpc: (name, args) => {
      mocks.rpc.push({ name, args })
      return Promise.resolve(mocks.result)
    },
    from: () => ({
      update: (patch) => {
        mocks.updates.push(patch)
        return { eq: () => ({ select: () => Promise.resolve({ data: [{ id: 'q1' }], error: null }) }) }
      },
    }),
  },
}))

const { quotations } = await import('../api/db/quotations')

describe('quotations client', () => {
  beforeEach(() => {
    mocks.rpc.length = 0
    mocks.updates.length = 0
    mocks.result = { data: { id: 'q1' }, error: null }
  })

  const lines = [{ product_name: 'x', qty: 1, unit_price: 5 }]

  it('creates through create_quotation, with no code generated or totals computed in the browser', async () => {
    await quotations.create({ customer_id: 'c1', line_items: lines, created_by: 'a@b.c', payment_terms: 'Net 30' })
    expect(mocks.rpc.map((c) => c.name)).toEqual(['create_quotation'])
    expect(mocks.rpc[0].args).toMatchObject({ p_customer_id: 'c1', p_lines: lines, p_payment_terms: 'Net 30', p_deal_id: null })
  })

  it('updates lines through update_quotation, sending only the header fields it was given', async () => {
    await quotations.update('q1', { line_items: lines, notes: 'n', payment_terms: null }, 'a@b.c')
    expect(mocks.rpc[0]).toEqual({
      name: 'update_quotation',
      args: { p_id: 'q1', p_lines: lines, p_fields: { notes: 'n', payment_terms: null }, p_actor_email: 'a@b.c' },
    })
  })

  it('without lines, updates the plain fields directly', async () => {
    await quotations.update('q1', { notes: 'only a note' })
    expect(mocks.rpc).toEqual([])
    expect(mocks.updates).toEqual([{ notes: 'only a note' }])
  })

  it('throws the database refusal', async () => {
    mocks.result = { data: null, error: { code: 'P0001', message: 'This quotation is accepted and can no longer be edited' } }
    await expect(quotations.update('q1', { line_items: lines })).rejects.toMatchObject({ code: 'P0001' })
  })
})

describe('the screens pass the editor along', () => {
  it('the shared form and the Deal screen', () => {
    expect(readFileSync('src/pages/SalesDocuments/SalesDocumentForm.jsx', 'utf8')).toContain('MODULE.update(initial.id, editFields, currentUserEmail)')
    expect(readFileSync('src/pages/Pipeline/DealDetail.jsx', 'utf8')).toContain('db.quotations.update(editingQtId, fields, currentUserEmail)')
  })
})
