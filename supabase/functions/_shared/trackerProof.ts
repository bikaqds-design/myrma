// Proof that a public tracker caller may use a ticket. (Audit finding BUG-023.)
//
// The RMA number is the only secret protecting a ticket on the public tracker.
// `comments` and `addComment` used to accept a bare ticket id — ids appear in
// staff links (`?ticket=<id>`) — so anyone holding one could read a ticket's
// public thread or post to it without knowing the number.
//
// Kept free of Deno and network imports so the rule is unit-tested directly
// (src/test/trackerProof.test.js); the function supplies the lookup.

/** Finds the id of the ticket whose RMA number matches, case-insensitively and literally. */
export type TicketIdByRmaNumber = (rmaNumber: string) => Promise<string | null>

/**
 * The ticket id the caller has proved they may use, or null.
 *
 * The RMA number must name a ticket, and that ticket must be the one asked
 * for. A mismatch and an unknown number give the same answer, so the endpoint
 * cannot be used to learn whether an id belongs to some number.
 */
export async function provenTicketId(
  lookup: TicketIdByRmaNumber,
  rmaNumber: unknown,
  ticketId: unknown
): Promise<string | null> {
  const number = typeof rmaNumber === 'string' ? rmaNumber.trim() : ''
  const id = typeof ticketId === 'string' ? ticketId.trim() : ''
  if (!number || number.length > 64 || !id) return null
  try {
    const found = await lookup(number)
    return found && found === id ? found : null
  } catch {
    return null
  }
}

/**
 * Neutralises LIKE metacharacters so the lookup matches one RMA number instead
 * of a pattern.
 *
 * ilike is used for case-insensitivity — customers type "rma-…" — but it also
 * honours % and _. Unescaped, "RMA-21052026%" returned a real ticket without
 * knowing the number, collapsing the guessing space to a handful of days.
 * Backslash first, or it would double-escape the escapes added after it.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}
