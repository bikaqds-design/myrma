# Phase 1 Data Model: CRM Upgrade — Sprint 1 Foundation

Source of truth for field-level detail: CRM_UPGRADE_STUDY.md §6.2 (verified against the live schema). This document adds relationships, validation rules, and state transitions not fully spelled out there.

## Entity: `contacts` (new table)

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| customer_id | uuid | FK → `customers.id` ON DELETE CASCADE, NOT NULL |
| full_name | text | NOT NULL |
| title | text | nullable |
| phone | text | nullable |
| email | text | nullable |
| is_primary | boolean | default `false` |
| notes | text | nullable |
| created_at | timestamptz | default `now()` |
| created_by | text | creator's email, nullable — **changed from `uuid FK -> auth.users` during Sprint 2**: same fix as `assigned_rep`, see `20260629_crm_created_by_use_email.sql` |

**Relationships**: many contacts → one customer (account). A `deals.contact_id` may reference one of an account's contacts as the deal's primary point of contact.

**Validation rules** (`contactSchema` in `src/lib/schemas.ts`):
- `full_name`: required, min 1 char
- `email`: optional, valid email format if present
- `customer_id`: required, must reference an existing customer
- At most one contact per `customer_id` may have `is_primary = true` — enforced at the application layer in `contacts.create()`/`contacts.update()` (unsetting any prior primary before setting a new one), not a DB constraint, matching the existing soft-business-rule pattern used elsewhere in this codebase (e.g. ticket status transitions).

## Entity: `pipelines` (new table)

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| name | text | NOT NULL |
| stages | jsonb | NOT NULL — **array** of `{id, name, order, probability_default, is_won, is_lost}` |
| is_active | boolean | default `true` |
| created_at | timestamptz | default `now()` |

**Seed data** (inserted by the migration, not application code):
- **B2B Dealer Pipeline**: New Lead (10%) → Contacted (20%) → Needs Assessment (40%) → Quote Sent (60%) → Negotiation (75%) → Won / Lost
- **B2C Retail Pipeline**: New Inquiry (10%) → Contacted (30%) → Quote Sent (60%) → Won / Lost

**Validation rules**:
- `stages` array MUST contain exactly one stage with `is_won: true` and exactly one with `is_lost: true` — validated in `pipelines.update()` before persisting an admin-edited pipeline (Sprint 2+ feature; Sprint 1 only needs the seeded defaults to satisfy this, which they do by construction).
- Stage `id` values within a pipeline MUST be unique — referenced by `deals.stage`.

## Entity: `leads` (new table)

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| full_name | text | NOT NULL |
| company_name | text | nullable |
| phone | text | nullable |
| email | text | nullable |
| source | text | NOT NULL — `LEAD_SOURCE` enum |
| status | text | NOT NULL, default `'new'` — `LEAD_STATUS` enum |
| assigned_rep | text | rep's email, nullable (unassigned leads exist before triage) — **changed from `uuid FK -> auth.users` during Sprint 2**: the client can't resolve another user's `auth.users.id` (protected schema, not queryable via PostgREST); switched to email to match the existing `rma_tickets.assigned_technician` convention, see `20260628_crm_assigned_rep_use_email.sql` |
| notes | text | nullable |
| converted_at | timestamptz | nullable |
| converted_customer_id | uuid | FK → `customers.id`, nullable |
| converted_deal_id | uuid | FK → `deals.id`, nullable |
| created_at | timestamptz | default `now()` |
| created_by | text | creator's email, nullable — see `contacts.created_by` above for why this is text, not a uuid FK |
| updated_at | timestamptz | nullable |

**State transitions** (`LEAD_STATUS`): `new → contacted → qualified → (converted, terminal)` or `→ disqualified (terminal)` at any point from `new`/`contacted`/`qualified`. `nurturing` and `inactive` (added Sprint 2, see `20260701_crm_leads_add_statuses.sql`) are non-terminal side states reachable from any non-terminal status — `nurturing` for leads still being actively worked but not buying-ready, `inactive` for leads gone cold; both remain reactivatable back to any non-terminal status, matching current CRM best practice (5–7 action-oriented statuses) rather than a strict linear funnel. Once `converted_at` is set, the lead is immutable except for `notes` — `leads.convert()` is the only path that sets `converted_*` fields, and the API module should reject further status changes on an already-converted lead.

**Relationships**: A converted lead points to exactly one customer (new or matched-existing) and exactly one deal. A lead before conversion has neither.

**Validation rules** (`leadSchema`):
- `full_name`: required
- `source`: required, must be one of `LEAD_SOURCE` values
- `status`: must be one of `LEAD_STATUS` values, defaults to `'new'` on create
- At least one of `phone`/`email` should be present (a lead with no contact method is not actionable) — soft validation (warning, not hard reject) since walk-in leads occasionally lack both initially.

## Entity: `deals` (new table)

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| title | text | NOT NULL |
| customer_id | uuid | FK → `customers.id`, NOT NULL |
| contact_id | uuid | FK → `contacts.id`, nullable |
| pipeline_id | uuid | FK → `pipelines.id`, NOT NULL |
| stage | text | NOT NULL — must match a stage `id`/`name` present in `pipelines.stages` for this deal's `pipeline_id` |
| value | numeric(12,2) | nullable |
| probability | integer | default `0`, range 0–100 |
| expected_close_date | date | nullable |
| assigned_rep | text | rep's email, nullable — see `leads.assigned_rep` above for why this is text, not a uuid FK |
| product_lines | jsonb | NOT NULL default `'[]'` — **array** of `{product_id, product_name, qty, unit_price}` |
| status | text | NOT NULL, default `'open'` — `DEAL_STATUS` enum: open / won / lost |
| lost_reason | text | nullable — **required** (application-layer check) when `status = 'lost'` |
| won_at | timestamptz | nullable |
| lost_at | timestamptz | nullable |
| notes | text | nullable |
| created_at | timestamptz | default `now()` |
| created_by | text | creator's email, nullable — see `contacts.created_by` above for why this is text, not a uuid FK |
| updated_at | timestamptz | nullable |

**State transitions** (`DEAL_STATUS`): `open → won` (terminal, sets `won_at`) or `open → lost` (terminal, sets `lost_at`, requires `lost_reason`). A won/lost deal's `stage` should land on whichever pipeline stage has `is_won`/`is_lost: true`. No transition out of `won`/`lost` in Sprint 1 (re-opening a closed deal is an explicit non-goal — not in the study's Phase 1 scope).

**Relationships**: many deals → one customer (account); optionally one contact; exactly one pipeline. `deals.moveStage()` is the only sanctioned path to change `stage` outside of creation.

**Validation rules** (`dealSchema`):
- `title`, `customer_id`, `pipeline_id`, `stage`: required
- `stage` value validated against the referenced pipeline's `stages` array at write time (FR-011) — this is an application-layer check inside `deals.create()`/`deals.moveStage()`, not a DB constraint (see research.md §4 for why)
- `lost_reason`: required when `status` transitions to `'lost'`

## Entity: `activities` (new table)

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| related_type | text | NOT NULL — enum: lead / deal / customer / contact |
| related_id | uuid | NOT NULL — polymorphic FK (no DB-level FK constraint possible across multiple tables; application-layer integrity) |
| type | text | NOT NULL — `ACTIVITY_TYPE` enum: call / meeting / whatsapp / email / note / task |
| title | text | NOT NULL |
| due_date | timestamptz | nullable |
| completed_at | timestamptz | nullable — `NULL` = pending/overdue |
| assigned_rep | text | rep's email, nullable — see `leads.assigned_rep` above for why this is text, not a uuid FK |
| outcome_notes | text | nullable |
| created_at | timestamptz | default `now()` |
| created_by | text | creator's email, nullable — see `contacts.created_by` above for why this is text, not a uuid FK |

**Derived state**: "Overdue" = `due_date < now() AND completed_at IS NULL` — computed at query time (`activities.listOverdue()`), not a stored column, to avoid a stale-flag bug (a denormalized `is_overdue` boolean would need a cron job to stay correct; a computed query does not).

**Relationships**: polymorphic — `related_id` may point to a `leads`, `deals`, `customers`, or `contacts` row depending on `related_type`. No referential integrity constraint at the DB level for this reason; `activities.create()` should validate the referenced row exists before insert as an application-layer check.

**Validation rules** (`activitySchema`):
- `related_type`, `related_id`, `type`, `title`: required
- `type` must be one of `ACTIVITY_TYPE` values

## Entity: `customers` (extended, existing table)

New columns added via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`:

| Column | Type | Default | Purpose |
|---|---|---|---|
| lifecycle_stage | text | `'customer'` | Enum: lead / prospect / customer / churned |
| lead_source | text | `NULL` | How this account was acquired |
| assigned_rep | text | `NULL` | CRM deal-owner's email — **separate from** `account_manager`; see `leads.assigned_rep` above for why this is text, not a uuid FK |
| last_activity_at | timestamptz | `NULL` | Denormalized — updated by trigger when any `activities` row referencing this customer (or a deal/lead/contact belonging to it) is created |

**Explicitly unchanged**: `account_manager` (existing free-text column) — not merged, not deprecated. See research.md and the spec's Assumptions for why.

**`last_activity_at` trigger note**: Sprint 1 should include a trigger (or the application layer should update it directly in `activities.create()`) — whichever is simpler to implement correctly is acceptable; this is an implementation detail left to the task-breakdown phase (`/speckit-tasks`), not specified further here.
