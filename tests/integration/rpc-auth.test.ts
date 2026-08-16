/**
 * RPC authorization.
 *
 * Every one of these functions is SECURITY DEFINER — it runs with the owner's
 * rights, so its own role check is the only thing standing between an
 * unauthenticated caller and a privileged write. That check has never been
 * tested; it has only ever been read.
 *
 * Each test calls the RPC as an anonymous client and asserts it is refused.
 * The arguments are deliberately non-existent UUIDs, so even in the failure
 * case the function has nothing real to act on — but the point is that it must
 * refuse on the role check, before it looks at the arguments at all.
 */
import { expect, it } from 'vitest'
import { anonClient, describeIntegration, skipReason } from './_client'

const NOWHERE = '00000000-0000-0000-0000-000000000000'

/** Every RPC here must reject an anonymous caller. */
const PRIVILEGED_RPCS: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'post_invoice', args: { p_invoice_id: NOWHERE, p_actor_email: 'anon@example.com' } },
  { name: 'void_invoice', args: { p_invoice_id: NOWHERE, p_actor_email: 'anon@example.com', p_reason: 'probe' } },
  { name: 'approve_sales_order', args: { p_so_id: NOWHERE, p_actor_email: 'anon@example.com' } },
  { name: 'cancel_sales_order', args: { p_so_id: NOWHERE, p_actor_email: 'anon@example.com' } },
]

describeIntegration(`RPC authorization — anonymous callers (${skipReason})`, () => {
  it.each(PRIVILEGED_RPCS)('$name refuses an anonymous caller', async ({ name, args }) => {
    const supabase = anonClient()
    const { error } = await supabase.rpc(name, args)

    expect(error, `${name} did not error for an anonymous caller`).toBeTruthy()

    // Distinguish "refused" from "does not exist". A typo'd RPC name also
    // errors, which would make this test pass while proving nothing — PGRST202
    // is PostgREST's "function not found", and it means the test is wrong, not
    // that the database is safe.
    expect(
      error?.code,
      `${name} was not found (PGRST202) — the test is calling a name that does not exist`
    ).not.toBe('PGRST202')
  })
})
