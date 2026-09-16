# Feature Specification: Sales Funnel Hardening

**Feature Branch**: `003-sales-funnel-hardening` (pinned via `.specify/feature.json`; work continues on `test`)
**Created**: 2026-06-30
**Status**: Draft
**Input**: `sales-funnel-audit.md` (enterprise audit of Lead → Deal → Quotation → Sales Order → Invoice → Credit Note / Payment)

## Overview

The sales funnel was built across Sprint 6 (Sales Documents) and Accounting v1. A full audit (`sales-funnel-audit.md`) found that, while the happy path works, several transitions break for common inputs, can strand inventory, can desynchronize the financial ledger on partial failure, and lack server-side lifecycle invariants. This feature hardens the funnel so every component connects end-to-end with **database-enforced** invariants suitable for enterprise use — no stuck states, no orphaned stock, no money/stock drift, no client-only governance.

## User Scenarios & Testing

### Primary user story

A sales rep quotes a customer (any mix of stocked products, fungible parts, and non-stock/service lines), submits for approval; a manager approves it into a sales order, which reserves the right inventory; the order is invoiced and posted (decrementing stock and assigning a gapless invoice number); payments and credit notes are applied. At every step, if something is not allowed the system refuses cleanly with a clear reason, and a half-finished operation never leaves the document, inventory, and ledger in disagreement.

### Acceptance scenarios

1. **Non-serialized lines convert**: Given a quotation containing a service line and a fungible-part line, when a manager approves the resulting sales order, then the order is accepted, fungible parts are reserved via the parts counter, service lines reserve nothing, and no "Insufficient stock" error is raised for lines that need no serialized unit.
2. **Approved order can be released**: Given an approved (stock-reserved) sales order that has **not** been invoiced, when it is cancelled, then all its reservations (serialized units and parts) return to available and the order moves to `cancelled`.
3. **Atomic post**: Given a draft invoice linked to an approved sales order, when it is posted, then code assignment, status change, and inventory delivery all succeed together or all roll back together — never a posted invoice with un-decremented stock.
4. **Atomic credit note / payment apply**: Given a credit note or payment applied to an invoice, when applied, then the application record and the invoice's `amount_paid`/`payment_status` update together — the aging report and the invoice view never disagree.
5. **No duplicate documents**: Given a quotation, when conversion to a sales order is attempted twice (double-click, retry, or two managers), then exactly one sales order is created and the second attempt fails cleanly.
6. **Separation of duties**: Given a sales rep who owns a quotation, when they attempt to approve it themselves through any path, then the system refuses (approval requires manager-or-above), enforced at the database, not only hidden in the UI.
7. **Governed bulk edits**: Given a converted lead and a won/lost deal, when bulk operations run, then converted-lead immutability holds and bulk stage moves cannot set an invalid stage or leave a deal in an inconsistent won/lost state.
8. **Safe void**: Given a posted invoice with a payment applied, when a void is attempted, then the system refuses (a reversal/credit must happen first) so the customer ledger cannot go silently negative and delivered stock is not lost without a record.
9. **Migrations are safe**: Given the standard `supabase db push`, when migrations run, then no destructive test-data reset executes as part of the normal pipeline.

### Edge cases

- A line product has *some* serialized stock but less than ordered → reservation refuses with a per-line shortfall, atomically (no partial reservation left behind).
- Concurrent approvals of the same approval activity → one wins, the other is a clean no-op/error; no double post, no burned sequence number, no double stock movement.
- An invoice whose source sales order was never approved → posting either reserves+delivers atomically or refuses; it never posts with zero stock movement silently.
- Voiding an unpaid posted invoice → allowed, and any reservation/delivery is reversed or explicitly recorded.

## Requirements

### Functional Requirements

- **FR-001 (H1)**: Sales order approval MUST handle every line type — serialized products (reserve units), fungible parts (reserve parts counter), and non-stock/service lines (reserve nothing) — without failing the whole approval for lines that legitimately have no serialized stock.
- **FR-002 (H1)**: The system MUST be able to classify a document line as serialized-stock, fungible-part, or non-stock/service so reservation and delivery dispatch correctly.
- **FR-003 (H2)**: An approved (reserved) sales order that has not been invoiced MUST have a path to release its reservations and cancel, returning all reserved stock to available.
- **FR-004 (H3)**: Destructive test-data/reset scripts MUST NOT live in the migrations pipeline that `supabase db push` executes.
- **FR-005 (H4)**: Each funnel lifecycle transition that performs more than one write (quotation→order conversion; order approval reserve+status; invoice post code+status+deliver; credit-note issue+apply+invoice-balance; payment record+apply+invoice-balance) MUST be atomic — all writes commit together or none do.
- **FR-006 (H4)**: Quotation→sales-order conversion MUST be idempotent — a second conversion of an already-converted quotation MUST NOT create a second sales order.
- **FR-007 (M1)**: Concurrent execution of a single approval MUST NOT double-post, double-deliver, double-apply, or burn a gapless sequence number; transitions MUST be guarded against the read-then-write race.
- **FR-008 (M2)**: Bulk deal stage moves MUST validate each deal's stage against its pipeline and MUST keep `status`/`won_at`/`lost_at` consistent with the target stage (no won deal left in a non-terminal stage, no invalid stage written).
- **FR-009 (M3)**: Bulk lead updates MUST honor the same converted-lead immutability that single-record updates enforce.
- **FR-010 (M4)**: Voiding a posted invoice that has any payment or credit-note applied MUST be refused (or must reverse those applications and inventory as part of the void) so the customer ledger cannot be left inconsistent.
- **FR-011 (M5)**: The approve/reject transition for each document MUST be enforced as manager-or-above at the data layer, not only gated in the UI.
- **FR-012 (L1)**: Lead conversion to an existing customer MUST validate that the customer exists and is visible/assignable to the actor.
- **FR-013 (L2)**: Document action controls MUST NOT offer actions that the underlying state machine will always reject (e.g. "Cancel" on a delivered order that cannot be cancelled).
- **FR-014**: Every refused transition MUST return a clear, user-presentable reason; no silent no-ops.
- **FR-015**: All new strings ship in both `en.json` and `ar.json`; all new tables/RPCs follow RLS-by-default and the `rma_*` helper convention (Constitution III).

### Key Entities

- **Document line classification** — a way to know whether a quotation/order/invoice line is serialized-stock, fungible-part, or non-stock/service (drives reservation/delivery dispatch). May derive from the existing product/parts catalog rather than a new column.
- **Sales order reservation lifecycle** — the relationship between an order's status and the inventory it holds (reserved vs delivered vs released), with a defined release path.
- **Lifecycle transition RPCs** — server-side, atomic, role-checked transitions for: quotation→order, order approve/reject, invoice post/void, credit-note issue/apply, payment record/apply.

## Success Criteria

- **SC-001**: A quotation containing a service line, a parts line, and a serialized-product line converts to an order and is approved with correct per-line inventory treatment and zero spurious stock errors.
- **SC-002**: After approving and then cancelling a non-invoiced order, on-hand availability returns to exactly its pre-approval value (no stranded reservations) — verifiable via stock counts and `stock_moves`.
- **SC-003**: Injected mid-transaction failure in post / credit-note-apply / payment-apply leaves document status, inventory, and the customer ledger fully consistent (transition either fully applied or fully absent).
- **SC-004**: Attempting a duplicate quotation→order conversion or a concurrent double-approval yields exactly one resulting document and one set of stock movements.
- **SC-005**: A non-manager cannot move any document past an approval gate through any available path (UI or direct API), verified against RLS/RPC behavior.
- **SC-006**: `supabase db push` on a clean database runs the full migration set with no destructive data reset.
- **SC-007**: Existing gates stay green — `npm test`, `npm run lint`, `npm run build` all pass; no regression in the 14-item funnel checklist or Accounting v1 checks.

## Out of Scope

- General ledger / double-entry bookkeeping, multi-currency, bank reconciliation (explicitly deferred in Accounting v1).
- New funnel features (e.g. partial deliveries, backorders, multi-warehouse allocation) — this feature hardens existing transitions, it does not add new commercial capabilities.
- Refund/payment-reversal UX beyond what FR-010 requires to keep the ledger consistent.
