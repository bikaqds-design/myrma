# A-04 — Tax codes and the VAT return

Gap analysis BL-15 (R-14: VAT misstatement). Plan item A-04: *tax codes, per-line
tax snapshots, VAT return report — posted tax unchanged when a rate later changes.*

## A-04a — database (`20260911_tax_codes.sql`)

- **`tax_codes`**: `code` (e.g. `VAT14`), name / Arabic name, `kind` (`standard`,
  `reduced`, `zero`, `exempt`, `out_of_scope`), `rate`, `is_default` (the code a
  line takes when it carries only a rate — one per rate), `is_active`. Written by
  administrators and accountants (`rma_is_finance()`), read by staff, audited.
  **`tax_code_rates`** keeps every rate a code has had.
- **Every document line has `tax_code`**, and its existing `tax_pct` is the rate
  the code had when the line was written (the snapshot). A posted document cannot
  be rewritten, so a later rate change never changes posted tax.
  - A line with only a rate takes the default code for that rate.
  - A line that names a code gets the code's current rate. A credit note or a
    supplier bill may keep any rate its code has had.
  - A screen that sends a line back without a code, at the same rate, keeps the
    line's code (the writers remember the previous codes for one save).
  - Quote → order → invoice, delivery → invoice, return → credit note,
    order → supplier bill and receipts → supplier bill carry the code.
- **No posting without a code.** Posting an invoice, issuing a credit note and
  approving a supplier bill fill missing codes with the default for the rate, and
  are refused while a line still has none. An invoice saved before its code's
  rate changed must be saved again before it is posted (tax point = posting).
- **VAT return**: `rma_vat_return(from, to)` — output and input by side, code and
  rate: net and tax, from the documents the ledger posted in the period (invoices
  posted/voided, credit notes issued/voided, supplier bills approved/cancelled, the
  bills in base currency at their own rate). `rma_vat_return_ledger(from, to)`
  gives the ledger's VAT account movements to tie it to. Managers and accountants.
- Also added for A-04b: `products.tax_code` (a product's usual code) and
  `customers.tax_status` / `brands.tax_status` (`registered`, `unregistered`,
  `exempt`, `foreign`), so the screens can propose a line's code.

## Starting codes

`VAT<rate>` standard at the tenant's `default_tax_rate` (staging: `VAT14`),
`ZERO` (default for 0 %), `EXEMPT`, `OOS`, and a code for any other rate existing
lines already use. **Existing 0 % lines were given `ZERO` (zero-rated).**

## Defaults to confirm

1. Existing and new 0 % lines default to **zero-rated**, not exempt. Exempt must
   be chosen on the line (A-04b screens). Zero-rated and exempt sit in different
   boxes of a VAT return.
2. Tax codes are configured by **administrators and accountants** (BL-15:
   "tax.configure (finance)").
3. A posting is **refused** while a line has no code (BL-15), rather than posted
   at its typed rate.

## Not in scope

Withholding tax (Egypt's WHT deducted by the customer) — a separate mechanism, not
a VAT code. Tax by customer / supplier reports. E-invoicing (W5).

## A-04b — screens (next)

Control Panel › Tax codes; a code on every document line (proposed from the
product and the customer's / supplier's status); tax status on customers and
suppliers; Accounting › VAT return with the ledger check; the tax registration
number on printed invoices.
