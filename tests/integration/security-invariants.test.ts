/**
 * Security invariants, read from production.
 *
 * BUG-087: every `IF NOT rma_is_*()` guard in a SECURITY DEFINER function used
 * to fail OPEN for a caller with no current role, because the helpers returned
 * NULL. 20260867 fixed it; ordinary later work can undo it — a helper
 * re-declared without COALESCE, or an old function body copied back with a
 * bare `IF NOT (… rma_user_role() …)` guard. The unit test reads the migration
 * files and cannot see a change made directly in production; the SQL test
 * files cannot run in CI at all (db-tests is disabled). This tier can.
 *
 * rma_security_invariant_counts() (20260869) returns counts only — no names,
 * no code — so it is safe to expose to the anon key this tier holds.
 */
import { expect, it } from 'vitest'
import { anonClient, describeIntegration, skipReason } from './_client'

/**
 * Functions in `public` that anon may run. 20260841 made "none" the default,
 * so each one is a deliberate exception and this number should only change in
 * a PR that means to change it:
 *   - rma_applied_migration_versions  (20260868, the migration drift check)
 *   - rma_security_invariant_counts   (20260869, this test)
 */
const EXPECTED_ANON_EXECUTABLE = 2

describeIntegration(`Security invariants — production (${skipReason})`, () => {
  it('reads the invariant counts (a missing function is a failure, not a skip)', async () => {
    const { data, error } = await anonClient().rpc('rma_security_invariant_counts')
    expect(error, `could not read the counts: ${error?.message}`).toBeNull()
    expect(data).toEqual(
      expect.objectContaining({
        unwrapped_role_guards: expect.any(Number),
        helpers_without_coalesce: expect.any(Number),
        policies_negating_helpers: expect.any(Number),
        anon_executable_functions: expect.any(Number),
      })
    )
  })

  it('no SECURITY DEFINER function guards on a bare `IF NOT (… rma_user_role() …)` — it would fail open', async () => {
    const { data } = await anonClient().rpc('rma_security_invariant_counts')
    expect(data?.unwrapped_role_guards).toBe(0)
  })

  it('every role helper still returns false, never NULL, for a caller with no role', async () => {
    const { data } = await anonClient().rpc('rma_security_invariant_counts')
    expect(data?.helpers_without_coalesce).toBe(0)
  })

  it('no RLS policy negates or compares a role helper — the NULL → false fix would widen it', async () => {
    const { data } = await anonClient().rpc('rma_security_invariant_counts')
    expect(data?.policies_negating_helpers).toBe(0)
  })

  it('anon can run exactly the functions chosen for it — no more', async () => {
    const { data } = await anonClient().rpc('rma_security_invariant_counts')
    expect(
      data?.anon_executable_functions,
      'the set of anon-executable functions changed — if deliberate, update EXPECTED_ANON_EXECUTABLE and its list'
    ).toBe(EXPECTED_ANON_EXECUTABLE)
  })
})
