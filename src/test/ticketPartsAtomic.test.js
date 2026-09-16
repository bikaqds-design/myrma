// @vitest-environment node
/**
 * ticketPartsAtomic.test.js — parts used on a ticket move stock in one transaction.
 *
 * ticketParts.add()/remove() used to change stock and then write ticket_parts
 * as two calls (BUG-030), and the table's own write policies let staff write
 * around the stock entirely. 20260871 moved both into RPCs and closed the
 * table to direct writes; the behaviour was proven by a rolled-back probe on
 * production (supabase/tests/ticket_parts_atomic.sql, 13/13). What is pinned
 * here is that neither half quietly comes back.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260871_ticket_parts_atomic.sql', 'utf8').replace(/\r\n/g, '\n')
const inventory = readFileSync('src/api/db/inventory.ts', 'utf8').replace(/\r\n/g, '\n')
const ticketParts = inventory.slice(inventory.indexOf('export const ticketParts'), inventory.indexOf('// ── Time Tracking'))

/** SQL with `-- …` comments removed, so a rule is asserted on code, never on prose about it. */
const code = (text) => text.replace(/--[^\n]*/g, '')

describe('the client', () => {
  it('adds and removes through one RPC each', () => {
    expect(ticketParts).toContain("rpc('rma_ticket_part_add'")
    expect(ticketParts).toContain("rpc('rma_ticket_part_remove', { p_id: id })")
  })

  it('never changes stock itself or writes ticket_parts directly', () => {
    expect(ticketParts).not.toMatch(/adjustQuantity|adjust_part_quantity/)
    expect(ticketParts).not.toMatch(/\.(insert|update|delete|upsert)\(/)
  })

  it('does not send the part or quantity when removing — the server reads the row', () => {
    expect(ticketParts).toMatch(/async remove\(id: string\)/)
  })
})

describe('the migration', () => {
  const body = code(sql)

  it('takes stock through adjust_part_quantity in the same function as the insert', () => {
    const add = body.slice(body.indexOf('FUNCTION public.rma_ticket_part_add('), body.indexOf('FUNCTION public.rma_ticket_part_remove('))
    expect(add).toContain('PERFORM public.adjust_part_quantity(p_part_id, -p_quantity)')
    expect(add).toContain('INSERT INTO public.ticket_parts')
    expect(add).toContain('public.rma_current_user_email()')
  })

  it('returns the removed row’s own quantity to its own part', () => {
    expect(body).toContain('PERFORM public.adjust_part_quantity(v_row.part_id, v_row.quantity)')
    expect(body).toMatch(/WHERE tp\.id = p_id FOR UPDATE/)
  })

  it('uses fail-closed guards (BUG-087)', () => {
    expect(body).toContain("IF NOT COALESCE((public.rma_is_staff() AND public.rma_user_role() <> 'viewer'), false) THEN")
    expect(body).toContain('IF NOT COALESCE(public.rma_is_admin(), false) THEN')
  })

  it('closes the table to direct writes and refuses to finish otherwise', () => {
    for (const policy of ['staff_write', 'staff_update', 'admin_delete']) {
      expect(body).toContain(`DROP POLICY IF EXISTS ${policy}`)
    }
    expect(body).toContain('REVOKE INSERT, UPDATE, DELETE ON public.ticket_parts FROM anon, authenticated')
    expect(body).toMatch(/has_table_privilege\('authenticated', 'public\.ticket_parts', 'INSERT'\)/)
  })

  it('does not let anonymous callers execute either function', () => {
    expect(body).toContain('REVOKE ALL ON FUNCTION public.rma_ticket_part_add(uuid, uuid, integer, numeric, text) FROM anon')
    expect(body).toContain('REVOKE ALL ON FUNCTION public.rma_ticket_part_remove(uuid) FROM anon')
  })
})
