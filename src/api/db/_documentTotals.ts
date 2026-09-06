/**
 * The one place a sales document's money is calculated (BUG-013).
 *
 * This formula previously existed in four separate copies — `computeTotals` in
 * `crmInvoices.ts`, an inline reduce in `creditNotes.ts`, `totals` in
 * `SalesDocumentForm.jsx`, and `lineTotal` in the credit-note modal — and they
 * had drifted. The credit-note copies dropped discount and tax entirely, so a
 * credit note raised against an invoice line of 1000.00 with 10% discount and
 * 14% VAT previewed as 1026.00 in the modal and was stored as 1000.00, leaving
 * the invoice 26.00 short when `issue_credit_note` applied the (wrong) total.
 *
 * Order of operations matters and is fixed here deliberately: discount applies
 * to the line base, and tax applies to the discounted amount — never the other
 * way round, which would over-charge tax on money the customer never paid.
 */

export interface DocumentLine {
  qty: number
  unit_price: number
  discount_pct?: number | null
  tax_pct?: number | null
}

export interface DocumentTotals {
  /** Gross, before discount. */
  subtotal: number
  discount_amount: number
  tax_amount: number
  /** subtotal - discount_amount + tax_amount */
  total: number
}

const round2 = (n: number): number => Math.round(n * 100) / 100

export function computeDocumentTotals(lines: readonly DocumentLine[]): DocumentTotals {
  let subtotal = 0
  let discount_amount = 0
  let tax_amount = 0

  for (const line of lines) {
    const base = (Number(line.qty) || 0) * (Number(line.unit_price) || 0)
    const disc = base * ((Number(line.discount_pct) || 0) / 100)
    const afterDisc = base - disc
    const tax = afterDisc * ((Number(line.tax_pct) || 0) / 100)
    subtotal += base
    discount_amount += disc
    tax_amount += tax
  }

  return {
    subtotal: round2(subtotal),
    discount_amount: round2(discount_amount),
    tax_amount: round2(tax_amount),
    total: round2(subtotal - discount_amount + tax_amount),
  }
}

/** Total for a single line, matching computeDocumentTotals exactly. */
export function computeLineTotal(line: DocumentLine): number {
  return computeDocumentTotals([line]).total
}
