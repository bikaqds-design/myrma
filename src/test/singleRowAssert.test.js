// @vitest-environment node
/**
 * singleRowAssert.test.js — a successful write must not report failure.
 *
 * Since b214789 (2026-09-13) eleven writes in quotations, sales orders, CRM
 * invoices and credit notes ended `.select().single()` and then called
 * `assertAffected(data)`. `.single()` returns ONE OBJECT, `assertAffected`
 * checks `data.length`, and an object has none — so every one of them threw
 * NotUpdatedError after the row had in fact been written: "Send for approval"
 * changed the status and then showed a failure.
 *
 * The mock below behaves like supabase-js: `.select()` resolves to an array of
 * the changed rows and `.single()` to one object.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROW = { id: 'r1', status: 'sent' }

vi.mock('../api/client.js', () => {
  const rows = (arr) => {
    const p = Promise.resolve({ data: arr, error: null })
    p.single = () => Promise.resolve({ data: arr[0] ?? null, error: arr.length ? null : { code: 'PGRST116' } })
    return p
  }
  const chain = () => {
    const c = {
      update: () => c,
      eq: () => c,
      in: () => c,
      select: () => rows([{ id: 'r1', status: 'sent' }]),
    }
    return c
  }
  return { supabase: { from: () => chain(), rpc: () => Promise.resolve({ data: null, error: null }) } }
})

const { quotations } = await import('../api/db/quotations')
const { salesOrders } = await import('../api/db/salesOrders')
const { crmInvoices } = await import('../api/db/crmInvoices')
const { creditNotes } = await import('../api/db/creditNotes')

describe('a successful status write returns the row instead of throwing', () => {
  it.each([
    ['quotations.markSent', () => quotations.markSent('r1')],
    ['quotations.markAccepted', () => quotations.markAccepted('r1')],
    ['quotations.markDeclined', () => quotations.markDeclined('r1')],
    ['quotations.cancel', () => quotations.cancel('r1')],
    ['quotations.reopen', () => quotations.reopen('r1')],
    ['crmInvoices.cancelDraft', () => crmInvoices.cancelDraft('r1', 'wrong customer', 'a@b.c')],
    ['salesOrders.markSent', () => salesOrders.markSent('r1')],
    ['creditNotes.update', () => creditNotes.update('r1', { notes: 'x' })],
  ])('%s', async (_name, call) => {
    await expect(call()).resolves.toMatchObject(ROW)
  })

})

describe('nothing pairs .single() with an array assertion again', () => {
  it('no assertAffected/assertUpdated right after .single() in src/api/db', () => {
    const dir = 'src/api/db'
    const hits = []
    for (const f of readdirSync(dir).filter((n) => /\.ts$/.test(n))) {
      const src = readFileSync(join(dir, f), 'utf8')
      if (/\.single\(\)\s*\r?\n\s*if \(error\) throw error\s*\r?\n\s*assert(Affected|Updated)\(data/.test(src)) hits.push(f)
    }
    expect(hits).toEqual([])
  })
})
