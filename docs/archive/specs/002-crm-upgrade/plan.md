# Implementation Plan: CRM Upgrade — Phase 1 / Sprint 1 (Foundation)

**Branch**: `002-crm-upgrade` | **Date**: 2026-06-17 | **Spec**: `specs/002-crm-upgrade/spec.md`

**Input**: Feature specification from `specs/002-crm-upgrade/spec.md`

## Summary

Build the database and API foundation for myRMA's CRM upgrade — no UI in this sprint. Primary requirement: a new `sales_rep` role that works correctly at the RLS layer (the fact-checked prerequisite gate), five new domain tables (contacts, pipelines, leads, deals, activities) with RLS-respecting TypeScript API modules following the existing `src/api/db/` pattern exactly, an atomic lead→deal conversion path, and an extended `customers` table serving as the CRM "Account." Technical approach: extend the existing single-codebase architecture (Option A per CRM_UPGRADE_STUDY.md §6.1) — reuse the existing migration conventions, `TableResult<T>` pattern, `canDo()`/`ROLE_DEFAULT_PERMISSIONS` permission system, and `db.auditLog` write-queue, rather than introducing any new architectural pattern.

## Technical Context

**Language/Version**: TypeScript (strict mode) for all new `src/api/db/` and `src/lib/` files — JavaScript (.jsx) is for UI only, and this sprint has no UI.

**Primary Dependencies**: `@supabase/supabase-js` (existing), `zod` (existing, for new schemas), `@tanstack/react-query` (existing — N/A this sprint, no UI consumes these modules yet, but modules must be query-key-compatible for Sprint 2+). No new dependencies — the stack is locked per the SpecKit constitution's "Architecture & Stack Constraints."

**Storage**: Supabase (PostgreSQL) — same project, same schema as existing myRMA tables. No second database, no second Supabase project.

**Testing**: Vitest, following the existing `src/test/*.test.js` convention. New Zod schemas get tests in `schemas.test.js` (extending the existing file, not a new one, matching how `ticketSchema`/`customerSchema` are already tested together). RLS/permission behavior is verified via the existing `canDo()`/`resolvePermissions()` test patterns in `permissions.test.js`, extended with `sales_rep` cases.

**Target Platform**: Same as existing myRMA — Vite-built PWA, Supabase backend. This sprint ships zero frontend changes; "target platform" is the Supabase database + the `src/api/db/` TypeScript layer only.

**Project Type**: Single project (existing web application — Option 1, no new project structure needed).

**Performance Goals**: No new performance targets this sprint (no UI to measure). Database-level: new indexes specified in the data model must keep `leads`/`deals`/`activities` list queries performant at the scale already established by `rma_tickets` (5,000-row client cap precedent) — CRM tables are expected to be smaller than RMA ticket volume at QDS's scale (35 people), so no special pagination strategy is needed in Sprint 1.

**Constraints**: Zero downtime — all migrations must be additive (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`) and idempotent. Zero regression to existing RMA functionality — the `customers` table extension and the `rma_is_staff()`/`rma_is_manager_or_above()` function changes touch shared, heavily-used infrastructure and must be additive-only (broadening role lists, never narrowing existing role behavior).

**Scale/Scope**: 35-person QDS team; CRM data volume expected to be a fraction of existing RMA ticket volume. 5 new tables, 1 extended table, 5 new API domain modules, 1 new role, 8 new migrations (per the fact-checked sequencing in CRM_UPGRADE_STUDY.md).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Shared UI Library & Design Tokens | N/A this sprint — no UI is built. Re-evaluate at the start of Sprint 2 (Leads page). | ✅ N/A |
| II. API Layer Encapsulation | All 5 new domain modules (`leads.ts`, `deals.ts`, `activities.ts`, `pipelines.ts`, `contacts.ts`) live in `src/api/db/`, exported from `index.ts`, consumed only via `db.*` — no direct `supabase` import anywhere in new code. JSONB ordering rule (FR-013) applies directly to `deals.product_lines` and `pipelines.stages`. | ✅ PASS (designed for) |
| III. Security & RLS by Default | This is the spine of the whole sprint — see User Story 1. Every new table gets explicit RLS policies in its own migration. `sales_rep` is added to `ROLE_DEFAULT_PERMISSIONS` via `resolvePermissions()`, never via raw `stored \|\| defaults`. Service role key handling is unaffected (no new Edge Functions in this sprint). | ✅ PASS (designed for) |
| IV. TanStack Query as the Data Layer | N/A for the API modules themselves (TanStack Query is a UI-layer concern) — but module method signatures (e.g. `leads.list()` returning a plain array, not a subscription) are designed to be directly droppable into a Sprint 2 `useQuery(['leads'], () => db.leads.list())` call without redesign. | ✅ PASS (designed for forward-compat) |
| V. No Magic Strings + TypeScript Discipline | `LEAD_STATUS`, `LEAD_SOURCE`, `DEAL_STATUS`, `ACTIVITY_TYPE` added to `constants.ts` (FR-016); all new `src/api/db/` and `src/lib/` files are `.ts`; Row types re-exported from `index.ts` (FR-014). | ✅ PASS (designed for) |

**No violations requiring justification.** Complexity Tracking section is empty — this sprint follows every existing architectural pattern rather than introducing a new one.

## Project Structure

### Documentation (this feature)

```text
specs/002-crm-upgrade/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md         # Phase 1 output
├── contracts/             # Phase 1 output — API module method signatures
└── tasks.md              # Phase 2 output (/speckit-tasks — not created by this command)
```

### Source Code (repository root)

This is the existing single-project myRMA web application — no new top-level structure. Sprint 1 touches only the database and API layers:

```text
supabase/
└── migrations/
    ├── 20260618_crm_add_sales_rep_role.sql   # NEW — prerequisite, sequenced first
    ├── 20260619_crm_contacts.sql              # NEW
    ├── 20260620_crm_pipelines.sql             # NEW
    ├── 20260621_crm_leads.sql                 # NEW
    ├── 20260622_crm_deals.sql                 # NEW
    ├── 20260623_crm_activities.sql            # NEW
    ├── 20260624_crm_customers_extend.sql      # NEW
    └── 20260625_crm_notification_events.sql   # NEW

src/
├── api/
│   └── db/
│       ├── leads.ts          # NEW — LeadRow, leads.list/get/create/update/convert
│       ├── deals.ts          # NEW — DealRow, deals.list/get/create/update/moveStage/markWon/markLost
│       ├── activities.ts     # NEW — ActivityRow, activities.list/create/complete/listOverdue
│       ├── pipelines.ts      # NEW — PipelineRow, pipelines.list/get/update
│       ├── contacts.ts       # NEW — ContactRow, contacts.list/create/update/delete
│       └── index.ts          # MODIFIED — export new modules + Row types
├── lib/
│   ├── constants.ts           # MODIFIED — LEAD_STATUS, LEAD_SOURCE, DEAL_STATUS, ACTIVITY_TYPE
│   ├── permissions.ts         # MODIFIED — sales_rep added to ROLE_DEFAULT_PERMISSIONS
│   └── schemas.ts             # MODIFIED — leadSchema, dealSchema, activitySchema, contactSchema
└── test/
    ├── schemas.test.js        # MODIFIED — test.each cases for the 4 new schemas
    └── permissions.test.js    # MODIFIED — sales_rep canDo()/resolvePermissions() cases
```

**Structure Decision**: Single project, existing layout. No `src/pages/` changes in this sprint (UI is Sprint 2+). This sprint is purely additive to `supabase/migrations/`, `src/api/db/`, and `src/lib/` — the three layers CONSTITUTION.md's "Data Access Architecture" section defines as sitting below the page-component layer.

## Complexity Tracking

*No entries — Constitution Check passed with no violations requiring justification.*

## Constitution Check — Post-Design Re-evaluation

*Re-checked after Phase 1 (data-model.md, contracts/, quickstart.md) — per the gate requirement.*

- **II. API Layer Encapsulation**: Confirmed by `contracts/api-modules.md` — every method signature returns/accepts plain typed objects via the `db.*` barrel; zero direct `supabase` references in any contract. The JSONB-array rule (`product_lines`, `stages`) is explicit in both the data model and the contracts. **Still ✅ PASS.**
- **III. Security & RLS by Default**: Data model confirms every new table has explicit RLS-relevant fields (`assigned_rep` for row-scoping) and the contracts document the `convert()` function as a `SECURITY DEFINER` RPC, not a client-side multi-step write — directly satisfying the atomicity + RLS-bypass-only-where-justified principle. **Still ✅ PASS.**
- **V. No Magic Strings + TypeScript Discipline**: All 5 contract files use named TypeScript interfaces, no inline object-shape types; status/type fields are typed as the constants (`LEAD_STATUS`, `DEAL_STATUS`, etc.) rather than bare `string` where a finite enum exists (`DealRow.status` uses a union type, not `string`). **Still ✅ PASS.**

No new violations surfaced during design. Constitution Check remains clean — ready for `/speckit-tasks`.
