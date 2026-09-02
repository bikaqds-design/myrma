/**
 * Searching, filtering and paging the user directory.
 *
 * Pure functions, kept out of the component so the rules are testable without
 * rendering a table — and so "why did this row disappear" has one place to look.
 *
 * ── Why this is done in the browser ─────────────────────────────────────────
 *
 * The whole directory is already loaded in one query. At this size that is the
 * right trade: filtering server-side would add a round trip per keystroke for a
 * list that fits in memory many times over. If the directory ever reaches a few
 * thousand people this should move to the server, and the seam is here — the
 * component only calls these three functions.
 */

/** Roles offered in the filter. Mirrors ROLES in src/lib/constants.ts. */
export const FILTER_ROLES = [
  'super_admin',
  'admin',
  'manager',
  'technician',
  'viewer',
  'sales_rep',
  'accountant',
]

/** Statuses a row can hold, per the chk_user_status constraint. */
export const FILTER_STATUSES = ['active', 'pending', 'suspended', 'locked', 'deactivated']

export const PAGE_SIZES = [10, 25, 50, 100]

/**
 * Narrow the directory by free text, role and status.
 *
 * Search matches the email and the notes, case-insensitively, on a trimmed
 * substring. Deliberately not a word or prefix match: people search for a
 * fragment they half-remember ("nour", "@qdsegypt"), and a stricter rule would
 * return nothing for exactly those attempts.
 *
 * An absent status counts as 'active', matching how the table renders it —
 * otherwise filtering by Active would hide the older rows that predate the
 * column having a default.
 */
export function filterUsers(users, { search = '', role = '', status = '' } = {}) {
  const q = String(search).trim().toLowerCase()

  return (users ?? []).filter((u) => {
    if (role && u.role !== role) return false
    if (status && (u.status || 'active') !== status) return false
    if (!q) return true

    const haystack = `${u.user_email ?? ''} ${u.notes ?? ''}`.toLowerCase()
    return haystack.includes(q)
  })
}

/**
 * Cut a filtered list into one page.
 *
 * Clamps the page rather than trusting it. Filtering while on page 5 leaves the
 * page number pointing past the end of a now-shorter list, and an unclamped
 * slice would show an empty table with rows that plainly exist — which reads as
 * a bug in the filter.
 */
export function paginate(rows, page, pageSize) {
  const total = (rows ?? []).length
  const size = Math.max(1, pageSize)
  const pageCount = Math.max(1, Math.ceil(total / size))
  const current = Math.min(Math.max(1, page), pageCount)
  const start = (current - 1) * size

  return {
    rows: (rows ?? []).slice(start, start + size),
    page: current,
    pageCount,
    total,
    // 1-based and inclusive, for "Showing 1-25 of 888".
    from: total === 0 ? 0 : start + 1,
    to: Math.min(start + size, total),
  }
}

/**
 * Keep a selection honest when the visible rows change.
 *
 * A selection that survives filtering is a trap: select twelve people, filter to
 * one, press Delete, and eleven invisible rows go with it. So the selection is
 * intersected with what is currently visible — if you cannot see it, you cannot
 * act on it.
 */
export function pruneSelection(selected, visibleUsers) {
  const visible = new Set((visibleUsers ?? []).map((u) => u.user_email))
  return new Set([...selected].filter((email) => visible.has(email)))
}

/**
 * Which of the selected users may actually be deleted.
 *
 * Your own account is excluded here as well as in the Edge Function. The server
 * is the boundary; this is so the button never offers something that will be
 * refused.
 */
export function deletableSelection(selected, currentUserEmail) {
  const me = String(currentUserEmail ?? '').toLowerCase()
  return [...selected].filter((email) => String(email).toLowerCase() !== me)
}
