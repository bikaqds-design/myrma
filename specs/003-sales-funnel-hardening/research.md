# Phase 0 Research: Sales Funnel Hardening

Resolves the design unknowns implied by the audit findings. Each decision is what the implementation will follow; alternatives are recorded so the choice is reviewable.

---

## R1 — How to classify a document line (serialized / fungible-part / non-stock) — FR-001, FR-002

**Decision**: Classify **at reservation time, in the RPC, by catalog lookup** — not by adding a field to `line_items`.
Resolution order for a line's `product_id`:
1. If the product has any `inventory_units` rows → **serialized** → reserve/deliver/release via the unit RPCs (`reserve_units`/`deliver_units`/`release_units`).
2. Else if a `parts` row matches the product → **fungible part** → use `reserve_parts`/`deliver_parts`/`restore_parts` (counter model, already exist, currently never called).
3. Else → **non-stock / service** → reserve and deliver **nothing**; record a `stock_moves` row with `move_type='noop'`/`qty=0` only if useful for audit, otherwise skip.

**Rationale**: `line_items` is historical JSONB across thousands of existing rows; adding a `line_type` would require a backfill migration of JSONB arrays (error-prone, violates "keep it simple") and a UI change to set it. The catalog already encodes the truth (a product either has serialized units, is a part, or is neither). Deriving keeps the line shape unchanged and makes old documents work without backfill.

**Alternatives considered**:
- *Add `line_type` to every line at creation* — rejected: JSONB backfill + form changes + a new source of truth to keep in sync with the catalog.
- *Require every SO line to be serialized (status quo)* — rejected: that is exactly the H1 dead-end.

**Risk / mitigation**: a product that is *both* serialized and a part is ambiguous. Mitigation: serialized takes precedence (step 1 before step 2); this matches the existing model where `inventory_units` is the stronger identity. Documented in `data-model.md`.

---

## R2 — Releasing reservations from an approved order — FR-003

**Decision**: Keep the existing `sales_orders.status` enum. Extend cancellation: a `cancel_sales_order` RPC releases **all** reservations the order holds (units + parts) whenever the order is **not yet invoiced**, regardless of whether status is `confirmed` or `delivered`. The RPC checks for a non-cancelled linked invoice first and refuses if one exists ("invoice it / credit-note it instead").

**Rationale**: The current `cancel()` only releases on `confirmed` (a state the post-fix approval flow never produces) and hard-blocks `delivered`, which is why approved stock strands. Gating release on "no invoice yet" rather than on a specific status matches the real invariant: stock is recoverable until it has been delivered against a posted invoice.

**Alternatives considered**:
- *Introduce a distinct `approved`/`reserved` status separate from `delivered`* — cleaner semantically, but a status-enum change ripples through the UI status pills, PDF labels, the `v_sales_documents` view, and the existing 14-item checklist. Deferred as a larger refactor; the cancel-gating approach delivers the invariant with far less surface area.
- *Auto-release on a timer* — rejected: surprising, and out of scope.

---

## R3 — Making multi-write transitions atomic — FR-005, FR-006, FR-007

**Decision**: Move each multi-write transition into a single **`SECURITY DEFINER` PL/pgSQL RPC** that performs all writes in one implicit transaction, with `SELECT … FOR UPDATE` on the document row at the top to serialize concurrent callers. The TS API methods become thin wrappers that call the RPC and return its result.

Transitions converted to RPCs:
| Transition | New RPC | Writes folded in |
|---|---|---|
| Quotation → SO | `convert_quotation_to_so` | insert SO + flip `qt.status='converted'` + idempotency guard |
| SO approve | `approve_sales_order` | reserve every line (by type) + set status + stamp timestamps + role check |
| SO reject | `reject_sales_order` | status only + role check |
| SO cancel | `cancel_sales_order` | release every reservation + status + "no invoice" guard |
| Invoice post | `post_invoice` (replaces current) | assign code + status + deliver every line (by type) + role check |
| Invoice void | `void_invoice` | guard (no applied payments/CN) + status + reverse delivery |
| CN issue | `issue_credit_note` (extended) | code + status + apply-to-invoice + bump invoice balance |
| Payment record | `record_payment` (extended) | payment row + applications + bump each invoice balance |

**Rationale**: Postgres gives every function an atomic transaction for free. Doing the writes client-side across multiple `await supabase.*` calls (the current shape) has no transaction boundary, so any mid-sequence failure desyncs state — the audit's H4. `FOR UPDATE` closes the M1 read-then-write race (two approvals can't both pass a `status='draft'` check). Gapless sequence integrity is preserved because `nextval_for_type` is called inside the same transaction and rolls back with it.

**Alternatives considered**:
- *Client-side compensation/rollback logic* — rejected: complex, racy, and still not atomic across a crash.
- *Supabase Edge Function orchestrating multiple statements* — rejected: still multiple statements without a shared transaction unless it opens one; an RPC is the idiomatic atomic unit here and matches the existing `crm_convert_lead` / `post_invoice` precedent.

**Idempotency (FR-006)**: `convert_quotation_to_so` re-reads the quotation `FOR UPDATE` and refuses if `status='converted'` (or if a SO already references it) — the insert + status flip are in one tx, so the flag can never lag the insert.

---

## R4 — Server-side approval governance — FR-011, M5

**Decision**: Each approve/reject RPC begins with `IF NOT public.rma_is_manager_or_above() THEN RAISE EXCEPTION …`. The UI keeps its `canApprove` button gate (defense in depth), but authority now lives in the RPC. This mirrors the existing `crm_convert_lead` internal authz check (the audit's "what's solid").

**Rationale**: Today the transition is a plain RLS `UPDATE` the document owner can perform, so a `sales_rep` could self-approve via the API. Separation of duties for an enterprise funnel must be enforced where the state actually changes.

**Alternatives considered**:
- *RLS column policy that forbids owners from setting `status='accepted'`* — rejected: RLS can't easily express "only this transition, only by this role" without brittle per-value policies; an RPC role check is clearer and testable.

---

## R5 — Safe invoice void — FR-010, M4

**Decision**: `void_invoice` refuses when the invoice has any `payment_applications` or `credit_note_applications` rows (`RAISE EXCEPTION 'reverse payments/credit notes before voiding'`). For a clean posted-but-unpaid invoice, void also reverses the inventory delivery for the order's lines (restore delivered units/parts to available) so stock isn't silently lost.

**Rationale**: Today `void_` only checks `doc_status='posted'`; voiding a paid invoice drops its `+total` from `v_customer_ledger` while payment rows remain, pushing the customer balance negative, and delivered stock is never restored. Refusing the dangerous case (and reversing stock for the safe case) keeps the ledger and inventory honest without building a full refund flow (out of scope).

**Alternatives considered**:
- *Auto-reverse payments on void* — rejected: that's refund logic; out of scope and risky to do implicitly. Refusal forces an explicit reversal first.

---

## R6 — Bulk-edit guards — FR-008, FR-009

**Decision**:
- `deals.bulkMoveStage` (M2): validate the target stage exists in **each** selected deal's pipeline; reject the batch if any deal's pipeline lacks it; when moving into a non-terminal stage, also reset `status='open'`, `won_at=NULL`, `lost_at=NULL`; moving into a won/lost stage sets the matching terminal status. Implemented in the TS method (loops are bounded by selection size) with the validation helper already present (`assertValidStage`).
- `leads.bulkUpdate` (M3): apply the same converted-lead immutability guard `update()` uses, and back it with a DB trigger so the invariant holds even if a future caller forgets (defense in depth).

**Rationale**: Keeps the validation already used on single-record paths consistent across bulk paths. The lead trigger is cheap insurance for a true immutability invariant.

**Alternatives considered**:
- *DB trigger for deal-stage validation too* — possible, but stage validity depends on the pipeline's JSONB `stages` array; a trigger doing JSONB lookups per row is heavier than validating once in the API against the already-loaded pipeline. Keep deal-stage validation in the API; use a trigger only for the simpler lead-immutability boolean.

---

## R7 — Relocating the reset script — FR-004, H3

**Decision**: Move `supabase/migrations/20260731_crm_funnel_test_data_reset.sql` → `scripts/manual/20260731_crm_funnel_test_data_reset.sql`. Add a one-line header note that it is a manual utility, run by hand in the SQL Editor, never via `supabase db push`. Update the memory/checklist references that point at the old path.

**Rationale**: Anything in `supabase/migrations/` runs on a normal migrate; a DELETE-everything script there is a production-wipe waiting to happen.

**Alternatives considered**:
- *Guard it with an `IF current_database() = 'staging'` clause* — rejected: brittle, and the file simply doesn't belong in the migration set at all.

---

## Resolved unknowns summary

| Spec item | Status |
|---|---|
| FR-001/002 line classification | ✅ R1 — derive from catalog at reserve time |
| FR-003 reservation release | ✅ R2 — cancel-gating on "not invoiced" |
| FR-005/006/007 atomicity & idempotency & races | ✅ R3 — `SECURITY DEFINER` RPCs with `FOR UPDATE` |
| FR-011 approval governance | ✅ R4 — role check inside RPC |
| FR-010 safe void | ✅ R5 — refuse if applied; reverse stock if clean |
| FR-008/009 bulk guards | ✅ R6 — API validation + lead trigger |
| FR-004 reset script | ✅ R7 — relocate to `scripts/manual/` |

No remaining `NEEDS CLARIFICATION`.
