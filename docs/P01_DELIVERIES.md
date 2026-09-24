# P-01 / P-02 — Deliveries, and invoicing what was delivered

Owner decisions (2026-09-24): partial deliveries with back-orders; only
**managers and above** confirm a delivery; goods are invoiced **only for what
was delivered** (services and advance billing use a separate manual invoice).

## Why

Today `post_invoice` does three things at once: it numbers the invoice,
captures cost of goods (`rma_invoice_cogs`, from whatever is still reserved
for the order) and delivers **every** unit reserved for the order
(`deliver_units` / `deliver_warehouse_stock`, which work per order, not per
line). So stock only leaves when an invoice is posted, a part-shipment cannot
be recorded, and an order can only be billed in one go.

## Model

- `deliveries` — one shipment against one confirmed sales order:
  `draft → confirmed`, or `draft → cancelled`. A gapless `DN-YYYY-NNNNN` code
  is assigned at confirmation (like `INV-`).
- `delivery_lines` — which order line, how many. At confirmation each line
  records the cost of what left (`cogs_base`, `cogs_unknown_qty`), and the
  exact units / bins it took (`delivery_line_units`, `delivery_line_bins`).
- Stock moves stay under `doc_type = 'sales_order'`, `doc_id = <order>`, so the
  reservation ledger (net reserved per order) keeps working unchanged; the
  delivery tables say which delivery took them.
- An order's delivered quantity per line is the sum of its **confirmed**
  deliveries. When every stock line is fully delivered the order becomes
  `delivered` (it is `confirmed` until then; no new status).

## Two paths, never mixed on one order

1. **Delivery path (new):** confirmed order → delivery (draft, choose
   quantities per line, never more than is still undelivered) → a manager
   confirms it (stock and cost leave now) → invoice from that delivery
   (P-02). That invoice moves no stock; its cost of goods is the delivery's.
2. **Legacy path (today):** `convert_so_to_invoice` → `post_invoice` delivers
   everything. Kept for orders with no deliveries until the screens move over.

`create_delivery` refuses an order that already has a live legacy invoice;
`convert_so_to_invoice` refuses an order that has any delivery. So stock can
never leave twice.

## Pieces (one PR each)

- **P-01a (database):** tables, `create_delivery`, `confirm_delivery`,
  `cancel_delivery`, sequence `delivery → DN`, the two-path exclusion.
- **P-02a (database):** `create_invoice_from_delivery(delivery)`, and
  `post_invoice` leaves stock alone and takes the delivery's cost for such an
  invoice.
- **P-01b / P-02b (screens):** deliveries on the sales-order page (create,
  confirm for managers, cancel, print), "Invoice this delivery"; then the
  legacy convert button is retired.

## Not in scope here

Delivery addresses/carriers/tracking, returns against a delivery (P-05),
delivering from a specific warehouse other than the one holding the
reservation.
