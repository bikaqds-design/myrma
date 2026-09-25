# P-03 — Goods receipts, and invoicing what was received

Owner decisions (2026-09-25): only **managers and above** confirm a receipt;
goods that arrive before the supplier invoice are costed at the **PO price**,
and when the invoice differs (price, freight) the **stock still on hand takes
the real cost** and whatever was already sold is reported as a price variance;
a supplier invoice from a PO bills **only what was received** (three-way match:
order → receipt → invoice); receiving on the supplier invoice (today's path)
**stays for orders with no receipts** and is retired later.

## Why

Today stock arrives only when a supplier invoice is approved and "received":
`receive_vendor_invoice` creates the units / fills the bins and costs them from
the invoice. Goods that arrive before the paperwork cannot be recorded, a
shipment cannot be checked against the order before the bill comes, and an
invoice can bill for goods that never came.

## Model

- `goods_receipts` — one arrival against one confirmed purchase order:
  `draft → confirmed`, or `draft → cancelled`. A gapless `GRN-YYYY-NNNNN` code
  is assigned at confirmation (like `DN-`), plus the supplier's own delivery
  note number (`supplier_ref`).
- `goods_receipt_lines` — which PO line, how many, into which warehouse, the
  serial numbers for a serialized product (scanned on arrival), and at
  confirmation the unit cost it was booked at (`unit_cost_base`: the PO line's
  net price in the base currency; unknown when the line has no price).
  `qty_invoiced` records how much of it a supplier invoice has billed (P-03b).
- `goods_receipt_line_units` / `goods_receipt_line_bins` — exactly which units
  and bins it filled, so a later invoice can re-cost what is still on hand.
- Stock moves use `doc_type = 'goods_receipt'`. New units carry
  `inventory_units.goods_receipt_id`.
- A PO line's received quantity is the sum of its **confirmed** receipts. The
  first confirmed receipt moves the order to `partially_completed`, the last
  one to `completed`.

## Two paths, never mixed on one order

1. **Receipt path (new):** confirmed PO → receipt (draft: quantities,
   warehouse, serials; never more than the line still has open, drafts
   counted) → a manager confirms it (stock and cost arrive now) → supplier
   invoice for what was received (P-03b).
2. **Legacy path (today):** convert the PO to a supplier invoice → approve →
   receive on the invoice. Kept for orders with no receipts.

`create_goods_receipt` refuses an order that already received stock on a
supplier invoice; `receive_vendor_invoice` refuses an invoice whose order has
any receipt. An order with a receipt cannot be amended (its lines are what was
received against).

## Pieces (one PR each)

- **P-03a (database):** tables, `create_goods_receipt`,
  `confirm_goods_receipt`, `cancel_goods_receipt`, sequence `goods_receipt →
  GRN`, the two-path exclusion.
- **P-03b (database):** supplier invoice from receipts (bills received − already
  invoiced; several invoices per order), approval re-costs the stock still on
  hand from each receipt and records the variance on what was already sold.
- **P-03c (screens):** receipts on the purchase-order page (receive, scan
  serials, confirm, cancel, print a receipt note); invoice from receipts.

## Not in scope here

Returns to the supplier (P-06), quality-inspection holds, receiving without a
purchase order.
