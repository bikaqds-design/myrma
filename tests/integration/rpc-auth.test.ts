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
  // BUG-032 / BUG-087 (2026-09-16): the functions whose guards changed that day.
  { name: 'convert_quotation_to_so', args: { p_quotation_id: NOWHERE, p_actor_email: 'anon@example.com' } },
  { name: 'transfer_units', args: { p_unit_ids: [NOWHERE], p_to_warehouse_id: NOWHERE, p_actor_email: 'anon@example.com' } },
  { name: 'move_rma_units', args: { p_ticket_id: NOWHERE, p_moves: [], p_actor_email: 'anon@example.com' } },
  { name: 'mark_batch_sent', args: { p_batch_id: NOWHERE, p_sent_date: '2026-01-01T00:00:00Z', p_tracking_number: 'probe' } },
  { name: 'rma_staff_directory', args: {} },
  // 20260870: these end sessions without asking who is asking, so no client
  // role may execute them at all.
  { name: 'rma_end_sessions_for_email', args: { p_email: 'nobody@invalid.example' } },
  { name: 'rma_end_sessions_without_access', args: {} },
  // 20260871 (BUG-030): parts used on a ticket.
  { name: 'rma_ticket_part_add', args: { p_ticket_id: NOWHERE, p_part_id: NOWHERE, p_quantity: 1 } },
  { name: 'rma_ticket_part_remove', args: { p_id: NOWHERE } },
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
