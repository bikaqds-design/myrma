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

/**
 * A bulk write reached some of the selected rows but not all of them.
 *
 * Carries what a screen needs to say something true: how many were selected,
 * and which ones did not change. The rest did change — which is why the caller
 * should refresh rather than assume nothing happened.
 */
export class NotAllUpdatedError extends Error {
  readonly code = 'RMA_NOT_ALL_UPDATED'
  constructor(
    entity: string,
    readonly total: number,
    readonly unchangedIds: string[]
  ) {
    super(
      unchangedIds.length === total
        ? `None of the ${total} selected ${entity} records were changed. They may have been deleted, or you may not have permission to change them.`
        : `${unchangedIds.length} of the ${total} selected ${entity} records were not changed — they may have been deleted, or you may not have permission to change them. The other ${total - unchangedIds.length} were.`
    )
    this.name = 'NotAllUpdatedError'
  }
}

/**
 * The bulk version of assertAffected. (BUG-074.)
 *
 * PostgREST applies RLS as a filter, so an UPDATE or DELETE over a list of ids
 * quietly skips the rows the caller may not touch and still answers 200. The
 * screen then reported "10 updated" when 3 were not. Chain `.select('id')` onto
 * the write and pass its result here with the ids you asked for.
 *
 * Same policy caveat as the single-row guards: only for tables whose SELECT
 * policy covers their UPDATE/DELETE policy, or a successful write looks unread.
 */
export function assertAllAffected(
  data: Array<{ id: string }> | null | undefined,
  ids: string[],
  entity: string
): void {
  const wanted = [...new Set(ids)]
  const got = new Set((data ?? []).map((r) => r.id))
  const unchanged = wanted.filter((id) => !got.has(id))
  if (unchanged.length) throw new NotAllUpdatedError(entity, wanted.length, unchanged)
}
