// Customer and supplier statements (Customer Details › Billing, Vendor
// Details) — A-05b part 2. Each entry keeps its own-currency amount, but the
// balance adds every entry, so it can only be in the base currency: it adds
// `amount_base` (20260913), in cents so a long statement does not drift.
//
// An 'exchange_difference' entry is the difference realised when an invoice
// was settled at another rate. It has no amount in the document's currency —
// only in base — so that is what it shows. With those rows the balance equals
// the customer's (or supplier's) balance in the ledger.

export const EXCHANGE_DIFFERENCE = 'exchange_difference'

const cents = (n) => Math.round((Number(n) || 0) * 100)

/** An entry's base-currency amount (older rows without one: their own amount). */
export function baseAmount(entry) {
  return entry?.amount_base ?? entry?.amount ?? 0
}

/**
 * The statement's lines with a running balance in base, and what each line
 * shows in its Amount column: { value, currency } — the entry's own amount and
 * currency, or for an exchange difference its base amount in the base currency.
 */
export function statementLines(entries, baseCurrency) {
  let running = 0
  return (entries || []).map((entry) => {
    running += cents(baseAmount(entry))
    const fx = entry.entry_type === EXCHANGE_DIFFERENCE
    return {
      ...entry,
      running: running / 100,
      shown: fx
        ? { value: Number(entry.amount_base) || 0, currency: baseCurrency }
        : { value: Number(entry.amount) || 0, currency: entry.currency || baseCurrency },
    }
  })
}

/** The balance in base currency: what the last line's running balance says. */
export function statementBalance(entries) {
  return (entries || []).reduce((sum, e) => sum + cents(baseAmount(e)), 0) / 100
}
