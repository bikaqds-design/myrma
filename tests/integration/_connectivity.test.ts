/**
 * Connectivity — runs first, and everything else depends on it.
 *
 * The RLS and RPC suites treat "the request errored" as "the database refused
 * me", which is the right reading only if the request actually reached
 * PostgREST. Point VITE_SUPABASE_URL at a typo and every one of those tests
 * goes green while proving nothing — the same false all-clear that made the
 * first two versions of the render-loop sweep useless.
 *
 * So: prove we are talking to a real PostgREST instance before trusting any
 * refusal. A request for a table that certainly does not exist comes back as a
 * *parsed PostgREST error* (PGRST205, "Could not find the table"). A bad host,
 * a wrong key, or an offline project cannot produce that — they fail at the
 * network layer or with an auth error instead.
 */
import { expect, it } from 'vitest'
import { anonClient, describeIntegration, hasCredentials, skipReason } from './_client'

describeIntegration(`Connectivity — the target is a live PostgREST (${skipReason})`, () => {
  it('credentials are present', () => {
    expect(hasCredentials).toBe(true)
    expect(process.env.VITE_SUPABASE_URL).toMatch(/^https:\/\//)
  })

  it('reaches PostgREST and gets a parsed protocol error, not a transport failure', async () => {
    const supabase = anonClient() // built here, not at describe scope — see _client.ts
    const { error } = await supabase
      .from('__table_that_does_not_exist__')
      .select('*')
      .limit(1)

    expect(error, 'no error for a nonexistent table — this is not a real PostgREST').toBeTruthy()
    expect(
      error?.code,
      `expected PGRST205 (table not found) but got ${error?.code}: ${error?.message}. ` +
        'If this is a network or auth failure, every refusal-based assertion in this tier is ' +
        'passing for the wrong reason.'
    ).toBe('PGRST205')
  })

  it('the anon key is accepted (an invalid key would be rejected before routing)', async () => {
    const supabase = anonClient()
    const { error } = await supabase.from('customers').select('id', { head: true }).limit(0)

    // Whatever RLS decides, the key itself must not be the thing rejected.
    expect(error?.message ?? '').not.toMatch(/JWS|JWT|api key|Invalid authentication/i)
  })
})
