/**
 * Guard against RLS-filtered writes being reported as success (BUG-008).
 *
 * PostgREST applies row-level security as a *filter*, not as an error. An
 * UPDATE or DELETE the caller is not permitted to perform therefore comes back
 * as `200 []` — no error, no rows. Every helper in this layer used to return
 * `data?.[0]`, i.e. `undefined`, and callers treated the absence of `error` as
 * success. The result was a false success toast, an activity-log entry and a
 * customer email for a change that never happened.
 *
 * Why an empty result is unambiguous here: this is only used on tables whose
 * SELECT policy is at least as permissive as their UPDATE policy, verified
 * against the live catalog on 2026-09-06 for all twenty tables this layer
 * updates. That matters because `.select()` compiles to `UPDATE … RETURNING`,
 * and RETURNING is evaluated against the SELECT policy — so on a table where
 * reads were *narrower* than writes, an empty result could mean "changed, but
 * you may not read it back" and this guard would throw falsely. (That exact
 * asymmetry is a real defect elsewhere in this codebase: see BUG-079.)
 *
 * Before adding a new table here, check its policies:
 *
 *   SELECT polname, polcmd, pg_get_expr(polqual, polrelid)
 *     FROM pg_policy WHERE polrelid = 'public.<table>'::regclass;
 */

export class NotUpdatedError extends Error {
  readonly code = 'RMA_NOT_UPDATED'
  constructor(entity: string) {
    super(
      `${entity} was not updated. It may have been deleted, or you may not have permission to change it.`
    )
    this.name = 'NotUpdatedError'
  }
}

/**
 * Returns the updated row, or throws if the write affected nothing.
 * Use for UPDATEs that chain `.select()`.
 */
export function assertUpdated<T>(data: T[] | null | undefined, entity: string): T {
  const row = data?.[0]
  if (!row) throw new NotUpdatedError(entity)
  return row
}

/**
 * Same contract for writes whose return value nobody needs — the caller only
 * has to know the row was really changed.
 */
export function assertAffected(data: unknown[] | null | undefined, entity: string): void {
  if (!data?.length) throw new NotUpdatedError(entity)
}
