# myRMA → Full CRM Upgrade
## Comprehensive Project Study & Implementation Plan

**QDS Egypt · June 2026**
*Benchmarked against Odoo CRM and Zoho CRM*

---

## ⚠️ Verification Notes (added 2026-06-17 — fact-checked against the live codebase)

This study was checked against the actual `D:\myrma-app` source before planning began. Four corrections were made:

1. **`customers` table field name was wrong.** §6.1 originally listed `phone` as an existing column. The real `CustomerRow` (`src/api/db/customers.ts`) has **`mobile`** and a separate **`landline`** — there is no `phone` column. Fixed throughout §6.
2. **Missing database-level prerequisite for the new `sales_rep` role.** The role system has two hardcoded role lists at the SQL level that the original study never mentioned:
   - `chk_user_role` CHECK constraint on `user_roles.role` (`supabase/migrations/20260526_check_constraints.sql:38-44`) — currently `CHECK (role IN ('super_admin','admin','manager','technician','viewer'))`. Inserting a `sales_rep` row would fail this constraint outright.
   - `public.rma_is_staff()` and `public.rma_is_manager_or_above()` SQL functions (`supabase/migrations/20260526_enable_rls.sql:52-58`) — also hardcoded role lists. `customers` table RLS (`staff_read` policy) gates SELECT through `rma_is_staff()` specifically — **without updating this function, a sales_rep cannot read the customers table at all**, regardless of what `ROLE_DEFAULT_PERMISSIONS` says client-side. RLS is enforced server-side; client permissions are UI-only.
   
   Added a new migration `20260618_crm_add_sales_rep_role.sql` as a hard Sprint-0 prerequisite — see §6.3 and §9.1.
3. **`account_manager` vs. `assigned_rep` — resolved, not left open.** Verified `account_manager` is a free-text input (`src/pages/Customers/_modals.jsx:124`), not a foreign key. The study's proposed `assigned_rep` is `uuid FK → auth.users`. These are structurally incompatible — merging them would require a data-cleanup migration to map free-text manager names to user IDs, which is unscoped and error-prone. **Decision: keep both columns, do not merge.** `account_manager` stays as the existing relationship-owner field; `assigned_rep` is the new CRM deal-owner field. They may reference the same person in practice, entered independently.
4. **Migration date sequencing.** Today is 2026-06-17 (latest existing migration: `20260617_kb_articles.sql`). The original proposed dates (`20260620` onward) left no room for the new prerequisite migration. Renumbered to start at `20260618`.

Everything else in this study (the @hello-pangea/dnd dependency, the ai-assist Edge Function, the ROLES constant shape, the registerTicketEventHandlers() wiring pattern, the dashboardWidgets config array, the permission-preview "view as user" feature) was verified accurate against the live code.

---

# 1. Executive Summary

This document is the full engineering and product study for upgrading myRMA — the existing RMA/service-ticket system built for QDS Egypt — into a complete CRM platform on par with Odoo CRM and Zoho CRM. It supersedes the initial study produced by Claude Code in the terminal (`CRM_PROJECT_STUDY.md`) and adds:

- A side-by-side feature benchmark against Odoo CRM and Zoho CRM
- A full gap analysis: what myRMA already has vs. what must be built
- A complete module-by-module scope definition
- An exact data model specification with migration SQL strategy
- A phased implementation plan with per-sprint task breakdowns
- Architecture decisions that must be locked before the first migration
- Risk register with mitigations

> **RECOMMENDATION:** Build the CRM directly inside the existing `D:\myrma-app` codebase as new domain modules. Do NOT create a separate app. The existing customers table, products catalog, invoices module, WhatsApp notification system, permissions layer, and audit log are all directly reusable. A second app means a duplicate customer table — and a duplicate customer table becomes a permanent data integrity problem the moment any QDS customer files both a quote and an RMA ticket.

---

# 2. Competitive Benchmark: Odoo CRM vs. Zoho CRM vs. myRMA Target

The table below maps the core CRM capabilities of Odoo 19 and Zoho CRM against the current state of myRMA and the target state after the upgrade. This is the master gap analysis.

| Capability | Odoo CRM | Zoho CRM | myRMA Now | myRMA Target |
|---|---|---|---|---|
| Contacts & Accounts (B2B/B2C) | Full (Account + Contact hierarchy) | Full (Accounts + Contacts separate) | Partial (customers table, single record) | Full — extend customers to add contacts child table |
| Lead capture & qualification | Full (web form, email, social, manual) | Full (web form, social, email, chat, manual) | None | Phase 1 — manual + CSV + WhatsApp lead source |
| Lead → Opportunity conversion | One-click, merges duplicate detection | One-click, creates Account + Contact + Deal | None | Phase 1 — convert lead → deal, link to customer |
| Visual Kanban pipeline (drag & drop) | Full, per-team pipelines | Full, multiple pipelines + sub-pipelines | None (uses @hello-pangea/dnd already) | Phase 1 — kanban board with deal stages |
| Multiple pipelines | Yes (per team) | Yes (up to 15 team pipelines) | None | Phase 1 — B2B Dealer + B2C Retail pipelines |
| Deal/opportunity records | Full (value, probability, close date, products) | Full (value, probability, stage, products) | None | Phase 1 — deals table with all key fields |
| Activities (tasks, calls, meetings) | Full + activity plan sequences | Full (tasks, calls, meetings, notes) | None | Phase 1 — activities table with follow-up alerts |
| Follow-up reminders & alerts | In-app + email + mobile push | In-app + email + SMS | WhatsApp/email already built for RMA | Phase 1 — reuse existing WhatsApp + email infra |
| Sales rep assignment & visibility | Yes — per team and per lead | Yes — owner per record + team visibility | Partial (account_manager on customers) | Phase 1 — assigned_rep on leads and deals |
| Sales dashboard & KPIs | Full — pipeline, forecast, rep stats | Full — custom dashboards per role | RMA-focused dashboard exists | Phase 1 — sales KPI cards added to Dashboard.jsx |
| Role-based access (sales rep view) | Yes — sales teams with own pipeline | Yes — profiles + record ownership | Yes (canDo() RBAC exists) | Phase 1 — add sales_rep role + new resource keys |
| Quotes / proposals from deals | Full — convert opportunity → quote → order | Full — quotes module linked to deals | Invoices/quotes PDF module already exists | Phase 2 — link deal stage → existing invoices module |
| Product catalog in deals | Full ERP integration | Full — products linked to deals | Full product catalog already exists | Phase 2 — link deals to existing products table |
| Customer 360 view (RMA + sales) | Full via Helpdesk module integration | Full via Zoho Desk integration | RMA data per customer exists | Phase 2 — unified timeline: deals + RMA tickets |
| Bulk CSV import (leads/contacts) | Yes | Yes | Yes (customers + products already) | Phase 1/2 — extend existing CSV import to leads |
| Sales targets & quotas | Yes (Sales module) | Yes (forecasting + targets) | None | Phase 2 — sales_targets table + dashboard widget |
| Email/WhatsApp templates for follow-ups | Yes (Marketing module) | Yes (email + SMS templates) | Full WhatsApp template system already built | Phase 2 — extend existing templates to CRM events |
| Lead scoring / AI prioritization | AI lead scoring (Odoo 19) | Zia AI scoring + lead ranking | AI Assist via NVIDIA NIM already exists | Phase 3 — extend ai-assist Edge Function |
| Marketing automation / drip campaigns | Full Marketing Automation module | Full Zoho Campaigns integration | None | Phase 3 — out of scope for SMB of 35 people |
| Territory management | Yes | Yes | None | Out of scope |
| Customer portal / self-service | Yes (Customer Portal module) | Yes (Zoho CRM Portal) | Public RMA tracker already exists | Phase 3 — optional extension of public tracker |
| Mobile PWA | Mobile app + PWA | Mobile app | Full PWA already exists | No work needed — PWA covers this |
| Audit log | Full | Full | Full audit log already exists | No work needed — extend to CRM events |
| Real-time notifications | Yes | Yes | Supabase Realtime already wired | No work needed — reuse existing channel |
| Dark mode | No | No | Full dark mode (Direction B) | No work needed — already ahead of competitors |
| Arabic / RTL support | Partial | Partial | Full Arabic + RTL already built | No work needed — already ahead of competitors |

---

# 3. What Odoo CRM Does That We Must Replicate

## 3.1 Odoo CRM Core Architecture

Odoo CRM is organized around four core concepts that define the data model every serious CRM follows:

1. **Leads** — pre-qualified prospects captured from any source (website forms, email, manual entry, social media). Leads are a lightweight, disposable record — they live in a separate list until a salesperson qualifies them and converts them to an Opportunity.
2. **Opportunities (Deals)** — the main pipeline record. A deal has a customer, value, expected close date, stage, assigned rep, linked products, and probability. It lives on the Kanban board.
3. **Activities** — every touchpoint logged against a deal or customer. Calls, meetings, emails, WhatsApp messages, notes. Odoo adds Activity Plans: preconfigured sequences of activities that auto-schedule when triggered (e.g. when a deal enters "Negotiation" stage, schedule a call in 2 days and a follow-up email in 5 days).
4. **Pipeline Analysis** — reporting on the health of the pipeline: stage distribution, win/loss rates, rep performance, forecast (sum of open deal values × probability), cohort trends.

## 3.2 Odoo-Specific Features Worth Replicating

| Odoo Feature | Priority for QDS | Implementation Approach |
|---|---|---|
| Kanban pipeline with drag-and-drop stage movement | Critical | @hello-pangea/dnd already in project — build Pipeline page |
| Per-team pipeline stages (B2B vs. B2C) | Critical | pipelines table with stages[] JSONB array |
| Lead qualification step before pipeline entry | Important | leads table separate from deals — convert flow |
| Activity types + next-activity scheduling | Important | activities table with due_date + type enum |
| Overdue activity alerts on Kanban cards | Important | Computed via RLS + real-time notification |
| Win/loss analysis with lost_reason | Important | lost_reason field on deals table |
| Pipeline forecast (value × probability) | Nice-to-have Phase 2 | Computed view or dashboard widget |
| Activity plan sequences | Phase 3 | activity_plan_templates table |
| Duplicate lead/contact detection | Phase 2 | Fuzzy match on name + phone on save |
| UTM source tracking on leads | Phase 2 | lead_source + lead_medium + lead_campaign fields |

---

# 4. What Zoho CRM Does That We Must Replicate

## 4.1 Zoho CRM Core Architecture

Zoho CRM separates data into a strict four-level hierarchy that is more explicit than Odoo's:

1. **Leads** — a single flat record with both person and company fields. Source is always tracked. Status pipeline manages outreach before conversion.
2. **Accounts** — the company record. Created from lead conversion or manually. One account, many contacts and many deals.
3. **Contacts** — the individual person at an account. Multiple contacts per account. Links to deals.
4. **Deals (Opportunities)** — the pipeline record. Linked to Account + Contact. Has stage, value, close date, probability, and product lines.

This hierarchy is the industry standard and directly maps to QDS's B2B dealer sales: one company (Account) may have multiple buyers (Contacts) and multiple open deals simultaneously.

## 4.2 Zoho-Specific Features Worth Replicating

| Zoho Feature | Priority for QDS | Implementation Approach |
|---|---|---|
| Account + Contact hierarchy (company + individual) | Critical for B2B | contacts child table linked to customers (accounts) |
| Lead conversion creates Account + Contact + Deal | Critical | Convert function in leads.ts domain module |
| Multiple pipelines with per-pipeline stages | Important | pipelines table + pipeline_id on deals |
| Blueprint (enforce required fields before stage advance) | Phase 2 | Zod schema enforcement per stage transition |
| Workflow rules (auto-create task on stage change) | Phase 2 | Extend existing automation_rules system in system.ts |
| Custom views / saved filters per rep | Phase 2 | Saved filter presets in user_preferences |
| Role-based homepage dashboards | Phase 2 | Extend AppearanceContext widget order per role |
| 360° customer view (deals + support + notes) | Phase 2 | Unified timeline in CustomerDetails.jsx |
| Forecasting (closed, best case, committed) | Phase 2 | Computed aggregate on deals table |
| Lead scoring rules (field-based) | Phase 3 | Extend ai-assist or rules table |

---

# 5. Full Module Scope Definition

## 5.1 Phase 1 — MVP (Must-Have for Launch)

> **Goal:** Give QDS Egypt's 35-person team a working sales pipeline they will actually use. Ship nothing that isn't in daily use before adding Phase 2.

| Module | Description | New Files | Reuses Existing |
|---|---|---|---|
| Contacts (Accounts sub-table) | A contacts table for multiple people per customer/account. Each contact has name, title, phone, email, is_primary flag, linked to customers.id. The existing customers table becomes the "Account." | src/api/db/contacts.ts, migration 20260619_crm_contacts.sql | customers table, CustomerDetails.jsx |
| Leads | New leads table: source (walk-in/phone/referral/exhibition/website/whatsapp), status (new/contacted/qualified/disqualified), assigned_rep, converted_at, converted_deal_id. Leads page with list view + filters + quick-add form. | src/pages/Leads/, src/api/db/leads.ts | canDo(), useURLTab, ui.jsx, WhatsApp templates |
| Sales Pipeline / Deals | Kanban board of deals grouped by stage. Each deal: account, pipeline, stage, value, currency (EGP), probability, expected_close_date, assigned_rep, product_lines[], status (open/won/lost), lost_reason. Drag-and-drop between stages. | src/pages/Pipeline/, src/api/db/deals.ts | @hello-pangea/dnd, ui.jsx, products table |
| Pipelines Config | Two default pipelines: "B2B Dealer" (6 stages) and "B2C Retail" (5 stages). Configurable by admin in Control Panel. Stored in pipelines table with stages[] JSONB. | src/api/db/pipelines.ts, ControlPanel sub-page | useURLTab, ControlPanel.jsx, canDo() |
| Activities & Follow-Ups | Log calls, meetings, WhatsApp, emails, notes against a deal, lead, or customer. Each activity has a due_date. Overdue follow-ups surface in dashboard. "Next follow-up date" visible on pipeline cards. | src/api/db/activities.ts, src/pages/Activities/ | WhatsApp notification system, existing calendar, TechCalendar.jsx |
| Sales Rep Management | Sales rep sees only their own leads/deals. Manager/admin sees all. Rep workload view: open deals count, overdue follow-ups count. Leaderboard by deals won this month. | Permission keys: leads.*, deals.*, activities.* | canDo(), resolvePermissions(), user_roles table |
| Sales Dashboard Widgets | New KPI cards on Dashboard.jsx: Total open deal value, Deals won this month, Overdue follow-ups count, Pipeline by stage (bar chart). Added to existing widget grid. | Dashboard.jsx extension | Dashboard.jsx, Recharts, TanStack Query |
| Notifications for Sales Events | Trigger WhatsApp/email notifications for: new lead assigned to rep, deal moved to won, follow-up due today (morning digest), deal overdue (no activity in N days). | src/lib/events/crmEventHandlers.ts | notificationEventBus, notification_queue, WhatsApp templates, send-whatsapp Edge Function |

## 5.2 Phase 2 — Strong Value-Add (After Phase 1 Adoption)

> **Gate:** Do not start Phase 2 until the team has used Phase 1 for at least 4 weeks and feedback is positive.

| Module | Description | Key Reuse Opportunity |
|---|---|---|
| Quotes from Deals | "Convert deal to quote" button on Pipeline card → opens existing Invoices page pre-filled with deal's products and customer. Deal stage auto-advances to "Quote Sent." | Existing Invoices.jsx + jsPDF export — near-zero new code |
| Customer 360 Timeline | Unified activity timeline in CustomerDetails.jsx showing: RMA tickets, deals, activities, quotes, invoices, WhatsApp messages — all on one page. | CustomerDetails.jsx already exists — add CRM timeline tab |
| Sales Targets & Quotas | Admin sets monthly/quarterly target per rep and per team. Dashboard shows actual vs. target progress bars. sales_targets table. | Dashboard.jsx widget system + Reports.jsx |
| Bulk Lead Import | CSV import for trade-show lead lists. Maps columns: name, company, phone, email, source, notes. Same parseCSVLine pattern as Products/Customers pages. | Existing CSV import pattern in Customers/index.jsx |
| Email/WhatsApp Templates for CRM | Templates for: welcome new lead, quote sent follow-up, deal won thank-you, re-engagement after 30 days of silence. | WATemplates.jsx, WhatsApp template system — just add new event_types |
| Duplicate Detection | When saving a new lead or contact, fuzzy-match on phone + company name against existing leads and customers. Show merge suggestion modal. | New utility in leads.ts — Levenshtein or exact phone match |
| UTM / Lead Source Analytics | Track source, medium, campaign on leads. Reports page shows: leads by source this month, conversion rate per source, pipeline value by source. | Extend leads table + Reports.jsx |
| Forecasting View | Pipeline value breakdown: Committed (probability > 80%), Best Case (probability > 40%), Won this month. Shown as stacked bar chart. | Dashboard.jsx + Recharts — computed from deals table |

## 5.3 Phase 3 — Nice-to-Have (Only After Phase 2 Is Validated)

The following are explicitly out of scope until Phases 1–2 are proven. Do not build these speculatively.

- AI lead scoring (extend existing ai-assist Edge Function with a deals scoring endpoint)
- Marketing automation / drip email campaigns
- Customer self-service portal for B2B dealers (extend existing `/tracker` public page)
- Territory / regional management (not needed at 35 people)
- Custom object builder (Salesforce/Zoho-style — over-engineered for this scale)
- Activity plan templates (Odoo-style sequential activity sequences)

---

# 6. Data Model Specification

## 6.1 The Architecture Decision: customers → accounts

> ⚠️ **CRITICAL DECISION — must be made before writing the first migration. This is the single irreversible fork in the road.**

The existing `customers` table has (verified against `src/api/db/customers.ts`): `id`, `company_name`, `contact_person` (string), `account_manager` (free-text, not a FK), `customer_type` (B2B/B2C), `cr_number`, `tax_id`, `customer_status`, `notes`, `mobile`, `landline`, `email`, `address`, `attachments`, `created_date`, `updated_date`, `created_by`. (No `phone` column — it's `mobile` + a separate `landline`.)

There are two options:

| Option | Description | Pros | Cons | Recommendation |
|---|---|---|---|---|
| **Option A: Extend customers table** | Add CRM fields (lifecycle_stage, lead_source, assigned_rep) directly to customers. Build a new contacts child table for multiple people per account. | Minimal migration, zero RMA disruption, all existing pages still work | Table name "customers" is slightly confusing as a CRM "accounts" table; contact_person field becomes partially redundant | **RECOMMENDED** for QDS at 35 people. Rename conceptually in UI to "Accounts" while keeping the DB table as customers. |
| **Option B: Rename/migrate to accounts** | Create new accounts + contacts tables. Migrate all customers rows to accounts. Update all FK references in rma_tickets, invoices, inventory. | Cleaner long-term architecture, matches Odoo/Zoho naming exactly | High-risk migration touching 8+ tables; breaks existing API modules; significant test surface | NOT recommended until Phase 1 is validated and the team sees clear need. |

> **DECISION:** Go with Option A. Add CRM fields to the customers table. Add a contacts child table for multiple people per account. Rename "Customers" to "Accounts" in the UI navigation and page titles only — the DB table stays `customers`. This is what the existing `CONSTITUTION.md` pattern demands: backward-compatible schema evolution.

## 6.2 New Tables Required

### `contacts`

Multiple people per account (customer). Supports Zoho-style Account → Contact hierarchy.

| Column | Type | Description |
|---|---|---|
| id | uuid PK | Primary key |
| customer_id | uuid FK → customers.id ON DELETE CASCADE | The account this contact belongs to |
| full_name | text NOT NULL | Contact's full name |
| title | text | Job title (e.g. "Purchasing Manager") |
| phone | text | Direct phone number |
| email | text | Direct email address |
| is_primary | boolean DEFAULT false | Primary contact flag (one per customer) |
| notes | text | Notes about this contact |
| created_at | timestamptz DEFAULT now() | |
| created_by | uuid FK → auth.users | For audit trail |

### `pipelines`

Configurable pipeline definitions. Two default pipelines ship with the migration.

| Column | Type | Description |
|---|---|---|
| id | uuid PK | |
| name | text NOT NULL | e.g. "B2B Dealer Pipeline" |
| stages | jsonb NOT NULL | Array of stage objects: `[{id, name, order, probability_default, is_won, is_lost}]` |
| is_active | boolean DEFAULT true | |
| created_at | timestamptz DEFAULT now() | |

**Default B2B Dealer stages:** New Lead (10%) → Contacted (20%) → Needs Assessment (40%) → Quote Sent (60%) → Negotiation (75%) → Won / Lost

**Default B2C Retail stages:** New Inquiry (10%) → Contacted (30%) → Quote Sent (60%) → Won / Lost

### `leads`

| Column | Type | Description |
|---|---|---|
| id | uuid PK | |
| full_name | text NOT NULL | Lead person's name |
| company_name | text | Their company name |
| phone | text | Phone number |
| email | text | |
| source | text NOT NULL | Enum: walk-in / phone / referral / exhibition / website / whatsapp / other |
| status | text NOT NULL DEFAULT new | Enum: new / contacted / qualified / disqualified |
| assigned_rep | uuid FK → auth.users | Sales rep assigned to this lead |
| notes | text | Free-text notes from initial contact |
| converted_at | timestamptz | Set when converted to a deal |
| converted_customer_id | uuid FK → customers | Account created or linked on conversion |
| converted_deal_id | uuid FK → deals | Deal created on conversion |
| created_at | timestamptz DEFAULT now() | |
| created_by | uuid FK → auth.users | |
| updated_at | timestamptz | |

### `deals`

| Column | Type | Description |
|---|---|---|
| id | uuid PK | |
| title | text NOT NULL | Deal name/description |
| customer_id | uuid FK → customers.id | The account this deal belongs to |
| contact_id | uuid FK → contacts.id | Primary contact person for this deal |
| pipeline_id | uuid FK → pipelines.id NOT NULL | Which pipeline this deal is in |
| stage | text NOT NULL | Current stage name (from pipelines.stages[].name) |
| value | numeric(12,2) | Expected deal value in EGP |
| probability | integer DEFAULT 0 | Win probability 0–100 (can override pipeline default) |
| expected_close_date | date | Estimated close date |
| assigned_rep | uuid FK → auth.users | Owning sales rep |
| product_lines | jsonb | Array of `{product_id, product_name, qty, unit_price}` |
| status | text NOT NULL DEFAULT open | Enum: open / won / lost |
| lost_reason | text | Required when status = lost |
| won_at | timestamptz | Set when status → won |
| lost_at | timestamptz | Set when status → lost |
| notes | text | |
| created_at | timestamptz DEFAULT now() | |
| created_by | uuid FK → auth.users | |
| updated_at | timestamptz | |

### `activities`

| Column | Type | Description |
|---|---|---|
| id | uuid PK | |
| related_type | text NOT NULL | Enum: lead / deal / customer / contact |
| related_id | uuid NOT NULL | FK to the related record (polymorphic) |
| type | text NOT NULL | Enum: call / meeting / whatsapp / email / note / task |
| title | text NOT NULL | Brief description of the activity |
| due_date | timestamptz | When this activity is due |
| completed_at | timestamptz | Set when marked done; null = pending/overdue |
| assigned_rep | uuid FK → auth.users | |
| outcome_notes | text | What happened — filled in when completing |
| created_at | timestamptz DEFAULT now() | |
| created_by | uuid FK → auth.users | |

### Additions to the `customers` table (ALTER TABLE)

| Column to Add | Type | Purpose |
|---|---|---|
| lifecycle_stage | text DEFAULT customer | Enum: lead / prospect / customer / churned. Distinguishes CRM accounts from existing RMA-only customers. |
| lead_source | text | How this account was originally acquired (walk-in / referral / exhibition / etc.) |
| assigned_rep | uuid FK → auth.users | The sales rep who owns this account. **Resolved (see Verification Notes):** kept separate from the existing `account_manager` column — that field is free-text, not a FK, so merging would need an unscoped data-cleanup migration. |
| last_activity_at | timestamptz | Denormalized: updated by trigger when any activity is logged. Enables "last contacted" display without a JOIN. |

## 6.3 Migrations to Write

| Migration File | Contents |
|---|---|
| `20260618_crm_add_sales_rep_role.sql` | **New — hard prerequisite, run first.** `ALTER TABLE user_roles DROP CONSTRAINT chk_user_role` + re-add with `'sales_rep'` included; `CREATE OR REPLACE FUNCTION public.rma_is_staff()` and `public.rma_is_manager_or_above()` with `'sales_rep'` added to their role lists (decide per-function whether sales_rep counts as "staff" — yes — and "manager or above" — no). Without this, `customers` table RLS (`staff_read` policy uses `rma_is_staff()`) blocks sales_rep from reading accounts entirely. |
| `20260619_crm_contacts.sql` | CREATE TABLE contacts (full schema); RLS policies (staff read/write, anon blocked); indexes on customer_id, phone, email |
| `20260620_crm_pipelines.sql` | CREATE TABLE pipelines; INSERT default B2B and B2C pipelines; RLS (staff read; admin write) |
| `20260621_crm_leads.sql` | CREATE TABLE leads (full schema); indexes on assigned_rep, status, source, created_at; RLS (reps see own leads; managers see all) |
| `20260622_crm_deals.sql` | CREATE TABLE deals (full schema); indexes on customer_id, assigned_rep, status, expected_close_date; RLS (reps see own deals; managers see all) |
| `20260623_crm_activities.sql` | CREATE TABLE activities (full schema); indexes on related_id, assigned_rep, due_date, completed_at; RLS (reps see own; managers see all) |
| `20260624_crm_customers_extend.sql` | ALTER TABLE customers ADD COLUMN IF NOT EXISTS lifecycle_stage, lead_source, assigned_rep, last_activity_at. `account_manager` is left untouched (resolved — see Verification Notes; not merged with assigned_rep). |
| `20260625_crm_notification_events.sql` | INSERT new event_type rows into whatsapp_templates for: crm_lead_assigned, crm_deal_won, crm_followup_due, crm_deal_overdue |

---

# 7. Permissions & Role System Extension

## 7.1 New Role: `sales_rep`

A `sales_rep` is a pure CRM-facing role. They should NOT see RMA technician internals (repair queue, parts inventory, tech calendar) by default. They CAN see customers (accounts) to link deals, and they can see invoices to track their own quotes.

| Section | sales_rep Default | Rationale |
|---|---|---|
| leads.* | read, create, edit (own) | Core CRM function |
| deals.* | read, create, edit (own) | Core CRM function |
| activities.* | read, create, edit (own) | Core CRM function |
| customers.* | read, edit (no delete) | Needs account context for deals |
| invoices.* | read (own), create | Convert deal to quote |
| products.* | read only | View catalog to add to deals |
| rma_tickets.* | none | Should not see repair queue |
| inventory.* | none | Not relevant to sales |
| parts.* | none | Not relevant to sales |
| control_panel.* | none | Admin only |
| reports.* | read (own stats only) | See personal sales performance |

> **⚠️ RLS gap to resolve in `20260618_crm_add_sales_rep_role.sql`:** the `customers.* edit` permission above needs server-side enforcement, but the existing `manager_update` RLS policy on `customers` is gated by `rma_is_manager_or_above()` — and sales_rep is deliberately *not* manager-or-above (folding it in would loosen that check everywhere else it's used across the app, not just for customers). **Recommendation:** add a dedicated `sales_rep_update_assigned` policy on `customers` in the same migration — `FOR UPDATE TO authenticated USING (public.rma_user_role() = 'sales_rep' AND assigned_rep = auth.uid())` — scoping edit rights to accounts the rep is actually assigned to, rather than every account. Decide this before Sprint 1, not during it.

## 7.2 New Resource Keys for `canDo()`

Add to `ROLE_DEFAULT_PERMISSIONS` in `src/lib/permissions.ts` and to `src/lib/constants.ts`:

- `leads` — actions: read, create, edit, delete, assign
- `deals` — actions: read, create, edit, delete, assign, change_stage, mark_won, mark_lost
- `activities` — actions: read, create, edit, delete, complete
- `contacts` — actions: read, create, edit, delete
- `pipelines` — actions: read, configure (admin-only)

> **IMPORTANT:** Re-audit `ROLE_DEFAULT_PERMISSIONS` for all existing roles when adding `sales_rep`. A sales rep should almost certainly NOT see technician-only sections. Use the existing permission preview ("view as user") feature in User Management to verify the experience before deploying.

---

# 8. New Pages & Routes

| Route | Page Component | Auth | Description |
|---|---|---|---|
| /leads | src/pages/Leads/index.jsx | sales_rep+ | Lead list with filters (status, source, assigned rep), quick-add modal, convert-to-deal action |
| /pipeline | src/pages/Pipeline/index.jsx | sales_rep+ | Main Kanban board — tabs for B2B / B2C pipelines, drag-and-drop cards, quick-edit slide-out drawer |
| /pipeline/:id | src/pages/Pipeline/DealDetail.jsx | sales_rep+ | Full deal record: details, product lines, activity timeline, notes, convert to quote button |
| /activities | src/pages/Activities/index.jsx | sales_rep+ | Activity list / calendar view — filter by type, rep, overdue. Today's follow-up agenda. |
| /sales-dashboard | Extend existing Dashboard.jsx | sales_rep+ | New sales KPI section added to existing Dashboard (not a new page — new widgets in the existing grid) |

## 8.1 New API Domain Modules

| File | Exports | Notes |
|---|---|---|
| src/api/db/leads.ts | LeadRow, leads.list(), leads.get(), leads.create(), leads.update(), leads.convert() | convert() creates a deal + optionally a customer, sets converted_at |
| src/api/db/deals.ts | DealRow, deals.list(), deals.get(), deals.create(), deals.update(), deals.moveStage(), deals.markWon(), deals.markLost() | moveStage() validates against pipelines.stages — cannot skip to won without going through all required stages |
| src/api/db/activities.ts | ActivityRow, activities.list(), activities.create(), activities.complete(), activities.listOverdue() | listOverdue() = due_date < now() AND completed_at IS NULL |
| src/api/db/pipelines.ts | PipelineRow, pipelines.list(), pipelines.get(), pipelines.update() | Admin-only update; read available to all staff |
| src/api/db/contacts.ts | ContactRow, contacts.list(), contacts.create(), contacts.update(), contacts.delete() | list() takes customer_id filter |

## 8.2 New Constants & Schemas

- Add to `src/lib/constants.ts`: `LEAD_STATUS`, `LEAD_SOURCE`, `DEAL_STATUS`, `ACTIVITY_TYPE`, `CRM_PIPELINE_IDS` (seeded UUIDs for the two default pipelines)
- Add to `src/lib/schemas.ts`: `leadSchema`, `dealSchema`, `activitySchema`, `contactSchema` — all with Zod validation
- Add corresponding unit tests to `src/lib/schemas.test.js` covering valid and invalid inputs for each new schema

---

# 9. Implementation Plan — Sprint-by-Sprint

## 9.1 Pre-Build: Architecture Lock (Before Any Code)

> ⚠️ **These decisions must be made and documented before any migration file is written. Changing them after migration = expensive rollback.**

1. **Apply `20260618_crm_add_sales_rep_role.sql` first, before any other CRM migration.** This is a hard technical gate, not a preference: `chk_user_role` will reject inserting a `sales_rep` row, and `rma_is_staff()` will silently exclude sales_rep from reading `customers` (and every other table gated by that function) until this runs. See Verification Notes and §7.1.
2. Confirm Option A (extend customers table, not rename to accounts). Update `CLAUDE.md` to document this decision.
3. Confirm the pipeline stage names for B2B and B2C pipelines with the QDS sales team. These become the stage strings stored in the deals table — changing them later requires a data migration.
4. Confirm which Supabase project (same as myRMA or a new one). **RECOMMENDATION:** same project, same schema. No second project.
5. ~~Confirm whether `account_manager` should be merged with `assigned_rep`~~ — **resolved, see Verification Notes:** keep separate, `account_manager` is free-text and not mergeable with a FK column without an unscoped cleanup migration.
6. Review and confirm the `sales_rep` role permissions matrix with the sales manager before writing the first permission migration, including the scoped-update RLS policy noted in §7.1.

## 9.2 Sprint 1 — Foundation (Week 1–2)

**Goal:** Database, API modules, permissions, constants — no UI yet.

- Confirm `20260618_crm_add_sales_rep_role.sql` (Sprint 0 prerequisite) is already applied before starting this sprint
- Write migrations: contacts, pipelines (with seed data), leads, deals, activities, customers extension
- Seed the two default pipelines (B2B Dealer, B2C Retail) in the migration
- Add all new constants to `src/lib/constants.ts` (LEAD_STATUS, LEAD_SOURCE, DEAL_STATUS, ACTIVITY_TYPE)
- Add all new Zod schemas to `src/lib/schemas.ts`
- Write all new API domain modules (leads.ts, deals.ts, activities.ts, pipelines.ts, contacts.ts) with RLS-aware helpers
- Export all new Row types from `src/api/db/index.ts`
- Add `sales_rep` role to user_roles table; add new resource keys to `ROLE_DEFAULT_PERMISSIONS` in permissions.ts
- Write unit tests for all new schemas and permissions
- Run `npm test` — all 80+ tests must pass

## 9.3 Sprint 2 — Leads Page (Week 3)

**Goal:** Sales reps can capture and track leads.

- Build `src/pages/Leads/` — list view with status columns, source filters, overdue badge
- Add modal: Create Lead (name, company, phone, source, notes, assign rep)
- Add action: Convert Lead to Deal — opens convert modal, creates deal (and optionally creates new customer account)
- Add bulk CSV import of leads (extend existing parseCSVLine pattern)
- Add route `/leads` to `App.jsx` with `sales_rep+` auth guard
- Add "Leads" to sidebar navigation (gated by `canDo`)
- Add all strings to `en.json` + `ar.json`
- Test: create lead, convert to deal, verify deal appears in deals table

## 9.4 Sprint 3 — Pipeline Kanban (Week 4–5)

**Goal:** The main CRM interface — the Kanban board. This is the highest-value and most-used screen.

- Build `src/pages/Pipeline/index.jsx` — pipeline tabs (B2B / B2C), Kanban columns by stage, deal cards
- Deal cards show: title, customer name, value (EGP), assigned rep avatar, next activity due date, overdue badge
- Drag-and-drop between stages using `@hello-pangea/dnd` (already installed)
- On drop: call `deals.moveStage()` → validate → persist → invalidate query
- Add Deal drawer/modal: create new deal (title, customer, pipeline, stage, value, close date, rep)
- Add Deal detail page `/pipeline/:id`: full record view with product lines, notes, activity timeline
- Add "Won" and "Lost" actions with `lost_reason` required on lost
- Add route `/pipeline` to `App.jsx`
- Add "Pipeline" to sidebar navigation
- Add all strings to `en.json` + `ar.json`

## 9.5 Sprint 4 — Activities & Follow-Ups (Week 6)

**Goal:** Reps never miss a follow-up.

- Build `src/pages/Activities/index.jsx` — "Today" tab (due today), "Overdue" tab, "All" tab
- Activity quick-log panel on deal detail and lead detail pages
- Overdue follow-ups count badge in sidebar next to "Activities"
- Dashboard widget: "Overdue Follow-Ups" count card (red badge, links to Activities page)
- CRM event handlers in `src/lib/events/crmEventHandlers.ts`: register on app load in `App.jsx`
- Notification: WhatsApp template for `crm_followup_due` — morning digest of today's activities (sent via notification-worker)
- Add all strings to `en.json` + `ar.json`

## 9.6 Sprint 5 — Dashboard & Polish (Week 7)

**Goal:** Management visibility. System is now usable end-to-end.

- Add sales KPI section to `Dashboard.jsx`: Total open pipeline value, Deals won this month, Leads created this month, Overdue follow-ups
- Add "Pipeline by Stage" bar chart (Recharts) to `Dashboard.jsx`
- Add Rep Leaderboard card to `Dashboard.jsx` (top 5 reps by deals won this month)
- Add Contacts tab to `CustomerDetails.jsx` (list contacts, add/edit/delete)
- Add "CRM" section to `Reports.jsx`: deals by stage, win/loss rate, leads by source, rep performance table
- QA: test all flows end-to-end with a `sales_rep` test account and a manager test account
- Run `npm test`, `npm run lint`, `npm run build` — all must pass
- Deploy to staging; get feedback from QDS team before production push

---

# 10. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| customers vs. accounts naming causes confusion in the team | High | Medium | Rename to "Accounts" in all UI labels on Day 1 of Phase 1. Update sidebar, page titles, and en.json / ar.json. DB table stays customers. |
| RLS policies for new CRM tables are incomplete | Medium | High | Use the existing migration pattern: every new table gets RLS policies in the same migration file. Test with a sales_rep session (not admin) before deploying. |
| sales_rep role doesn't work at all (not a risk — a confirmed certainty without the fix) | **Certain** without `20260618_crm_add_sales_rep_role.sql` | Critical | `chk_user_role` rejects the role outright; `rma_is_staff()` blocks all shared-table reads including `customers`. This migration must run before Sprint 1 starts — see §6.3 and §9.1. |
| sales_rep accidentally sees RMA internals | Medium | Medium | Use permission preview feature in User Management to simulate a sales_rep session before deploying. Audit ROLE_DEFAULT_PERMISSIONS before Sprint 1 PR is merged. |
| Pipeline stage names locked in data, hard to rename later | Low | High | Confirm stage names with QDS sales manager before Sprint 1. Document the decision in CLAUDE.md. A future rename requires a data migration. |
| Scope creep: Phase 2 features get built before Phase 1 is validated | High | Medium | Hard gate: Phase 2 work must not start until Phase 1 has been in use for 4+ weeks with positive feedback from reps. |
| @hello-pangea/dnd drag performance on mobile (PWA) | Medium | Low | Test Kanban on mobile PWA during Sprint 3. Disable drag on touch if performance is poor; replace with tap-to-move-stage dropdown as fallback. |
| Duplicate customer problem (CRM contact = RMA customer) | Medium | High | Build duplicate detection in Phase 2 (fuzzy phone match on lead/contact save). Communicate to team: always search existing customers before creating new lead/account. |
| JSONB key-order issue in deals.product_lines or pipelines.stages | Low | High | All ordered data in JSONB must use arrays, never objects. The CONSTITUTION.md §7.5a already mandates this. Review all JSONB fields in new migrations before applying. |
| WhatsApp notification volume spikes (too many CRM notifications) | Medium | Low | Make each CRM notification type (lead_assigned, followup_due, deal_won) individually toggleable in WASettings.jsx, same pattern as existing ticket notifications. |

---

# 11. Files Changed / Created — Complete Checklist

This is the exhaustive list of every file that must be created or modified in `D:\myrma-app` to complete Phase 1 of the CRM upgrade.

## 11.1 New Files (Create)

| File | Description |
|---|---|
| supabase/migrations/20260618_crm_add_sales_rep_role.sql | **Prerequisite.** chk_user_role constraint + rma_is_staff()/rma_is_manager_or_above() updates + scoped customers update policy for sales_rep |
| supabase/migrations/20260619_crm_contacts.sql | contacts table + RLS |
| supabase/migrations/20260620_crm_pipelines.sql | pipelines table + seed data |
| supabase/migrations/20260621_crm_leads.sql | leads table + indexes + RLS |
| supabase/migrations/20260622_crm_deals.sql | deals table + indexes + RLS |
| supabase/migrations/20260623_crm_activities.sql | activities table + indexes + RLS |
| supabase/migrations/20260624_crm_customers_extend.sql | ALTER customers + add lifecycle_stage etc. (account_manager untouched) |
| supabase/migrations/20260625_crm_notification_events.sql | Seed new WhatsApp event types |
| src/api/db/leads.ts | Lead CRUD domain module |
| src/api/db/deals.ts | Deal CRUD domain module |
| src/api/db/activities.ts | Activity CRUD domain module |
| src/api/db/pipelines.ts | Pipeline read + admin update module |
| src/api/db/contacts.ts | Contact CRUD domain module |
| src/pages/Leads/index.jsx | Leads list page |
| src/pages/Pipeline/index.jsx | Kanban pipeline page |
| src/pages/Pipeline/DealDetail.jsx | Deal detail page |
| src/pages/Activities/index.jsx | Activities list page |
| src/lib/events/crmEventHandlers.ts | CRM notification event handlers |

## 11.2 Modified Files (Edit)

| File | Change Required |
|---|---|
| src/api/db/index.ts | Export all new Row types and domain modules |
| src/api/supabaseClient.js | Expose new db.leads, db.deals, db.activities, db.pipelines, db.contacts helpers |
| src/lib/constants.ts | Add LEAD_STATUS, LEAD_SOURCE, DEAL_STATUS, ACTIVITY_TYPE, CRM_PIPELINE_IDS |
| src/lib/schemas.ts | Add leadSchema, dealSchema, activitySchema, contactSchema |
| src/lib/permissions.ts | Add sales_rep to ROLE_DEFAULT_PERMISSIONS with CRM resource keys |
| src/lib/events/ticketEventHandlers.ts | Import and call registerCrmEventHandlers() alongside existing handlers |
| src/App.jsx | Add /leads, /pipeline, /pipeline/:id, /activities routes; import new pages; add sales_rep role check |
| src/locales/en.json | Add all new CRM translation keys |
| src/locales/ar.json | Add all new CRM Arabic translation keys (must be simultaneous with en.json) |
| src/pages/Dashboard.jsx | Add sales KPI widgets section (total deal value, deals won, overdue follow-ups, pipeline bar chart) |
| src/pages/CustomerDetails.jsx | Add Contacts tab, add Deals tab (list open/won deals for this account) |
| src/pages/Reports.jsx | Add CRM reports section: win/loss rate, leads by source, rep performance |
| src/pages/ControlPanel.jsx | Add Pipeline Config sub-page (admin can edit pipeline stage names) |
| CLAUDE.md | Document the customers-as-accounts decision, new routes, new domain modules, new role |
| docs/archive/AUDIT_LOG.md | Add CRM upgrade changelog entries |

---

# 12. Definition of Done for Phase 1

Phase 1 is complete when **ALL** of the following are true:

1. All 7 migration files have been applied to production Supabase. No ad-hoc SQL was run outside migration files.
2. All new constants are in `src/lib/constants.ts` — zero magic strings in new code.
3. All new schemas are in `src/lib/schemas.ts` with unit tests. `npm test` passes with 0 failures.
4. All new API modules are in `src/api/db/` and export their Row types from `index.ts`.
5. The `sales_rep` role is in `user_roles` and `ROLE_DEFAULT_PERMISSIONS`. Permission preview confirms sales reps cannot see RMA technician sections.
6. `/leads` page: sales rep can create a lead, edit it, convert it to a deal.
7. `/pipeline` page: deal appears on the Kanban board in the correct stage column. Dragging it between columns persists the change.
8. A deal can be marked Won and Lost (with required `lost_reason`). Won/Lost deals are excluded from the active pipeline Kanban by default.
9. Activities can be logged against a deal. Overdue activities show a badge on the Kanban card.
10. Dashboard shows at minimum: Total open deal value, Deals won this month, Overdue follow-ups count.
11. `CustomerDetails.jsx` shows a Contacts tab (add/view contacts) and a Deals tab (open/won deals for that account).
12. All UI strings are translated in both `en.json` and `ar.json`. No hardcoded English in new components.
13. Dark mode works correctly on all new pages (Direction B design tokens used throughout).
14. `npm test`, `npm run lint`, `npm run build` all pass with zero errors.
15. At least one QDS sales rep and one manager have used the system for one full sales cycle (lead → deal → won/lost) and confirmed the workflow matches their actual process.

---

# 13. Relationship to Existing myRMA Architecture

This section confirms that the CRM upgrade does not break or conflict with any existing myRMA feature.

| Existing Feature | CRM Impact | Action Required |
|---|---|---|
| RMA Tickets | None — rma_tickets table is untouched. Sales reps cannot see it (permission gating). | None |
| Customers page | Renamed to "Accounts" in UI only. Table and API unchanged. Add Contacts sub-tab and Deals sub-tab to CustomerDetails.jsx. | Minor UI additions |
| Products catalog | Reused as-is in deals.product_lines. No changes to products table. | None |
| Invoices module | Reused in Phase 2 (deal → quote conversion). Phase 1 has no impact. | Phase 2 only |
| WhatsApp notifications | Extended with 4 new CRM event_types. Existing RMA templates are untouched. | Add new template rows to whatsapp_templates |
| Dashboard | New sales KPI section added below existing RMA KPI section. | Additive only — existing widgets unchanged |
| Reports | New CRM section added. Existing RMA reports untouched. | Additive only |
| ControlPanel | New Pipeline Config sub-page added. Existing sub-pages untouched. | Additive only |
| Permission system | New sales_rep role and new resource keys added. Existing roles get the new CRM keys set to false by default. | Update ROLE_DEFAULT_PERMISSIONS; re-run resolvePermissions audit |
| AI Assist (ai-assist Edge Function) | No Phase 1 impact. Phase 3 may extend it for deal scoring. | Phase 3 only |
| Audit log | All new CRM mutations (create lead, move deal stage, mark won/lost) automatically trigger audit log via the existing db.audit write queue. | Use existing audit.ts write pattern in new domain modules |

---

*myRMA CRM Upgrade Study v1.0 · QDS Egypt · June 2026 · Benchmarked against Odoo CRM 19.0 and Zoho CRM 2026*
