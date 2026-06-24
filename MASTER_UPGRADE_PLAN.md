# myRMA — Master Upgrade Plan

**Branch**: `002-crm-upgrade` | **Date**: 2026-06-22 | **Supersedes**: `CRM_UPGRADE_PLAN.md`, `SYSTEM_UPGRADE_PLAN.md` (both archived to `docs/archive/`)

**Input**: `specs/002-crm-upgrade/spec.md` (CRM track, formal SpecKit feature) + `docs/archive/CRM_UPGRADE_STUDY.md` (CRM source study) + live Odoo 19 Community source at `D:\odoo-19.0` read as a benchmark for the System track (LGPLv3 — patterns studied, never copied)

**This is the single file to follow going forward.** Two parallel tracks, one document, one workflow. Check items off as you go — this file is the persistent state of the build across sessions.

---

## Summary

myRMA is being upgraded along two tracks simultaneously:

- **Track A — CRM**: turns myRMA into a CRM-capable system (leads, deals, pipeline, activities, sales_rep role) per `docs/archive/CRM_UPGRADE_STUDY.md`. Formal SpecKit artifacts for Sprint 1 live in `specs/002-crm-upgrade/` (`spec.md`, `research.md`, `data-model.md`, `contracts/api-modules.md`, `quickstart.md`) — this file is the sprint-by-sprint build tracker that sits above those, same role `CRM_UPGRADE_PLAN.md` played before this merge (now archived).
- **Track B — System**: upgrades myRMA's existing modules (RMA Tickets, Inventory, Parts, Products, Customers, Invoices, Automation, Webhooks, SLA, Custom Fields, Audit Log) using Odoo as a benchmark, not a blueprint. Every recommendation augments what exists; none propose replacing a working module. Where myRMA's current design already suits a repair-shop SaaS better than Odoo's generic-ERP approach, that's stated explicitly — "no change" is a valid, common conclusion in this track.

Both tracks share the same engineering constitution (`CONSTITUTION.md`), the same workflow discipline (below), and the same file. They are tracked together because they touch overlapping ground (e.g. the `activities` chatter built for Track A's leads is the same engine Track B's "finish Custom Fields" and "Customer notes vs activities" items reference).

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

---

## Sprint 4 — Activities & Follow-Ups

**Goal**: Reps never miss a follow-up. (Note: the core activity engine — log/schedule/complete/reopen/reschedule, planned vs. history — already exists from Sprint 2.5. This sprint is the system-wide surface for it, not new plumbing.)

- [ ] `src/pages/Activities/index.jsx` — "Today", "Overdue", "All" tabs
- [ ] Activity quick-log panel on deal detail page (lead detail already has it via `LeadChatter`)
- [ ] Overdue follow-ups count badge in sidebar
- [ ] Dashboard widget: "Overdue Follow-Ups" count card
- [ ] `src/lib/events/crmEventHandlers.ts` — `registerCrmEventHandlers()` alongside `registerTicketEventHandlers()`
- [ ] WhatsApp template `crm_followup_due` — morning digest, toggleable per-type in `WASettings.jsx`
- [ ] All strings in `en.json` + `ar.json`

---

## Sprint 5 — Dashboard & Polish

**Goal**: Management visibility. System usable end-to-end.

- [ ] `Dashboard.jsx`: sales KPI section — open pipeline value, deals won this month, leads created this month, overdue follow-ups
- [ ] `Dashboard.jsx`: "Pipeline by Stage" bar chart (Recharts)
- [ ] `Dashboard.jsx`: Rep Leaderboard card (top 5 by deals won this month)
- [ ] `CustomerDetails.jsx`: Contacts tab (list/add/edit/delete) — **can be built alongside Track B's "Invoices tab" item**, same page, same sprint
- [ ] `CustomerDetails.jsx`: Deals tab (open/won deals for this account)
- [ ] `Reports.jsx`: CRM section — deals by stage, win/loss rate, leads by source, rep performance
- [ ] `ControlPanel.jsx`: Pipeline Config sub-page (admin edits stage names)
- [ ] QA: full end-to-end test with a `sales_rep` account and a manager account
- [ ] `npm test`, `npm run lint`, `npm run build` all pass
- [ ] Deploy to staging; get feedback from QDS team before production push

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
| `src/api/db/leads.ts`, `deals.ts`, `activities.ts`, `pipelines.ts`, `contacts.ts` | 1 |
| `src/pages/Leads/index.jsx`, `LeadDetails.jsx`, `LeadChatter.jsx`, `_modals.jsx`, `_constants.js` | 2, 2.5 |
| `src/pages/Pipeline/index.jsx`, `Pipeline/DealDetail.jsx` | 3 |
| `src/pages/Activities/index.jsx` | 4 |
| `src/lib/events/crmEventHandlers.ts` | 4 |

### Modified files (Track A)
| File | Change | Sprint |
|---|---|---|
| `src/api/db/index.ts` | Export new Row types + modules | 1 |
| `src/lib/constants.ts` | `LEAD_STATUS`, `LEAD_SOURCE`, `DEAL_STATUS`, `ACTIVITY_TYPE` (+`LOG`), `LIFECYCLE_STAGE` | 1, 2.5 |
| `src/lib/schemas.ts` | New Zod schemas | 1, 2 (assigned_rep fix) |
| `src/lib/permissions.ts` | `sales_rep` in `ROLE_DEFAULT_PERMISSIONS` | 1 |
| `src/App.jsx` | Routes `/leads`, `/leads/:id`, `/pipeline`, `/pipeline/:id`, `/activities` | 2, 2.5, 3–4 |
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
