# Feature Specification: CRM Upgrade — Phase 1 / Sprint 1 (Foundation)

**Feature Branch**: `002-crm-upgrade`

**Created**: 2026-06-17

**Status**: Draft

**Input**: User description: "CRM upgrade Phase 1 (Sprint 1 foundation): customers/accounts extension, contacts, leads, deals, activities, pipelines, sales_rep role and RLS prerequisite, per CRM_UPGRADE_STUDY.md"

**Source document**: `CRM_UPGRADE_STUDY.md` (fact-checked against the live codebase 2026-06-17 — see its Verification Notes section). This spec covers **Sprint 1 only**: database schema, API domain modules, permissions, and constants. No UI is built in this sprint — `/leads`, `/pipeline`, `/activities` pages and Dashboard/Reports/CustomerDetails widgets are Sprint 2–5 (out of scope here).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - sales_rep role exists and is correctly scoped (Priority: P1)

An admin can assign the `sales_rep` role to a user. That user can authenticate, read the `customers` table (needed to link deals to accounts) and the new CRM tables, but is blocked from RMA-only tables (`rma_tickets`, `inventory`, `parts`) — all enforced at the database level via RLS, not just client-side UI gating.

**Why this priority**: This is the literal prerequisite gate identified during fact-checking. Without it, `chk_user_role` rejects the role outright and `rma_is_staff()` blocks every subsequent CRM read — nothing else in this sprint can be verified until this works.

**Independent Test**: Insert a `user_roles` row with `role = 'sales_rep'` directly via `db.userRoles.createRole()`. Confirm the insert succeeds (constraint allows it). Using that user's session, confirm a `SELECT` against `customers` returns rows, and a `SELECT` against `rma_tickets` returns zero rows (RLS blocks it, doesn't error — matching the existing RLS pattern for excluded sections).

**Acceptance Scenarios**:

1. **Given** the `chk_user_role` constraint has been updated, **When** a row is inserted into `user_roles` with `role = 'sales_rep'`, **Then** the insert succeeds (previously: constraint violation).
2. **Given** `rma_is_staff()` has been updated to include `sales_rep`, **When** a sales_rep-authenticated session queries `customers`, **Then** rows are returned (previously: zero rows due to RLS, regardless of `ROLE_DEFAULT_PERMISSIONS`).
3. **Given** the new scoped `customers` update policy exists, **When** a sales_rep updates a `customers` row where `assigned_rep = rma_current_user_email()`, **Then** the update succeeds; **When** they attempt to update a `customers` row assigned to a different rep, **Then** the update is rejected by RLS.
4. **Given** a sales_rep session, **When** it queries `rma_tickets`, `inventory`, or `parts`, **Then** zero rows are returned (RLS exclusion, not an error).

---

### User Story 2 - CRM domain API modules exist and are RLS-respecting (Priority: P1)

A developer can import `db.leads`, `db.deals`, `db.activities`, `db.pipelines`, `db.contacts` from `src/api/supabaseClient.js` (same barrel pattern as every existing domain module) and perform typed CRUD operations. Every helper follows the project's established conventions: Row types exported from `src/api/db/index.ts`, optional-table guarding via `TableResult<T>` where relevant, and audit-log integration via the existing `db.auditLog`/`auditInsert` write-queue pattern.

**Why this priority**: This is the data layer every future Sprint 2–5 UI page is built on. Per CONSTITUTION.md LAW, page components will never query Supabase directly — they depend entirely on these modules existing and being correct first.

**Independent Test**: Without any UI, call each new module's `list()`/`create()`/`update()` methods directly (e.g. via a test script or the existing Vitest suite) against a seeded test database and confirm correct Row shapes, RLS-appropriate filtering (a rep sees only their own leads/deals unless manager+), and that `db.api/db/index.ts` exports all five new Row types alongside the existing ones.

**Acceptance Scenarios**:

1. **Given** the `leads` table exists, **When** `db.leads.create({...})` is called, **Then** a row is persisted and the returned object matches the `LeadRow` type.
2. **Given** a deal exists in stage "New Lead", **When** `db.deals.moveStage(dealId, 'Quote Sent')` is called, **Then** the stage updates AND the move is validated against the deal's `pipeline_id`'s `stages` array — an invalid stage name is rejected, not silently written.
3. **Given** an activity with `due_date` in the past and `completed_at IS NULL`, **When** `db.activities.listOverdue()` is called, **Then** that activity is included in the result.
4. **Given** a sales_rep session, **When** `db.deals.list()` is called, **Then** only deals where `assigned_rep = rma_current_user_email()` are returned; **given** a manager+ session, **When** the same call is made, **Then** all deals are returned.
5. **Given** `src/api/db/index.ts`, **When** inspected, **Then** it exports `LeadRow`, `DealRow`, `ActivityRow`, `PipelineRow`, `ContactRow` alongside all existing Row type exports, with zero duplication of the `TableResult<T>` pattern already centralized there.

---

### User Story 3 - Lead-to-deal conversion is atomic and correct (Priority: P2)

A developer (via API, no UI yet) can call a conversion function that takes a `leads` row and produces a `deals` row, optionally creating a new `customers` row if the lead isn't already linked to an existing account, and sets `leads.converted_at`/`converted_customer_id`/`converted_deal_id` — all as a single atomic operation, not a multi-step client-side sequence that can partially fail.

**Why this priority**: This is the one cross-table write in Sprint 1 with real partial-failure risk (lead converts but deal creation fails, or vice versa, leaving orphaned/inconsistent state) — exactly the class of bug CONSTITUTION.md's data-integrity rules exist to prevent (see the existing `delete_ticket_cascade` RPC pattern for tickets).

**Why this priority is P2 not P1**: Leads/deals/activities can each be exercised independently without conversion working first (per the Independent Test requirement) — conversion is valuable but not blocking for the other two stories.

**Independent Test**: Call the conversion function against a test lead. Verify exactly one new `deals` row and (if no existing customer match) exactly one new `customers` row are created, and the source `leads` row is updated — all in one transaction. Force a simulated failure partway through and confirm no partial state is left (no orphaned deal without a lead update, etc.).

**Acceptance Scenarios**:

1. **Given** a lead with no matching existing customer, **When** converted, **Then** a new `customers` row, a new `deals` row, and an updated `leads` row (with `converted_at`, `converted_customer_id`, `converted_deal_id` set) all exist after the call.
2. **Given** a lead whose phone/company matches an existing `customers` row, **When** converted, **Then** the new deal links to the *existing* customer — no duplicate account is created.
3. **Given** the conversion is interrupted (e.g. the deal insert fails after the customer insert succeeds), **When** the overall operation is inspected, **Then** either both inserts are rolled back or the operation is implemented as a single Postgres function call (not sequential client-side calls) so partial failure is structurally impossible.

---

### Edge Cases

- What happens when an admin tries to assign `sales_rep` to a user who already has a different role? → Existing `db.userRoles.updateRole()` already clears stale permission overrides on role change (PERM-2 fix) — confirm this still applies correctly for the new role.
- What happens when a sales_rep's `assigned_rep` is null on a `customers` row (legacy data predating this feature)? → The scoped update policy (`assigned_rep = rma_current_user_email()`) correctly denies edit access; this is expected, not a bug — legacy unassigned accounts need a manager to assign a rep first.
- How does the system handle a `deals.moveStage()` call targeting a stage name that doesn't exist in the deal's pipeline's `stages` JSONB array? → Must reject with a clear error, not silently write an invalid stage string (which would break Kanban rendering in Sprint 3).
- How does the system handle JSONB key-order for `deals.product_lines` and `pipelines.stages`? → Per CONSTITUTION.md §7.5a (and the WhatsApp params scramble bug this exact rule was written to prevent), both **must** be stored as arrays, never objects with positional/ordered semantics relying on key order.
- What happens to a `sales_rep`'s existing session permissions if the prerequisite migration (`20260618_crm_add_sales_rep_role.sql`) has not yet been applied but the role was somehow already set? → Out of scope for Sprint 1 — the migration is a hard precondition documented in the study; this scenario should not occur if the merge order in the study's Risk Register is followed.
- What happens when `account_manager` (free-text) and `assigned_rep` (FK) refer to different people for the same account? → Expected and allowed per the Sprint-0 architecture decision (Verification Notes #3) — they are deliberately independent fields, not synchronized.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow the `user_roles.role` column to accept the value `'sales_rep'` (update `chk_user_role` CHECK constraint).
- **FR-002**: System MUST update `public.rma_is_staff()` to return `true` for `sales_rep`, so sales reps can read tables gated by that function (including `customers`).
- **FR-003**: System MUST NOT add `sales_rep` to `public.rma_is_manager_or_above()` — sales_rep is deliberately not manager-tier, to avoid loosening that check's meaning across the rest of the app.
- **FR-004**: System MUST add a new RLS policy scoping `customers` UPDATE to `sales_rep` sessions where `assigned_rep = rma_current_user_email()` — distinct from the existing `manager_update` policy.
- **FR-005**: System MUST create the `contacts` table (customer_id FK, full_name, title, phone, email, is_primary, notes) with RLS: staff read, admin/manager write, anon blocked.
- **FR-006**: System MUST create the `pipelines` table (name, stages JSONB array, is_active) seeded with the two default pipelines (B2B Dealer — 6 stages; B2C Retail — 5 stages) defined in CRM_UPGRADE_STUDY.md §6.2.
- **FR-007**: System MUST create the `leads` table (full_name, company_name, phone, email, source, status, assigned_rep, converted_at, converted_customer_id, converted_deal_id) with RLS: reps see own, manager+ see all.
- **FR-008**: System MUST create the `deals` table (title, customer_id, contact_id, pipeline_id, stage, value, probability, expected_close_date, assigned_rep, product_lines JSONB array, status, lost_reason, won_at, lost_at) with RLS: reps see own, manager+ see all.
- **FR-009**: System MUST create the `activities` table (related_type, related_id, type, title, due_date, completed_at, assigned_rep, outcome_notes) with RLS: reps see own, manager+ see all.
- **FR-010**: System MUST extend `customers` with `lifecycle_stage`, `lead_source`, `assigned_rep`, `last_activity_at` via `ADD COLUMN IF NOT EXISTS` — `account_manager` MUST NOT be modified or merged.
- **FR-011**: System MUST provide a `deals.moveStage()` API function that validates the target stage exists in the deal's pipeline before persisting — invalid stage names MUST be rejected.
- **FR-012**: System MUST provide a lead-to-deal conversion function that is atomic (single transaction or a single `SECURITY DEFINER` Postgres function) — partial failure (e.g. deal created but lead not marked converted) MUST be structurally impossible, not just "unlikely."
- **FR-013**: System MUST store `deals.product_lines` and `pipelines.stages` as JSONB **arrays**, never relying on object key order, per CONSTITUTION.md §7.5a.
- **FR-014**: System MUST export all new Row types (`LeadRow`, `DealRow`, `ActivityRow`, `PipelineRow`, `ContactRow`) from `src/api/db/index.ts`, following the existing aggregation pattern.
- **FR-015**: System MUST add `sales_rep` to `ROLE_DEFAULT_PERMISSIONS` in `src/lib/permissions.ts` with the resource-key matrix defined in CRM_UPGRADE_STUDY.md §7.1 (leads/deals/activities: read+create+edit-own; customers: read+edit-no-delete; rma_tickets/inventory/parts/control_panel: none).
- **FR-016**: System MUST add new constants to `src/lib/constants.ts`: `LEAD_STATUS`, `LEAD_SOURCE`, `DEAL_STATUS`, `ACTIVITY_TYPE` — no magic strings in the new domain modules.
- **FR-017**: System MUST add new Zod schemas to `src/lib/schemas.ts`: `leadSchema`, `dealSchema`, `activitySchema`, `contactSchema`, each with unit tests in the existing `src/test/schemas.test.js` pattern.
- **FR-018**: All new audit-relevant mutations (lead created, deal stage changed, deal won/lost) MUST write through the existing `db.auditLog`/resilient write-queue pattern (`src/api/db/audit.ts`) — no new audit mechanism.
- **FR-019**: Every new migration MUST be idempotent (`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`) per CONSTITUTION.md §7.5, and named `YYYYMMDD_description.sql` starting at `20260618_crm_add_sales_rep_role.sql` (sequenced first) through `20260625_crm_notification_events.sql`.

### Key Entities *(include if feature involves data)*

- **Contact**: A person at a customer/account. Many contacts per customer (`customer_id` FK). One may be flagged `is_primary`.
- **Pipeline**: A named, ordered sequence of deal stages (JSONB array of `{id, name, order, probability_default, is_won, is_lost}`). Two seeded on creation: B2B Dealer, B2C Retail.
- **Lead**: A pre-qualified prospect, not yet a customer/account. Has a source and status. Converts into a Customer (if new) + Deal, recording the linkage on conversion.
- **Deal**: The pipeline record. Belongs to a customer (account), optionally a specific contact, and a pipeline. Has a current stage (must be valid for its pipeline), value, probability, and product line items. Terminal states: won or lost (with reason).
- **Activity**: A logged touchpoint (call/meeting/whatsapp/email/note/task) against a lead, deal, customer, or contact (polymorphic `related_type`/`related_id`). Has a due date and completion state — overdue means `due_date < now()` and `completed_at IS NULL`.
- **Customer (extended)**: The existing RMA customer record, now also serving as the CRM "Account." Gains `lifecycle_stage`, `lead_source`, `assigned_rep`, `last_activity_at` — existing `account_manager` is untouched and deliberately not unified with `assigned_rep`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All 8 new/modified migrations (`20260618` through `20260625`) apply cleanly, in order, to a fresh copy of the production schema, with zero errors, and are safely re-runnable (idempotent) without erroring on a second apply.
- **SC-002**: A `sales_rep` test session can read the `customers` table and zero RMA-only tables (`rma_tickets`, `inventory`, `parts`) — verified via direct RLS testing, not just UI inspection (per the existing permission-preview "view as user" feature, extended to cover this role).
- **SC-003**: `npm test` passes 100% with the new schema/permission/constant unit tests added (current baseline: 173/173 — Sprint 1 should net-add tests, not just maintain the count).
- **SC-004**: `npm run lint:ci` and `npm run build` both pass with zero errors after all Sprint 1 changes (matching the project's existing CI gate).
- **SC-005**: A lead can be created, then converted to a deal, end-to-end via direct API calls (no UI), in under 3 sequential calls (create lead → convert → verify deal exists) with zero orphaned rows on success or failure.
- **SC-006**: Zero existing tests regress — all pre-existing RMA functionality (tickets, customers, products, inventory) is unaffected, confirmed by the full existing test suite plus a manual smoke pass on the 5 page folders listed in CLAUDE.md.

## Assumptions

- Same Supabase project and schema as the existing myRMA database — no second project (per study §9.1 decision, Option A architecture).
- The pipeline stage names proposed in the study (B2B Dealer: 6 stages; B2C Retail: 5 stages) are used as Sprint 1 defaults; QDS sales team confirmation of exact naming is a parallel, non-blocking task — renaming later requires a data migration, so getting this right before Sprint 2's Kanban UI ships is preferred but not a Sprint 1 blocker since Sprint 1 has no UI.
- `account_manager` and `assigned_rep` remain permanently separate columns (resolved during fact-checking — not an open question).
- This sprint produces no UI; all acceptance scenarios are verified via direct API/database calls (Vitest, or manual Supabase SQL/RPC testing), not through page interaction.
- The lead-to-deal conversion function will be implemented as a Postgres function (similar to the existing `rma_search_by_serial` / `delete_ticket_cascade` RPC pattern) rather than a multi-step client-side sequence, to satisfy the atomicity requirement (FR-012).
- `sales_rep` permission defaults are a starting point per the study; the actual matrix should be reviewed with the QDS sales manager before Sprint 1's permission migration is finalized (study §9.1 item 6) — this spec does not block on that review completing, but flags it as a pre-merge checklist item.
