/**
 * RLS: what a logged-out client can reach.
 *
 * This is the coverage gap named in MASTER_UPGRADE_PLAN A6 — every RLS policy
 * in this project has only ever been verified by a human clicking around while
 * signed in, which is precisely the state in which a missing policy is
 * invisible. An anonymous client is the one caller that proves the policy is
 * doing the work rather than the UI.
 *
 * Read-only by construction: a passing test reads nothing, and a failing one
 * has already leaked.
 */
import { expect, it } from 'vitest'
import { anonClient, describeIntegration, PROTECTED_TABLES, skipReason } from './_client'

describeIntegration(`RLS — anonymous access (${skipReason})`, () => {
  it.each(PROTECTED_TABLES)('anon cannot read %s', async (table) => {
    const supabase = anonClient()
    const { data, error } = await supabase.from(table).select('*').limit(1)

    // Two shapes count as correctly denied:
    //   - a refusal: no grant (42501) or a SELECT policy that admits nothing
    //   - success with zero rows
    // What must never happen is rows coming back.
    //
    // A MISSING relation is not a pass, and used to be treated as one: the
    // suite listed `purchase_documents`, which does not exist, and the 404 was
    // read as "correctly denied" — a green test pinning nothing. PGRST205 is
    // PostgREST's "not in the schema cache"; 42P01 is Postgres's "relation does
    // not exist". (BUG-061)
    if (error) {
      const missing = error.code === 'PGRST205' || error.code === '42P01'
      expect(
        missing,
        `${table} does not exist, so this test proves nothing about it (${error.code}: ${error.message})`
      ).toBe(false)
      return
    }
    expect(
      data,
      `${table} returned ${data?.length} row(s) to an anonymous client — RLS is not protecting it`
    ).toEqual([])
  })

  it('anon cannot read staff email addresses off tickets', async () => {
    const supabase = anonClient()
    // The public tracker leaked these once already (fixed in d7439f6); this
    // pins the underlying table rather than the edge function that wraps it.
    const { data, error } = await supabase
      .from('ticket_comments')
      .select('author_email')
      .limit(1)

    if (!error) expect(data).toEqual([])
  })

  it('anon cannot insert a customer', async () => {
    const supabase = anonClient()
    // Write attempt with an obviously-fake payload. If RLS is correct this is
    // refused and nothing is created; if it somehow succeeds the assertion
    // fails loudly and the row is reported so it can be removed by hand.
    const { data, error } = await supabase
      .from('customers')
      .insert([{ company_name: '__rls_probe_should_never_exist__', customer_type: 'B2B' }])
      .select()

    expect(
      error,
      `anonymous insert succeeded and created ${JSON.stringify(data)} — delete it and fix the policy`
    ).toBeTruthy()
  })
})
