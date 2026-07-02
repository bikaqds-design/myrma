# Quickstart: Validating Sales Funnel Hardening

Manual validation scenarios that prove the hardened funnel works end-to-end. Run after each implementation phase. Maps to the spec's Success Criteria (SC-00x) and the audit findings (Hx/Mx). Detailed RPC signatures live in [`contracts/`](./contracts/); invariants in [`data-model.md`](./data-model.md).

## Prerequisites

- Working tree at the funnel code (`test` @ ≥ `0e78b1b`).
- Apply the feature migrations in order in the Supabase SQL Editor (created during implementation):
  `20260732_funnel_line_reservation.sql` → `20260733_so_lifecycle_rpcs.sql` → `20260734_invoice_lifecycle_rpcs.sql` → `20260735_cn_payment_lifecycle_rpcs.sql` → `20260736_lead_deal_guards.sql`.
- Seed test data via the **relocated** `scripts/manual/20260731_crm_funnel_test_data_reset.sql` (run by hand — confirm it is NOT in `supabase/migrations/`).
- Gate: `npm test && npm run lint && npm run build` all green.

## Scenario 1 — Mixed-line order approves (SC-001, H1)

1. Create a quotation with three lines: a serialized product (has `inventory_units`), a fungible part, and a service/non-stock product.
2. Submit → approve from the Activities page (as a manager).
3. **Expect**: SO lands `delivered`; serialized line reserved a unit; part's `reserved_quantity` incremented; service line moved nothing; **no "Insufficient stock" error**.
4. Verify in SQL: `stock_moves` has a `reserve` row for the unit and the part, none for the service.

## Scenario 2 — Approved order releases on cancel (SC-002, H2)

1. Note a product's `available` count. Approve an SO that reserves it.
2. Confirm `available` dropped. Then **Cancel** the (not-invoiced) SO.
3. **Expect**: SO → `cancelled`; `available` returns to the original number; `stock_moves` shows matching `release` rows. No stranded `reserved` units/parts.

## Scenario 3 — Atomic post (SC-003, H4/M1)

1. Approve an SO, convert to invoice, approve (post) it.
2. **Expect**: invoice `posted` with an `inv_code`; stock delivered (on-hand decremented) — both present together.
3. Failure injection (dev): temporarily make a line reference a product whose deliver will fail; attempt post.
   **Expect**: invoice stays `draft`, no `inv_code` assigned, no partial stock movement, sequence number not burned.

## Scenario 4 — Atomic AR application (SC-003, H4)

1. Post an invoice (total = 115, amount_paid = 0).
2. Issue a credit note linked to it for 115.
3. **Expect**: CN `issued`/`applied`; invoice `amount_paid = 115`, `payment_status = paid`; aging report shows 0 outstanding for it; `v_customer_ledger` nets to the same balance. The invoice view and the aging report agree.
4. Repeat with a payment instead of a CN; same consistency.

## Scenario 5 — No duplicate documents (SC-004, H4/FR-006)

1. On a quotation, click Convert to SO; immediately retry / double-click.
2. **Expect**: exactly one SO exists for the quotation; the second attempt errors with `Quotation already converted`.
3. Two managers approve the same approval activity near-simultaneously → exactly one post / one set of stock movements.

## Scenario 6 — Separation of duties (SC-005, M5)

1. As a `sales_rep` who owns a quotation/SO, attempt the approve transition via the API (`supabase.rpc('approve_sales_order', …)`).
2. **Expect**: refusal `Not authorized to approve sales orders` — enforced by the RPC, not just hidden in the UI.

## Scenario 7 — Governed bulk edits (SC + M2/M3)

1. Convert a lead. Then bulk-update a selection that includes it (change status).
   **Expect**: the converted lead is refused/untouched (`Converted leads are immutable except for notes`); others update.
2. Select a won deal and bulk-move it to a non-terminal stage.
   **Expect**: stage changes **and** `status` resets to `open`, `won_at` cleared — no won deal left in a non-terminal stage. An invalid stage for any selected deal's pipeline rejects the whole batch.

## Scenario 8 — Safe void (M4/FR-010)

1. Post an invoice, record a payment against it. Attempt to void.
   **Expect**: refusal `Reverse payments/credit notes before voiding`; customer ledger unchanged (never goes negative).
2. Post a fresh unpaid invoice, void it.
   **Expect**: allowed; delivered stock restored to available; `payment_status = reversed`.

## Scenario 9 — Migration safety (SC-006, H3)

1. On a clean DB, run the full `supabase/migrations/` set (`supabase db push`).
2. **Expect**: completes with no destructive data reset; the reset script is absent from the pipeline (lives in `scripts/manual/`).

## Regression gate (SC-007)

- Re-run the 14-item funnel checklist + Accounting v1 rows (42–52) in `MASTER_UPGRADE_PLAN.md`.
- `npm test && npm run lint && npm run build` green.
