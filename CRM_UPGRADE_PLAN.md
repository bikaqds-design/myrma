# CRM Upgrade — Master Build Plan

**Status**: Sprint 1 (Foundation) code-complete — all 9 migrations, constants, schemas, permissions, and 5 API modules built and passing `test`/`lint`/`build`. Manual QA (live `sales_rep` session, API smoke test, page regression check) still needed before Sprint 1 is fully done — see Step 14. Sprints 2–5 not started. **Branch**: `002-crm-upgrade`. **Scope**: Full Phase 1 — all 5 sprints, transforming myRMA into a CRM-capable system per `CRM_UPGRADE_STUDY.md`.

**This is the single file to follow sprint-by-sprint.** Check items off as you go. Full technical detail (data model, API contracts, validation steps) lives in `specs/002-crm-upgrade/` — link out from here rather than duplicating, except where a build step needs to be self-contained enough to execute without cross-referencing.

**Source documents**: `CRM_UPGRADE_STUDY.md` (fact-checked study, source of truth for the "why"), `specs/002-crm-upgrade/plan.md` + `spec.md` + `research.md` + `data-model.md` + `contracts/api-modules.md` + `quickstart.md` (SpecKit Sprint 1 detail, source of truth for the "how" of Sprint 1 specifically).

**Hard rule for every sprint**: explain planned changes and wait for confirmation before implementing (standing instruction). After every implementation, provide "how to test" steps. Never forget Arabic translation (`ar.json`) alongside every new English string. Never push to `main` — only to `test`, and only when explicitly told.

---

## Pre-Build: Architecture Lock

These decisions are made and must not be revisited mid-build — changing them after migrations are written means an expensive rollback.

- [x] **Sales_rep RLS prerequisite confirmed as a hard gate** — `20260618_crm_add_sales_rep_role.sql` must run before any other CRM migration (see Sprint 1, Step 1)
- [x] **Option A confirmed**: extend the existing `customers` table (don't rename to `accounts`); DB table stays `customers`, UI label may say "Accounts"
- [ ] **Pipeline stage names confirmed with QDS sales team** — defaults proposed below (Sprint 1, Step 3); changing names later requires a data migration, so confirm before Sprint 1 ships, not after
- [x] **Same Supabase project, same schema** — no second project
- [x] **`account_manager` vs `assigned_rep` resolved**: kept as two separate columns — `account_manager` (existing, free-text) is not mergeable with `assigned_rep` (new, FK) without an unscoped data-cleanup migration
- [ ] **Sales_rep permission matrix reviewed with the sales manager** — ships with the default matrix below as Sprint 1's starting point; can be adjusted later (cheap, one-line change in `permissions.ts`), not a hard blocker

---

## Sprint 1 — Foundation (Database + API, no UI)

**Goal**: Database, API modules, permissions, constants. Nothing user-facing yet.

### Step 1 — Prerequisite migration (must run first) ✅ Applied & verified 2026-06-22

**File**: `supabase/migrations/20260618_crm_add_sales_rep_role.sql`

- [x] `ALTER TABLE user_roles DROP CONSTRAINT chk_user_role` + re-add including `'sales_rep'`
- [x] `CREATE OR REPLACE FUNCTION public.rma_is_staff()` — add `'sales_rep'` to the role list
- [x] Do **NOT** add `sales_rep` to `public.rma_is_manager_or_above()` (would over-grant manager-tier write access schema-wide)
- [ ] ~~Add new policy `sales_rep_update_assigned` on `customers` here~~ — **moved to Step 7**: the policy references `customers.assigned_rep`, which doesn't exist until that migration adds the column. Postgres validates policy column references at `CREATE POLICY` time, so defining it here would fail outright.

### Step 2 — Contacts table ✅ Applied & verified 2026-06-22

**File**: `supabase/migrations/20260619_crm_contacts.sql`
- [x] `CREATE TABLE IF NOT EXISTS contacts` (see `specs/002-crm-upgrade/data-model.md` for full columns)
- [x] RLS: staff read, manager+/admin write (sales_rep is read-only on contacts in Sprint 1 — confirmed with user, can be revisited if Sprint 2/3 needs rep-created contacts)

### Step 3 — Pipelines table + seed data ✅ Applied & verified 2026-06-22

**File**: `supabase/migrations/20260620_crm_pipelines.sql`
- [x] `CREATE TABLE IF NOT EXISTS pipelines`
- [x] Seed **B2B Dealer**: New Lead (10%) → Contacted (20%) → Needs Assessment (40%) → Quote Sent (60%) → Negotiation (75%) → Won (100%)/Lost (0%) — 7 stages, names not yet confirmed with QDS sales team (see Architecture Lock)
- [x] Seed **B2C Retail**: New Inquiry (10%) → Contacted (30%) → Quote Sent (60%) → Won (100%)/Lost (0%) — 5 stages
- [x] RLS: staff read, admin write

### Step 4 — Leads table ✅ Applied & verified 2026-06-22

**File**: `supabase/migrations/20260621_crm_leads.sql`
- [x] `CREATE TABLE IF NOT EXISTS leads`, indexes on `assigned_rep`, `status`, `source`, `created_at`
- [x] `chk_lead_source`/`chk_lead_status` CHECK constraints (DB-level enum enforcement, matching `chk_ticket_status` pattern)
- [x] RLS: reps see own (`assigned_rep = auth.uid()`), manager+ see all — composite policy since sales_rep isn't in `rma_is_manager_or_above()`. Unassigned leads are manager+-only (confirmed with user — no self-claim pool in Sprint 1).
- [x] `converted_deal_id` created as plain `uuid` (no FK yet — `deals` doesn't exist until Step 5; FK added there)

### Step 5 — Deals table ✅ Applied & verified 2026-06-22

**File**: `supabase/migrations/20260622_crm_deals.sql`
- [x] `CREATE TABLE IF NOT EXISTS deals`, indexes on `customer_id`, `assigned_rep`, `status`, `expected_close_date`
- [x] `chk_deal_status`/`chk_deal_probability` CHECK constraints
- [x] RLS: reps see own, manager+ see all (same composite pattern as leads)
- [x] Closed the loop from Step 4: added `fk_leads_converted_deal` FK now that `deals` exists

### Step 6 — Activities table ✅ Applied & verified 2026-06-22

**File**: `supabase/migrations/20260623_crm_activities.sql`
- [x] `CREATE TABLE IF NOT EXISTS activities`, indexes on `related_id`, `assigned_rep`, `due_date`, `completed_at`
- [x] `chk_activity_related_type`/`chk_activity_type` CHECK constraints
- [x] RLS: reps see own, manager+ see all (same composite pattern as leads/deals)

### Step 7 — Extend customers table ✅ Applied & verified 2026-06-22

**File**: `supabase/migrations/20260624_crm_customers_extend.sql`
- [x] `ADD COLUMN IF NOT EXISTS lifecycle_stage text DEFAULT 'customer'` + `chk_customer_lifecycle_stage` CHECK constraint
- [x] `ADD COLUMN IF NOT EXISTS lead_source text`
- [x] `ADD COLUMN IF NOT EXISTS assigned_rep uuid REFERENCES auth.users(id)`
- [x] `ADD COLUMN IF NOT EXISTS last_activity_at timestamptz`
- [x] **Do not touch `account_manager`** — stays separate (see Architecture Lock)
- [x] Added policy `sales_rep_update_assigned` on `customers` (moved here from Step 1, deferred until `assigned_rep` existed)
- [x] `last_activity_at` kept correct via a trigger on `activities` INSERT (`crm_update_customer_last_activity()`), not an app-layer update — resolves the customer via `related_type` (direct for `customer`, FK lookup for `contact`/`deal`, `converted_customer_id` for `lead`)

### Step 8 — Notification events ✅ Applied & verified 2026-06-22

**File**: `supabase/migrations/20260625_crm_notification_events.sql`
- [x] Seed `whatsapp_templates` event types: `crm_lead_assigned`, `crm_deal_won`, `crm_followup_due`, `crm_deal_overdue` — all `status = 'pending_approval'` (placeholder bodies, not yet Meta-registered; create + approve in Meta Business Manager before Sprint 4 goes live, then update `template_name`)

### Step 9 — Constants ✅ Applied & verified 2026-06-22

**File**: `src/lib/constants.ts`
- [x] `LEAD_STATUS` (new, contacted, qualified, converted, disqualified)
- [x] `LEAD_SOURCE` (walk-in, phone, referral, exhibition, website, whatsapp)
- [x] `DEAL_STATUS` (open, won, lost)
- [x] `ACTIVITY_TYPE` (call, meeting, whatsapp, email, note, task)
- [x] `LIFECYCLE_STAGE` (lead, prospect, customer, churned) — not in the original list, added because it corresponds to Step 7's `chk_customer_lifecycle_stage` constraint
- [x] ~~`CRM_PIPELINE_IDS`~~ — skipped: pipeline `id`s are generated UUIDs from the seed migration, nothing static to hardcode; code looks them up via `pipelines.list()`/`.get()`
- [x] Added `ROLES.SALES_REP` + `ROLE_LIST` entry — gap in the original plan: Step 11 needs `ROLES.SALES_REP` to exist, and nothing else added it
- [x] 30 new test cases in `src/test/constants.test.js`, full suite: 203/203 passing, lint clean

### Step 10 — Zod schemas ✅ Applied & verified 2026-06-22

**File**: `src/lib/schemas.ts`
- [x] `contactSchema`, `leadSchema`, `dealSchema`, `activitySchema`
- [x] `dealSchema` uses `.superRefine()` to require `lost_reason` when `status === 'lost'` (matches `customerSchema`'s B2B `company_name` pattern)
- [x] `leadSchema` deliberately does NOT hard-reject missing phone+email — data-model.md specifies that as a soft UI warning, not a blocked submit
- [x] Stage-membership validation (is this stage id valid for this deal's pipeline?) is NOT in the schema — requires a DB lookup, lives in `deals.create()`/`moveStage()` at the API layer instead (Step 12)
- [x] 43 new test cases in `src/test/schemas.test.js`, full suite: 246/246 passing, lint clean

### Step 11 — Permissions ✅ Applied & verified 2026-06-22

**File**: `src/lib/permissions.ts`
- [x] Add `sales_rep` to `ROLE_DEFAULT_PERMISSIONS`: `leads`/`deals`/`activities` (view/create/edit, no delete — RLS already scopes to "own" rows), `contacts`/`pipelines` (view only — RLS write is manager+/admin only), `customers` (view + edit, no create/delete — matches `sales_rep_update_assigned` RLS policy), `invoices` (view only — **not** create, see below)
- [x] **Deviated from the study's matrix on one point**: study said sales_rep gets `invoices: read (own), create`, but `invoices` RLS (existing, untouched by this migration set) restricts INSERT to `manager_or_above()`. Shipping `invoices.create: false` so the UI never offers an action that fails at the RLS layer — flagged as a backlog item if sales_rep invoice creation is wanted later (needs its own RLS migration)
- [x] Also added full CRM sections to `MANAGER`'s existing defaults (gap in the original plan — without this, `canDo('manager', ..., 'leads', 'view')` would return `false` despite manager's RLS already granting full access, same UI/RLS-mismatch bug class fixed in `PartsInventory.jsx`/`Invoices.jsx` earlier this project). `pipelines` is view-only even for manager (admin-only write at the RLS layer). `TECHNICIAN`/`VIEWER` get no CRM sections — zero RLS access either way.
- [x] 26 new test cases in `src/test/permissions.test.js`, full suite: 272/272 passing, lint clean

### Step 12 — API domain modules

- [x] **Prerequisite, not in the original plan**: `supabase/migrations/20260626_crm_leads_convert_rpc.sql` — `crm_convert_lead()` SECURITY DEFINER function backing `leads.convert()`. Unlike the existing `delete_customer_cascade` precedent (granted to `anon, authenticated` with no internal auth check), this function replicates the `leads_update` RLS authorization logic inside the function body and is granted to `authenticated` only — applied & verified 2026-06-22.

Build in this order (each builds on the prior ones already existing):
1. [x] `src/api/db/contacts.ts` — `ContactRow`, `contacts.list/create/update/delete` (single-primary-contact invariant enforced via a shared `clearExistingPrimary()` helper)
2. [x] `src/api/db/pipelines.ts` — `PipelineRow`, `PipelineStage`, `pipelines.list/get/update` (`update()` validates exactly-one-`is_won`/exactly-one-`is_lost`/unique-stage-ids before persisting)
3. [x] `src/api/db/deals.ts` — `DealRow`, `DealProductLine`, `deals.list/get/create/update/moveStage/markWon/markLost`
4. [x] `src/api/db/activities.ts` — `ActivityRow`, `activities.list/create/complete/listOverdue` (`create()` verifies the polymorphic `related_id` actually exists before insert)
5. [x] `src/api/db/leads.ts` — `LeadRow`, `leads.list/get/create/update/convert` (`update()` rejects any field but `notes` once `converted_at` is set; `convert()` calls the `crm_convert_lead` RPC)

Exact signatures: `specs/002-crm-upgrade/contracts/api-modules.md`. Full field/state-transition detail: `specs/002-crm-upgrade/data-model.md`.

**Non-negotiable implementation rules**:
- [x] `leads.convert()` MUST be a single `SECURITY DEFINER` Postgres function via `supabase.rpc()` — never a client-side sequence of inserts (partial failure must be structurally impossible)
- [x] `deals.moveStage()` MUST validate the target stage exists in the pipeline's `stages` array before writing — throw on invalid, never write silently. **Extended beyond the plan**: the same validation also runs in `deals.create()` and in `deals.update()` whenever it carries a `stage` field — not just `moveStage()` — since research.md's whole concern was a stale client writing a ghost stage through *any* path, not just one named method.
- [x] `deals.product_lines` and `pipelines.stages` MUST be JSONB **arrays**, never objects (Postgres JSONB does not preserve object key order — this exact bug already happened once with WhatsApp template params)

### Step 13 — Wire into the barrel export ✅ Applied & verified 2026-06-22

**File**: `src/api/db/index.ts`
- [x] Export `contacts`, `pipelines`, `leads`, `deals`, `activities` and their Row types
- [x] `npm test` 272/272, `npm run lint:ci` clean, `npm run build` succeeded (bundle +6KB, as expected for 5 new modules) — this is the step that actually exercises the 5 new files through Vite's compiler, since nothing imported them before this

### Step 14 — Validate Sprint 1

- [x] All 9 migrations apply cleanly (8 from the original plan + the `crm_convert_lead` RPC migration, applied & verified as each was written)
- [x] `npm test` (272/272), `npm run lint:ci` (clean), `npm run build` (succeeds) — re-run together as a final pass, 2026-06-22
- [ ] **Needs a live session — not done yet**: `sales_rep` test session reads `customers`/CRM tables, blocked from `rma_tickets`/`inventory`/`parts`
- [ ] **Needs a live session — not done yet**: each API module exercised directly (create lead, list pipelines, create deal, invalid `moveStage()` throws)
- [ ] **Needs a live session — not done yet**: `leads.convert()` exercised end-to-end — exactly one customer + one deal created, lead becomes immutable
- [ ] **Needs manual click-through — not done yet**: smoke test `RMATickets`, `Customers`, `Products`, `Inventory`, `UserManagement` for regressions

---

## Sprint 2 — Leads Page (Week 3)

**Goal**: Sales reps can capture and track leads.

- [ ] Build `src/pages/Leads/index.jsx` — list view, status columns, source filters, overdue badge
- [ ] Modal: Create Lead (name, company, phone, source, notes, assign rep)
- [ ] Action: Convert Lead to Deal — opens convert modal, calls `leads.convert()`, optionally creates new customer account
- [ ] Bulk CSV import of leads — extend the existing `parseCSVLine` pattern (Products/Customers), do not write a second CSV parser
- [ ] Add route `/leads` to `App.jsx` with `sales_rep+` auth guard, lazy-loaded via `lazyWithReload()`
- [ ] Add "Leads" to sidebar navigation, gated by `canDo`
- [ ] All strings in `en.json` + `ar.json` (same commit)
- [ ] Dark mode: Direction B tokens only, no `dark:bg-slate-*`/`dark:bg-gray-*`
- [ ] Test: create a lead, convert it, confirm the deal appears in the deals table

---

## Sprint 3 — Pipeline Kanban (Week 4–5)

**Goal**: The main CRM interface — highest-value, most-used screen.

- [ ] Build `src/pages/Pipeline/index.jsx` — pipeline tabs (B2B/B2C), Kanban columns by stage, deal cards
- [ ] Deal cards show: title, customer name, value (EGP), assigned rep avatar, next activity due date, overdue badge
- [ ] Drag-and-drop between stages via `@hello-pangea/dnd` (already installed — no new dependency)
- [ ] On drop: call `deals.moveStage()` → validated server-side → persist → `queryClient.invalidateQueries`
- [ ] Deal create drawer/modal: title, customer, pipeline, stage, value, close date, rep
- [ ] Build `src/pages/Pipeline/DealDetail.jsx` (route `/pipeline/:id`): full record, product lines, notes, activity timeline
- [ ] "Won"/"Lost" actions — `lost_reason` required on Lost
- [ ] Add routes `/pipeline`, `/pipeline/:id` to `App.jsx`; add "Pipeline" to sidebar
- [ ] All strings in `en.json` + `ar.json`
- [ ] Mobile/PWA check: test drag performance on touch; if poor, fall back to a tap-to-move-stage dropdown (see Risk Register)

---

## Sprint 4 — Activities & Follow-Ups (Week 6)

**Goal**: Reps never miss a follow-up.

- [ ] Build `src/pages/Activities/index.jsx` — "Today", "Overdue", "All" tabs
- [ ] Activity quick-log panel on deal detail and lead detail pages
- [ ] Overdue follow-ups count badge in sidebar next to "Activities"
- [ ] Dashboard widget: "Overdue Follow-Ups" count card (red badge, links to Activities page)
- [ ] `src/lib/events/crmEventHandlers.ts` — register via `registerCrmEventHandlers()` called alongside `registerTicketEventHandlers()` in `App.jsx`
- [ ] WhatsApp template `crm_followup_due` — morning digest of today's activities via `notification-worker`; toggleable per-type in `WASettings.jsx` (same pattern as ticket notifications)
- [ ] All strings in `en.json` + `ar.json`

---

## Sprint 5 — Dashboard & Polish (Week 7)

**Goal**: Management visibility. System usable end-to-end.

- [ ] `Dashboard.jsx`: sales KPI section — total open pipeline value, deals won this month, leads created this month, overdue follow-ups
- [ ] `Dashboard.jsx`: "Pipeline by Stage" bar chart (Recharts)
- [ ] `Dashboard.jsx`: Rep Leaderboard card (top 5 reps by deals won this month)
- [ ] `CustomerDetails.jsx`: add Contacts tab (list/add/edit/delete contacts)
- [ ] `CustomerDetails.jsx`: add Deals tab (open/won deals for this account)
- [ ] `Reports.jsx`: CRM section — deals by stage, win/loss rate, leads by source, rep performance table
- [ ] `ControlPanel.jsx`: Pipeline Config sub-page (admin can edit pipeline stage names)
- [ ] QA: full end-to-end test with a `sales_rep` account and a manager account
- [ ] `npm test`, `npm run lint`, `npm run build` all pass
- [ ] Deploy to staging; get feedback from QDS team before production push

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `customers` vs "accounts" naming confuses the team | High | Medium | Rename to "Accounts" in all UI labels from Sprint 2 Day 1. DB table stays `customers`. |
| RLS policies for new CRM tables incomplete | Medium | High | Every new table gets RLS policies in its own migration file. Test with a `sales_rep` session, not admin, before deploying. |
| `sales_rep` role doesn't work without the prerequisite | Certain without Step 1 | Critical | `20260618_crm_add_sales_rep_role.sql` must run first — see Sprint 1 Step 1. |
| `sales_rep` accidentally sees RMA internals | Medium | Medium | Use the permission-preview "view as user" feature to simulate a `sales_rep` session before each deploy. |
| Pipeline stage names locked in data, hard to rename later | Low | High | Confirm names with QDS sales manager before Sprint 1 ships (see Architecture Lock checklist). |
| Scope creep — Phase 2 features built before Phase 1 validated | High | Medium | Hard gate: no Phase 2 work starts until Phase 1 has been in use 4+ weeks with positive rep feedback. |
| `@hello-pangea/dnd` drag performance on mobile PWA | Medium | Low | Test during Sprint 3; fall back to tap-to-move-stage dropdown if needed. |
| Duplicate customer problem (CRM contact = RMA customer) | Medium | High | Phase 2: fuzzy phone-match duplicate detection. Until then: always search existing customers before creating a new lead/account. |
| JSONB key-order issue in `product_lines`/`stages` | Low | High | Always arrays, never objects — see Sprint 1 Step 12 non-negotiable rules. |
| WhatsApp notification volume spikes | Medium | Low | Each CRM notification type individually toggleable in `WASettings.jsx`, same as existing ticket notifications. |

---

## Complete File Checklist (all 5 sprints)

### New files

| File | Sprint |
|---|---|
| `supabase/migrations/20260618_crm_add_sales_rep_role.sql` | 1 |
| `supabase/migrations/20260619_crm_contacts.sql` | 1 |
| `supabase/migrations/20260620_crm_pipelines.sql` | 1 |
| `supabase/migrations/20260621_crm_leads.sql` | 1 |
| `supabase/migrations/20260622_crm_deals.sql` | 1 |
| `supabase/migrations/20260623_crm_activities.sql` | 1 |
| `supabase/migrations/20260624_crm_customers_extend.sql` | 1 |
| `supabase/migrations/20260625_crm_notification_events.sql` | 1 |
| `src/api/db/leads.ts`, `deals.ts`, `activities.ts`, `pipelines.ts`, `contacts.ts` | 1 |
| `src/pages/Leads/index.jsx` | 2 |
| `src/pages/Pipeline/index.jsx`, `Pipeline/DealDetail.jsx` | 3 |
| `src/pages/Activities/index.jsx` | 4 |
| `src/lib/events/crmEventHandlers.ts` | 4 |

### Modified files

| File | Change | Sprint |
|---|---|---|
| `src/api/db/index.ts` | Export new Row types + modules | 1 |
| `src/lib/constants.ts` | `LEAD_STATUS`, `LEAD_SOURCE`, `DEAL_STATUS`, `ACTIVITY_TYPE`, `CRM_PIPELINE_IDS` | 1 |
| `src/lib/schemas.ts` | New Zod schemas | 1 |
| `src/lib/permissions.ts` | `sales_rep` in `ROLE_DEFAULT_PERMISSIONS` | 1 |
| `src/App.jsx` | Routes `/leads`, `/pipeline`, `/pipeline/:id`, `/activities` | 2–4 |
| `src/lib/events/ticketEventHandlers.ts` | Call `registerCrmEventHandlers()` | 4 |
| `src/pages/Dashboard.jsx` | Sales KPI widgets, pipeline chart, leaderboard | 4–5 |
| `src/pages/CustomerDetails.jsx` | Contacts tab, Deals tab | 5 |
| `src/pages/Reports.jsx` | CRM reports section | 5 |
| `src/pages/ControlPanel.jsx` | Pipeline Config sub-page | 5 |
| `src/locales/en.json`, `ar.json` | Every new string, every sprint, same commit | 2–5 |
| `CLAUDE.md` | Document customers-as-accounts decision, new routes, modules, role | 1, ongoing |
| `docs/archive/AUDIT_LOG.md` | CRM upgrade changelog entries | ongoing |

---

## Definition of Done — Phase 1 Complete

Phase 1 (all 5 sprints) is done when every item below is true:

1. [ ] All 8 migrations applied to production. No ad-hoc SQL outside migration files.
2. [ ] All new constants in `constants.ts` — zero magic strings in new code.
3. [ ] All new schemas in `schemas.ts` with unit tests; `npm test` passes with 0 failures.
4. [ ] All new API modules in `src/api/db/`, Row types exported from `index.ts`.
5. [ ] `sales_rep` role in `user_roles` + `ROLE_DEFAULT_PERMISSIONS`; permission preview confirms reps cannot see RMA technician sections.
6. [ ] `/leads`: a rep can create a lead, edit it, convert it to a deal.
7. [ ] `/pipeline`: a deal appears in the correct stage column; drag-drop between columns persists.
8. [ ] A deal can be marked Won and Lost (with required `lost_reason`); Won/Lost excluded from the active Kanban by default.
9. [ ] Activities can be logged against a deal; overdue activities show a badge on the Kanban card.
10. [ ] Dashboard shows: total open deal value, deals won this month, overdue follow-ups count.
11. [ ] `CustomerDetails.jsx` shows Contacts tab and Deals tab.
12. [ ] All UI strings translated in `en.json` and `ar.json` — no hardcoded English in new components.
13. [ ] Dark mode correct on all new pages (Direction B tokens).
14. [ ] `npm test`, `npm run lint`, `npm run build` all pass with zero errors.
15. [ ] At least one QDS sales rep and one manager have run one full sales cycle (lead → deal → won/lost) and confirmed it matches their real process.

---

## How to keep using this file

- Check items off as each step is built and verified — this file is the persistent state of the build across sessions.
- Do not start a sprint's items until the previous sprint's checklist is fully checked (Sprint 1 must be 100% done — including `npm test`/`lint`/`build` green — before Sprint 2 UI work begins).
- If a step's detail is unclear, check `specs/002-crm-upgrade/` first (data-model.md for schema, contracts/api-modules.md for exact signatures, quickstart.md for validation steps) before re-deriving it from `CRM_UPGRADE_STUDY.md`.
- If a decision in the Architecture Lock section needs to change, update it here AND in `CLAUDE.md`, and re-check whether any already-checked-off step is invalidated.
