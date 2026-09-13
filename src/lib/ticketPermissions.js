/**
 * Who may change an RMA ticket, decided in one place. (Audit finding BUG-071.)
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * The same question was answered four different ways across the RMA screens.
 * The row edit button, the inline status and priority pills and the kanban
 * board checked that an `edit_assigned` user was actually the assignee. The
 * bulk status change, the bulk product-status change, the row menu's Edit, the
 * drawer's Edit button and the ticket form's save did not — they checked only
 * that the permission existed.
 *
 * The database draws one line (`staff_update` on rma_tickets): managers and
 * above may update any ticket; a technician may update only tickets assigned to
 * them. So a technician could select twenty tickets, apply a status, and have
 * the database refuse the eighteen that were not theirs. With BUG-008's row
 * check in place that surfaced as a failure for the whole batch — after an
 * activity entry claiming "status changed" had already been written for every
 * selected ticket.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 *   edit_all                        -> any ticket
 *   edit_assigned                   -> tickets assigned to this person
 *   change_status (without edit_all) -> the status of tickets assigned to them
 *
 * `canDo` is the screen's own section-bound permission check, passed in so this
 * stays a pure function the screens and the tests share.
 *
 * This is the interface agreeing with row-level security. It is not a security
 * boundary: a refused update is still refused by the database, and the screens
 * report it rather than trusting this to be exhaustive (custom roles can hold
 * flags the database does not honour).
 */

/**
 * Whether `ticket` is assigned to `userEmail`. Compared case-insensitively:
 * every assignee in production is stored lower-case, so this matches the data,
 * and a stray capital in either value should not hide a person's own ticket.
 */
export function isAssignedTo(ticket, userEmail) {
  const assignee = String(ticket?.assigned_technician ?? '').trim().toLowerCase()
  const me = String(userEmail ?? '').trim().toLowerCase()
  return assignee !== '' && assignee === me
}

/** May this person edit the ticket (fields, products, anything)? */
export function canEditTicket(canDo, ticket, userEmail) {
  if (canDo('edit_all')) return true
  return canDo('edit_assigned') && isAssignedTo(ticket, userEmail)
}

/** May this person change the ticket's status? */
export function canChangeTicketStatus(canDo, ticket, userEmail) {
  if (canDo('edit_all')) return true
  return (canDo('change_status') || canDo('edit_assigned')) && isAssignedTo(ticket, userEmail)
}

/**
 * Split a selection into the tickets `allowed` admits and the ones it does not,
 * preserving order, so a bulk action can act on the first and say how many it
 * skipped instead of attempting every row and reporting the database's refusals
 * as a failure of the whole batch.
 */
export function partitionTickets(tickets, allowed) {
  const permitted = []
  const skipped = []
  for (const ticket of tickets) {
    if (!ticket) continue
    ;(allowed(ticket) ? permitted : skipped).push(ticket)
  }
  return { permitted, skipped }
}
