# Sales Funnel Audit — Lead → Invoice

**Date:** 2026-06-30 · **Branch:** `test` @ `0e78b1b` · **Auditor:** Claude (Opus 4.8)
**Scope:** Enterprise-grade audit of the full sales funnel — Lead → Deal → Quotation → Sales Order → Invoice → Credit Note / Payment — to find gaps, bugs, and broken connections between components.

> **Note on the codex report:** the companion `codex sales funnel audit.md` was run against a **stale checkout** (local `test` @ `e852061`) that predated the entire Sales Documents + Accounting build, so its top finding ("the live code only implements Lead to Deal") is an artifact of auditing the wrong commit, not a real gap. This audit was run against the actual funnel code after fast-forwarding the working tree to `origin/test` (`0e78b1b`). Codex findings that touch code present on both branches are cross-referenced below and remain valid.

---

## Extracted system logic (as actually wired)

```
Lead ──convert()──▶ Customer + Deal           [atomic RPC crm_convert_lead]
Deal ──"Create Quotation"──▶ Quotation(draft)
Quotation: draft ─send─▶ sent ─[manager approve]─▶ accepted ─convert─▶ Sales Order(draft)
                                              └─[reject]─▶ declined        + qt.status=converted
Sales Order: draft ─send─▶ sent ─[manager approve = markAccepted]─▶ delivered  (RESERVES stock)
Sales Order(delivered) ──convert──▶ Invoice(draft)  [+ raises invoice approval activity]
Invoice: draft ─[manager approve = post()]─▶ posted (assigns INV-code, DELIVERS stock)
Invoice(posted) ─record payment─▶ payment row + payment_application + amount_paid↑
Invoice(posted) ─▶ Credit Note(draft) ─issue()─▶ issued (assigns CN-code, applies to invoice, restocks if rma_return)
```

The **approval pool** is the spine: each submit raises an `activities` row of `type:'approval'` whose `title` encodes `approval|docType|docId|code|total|customer`; a manager's Approve/Reject on the Activities page dispatches to that document's lifecycle action (`src/pages/Activities/index.jsx:405-422`).

---

## Findings, ranked by severity

### 🔴 HIGH — break the funnel or corrupt stock/money

#### H1 — Sales Order approval is impossible for any product not already serialized in stock
- **Where:** `src/api/db/salesOrders.ts:189-213` (`markAccepted`), `supabase/migrations/20260719_inventory_reservation.sql:56-68` (`reserve_units`), `src/api/db/inventory.ts:138` (units only created on stock-in).
- **Evidence:** `markAccepted` calls `reserve_units` for **every** line. `reserve_units` raises `Insufficient stock` whenever the product has zero available `inventory_units` rows. `reserve_parts`/`deliver_parts` exist but are **never called anywhere in `src/`**.
- **Failure scenario:** quote a service, a part, or any not-yet-stocked catalog item → manager clicks Approve → "Insufficient stock" → SO stuck at `sent`. The funnel dead-ends for the majority of sellable items.
- **Fix direction:** branch on line type / product stock model — reserve serialized units via `reserve_units`, fungible parts via `reserve_parts`, and skip reservation for non-stock/service lines. Requires a way to classify a line (stock vs part vs service).

#### H2 — Reserved inventory is stranded forever on an approved SO that never gets invoiced
- **Where:** `src/api/db/salesOrders.ts:189-213` (`markAccepted` sets `status='delivered'` + reserves), `src/api/db/salesOrders.ts:280-304` (`cancel`).
- **Evidence:** `cancel()` throws on `status='delivered'` and only calls `release_units` when `status='confirmed'` — a state the live approval flow never produces. No "un-approve" path exists.
- **Failure scenario:** approve an SO (stock reserved) → deal falls through → cannot cancel → units locked as `reserved` permanently. Stock leaks out of availability with no recovery.
- **Fix direction:** add a release path for an approved SO (either allow cancel from `delivered`-but-not-invoiced and release the reservation, or introduce a distinct `approved`/`reserved` status separate from `delivered`).

#### H3 — The data-reset script lives in `supabase/migrations/` and will wipe production on a normal migrate
- **Where:** `supabase/migrations/20260731_crm_funnel_test_data_reset.sql`.
- **Evidence:** it `DELETE`s all leads/deals/activities/quotations/sales_orders/crm_invoices; `README.md` documents `supabase db push`, which runs every file in that folder.
- **Failure scenario:** anyone running the standard migrate flow wipes the entire funnel.
- **Fix direction:** move to `scripts/manual/` or `supabase/seed/`. *(codex finding #2 — valid.)*

#### H4 — Lifecycle transitions are multi-write but not atomic; partial failure desyncs document ↔ inventory ↔ AR ledger
- **Where:**
  - `src/api/db/crmInvoices.ts` `post()` — posts (RPC) then *separately* `deliver_units`.
  - `src/api/db/creditNotes.ts` `issue()` — RPC + `get` + `applyToInvoice` + `recordPayment` as 4 separate awaits.
  - `src/api/db/payments.ts` `record()` — RPC then a loop of [insert application + recordPayment].
  - `src/api/db/quotations.ts:272-297` `convertToSalesOrder()` — inserts SO then *separately* flips `qt.status='converted'`.
- **Failure scenario:** any mid-sequence failure leaves the document, inventory, and ledger inconsistent — e.g. invoice posted but stock not decremented; CN "applied" but invoice `amount_paid`/aging wrong; duplicate sales orders from one quotation (no DB idempotency guard, unlike SO→Invoice).
- **Fix direction:** collapse each transition into a single `SECURITY DEFINER` RPC that does all writes in one transaction.

### 🟠 MEDIUM

#### M1 — Double-approval race / no row locks
- **Where:** `post_invoice`, `issue_credit_note`, `record_payment` RPCs; `markAccepted`.
- **Evidence:** all read-then-write without `SELECT … FOR UPDATE`. Two concurrent approvals (or a double-click before the activity completes) can post twice / deliver stock twice / burn a sequence number. Status guards catch the sequential case but not concurrent TOCTOU.
- **Fix direction:** add `SELECT … FOR UPDATE` (or a conditional `WHERE status='draft'` update) inside each transition RPC.

#### M2 — `deals.bulkMoveStage()` skips validation and terminal semantics
- **Where:** `src/api/db/deals.ts:197-204`.
- **Evidence:** writes `stage` with no `assertValidStage` and never resets `status`/`won_at`/`lost_at`. *(codex — valid.)*
- **Fix direction:** validate stage per deal; reset terminal fields on move; reject mixed-pipeline bulk moves.

#### M3 — `leads.bulkUpdate()` bypasses converted-lead immutability
- **Where:** `src/api/db/leads.ts:98-102` (vs guard at `:60-65`).
- **Evidence:** updates directly with no converted-lead guard and no DB-level guard. *(codex — valid.)*
- **Fix direction:** apply the same guard in `bulkUpdate`, ideally backed by a DB trigger.

#### M4 — Voiding a paid invoice leaves a dangling customer credit and unrestored stock
- **Where:** `src/api/db/crmInvoices.ts` `void_()`.
- **Evidence:** only checks `doc_status='posted'`. Voided invoice drops out of `v_customer_ledger` (`+total` removed) while its payment/CN rows remain (`−amount`) → customer balance goes negative; delivered inventory never restored.
- **Fix direction:** block voiding an invoice with payments/applications (require reversal first), or reverse payments + restore stock as part of void.

#### M5 — Approval enforced only in the UI, not server-side
- **Where:** `src/pages/Activities/index.jsx:315` (`canApprove`), vs the plain RLS updates behind `quotations.markAccepted` etc.
- **Evidence:** the document's own `assigned_rep`/`created_by` can perform the transition via the API; a `sales_rep` could self-approve. No separation-of-duties at the data layer.
- **Fix direction:** enforce the approve transition in a `SECURITY DEFINER` RPC with an internal `rma_is_manager_or_above()` check.

### 🟡 LOW

- **L1** — `crm_convert_lead` links `p_existing_customer_id` with no existence/visibility check. *(codex — valid.)*
- **L2** — SO detail shows a **Cancel** button for `status='delivered'` (`src/pages/SalesDocuments/SalesDocumentDetail.jsx:515`) that `cancel()` always rejects.
- **L3** — Free-form quotation lines (`product_id:null`) flow into totals, only blocked at SO conversion. *(codex — valid.)*
- **L4** — `canApprove` in `src/pages/SalesDocuments/SalesDocumentDetail.jsx:113` is dead code.

---

## What's genuinely solid

- **Lead→Customer→Deal** is one atomic `SECURITY DEFINER` RPC with an internal authz check.
- **Gapless INV-/CN- numbering** via `document_sequences` + a row-locked `nextval_for_type`; `post_invoice`/`issue_credit_note` guard against sequential re-posting.
- **Customer ledger math** (`v_customer_ledger` signed union) nets invoice/CN/payment correctly on the happy path, including overpayment credit.
- **Two invoice status fields** (`doc_status` + `payment_status`) — correct Odoo-style modeling.
- `assigned_rep`/`created_by` correctly validated as **email** in Zod (the "who" convention).
- **SO→Invoice has a real DB idempotency guard** (prevents duplicate invoices from one SO).

---

## Suggested remediation order

1. **H3** — move the reset script out of `migrations/` (minutes; prevents catastrophe).
2. **H1 + H2** — fix the inventory model: parts via `reserve_parts`/`deliver_parts`, allow non-stock/service lines to skip reservation, add a release path for approved-but-cancelled SOs. This is what makes the funnel connect end-to-end.
3. **H4 + M1** — collapse each lifecycle transition into one atomic, row-locked RPC.
4. **M2–M5**, then **L1–L4**.
