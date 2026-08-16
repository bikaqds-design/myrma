/**
 * Schema drift.
 *
 * The app addresses columns by name through PostgREST, so a renamed or dropped
 * column is not a build error or a type error — it is a 42703 at runtime, in
 * whichever screen happens to touch it first. BUG #40 was the mirror image:
 * `rma_tickets.product_id` existed, so the query succeeded and quietly returned
 * nothing for every product, for months.
 *
 * Selecting each column the app depends on is the cheapest possible check that
 * the live schema still matches the code's assumptions. `head: true` fetches no
 * rows at all — PostgREST still resolves and validates the column list, so this
 * reads no data whatsoever.
 */
import { expect, it } from 'vitest'
import { anonClient, describeIntegration, EXPECTED_COLUMNS, skipReason } from './_client'

const cases = Object.entries(EXPECTED_COLUMNS)

describeIntegration(`Schema drift — columns the app reads (${skipReason})`, () => {
  it.each(cases)('%s exposes every column the app selects', async (table, columns) => {
    const supabase = anonClient()
    const { error } = await supabase
      .from(table)
      .select((columns as string[]).join(','), { head: true, count: 'exact' })
      .limit(0)

    // 42703 = undefined_column, PGRST204 = column not in the schema cache.
    // Either means the code and the database have diverged.
    if (error && (error.code === '42703' || error.code === 'PGRST204')) {
      throw new Error(`${table}: ${error.message}`)
    }

    // Anything else — an RLS refusal, most likely — is fine here. The column
    // list resolved, which is the only thing this test is asserting.
    expect(error?.code).not.toBe('42703')
    expect(error?.code).not.toBe('PGRST204')
  })

  it('rma_tickets.product_id is still unwritten (the BUG #40 assumption)', async () => {
    const supabase = anonClient()
    // getRelatedTickets was rewritten to read inventory_units because nothing
    // populates this column. If that ever changes, the rewrite should be
    // revisited — so this pins the assumption rather than leaving it in a
    // comment. Anonymous callers get no rows, so this only asserts the column
    // still resolves; the behavioural half lives in the unit tests.
    const { error } = await supabase
      .from('rma_tickets')
      .select('product_id', { head: true })
      .limit(0)

    expect(error?.code).not.toBe('42703')
  })
})
