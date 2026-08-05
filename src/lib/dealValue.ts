/**
 * Deal value rules.
 *
 * A deal's value means two different things depending on where the deal sits:
 *
 *   open       → FORECAST. Sum of every quotation still in play, so the deal shows
 *                what it could be worth while it is being worked.
 *   won / lost → ACTUAL.   Sum of only the quotations that became Sales Orders, so
 *                a closed deal reports what genuinely materialised.
 *
 * Dead quotations (cancelled / declined / expired) and archived ones never count
 * toward either figure.
 *
 * Keyed off the deal's `status`, never stage names — stages are user-configurable
 * in Control Panel, so a rule that matched on stage names would silently break the
 * first time someone renamed or added one.
 *
 * Deals that have no quotations at all keep a hand-typed value; callers must skip
 * the sync entirely for those rather than writing 0 over it.
 */

/** Quotation statuses that are still in play. */
export const LIVE_QT_STATUSES = ['draft', 'sent', 'accepted', 'converted']

/** The subset of a quotation this module needs. */
export interface ValuedQuotation {
  status: string
  archived?: boolean | null
  total?: number | null
}

export function liveQuotations<T extends ValuedQuotation>(list: T[]): T[] {
  return list.filter((q) => !q.archived && LIVE_QT_STATUSES.includes(q.status))
}

export function convertedQuotations<T extends ValuedQuotation>(list: T[]): T[] {
  return list.filter((q) => !q.archived && q.status === 'converted')
}

export function sumTotals(list: ValuedQuotation[]): number {
  return list.reduce((sum, q) => sum + Number(q.total ?? 0), 0)
}

/**
 * The deal's value for a given deal status. Pass the status the deal is ABOUT to
 * have when computing during a transition (marking won, reopening) — the caller
 * usually knows the target status before the row has been refetched.
 */
export function dealValueFor(list: ValuedQuotation[], dealStatus: string): number {
  return sumTotals(dealStatus === 'open' ? liveQuotations(list) : convertedQuotations(list))
}

/**
 * A deal carrying quotations can only be marked won once at least one has been
 * converted to a Sales Order — otherwise its actual value would be 0 and the win
 * would not be backed by a real order. Deals with no quotations are unaffected.
 */
export function canMarkDealWon(list: ValuedQuotation[]): boolean {
  return list.length === 0 || convertedQuotations(list).length > 0
}
