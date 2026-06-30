# myRMA → QDS CRM — Master Build Plan

**Branch**: `002-crm-upgrade` | **Last updated**: 2026-07-XX | **Supersedes**: `CRM_UPGRADE_PLAN.md`, `SYSTEM_UPGRADE_PLAN.md` (both archived to `docs/archive/`)

**This is the single file to follow going forward.** Check items off as you go — this file is the persistent build state across sessions.

---

## System Pivot — CRM First

**As of this update, the system is no longer an "RMA system with CRM features." It is now a full CRM platform where the RMA Tickets module is one component (the Service module) among several.**

The product is now: **QDS CRM** — a purpose-built CRM for QDS covering the full customer lifecycle:
- **Sales**: Leads → Deals → Quotations → Sales Orders → Invoices
- **Service**: RMA Tickets (existing module, kept intact, becomes the "Service" module)
- **Accounting**: Customer payments, balances, financial statements (Sprint 7)
- **Inventory**: Products stock, RMA units, sub-warehouses, auto-adjustment (Sprint 8)
- **CRM Core**: Contacts, Activities, Pipeline, Reports (Sprints 1–5, largely complete)

**What does NOT change:**
- All existing code conventions, design tokens, i18n law, Constitution (`CONSTITUTION.md`)
- The RMA Tickets module — kept, unchanged, renamed "Service" in UI labels only
- All CRM data built in Sprints 1–5 (leads, deals, pipelines, activities, contacts)

**What changes from here:**
- New modules (Sales Documents, Accounting, Inventory redesign) are the primary build priority
- Track B "nice to have" system upgrades are deprioritised below new modules
- Core `CLAUDE.md` and `DESIGN.md` will be updated progressively as modules ship

---

## Summary

This plan tracks the full build of QDS CRM across three areas:

- **Track A — CRM Core** *(Sprints 1–5, largely done)*: leads, deals, pipeline, activities, contacts, sales_rep role, dashboard widgets, customer tabs. Formal SpecKit artifacts in `specs/002-crm-upgrade/`.
- **Track A — Sales Documents** *(Sprint 6, ✅ COMPLETE 2026-06-30)*: the complete sales funnel — Quotations (linked from deal product lines or standalone), Sales Orders, Invoices, Credit Notes — at `/sales` (route name differs from the original `/invoices` plan, kept distinct from the legacy `Invoices.jsx` RMA-service-invoice page).
- **Track A — Accounting v1** *(Sprint 7, ✅ COMPLETE 2026-06-30)*: customer payment ledger, AR aging, customer statement, soft credit limits — at `/accounting`. Deliberately not a full GL/ERP; see Sprint 7 section for exact scope and what was deferred.
- **Track A — Inventory Redesign** *(Sprint 8, future)*: new inventory page replacing the current one; auto-adjusts from sales orders, invoices, credit notes.
- **Track B — System Upgrades**: bug fixes and quality improvements to existing modules (RMA Tickets, Products, Parts, SLA, Webhooks). Deprioritised below Track A new modules; tackled between sprints.

All tracks share `CONSTITUTION.md`, the same workflow discipline (below), and this file.

---

## Workflow — how every sprint/step in this plan gets built

This section documents the standing process, made explicit per your request so it doesn't rely on memory across sessions.

1. **Explain before implementing.** Before writing any code or migration for a sprint/step, state in plain language: what's changing, why, which files/tables are touched, and what the tradeoffs or risks are. This applies to every checklist item below, not just the big ones.
2. **Wait for confirmation.** Don't start implementation until you've said go — either an explicit "yes/confirm/start," or an `AskUserQuestion` answer when there's a genuine fork in approach. Routine, low-risk follow-through on an already-confirmed sprint doesn't need re-confirmation for every sub-step.
3. **Build.** Migrations are idempotent SQL files in `supabase/migrations/` (`IF NOT EXISTS`/`DROP ... IF EXISTS` patterns), named `YYYYMMDD_description.sql`. Code follows `CONSTITUTION.md` (locked stack, RLS rules, i18n law, design tokens, etc.) without exception.
4. **Test.** `npm test`, `npm run lint:ci`, `npm run build` must all pass before a step is marked done. Any new SQL migration is pasted into Supabase SQL Editor by you and confirmed "Success" before the corresponding code that depends on it ships.
5. **Report how to test.** Every implemented step gets explicit manual click-through instructions — this is non-negotiable, not just for big features.
6. **Next.** Move to the next checklist item only after the current one is checked off and verified. Don't start Sprint/Phase N+1 until Sprint/Phase N's checklist is 100% done (a hard gate carried over from the original CRM plan).
7. **Bugs found mid-build get fixed in place and logged inline** in this document (not in a separate bug tracker) — the running narrative of what broke and why is part of this file's value, same as it was in the original `CRM_UPGRADE_PLAN.md`.
8. **Translation is part of "done."** Every new user-facing string ships in `en.json` **and** `ar.json` in the same step — never English-only.
9. **Git discipline**: never push to `main`. Pushes to `test` happen only on explicit per-instance request — a prior push approval is not a standing permission for the next one.

---

## Technical Context

Locked by `CONSTITUTION.md` — not re-litigated per sprint. Summary for reference:

- **Stack**: React 18 + Vite + Supabase (Postgres/RLS/Edge Functions) + Tailwind CSS + TypeScript (lib layer) + TanStack Query + React Router v6 + react-i18next.
- **Storage**: Single Supabase project, single schema — no second project, no separate CRM database (confirmed, Architecture Lock).
- **Testing**: Vitest (`npm test`), ESLint strict (`npm run lint:ci`).
- **Target platform**: Web PWA, dark-mode + RTL (Arabic) required on every new screen.
- **Scale/scope**: Single-tenant SMB repair-shop SaaS (QDS), not a multi-tenant generic ERP — this framing is why Track B explicitly rejects several Odoo patterns sized for a different scale (see Track B → "Explicitly not recommended").

## Constitution Check

*Gate: every step in both tracks must pass before merge; re-checked after each phase.*

- ✅ No new frontend framework/library introduced outside `CONSTITUTION.md §2.1`'s locked stack (drag-and-drop for Sprint 3 Kanban uses `@hello-pangea/dnd`, already installed — not a new dependency).
- ✅ Every new table gets RLS policies in its own migration; no table ships without RLS (Track A: enforced since Sprint 1 Step 1; Track B: every "Now" item below that adds a column/table inherits this rule).
- ✅ JSONB columns are always arrays, never objects (`CONSTITUTION.md §7.5a`) — applies to `deals.product_lines`, `pipelines.stages`, `activities.attachments`, and any future Track B JSONB column (e.g. a future `webhook_deliveries.response_data` must follow the same rule if it's ever JSONB).
- ✅ No hardcoded English strings in new code — i18n law applies equally to both tracks.
- ✅ Permissions resolved via `resolvePermissions()`, never `stored || ROLE_DEFAULT_PERMISSIONS[role]` — applies to any new `sales_rep` permission entries (Track A) and any new admin-only Track B feature (e.g. webhook delivery log).

No violations requiring justification at this time. Complexity Tracking table omitted — not needed.

---

## Architecture Lock (Track A)

These decisions are made and must not be revisited mid-build — changing them after migrations are written means an expensive rollback.

- [x] **Sales_rep RLS prerequisite confirmed as a hard gate** — `20260618_crm_add_sales_rep_role.sql` must run before any other CRM migration
- [x] **Option A confirmed**: extend the existing `customers` table (don't rename to `accounts`); DB table stays `customers`, UI label may say "Accounts"
- [ ] **Pipeline stage names confirmed with QDS sales team** — defaults proposed below (Sprint 1, Step 3); changing names later requires a data migration, so confirm before Sprint 3 (Pipeline UI) ships, not after
- [x] **Same Supabase project, same schema** — no second project
- [x] **`account_manager` vs `assigned_rep` resolved**: kept as two separate columns — `account_manager` (existing, free-text) is not mergeable with `assigned_rep` (new, FK-turned-text) without an unscoped data-cleanup migration
- [ ] **Sales_rep permission matrix reviewed with the sales manager** — ships with the default matrix below as Sprint 1's starting point; can be adjusted later (cheap, one-line change in `permissions.ts`), not a hard blocker

---

# TRACK A — CRM Upgrade

## Sprint 1 — Foundation (Database + API, no UI) ✅ COMPLETE

**Goal**: Database, API modules, permissions, constants. Nothing user-facing yet.

### Step 1 — Prerequisite migration ✅ Applied & verified 2026-06-22
**File**: `supabase/migrations/20260618_crm_add_sales_rep_role.sql`
- [x] `ALTER TABLE user_roles DROP CONSTRAINT chk_user_role` + re-add including `'sales_rep'`
- [x] `CREATE OR REPLACE FUNCTION public.rma_is_staff()` — add `'sales_rep'` to the role list
- [x] Do **NOT** add `sales_rep` to `public.rma_is_manager_or_above()` (would over-grant manager-tier write access schema-wide)

### Step 2 — Contacts table ✅ Applied & verified 2026-06-22
**File**: `supabase/migrations/20260619_crm_contacts.sql`
- [x] `CREATE TABLE IF NOT EXISTS contacts`
- [x] RLS: staff read, manager+/admin write

### Step 3 — Pipelines table + seed data ✅ Applied & verified 2026-06-22
**File**: `supabase/migrations/20260620_crm_pipelines.sql`
- [x] Seed **B2B Dealer**: New Lead (10%) → Contacted (20%) → Needs Assessment (40%) → Quote Sent (60%) → Negotiation (75%) → Won (100%)/Lost (0%) — 7 stages, names not yet confirmed with QDS sales team
- [x] Seed **B2C Retail**: New Inquiry (10%) → Contacted (30%) → Quote Sent (60%) → Won (100%)/Lost (0%) — 5 stages
- [x] RLS: staff read, admin write

### Step 4 — Leads table ✅ Applied & verified 2026-06-22
**File**: `supabase/migrations/20260621_crm_leads.sql`
- [x] `chk_lead_source`/`chk_lead_status` CHECK constraints
- [x] RLS: reps see own, manager+ see all. Unassigned leads are manager+-only (no self-claim pool in Sprint 1).
- [x] `converted_deal_id` created as plain `uuid` (FK added in Step 5)

### Step 5 — Deals table ✅ Applied & verified 2026-06-22
**File**: `supabase/migrations/20260622_crm_deals.sql`
- [x] `chk_deal_status`/`chk_deal_probability` CHECK constraints
- [x] RLS: same composite pattern as leads
- [x] Closed the loop from Step 4: `fk_leads_converted_deal` FK

### Step 6 — Activities table ✅ Applied & verified 2026-06-22
**File**: `supabase/migrations/20260623_crm_activities.sql`
- [x] `chk_activity_related_type`/`chk_activity_type` CHECK constraints
- [x] RLS: same composite pattern

### Step 7 — Extend customers table ✅ Applied & verified 2026-06-22
**File**: `supabase/migrations/20260624_crm_customers_extend.sql`
- [x] `lifecycle_stage`, `lead_source`, `assigned_rep`, `last_activity_at` added
- [x] **Do not touch `account_manager`** — stays separate
- [x] `sales_rep_update_assigned` policy added
- [x] `last_activity_at` kept correct via trigger `crm_update_customer_last_activity()` on `activities` INSERT

### Step 8 — Notification events ✅ Applied & verified 2026-06-22
**File**: `supabase/migrations/20260625_crm_notification_events.sql`
- [x] Seed `whatsapp_templates`: `crm_lead_assigned`, `crm_deal_won`, `crm_followup_due`, `crm_deal_overdue` (`pending_approval` — register in Meta before Sprint 4 ships)

### Step 9 — Constants ✅ Applied & verified 2026-06-22
**File**: `src/lib/constants.ts`
- [x] `LEAD_STATUS`, `LEAD_SOURCE`, `DEAL_STATUS`, `ACTIVITY_TYPE`, `LIFECYCLE_STAGE`
- [x] `ROLES.SALES_REP` + `ROLE_LIST` entry
- [x] 30 new tests, full suite green at the time

### Step 10 — Zod schemas ✅ Applied & verified 2026-06-22
**File**: `src/lib/schemas.ts`
- [x] `contactSchema`, `leadSchema`, `dealSchema`, `activitySchema`
- [x] `dealSchema.superRefine()` requires `lost_reason` when `status === 'lost'`
- [x] `leadSchema` does NOT hard-reject missing phone+email (soft UI warning only)
- [x] Stage-membership validation lives at the API layer (`deals.create()`/`moveStage()`), not in the schema

### Step 11 — Permissions ✅ Applied & verified 2026-06-22
**File**: `src/lib/permissions.ts`
- [x] `sales_rep` added to `ROLE_DEFAULT_PERMISSIONS`: leads/deals/activities (CRUD, no delete), contacts/pipelines (view-only), customers (view+edit), invoices (view-only — deviates from the original study matrix because RLS restricts invoice INSERT to manager+)
- [x] Full CRM sections backfilled onto `MANAGER`'s defaults (gap fix)
- [x] 26 new tests, full suite green at the time

### Step 12 — API domain modules ✅ Applied & verified 2026-06-22
- [x] Prerequisite: `20260626_crm_leads_convert_rpc.sql` — `crm_convert_lead()` SECURITY DEFINER RPC with an internal auth check (unlike the older unguarded `delete_customer_cascade` precedent)
- [x] `src/api/db/contacts.ts`, `pipelines.ts`, `deals.ts`, `activities.ts`, `leads.ts` built in that order
- [x] Non-negotiables held: `leads.convert()` is one atomic RPC; `deals.moveStage()`/`create()`/`update()` all validate stage membership; `product_lines`/`stages` are always JSONB arrays

### Step 13 — Barrel export ✅ Applied & verified 2026-06-22
**File**: `src/api/db/index.ts` — `npm test` 272/272, lint clean, build succeeded

### Step 14 — Validate Sprint 1 ✅ Sufficient to proceed — 2026-06-22
- [x] All 9 migrations applied cleanly and verified live
- [x] `npm test` (274/274 by end of sprint), lint clean, build succeeds
- [x] `sales_rep` proven live end-to-end; 3 real bugs found and fixed during manual QA (duplicate role constraint, missing `products` permission, preview-role sidebar gating)
- [ ] Direct API-module smoke test — deliberately deferred to Sprint 2's real UI clicks rather than fragile production-console testing; revisit only if something unexpected surfaces

---

## Sprint 2 — Leads Page ✅ COMPLETE (build), QA in progress

### Step 0 — Prerequisite: assigned_rep type fix ✅ Applied & verified 2026-06-22
**File**: `supabase/migrations/20260628_crm_assigned_rep_use_email.sql`

Found while starting to build the Leads page: `assigned_rep` on `leads`/`deals`/`activities`/`customers` was `uuid REFERENCES auth.users(id)`, but there's no client-side way to resolve another user's `auth.users.id` (protected schema, not queryable via PostgREST). Switched all 4 columns to `text` (email), matching `rma_tickets.assigned_technician`. Required dropping/recreating all 7 dependent policies plus fixing `crm_convert_lead()`'s internal auth check.

**Goal**: Sales reps can capture and track leads.

- [x] `src/pages/Leads/index.jsx` — list view, status/source filters, search (no "overdue badge" — leads have no `due_date`; only Activities do)
- [x] `CreateLeadModal`/`ConvertLeadModal` — `src/pages/Leads/_modals.jsx`
- [x] Convert Lead to Deal via atomic RPC
- [x] Bulk CSV import (local `parseCSVLine`, matching existing Products/Customers pattern)
- [x] Route `/leads`, sidebar entry, nav-gated via `requiredPermission: ['leads','view']`
- [x] Full `en.json`/`ar.json`, Direction B dark mode
- [x] `npm test` 274/274, lint clean, build succeeds

**Bugs found and fixed during manual QA** (all verified live):
- [x] `created_by` had the same uuid-vs-email bug as `assigned_rep` — `20260629_crm_created_by_use_email.sql`
- [x] Zod schemas still validated `assigned_rep`/etc as `.uuid()` after the DB columns moved to text — fixed to `z.union([z.string().email(), z.literal('')])`
- [x] Row action menu opened with a scrollbar instead of floating — `overflow-x-auto` on the table wrapper implicitly forces `overflow-y: auto` too (CSS overflow spec); fixed by portal-rendering the menu via `createPortal(..., document.body)` with `position: fixed`
- [x] Convert-to-deal failed on `customers.customer_code NOT NULL` — `crm_convert_lead()` never set it; fixed via `20260630_crm_convert_lead_customer_code.sql`, generating the same `CB-########` format the UI uses elsewhere
- [x] `ConvertLeadModal` bug in `LeadDetails.jsx` — two bugs: (1) `handleOpenConvert` only set `title`, leaving `pipeline_id: ''` → validation always fired "Deal title and pipeline are required"; (2) modal was called with `pipelines={pipelines}` but component signature expects `stages` prop (defaulted to `[]`, hiding the stage selector entirely). Fixed: `handleOpenConvert` now mirrors `Leads/index.jsx` logic (auto-sets `pipeline_id` + `stage_id` from `pipelines[0]`); call site now passes computed `stages` array. Also added `stage_id: ''` to `EMPTY_CONVERT_FORM` in `_constants.js`.

**User-requested additions, built Sprint 2 → folded into Sprint 2.5**:
- [x] Lead comments — initially a `LeadDrawer.jsx` modal reusing `activities` (`type:'note'`, `related_type:'lead'`) — **superseded by Sprint 2.5's full chatter**, logic carried forward
- [x] Two new lead statuses, `nurturing` + `inactive`, researched against HubSpot/Salesforce/RevOps best practice (5–7 action-oriented statuses) — `20260701_crm_leads_add_statuses.sql`, `converted`/`disqualified` unchanged

- [x] Manual click-through confirmed: create lead, convert lead → deal + new customer, action menu fix — all working as of 2026-06-22

---

## Sprint 2.5 — Professional Lead Experience (Odoo/Zoho-grade) ✅ BUILT, QA pending

**Trigger**: user reviewed the basic comment drawer and asked for a real CRM lead experience "same as Odoo and Zoho." This pulled the Activities feed (originally Sprint 4 scope) forward and fused it into a full lead detail page — no throwaway work, Sprint 4 needs this exact feed for deals too.

**Research basis** (mapped from real Odoo/Zoho documentation, not assumption):

| Odoo / Zoho capability | Our implementation |
|---|---|
| Full record detail page | `/leads/:id` + `LeadDetails.jsx`, mirrors `/customers/:id` |
| Status pipeline strip | Clickable status stepper (detail page) + inline status-pill dropdown (list, reusing the RMA pattern) |
| Chatter → Log Note | "Log note" composer → `activities` row `type:'note'` |
| Chatter → Schedule Activity | "Schedule activity" composer → call/meeting/task/email/whatsapp + due date + assignee |
| Planned vs. Done split | "Planned" zone (Mark Done) + "History" feed below |
| Automatic field tracking | System auto-logs `type:'log'` activities on status change/conversion, rendered muted/italic |
| Followers + @mentions | **Deferred** (Phase F) — needs a `lead_followers` table + notification-routing work, not core to daily rep workflow |
| Attachments | **In scope** — `activities.attachments` jsonb, reuses the `rma-attachments` bucket |

### Phase A — Lead detail page + routing ✅
- [x] `LeadDetails.jsx` — header (name, company, status stepper, Edit/Convert/Disqualify), contact-info card, chatter panel
- [x] `LeadDetailsRoute` wrapper + `/leads/:id` route, gated `['leads','view']`
- [x] Lead name clickable in the list → navigates to detail page
- [x] `LeadDrawer.jsx` retired; logic moved into `LeadChatter.jsx`
- [x] Mobile-header title map updated

### Phase B — Inline + stepper status change (with auto-logging) ✅
- [x] Inline status-pill dropdown in the list (portal-rendered, same pattern as the action menu)
- [x] Clickable status stepper on the detail page
- [x] Every status change auto-logs a `type:'log'` activity ("Status changed from X to Y")
- [x] Gated by `canDo('edit')`, blocked on converted leads

### Phase C — Odoo-style chatter (`LeadChatter.jsx`) ✅
- [x] Two-tab composer: Log Note / Schedule Activity
- [x] Planned zone (overdue flagged red, Mark Done)
- [x] History feed (notes + completed activities + system logs, newest first, type icons + timestamps)
- [x] Built entirely on the existing `activities` table + API — realtime via Supabase channel

### Phase D — Data model + constants ✅
- [x] `20260702_crm_activities_chatter.sql` — `chk_activity_type` extended with `'log'`; `attachments jsonb` column added
- [x] `ACTIVITY_TYPE.LOG` + `ACTIVITY_TYPE_SCHEDULABLE` (excludes `'log'`) in `constants.ts`
- [x] Tests updated

### Phase E — i18n + validation ✅
- [x] All new strings in `en.json`/`ar.json`
- [x] `npm test` 277/277, lint clean, build succeeds (55 precache entries)
- [x] Found and fixed a latent gap: `common.saveChanges`/`createdBy`/`remove`/`createdAt` were missing from the `common` i18n namespace despite already being referenced

### Phase F — Followers, @mentions, attachments-as-a-concept (DEFERRED, future)
- [ ] `lead_followers` table + subscribe/unsubscribe UI
- [ ] @mention autocomplete → in-app notification
- _Revisit after Sprint 3._

### Round 2 — user feedback after first click-through ✅ COMPLETE — verified 2026-06-22
- [x] **Threaded replies**: `20260703_crm_activities_replies.sql` adds `parent_id uuid REFERENCES activities(id) ON DELETE CASCADE`. History items show "Reply" (hidden on system `log` entries); replies render indented, oldest-first. Replies are themselves `type:'note'` rows with `parent_id` set — no new table.
- [x] **Activity status control**: user chose **Done/Reopen + Reschedule** over a full Done/Cancelled model (no schema change needed — `completed_at` already nullable). Added `activities.reopen()` and `activities.reschedule()`. Planned items show Mark Done + Reschedule; completed items in History show Reopen.
- [x] **Company-name-first**: `LeadDetails.jsx` header and the list row now show `company_name || full_name` as the bold primary line, `full_name` demoted to a secondary line only when a company exists.
- [x] `npm test` 277/277, lint clean, build succeeds
- [x] Migration `20260703_crm_activities_replies.sql` run live, confirmed "Success"
- [x] Manual click-through confirmed 2026-06-22: replies thread correctly, reschedule updates due date, reopen moves an activity back to Planned, company-name-first displays correctly in both list and detail page

**Sprint 2.5 is fully closed.** All phases (A–E, Round 2) built and verified.

---

## Sprint 3 — Pipeline Kanban ✅ BUILT, QA pending

> **Build status 2026-06-23**: All build-checklist items complete. `npm test` 277/277, lint clean, build succeeds (60 precache entries, up from 55 — two new lazy chunks for `Pipeline/index.jsx` and `Pipeline/DealDetail.jsx`). Decisions applied per user confirmation: rotting threshold hardcoded at `DEAL_ROTTING_THRESHOLD_DAYS = 7` (global constant, no admin UI — see prior discussion); built against the current seeded pipeline stage-name defaults (cheap to rename later — `deals.stage` stores the stage `id`, not its name, so a rename is a one-line label update on `pipelines`, not a deal-row migration).
>
> **No-throwaway-work refactor**: `LeadChatter.jsx` (Sprint 2.5) generalized into `src/components/ActivityChatter.jsx`, accepting `relatedType`/`relatedId` instead of being lead-only. `LeadDetails.jsx` updated to use it; `DealDetail.jsx` reuses the exact same component — notes, scheduled activities, planned/history, replies, reschedule, reopen, and attachments all work identically for deals with zero duplicated code. i18n namespace renamed `leadChatter` → `activityChatter` to match (new keys `logStage`/`logWon`/`logLost` added for deal-specific system log entries; `lockedConverted` moved to the lead-specific `leads.*` namespace since it no longer fits a shared component). `storage.uploadLeadAttachment()` generalized to `storage.uploadActivityAttachment(file, relatedType, relatedId)`.
>
> **Won/Lost semantics**: `deals.markWon()` now also sets `probability: 100` (Odoo pattern, approved). `deals.moveStage()`, `markWon()`, and `markLost()` all auto-log a `type:'log'` activity (stage names/reasons baked in as plain text at write time, not re-resolved via i18n keys — pipeline stages are admin-configured business data, not app chrome). On the Kanban board, dragging a card onto the Won column calls `markWon()` directly (not a plain stage move); dragging onto Lost opens the existing lost-reason modal first — both match the drag-to-close UX pattern from the Odoo research, not just a generic stage change.
>
> **Bulk activity-state query**: added `activities.listForRelated(relatedType, relatedIds[])` to `src/api/db/activities.ts` so the board can compute per-card and per-column overdue/today/planned state in one query instead of one-per-card (would have been an N+1 query pattern otherwise).
>
> **Scope note**: stage-column folding (Odoo's `fold` boolean) was not built — not part of our `PipelineStage` data model and not requested; flagging as a possible future addition, not a gap.
>
> **Needs manual click-through** (see chat for the full list): create a deal, drag a card between stages, drag a card onto Won (confirm probability hits 100), drag a card onto Lost (confirm the reason modal blocks until filled), open a deal detail page and use the chatter (note/schedule/reply/reschedule/reopen — same as Leads), edit product lines, verify the rotting indicator and per-column progress bar render sensibly, and test drag performance on a touch device per the Risk Register (fall back to a tap-to-move dropdown only if it's actually poor — not pre-built speculatively).
>
> **Post-build refinements 2026-06-24** (user QA round, `npm test` 277/277, lint clean, build OK — one transient esbuild OOM that passed on retry):
> 1. **Won/Lost cards now render in their own columns** — the board query dropped its `status:'open'` filter (key `['deals', pipelineId]`), and the optimistic drag handler keeps closed cards in place with `isDragDisabled` + `opacity-70`, so a Lost deal (e.g. "Salma Reda") now shows under Lost on both B2B and B2C pipelines instead of vanishing.
> 2. **Leads list is sortable** — page-scoped `SortableHeader` in `src/pages/Leads/_shared.jsx`, `sortConfig` persisted via `safeStorage` (`leadsSortConfig`), wired into Name/Source/Status/Assigned-Rep. Pattern recorded in agent memory for reuse on future list pages.
> 3. **"New Lead" → "New Deal"** on the Pipeline board — label-only change via migration `20260704_crm_pipeline_rename_new_lead_stage.sql` (data UPDATE on `pipelines.stages`, stage `id` unchanged; **user must run it**).
> 4. **Deal product lines link to the Products DB** — `DealDetail.jsx` uses the page-scoped `ProductSearchInput` (`src/pages/Pipeline/_shared.jsx`) so a line can be tied to a real product (`product_id` + `product_name`) instead of free text only.
> Earlier same-round UX fixes: color-coded inline Source dropdown on the Leads list (matching the Status dropdown), customer-search "required" bug on Create Deal fixed, and a "Linked Deal" card on the Lead detail page when `converted_deal_id` is set.

**Goal**: The main CRM interface — highest-value, most-used screen.

**Odoo benchmark findings to fold in** (researched from real Odoo 19 `crm` module source, `D:\odoo-19.0`):
- Deal card anatomy: bold title → revenue (+ recurring revenue if used) → contact avatar/name (falls back to company name) → tags → footer split: priority stars + next-activity icon (left), staleness indicator + assigned-rep avatar (right)
- "Rotting" indicator — a stage-level threshold (days) after which a stalled deal is visually flagged
- Per-column progress bar segmented by overdue/today/planned activities, summed by deal value — gives an at-a-glance "how much revenue is at risk per stage" view
- `activity_state` rollup logic (confirmed from `mail_activity_mixin.py`): a record's badge = `overdue` if any open activity is overdue, else `today` if any due today, else `planned` — worth applying to the Leads list too, not just Pipeline cards
- Empty stage columns can fold/collapse
- Odoo enforces `probability = 100` whenever a deal sits in a Won stage at the constraint level — worth tightening when Won/Lost actions are built here

**Build checklist:**
- [x] `src/pages/Pipeline/index.jsx` — pipeline tabs, Kanban columns by stage, deal cards
- [x] Deal cards: title, customer name, value (EGP), assigned rep avatar (colored initials), next activity due date + overdue/today badge, rotting/staleness indicator
- [x] Per-column progress bar (overdue/today/planned, summed by value)
- [x] Drag-and-drop between stages via `@hello-pangea/dnd` (already installed, optimistic UI update on drop)
- [x] On drop: `deals.moveStage()` → server-validated → `queryClient.invalidateQueries` (or `markWon()`/opens lost-reason modal if dropped on a terminal column)
- [x] Deal create modal: title, customer (lightweight search field, top-8 matches), pipeline, stage, value, close date, rep, notes
- [x] `src/pages/Pipeline/DealDetail.jsx` (route `/pipeline/:id`): full record, editable product lines, notes, activity timeline via shared `ActivityChatter`
- [x] Won/Lost actions — `lost_reason` required on Lost; `probability = 100` enforced in `deals.markWon()`
- [x] Routes `/pipeline`, `/pipeline/:id`; "Pipeline" added to sidebar (gated `['deals','view']`)
- [x] All strings in `en.json` + `ar.json`
- [ ] Mobile/PWA check: drag performance on touch — **not yet tested, needs a real device/touch test**; fall back to tap-to-move-stage dropdown only if it proves poor (see Risk Register)

**Post-build refinements — Round 2 (2026-07-08)** — `npm test` 277/277, lint clean, build succeeds:

1. **Four additional Pipeline views** — Odoo-parity analytics suite added via URL-persisted view switcher (`?view=kanban|list|graph|pivot|activity`), no route change needed:
   - **List view** (`PipelineListView.jsx`) — sortable table (Title/Customer/Stage/Value/Rep/Close Date), status filter chips, footer totals
   - **Graph view** (`PipelineGraphView.jsx`) — Recharts engine; bar/line/pie chart type toggle; measure (count | revenue) and group-by (stage | salesperson | status | month) selectors; summary stat cards
   - **Pivot view** (`PipelinePivotView.jsx`) — 2D pivot table; row dim, col dim, measure selectors (count | sum | avg); row/col/grand totals with accent color
   - **Activity view** (`PipelineActivityView.jsx`) — deals × activity-type matrix; cells color-coded overdue/today/planned; column progress bar; SVG icons per type
   - View switcher toolbar added to `Pipeline/index.jsx` PageHeader

2. **XLSX Export** — added to Pipeline PageHeader; flat table with Excel AutoFilter on every column header (no stage-group headers, no subtotals, no grand total); sorted by stage order; 14 columns (Stage / Title / Company / Value / Status / Probability / Rep / Close Date / Rotting / Won-Lost Date / Lost Reason / Created At / Created By / Notes)

3. **Kanban column header fix** — title + deal count on line 1, total column value on line 2 (previously both on one cramped line)

4. **"New Deal" → "New Deals"** label fix — `20260707_crm_rename_new_deal_stage_plural.sql` (data UPDATE on `pipelines.stages` JSONB; stage `id` `new_lead` unchanged; idempotent)

5. **Seed data** — `20260706_seed_test_users_and_deals.sql`: 10 test users across all roles (inserted into `user_roles` only, no auth accounts), 31 deals spread across all stages, Feb–Jul 2026, varied reps/values/statuses — used to populate the Graph/Pivot/Activity views with realistic data

6. **Deal Detail page — 6 Odoo-parity UX improvements** (all in `DealDetail.jsx`):
   - **Color-coded stage pills** — distinct color per stage position (blue → indigo → violet → amber → orange); active stage gets a ring; wraps if > 5 stages
   - **Won/Lost inline** — ✓ Mark Won and ✗ Mark Lost moved from the top-right button cluster into the stage row itself (same line), separated by a `|` divider; only Edit and Reopen remain top-right
   - **Probability** — shown as a color-coded pill in the header (green ≥75 / amber ≥50 / orange ≥25 / gray <25) and as a progress bar in the Deal Info sidebar; editable via a range slider (0–100, step 5) in the Edit Deal modal; `probability` added to `EMPTY_DEAL_FORM` in `_constants.js`
   - **Value prominent + conditional edit** — value displayed as a large bold number in the header; a pencil icon next to it opens an inline input (Enter/Esc to confirm/cancel) — **only shown when `product_lines` is empty**; when product lines exist, value is read-only with a "(Calculated from product lines)" note; the Edit Deal modal disables the value field the same way (`hasProductLines` prop)
   - **Expected Close Date in header** — shown inline with the value and probability in the header info row (calendar icon + "Closes: date"); still present in the Deal Info sidebar as well
   - **Single unified tab row** — the right panel previously had two nested tab bars (outer "Activity | Product Lines", inner "Log Note | Schedule Activity"). Collapsed into **one flat row**: Log Note | Schedule Activity | Product Lines. `ActivityChatter` now accepts optional `controlledTab`/`onControlledTabChange` props; when provided it suppresses its own tab bar and is driven externally by DealDetail. Product Lines tab shows the full editor with column headers (Product / Qty / Unit Price / Subtotal) and a bold total row; saving product lines now also auto-syncs `deals.value` to the computed sum.

7. **Activity controls inline** (`ActivityChatter.jsx`) — planned activity cards changed from stacked right-side buttons to a horizontal inline row below the title: **✓ Mark Done · ✏ Edit · ✕ Cancel**. "Edit" = reschedule (date picker inline below). "Cancel" = hard-deletes the activity row via new `db.activities.delete(id)` method added to `src/api/db/activities.ts`.

8. **Data consistency migration** — `20260708_crm_sync_deal_values.sql`: back-fills `deals.value` from `SUM(qty × unit_price)` for all deals with non-empty `product_lines` (old `saveLines()` path never wrote back to `value`); also enforces `probability = 100` for won deals and `probability = 0` for lost deals. **User must run in Supabase SQL Editor.**

**Post-build refinements — Round 3 (2026-07-09)** — `npm test` 277/277, lint clean, build ✓:

1. **Full inline editing on Deal Detail** — all editable fields now use the modern "click-to-edit" hover pattern (dashed indigo underline + background tint on hover; click the value to open an input in-place). No pencil icons. Fields covered:
   - **Title** — click `h1` → text input (Enter saves, Esc cancels)
   - **Customer** — click name → searchable type-ahead dropdown (top-10 live filter from `customers` list; click-outside closes; saves `customer_id`)
   - **Value** — click value → number input (existing pencil replaced by click pattern; disabled when product lines exist)
   - **Expected Close Date** — click date row → date picker input; shows "Set close date" when null so the field is always a click target
   - **Probability** — click colored pill → number input 0–100 (ring glow hover on the pill suits its shape better than underline)
   - **Assigned Rep** (sidebar) — click name → `<select>` dropdown; widened role filter to include `admin`/`super_admin` (was `sales_rep|manager` only — caused blank dropdown for admin accounts); field uses `user_email` (not `email`) from `UserRoleRow`
   - All edit states: save button + Esc/Enter shortcut; `canEditDeal` guard prevents any click on read-only roles; `title` tooltip "Click to edit"

2. **Tab bar redesign** on Deal Detail:
   - "Log Note" renamed → **"Deal Log"** (new i18n key `activityChatter.addComment`)
   - New 4th tab **"Deal Notes"** (`pipeline.dealNotesTab`) — full-width `<textarea>` pre-populated from `deal.notes`, with an explicit Save button; saves to `deals.notes`; persists between tab switches via `useEffect` sync from the query cache
   - Tab order: **Deal Log | Schedule Activity | Product Lines | Deal Notes**
   - **Deal Log tab**: note composer removed (moved to right-side Comment Panel); ActivityChatter renders in read-only history mode (`hideNoteComposer` prop)
   - **Schedule Activity tab**: history feed removed (`hideHistory` prop); shows only the schedule form + planned activities list

3. **Deal Comment Panel** — new persistent right-side column (`src/pages/Pipeline/DealCommentPanel.jsx`):
   - Always visible; does not require switching tabs
   - Colored avatar initials (deterministic hash of email → one of 8 accent colors — same across sessions)
   - Threaded comment bubbles (bubble style, rounded-tl-sm on author side)
   - Timestamps, file attachment links, "Reply" inline (Enter to send, Esc to cancel)
   - Composer at bottom: `<textarea>` (500-char limit, char counter), attachment button (reuses `storage.uploadActivityAttachment`), Send button + Ctrl+Enter shortcut
   - **Synced with Deal Log**: both read the same TanStack Query key `['activities', 'deal', dealId]`; posting in the panel immediately appears in the Deal Log (no extra code — shared cache)
   - Realtime: Supabase channel `deal_comments_panel_${dealId}` → `invalidateQueries` on any `activities` INSERT/UPDATE/DELETE
   - Auto-scrolls to bottom on new comment arrival (only if comments grew, not on initial load)

4. **`ActivityChatter.jsx` extended** with two new props:
   - `hideNoteComposer` — suppresses the note textarea when the note composer has moved to an external panel (schedule activity form still shows when on the activity tab)
   - `hideHistory` — suppresses the history feed section (used for Schedule Activity tab to show planned-only view)

5. **Deal Detail layout**:
   - **Full-width page** — `max-w-5xl` cap removed; page now fills the content area
   - **4-column grid**: Deal Info (25%) | Tabs (50%) | Comment Panel (25%) — `lg:grid-cols-4`, `items-start`
   - **Edit button removed** — inline editing makes the modal-based "Edit Deal" button redundant; "Reopen Deal" stays (it's a distinct workflow action, not an edit)

6. **New i18n keys** (both `en.json` + `ar.json`):
   - `activityChatter.addComment` → "Deal Log" / "سجل الصفقة"
   - `pipeline.dealNotesTab` → "Deal Notes" / "ملاحظات الصفقة"
   - `pipeline.dealNotesPlaceholder` → "Add notes about this deal..." / "أضف ملاحظات حول هذه الصفقة..."
   - `pipeline.searchCustomer` → "Search customer..." / "ابحث عن عميل..."
   - `pipeline.setCloseDate` → "Set close date" / "تحديد تاريخ الإغلاق"
   - `pipeline.clickToEdit` → "Click to edit" / "انقر للتعديل"
   - `pipeline.commentsPanel` → "Comments" / "التعليقات"
   - `pipeline.noComments` → "No comments yet. Be the first to comment." / "لا توجد تعليقات بعد. كن أول من يعلق."
   - `pipeline.commentPlaceholder` → "Write a comment... (Ctrl+Enter to send)" / "اكتب تعليقاً... (Ctrl+Enter للإرسال)"

**Post-build refinements — Round 4 (2026-07-09)** — `npm test` 277/277, lint clean, build ✓:

1. **Lead & deal reference codes** — auto-generated reference codes added to identify records at a glance:
   - **Leads**: `LD-XXXXXXXX` (8 random digits) stored in `leads.lead_code`. Generated client-side at create-time; displayed as a clickable code cell in the list (replaces name as the click target to navigate to detail page). `20260709_crm_lead_deal_codes.sql` adds the column and backfills existing rows.
   - **Deals**: `QT-XXXXXXXX` stored in `deals.deal_code`. Initially seeded as `DL-` in `20260709`, then renamed to `QT-` (Quotation) by `20260710_crm_deal_code_rename.sql` to reflect the deal-as-quotation lifecycle. `crm_convert_lead` RPC updated in `20260711_crm_convert_rpc_deal_code.sql` to generate the QT- code atomically on conversion (no longer patched client-side after the fact).
   - Codes displayed in the Leads list (clickable), Pipeline list (clickable), Deal Detail header, and Lead Detail header. Pipeline search extended to support `deal_code` matching.

2. **Pipeline list view overhaul** (`PipelineListView.jsx`):
   - **Status column removed** — stage IS the status indicator; won/lost stages render green/red on the StagePin badge; a separate status column was redundant.
   - **StagePin inline dropdown** — per-row badge that opens a stage-change menu on click. Color-coded by stage position using an 8-color palette (`OPEN_STAGE_COLORS`). Won = green, Lost = red. Uses `.stage-pin-root` CSS class for safe click-outside detection (mousedown fires before click — the containment check prevents the dropdown from closing before the option click lands).
   - **Multi-select bulk actions** — checkbox column + select-all header. Bulk stage-change via `deals.bulkMoveStage()`; bulk delete (admin-only) via `deals.bulkDelete()`. `selectedDeals` state lifted to `Pipeline/index.jsx` so the export dropdown can also read it.
   - **Export dropdown** — replaces single export button with 3-option dropdown: Export All, Export Filtered (only when a filter is active), Export Selected (only when rows are checked).
   - **Status filter removed** from filter panel and graph/pivot views — status (open/won/lost) is now implicit in stage color, not a separate dimension.

3. **Leads page export dropdown** — same 3-option pattern (Export All / Export Filtered / Export Selected) added to the Leads page header, replacing the single export button.

4. **Kanban improvements** — Leads kanban card clickable-code (LD- code displayed on card, clicking navigates to detail); deal codes displayed on Pipeline kanban cards.

---

## System-wide Rule — Bulk Action Bar (2026-07-09)

**Rule**: When rows can be multi-selected for bulk operations, the bulk action bar MUST appear as a standalone card **below** the search/filter card and **above** the table — never inside `<PageHeader>` or the toolbar row. All existing pages unified to this pattern.

**Canonical container** (use exactly — `Pipeline/PipelineListView.jsx` is the reference):

```text
bg-indigo-50 dark:bg-indigo-900/20 border border-[#4338ca]/20 dark:border-[#a5b4fc]/20 rounded-[14px] px-4 py-2.5 flex items-center gap-3 flex-wrap
```

**Count label**: `text-sm font-medium text-[#4338ca] dark:text-[#a5b4fc]` — format: `{N} {t('common.selected')}`

**Divider**: `w-px h-5 bg-[#4338ca]/20 dark:bg-[#a5b4fc]/20`

**Action selects**: `text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg px-2 py-1.5 bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent`

**Apply button**: `px-3 py-1.5 bg-[#4338ca] dark:bg-[#a5b4fc] text-white dark:text-[#0b0f17] rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-40 transition-opacity`

**Delete button** (soft red, NOT solid): `flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors border border-red-200 dark:border-red-800`

**Clear button**: `ml-auto text-xs text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]`

**Pages unified (2026-07-09)**: Pipeline (reference), Leads, Customers, Products, RMA Tickets.

---

## System-wide Rule — Filter Button Pattern (2026-07-08)

**Rule**: Every page that has a search bar must also have a standardised **Filters** button (funnel icon + label + active-count badge) that reveals a collapsible filter panel. This is a permanent engineering law enforced from this date forward — new pages must ship with it, and existing pages without it were retroactively updated today.

**Canonical Filters button classes** (use exactly — no `indigo-*` named classes):

- **Inactive**: `flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors border-[#e6e9ef] dark:border-[#212a38] text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520]`
- **Active** (panel open OR filters applied): `border-[#4338ca] dark:border-[#a5b4fc] text-[#4338ca] dark:text-[#a5b4fc] bg-indigo-50 dark:bg-indigo-900/20`
- **Badge**: `w-4 h-4 bg-[#4338ca] dark:bg-[#a5b4fc] text-white dark:text-[#0b0f17] text-xs rounded-full flex items-center justify-center`
- **Filter icon**: `w-4 h-4` (never `w-5 h-5`)
- **Filter panel**: `p-4 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]`
- **Panel selects**: `px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent`

**Pages updated today** (`npm test` 277/277, lint 0 errors, build ✓):

| Page | Filter state moved/added |
|---|---|
| `cp/AuditLog.jsx` | Moved User, Action Type, Date From, Date To behind Filters toggle |
| `cp/WALogs.jsx` | Moved Provider, Status, Date From, Date To behind Filters toggle; search stays always-visible |
| `Leads/index.jsx` | Moved Status, Source behind Filters toggle |
| `Pipeline/PipelineListView.jsx` | Added Stage + Assigned Rep filters; status chips remain always-visible |
| `PartsInventory.jsx` | Added Supplier filter; Low Stock chip remains always-visible |
| `Products/ProductsListTab.jsx` + `Products/index.jsx` | Added Brand, Category, Status filters; state in index.jsx, UI in ProductsListTab |

**New i18n keys** (added to `en.json` + `ar.json`):
- `products.allBrands`, `products.allCategories`, `products.allStatuses`
- `parts.allSuppliers`
- `pipeline.allStages`, `pipeline.allReps`

---

## System-wide Design Unification Sprint (2026-07-09)

**Goal**: Make every page's search bar, Filters button, export button, and page header visually identical. Applied retroactively to all existing pages — new pages must ship already unified.

**Changes applied** (`npm test` 277/277, lint 0 errors, build ✓):

1. **AI Assist button hidden** — `<AIAssist>` JSX and imports removed from Dashboard, Reports, Inventory, CustomerDetails, RMATickets. Component file kept for future re-enabling.

2. **Export button canonicalized** — `RMATickets/index.jsx` export button replaced with the canonical outline style (green download icon, design-token border/hover).

3. **Search bar unified across all pages** — all `border-gray-300`, `ring-indigo-500/600`, light-only inputs updated to the canonical class (see Filter Button Rule above for `inp` class string). Pages fixed: `PartsInventory`, `Inventory/ByProductTab`, `Inventory/WarehousesTab`, `cp/AuditLog`, `cp/WALogs`.

4. **Filters button active state unified** — eliminated all `border-indigo-500 / text-indigo-600 / dark:border-indigo-400 / dark:text-indigo-300` references. Updated to design-token classes (see rule above). Pages fixed: Products, Customers, RMATickets, PartsInventory, Inventory/ByProductTab, AuditLog.

5. **Filter icon size unified** — all `w-5 h-5` filter funnel icons → `w-4 h-4`. Pages fixed: PartsInventory, Inventory/ByProductTab, AuditLog.

6. **Filter badge unified** — all `bg-indigo-600` badge backgrounds → `bg-[#4338ca] dark:bg-[#a5b4fc] text-white dark:text-[#0b0f17]`. Pages fixed: PartsInventory, Inventory/ByProductTab, Products, AuditLog.

7. **Filter panel background unified** — `bg-gray-50` → `bg-[#f8f9fb] dark:bg-[#0f1520]` with design-token border. Pages fixed: Inventory/ByProductTab.

8. **Pipeline search/filter added** — Pipeline/index.jsx gained a persistent search bar + stage/rep/status filter panel; `filteredDeals` useMemo passed to all 5 views (kanban, list, graph, pivot, activity). PipelineListView's duplicate filter UI removed.

9. **`Button secondary` variant updated** in `src/components/ui.jsx` — now uses design tokens system-wide instead of gray palette.

**New i18n keys** (added to `en.json` + `ar.json`):

- `pipeline.allStatuses`, `pipeline.searchPlaceholder`, `pipeline.filteredCount`

---

## Sprint 4 — Activities & Follow-Ups

**Goal**: Reps never miss a follow-up. (Note: the core activity engine — log/schedule/complete/reopen/reschedule, planned vs. history — already exists from Sprint 2.5. This sprint is the system-wide surface for it, not new plumbing.)

- [x] `src/pages/Activities/index.jsx` — full page redesign (2026-06-28): 4-tab layout (All Activities default → Today → Overdue → Activity Logs); table list view with 7 sortable columns: Source badge (Lead/Deal, extensible), User (assigned_rep), Customer (resolved + clickable → `/customers/:id` for deals, `/leads/:id` for leads), Details (type icon + title), Due Date / Completed (dynamic header per tab, overdue red / today amber), Actions (Mark Done / Reschedule inline / Cancel; Reopen on Logs tab); search bar matches Leads/Pipeline design (`shadow-sm`, `max-w-md`, `w-5 h-5` icon, indigo named colors); collapsible filter panel (Type / Assignee / Source); indigo bulk action bar (bulk Mark Done + bulk Cancel); canonical pagination (`activitiesPerPage` safeStorage key); sort config persisted (`activitiesSortConfig`); all strings in `en.json` + `ar.json`.
- [x] `src/api/db/activities.ts` — `listCompleted()` added: queries `completed_at IS NOT NULL`, non-log type, ordered newest-first; used by the Activity Logs tab.
- [x] Overdue follow-ups count badge in sidebar — `listOverdue()` in `activities.ts`; `overdueActivityCount` query in `App.jsx`; `badge` property on the Activities nav item (already live)
- [x] Dashboard widget: "Overdue Follow-Ups" count card — `overdue_followups` in `WIDGET_CATALOG`; list card with day-count badges; green "all clear" empty state; clickable → `/activities?tab=overdue` (already live)
- [ ] `src/lib/events/crmEventHandlers.ts` — `registerCrmEventHandlers()` alongside `registerTicketEventHandlers()` (postponed)
- [ ] WhatsApp template `crm_followup_due` — morning digest, toggleable per-type in `WASettings.jsx` (postponed)
- [ ] All strings in `en.json` + `ar.json`

**Post-build additions (2026-06-28)**:

- [x] Pagination added to `Leads/index.jsx` (safeStorage key `leadsPerPage`) and `Pipeline/PipelineListView.jsx` (safeStorage key `pipelineListPerPage`) — matches canonical pattern in `DESIGN.md`; select-all scoped to current page with cross-page Set merge/delete.

---

## Sprint 5 — Dashboard & Polish

**Goal**: Management visibility. System usable end-to-end.

- [x] `Dashboard.jsx`: sales KPI section — 4 hero tiles (`crm_kpi` widget): open pipeline value (fmtCurrency), deals won this month, new leads this month, overdue follow-ups count
- [x] `Dashboard.jsx`: "Pipeline by Stage" horizontal bar chart (`pipeline_by_stage` widget) — open deals grouped by stage, count + value label, normalized bar width
- [x] `Dashboard.jsx`: Rep Leaderboard card (`rep_leaderboard` widget) — top 5 reps by deals won this month; gold/silver/bronze rank circles; won count + value per row
- [x] `CustomerDetails.jsx`: Contacts tab — list/add/edit/delete; inline form; Primary badge; `db.contacts.list/create/update/delete`; tab label shows count
- [x] `CustomerDetails.jsx`: Deals tab — table of all deals for the account; status badge (Open/Won/Lost); row click navigates to `/pipeline/:id`; `db.deals.listForCustomer()` added to `deals.ts`
- [ ] Reports CRM section — **POSTPONED** to Sprint 7 (new Accounting/Reports engine will be built from scratch)
- [ ] Pipeline Config in ControlPanel — **POSTPONED** (not yet prioritised)
- [ ] QA: full end-to-end test with a `sales_rep` account and a manager account
- [ ] `npm test`, `npm run lint`, `npm run build` all pass
- [ ] Deploy to staging; get feedback from QDS team before production push

---

## Postponed Items — Deprioritised Below Sprint 6

The following items were planned or in-progress but are formally deprioritised until the Sales Documents module (Sprint 6) is complete. They are NOT deleted — check them off when they are eventually built.

**Track A — Open Sprint 5 items (carry forward):**
- [ ] QA: full end-to-end test with a `sales_rep` account and a manager account
- [ ] `npm test`, `npm run lint`, `npm run build` all pass on the CRM modules
- [ ] Deploy to staging; QDS team feedback before production push
- [ ] Reports CRM section — deferred to Sprint 7's new accounting+reports engine
- [ ] Pipeline Config in ControlPanel — deferred until user requests it

**Track A — Deferred feature work:**
- [ ] `src/lib/events/crmEventHandlers.ts` — CRM WhatsApp event handlers (Sprint 4)
- [ ] WhatsApp template `crm_followup_due` — morning digest (Sprint 4)
- [ ] Sprint 2.5 Phase F — lead followers, @mentions, follower table (after Sprint 6)

**Track B — All "Do now" and "Do next" items** remain as listed in Track B → Section B2. They are deprioritised below Sprint 6/7/8 but the list stands unchanged.

---

## Sprint 6 — Sales Documents (Quotation → Sales Order → Invoice → Credit Note) ✅ COMPLETE 2026-06-30

**Goal**: The complete sales funnel, from initial quotation inside a deal through to a paid invoice with credit note support. Replaces the current stub `/invoices` page with a unified Invoicing module.

**Status note**: built across several sessions; this plan's detailed spec below is the original design and matches the shipped implementation closely, with these deviations:

- Route is `/sales` (+ `/sales/:type/:id` detail), not `/invoices` — the legacy `Invoices.jsx` (RMA service invoices, unrelated table) still owns `/invoices`, so reusing that path wasn't viable.
- Sales Order status model is richer than originally planned: `draft → sent → accepted → declined → confirmed → delivered → cancelled` (adds `sent`/`accepted`/`declined` so SOs run the same manager-approval workflow as Quotations and Invoices — see the Activities "approval pool" pattern in `CLAUDE.md`). Approving an SO now lands it directly in `delivered` with inventory reserved in one step — no separate "Confirm Order"/"Mark Delivered" clicks (a 2026-06-30 round-2 fix).
- A 14-item bug-fix pass on 2026-06-30 (post-ship QA) covered Activities search/columns, the Leads Converted tab, a Deal-activity due-date bug, the SO/Invoice approval-gate work above, a standalone Credit Note creation flow (not only invoice-bound), Credit Note ↔ invoice application as a payment, Credit Note ↔ RMA ticket auto-close, and the `OPP-` deal-code prefix (renamed from a colliding `QT-`). Full test checklist is in the "Sales Funnel Test Checklist" section near the end of this document.

> ⚠️ **Architecture Lock required before build starts.** Three decisions below (marked `[CONFIRM]`) must be confirmed by the user before any migration or code is written. They are each one-time choices with no cheap rollback.

### Document lifecycle

```
Lead → Deal ──► [Quotation on Deal] ──► Sales Order ──► Invoice
                       ↑                     ↑               ↑
            (Invoicing tab / standalone) (Invoicing tab) (Invoicing tab)
                                                             ↓
                                                       Credit Note
```

- A **Quotation** can be created from inside a Deal, or standalone from the Invoicing tab
- A **Sales Order** can be created by converting a Quotation, or standalone from the Invoicing tab
- An **Invoice** can be created by converting a Sales Order, or standalone from the Invoicing tab
- A **Credit Note** is always linked to a source Invoice (for RMA returns, rebates, discounts, or corrections)

### Architecture Lock Decisions — ✅ ALL CONFIRMED 2026-06-28

**[✅ CONFIRMED-6A] Separate tables**
Four separate tables (`quotations`, `sales_orders`, `crm_invoices`, `credit_notes`) instead of one unified table with a `doc_type` discriminator. Reason: each document has different columns (quotation has `validity_until`; invoice has `due_date`, `paid_at`, `void_reason`; credit note has `type`, `source_invoice_id`, `affects_inventory`), different status CHECK constraints, and different RLS write rules. The "All Documents" Invoicing tab uses a `v_sales_documents` Postgres VIEW that UNIONs the four tables.

**[✅ CONFIRMED-6B] Quotation as its own table (not embedded on the deal)**
The deal's current `product_lines` JSONB evolves into a separate `quotations` table with a nullable `deal_id` FK. When a quotation is created from a Deal, a `quotations` row is inserted and linked (`deal_id = deal.id`). The Deal Detail page's "Product Lines" tab becomes the "Quotation" tab showing that row. Standalone quotations from the Invoicing tab have `deal_id = NULL`. This is required because quotations can be created independently of deals.

**[✅ CONFIRMED-6C] Independent code per document type — prefix-rename scheme DROPPED**
The original plan (QT-12345678 → SO-12345678 → INV-12345678 with a shared base number) is dropped. Research across Odoo, Zoho, QuickBooks, and EU VAT law confirms: (1) one quotation can generate multiple sales orders (partial acceptance); one SO can be invoiced in multiple invoices; sharing a base number breaks immediately in these cases; (2) an invoice's sequential number must be unique within its series — a shared base violates the auditability requirement. Use independent codes per type:

| Document | Code format | Counter type | Assigned when |
|---|---|---|---|
| Quotation | `QT-XXXXXXXX` (8 random digits) | Random, server-side RPC | On row create |
| Sales Order | `SO-XXXXXXXX` (8 random digits) | Random, server-side RPC | On row create |
| Invoice | `INV-YYYY-NNNNN` (year + 5-digit sequential) | Sequential, gapless, locked | On `post()` transition only — never on draft create |
| Credit Note | `CN-YYYY-NNNNN` (year + 5-digit sequential) | Sequential, gapless, locked | On `issue()` transition only — never on draft create |

Traceability between documents comes from FK columns (`sales_orders.quotation_id`, `crm_invoices.so_id`, `credit_notes.invoice_id`) and a visible "Created from QT-XXXXXXXX" reference on each document. A `document_sequences` table (or Postgres sequence wrapped in a locked RPC) provides the gapless counter for INV- and CN- codes; a rolled-back draft invoice never burns a number.

### Status workflows (research-validated against Odoo/Zoho/QuickBooks/SAP B1)

| Document | Statuses | Notes |
|---|---|---|
| Quotation | `draft` → `sent` → `accepted` \| `declined` \| `expired` \| `cancelled` | `expired` is set by a scheduled job on `validity_until` passing, never by the user. Only `accepted` unlocks "Convert to Sales Order". |
| Sales Order | `draft` → `confirmed` → `delivered` \| `cancelled` | Lines lock on `confirmed`. Cancelling releases all inventory reservations. `reset_to_draft` allowed only if no downstream invoice exists. |
| Invoice | `doc_status`: `draft` → `posted` → `cancelled` | Lines lock on `posted`. Never edit a posted invoice — correct via credit note only. |
| Invoice | `payment_status`: `unpaid` → `partial` → `paid` \| `reversed` | **Separate field** from `doc_status`. Derived from sum of payments vs total — never manually set. |
| Credit Note | `draft` → `issued` → `applied` \| `voided` | Sequential CN- number assigned on `issued` only. `applied` when `remaining_balance = 0`. |

> **WHY TWO INVOICE STATUS FIELDS**: conflating document lifecycle (editability) with payment state (collections) into one column forces impossible combinations ("cancelled but paid"), breaks AR reporting, and makes partial payments unrepresentable. Odoo's `account.move` uses `state` + `payment_state` exactly this way — it is the single most important schema decision in this sprint.

### Credit Note types (drives inventory behavior)

| Type | Inventory effect | Use case |
|---|---|---|
| `rma_return` | ✅ Restores stock (per-line toggle) | Defective/wrong product returned via RMA ticket |
| `rebate` | ❌ No stock effect | Volume rebate, loyalty credit |
| `discount` | ❌ No stock effect | Post-invoice discount, goodwill concession |
| `correction` | ❌ No stock effect | Billing error (wrong qty/price), duplicate charge |

The `type` column is a first-class enum. It drives whether the Restock step appears in the UI and whether the `affects_inventory` flag is set. A `rebate` CN can never accidentally move stock.

### Shared document layout (all 4 documents share this structure)

**Header section**: Document number · Document date · Customer (DB-linked, required on SO/Invoice; required on Quotation too when linked to a deal; optional for standalone quotation draft) · Sales rep · Reference / Customer PO# · Type-specific date field (Quotation: `validity_until`; Sales Order: `delivery_date`; Invoice: `due_date`; Credit Note: `issued_date`) · Payment terms (SO, Invoice only)

**Line items** (JSONB array — always array, never object, per CONSTITUTION rule):
```
Line # | Product (DB-linked; free-form name allowed on Quotation only — product_id nullable)
       | Description | Qty | Unit Price | Discount % | Tax % | Line Subtotal
```

**Footer**: Subtotal · Total Discount · Total Tax · **Grand Total**

**Key rules**:
- `product_id` is **nullable** on Quotation lines (free-form / back-to-back orders allowed)
- `product_id` is **NOT NULL** on Sales Order and Invoice lines — enforced at the Convert step. Any free-form Quotation line with no `product_id` **must be saved as a new product** in the catalog before the SO is created; the conversion step surfaces a "New product detected" confirmation modal with a pre-filled create-product form
- `customer_id` is **NOT NULL** on Sales Orders and Invoices — enforced at the Convert step

**Actions bar**: Preview PDF · Download PDF · Convert to next stage · Send · Cancel / Void

### Inventory rules (two-stage model)

| Stage | Action | On serialised units (`inventory_units`) | On parts (`parts`) |
|---|---|---|---|
| Quotation | Any | **No effect** | **No effect** |
| Sales Order — `confirm()` | Reserve | Flip `reservation_status` to `'reserved'`, stamp `reserved_by_doc_id` via `SELECT … FOR UPDATE SKIP LOCKED` | `reserved_quantity += qty`, checked under row lock |
| Sales Order — `cancel()` | Release reservation | Flip reserved units back to `'available'`, clear `reserved_by_doc_id` | `reserved_quantity -= qty` |
| Invoice — `post()` | Deliver + release | Transition units to `'delivered'`; `reservation_status` clears | `quantity -= qty AND reserved_quantity -= qty` |
| Invoice — direct (no SO) | Reserve + deliver atomically | Pick available units FOR UPDATE, move straight to `'delivered'` in one RPC | `quantity -= qty` with available check (no intermediate reservation) |
| Credit Note (`rma_return`) — `issue()` | Restore stock | Return units to `'available'` (or `'active_rma'` if damaged) | `quantity += qty` |
| Credit Note (rebate/discount/correction) — `issue()` | **No stock effect** | No inventory RPC called | No inventory RPC called |

**Overselling guard**: `salesOrders.confirm()` and `crmInvoices.post()` (direct path) must check **available** (`on_hand − reserved`), never on-hand alone. If any line is short, abort the whole operation and return per-line shortfall detail to the UI for display.

**Stock moves ledger** (`stock_moves` table): every reserve/deliver/release/restore writes an append-only row: `(ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email, created_at)`. This is the audit trail and the reconciliation source if counters drift.

### Step 1 — Constants + Zod schemas

- [ ] Add to `src/lib/constants.ts`:
  - `QUOTATION_STATUS` (`draft | sent | accepted | declined | expired | cancelled`)
  - `SALES_ORDER_STATUS` (`draft | confirmed | delivered | cancelled`)
  - `INVOICE_DOC_STATUS` (`draft | posted | cancelled`)
  - `INVOICE_PAYMENT_STATUS` (`unpaid | partial | paid | reversed`)
  - `CREDIT_NOTE_STATUS` (`draft | issued | applied | voided`)
  - `CREDIT_NOTE_TYPE` (`rma_return | rebate | discount | correction`)
- [ ] Add Zod schemas to `src/lib/schemas.ts`:
  - `quotationLineSchema` — `product_id` optional/nullable (free-form allowed)
  - `salesOrderLineSchema` — `product_id` required (validated at convert step)
  - `invoiceLineSchema` — same as SO
  - `creditNoteLineSchema` — `product_id` optional, `restock: boolean`
- [ ] Full `en.json` + `ar.json` for all new status labels

### Step 2 — DB migrations (apply in order, each idempotent)

- [ ] `20260XXX_document_sequences.sql` — `document_sequences(seq_type text PK, last_value int, year int)` with `nextval_for_type(seq_type text)` SECURITY DEFINER RPC that uses `SELECT ... FOR UPDATE` to guarantee gapless sequential numbers. Seed rows: `('invoice', 0, EXTRACT(YEAR FROM NOW()))`, `('credit_note', 0, EXTRACT(YEAR FROM NOW()))`. This is the locked counter for INV- and CN- codes.
- [ ] `20260XXX_stock_moves.sql` — `stock_moves` append-only ledger table (see schema above). RLS: staff read own-related, manager+ read all, INSERT only via server-side RPCs (SECURITY DEFINER).
- [ ] `20260XXX_quotations.sql` — `quotations` table: `id`, `qt_code text UNIQUE NOT NULL`, `deal_id uuid REFERENCES deals(id) ON DELETE SET NULL NULLABLE`, `customer_id uuid REFERENCES customers(id) NOT NULL`, `status` (CHECK constraint), `line_items jsonb NOT NULL DEFAULT '[]'`, `subtotal numeric`, `discount_amount numeric DEFAULT 0`, `tax_amount numeric DEFAULT 0`, `total numeric`, `validity_until date`, `payment_terms text`, `reference_po text`, `notes text`, `assigned_rep text` (email), `created_by text` (email), `created_at timestamptz`. RLS: sales_rep read own + deal's rep, manager+ all; write: manager+ or owner.
- [ ] `20260XXX_sales_orders.sql` — `sales_orders` table: `id`, `so_code text UNIQUE NOT NULL`, `quotation_id uuid REFERENCES quotations(id) NULLABLE`, `customer_id uuid REFERENCES customers(id) NOT NULL`, `status` (CHECK), `line_items jsonb NOT NULL DEFAULT '[]'`, `subtotal numeric`, `discount_amount numeric DEFAULT 0`, `tax_amount numeric DEFAULT 0`, `total numeric`, `delivery_date date`, `payment_terms text`, `reference_po text`, `notes text`, `assigned_rep text`, `created_by text`, `created_at timestamptz`, `confirmed_at timestamptz`, `delivered_at timestamptz`. RLS: sales_rep read own, manager+ all; write: manager+.
- [ ] `20260XXX_crm_invoices.sql` — `crm_invoices` table: `id`, `inv_code text UNIQUE` (NULL until posted — assigned by RPC), `so_id uuid REFERENCES sales_orders(id) NULLABLE`, `customer_id uuid REFERENCES customers(id) NOT NULL`, `doc_status text CHECK(... draft/posted/cancelled)`, `payment_status text CHECK(... unpaid/partial/paid/reversed) DEFAULT 'unpaid'`, `line_items jsonb NOT NULL DEFAULT '[]'`, `subtotal numeric`, `discount_amount numeric DEFAULT 0`, `tax_amount numeric DEFAULT 0`, `total numeric`, `amount_paid numeric DEFAULT 0`, `due_date date`, `payment_terms text`, `reference_po text`, `notes text`, `void_reason text`, `assigned_rep text`, `created_by text`, `created_at timestamptz`, `posted_at timestamptz`, `paid_at timestamptz`. RLS: sales_rep read own, manager+ all; write: manager+.
- [ ] `20260XXX_credit_notes.sql` — `credit_notes` table: `id`, `cn_code text UNIQUE` (NULL until issued), `type text CHECK(... rma_return/rebate/discount/correction)`, `source_invoice_id uuid REFERENCES crm_invoices(id) NULLABLE`, `source_invoice_number text` (denormalized for PDF), `ticket_id uuid NULLABLE` (for `rma_return` type), `customer_id uuid REFERENCES customers(id) NOT NULL`, `status text CHECK(... draft/issued/applied/voided)`, `line_items jsonb NOT NULL DEFAULT '[]'`, `subtotal numeric`, `tax_amount numeric DEFAULT 0`, `total numeric`, `applied_amount numeric DEFAULT 0`, `remaining_balance numeric`, `reason text NOT NULL`, `affects_inventory boolean GENERATED ALWAYS AS (type = 'rma_return') STORED`, `restock_status text CHECK(... not_applicable/pending/restocked) DEFAULT 'not_applicable'`, `assigned_rep text`, `created_by text`, `created_at timestamptz`, `issued_at timestamptz`. RLS: sales_rep read, manager+ write.
- [ ] `20260XXX_credit_note_applications.sql` — `credit_note_applications(id, credit_note_id FK, invoice_id FK, amount_applied numeric, applied_date timestamptz, applied_by text)`. Trigger updates `credit_notes.applied_amount` and flips `status` to `'applied'` when `remaining_balance` hits 0.
- [ ] `20260XXX_inventory_reservation.sql` — adds to `inventory_units`: `reservation_status text CHECK('available','reserved','delivered') DEFAULT 'available'`, `reserved_by_doc_type text`, `reserved_by_doc_id uuid`, `reserved_at timestamptz`, `reserved_by_email text`. Adds to `parts`: `reserved_quantity integer NOT NULL DEFAULT 0 CHECK(reserved_quantity >= 0)`. Creates RPCs: `reserve_units(doc_type, doc_id, product_id, qty, actor_email)` and `release_units(doc_type, doc_id, actor_email)` and `deliver_units(doc_type, doc_id, actor_email)` and `restore_units(doc_type, doc_id, actor_email)` — all SECURITY DEFINER, all write to `stock_moves` ledger.
- [ ] `20260XXX_sales_documents_view.sql` — `CREATE OR REPLACE VIEW v_sales_documents AS` SELECT from all four tables UNIONed with a `doc_type text` discriminator column — powers the "All" tab in the Invoicing page without duplicating queries.
- [ ] All migrations: idempotent (`IF NOT EXISTS`, `DROP ... IF EXISTS`), named with correct date prefix.

### Step 3 — API modules

- [ ] `src/api/db/quotations.ts` — `QuotationRow` type; `list()`, `get()`, `create()` (generates QT- code via RPC, links `deal_id` if provided), `update()` (draft only), `markSent()`, `markAccepted()`, `markDeclined()`, `markExpired()`, `cancel()`, `convertToSalesOrder()` (creates SO row + validates/promotes free-form lines + returns the new SO id)
- [ ] `src/api/db/salesOrders.ts` — `SalesOrderRow` type; `list()`, `get()`, `create()`, `update()` (draft only), `confirm()` (validates all `product_id` NOT NULL + runs `reserve_units` RPC per line), `markDelivered()` (runs `deliver_units` RPC), `cancel()` (runs `release_units` RPC), `convertToInvoice()` (creates Invoice row with `doc_status: 'draft'`, links `so_id`)
- [ ] `src/api/db/crmInvoices.ts` — `CrmInvoiceRow` type; `list()`, `get()`, `create()` (draft, no inv_code yet), `update()` (draft only), `post()` (calls `nextval_for_type('invoice')` RPC to assign `inv_code`, locks lines, runs `deliver_units` if no upstream SO; transitions `doc_status → 'posted'`), `recordPayment(amount)` (updates `amount_paid`, derives `payment_status`), `void_(reason)` (requires a credit note — sets `doc_status: 'cancelled'`, must NOT be called directly without a linked credit note), `markReversed()` (called internally when a credit note is fully applied)
- [ ] `src/api/db/creditNotes.ts` — `CreditNoteRow` type; `create()` (draft; optionally `fromInvoice(invoiceId)` factory pre-fills lines), `update()` (draft only), `issue()` (assigns CN- code via `nextval_for_type('credit_note')` RPC, posts AR reduction, triggers `restore_units` RPC only when `type === 'rma_return'`), `applyToInvoice(invoiceId, amount)` (inserts into `credit_note_applications`, updates `applied_amount` + `remaining_balance`), `void()`
- [ ] Update `src/api/db/index.ts` to export all new Row types and modules

### Step 4 — Quotation on Deal Detail

- [ ] Replace the "Product Lines" tab in `DealDetail.jsx` with a "Quotation" tab
- [ ] On first open (no quotation row exists for this deal), show an "Add Quotation" button that calls `quotations.create({ deal_id: deal.id, customer_id: deal.customer_id, ... })`
- [ ] If a quotation exists, show the shared `SalesDocumentForm` component (see Step 5) pre-loaded with the quotation row
- [ ] Quotation status stepper at the top: Draft → Sent → Accepted / Declined / Expired / Cancelled
- [ ] "Convert to Sales Order" button — active only on `draft`/`accepted` status; triggers `quotations.convertToSalesOrder()`. If any free-form lines (null `product_id`) exist, shows a per-line "New Product" confirmation modal before converting
- [ ] "Download PDF" button — calls the existing RMA PDF engine with the Quotation template
- [ ] All strings in `en.json` + `ar.json`

### Step 5 — Shared `SalesDocumentForm` component

`src/components/SalesDocumentForm.jsx` — used by all four document types and the detail/edit pages. Props: `docType` (`'quotation'|'sales_order'|'invoice'|'credit_note'`), `doc` (the row), `onUpdate(fields)`, `readOnly`.

- [ ] **Header section**: renders all shared fields (customer search, rep, reference/PO#, type-specific date field) + a read-only document number when set
- [ ] **Line item editor**: add row / remove row / reorder (drag or up/down arrows). Each row: product search (DB-linked for all types; free-form override for quotation only — `product_id` nullable). Columns: Product | Description | Qty | Unit Price | Discount % | Tax % | Subtotal (auto-computed). Bottom row: Grand total
- [ ] **Footer**: Subtotal · Total Discount · Total Tax · Grand Total — all auto-computed, never hand-edited
- [ ] Free-form product input: visible only when `docType === 'quotation'`; on blur, checks if the text matches an existing product name; if no match, shows a "New product — will be saved on conversion" indicator
- [ ] When `readOnly`, all fields are display-only; only action buttons are active

### Step 6 — New Invoicing page (`/invoices` replacement)

- [ ] **5-tab layout**: All · Quotations · Sales Orders · Invoices · Credit Notes
- [ ] Same design pattern as Activities page: search bar (`max-w-md`, `shadow-sm`), collapsible Filters panel, sortConfig persisted to `safeStorage`, canonical pagination
- [ ] Per-tab list columns:

  | Tab | Columns |
  |---|---|
  | All | Type badge · Doc# · Customer · Rep · Date · Total · Status |
  | Quotations | QT# · Customer · Rep · Date · Validity · Total · Status |
  | Sales Orders | SO# · Customer · Rep · Date · Delivery · Total · Status |
  | Invoices | INV# · Customer · Rep · Issue Date · Due Date · Total · Payment Status · Doc Status |
  | Credit Notes | CN# · Type · Customer · Source Invoice · Date · Total · Remaining · Status |

- [ ] Per-tab filter options: Status multi-select · Assigned Rep · Date range (created_at or type-specific date)
- [ ] Bulk actions: bulk cancel (quotations / draft SOs), bulk delete (drafts, manager+ only), bulk export
- [ ] Create buttons: "New Quotation", "New Sales Order", "New Invoice", "New Credit Note" — each opens a create-from-scratch modal (standalone path)
- [ ] Row click → opens the document detail/edit page
- [ ] Route: `/invoices` (replaces the current stub component)
- [ ] All strings in `en.json` + `ar.json`

### Step 7 — Document detail/edit page

Shared route pattern: `/invoices/quotation/:id`, `/invoices/so/:id`, `/invoices/invoice/:id`, `/invoices/cn/:id` (or a single `/invoices/:docType/:id` dynamic route).

- [ ] Renders `SalesDocumentForm` in edit mode (draft) or read-only mode (posted/issued/delivered)
- [ ] Status stepper at top — type-specific (Quotation stepper vs SO stepper vs Invoice dual-status vs CN stepper)
- [ ] Invoice detail: both `doc_status` stepper and `payment_status` indicator (e.g. "Posted · Partially Paid 40%" as two separate visual elements)
- [ ] Conversion action buttons with status guards:
  - Quotation → SO: enabled on `draft|accepted`; blocked on `cancelled|expired|declined`
  - SO → Invoice: enabled on `confirmed|delivered`; blocked on `cancelled`
  - Invoice → Credit Note: enabled on `posted` (any `payment_status`)
- [ ] "Download PDF" button on all types
- [ ] Credit Note creation: opens an inline modal pre-filled from the invoice's lines (user can reduce qtys per line)
- [ ] "Linked from" trail: e.g. "Quotation QT-XXXXXXXX" on a SO detail page, with a clickable link
- [ ] All strings in `en.json` + `ar.json`

### Step 8 — PDF templates (one per document type)

- [ ] Reuse the existing RMA ticket PDF engine (find and extend the existing `exportPDF` / `generatePDF` helper in the codebase)
- [ ] Shared layout function with a `docType` discriminator: same branding header (company logo from `branding` settings, address, contact), same line-item table structure, same footer totals
- [ ] Per-type title and type-specific fields:
  - Quotation PDF: "Quotation", validity date, "This quotation is valid until [date]" footer note
  - Sales Order PDF: "Sales Order", delivery date, confirmation number
  - Invoice PDF: "Tax Invoice", due date, payment terms, bank/payment details section
  - Credit Note PDF: "Credit Note", original invoice reference ("Credit against INV-2026-00042"), reason
- [ ] RTL/Arabic support: same `dir` + `t()` passing convention as existing PDF code
- [ ] Company branding: logo, address, VAT/tax registration number from `branding` settings

### Step 9 — Inventory integration (wires Step 2 RPCs into API methods)

- [ ] `salesOrders.confirm()` calls `reserve_units` RPC for each line; if any line returns a shortfall, throws and surfaces per-line shortage in the UI ("Product X: need 3, only 1 available")
- [ ] `salesOrders.cancel()` calls `release_units` RPC; all reserved units return to `'available'`
- [ ] `crmInvoices.post()` on the direct path (no upstream SO) calls `deliver_units` RPC in one atomic step (reserve + decrement combined)
- [ ] `crmInvoices.post()` on the SO-conversion path calls `deliver_units` to release the reservation and decrement
- [ ] `creditNotes.issue()` on `type === 'rma_return'` calls `restore_units` RPC for lines with `restock: true`; lines with `restock: false` (scrapped/damaged) get no stock RPC
- [ ] Guard: `invoice.void()` is never called directly without an associated credit note. Instead, `creditNotes.issue()` internally calls `invoice.markReversed()` (when the credit fully covers the invoice)

### Sprint 6 gate

- [x] All DB migrations applied and verified in Supabase SQL Editor, no errors (confirmed by user 2026-06-30, through migration `20260730_crm_customer_ledger_view.sql`)
- [x] `npm test`, `npm run lint`, `npm run build` all pass (277/277 tests, 0 lint errors, build green — re-verified 2026-06-30 after the round-2 bug-fix pass)
- [x] Architecture Locks CONFIRM-6A, CONFIRM-6B, CONFIRM-6C signed off before any code was written
- [ ] Full click-through (both paths): Deal → Quotation tab → Convert to SO → Convert to Invoice → PDF; standalone from Invoicing tab for each document type — **manual QA pending**, tracked in the Sales Funnel Test Checklist below
- [ ] Free-form product promotion: create a quotation with a non-DB product name → convert to SO → confirm the "new product" modal → verify the product now exists in the catalog — **manual QA pending**
- [ ] Inventory cycle: SO confirm reserves units → Invoice post decrements → Credit Note (rma_return) restores; verify `stock_moves` ledger rows for each step — **manual QA pending**
- [ ] Invoice code gapless check: delete two draft invoices, post a third → verify INV- sequence has no gap — **manual QA pending**
- [ ] Credit note applied: issue a CN against an invoice, apply it → verify `remaining_balance` reaches 0 and status flips to `applied` — **manual QA pending**

---

## Sprint 7 — Accounting (Customer Financial Tracking) ✅ COMPLETE (v1) 2026-06-30

**Goal**: Customer payment tracking against the sales funnel — explicitly **not** a full ERP/GL system. Confirmed scope with the user before building (via `AskUserQuestion`): one payment can be split across multiple open invoices; this round covers the payments ledger, customer financial tab, AR aging report, and customer credit limits; lives at a new top-level `/accounting` page (payments ledger + aging) with the customer statement as a drill-down on `CustomerDetails.jsx`.

**What was actually built** (see `CLAUDE.md` → "Sales Documents & Accounting" for the architecture):

- `payments` + `payment_applications` tables (migration `20260727_crm_payments.sql`) — mirrors the `credit_notes`/`credit_note_applications` pattern exactly (same RLS tiers, same trigger-syncs-balance pattern)
- Gapless `PAY-YYYY-NNNNN` codes via the existing `nextval_for_type()` RPC (`20260728_crm_payment_sequence.sql`)
- `customers.credit_limit` — soft warning only, never enforced/blocking (`20260729_crm_customer_credit_limit.sql`)
- `v_customer_ledger` view — signed invoice/credit-note/payment feed, same UNION-of-tables shape as `v_sales_documents` (`20260730_crm_customer_ledger_view.sql`)
- `src/api/db/payments.ts`, `src/api/db/customerLedger.ts` — new API modules
- New `/accounting` page: Payments ledger tab + AR Aging tab (Current/31-60/61-90/90+ vs. `due_date`)
- New "Billing" tab on `CustomerDetails.jsx`: chronological statement with running balance + credit limit field/warning
- The existing invoice-page "Record Payment" button now routes through the new ledger (`payments.record()`) instead of mutating `crm_invoices.amount_paid` directly, so every payment recorded anywhere is tracked

**Deliberately deferred / out of scope for v1** (do not add without asking the user first):

- No general ledger / journal entries / double-entry bookkeeping
- No automated reversal of `amount_paid` when a payment is voided — voiding is blocked once a payment has any applications (same precedent as `creditNotes.void_()`)
- No multi-currency, no bank reconciliation
- No customer statement PDF (the original placeholder scope above) — only the in-app Billing tab statement
- No dashboard AR widgets (Total AR outstanding / overdue / cash collected) on the main Dashboard
- No DSO/collections-effectiveness reporting, no automated payment reminders, no hard enforcement of credit limits
- The system-wide `/reports` CRM section mentioned in the original placeholder scope was not built as part of this sprint

---

## Sprint 8 — Inventory Redesign

**Goal**: Replace the current Inventory page with a clean, sprint-6-integrated architecture that tracks on-hand, reserved, and available stock across products and parts.

**Status**: ⏳ Blocked on Sprint 6 inventory integration (Step 9) — user will provide a detailed spec before this sprint starts.

**Known scope from user's description** (placeholder until detailed spec is provided):
- New page from scratch — current `src/pages/Inventory/` folder deleted, new page starts clean
- List view: all products with real-time on-hand / reserved / available counts (derived from `inventory_units` row states and `parts.quantity` + `parts.reserved_quantity`)
- Sub-warehouses: create child locations under the main warehouse; units assignable to sub-location (extends the existing `warehouses` table with a `parent_id` nullable FK)
- Stock auto-adjusted by: Sales Order confirm → Invoice post → Credit Note issue (already live from Sprint 6 Step 9 — this sprint only surfaces it in the new UI)
- RMA units: same page, filtered view (not a separate page); `active_rma` status units visible in a dedicated column or filter
- Search bar + Filters + sort + pagination — same design pattern as Activities/Invoicing pages

**Architecture dependencies from Sprint 6**:
- `stock_moves` ledger (Sprint 6 Step 2) must be live — Sprint 8 will surface this as a movement history timeline per product/unit
- `inventory_units.reservation_status` + `parts.reserved_quantity` columns must be live

---

## Sales Funnel Test Checklist (Sprint 6 round-2 fixes + Sprint 7 Accounting v1)

Manual QA checklist covering the 2026-06-30 work: the 14-item sales-funnel bug-fix pass on top of Sprint 6, plus Sprint 7 (Accounting v1). Run this top to bottom before signing off the Sprint 6 / Sprint 7 gates above. Migrations required first, applied in order (confirmed done by user 2026-06-30): `20260726_crm_deal_code_prefix_opp.sql` → `20260727_crm_payments.sql` → `20260728_crm_payment_sequence.sql` → `20260729_crm_customer_credit_limit.sql` → `20260730_crm_customer_ledger_view.sql`.

| # | Stage | Test | Expected Result |
|---|-------|------|------------------|
| 1 | Activities | Search by a lead/deal/QT/SO/INV/CN code | Matching activity rows appear |
| 2 | Activities | Check the activity table | "Created" column shows alongside Due Date/Completed |
| 3 | Activities | Open an invoice-approval card raised after SO→Invoice conversion | Card shows the linked SO's code as the reference (invoice has no `inv_code` yet at draft time) |
| 4 | Activities | Approve/reject a Quotation and a Sales Order approval card | Both still route correctly |
| 5 | Leads | Convert a lead to a deal | Lead disappears from main tab, appears in new "Converted" tab |
| 6 | Leads | Open the Converted tab | Status field, source field, checkboxes stay locked/read-only |
| 7 | Deal / Pipeline | On a Deal, click "Schedule Activity" and leave due date empty | Submit is blocked / validation error shown |
| 8 | Deal / Pipeline | Schedule a Deal activity with a due date | Activity appears on the Activities page (previously never appeared) |
| 9 | Deal / Pipeline | Create a new deal directly (not via convert) | Generated code uses `OPP-` prefix |
| 10 | Deal / Pipeline | Convert a Lead to a Deal via the `crm_convert_lead` RPC | Generated deal code also uses `OPP-` (server-side path) |
| 11 | Deal / Pipeline | View a deal created before the migration | Old `QT-` code is backfilled to `OPP-` |
| 12 | Quotation | Create, send, and accept a quotation | Unaffected — flow works exactly as before |
| 13 | Quotation → SO | Convert an accepted quotation to a Sales Order | SO created with line items carried over, `so_code` assigned |
| 14 | Sales Order | Send an SO, then approve it from the Activities approval pool | SO lands directly in `delivered` with inventory reserved — no intermediate clicks |
| 15 | Sales Order | Open any SO at any status | No "Confirm Order" or "Mark Delivered" button appears anywhere |
| 16 | Sales Order | Approve an SO where a line item exceeds available stock | Approval fails with an error; SO stays at `sent` |
| 17 | Sales Order | Cancel an SO before it's invoiced | Status → `cancelled`, any reservation released |
| 18 | Sales Order | View a `delivered` SO | "Download PDF" is available |
| 19 | SO → Invoice | Convert a delivered SO to an invoice a second time | Blocked — "already converted" error |
| 20 | Invoice | Convert SO → Invoice | New invoice shows "Awaiting approval in Activities"; no "Post Invoice" button visible |
| 21 | Invoice | Approve the invoice from the Activities approval pool | Invoice becomes `posted`, `inv_code` assigned, linked SO inventory decremented |
| 22 | Invoice | Reject an invoice approval instead | Invoice is voided |
| 23 | Invoice | Open a posted invoice | No "Create Credit Note" button present |
| 24 | Invoice | Record a payment / void a posted invoice | Both still work as before |
| 25 | Credit Note | Open Sales Documents → "+ New" | "New Credit Note" option is present |
| 26 | Credit Note | Submit the new CN modal with no customer / no reason / no line items | Submission blocked until all three are filled |
| 27 | Credit Note | Create a standalone CN with no invoice link, then issue it | `cn_code` assigned, status → `issued` |
| 28 | Credit Note | Create a standalone CN linked to an open invoice, save, then issue | Linked invoice's `amount_paid`/`payment_status` updates automatically on issue |
| 29 | Credit Note | Issue a CN whose amount is less than the invoice's remaining balance | Invoice `payment_status` → `partial` |
| 30 | Credit Note | Issue a CN whose amount covers the full remaining balance | Invoice `payment_status` → `paid` |
| 31 | Credit Note | Check "Link to invoice" before selecting a customer | Checkbox disabled until a customer is chosen |
| 32 | Credit Note | Link to a customer with no open invoices | "No open invoices" message shown instead of an empty dropdown |
| 33 | Credit Note | Void a draft or issued CN | Still works (status → `voided`) |
| 34 | RMA Ticket → CN | Open an RMA ticket with no linked CRM customer | "Issue Credit Note" button is hidden |
| 35 | RMA Ticket → CN | Open an open ticket with a linked customer | "Issue Credit Note" button is visible |
| 36 | RMA Ticket → CN | Fill in the CN form from the ticket and submit | CN is created **and** issued in one step |
| 37 | RMA Ticket → CN | After issuing | Ticket status auto-updates to `Closed` |
| 38 | RMA Ticket → CN | Check the ticket's activity/history log | Entry logged: `credit_note_created` with the CN code + reason |
| 39 | RMA Ticket → CN | Re-open the same ticket afterward | "Issue Credit Note" button no longer shows |
| 40 | i18n | Switch app language to Arabic | Every new string renders translated, no raw keys, RTL layout intact |
| 41 | Build | `npm test -- --run`, `npm run lint`, `npm run build` | 277/277 tests pass, 0 lint errors, build succeeds |
| 42 | Accounting | Open the sidebar nav | New "Accounting" item appears, routes to `/accounting` |
| 43 | Accounting → Payments | From a posted invoice, "Record Payment," pick a method, submit | `payments` + `payment_applications` rows created; invoice `amount_paid`/`payment_status` updates |
| 44 | Accounting → Payments | From `/accounting`, "+ Record Payment," pick a customer with 2+ open invoices, "Auto-allocate" | Suggests oldest-due-date-first allocation across invoices, editable per row |
| 45 | Accounting → Payments | Submit a payment where the amount exceeds the sum of allocations | Leftover shows as `unapplied_amount` on the payment row |
| 46 | Accounting → Payments | Try to void a payment that has at least one allocation | Blocked with an error |
| 47 | Accounting → Aging | Open the AR Aging tab with several customers carrying overdue invoices | Outstanding totals bucketed correctly into Current/31-60/61-90/90+ |
| 48 | Customer Details → Billing | Open a customer with invoices, a credit note, and a payment on file | "Billing" tab shows all three in date order with a correct running balance |
| 49 | Customer Details → Billing | Set a Credit Limit on a customer's profile, save | Field persists; reopen and confirm it's still set |
| 50 | Customer Details → Billing | Set a credit limit below the customer's outstanding balance | Billing tab shows a red "over credit limit" warning (display-only) |
| 51 | i18n | Switch to Arabic, visit `/accounting` and a customer's Billing tab | All new strings translated, no raw keys |
| 52 | Build | `npm test -- --run`, `npm run lint`, `npm run build` | 277/277 tests pass, 0 lint errors, build succeeds (Accounting v1) |

---

# TRACK B — System-Wide Module Upgrades (Odoo Benchmark)

**Method**: Odoo 19 Community source (`D:\odoo-19.0`, LGPLv3) read module-by-module as a reference architecture, never copied. Every "current state" claim was verified against the live myRMA codebase (file:line cited), not assumed from documentation.

**Philosophy**: preserve myRMA's existing architecture, schema, business logic, UI identity, and workflow philosophy. Odoo is a benchmark, not a blueprint — every recommendation augments what exists, none propose replacing a working module. "No change" is a valid, common conclusion below. A few "beyond Odoo" ideas are included where myRMA already has infrastructure Odoo doesn't (WhatsApp, PWA).

## Section B0 — Pre-existing gaps found during the audit (not Odoo-related)

Surfaced while verifying current-state ground truth — not comparisons to Odoo, just inconsistencies already in the live codebase.

| # | Finding | File | Risk |
|---|---|---|---|
| 1 | `INVOICE_STATUS` constant doesn't include `'void'`, but `Invoices.jsx` references it as a real status | `src/lib/constants.ts`, `src/pages/Invoices.jsx:827,981` | Type-safety gap |
| 2 | Custom Fields engine is fully built (CRUD, 6 field types, generic `entity_type`) but **not consumed anywhere** | `src/pages/cp/CustomFields.jsx`, `system.ts:176-212` | Dead feature |
| 3 | SLA `pauseOnHold` flag exists and is shown in the admin UI but is **never read** anywhere | `system.ts:322-359` | Misleading admin UI |
| 4 | SLA breach detection is fully manual — due date computed once at creation, nothing flags an active breach | `TicketForm.jsx:529-534` | "Due date display" only, not real SLA enforcement |
| 5 | Parts stock decrement on ticket-attach is synchronous, unguarded — no transaction, no floor check | `inventory.ts:371-391` | Could go negative under concurrent edits |
| 6 | Webhook delivery has no log, no retry, silently swallows failures | `system.ts:285` | A dead endpoint vanishes with zero visibility |
| 7 | Customer duplicate detection exists only in bulk CSV import, not the single "Add Customer" modal | `Customers/index.jsx:645-694` vs `_modals.jsx` | Easy to manually create a duplicate the import path would have caught |
| 8 | Time-entry "timer" fields (`started_at`/`ended_at`) exist on the schema but no start/stop UI handler was found | `TicketDrawer.jsx:50-150` | Possibly dead/unfinished — needs confirmation before touching |

## Section B1 — Module Comparisons

### B1.1 RMA Tickets
**Current**: 7-status workflow, product-level `warranty_status` (doesn't touch billing), parts via real join table, manual time entries, 4 resolution types, comments/timeline already built.
**Odoo (`repair`)**: parts-availability traffic light (available/expected/late); warranty boolean auto-zeroes price; `schedule_date` with relative-date quick filters; add/remove/scrap parts categorization.
**Missing**: no warranty→billing link; no parts-readiness indicator; SLA due date with no breach alerting; no Today/Overdue quick filters.

| Improvement | Complexity | Now/Later |
|---|---|---|
| Warranty status auto-zeroes invoice/resolution amount (UI default, overridable) | Low | Now |
| Parts-readiness badge on ticket list/drawer (derived, no schema change) | Low | Now |
| SLA breach alerting (scheduled check + existing notification system) | Medium | Later |
| Today/Overdue quick filter chips on ticket list | Low | Now |

**Beyond Odoo**: "customer approves warranty exception via WhatsApp reply" — reuses existing `notification_queue` + webhook infra, a genuine differentiator. Idea only.

### B1.2 Inventory
**Current**: fully serialized model (one row per physical unit — stronger starting point than Odoo's default bulk model for this use case). Flat warehouse list. Transfer = direct field mutation, no reservation state. No serial duplicate detection.
**Odoo (`stock`)**: quant model separating on-hand vs reserved; location hierarchy with parent-path indexing; serial duplicate detection; move-chaining for audit trail.
**Missing**: no reservation concept (transfer race risk); no serial duplicate detection.

| Improvement | Complexity | Now/Later |
|---|---|---|
| Serial duplicate check (query/constraint flagging a serial assigned to >1 row) | Low | Now |
| `reserved_by`/`pending_transfer_to` nullable field — "claim before move," without rebuilding around Odoo's full quant model | Medium | Later |
| Location hierarchy (zones/bins) | Medium-High | **Not recommended** — flat warehouse list matches actual physical footprint |

### B1.3 Parts Inventory
**Current**: single `quantity` field, reorder-level threshold with a passive UI banner, supplier + unit_cost tracked, reversible decrement/restore.
**Odoo (`stock`+`purchase`)**: three-state availability tied to incoming POs; FIFO/LIFO removal; reorder rules auto-generating a PO.
**Missing**: low stock is passive, not a proactive notification; no "incoming/expected" concept.

| Improvement | Complexity | Now/Later |
|---|---|---|
| Wire low-stock crossing `reorder_level` into the existing notification system | Low | Now |
| Guard stock decrement against negative values (gap B0#5) | Low | Now |
| "Expected restock" date field — feeds the RMA Tickets parts-readiness badge | Low | Later, pairs with B1.1 |

**Beyond Odoo**: predictive reorder using existing audit/ticket-history usage data — more useful for a repair shop than generic reorder rules. Idea only.

### B1.4 Products
**Current**: exactly 3-level hierarchy (Brand→Category→Subcategory), no tagging, hard delete, no variants — each row a discrete SKU.
**Odoo (`product`)**: template-vs-variant split, recursive category tree, separate tag model, active/archived soft-delete.
**Verdict**: mostly validates current design — variants solve "one product, many configurations," not discrete serialized electronics. No recommendation to adopt. 3-level hierarchy is appropriately simpler than Odoo's recursive tree at this catalog size.
**Missing**: no tags; hard delete (no archive) risks orphaning historical ticket/invoice references.

| Improvement | Complexity | Now/Later |
|---|---|---|
| Soft-delete: `active boolean default true`, delete UI becomes "Archive" | Low | Now — data-integrity fix |
| Product tags (new table + join, multi-select chip UI) | Medium | Later |

### B1.5 Customers
**Current**: `customer_type` (B2B/B2C) is structural, not just a label. Separate `customer_notes` table (pre-CRM) distinct from the new Track A `activities` chatter. Duplicate detection only in CSV import. No invoice history cross-link.
**Odoo (`res.partner`+`crm`)**: unified partner record, duplicate warnings on every save, full document history on one page.
**Missing**: duplicate check on manual create; invoice history not shown on customer page.

| Improvement | Complexity | Now/Later |
|---|---|---|
| Reuse import dedup logic as a soft warning on "Add Customer" | Low | Now |
| Invoices tab on `CustomerDetails.jsx` | Low-Medium | Now — pairs with Track A Sprint 5's Contacts/Deals tabs, same page/sprint |
| **Decision needed**: merge `customer_notes` into the CRM `activities` table (`related_type:'customer'`) for one unified chatter, or keep them separate (different audiences — general notes vs sales-rep follow-up) | Medium | Later — needs your input first |

### B1.6 Invoices
**Current**: flat document — `line_items` as a single JSONB array, document-level tax/discount, quote-vs-invoice already distinguished, one ticket per invoice, no immutability after creation, `paid_date` exists but unused.
**Odoo (`account`/`sale`)**: normalized line items with per-line tax, real payment-state machine, draft→posted→cancelled lock, many-to-many lines↔invoices enabling partial/progressive billing.
**Missing**: no payment-state tracking beyond a label; no lock-after-send; can't bill one ticket across multiple invoices or vice versa.

| Improvement | Complexity | Now/Later |
|---|---|---|
| Fix `'void'` missing from `INVOICE_STATUS` (gap B0#1) | Low | Now |
| Wire `paid_date` into the UI on status→Paid | Low | Now |
| Lock invoice fields once "sent"/"paid" (UI-level, admin-reversible) | Low-Medium | Now |
| Per-line tax | Low if needed | **Confirm need first** — don't build speculatively |
| Partial/multi-document invoicing (normalize `line_items`, many-to-many to invoices) | High | **Later, only if confirmed as a real business need** — most invasive item in this entire document |

### B1.7 Automation Rules
**Current**: fully working — 5 triggers, AND-only conditions (4 operators), 4 action types.
**Odoo (`base_automation`)**: similar model, supports OR logic too.
**Missing**: OR logic between conditions.

| Improvement | Complexity | Now/Later |
|---|---|---|
| AND-group vs OR-group toggle per condition set | Medium | Later — not urgent, most real automations are simple enough today |

### B1.8 Webhooks
**Current**: fully working delivery to 9 event types, HMAC-signed, fire-and-forget.
**Missing**: delivery log (gap B0#6) — no visibility, no retry.

| Improvement | Complexity | Now/Later |
|---|---|---|
| `webhook_deliveries` log table + Control Panel list view | Medium | Now — observability fix for a feature already shipped and silently failing today |
| Retry with backoff (mirrors the existing WhatsApp `notification-worker` pattern) | Medium | Later |

### B1.9 SLA Policies
**Current**: per-priority resolution-hour targets, due date computed once at creation. `pauseOnHold` unused (B0#3). No breach detection (B0#4).

| Improvement | Complexity | Now/Later |
|---|---|---|
| Wire `pauseOnHold` to actually pause/resume the clock, or remove the toggle | Low | Now — "don't ship a lie" fix |
| Active breach detection + alert | Medium | Later — ties to B1.1 |

### B1.10 Custom Fields
**Current**: fully built generic engine, zero UI consumption (gap B0#2).

| Improvement | Complexity | Now/Later |
|---|---|---|
| Render custom fields dynamically in `TicketForm.jsx` and `CustomerDetails.jsx` | Medium | **Now** — highest-ROI item in this document; finishing existing work, not a new feature |

### B1.11 Audit Log
**Current**: solid, resilient (retry + localStorage fallback). Manual logging only, free-text details.
**Odoo (`mail.tracking.value`)**: automatic field-level before/after tracking.
**Missing**: structured before/after values.

| Improvement | Complexity | Now/Later |
|---|---|---|
| Optional `old_value`/`new_value` columns, populated on high-value fields (ticket_status, priority, assigned_technician) | Low-Medium | Later — current system works, this is a quality upgrade |

## Section B2 — Track B Priority Recommendation

**Do now** (low-risk, mostly bug fixes or finishing existing work):
1. Fix `INVOICE_STATUS` missing `'void'`
2. Render Custom Fields in Ticket/Customer forms
3. Fix or remove the dead `pauseOnHold` SLA toggle
4. Guard parts stock decrement against negative values
5. Soft-delete (archive) for Products
6. Wire `paid_date` into the Invoices UI
7. Reuse duplicate-customer check on manual create
8. Add an Invoices tab to Customer Details

**Do next** (real value, moderate scope):
9. Webhook delivery log
10. Parts-readiness badge on RMA tickets
11. Warranty→billing auto-zero default
12. Low-stock notification
13. Product tags

**Needs your decision first** (not a default "yes"):
14. `customer_notes` vs CRM `activities` — merge or keep separate?
15. Per-line invoice tax — only if mixed tax rates are real
16. Partial/multi-document invoicing — only if deposits/progressive billing are real
17. Inventory reservation field — only if the transfer race condition is a real concern

**Explicitly not recommended** (Odoo solving a problem this system doesn't have):
- Product variant/template split
- Multi-zone warehouse location hierarchy
- Server-action/code-based automation engine

---

# Cross-Track Notes

- **`activities` is shared infrastructure.** Track A built it for leads (Sprint 2.5); Track B item B1.5#3 (`customer_notes` vs `activities`) and Track A's Sprint 4 (deal activities) both extend the same table. Any schema change to `activities` (e.g. a future Track B audit-trail enhancement) should be checked against both tracks' usage before shipping.
- **JSONB array discipline applies system-wide**, not just CRM tables — any future Track B column (e.g. a hypothetical `webhook_deliveries.response_data`) must follow the same array-not-object rule from `CONSTITUTION.md §7.5a`.
- **`CustomerDetails.jsx` is a convergence point** — Track A Sprint 5 adds Contacts/Deals tabs; Track B adds an Invoices tab. Worth building in the same pass when that sprint starts, rather than two separate edits to the same file.
- **The uuid-vs-email lesson from Track A (Sprint 2, three separate bugs)** generalizes: any Track B feature that stores "who" (e.g. webhook delivery triggered_by, audit log before/after on `assigned_technician`) should default to `text` (email), matching the established convention (`rma_tickets.assigned_technician`, `customers.created_by`), not a `uuid REFERENCES auth.users(id)` FK — that pattern has already caused three real bugs in this project.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `customers` vs "accounts" naming confuses the team | High | Medium | "Accounts" in UI labels only; DB table stays `customers`. |
| RLS policies for new tables incomplete | Medium | High | Every new table gets RLS in its own migration; test with a `sales_rep`/non-admin session before deploying. |
| `sales_rep` role doesn't work without the prerequisite | N/A — done | Critical | `20260618_crm_add_sales_rep_role.sql` ran first. |
| `sales_rep` accidentally sees RMA internals | Medium | Medium | Use the permission-preview "view as user" feature before each deploy. |
| Pipeline stage names locked in seeded data, hard to rename later | Low | High | Confirm names with QDS sales manager before Sprint 3 ships. |
| Scope creep — later sprints/items built before earlier ones validated | High | Medium | Hard gate: no Sprint N+1 work starts until Sprint N's checklist is 100% done. Same rule applies across Track B's now/next/later tiers. |
| `@hello-pangea/dnd` drag performance on mobile PWA | Medium | Low | Test during Sprint 3; fall back to tap-to-move-stage dropdown if needed. |
| Duplicate customer problem (CRM contact = RMA customer) | Medium | High | Track B item #7 (reuse import dedup on manual create) directly mitigates this. |
| JSONB key-order issue in `product_lines`/`stages`/any future JSONB column | Low | High | Always arrays, never objects — see Constitution Check above. |
| WhatsApp notification volume spikes | Medium | Low | Each notification type individually toggleable in `WASettings.jsx`. |
| Partial invoicing (Track B #16) started speculatively without a confirmed business need | Low (gated) | High | Explicitly held behind your confirmation in Section B2 — not scheduled by default. |

---

## Definition of Done

**Track A — Phase 1 CRM complete when:**
1. [ ] All CRM migrations applied to production, no ad-hoc SQL outside migration files
2. [ ] `sales_rep` role + permissions confirmed via permission preview
3. [x] `/leads`: a rep can create, edit, convert a lead (done, Sprint 2)
4. [x] Lead detail page with chatter (notes, scheduled activities, status history) — Odoo/Zoho-grade (done, Sprint 2.5)
5. [ ] `/pipeline`: a deal appears in the correct stage column; drag-drop persists
6. [ ] A deal can be marked Won/Lost (`lost_reason` required on Lost)
7. [ ] Activities can be logged against a deal; overdue activities show a badge on the Kanban card
8. [ ] Dashboard shows total open deal value, deals won this month, overdue follow-ups
9. [ ] `CustomerDetails.jsx` shows Contacts tab and Deals tab
10. [ ] All new UI strings translated in `en.json`/`ar.json`
11. [ ] Dark mode correct on all new pages
12. [ ] `npm test`, `npm run lint`, `npm run build` all pass
13. [ ] At least one QDS sales rep and one manager have run a full sales cycle (lead → deal → won/lost) and confirmed it matches their real process

**Track B — done when, per item:**
- Each "Do now" item (B2 #1-8) is built, tested, and confirmed via manual click-through
- Each "Do next" item (B2 #9-13) is explicitly approved before starting, then built the same way
- Each "Needs your decision" item (B2 #14-17) has an explicit decision recorded in this file before any code is written

---

## Complete File Checklist

### New files (Track A)
| File | Sprint |
|---|---|
| `supabase/migrations/20260618_*` through `20260703_*` (full chain, see Sprints 1-2.5 above) | 1–2.5 |
| `supabase/migrations/20260704_crm_pipeline_rename_new_lead_stage.sql` | 3 |
| `supabase/migrations/20260706_seed_test_users_and_deals.sql` | 3 |
| `supabase/migrations/20260707_crm_rename_new_deal_stage_plural.sql` | 3 |
| `supabase/migrations/20260708_crm_sync_deal_values.sql` | 3 |
| `src/api/db/leads.ts`, `deals.ts`, `activities.ts`, `pipelines.ts`, `contacts.ts` | 1 |
| `src/pages/Leads/index.jsx`, `LeadDetails.jsx`, `LeadChatter.jsx`, `_modals.jsx`, `_constants.js` | 2, 2.5 |
| `src/pages/Pipeline/index.jsx`, `Pipeline/DealDetail.jsx` | 3 |
| `src/pages/Pipeline/PipelineListView.jsx` | 3 |
| `src/pages/Pipeline/PipelineGraphView.jsx` | 3 |
| `src/pages/Pipeline/PipelinePivotView.jsx` | 3 |
| `src/pages/Pipeline/PipelineActivityView.jsx` | 3 |
| `src/pages/Activities/index.jsx` | 4 |
| `src/lib/events/crmEventHandlers.ts` | 4 |

### Modified files (Track A)
| File | Change | Sprint |
|---|---|---|
| `src/api/db/index.ts` | Export new Row types + modules | 1 |
| `src/api/db/activities.ts` | Added `delete(id)` method; `listForRelated()` bulk query | 3 |
| `src/api/db/deals.ts` | `moveStage()`, `markWon()`, `markLost()`, `reopen()` with auto-log | 3 |
| `src/lib/constants.ts` | `LEAD_STATUS`, `LEAD_SOURCE`, `DEAL_STATUS`, `ACTIVITY_TYPE` (+`LOG`), `LIFECYCLE_STAGE` | 1, 2.5 |
| `src/lib/schemas.ts` | New Zod schemas | 1, 2 (assigned_rep fix) |
| `src/lib/permissions.ts` | `sales_rep` in `ROLE_DEFAULT_PERMISSIONS` | 1 |
| `src/App.jsx` | Routes `/leads`, `/leads/:id`, `/pipeline`, `/pipeline/:id`, `/activities` | 2, 2.5, 3–4 |
| `src/components/ActivityChatter.jsx` | `controlledTab`/`onControlledTabChange` props (external tab control); inline Mark Done/Edit/Cancel activity controls; `handleCancelActivity` via `db.activities.delete()` | 3 |
| `src/pages/Pipeline/index.jsx` | View switcher (kanban/list/graph/pivot/activity); XLSX export (flat + AutoFilter); Kanban column header layout fix | 3 |
| `src/pages/Pipeline/DealDetail.jsx` | Color-coded stages; Won/Lost inline; probability header + sidebar + slider; prominent value + inline edit; Expected Close Date in header; unified single tab row (Log Note / Schedule Activity / Product Lines); product lines tab with column headers + auto-sync value | 3 |
| `src/pages/Pipeline/_modals.jsx` | Probability slider; value field locked when `hasProductLines` | 3 |
| `src/pages/Pipeline/_constants.js` | `probability: 0` added to `EMPTY_DEAL_FORM` | 3 |
| `src/pages/Dashboard.jsx` | Sales KPI widgets, pipeline chart, leaderboard | 4–5 |
| `src/pages/CustomerDetails.jsx` | Contacts tab, Deals tab (Track A) + Invoices tab (Track B) | 5 |
| `src/pages/Reports.jsx` | CRM reports section | 5 |
| `src/pages/ControlPanel.jsx` | Pipeline Config sub-page | 5 |
| `src/locales/en.json`, `ar.json` | Every new string, every sprint, same commit | 2–5 |

### Files to touch (Track B, "Do now" tier)
| File | Item |
|---|---|
| `src/lib/constants.ts` | Add `'void'` to `INVOICE_STATUS` |
| `src/pages/cp/CustomFields.jsx`, `TicketForm.jsx`, `CustomerDetails.jsx` | Wire custom field rendering |
| `src/pages/cp/*SLA*`, `system.ts` | Fix/remove `pauseOnHold` |
| `src/api/db/inventory.ts` | Guard parts stock decrement |
| `src/api/db/catalog.ts`, `Products/index.jsx`, a new migration | Soft-delete for products |
| `src/pages/Invoices.jsx` | Wire `paid_date` into UI |
| `src/pages/Customers/_modals.jsx` | Reuse dedup logic on manual create |
| `src/pages/CustomerDetails.jsx` | Invoices tab |

---

*This file is the persistent build state across sessions for both tracks. Check items off as built and verified. Don't start a sprint's/tier's items until the previous one's checklist is fully checked. If a step's detail is unclear, check `specs/002-crm-upgrade/` first (Track A) before re-deriving from `docs/archive/CRM_UPGRADE_STUDY.md`. If an Architecture Lock decision needs to change, update it here AND in `CLAUDE.md`, and re-check whether any already-checked-off step is invalidated.*
