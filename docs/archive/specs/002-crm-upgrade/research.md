# Phase 0 Research: CRM Upgrade — Sprint 1 Foundation

No items in the spec's Technical Context were marked `NEEDS CLARIFICATION` — the verified `CRM_UPGRADE_STUDY.md` and the existing myRMA architecture already answer every structural question for this sprint. This document records the technical decisions made and why, plus the alternatives considered for the genuinely non-obvious ones.

## 1. Lead-to-deal conversion: atomicity strategy

**Decision**: Implement `leads.convert()` as a single Postgres function (`SECURITY DEFINER`, called via `supabase.rpc()`), not a sequence of client-side `insert`/`update` calls.

**Rationale**: FR-012 requires the conversion to be structurally atomic — a customer row, a deal row, and a lead-status update must all succeed or all fail together. A client-side sequence (`await db.customers.create(...)`, `await db.deals.create(...)`, `await db.leads.update(...)`) has a real partial-failure window: if the network drops between calls, or the second insert fails validation, the first insert's effect is already committed and orphaned. This is the exact failure class CONSTITUTION.md's existing `delete_ticket_cascade` RPC function was built to prevent for ticket deletion — same pattern, same justification, applied to a write instead of a delete.

**Alternatives considered**:
- *Client-side sequence with manual rollback on error*: rejected — manual rollback (e.g. deleting the customer row if the deal insert fails) is itself not atomic (the rollback call can also fail), and adds significant complexity for a problem Postgres transactions solve natively.
- *Supabase Edge Function wrapping a transaction*: rejected for Sprint 1 — adds a new Edge Function (network hop, cold start, deploy step) for a single multi-row insert that a `SECURITY DEFINER` SQL function handles directly inside the database with less latency and less new surface area. Edge Functions in this codebase are reserved for cases needing the service-role key or external API calls (WhatsApp, email) — this conversion needs neither.

## 2. `sales_rep` and the RLS helper functions

**Decision**: Add `sales_rep` to `rma_is_staff()` only. Do not add it to `rma_is_manager_or_above()`. Add a new, narrowly-scoped RLS policy (`sales_rep_update_assigned`) for the one case (customers UPDATE) where sales_rep needs write access that `rma_is_staff()` (read-only intent) doesn't cover and `rma_is_manager_or_above()` (broader than needed) shouldn't be loosened for.

**Rationale**: `rma_is_manager_or_above()` is consumed by RLS policies across the *entire* existing schema, not just `customers` — adding sales_rep to it would silently grant sales_rep manager-tier write access to every table using that check (`rma_tickets`, `inventory`, etc.), directly contradicting the explicit requirement that sales_rep NOT see RMA internals. A scoped, single-purpose policy is the correct-grained tool here, matching the principle of least privilege the existing RLS policies already follow (e.g. `staff_read` vs `manager_insert` vs `admin_delete` are already three separate, separately-scoped policies per table, not one broad policy).

**Alternatives considered**:
- *New `rma_is_sales_rep_or_above()` helper function*: considered for symmetry with the existing naming convention, but rejected as unnecessary — there's exactly one policy that needs this distinction (customers update), not a pattern repeated across many tables yet. If Sprint 2+ reveals more sales_rep-scoped write needs, this helper can be introduced then without needing to revisit Sprint 1's migration.

## 3. JSONB array discipline for `product_lines` and `stages`

**Decision**: Both `deals.product_lines` and `pipelines.stages` are stored and consumed exclusively as arrays — API methods that read them always return/accept arrays, never spread them into keyed objects at any point in the read/write path.

**Rationale**: CONSTITUTION.md §7.5a documents the exact bug class this prevents (the WhatsApp template params scramble, where `Object.values()` on a JSONB-round-tripped object silently reordered positional data). `deals.product_lines` (an ordered list of line items) and `pipelines.stages` (an ordered sequence defining Kanban column order) are both order-sensitive by definition — this is not a hypothetical risk, it's the same shape of bug that has already happened once in this codebase.

**Alternatives considered**: None seriously — this is a hard constitutional rule (LAW-level), not a judgment call.

## 4. Stage validation on `deals.moveStage()`

**Decision**: `moveStage()` validates the target stage name exists in `pipelines.stages` (looked up via the deal's `pipeline_id`) before writing. Invalid stage names throw, not silently persist.

**Rationale**: FR-011 requires this. Without it, a typo or a stale client (caching an old pipeline configuration before an admin renames a stage) could write a "ghost" stage value that never appears as a Kanban column in Sprint 3's UI — the deal becomes invisible on the board, a silent data-integrity bug that's hard to diagnose after the fact. Validating at write time (in the API module, server-adjacent) catches this before it reaches the database, consistent with the project's existing Zod-at-the-boundary validation philosophy (CONSTITUTION.md §8.4).

**Alternatives considered**:
- *Database-level CHECK constraint or trigger*: considered, but `stages` is a per-pipeline JSONB array (not a fixed enum), so a static CHECK constraint can't express "valid for this row's pipeline_id." A trigger could, but adds migration complexity for a check the TypeScript layer can already perform cheaply (one extra read already happens to resolve the pipeline anyway). Revisit if a non-TypeScript client ever writes to this table directly (none planned).

## 5. Permission defaults: sales_rep matrix source of truth

**Decision**: Ship the `sales_rep` permission matrix exactly as specified in CRM_UPGRADE_STUDY.md §7.1 (leads/deals/activities: read+create+edit-own; customers: read+edit-no-delete; everything RMA-internal: none) as the Sprint 1 default, flagged in the spec's Assumptions as needing QDS sales-manager sign-off before the migration is considered final — but not blocking Sprint 1 development from proceeding.

**Rationale**: The study's matrix is well-reasoned and directly modeled on the existing `manager`/`technician`/`viewer` default-permission pattern already in `ROLE_DEFAULT_PERMISSIONS` — there's a concrete, testable starting point, and permission *values* are a one-line change in `permissions.ts` if QDS feedback requires adjustment (unlike the RLS function/constraint changes, which are structural). Blocking the entire sprint on a stakeholder meeting for a value that's cheap to change later would be the kind of unnecessary gate CONSTITUTION.md's pragmatism principles argue against.

**Alternatives considered**: Block Sprint 1 start until sign-off — rejected as overly conservative for a low-cost-to-change parameter; noted as a pre-production-deploy checklist item instead (see spec.md Assumptions).
