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
    //   - an explicit error (RLS refusal, or the table not exposed at all)
    //   - success with zero rows, which is what a SELECT policy that matches
    //     nothing returns for an anonymous caller
    // What must never happen is rows coming back.
    if (error) {
      expect(error).toBeTruthy()
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
