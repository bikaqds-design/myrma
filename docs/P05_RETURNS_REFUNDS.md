# P-05 — Customer returns, and refunds

Owner decisions (2026-09-27): **goods first** — a return credit note is made
from a confirmed return, and credits exactly what came back (price
adjustments, rebates and goodwill credit notes are unchanged); a returned item
goes **back to stock** only (sellable again, into a main/branch warehouse, at
the cost it left with — damaged goods keep going through an RMA ticket);
**managers and above** confirm a return; **every refund needs a second
manager** (one records it, a different one approves it).

## Why

Gap analysis BL-08 (tests T-04a, T-04c). Today a return credit note credits
the money, but nothing brings the goods back: `creditNotes.restoreUnits` has no
caller, both credit-note modals hard-code `restock: false`, `restock_status`
stays `pending` for ever, and bulk stock has no return path at all. A "refund"
is only a `ticket_resolutions` row; no money leaves a credit note's balance or
an overpayment, so a customer owed money back cannot be paid through the
system, and nobody approves it.

## Model

- `customer_returns` — one return of goods from one **confirmed delivery**
  (P-01) whose invoice is **posted**: `draft → confirmed`, or
  `draft → cancelled`. A gapless `RTN-YYYY-NNNNN` code is assigned at
  confirmation, and a free-text reason (P-05b gives the credit note its
  `return` reason code).
- `customer_return_lines` — which delivery line, how many, into which
  sellable warehouse, and (serialized) exactly which units come back — they
  must be units that left on that delivery line. At confirmation: the cost it
  comes back at (`cost_base`, `cost_unknown_qty`).
- `customer_return_line_units` / `customer_return_line_bins` — which units and
  bins it refilled, at what cost.
- Stock moves use `doc_type = 'customer_return'`, `move_type = 'restore'`.
- A delivery line's returned quantity is the sum of its confirmed returns;
  drafts hold their quantity too, so two drafts cannot return the same goods.

### Cost

A returned serialized unit keeps its own `unit_cost_base` (it never lost it).
A bulk return goes into the chosen bin at the delivery line's average cost —
known only when every unit on that delivery line had a known cost; otherwise
the returned units are **uncosted** (`uncosted_quantity`, on the `rma_uncosted_stock()` worklist)
rather than given a cost nobody paid.

### Why only against a posted delivery invoice

The credit note (P-05b) credits the invoice line the goods were billed on. A
delivery that is not invoiced yet is invoiced first and credited. Once a
delivery has a return, it cannot be invoiced again (its invoice was voided
after the return), or the returned goods would be billed a second time.
Orders invoiced the old whole-order way have no delivery; they keep the
existing credit-note path until the whole-order convert is retired for stock
orders.

## Pieces (one PR each)

- **P-05a (database):** tables, `create_customer_return`,
  `confirm_customer_return`, `cancel_customer_return`, sequence
  `customer_return → RTN`, `create_invoice_from_delivery` refuses a delivery
  with a return, Backup & Restore. **Done** (#77, `20260902`).
- **P-05b (database):** `create_credit_note_from_return` — an `rma_return`
  credit note for exactly the returned lines at the invoice line's price,
  discount and tax, against the delivery's invoice; a return credit note for
  stock lines on a delivery invoice can only be made this way (goods first).
  **Done** (`20260903`): the note keeps the return's lines, goes through
  `create_credit_note` (caps and approval unchanged), one live note per return.
- **P-05c (database):** customer refunds: recorded by a manager from a credit
  note's remaining balance or a payment's unapplied amount, `pending_approval`
  until a **different** manager approves it (then numbered `RF-`, and the
  source balance goes down); rejected = voided.
- **P-05d (screens):** Returns panel on a delivery (like the Deliveries
  panel), credit note from a return, refunds in Accounting, a printable return
  note.

Not in P-05: returns to suppliers (P-06), inspection/scrap dispositions (RMA
tickets cover damaged goods), returns against whole-order invoices.
