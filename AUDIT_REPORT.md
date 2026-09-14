# myCRM / myRMA 2.0 — Full Audit Report

**Date:** 2026-09-03
**Repository:** `D:\myrma-app` @ `dde31c3` (branch HEAD, working tree clean apart from two untracked files)
**Live database audited:** Supabase project `myrma-production` (`ohkynosgscfygtjxbpxq`, eu-west-1, Postgres 17.6)
**Scope:** frontend (React 18 + Vite), data layer (`src/api/**`), 11 Supabase Edge Functions, live RLS policies / RPCs / triggers / storage / cron, CI and build configuration, dependencies.
**Method:** static review of every module listed in the inventory, real execution of the static toolchain, read-only SQL against the live project, and a small number of **rolled-back** row-level-security probes (each ran inside a `DO` block that ends in `RAISE EXCEPTION`, so nothing was committed). No application code was modified. This file is the only artifact created.

> Important caveat carried through the whole report: the repository's migration files are known **not** to describe the live database (the project's own `PRELAUNCH_REVIEW.md` says so, and `supabase_migrations.schema_migrations` holds a single version). Every policy, function and constraint quoted below was therefore read from the **live** catalog, not from the SQL files.

---

## 1. Executive Summary

| Severity | Count |
|---|---|
| Critical | 4 |
| High | 17 |
| Medium | 33 |
| Low | 23 |
| Informational | 6 |
| **Total** | **83** |

Of the 83 findings, 26 are **confirmed by execution** (a command, query or rolled-back probe produced the evidence), 54 are **confirmed by code reading** (the defect is unambiguous in source or live catalog text), and 3 are **suspected** (design recommendations or settings the tooling could not read).

### Top 10 to fix first

1. **BUG-001 — any signed-in staff member, including `viewer`, can insert rows directly into `payments` / `vendor_payments`.** Probe as a live viewer account succeeded. A fabricated "active" payment immediately appears on the customer statement and reduces receivables. **— FIXED, see the finding for verification detail.**
2. **BUG-002 — a sales rep can rewrite their own *posted* invoice** (amount_paid, payment_status, total, line_items, inv_code, customer_id) through the REST API. The `manager_update_crm_invoices` policy has no `WITH CHECK` and nothing locks a posted row. The same shape exists on credit notes, payments and vendor payments. **— FIXED, see the finding for verification detail.**
3. **BUG-003 — the `rma-attachments` bucket is public and listable, has no size or MIME limit, any authenticated user can delete or overwrite any object, and anonymous visitors can upload without limit.** The live storage policies are not the ones in `20260527_storage_bucket_policies.sql`. **— FIXED, see the finding for verification detail.**
4. **BUG-004 — every document approval is enforced only in the UI.** A sales rep can set their sales order to `delivered` (skipping stock reservation) and a manager can approve their own purchase order or vendor invoice by writing `status` directly. **— FIXED, see the finding for verification detail.**
5. **BUG-005 — customer notifications have not been delivered by the scheduler since 2026-06-13.** The `drain-notification-queue` cron job sends no Authorization header and every call is rejected `401` because the function has `verify_jwt` on. 351 jobs are pending, 341 of them overdue-ticket emails that will all send the moment the drain is fixed. **— FIXED, see the finding for verification detail.**
6. ~~**BUG-007 — Supabase Realtime is not publishing any table.** Every `postgres_changes` subscription in the app (notifications bell, dashboard, leads, customers, inventory, deal comments) is dead.~~ **FIXED 2026-09-06** — the seven subscribed tables are published, RLS scoping verified through `realtime.apply_rls()` itself.
7. **BUG-008 — updates filtered out by RLS are reported as success.** A technician editing a ticket not assigned to them gets "Ticket updated", an activity-log entry, notifications and customer emails for a change that never happened.
8. **BUG-010 / BUG-011 — direct table writes let technicians un-reserve stock held by sales orders and let viewers edit every notification, write ticket resolutions and change the company-wide appearance.**
9. **BUG-013 — a credit note raised from an invoice ignores the invoice's discount and tax**, so the amount credited is wrong whenever either applies.
10. **BUG-014 / BUG-016 — the repository cannot be trusted as a description of production** (migration history is broken) **and CI is red on HEAD** (`lint:ci` fails: 2406 warnings against a cap of 2391).

---

## 2. Environment & Commands Run

All commands were executed from `D:\myrma-app` on 2026-09-03 (Windows 11, Node 24.15.0, npm 11). Exit codes are the real ones.

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `npx vitest run` | 0 | **45 files, 1184 tests passed**, 101.5 s |
| 2 | `npx eslint src -f json` | 0 | **0 errors, 2406 warnings** (2398 `no-restricted-syntax` hardcoded-text UI guard, 5 `no-unused-vars` in `src/test`, 3 `react-hooks/exhaustive-deps`) |
| 3 | `npm run lint:ci` | **1** | `ESLint found too many warnings (maximum: 2391)` — the CI lint gate fails on HEAD |
| 4 | `npx prettier --check src` | **1** | `Code style issues found in 259 files` |
| 5 | `npx tsc --noEmit -p tsconfig.json` (via `npx -p typescript@5`; there is no `typecheck` script in `package.json`, and `typescript` is not a devDependency — the first attempt printed "This is not the tsc command you are looking for") | **2** | **83 errors**: 35 × TS7016 (no declaration for `.js` imports — `allowJs` unset), 24 × TS7006 implicit any, 18 × TS2339, 2 × TS2352, 1 × TS7053, 1 × TS2345, 1 × TS2322, 1 × TS2307 (`src/lib/messaging/providers/WhatsAppProvider.ts` imports a path that does not exist) |
| 6 | `npx vite build` | 0 | Built in 13.7 s, PWA precache 90 entries (5.07 MB); one chunk-size warning (>500 kB). A first attempt run concurrently with tsc + eslint crashed with `[vite:esbuild-transpile] The service was stopped` (Go runtime OOM) — resource exhaustion, not a code defect; rerun alone passed |
| 7 | `npm audit --json` | **1** | 15 vulnerabilities: 0 critical, **11 high**, 2 moderate, 2 low (details in BUG-017 and Appendix A) |
| 8 | `npm outdated` | 0 | 58 outdated packages; security-relevant: `react-router-dom 7.15.1 → 7.18.3`, `vite 6.4.2 → 6.4.3`, `@supabase/supabase-js 2.105.4 → 2.114.0` |
| 9 | `npx vitest run --coverage` | see §6 | Coverage numbers in §6 |
| 10 | `grep` sweeps for `TODO/FIXME/HACK/XXX`, `console.log`, hardcoded secrets (`eyJ…`, `api_key=…`), `dangerouslySetInnerHTML`, `eval` | – | No TODO/FIXME/HACK; `XXX` only in phone placeholders; **0** `console.log` outside tests; no committed secrets (`.env` is gitignored and holds only the two `VITE_` values; seed scripts read the service key from `process.env`); no `dangerouslySetInnerHTML`/`eval` in app code |
| 11 | `npm run test:db` | not run | Requires Docker + `supabase start`; the project has documented that this job cannot pass (13 core tables are never created by any migration) and it is disabled in CI with `if: false` |
| 12 | `npm run test:integration` | not run | Needs `VITE_SUPABASE_*` in the environment of the test process; it only asserts anonymous refusals (see BUG-061) |
| 13 | Supabase MCP `get_advisors` (security, performance) | – | Security: 74 WARN (57 authenticated-executable SECURITY DEFINER functions, 15 anon-executable ones, `pg_net` in `public`, leaked-password protection off). Performance: 116 `multiple_permissive_policies`, 25 `unindexed_foreign_keys`, 19 `unused_index`, 3 `auth_rls_initplan`, `net._http_response` bloat |
| 14 | ~25 read-only SQL queries against the live project (catalog, policies, functions, triggers, constraints, storage, cron, `net._http_response`, integrity checks) | – | Quoted inline in the findings |
| 15 | 5 rolled-back RLS probes (`DO $$ … RAISE EXCEPTION $$` under `SET LOCAL ROLE authenticated` with a real user's email in `request.jwt.claims`) | – | Results in BUG-001, 010, 011; one probe (sales-rep invoice update) was blocked by the tool's safety classifier and is therefore reported as confirmed-by-code-reading only |

---

## 3. Project Inventory

### 3.1 Stack

| Layer | Technology |
|---|---|
| Frontend | React 18.3, Vite 6.4, React Router 7.15, TailwindCSS 3.4, Radix UI, TanStack Query 5, react-hook-form + zod, i18next (en/ar, RTL), framer-motion, recharts, jsPDF + html2canvas, pdfjs-dist (client-side PDF text extraction), xlsx, vite-plugin-pwa (Workbox) |
| Backend | Supabase: Postgres 17 (62 tables, 6 views, ~90 functions, 29 triggers, 199 RLS policies), GoTrue auth (email/password, TOTP MFA), Storage (1 bucket `rma-attachments`), 11 Deno Edge Functions, pg_cron (2 jobs), pg_net |
| Hosting | Vercel (SPA rewrite + security headers in `vercel.json`), Sentry (optional) |
| Data access | Single anon-key `supabase-js` client (`src/api/client.js`); all queries in `src/api/db/*.ts` (29 modules) plus `auth.js`, `storage.js`, `backup.js`, `email.js`, `ai.js`, `kbChat.js`, `branding.js` |
| Tests | Vitest (unit, jsdom, 45 files), Vitest integration tier (anonymous-only, hosted DB), SQL assertion files under `supabase/tests/` (not runnable) |

Size: 290 files / 88,345 lines under `src/`; 61,488 lines of pages/components; largest files `Reports.jsx` (1,976), `CustomerDetails.jsx` (1,914), `RMATickets/index.jsx` (1,792), `App.jsx` (1,839).

### 3.2 Routes (client) and their guards

Route guard: `RouteGuard` in `App.jsx` maps a path prefix to `canDo(role, permissions, section, action)`; unlisted paths need only a session. `admin`/`super_admin` bypass `canDo` entirely.

| Path | Component | Auth | Permission checked |
|---|---|---|---|
| `/tracker` | `RMATracker` | **none** | — (talks only to the `public-track` function) |
| `/kb` | `KnowledgeBasePublic` | **none** | — (reads `kb_articles` where `is_published`) |
| `/set-password` | `ResetPassword` (invite mode) | session (pending role allowed) | — |
| `/` , `/dashboard` | `Dashboard` | session + active role | none (widgets self-gate) |
| `/account` | `AccountSettings` | session | none |
| `/products`, `/products/:id` | `Products`, `ProductDetails` | session | `products.view` |
| `/knowledge-center` | `KnowledgeCenter` | session | `products.view` |
| `/customers`, `/customers/:id` | `Customers`, `CustomerDetails` | session | `customers.view` |
| `/leads`, `/leads/:id` | `Leads`, `LeadDetails` | session | `leads.view` |
| `/pipeline`, `/pipeline/:id` | `Pipeline`, `DealDetail` | session | `deals.view` |
| `/activities` | `Activities` | session | `deals.view` (route table) **or** `leads.view` (inline check) — the two disagree |
| `/sales`, `/sales/:type/:id` | `SalesDocuments`, `SalesDocumentDetail` | session | `sales.view` |
| `/accounting` | `Accounting` | session | `accounting.view` |
| `/purchasing`, `/purchasing/vendor/:id`, `/purchasing/:type/:id` | `Purchasing`, `VendorDetails`, `PurchaseDocumentDetail` | session | `purchasing.view` |
| `/rma-tickets` | `RMATickets` | session | `rma_tickets.view_all` |
| `/inventory` | `Inventory` | session | `inventory.view` |
| `/calendar` | `TechCalendar` | session | `calendar.view` |
| `/reports` | `Reports` | session | `reports.view` |
| `/control-panel` | `ControlPanel` (24 sections) | session | `role ∈ {admin, super_admin}` (role check, not permission) |
| `*` | `NotFoundPage` | session | — |

### 3.3 Server endpoints

**Edge Functions** (all deployed with `verify_jwt = true`, so the API gateway requires *some* Supabase JWT — the public anon key satisfies it):

| Function | Caller | Auth inside the function | Notes |
|---|---|---|---|
| `public-track` | anonymous tracker | none (service role inside; in-memory rate limit 15/min/instance) | lookup / comments / addComment |
| `send-email` | notification-worker (service key) or browser (user JWT) | service key **or** active `admin`/`super_admin` | Resend relay; HTML-escapes variables |
| `notification-worker` | pg_cron, browser fire-and-forget, Test Center | `WORKER_SECRET` header, **or** any non-viewer staff JWT, **or** literal header `x-trigger-source: pg_cron` | drains `notification_queue` (10 jobs/run) |
| `send-whatsapp` | browser | any non-viewer staff JWT (no status check) | Meta Cloud API |
| `whatsapp-webhook` | Meta | `hub.verify_token` on GET; **nothing** on POST | unreachable in practice (verify_jwt) |
| `admin-reset-password` | browser | `super_admin` (status **not** checked) | also creates auth users |
| `admin-invite-user` | browser | active `super_admin` | invite / revoke |
| `admin-delete-user` | browser | active `super_admin` | role row then auth user |
| `manage-sessions` | browser | any user (own data) | `list` only; `revoke` documented but not implemented |
| `ai-assist` | browser | any authenticated user (role/status **not** checked) | NVIDIA LLM |
| `kb-chat` | browser | any authenticated user; retrieval runs under the caller's RLS | streaming NDJSON |

**RPCs called by the app** (all `SECURITY DEFINER`, executable by `authenticated`): `adjust_part_quantity`, `adjust_stock`, `apply_credit_note_to_invoice`, `apply_payment_to_invoice`, `apply_vendor_payment_to_invoice`, `approve_sales_order`, `archive_warehouse`, `cancel_sales_order`, `convert_quotation_to_so`, `crm_convert_lead`, `delete_customer_cascade`, `delete_customers_cascade`, `generate_doc_code`, `issue_credit_note`, `mark_notifications_read`, `move_rma_units`, `post_invoice`, `promote_rma_unit`, `recalculate_stock`, `receive_stock`, `receive_vendor_invoice`, `record_payment`, `record_vendor_payment`, `reject_sales_order`, `restore_units`, `reverse_*_application` (3), `rma_accept_invitation`, `rma_document_counters`, `rma_search_by_serial`, `rma_staff_directory`, `rma_vi_landed_unit_costs`, `transfer_stock`, `void_credit_note`, `void_invoice`, `void_payment`, `void_vendor_payment`. Internal primitives (`reserve_units`, `deliver_units`, `nextval_for_type`, `_reverse_*`, …) are correctly revoked from `anon`/`authenticated`.

**Cron:** `queue-overdue-ticket-emails` daily 08:00 (SQL); `drain-notification-queue` every 2 min (`net.http_post` to `notification-worker`, **no Authorization header**).

### 3.4 Roles and where they are enforced

Seven built-in roles plus custom roles (`custom_roles.base_role` decides RLS treatment). Status ∈ `active | suspended | locked | deactivated | pending`; expiry via `access_expires_at`. All of this resolves through one SQL function, `rma_user_role()`, which returns NULL for any non-current account, so every policy helper (`rma_is_staff`, `rma_is_manager_or_above`, `rma_is_admin`, `rma_can_handle_cash`) fails closed for suspended users. **Live user_roles:** 2 super_admin, 2 admin, 3 manager, 4 sales_rep, 4 technician, 2 viewer (all active).

| Role | Client-side model (`src/lib/permissions.ts`) | Server-side model (RLS helpers) |
|---|---|---|
| `super_admin` / `admin` | `canDo()` returns `true` for everything; Control Panel gated on role | `rma_is_admin()` |
| `manager` | full CRUD minus delete on most sections; no `purchasing.approve` | `rma_is_manager_or_above()` — **no distinction from admin on purchase/sales tables** |
| `accountant` | cash only + read-only documents | `rma_can_handle_cash()`; dedicated `accountant_read_*` policies |
| `sales_rep` | own leads/deals/activities/sales docs; products read; customers edit-assigned | `rma_user_role() = 'sales_rep' AND assigned_rep/created_by = me` |
| `technician` | tickets: `edit_assigned`, `change_status`; inventory `resolve_units`; parts adjust | `rma_is_staff() AND role <> 'viewer'` on inventory/tickets; ticket update only when `assigned_technician = me` |
| `viewer` | read-only everywhere (`inventory.export` true) | `rma_is_staff()` — **which grants several write policies, see BUG-011** |
| custom | permission map on `custom_roles`, narrows base role | resolved to `base_role` |

The permission matrix (expected vs actual for every role × resource) is in §5.

### 3.5 Core business workflows

| # | Workflow | Entry point | Server-side atomicity |
|---|---|---|---|
| W1 | RMA ticket create → inventory units → RMA location moves → notifications/emails/WhatsApp/webhooks/automation | `RMATickets/TicketForm.jsx` | ticket insert only; units, moves, notifications are fire-and-forget client calls |
| W2 | Ticket edit / status / assignment / product status → auto-move units between 8 system warehouses | `TicketForm.jsx`, `RMATickets/index.jsx` (bulk) | `move_rma_units` RPC |
| W3 | Ticket comments (internal/public) + public tracker replies + attachments | `TicketDrawer.jsx`, `RMATracker.jsx`, `public-track` | direct inserts |
| W4 | Ticket resolution → credit note from ticket → ticket closed | `TicketDrawer.jsx` | `issue_credit_note` then separate ticket update |
| W5 | Lead → convert → customer + deal | `Leads/*` | `crm_convert_lead` RPC |
| W6 | Deal stages / won / lost / reopen; quotations per deal | `Pipeline/*` | client writes with client-side stage validation |
| W7 | Quotation → (approval activity) → accepted → sales order → (approval) → approved = reserve stock + delivered → invoice draft → (approval) → posted = gapless code + deliver stock + COGS | `SalesDocuments/*`, `Activities/index.jsx` | `convert_quotation_to_so`, `approve_sales_order`, `post_invoice` RPCs; **approval decision itself is a client write** |
| W8 | Payments (AR) record/apply/void/reverse; credit notes issue/apply/void; customer ledger + aging | `Accounting/*`, `SalesDocumentDetail.jsx` | `record_payment`, `apply_*`, `void_*`, `reverse_*` RPCs; ledger is a view |
| W9 | Purchase order → vendor invoice → (approval) → receive = stock in + landed cost + gapless VI code + PO completion; vendor payments (AP) | `Purchasing/*` | `receive_vendor_invoice`, `record_vendor_payment` RPCs; approval is a client write |
| W10 | Stock receive / transfer / adjust / recalculate; promote RMA unit to sellable; warehouse archive | `Inventory/*` | RPCs; **plus** legacy direct-mutation paths (`transferUnits`, `resolveUnits`, batches) |
| W11 | User management: invite, create-with-password, role change, permission override, suspend/lock/deactivate/expire, delete, custom roles, permission preview | `UserManagement/*` + 3 admin functions | mixed |
| W12 | Backup export (60 tables) / restore (upsert in FK order) | `BackupRestore.jsx`, `api/backup.js` | non-transactional |
| W13 | Knowledge Center: PDF upload → client-side text extraction → full-text search → LLM chat | `KnowledgeCenter.jsx`, `_KnowledgeUpload.jsx`, `kb-chat` | — |
| W14 | Notifications: in-app (`notifications` table + Realtime), email (Resend via `send-email`), WhatsApp (queue → worker → Meta), overdue-ticket cron | event bus in `src/lib/events` | see BUG-005/006/007 |
| W15 | Control panel configuration: SLA, automation rules, webhooks, custom fields, currencies, document numbering, branding, appearance, AI settings | `pages/cp/*` | `rma_config` rows |

---

## 4. Findings

Findings are grouped by severity. IDs are sequential across the whole report.

> **Document-integrity note (2026-09-06).** Twelve High findings — BUG-006, 008, 009, 010, 011, 012, 013, 014, 015, 016, 017 and 018 — were counted in the severity table above and referenced throughout this report (the Top 10, the permission matrix, the test-coverage list, and inside other findings) but their write-ups were missing from section 4.2: the section held 3 blocks where the summary claimed 15. The originals were recovered verbatim from the audit session transcript and restored here, and every DB- or code-level claim in them was re-checked against the live project on 2026-09-06 before being reinstated — the results are recorded as "Re-verified" lines on the affected findings. One consequence of the gap is worth stating plainly: **remediation was prioritised from a list in which most of the High tier was invisible**, which is why fixing jumped from the Criticals to selected Mediums. BUG-018 was fixed during that period anyway; its status lines had been appended to BUG-005’s block and have been moved to their own finding. The report now contains 80 findings with IDs BUG-001–BUG-080, each appearing exactly once. BUG-079 and BUG-080 were both found on 2026-09-06 during remediation — while verifying BUG-011 and while scoping BUG-008 respectively — and appended then.

### 4.1 Critical

#### [CRITICAL] Any staff account can insert payment rows directly, bypassing the payment RPCs

* ID: BUG-001
* Category: Permissions / Data Integrity
* Location: live RLS policy `payments.staff_insert_payments` (`WITH CHECK (rma_is_staff())`) and `vendor_payments.staff_insert_vendor_payments` (same); repo `supabase/migrations/20260751_harden_money_rpcs.sql` / `20260780_accountant_can_move_cash.sql` did not narrow the INSERT policy; view `v_customer_ledger` includes every `payments` row with `status = 'active'`
* Description: `record_payment` / `record_vendor_payment` enforce `rma_can_handle_cash()` and assign gapless `PAY-` codes, but the underlying tables accept a plain `INSERT` from any role that passes `rma_is_staff()` — that includes `viewer`, `technician` and `sales_rep`. A row inserted this way has `status = 'active'`, so it is summed into the customer statement (Billing tab) and into the AR picture.
* How to reproduce: as any signed-in viewer, `POST /rest/v1/payments` with `{customer_id, amount: 999999, unapplied_amount: 999999, method: 'cash', payment_date, created_by, status: 'active'}`. Probe executed as the live viewer account inside a rolled-back transaction: `viewer direct INSERT into payments succeeded, 1 row`.
* Expected: only `rma_can_handle_cash()` roles, and only through `record_payment` (or an equivalent guarded path).
* Actual: the insert succeeds; the customer's Billing tab shows a payment that never happened.
* Impact: financial records can be falsified by the least-privileged role; AR/AP statements and aging become untrustworthy. The same applies to `vendor_payments`.
* Suggested fix: drop the direct INSERT policies on `payments`, `vendor_payments` (and `payment_applications` / `credit_note_applications` / `vendor_payment_applications`, whose `manager_insert_*` policies are equally bypassable by a manager without going through the RPC), or replace them with `WITH CHECK (false)` and let the SECURITY DEFINER RPCs be the only writers (they already run as the owner).
* Confidence: Confirmed by execution
* **Status: FIXED — applied to production 2026-09-03.** `supabase/migrations/20260808_lock_down_direct_payment_writes.sql` narrows all five INSERT policies to `rma_is_admin()`. Verified live by `supabase/manual/20260847_verify_payment_write_lockdown.sql`: *"PASS: viewer INSERT into payments refused (42501). PASS: admin INSERT into payments allowed (1 row, rolled back)."* The migration's own guard asserted that all five tables end with exactly one admin-only INSERT policy and that every payment RPC remains executable, and it committed, so that assertion held. Safety facts verified beforehand: all payment RPCs are `SECURITY DEFINER` owned by `postgres` (`rolbypassrls = true`) and no table sets `FORCE ROW LEVEL SECURITY`, so RLS is not consulted inside them; all ten places `src/` touches these tables are `select`; the only direct writer is Backup & Restore, which is admin-gated and is why the policies were narrowed rather than dropped. The first verifier run returned INCONCLUSIVE on `payment_applications` because it sourced its row through a `SELECT` the viewer's own read policy filtered to nothing; the script now captures the ids before dropping role and covers all five tables.

#### [CRITICAL] A sales rep can rewrite any column of their own posted invoice; posted financial documents are not locked

* ID: BUG-002
* Category: Permissions / Data Integrity / Security
* Location: live policies `crm_invoices.manager_update_crm_invoices` — `USING (rma_is_manager_or_above() OR assigned_rep = rma_current_user_email() OR created_by = rma_current_user_email())`, **no `WITH CHECK`**; identical shape on `credit_notes.manager_update_credit_notes`, `payments.manager_update_payments`, `vendor_payments.manager_update_vendor_payments`; trigger list on `crm_invoices` contains only `trg_crm_invoices_updated_at`
* Description: Ownership grants an unrestricted UPDATE. Nothing at the database layer prevents a rep (or anyone who created the row) from setting `payment_status = 'paid'`, `amount_paid = total`, `total`, `line_items`, `doc_status`, `inv_code` or `customer_id` on a row that has already been posted. The client only ever writes a subset of columns, so the UI hides the hole; the REST API does not. The `manager_update_payments` policy is not even gated on a cash role — any `created_by` match qualifies, so whoever recorded a payment can rewrite its amount afterwards.
* Correction (2026-09-03): an earlier revision of this finding also claimed the missing `WITH CHECK` let a rep reassign a document to another rep. That was wrong. Postgres reuses the `USING` expression as the check on the new row whenever `WITH CHECK` is omitted from an `UPDATE` policy, and a rolled-back probe confirmed the reassignment is refused with 42501 on the current schema. The severity is unchanged: rewriting a posted invoice's own financial columns is the substance of this finding.
* How to reproduce: as a sales rep, `PATCH /rest/v1/crm_invoices?id=eq.<own posted invoice>` with `{"payment_status":"paid","amount_paid":<total>}`. (The equivalent rolled-back probe was blocked by the audit tooling's classifier; the policy text and trigger list above were read from the live catalog.)
* Expected: posted invoices are immutable except through `void_invoice`; reps may edit only draft documents and only non-financial columns; ownership updates must carry a `WITH CHECK` so `assigned_rep`/`created_by` cannot be handed to someone else.
* Actual: the update is accepted.
* Impact: revenue and receivables can be altered by the person who is measured on them; gapless invoice codes can be overwritten; a voided state can be undone.
* Suggested fix: add a `BEFORE UPDATE` trigger on `crm_invoices`/`credit_notes`/`payments`/`vendor_payments` that rejects changes to financial and status columns once `doc_status <> 'draft'` (or `status <> 'draft'`) unless the caller is one of the SECURITY DEFINER RPCs (e.g. check a session GUC set by the RPC); add `WITH CHECK` clauses mirroring `USING`; restrict `payments`/`vendor_payments` UPDATE to `rma_can_handle_cash()`.
* Confidence: Confirmed by code reading
* **Status: FIXED — applied and verified in production 2026-09-03** (`20260809` plus the follow-up `20260810`). Final verification run, all ten checks: *"PASS posted-invoice rewrite refused (guard). PASS posted-invoice total refused. PASS cogs_base still frozen. PASS archive of a posted invoice still allowed. PASS archive of an issued credit note still allowed. PASS issued credit note frozen. PASS draft still editable by its rep. PASS reassignment refused (WITH CHECK). PASS payments UPDATE filtered to zero rows for a manager. PASS admin restore path (posted invoice writable, rolled back)."* History follows, because the failure mode is worth keeping. `supabase/migrations/20260809_lock_settled_financial_documents.sql` went in first. Its first verification run passed every lock check but reported `FAIL archive of a posted invoice refused — guard too tight`: the guard compared `to_jsonb(OLD)` with `to_jsonb(NEW)`, and Postgres computes **stored generated columns after `BEFORE` triggers run**, so `crm_invoices.cogs_complete` and `credit_notes.affects_inventory` read as `NULL` in `NEW` and made every post-draft write look like a change. A diagnostic trigger placed ahead of the guard reported the archive attempt verbatim as `archived [false -> true] … cogs_complete [false -> NULL]`. `supabase/migrations/20260810_fix_settled_guard_generated_columns.sql` excludes generated columns, discovered from the catalog so a future one needs no edit; that is safe because a client cannot write a generated column at all (`428C9`) and the columns they derive from stay frozen. **Until 20260810 is applied, archiving a settled invoice or credit note fails for everyone except administrators.** The verifier now also asserts that `cogs_base` stays frozen, so the exemption cannot silently widen. Details of the change below. Two mechanisms, because there are two problems. `payments`/`vendor_payments` have **no** legitimate client UPDATE (all ten `src/` references are reads), so their policy is narrowed to `rma_is_admin()` for the restore path. `crm_invoices`/`credit_notes` do need draft editing and Archive-at-any-status, so they keep their ownership policy (its `WITH CHECK` is now written out explicitly, which changes no behaviour but stops a later edit to `USING` alone from silently widening the check) plus a `rma_guard_settled_document()` trigger that freezes every column except `archived`/`archived_at`/`archived_by`/`updated_at` (and `restock_status` on credit notes, which `creditNotes.restoreUnits()` writes after issue) once the document leaves draft. The trigger tells an RPC from a REST call by `current_user`, measured on this database rather than assumed: a direct write runs as `authenticated`, and inside a `SECURITY DEFINER` function it is `postgres`. An allow-list rather than a deny-list, so columns added later are frozen by default. Administrators are exempt for Backup & Restore, consistent with BUG-001. Does **not** cover `quotations`/`sales_orders` status transitions — that is BUG-004 and BUG-034.

#### [CRITICAL] Storage bucket is public and listable, any authenticated user can delete every object, anonymous uploads are unbounded, and the live policies differ from the migration

* ID: BUG-003
* Category: Security / Data Integrity
* Location: live `storage.buckets` row `rma-attachments` (`public = true`, `file_size_limit = NULL`, `allowed_mime_types = NULL`); live `storage.objects` policies `Allow public read 1gfjb3d_0` (SELECT, `public`, `qual true`), `Allow authenticated delete 1gfjb3d_0` (DELETE, `authenticated`, `qual true`), `Allow authenticated uploads 1gfjb3d_0` (INSERT, `authenticated`, `WITH CHECK true`), `anon can upload comment attachments` (INSERT, `anon`, path `comments/*`, no size/MIME check); repo `supabase/migrations/20260527_storage_bucket_policies.sql` (which defines a 25 MB / image-or-PDF anon policy that is **not** live); `src/api/storage.js` (client-side `validateAttachment` is the only check and trusts `file.type`)
* Description: Every upload — RMA attachments (customer devices, invoices), customer documents, comment attachments, avatars, product datasheets, branding — lands in one public bucket. Because the SELECT policy is `true` for `public`, an unauthenticated caller can *list* the bucket through the Storage API and then fetch every object; object names are the only protection and listing removes it. The DELETE and INSERT policies for `authenticated` carry no bucket or path condition, so a viewer can delete or overwrite any file (including another user's avatar or the company logo) and can upload arbitrary content of any size. Anonymous callers can upload unlimited files of any type into `comments/` (only the browser code limits size/type, and it can be skipped). The migration in the repo describes a stricter world that was never applied.
* How to reproduce: `POST https://<project>.supabase.co/storage/v1/object/list/rma-attachments` with the anon key and `{"prefix":""}`; or as any authenticated user `DELETE /storage/v1/object/rma-attachments/<any path>`; or as anon `POST /storage/v1/object/rma-attachments/comments/x/evil.html` with a very large body.
* Expected: private bucket (signed URLs) for ticket/customer/comment material; per-folder policies; server-side size and MIME limits; delete limited to the owner or managers.
* Actual: as described; confirmed by reading the live catalog.
* Impact: disclosure of every customer document and repair photo to anyone on the internet; storage-cost / disk-space abuse; destruction of evidence by any staff account.
* Suggested fix: make the bucket private (or split: a public `branding/products` bucket and a private one), set `file_size_limit` and `allowed_mime_types` on the bucket, rewrite the object policies with `bucket_id` + `storage.foldername(name)` conditions and owner checks, serve private files through `createSignedUrl`, and re-apply (and commit) the real policies so the repo matches production.
* Confidence: Confirmed by execution (catalog read); exploitation not attempted
* **Status: part 1 of 2 FIXED — applied and verified in production 2026-09-03.** Final verification run, all five checks: *"PASS bucket limits present (25.0 MB, 15 types). PASS viewer upload refused. PASS technician upload allowed. PASS viewer delete filtered to zero rows. PASS a different technician can delete a colleague's upload."* Getting there took two wrong turns in the verification script itself, worth recording because they are facts about this Supabase project rather than about the fix: `storage.buckets` has row security enabled with **zero policies**, so a probe left impersonating a viewer role from an earlier check read the bucket row as absent (default-deny) and falsely reported no limits configured — fixed by reading the bucket while still unscoped. And Supabase installs a project-wide `storage.protect_delete()` trigger that refuses **every** direct SQL `DELETE` on `storage.objects`, for any role, before RLS is even consulted, unless the session sets `storage.allow_delete_query = 'true'` — without knowing that, a probe reading 42501 from a blocked delete cannot tell a correctly-scoped policy from a wide-open one, since both would show the exact same error. The final script opens that gate transaction-locally against a disposable, metadata-only fixture row it creates and destroys in the same rolled-back transaction, and confirms empirically (before trusting it) that RLS is still enforced underneath: a viewer's delete still matches zero rows with the gate open. Read side (public enumeration) is BUG-003 part 2, tracked separately below. `supabase/migrations/20260811_scope_storage_write_policies.sql` (verify: `supabase/manual/20260849_verify_storage_write_lockdown.sql`) closes the write side: the three unconditional `true` policies (upload, delete, and the duplicate delete-named SELECT) are replaced with `bucket_id = 'rma-attachments' AND rma_is_staff() AND role <> 'viewer'`; an UPDATE (overwrite) policy is added where none existed, since `uploadAvatar()`/`uploadPhoto()` pass `{upsert:true}` and would otherwise silently fail; and the bucket gains a 25 MB size limit and a 15-type MIME allowlist enforced by storage-api itself (the app's own limits are client-side and were not the boundary). The type list was built from the app's `ALLOWED_ATTACHMENT_TYPES` plus the icon formats the favicon picker accepts (`.png/.ico/.jpg`) plus `avif`/`bmp` (several pickers use `accept="image/*"` and `resizeImage()` only re-encodes jpeg/png/webp, so other image types reach storage unchanged) — `image/svg+xml` is deliberately excluded because the bucket is public and an SVG is a script carrier. Turning the bucket private is a larger, separately-tracked change: roughly ten database columns store `getPublicUrl()` results that would all need to move to signed URLs.
* **Status: part 2 of 2 FIXED — applied and verified in production 2026-09-03.** RLS verification, all three checks: *"PASS anon sees only comments/ (1 of 41). PASS a technician still sees all 41 objects. PASS an unprovisioned account sees nothing."* Confirmed independently at the HTTP layer, which is the actual attack path: the anon-key `list` call went from **15 top-level entries to 1** (the deliberately-retained `comments` folder), the `customers/` prefix went from enumerable to **0**, and a known object path still returns **HTTP 200 with no headers** — rendering unaffected, exactly as the mechanism predicted. `supabase/migrations/20260812_scope_storage_read_policies.sql` (verify: `supabase/manual/20260850_verify_storage_read_lockdown.sql`) drops the two unconditional SELECT policies — `Allow public read 1gfjb3d_0` (PUBLIC, `true`) and the misnamed `Allow authenticated delete 1gfjb3d_1` (SELECT, `authenticated`, `true`) — and replaces the latter with `staff_read_attachments` scoped to the bucket and `rma_is_staff()`. Measured before/after targets, at the HTTP layer rather than inferred: `POST /storage/v1/object/list/rma-attachments {"prefix":""}` with only the publishable anon key returns **15 top-level entries today, 0 after**. The RLS-level probe records the same three cases: anon enumerates **41 of 41** objects before the fix, a technician must keep seeing all 41, and an authenticated account with no `user_roles` row (one exists — BUG-018) also enumerates all 41 today and must drop to 0. **Critically, this closes enumeration only, not disclosure.** The bucket is `public = true`, and a public bucket's content is served with no key and no role: `GET /object/public/rma-attachments/<path>` **and** `GET /object/rma-attachments/<path>` both returned HTTP 200 with *no headers whatsoever* when measured, which is simultaneously why no policy change here can break image rendering, PDF export or any stored `getPublicUrl()` link, and why anyone who already knows or has been given a path retains access afterwards. `anon can read comment attachments` (SELECT, `comments/` only, 1 object) is deliberately retained so the customer-facing tracker upload path is not disturbed, and is recorded as residual rather than closed. Full remediation of the disclosure half still requires the private-bucket plus signed-URL project described above.

#### [CRITICAL] Document approvals and sales/purchase state transitions are enforced only in the UI

* ID: BUG-004
* Category: Permissions / Logic
* Location: `src/api/db/salesOrders.ts` (`markSent`), `src/api/db/quotations.ts` (`markSent/markAccepted/markDeclined/cancel/reopen`), `src/api/db/purchasing.ts` (`markSent/markConfirmed/rejectToDraft/cancel`, `submitForApproval/approve/rejectToDraft/cancel`), `src/pages/Activities/index.jsx:458-492` (`approveDocument`/`rejectDocument` gate on `canDo('purchasing','approve')` / `canDo('sales','post')` client-side only); live policies `sales_update_sales_orders` (rep may update own SO, no column restriction), `sales_update_quotations`, `purchase_orders.manager_write_purchase_orders` (ALL for any manager), `vendor_invoices.manager_write_vendor_invoices` (ALL for any manager); no transition trigger on `quotations`/`sales_orders`/`crm_invoices`/`credit_notes` (only purchase tables have `assert_purchase_status_transition`)
* Description: `approve_sales_order` (reserve stock, manager-only) and `post_invoice` exist, but the same status columns are writable directly. A sales rep can `PATCH sales_orders SET status='delivered'` on their own order, skipping reservation and delivery entirely, and can mark their own quotation `accepted`/`converted`. `ROLE_DEFAULT_PERMISSIONS.manager.purchasing.approve = false` is meaningless at the database: `manager_write_*` is `ALL`, so a manager can approve the purchase order they raised (`UPDATE vendor_invoices SET status='approved'`), and the app's own `vendorInvoices.approve()` is exactly that write. The manager probe in this audit found no VI in `pending_approval` to flip (0 rows), so this is confirmed from policy text rather than execution.
* How to reproduce: sales rep: `PATCH /rest/v1/sales_orders?id=eq.<own>` `{"status":"delivered","total":1}`. Manager: create a PO, `submitForApproval`, then `PATCH /rest/v1/vendor_invoices?id=eq.<own>` `{"status":"approved"}` (allowed by `assert_purchase_status_transition` from `pending_approval`).
* Expected: approval requires a role different from the requester and lives in a SECURITY DEFINER RPC; direct status writes rejected.
* Actual: accepted.
* Impact: segregation of duties for spend and revenue is decorative; stock can be "delivered" without ever being reserved (15 delivered sales orders already have no stock-move rows — see BUG-041).
* Suggested fix: move every status change into guarded RPCs (`approve_vendor_invoice(p_vi)`, `submit_sales_order`, …) that check `created_by <> caller` where appropriate; add transition triggers to the four sales tables mirroring `assert_purchase_status_transition`; remove `status` from the columns the row-level UPDATE policies allow (column-level `GRANT UPDATE (…)` or a trigger comparing OLD/NEW).
* Confidence: **Confirmed by execution (2026-09-03)** for the sales-order half — a rolled-back probe as a live sales rep set `status='delivered'` on their own order with a direct `UPDATE`, reserving no stock, and also set the legacy value `'confirmed'` the same way. The purchasing self-approval half is **also confirmed by execution**: in the same rolled-back style, a live manager approved a vendor invoice they had raised, confirmed a purchase order, and a live sales rep accepted their own quotation — while the four control cases (admin approves, admin confirms, manager accepts, manager submits for approval) all succeeded, showing the gap is authority and not reachability. Root cause as predicted: `assert_purchase_status_transition` validates *which* transitions are legal but never *who* is making them, and `manager_write_vendor_invoices` grants managers `ALL`.
* **Status: part 1 of 2 FIXED — applied and verified in production 2026-09-03.** All six checks: *"PASS delivered refused. PASS legacy confirmed refused. PASS submit for approval still allowed. PASS editing an order without a status change still allowed. PASS a non-client caller (the RPC context) can still set delivered. PASS admin restore path still writes status."* `supabase/migrations/20260813_guard_sales_order_status.sql` (verify: `supabase/manual/20260851_verify_sales_order_status_guard.sql`) closes the stock-integrity half: a `BEFORE UPDATE` trigger refuses any direct client change to `sales_orders.status` except `-> 'sent'` (submit for approval, and re-submit after a decline). Safe to make this tight because every write to the table in `src/` was enumerated first: only `markSent` writes status directly; accept, decline and cancel already route through `approve_sales_order`/`reject_sales_order`/`cancel_sales_order`, which are `SECURITY DEFINER` and so pass the `current_user` discriminator untouched. Administrators are exempt for Backup & Restore, consistent with BUG-001/002/003. Part 2 — approval *authority* — was a business-policy question and was decided by the owner rather than assumed.
* **Status: part 2 of 2 FIXED — applied and verified in production 2026-09-03.** All seven checks: *"PASS manager refused VI approval. PASS admin approved the VI. PASS manager refused PO confirmation. PASS admin confirmed the PO. PASS rep refused quotation acceptance. PASS manager accepted the quotation. PASS manager can still raise and submit a VI for approval."* UI gating was checked afterwards and already agrees with the new server rules, so no screen offers a button that now fails: the Activities approval inbox gates purchasing on `canDo('purchasing','approve')` (manager false) and sales on `canDo('sales','post')` (manager true, rep false), and DealDetail gates quotation approval on `['manager','admin','super_admin']`. `supabase/migrations/20260814_require_authority_to_approve.sql` (verify: `supabase/manual/20260852_verify_approval_authority.sql`). Rule chosen by the owner: **purchase approval is admin-only, hardcoded** — the alternative of reading `purchasing.approve` from `user_roles.permissions` (which would allow delegating to a named manager later without a migration) was explicitly declined in favour of a rule that cannot be widened by an accidental permission edit. So `vendor_invoices -> 'approved'` and `purchase_orders -> 'confirmed'` now require `rma_is_admin()`. On the sales side, quotation **acceptance** requires `rma_is_manager_or_above()` — not a softer choice, but the rule `approve_sales_order()` already enforces one step later; making it admin-only would put a stricter gate in front of a looser one. Quotation **decline** is deliberately unrestricted, since recording that a customer said no is the rep's own work rather than an internal approval. Nothing is stranded by the change: no purchase order sits at `sent`/`pending_confirmation` and no vendor invoice at `pending_approval`. Does **not** build a transition map for quotations — they still have neither a transition trigger nor a status check constraint, so `'converted'` can be written by hand without a sales order existing; that is BUG-034.

### 4.2 High

#### [HIGH] The scheduled notification drain has failed on every run since it was created

* ID: BUG-005
* Category: Logic / Error Handling
* Location: live `cron.job` id 2 `drain-notification-queue` (`net.http_post(url := …/functions/v1/notification-worker, headers := {"Content-Type":…,"x-trigger-source":"pg_cron"})` — no `Authorization`/`apikey` header); repo `supabase/migrations/20260604_pgcron_notifications.sql`; `supabase/functions/notification-worker/index.ts` (deployed with `verify_jwt: true`)
* Description: With `verify_jwt` on, the Supabase gateway rejects any request lacking a JWT before the function code runs. The cron body never carries one.
* How to reproduce: `SELECT status_code, count(*), left(max(content),120) FROM net._http_response GROUP BY 1` → `401 × 179` today alone, content `{"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}`. `SELECT status, count(*) FROM notification_queue GROUP BY 1` → `pending 351` (oldest 2026-06-13), `completed 135` (last 2026-07-01), `failed 13`. Pending breakdown: 341 `email/ticket.overdue`, 9 `whatsapp/ticket.created`, 1 `whatsapp/ticket.updated`.
* Expected: queue drained every two minutes.
* Actual: the queue is drained only when a browser fires the worker after a ticket event (10 jobs per call, priority order), so daily overdue emails (priority 5) and any job created while nobody is using the app never send. The `net._http_response` table is bloating (advisor `table_bloat`).
* Impact: customers have not received overdue reminders or WhatsApp updates for months; the moment the header is fixed, **341 stale overdue emails go out at once** (the cron re-queues each overdue ticket every day, and the dedupe window is only 23 h).
* Suggested fix: send `Authorization: Bearer <service-role or WORKER_SECRET-backed JWT>` from the cron job (store it in Vault), or deploy the worker with `verify_jwt = false` and rely on `WORKER_SECRET`; before enabling, cancel or collapse the pending backlog (one email per ticket, or purge everything older than the dedupe window); alert on `net._http_response` non-2xx counts.
* Confidence: Confirmed by execution
* **Status: FIXED — applied and verified in production 2026-09-04.** With the owner's account open in the browser, `WORKER_SECRET` was set on the function via the dashboard (CLI account auth wasn't available in this environment — `supabase secrets set`/`projects list` returned "Access token not provided" even though `functions deploy` had worked all session, because deploy uses project-scoped auth and secret management needs a full personal access token). The matching Vault secrets (`notification_worker_secret`, `anon_key`) were created via SQL and their equality was checked directly — `SELECT decrypted_secret = '<value>' ...` returned `true` — before the drain went live, so a silent mismatch could not leave the job failing with a fresh 401 under a new guise. `20260817_reschedule_notification_drain.sql` applied cleanly; its own guard (missing secrets, or backlog >10) did not fire. `cron.job` confirms `drain-notification-queue` active on `*/2 * * * *`. The temporary local files holding the generated secret and the anon key were deleted immediately after both were confirmed stored server-side; the secret value was never included in any chat output.
* **Verified live, not just applied.** First tick after the reschedule (07:14:00 UTC) reported `net._http_response` as a client-side **timeout**, not a 401 — meaningfully different, since a 401 fires instantly on auth failure while this one spent the full 5s actually talking to the function. Checked `notification_queue` directly rather than trusting that: 3 jobs had `completed_at` timestamps **several seconds after** `pg_net` gave up waiting, proving the Edge Function kept running server-side regardless of the client-side wait — the worker was functioning; only observability was broken, and `net._http_response` could never show the `200` this file's own verification notes promised to look for. Fixed by adding `timeout_milliseconds := 30000` to the job's `net.http_post` call (`pg_net`'s default is 5000ms; the worker processes up to 10 jobs per run with a 200ms rate-limit pause between WhatsApp sends plus real external API latency, comfortably over 5s). `notification_queue` confirms real, ongoing progress: completed rose from 135 → 138 and pending fell from 10 → 6 across the first few ticks. **One unrelated pre-existing failure surfaced**, not caused by and out of scope for this fix: a WhatsApp `ticket.created` job permanently failed (`retry_count = max_retries = 3`) with Meta error `#131030 Recipient phone number not in allowed list` — a WhatsApp Business test-mode / allowed-recipients configuration issue on the Meta side, unrelated to the queue or credential work here.


#### [HIGH] The WhatsApp webhook is unreachable by Meta and, once reachable, unauthenticated

* ID: BUG-006
* Category: Security / Logic
* Location: `supabase/functions/whatsapp-webhook/index.ts`; live function `whatsapp-webhook` (`verify_jwt: true`); `notification_logs` (`delivered_at`/`read_at` NULL on all 192 rows)
* Description: Meta calls the webhook with no Supabase JWT, so both the GET verification handshake and every POST status update are rejected at the gateway. Independently, the POST handler verifies nothing — it does not check `X-Hub-Signature-256` — so once `verify_jwt` is switched off anyone can post fake delivery statuses or fake "customer replies" into `notification_logs`. Two `.catch()` calls on PostgREST builders (lines ~117 and ~131) are also unreachable code paths worth checking against the deployed supabase-js version.
* How to reproduce: `SELECT count(delivered_at), count(read_at) FROM notification_logs` → 0, 0 despite 21 WhatsApp messages marked sent. Post any JSON body with `object: 'whatsapp_business_account'` to the URL (after fixing verify_jwt) and observe rows appear.
* Expected: verified HMAC signature; statuses flow to the log.
* Actual: no delivery/read status has ever been recorded.
* Impact: the WA Logs screen and Test Center statistics are wrong; message-status-based retry never happens; after the gateway fix, log poisoning is possible.
* Suggested fix: deploy with `verify_jwt = false` and implement `X-Hub-Signature-256` (HMAC-SHA256 with the app secret) validation; reject unsigned POSTs.
* Confidence: Confirmed by execution (gateway config + data) / code reading (signature)

#### [HIGH] Supabase Realtime publishes no tables, so every live subscription in the app is dead

* ID: BUG-007
* Category: Logic / Configuration
* Location: live `supabase_realtime` publication (0 member tables); ten `postgres_changes` subscriptions — `src/App.jsx:650` (`notifications`), `src/pages/Dashboard.jsx:447` (`rma_tickets` INSERT/UPDATE/DELETE), `src/pages/Customers/index.jsx:178`, `src/pages/Products/index.jsx:187`, `src/pages/Leads/index.jsx:403`, `src/pages/RMATickets/index.jsx:214`, `src/pages/Inventory/index.jsx:75` (`inventory_units` + `rma_tickets`), `src/components/ActivityChatter.jsx:135`, `src/components/CommentPanel.jsx:59`, `src/pages/Pipeline/DealCommentPanel.jsx:59`
* Description: Postgres only writes a row change into the logical replication stream if the table belongs to a publication. `supabase_realtime` contained **zero** tables, so Realtime never saw a single event. Every `.subscribe()` still succeeds — the channel joins, the callback registers, no error surfaces anywhere — and then no callback ever fires. This is the silent failure mode: nothing looks broken, lists just go stale.
* How to reproduce: `SELECT pubname, (SELECT count(*) FROM pg_publication_rel r WHERE r.prpubid = p.oid) FROM pg_publication p;` → `supabase_realtime | 0`. Then open Customers in two browsers as two staff accounts and edit a record in one; the other never updates.
* Expected: the seven subscribed tables (`notifications`, `activities`, `customers`, `rma_tickets`, `inventory_units`, `leads`, `products`) publish INSERT/UPDATE/DELETE, with RLS scoping each subscriber.
* Actual: no table published; all ten subscriptions inert. TanStack Query's `staleTime` (60 s dashboard, 2 min inventory stats) is what has been masking it, so the symptom reads as "slow to update" rather than "realtime is off".
* Impact: no live updates anywhere — the notification bell does not light up, the dashboard does not move, two people working the same queue silently overwrite each other's assumptions. Not a security defect; a whole advertised feature that has never worked.
* Suggested fix: `ALTER PUBLICATION supabase_realtime ADD TABLE …` for exactly those seven tables — not `FOR ALL TABLES`, which would stream the financial ledger to any subscriber whose policy admits them.
* Confidence: Confirmed by execution
* **Status: FIXED — applied and verified in production 2026-09-06** (`20260818_publish_realtime_tables.sql`). The seven tables were enumerated from the source rather than guessed, and added individually; the migration refuses to run if any target lacks a primary key (publishing DELETE without a row identity makes Postgres reject deletes outright) or has RLS disabled (which would stream every row to every subscriber), and warns if the publication ever contains a table it did not add. Verifier `supabase/manual/20260856_verify_realtime_publication.sql`: **7 passed, 0 failed**.
* **RLS was verified, not assumed.** Realtime evaluates each table's SELECT policy per subscriber; all seven resolve through `rma_is_staff()` / `rma_user_role()` / `rma_current_user_email()`, which are `SECURITY DEFINER` and read `auth.jwt() ->> 'email'`. Probed under the exact context Realtime uses (`role = authenticated` + `request.jwt.claims`), rolled back: viewer sees 13 tickets; the one authenticated-but-unassigned account (`ahmed@qdsegypt.com`, see BUG-018) sees **0** rows across all four staff tables; a `sales_rep` sees **0** foreign activities or leads. Publishing granted no subscriber anything they could not already read through PostgREST.
* **Proven end to end through the real delivery path**, by feeding a WAL record built from a live row into `realtime.apply_rls()` — the function Realtime itself calls to decide who receives a row — with two subscriptions registered in `realtime.subscription`: **INSERT delivered to 1 of 2** (staff yes, unassigned no, zero decoder errors). So RLS demonstrably applies on the wire, not just in a `SELECT`.
* **One accepted residual: DELETE bypasses RLS.** Per Supabase's documentation — *"RLS policies are not applied to DELETE statements, because there is no way for Postgres to verify that a user has access to a deleted record"* — and measured here rather than taken on faith: the same harness with a DELETE record delivered to **2 of 2** subscribers, with `old_record` equal to `{"id": "e837a77d-…"}` and nothing else. So a DELETE tells every subscriber that some row vanished, disclosing a bare UUID with no customer name, amount or status. Audience: 8 auth accounts, 7 of them staff who can already read these tables in full. Accepted rather than mitigated — the alternative is dropping the dashboard's DELETE subscription, which would break its list pruning for no real gain.
* **Replica identity deliberately left `DEFAULT`.** The instinct is `REPLICA IDENTITY FULL` so DELETE payloads carry the old row, but it would be pure cost: with RLS enabled the `old` record still contains only the primary key (same doc note), and nothing needs more — exactly one handler in the codebase reads `old` (`src/pages/Dashboard.jsx:453`) and it uses `row.id` only, confirmed by grep across `src/**`. `FULL` would add WAL volume on every update and delete across seven busy tables and change no observable behaviour.
* **Confirmed from the client, 2026-09-06 — closing the one gap in the original verification.** That verification reached the database layer only (publication membership, RLS via `realtime.apply_rls`); whether a real browser would subscribe was untested because it needs a signed-in session. With the app running against production, `realtime.subscription` now holds live rows — `customers` and `notifications`, both `claims_role = authenticated` — registered by the Customers screen and the notification bell. That table held **0 rows** before the fix. The client half of the path is therefore confirmed too, not inferred.

#### [HIGH] Updates that RLS filters to zero rows are reported as success, then logged, notified and emailed

* ID: BUG-008
* Category: Error Handling / Logic
* Location: `src/api/db/tickets.ts:106-110` (`update()` returns `data?.[0]` — `undefined` on 0 rows — with no error); same pattern in `customers.ts`, `catalog.ts`, `system.ts`, `quotations.ts`, `salesOrders.ts`, `crmInvoices.ts` (`.single()` variants throw `PGRST116`, the array variants do not); consumer `src/pages/RMATickets/TicketForm.jsx:647-668` (`await db.rmaTickets.update(...)` then `logTicketChanges`, `dispatchUpdateNotifications`, `fireUpdateEmails`, `dispatchRmaStageMoves`, `toast.success`); `TicketForm.handleSubmit` permission check is `canDo('edit_all') || canDo('edit_assigned')` without checking assignment; live policy `rma_tickets.staff_update` restricts technicians to `assigned_technician = me`
* Description: PostgREST applies RLS as a filter, so an unauthorised UPDATE returns `200 []`. The technician role has `rma_tickets.view_all = true` and `edit_assigned = true`; the list page guards the edit button per row, but the form itself does not, and the bulk product-status action (`RMATickets/index.jsx:555-610`) applies to any selected ticket. After a 0-row update the code writes `ticket_activity` rows describing the change (insert policy allows it), creates in-app notifications, calls `send-email` for the customer, fires WhatsApp events and reports "Ticket updated".
* How to reproduce: sign in as a technician, open a ticket assigned to someone else via the URL `?ticket=<id>` or bulk-select it, change status, save. Observe success toast, an activity entry, and (if the customer has an email) a "status changed" email — while the ticket is unchanged.
* Expected: the helper detects 0 affected rows and throws; side effects run only after a confirmed write.
* Actual: false success and a falsified audit trail.
* Impact: customers receive incorrect status emails; activity/audit logs contain events that did not occur; users believe edits are saved.
* Suggested fix: in every `update()`/`delete()` helper use `.select().single()` or check `data.length === 0` and throw a "not permitted / not found" error; move side effects behind that check; make `TicketForm` verify `assigned_technician === userEmail` when only `edit_assigned` is held.
* Confidence: Confirmed by code reading
* **Re-verified 2026-09-06.** Counted across `src/api/db/*.ts`: **28** `.update(...).eq(...)` helpers, and **0** of them guard against a zero-row result — every one returns `data?.[0]`, which is `undefined` on an RLS no-op with no error raised. The live `rma_tickets.staff_update` policy still restricts technicians to `assigned_technician = rma_current_user_email()`, and `src/pages/RMATickets/index.jsx:240-256` still fires the customer email, the admin notification, the audit entry and `toast.success` inside the `try` that never throws.
* **Status: FIXED 2026-09-06, ships with the next front-end deploy.** New `src/api/db/_assertUpdated.ts` exports `assertUpdated()` (returns the row or throws) and `assertAffected()` (throws when nothing was touched), plus a `NotUpdatedError` carrying `code: 'RMA_NOT_UPDATED'`. Applied to **25 write helpers across 13 files**: 17 that already chained `.select()` and returned `data?.[0]`, and 8 that had no `.select()` at all and so could not detect a zero-row write even in principle — including `purchaseOrders.markSent/markConfirmed/rejectToDraft/cancel`, `vendorInvoices.rejectToDraft/cancel`, `geo.updateCountry` and `whatsappNotifications.cancel`, which were silently doing nothing for anyone RLS refused.
* **The safety of this was established before applying it, not assumed.** `.select()` compiles to `UPDATE … RETURNING`, and RETURNING is evaluated against the **SELECT** policy — so on a table whose reads are narrower than its writes, an empty result would mean “changed, but you may not read it back” and the guard would throw falsely. That asymmetry is real in this codebase (BUG-079). The live catalog was queried for all 20 tables this layer updates and in every case the SELECT policy is at least as permissive as the UPDATE policy, so an empty result is unambiguous. `_assertUpdated.ts` records the check and the query to repeat it before adding a table.
* **`cancelAll(status)` was deliberately left unguarded.** It is a bulk `.eq('status', …)` update, and cancelling when nothing is queued is a legitimate no-op rather than a refusal — throwing there would invent an error.
* **Behaviour change to expect:** operations that previously reported success while doing nothing will now surface an error. That is the point of the finding, but it is user-visible immediately. The most likely place to notice it is a technician editing a ticket not assigned to them — which previously produced a success toast, an activity-log entry and a *customer status email* for a change that never happened.
* Tests: `src/test/assertUpdated.test.js` (8 cases — row returned, empty/null/undefined throw, entity named in the message, stable error code, first-of-many). Full suite **48 files, 1232 tests passing**; production build clean.

#### [HIGH] Outbound webhooks can never fire in production, and their signing secrets live in the browser

* ID: BUG-009
* Category: Logic / Security
* Location: `src/api/db/system.ts:236-282` (`webhooks.dispatch` runs `fetch(h.url)` in the browser and computes the HMAC with `secret_key` read from the `webhooks` table); `vercel.json` CSP `connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.sentry.io https://*.ingest.sentry.io`; callers `src/pages/RMATickets/TicketForm.jsx:172-189, 315`; test buttons `src/pages/cp/Integrations.jsx:128-146`, `src/pages/cp/WebhooksConfig.jsx:79-99`
* Description: The Content-Security-Policy shipped on Vercel forbids the browser from connecting to any host except Supabase and Sentry, so every webhook `fetch` is blocked before it leaves the page; `dispatch` swallows the error. The integration "Test" buttons fail for the same reason. Even where CSP is absent (local dev), delivery depends on the user's browser staying open and exposes `secret_key` to every admin session.
* How to reproduce: configure a webhook to `https://webhook.site/...`, create a ticket on the deployed app, check the browser console (`Refused to connect … violates Content Security Policy`) and the endpoint (nothing).
* Expected: webhooks delivered server-side with retries and signing.
* Actual: nothing is ever sent.
* Impact: the Integrations/Webhooks features are advertised but inert.
* Suggested fix: move dispatch to a database trigger + `pg_net`, or an Edge Function invoked by the client; keep secrets server-side; delete the browser fetch.
* Confidence: Confirmed by code reading
* **Status: FIXED — applied, deployed and verified end-to-end 2026-09-06.** Delivery moved into a new `dispatch-webhook` Edge Function (deployed, v2, `verify_jwt: true`); database half in `20260825_webhook_secrets_server_side.sql`. Calling a Supabase Function is permitted by the same CSP that blocked the direct `fetch`, which is why this shape works where the old one could not — and delivery now completes server-side, so closing the tab no longer aborts it.
* **Three defects, not the two originally filed.** Alongside the CSP block and the browser-held secrets, there were **three different signing schemes** — `dispatch` sent an HMAC as `X-Signature-256`, the Control Panel's Test button sent the secret in *plaintext* as `X-Webhook-Secret`, and the deleted second screen used `X-myRMA-Secret`. No receiver could have verified all three. Only the HMAC survives; a plaintext secret in a header proves nothing about the body and hands the secret to anyone who can see the request.
* **The secret is now unreadable by any client role, which is the part a client-side fix could not achieve.** `admin_all` grants administrators the whole row, so an admin could have requested `?select=secret_key` regardless of what our code selected. The table-level SELECT grant was replaced with an explicit column list omitting `secret_key`, and a generated `has_secret` column lets the Control Panel show *whether* a secret is set without being able to read it. Probed live as a real admin: `SELECT *` → 42501, reading `secret_key` → 42501, reading the safe columns → succeeds, writing a new secret → still allowed (4 passed, 0 failed).
* **A column-level REVOKE alone did nothing, and the migration's own guard caught it.** Postgres treats a table-level SELECT grant as covering every column, so `REVOKE SELECT (secret_key)` against it is silently a no-op. The first apply was refused by the post-condition check rather than appearing to succeed. Recorded in the migration so the next person does not repeat it.
* **Verified end-to-end against production, not just by unit test** — which matters here, because the original defect was precisely that nobody noticed the feature never fired. Unauthenticated call → gateway 401; anon key with no real user → function 401; `GET` → 405; `OPTIONS` → 200. A disposable webhook was created **through the Control Panel form**, then: pointed at `https://127.0.0.1/hook` → `"Refused: the URL points at a private address"`, `delivered: 0`, no outbound request; repointed at `https://example.com/hook` → a genuine POST left Supabase's network and returned **`HTTP 405`**, reported honestly with `delivered: 0` rather than claimed as success. The probe webhook was deleted afterwards; `webhooks` is back to 0 rows.
* **Two real bugs were found by that end-to-end pass and would not have been caught by mocks.** (1) `webhooks.create()` and `update()` chained a bare `.select()`, which compiles to `INSERT/UPDATE … RETURNING` and is checked against SELECT privileges — so creating a webhook broke with "permission denied for table webhooks" the moment the column grant landed (the same RETURNING mechanism as BUG-079). Both now name their columns. (2) The function's CORS preflight allowed only `authorization, content-type`, but `supabase-js` always sends `x-client-info`, so the browser failed the preflight and the call never left the page — the identical failure shape this finding is about, reintroduced by the fix. Now matches the header list every other function in the project uses.
* **A server-side request forgery guard was added, which the original finding did not call for.** This function POSTs to an administrator-supplied URL from the service role's network position, so without a check it is an SSRF primitive. It requires https and refuses localhost, `.local`/`.internal`, and private, loopback and link-local IPv4 literals (the cloud metadata address 169.254.169.254 falls under link-local). Redirects are `redirect: 'manual'` so a redirect cannot land somewhere the check cleared. **Known limit, stated rather than implied away:** this cannot defeat DNS rebinding, which would need resolution-time checking that Deno's fetch does not expose.
* Also bounded: a 10s per-delivery timeout, at most 20 webhooks per event, and `last_triggered_at` updated only for deliveries that actually returned 2xx. Tests: `src/test/webhookDispatch.test.js` (8 cases — delivery goes through the function not a fetch, a failure never breaks the caller's ticket save, errors reach Sentry, the Test button reports real failures instead of success, and `list()` never selects `secret_key`). Full suite **50 files, 1249 tests passing**; build and `lint:ci` clean.

#### [HIGH] Non-viewer staff can rewrite inventory units directly, un-reserving stock held by sales orders without a ledger entry

* ID: BUG-010
* Category: Permissions / Data Integrity
* Location: live policy `inventory_units.staff_update` — `USING/WITH CHECK (rma_is_staff() AND rma_user_role() <> 'viewer')`, no column restriction; same on `manufacturer_batches`, `ticket_parts`; `warehouse_stock.manager_write_warehouse_stock` (ALL for managers, quantity editable without `stock_moves`); `stock_moves.no_direct_client_insert` correctly blocks the ledger
* Description: The stock model relies on `reservation_status`, `reserved_by_doc_*`, `warehouse_id`, `status` and `unit_cost_base` changing only via RPCs that write `stock_moves`. A technician (or sales rep) can `PATCH` any of those columns.
* How to reproduce: rolled-back probe as the live technician account: `UPDATE inventory_units SET reservation_status='available', reserved_by_doc_id=NULL, warehouse_id=NULL WHERE id=<a reserved unit>` → `1 row`.
* Expected: only the RPCs (and, for RMA flows, `move_rma_units`/`link_serial_to_rma_ticket`) may change those columns.
* Actual: any non-viewer staff can free reserved stock, move units between warehouses, change serials, or change `unit_cost_base` (COGS) silently.
* Impact: `post_invoice` will refuse to post when units have been un-reserved ("bills N serialized units but only M are reserved"), or stock will be sold twice; margin reporting can be manipulated.
* Suggested fix: reduce `staff_update` on `inventory_units` to the columns the RMA workflow legitimately edits (`notes`, `warranty_status`, `resolution_type`…) via a column-guard trigger, and route everything else through RPCs; same for `warehouse_stock` (managers should use `adjust_stock`).
* Confidence: Confirmed by execution
* **Re-verified live 2026-09-06** (rolled-back probe, current policy text `USING/WITH CHECK (rma_is_staff() AND rma_user_role() <> 'viewer')`): as the live technician account, `UPDATE inventory_units SET reserved_by_doc_id = NULL, status = 'available'` on a reserved unit → **1 row allowed**. Still open, unchanged by any fix so far.
* **Status: FIXED — applied and verified in production 2026-09-06** (`20260822_guard_inventory_ledger_columns.sql`; verifier `supabase/manual/20260859_verify_inventory_ledger_guard.sql`: **7 passed, 0 failed**). A `BEFORE UPDATE` trigger refuses any direct client change to the ledger and provenance columns: `reservation_status`, `reserved_by_doc_type`, `reserved_by_doc_id`, `reserved_at`, `reserved_by_email`, `unit_cost_base`, `vendor_invoice_id`, `product_id`, `serial_number`. The exploit in this finding was re-run against the fix and is now refused; so are COGS and serial-number rewrites. No role exemption — not even an admin may move these from a browser, which is not a lockout because the RPCs are SECURITY DEFINER and run as `postgres`, as does the SQL editor for genuine repair.
* **Scope was deliberately limited, and the remainder is not closed.** `status` and `warehouse_id` are left client-writable because four live paths write them directly — `src/api/db/inventory.ts:335` (RMA resolution), `:389`/`:405` (manufacturer batch send/close) and `:440` (warehouse move). Guarding them would break those screens today; migrating them onto RPCs that write `stock_moves` is **BUG-032**, and this fix does not pretend to cover it. The exploit is still closed, because `status` alone cannot un-reserve a unit — a sales order reads the reservation columns, which are now guarded. Verified positively: all four client paths still succeed after the change.
* **The guard is `SECURITY INVOKER`, deliberately, and the migration refuses to finish if that changes.** It uses `current_user` to tell a browser PATCH ('authenticated') from a call inside an RPC ('postgres'), and that discriminator is always true inside a `SECURITY DEFINER` function — which is how the stamping trigger in 20260819 silently did nothing. This establishes the convention now holding across the database: **guard** triggers are INVOKER (`rma_guard_settled_document`, `rma_guard_sales_order_status`, `rma_guard_approval_authority`, `rma_assert_sales_status_transition` all are); **stamping** triggers are DEFINER and must key off the JWT instead.

#### [HIGH] The viewer role can write ticket resolutions, edit every notification and change the company-wide appearance; any staff can forge notifications

* ID: BUG-011
* Category: Permissions
* Location: live policies `ticket_resolutions.staff_write_resolutions` (INSERT `rma_is_staff()`), `ticket_resolutions.staff_write_update_resolutions` (UPDATE `rma_is_staff()`, no `WITH CHECK`), `notifications.user_update_read` (UPDATE `USING rma_is_staff()` — intended for `read_by` but covers every column), `notifications.staff_insert` (INSERT `rma_is_staff()`, arbitrary `target_roles`/`created_by`), `rma_config.staff_write_appearance_settings` (ALL for staff on `config_key='appearance_settings'` — favicon, tab title, login background are company-wide), `email_queue.staff_insert_email_queue`, `notification_queue.staff_insert_notif_queue` (viewer can enqueue WhatsApp jobs to any phone)
* Description: `viewer` is documented as read-only, and `mark_notifications_read` was already hardened to use the JWT identity — but the table-level UPDATE policy it replaced is still there.
* How to reproduce: rolled-back probe as the live viewer account: `INSERT INTO ticket_resolutions … refund 12345` → 1 row; `UPDATE notifications SET title='probe'` → **155 rows**; `UPDATE rma_config SET config_value=… WHERE config_key='appearance_settings'` → 1 row. As technician: `INSERT INTO notifications (… target_roles=['super_admin'], created_by='someone-else')` → 1 row.
* Expected: viewer has no write policy anywhere; notification UPDATE limited to `read_by`; appearance/company config admin-only (personal keys already live in `user_preferences`).
* Actual: as probed.
* Impact: read-only users can plant refund/credit resolutions on tickets, deface or delete the content of every staff notification, impersonate the system in the bell, spam the WhatsApp queue, and change the login screen.
* Suggested fix: drop `user_update_read` (the RPC covers it); drop `staff_write_appearance_settings` or limit to managers; restrict `ticket_resolutions` writes to `rma_is_staff() AND role <> 'viewer'` plus `created_by = me` in `WITH CHECK`; on `notifications.staff_insert` add `WITH CHECK (created_by = rma_current_user_email())` and restrict `target_roles` to non-admin roles unless manager+; limit `notification_queue` inserts to non-viewer staff.
* Confidence: Confirmed by execution
* **Re-verified live 2026-09-06**, all three halves still open, and the notification half is worse than first written. As the live viewer account: `UPDATE rma_config … WHERE config_key='appearance_settings'` → **1 row**; `INSERT INTO ticket_resolutions (type='refund', amount=9999)` → **1 row**. `UPDATE notifications SET title=<literal>` → **155 rows, the entire table** — while `SELECT count(*) FROM notifications` as the same viewer returns **0**. The viewer can therefore rewrite every notification in the system including the 155 they cannot read: the UPDATE policy is `rma_is_staff()` while the SELECT policy is targeted, so a write that reads no column bypasses the narrower read rule entirely.
* **Measurement note for whoever re-tests this:** `UPDATE notifications SET title = title` returns **0 rows**, which looks like the hole is closed. It is not — assigning a column to itself makes the statement read that column, which pulls in the SELECT policy. Use a literal (`SET title = 'x'`) to test the UPDATE policy on its own.
* **Status: FIXED — applied and verified in production 2026-09-06** (`20260819_stop_viewer_writes.sql` + same-day correction `20260820_fix_created_by_stamp_secdef.sql`). Verifier `supabase/manual/20260857_verify_viewer_write_lockdown.sql`: **11 passed, 0 failed**. Six policies changed: `notifications.user_update_read` **dropped outright** (the only UPDATE path in the app is the `mark_notifications_read()` SECURITY DEFINER RPC — confirmed no direct UPDATE to that table exists anywhere in `src/`); `notifications.staff_insert`, `notification_queue` and `email_queue` inserts narrowed to non-viewer staff; `ticket_resolutions` insert/update narrowed to **technician, accountant, manager, admin, super_admin** (owner's decision 2026-09-06 — excludes `sales_rep` as well as `viewer`; the manager-only DELETE is unchanged); `rma_config.staff_write_appearance_settings` **dropped** — `admin_all` already grants admins the write and the only UI that edits branding (ControlPanel) is already gated to ADMIN/SUPER_ADMIN in `src/App.jsx:1785`, so this matches the client exactly. `staff_read_appearance_settings` was deliberately kept and verified: every user must still read the favicon and tab title.
* **Verified in both directions, not just the refusals.** Viewer: UPDATE notifications 0 rows, INSERT ticket_resolutions 42501, UPDATE appearance 0 rows, INSERT notifications 42501. sales_rep: INSERT ticket_resolutions 42501. And the work still works — technician can insert a resolution, technician can create a notification targeting admin/manager, technician can still read the branding, admin can still edit it.
* **Authorship forging closed too.** A `BEFORE INSERT` trigger now stamps `created_by` from the JWT on both `notifications` and `ticket_resolutions`; a forged `created_by` is discarded (probe: submitted `forged@example.com`, stored `omara@qdsegypt.com`). Server-side callers with no JWT — service role, Edge Functions, pg_cron — keep whatever they set.
* **The first attempt at that trigger silently did nothing, and the verifier caught it.** It guarded on `current_user NOT IN ('authenticated','anon')`, the idiom from BUG-002's settled-document guard. That does not transfer to a `SECURITY DEFINER` function: inside one, `current_user` is the function's **owner** (`postgres`), so the guard matched every call and the stamp never ran. Measured directly — outside the trigger `current_user = authenticated`, inside it `postgres`. Corrected in `20260820` to key off the presence of a JWT email, which is immune to SECURITY DEFINER. Worth remembering before reusing that guard anywhere else.

#### [HIGH] Data Cleanup deletes tickets without awaiting, calls a method that does not exist, and always reports success

* ID: BUG-012
* Category: Error Handling / Data Integrity
* Location: `src/pages/cp/DataCleanup.jsx:69-84`
* Description: `;(await db.rmaTickets.bulkDelete) ? db.rmaTickets.bulkDelete(...) : Promise.all(list.map(t => db.rmaTickets.delete(t.id)))` — `rmaTickets.bulkDelete` is not defined in `src/api/db/tickets.ts`, so the expression always falls to the `Promise.all` branch, which is **not awaited**. The success toast fires immediately, `load()` re-reads before the deletes finish, and any failure becomes an unhandled promise rejection (not shown to the user, not captured by `captureException`). The deletes are hard deletes that cascade to `inventory_units`, `ticket_comments`, `ticket_activity`, `time_entries`, `ticket_parts`, `ticket_resolutions`. The "orphan customers" heuristic on lines 56-61 compares `customer_name` strings rather than `customer_id`, so a customer whose display name changed is offered for deletion while linked by FK (the RPC will then refuse, correctly, but the count is misleading).
* How to reproduce: as admin open Control Panel → Data → Cleanup, click "Delete completed older than 90 days"; the toast appears before the network requests complete; throttle the network to see partial deletion with no error.
* Expected: awaited, transactional bulk delete with an accurate result.
* Actual: fire-and-forget destructive operation.
* Impact: silent partial deletion of ticket history.
* Suggested fix: add `rmaTickets.bulkDelete(ids)` (single `.in('id', ids)` delete) and `await` it inside the try; use `customer_id` for the orphan check.
* Confidence: Confirmed by code reading
* **Re-verified 2026-09-06.** `src/api/db/tickets.ts` still exports only `list/get/create/update/delete` — there is no `bulkDelete`, so the ternary always takes the un-awaited `Promise.all` branch, exactly as described. Unchanged.
* **Status: FIXED 2026-09-06, ships with the next front-end deploy.** Added `rmaTickets.bulkDelete(ids)` — a single `.in('id', ids)` statement — and `await`ed it inside the `try`, replacing `;(await db.rmaTickets.bulkDelete) ? … : Promise.all(…)`. Confirmed first that `bulkDelete` genuinely did not exist on `src/api/db/tickets.ts`, so the ternary always took the un-awaited `Promise.all` branch exactly as described: the success toast and `load()` fired before any delete resolved, and failures became unhandled rejections that never reached the `catch`. `load()` is now awaited too, so the list cannot be re-read mid-deletion.
* The orphan-customer heuristic was fixed as well, conservatively. It matched `customer_name` strings, so a customer whose display name had changed was offered for deletion while still bound by its FK. It now treats a customer as linked if a ticket references it **by id or by name** — the union rather than the id alone, because legacy tickets can carry a name with no `customer_id`, and matching on id alone would have introduced the opposite error.

#### [HIGH] A credit note raised from an invoice ignores the invoice's discount and tax

* ID: BUG-013
* Category: Logic (calculation)
* Location: `src/pages/SalesDocuments/_modals.jsx:222-246` (`CreditNoteFromInvoiceModal` displays `lineTotal` = net-of-discount + tax, but `handleSubmit` passes only `qty` and `unit_price`); `src/api/db/creditNotes.ts:95-118` (`create()` computes `subtotal = Σ qty × unit_price`, `tax_amount: 0`, `total = subtotal`); `creditNotes.update()` same; `issue_credit_note` applies `v_cn.total` to the invoice
* Description: For an invoice line with 10% discount and 14% tax, the modal shows the credited amount as `qty × price × 0.9 × 1.14`, but the stored credit note total is `qty × price`. On issue, that (wrong) total is applied against the invoice.
* How to reproduce: post an invoice with `discount_pct: 10, tax_pct: 14` on a 1000.00 line (total 1026.00). Raise a credit note from it for the full line: modal preview shows 1026.00; the saved credit note has `total = 1000.00` and the invoice is left with 26.00 outstanding.
* Expected: credit note total equals the credited portion of the invoice total (including its discount and tax), and the `CreditNoteLine` carries `discount_pct`/`tax_pct`.
* Actual: mismatch; customers are under- or over-credited.
* Impact: wrong customer balances and VAT figures on every taxed or discounted invoice credit.
* Suggested fix: carry `discount_pct`/`tax_pct` on credit-note lines and reuse the shared `computeTotals`; or compute the CN amount server-side from the invoice line.
* Confidence: Confirmed by code reading
* **Re-verified 2026-09-06.** `src/api/db/creditNotes.ts:99-113` still computes `subtotal = Σ qty × unit_price`, writes `tax_amount: 0` and `subtotal: total`, while `src/api/db/crmInvoices.ts:50-60` accumulates real `discount_amount`/`tax_amount` from per-line `discount_pct`/`tax_pct`. Unchanged.
* **Status: FIXED 2026-09-06** — schema half applied and verified in production (`20260824_credit_notes_discount_amount.sql`); client half ships with the next front-end deploy. The finding's mechanism was re-confirmed line by line before changing anything: `CreateCreditNoteModal` (`_modals.jsx:212`) previewed `net + net × tax_pct` while its `handleSubmit` mapped lines to `{product_id, product_name, qty, unit_price, restock}`, dropping `discount_pct` and `tax_pct`; `creditNotes.create()` then computed `subtotal = Σ qty × unit_price` with `tax_amount: 0`. Modal showed 1026.00, database stored 1000.00, and `issue_credit_note` applied that wrong total to the invoice.
* **Root cause addressed, not just the symptom.** The same money formula existed in **four** copies — `computeTotals` in `crmInvoices.ts`, an inline reduce in `creditNotes.ts`, `totals` in `SalesDocumentForm.jsx` and `lineTotal` in the modal — and they had drifted. All now go through one shared `src/api/db/_documentTotals.ts` (`computeDocumentTotals`, `computeLineTotal`), so the preview and the stored document are computed by the same code and cannot diverge again. Order of operations is fixed and documented there: discount applies to the line base, tax to the discounted amount.
* `credit_notes` gained `discount_amount numeric(12,2) NOT NULL DEFAULT 0`, bringing it to parity with `crm_invoices` and `quotations`. No UI change was needed — `SalesDocumentDetail.jsx:738` already renders a discount row for any document that has one. The migration is additive and defaulted, and `issue_credit_note` reads only `total`, so existing rows and the RPC are unaffected; its guard re-checks that every existing credit note still reconciles (`subtotal - discount + tax = total`) and refuses to finish otherwise.
* **No existing data is wrong, which was checked rather than assumed.** All 5 credit notes in production were compared against their source invoices: none of those invoices carries any discount or tax (`discount_amount` 0.00, `tax_amount` 0.00, zero lines with a non-zero `discount_pct`/`tax_pct`). So nothing needs repairing — the defect was latent and would have bitten on the first credit against a taxed or discounted invoice, which for a 14% VAT business is a matter of time.
* Tests: `src/test/documentTotals.test.js` (9 cases) pins the finding's worked example exactly — 1000.00 at 10% discount and 14% VAT → subtotal 1000, discount 100, tax 126, **total 1026** — plus tax-on-discounted-not-gross, null/missing percentages, multi-line, a reconciliation invariant, and that `computeLineTotal` equals what is stored. Full suite **49 files, 1241 tests passing**; build clean.

#### [HIGH] Migration history is broken: the live database records one applied migration out of 137

* ID: BUG-014
* Category: Data Integrity / Configuration
* Location: live `supabase_migrations.schema_migrations` → only `20260524`; repo `supabase/migrations/` (137 files, incl. `00000000_baseline_schema.sql`); `.github/workflows/ci.yml` (`db-tests` job disabled with `if: false`)
* Description: Migrations were applied through the SQL editor. `supabase db push` / `migration list` will try to re-apply everything (most files are not idempotent). The project's own review already found policies live that no migration creates, and this audit found the storage policies differ from the file that claims to define them (BUG-003). There is no automated way to rebuild or diff the schema, and the SQL test files in `supabase/tests/` are unrunnable.
* How to reproduce: `SELECT version FROM supabase_migrations.schema_migrations` → 1 row.
* Expected: every applied migration recorded; `supabase db diff` clean.
* Actual: drift is undetectable.
* Impact: high risk of accidental re-application or of shipping a fix that assumes a policy the DB never received; no reproducible staging environment.
* Suggested fix: `supabase migration repair --status applied <every version>` after confirming each file's effect is live, then generate a fresh baseline with `supabase db dump` and enforce `db diff` in CI.
* Confidence: Confirmed by execution
* **Partially changed, still broken (re-measured 2026-09-06).** `schema_migrations` now holds **4** rows — `20260524` plus three recorded automatically by the migration tool during this remediation work (`20260904063824`, `20260904071259`, `20260906081840`). The migrations applied by hand in the SQL editor are still unrecorded, so the drift this finding describes is unchanged in kind: the table remains an unreliable description of what the database actually has.
* **Investigated 2026-09-06; not yet repaired — the repair needs a decision (see below).** Re-measured: **156 migration files, 10 recorded rows**. Sampled verification across the whole timeline (baseline through today) checked 14 durable objects — tables and functions created by files spanning `00000000_baseline_schema` to `20260815` — and **all 14 are live**, which is good evidence the files' cumulative effect is really in the database. Note that per-object checking is only strong in one direction: an object legitimately dropped by a later migration would read as "missing" without meaning the migration never ran.
* **This session made the drift worse, which is worth stating plainly.** The nine migrations applied today were recorded under generated timestamps (`20260906092058` …) with the filename only in the `name` column, not under their file versions. So `supabase db push` would today see `20260808_*.sql` through `20260824_*.sql` as unapplied and attempt to re-run them.
* **Two obstacles found for whoever does the repair.** (1) Filename prefixes are **not unique**: 156 files reduce to 149 distinct prefixes, with collisions on `20260524`, `20260526`, `20260604` (×4 files), `20260808` and `20260809`. `schema_migrations.version` is the primary key, so those seven files cannot all be recorded under a bare date prefix and need disambiguating to full `YYYYMMDDHHMMSS` versions first. (2) The repair means renaming files and writing ~150 ledger rows in a working tree that currently has unrelated uncommitted changes, so it wants a clean checkout and a deliberate commit rather than being folded into a remediation session.
* **Status: FIXED — repaired and verified in production 2026-09-06.** `supabase_migrations.schema_migrations` now contains **156 rows for 156 migration files**, verified as an exact set match in both directions: no file missing from the ledger, no ledger row without a file. `supabase db push` and `migration list` are usable again.
* **Seven files were renamed first, because filename prefixes were not unique** and `version` is the primary key — 156 files collapsed to 149 distinct prefixes. The most-referenced file kept the bare prefix in each collision and the least-referenced was extended to a unique numeric version, so live cross-references survived: `20260524_features` → `20260524000001`, `20260526_enable_rls` → `20260526000001`, `20260604_priority_changed_email_template` / `_ticket_customer_email` / `_ticket_resolutions` → `20260604000001/2/3`, `20260808_product_documents_trash` → `20260808000001`, `20260809_company_documents` → `20260809000001`. The two in-repo references to renamed files were updated (`20260617_kb_articles.sql`, and one self-referencing header); references inside `docs/archive/` were deliberately left alone as historical records.
* **Ordering was checked, not assumed.** The extended versions still sort correctly between neighbouring dates (`20260524` < `20260524000001` < `20260526`), and in each collision the files are functionally independent — product/company document tables versus the payment-lockdown policies, and the four unrelated 20260604 notification/template migrations — so the order within a shared date does not matter for a rebuild. That independence is an assumption worth re-checking if any of those files are ever edited to depend on each other.
* **This session's own drift was corrected at the same time.** The nine migrations applied today had been recorded under generated timestamps (`20260904063824`, `20260906092058` …) with the filename only in `name`, so `db push` would have tried to re-run `20260808_*.sql` through `20260824_*.sql`. Those nine rows were deleted and replaced by their file versions.
* **Supporting evidence for treating the historical files as applied:** a sampled verification across the whole timeline — 14 durable objects (tables and functions) from `00000000_baseline_schema` through `20260815` — found **all 14 live**. Note the limit of that evidence: per-object checking is strong when objects are present and weak when absent, since a later migration may legitimately have dropped one.
* **It drifted again, in the opposite direction, and was repaired 2026-09-07.** The ledger was fine; the *repository* was not. Four migrations applied on 2026-09-06 — `20260833_issue_credit_note_closes_ticket`, `20260834_drop_old_issue_credit_note_overload`, `20260835_deal_status_follows_stage`, `20260836_consolidate_preference_policies` — were recorded in `schema_migrations` but their `.sql` files were **never written to `supabase/migrations/`**. So the BUG-048, BUG-033 and BUG-050 fixes existed only in the production database: a rebuilt environment would have silently lacked all three. The four files were recovered verbatim from the ledger's own `statements` column and written to the repository, each carrying a provenance header saying where it came from. 171 files, ledger consistent.
* Related hygiene, same day: the three migrations applied on 2026-09-07 had been recorded under bare names (`real_session_management`) rather than the `20260837_real_session_management` convention every other row uses. Renamed in the ledger so it stays greppable by filename.
* **The lesson is the one this finding keeps teaching:** `apply_migration` records a row whether or not a file exists, so applying and committing are two separate acts and neither implies the other. Enforcing `db diff` in CI — still open below — is what would catch this class automatically.
* **Still open, and deliberately not done here:** enforcing `supabase db diff` in CI, which is what would stop this drifting again. It needs the Supabase CLI plus a database password in CI secrets, which is a repository-settings change rather than a code one.

#### [HIGH] The Webhooks control-panel page calls a method that does not exist

* ID: BUG-015
* Category: Logic
* Location: `src/pages/cp/WebhooksConfig.jsx:46-56` (`await db.webhooks.save(newHooks, currentUserEmail)`); `src/api/db/system.ts` exports `webhooks = { list, create, update, delete, dispatch }`; `src/pages/ControlPanel.jsx:154` mounts `WebhooksConfig` for section `webhooks` while `Integrations.jsx` (section `integrations`) is a second, table-backed webhook editor
* Description: Saving on the Webhooks section throws `TypeError: db.webhooks.save is not a function`, caught and shown as a toast. Two different UIs manage the same concept with different secret header names (`X-myRMA-Secret` vs `X-Webhook-Secret` vs the HMAC `X-Signature-256` used by `dispatch`).
* How to reproduce: Control Panel → Automation → Webhooks → add a hook → Save.
* Expected: one working editor.
* Actual: error toast on every save.
* Impact: broken admin feature; confusing duplication.
* Suggested fix: delete `WebhooksConfig.jsx` and the registry entry, keep `Integrations.jsx`.
* Confidence: Confirmed by code reading
* **Re-verified 2026-09-06.** `webhooks` in `src/api/db/system.ts:216` exports `list, create, update, delete, dispatch` — still no `save`, while `WebhooksConfig.jsx:49` calls `db.webhooks.save(...)`. Note the blast radius is larger than "saving fails": deleting a hook also routes through `saveAll` (line 280), so create, edit **and** delete all throw on this screen.
* **Status: FIXED 2026-09-06, ships with the next front-end deploy.** `src/pages/cp/WebhooksConfig.jsx` deleted, along with its `_registry.jsx` entry, its `ControlPanel.jsx` import and mount, and the `'webhooks'` section id in `src/App.jsx` and `src/components/Breadcrumb.jsx`. **The report's premise was checked before deleting anything**: `src/pages/cp/Integrations.jsx` is a complete, working webhook editor — it calls `db.webhooks.list/create/update/delete`, all of which exist — so removing the broken duplicate keeps the feature under Control Panel → Email & API. Build clean; 1224 tests pass. The `webhooks` table is untouched and still backed up (`src/api/backup.js:237`). Note this screen was broken for **create, edit and delete**, not just save: deleting a hook also routed through `saveAll` → the non-existent `db.webhooks.save`.
* **Not fixed by this, and still true:** outbound webhooks never actually fire in production — that is BUG-009 (the Vercel CSP blocks the browser `fetch`, and the signing secrets are read into every admin session). Removing the dead editor does not make the feature work; it removes the second, broken way of configuring something that is itself inert.

#### [HIGH] CI lint gate fails on HEAD

* ID: BUG-016
* Category: Configuration
* Location: `package.json` (`lint:ci: eslint src --max-warnings 2391`), `.github/workflows/ci.yml` (job `ci` runs `npm run lint:ci`), `eslint.config.js` (`no-restricted-syntax` hardcoded-text rule)
* Description: The warning budget was set to a snapshot count and has been exceeded (2406). Every push to `test`/`main` currently fails the required job, which trains the team to ignore CI.
* How to reproduce: `npm run lint:ci` → exit 1, "ESLint found too many warnings (maximum: 2391)".
* Expected: green gate.
* Actual: red.
* Impact: build/test signal lost; README and CLAUDE.md claim "zero warnings" which is not true.
* Suggested fix: either burn the untranslated-text warnings down (they are real i18n gaps — see BUG-042) or move the rule to a separate report and cap only the other rules.
* Confidence: Confirmed by execution
* **Status: FIXED 2026-09-06 — and the finding's premise had already shifted.** By the time this was picked up, `lint:ci` had been changed from `--max-warnings 2391` to `2451` (uncommitted, in `package.json`), so the job exited **0** and CI was green again. The symptom was gone; the design flaw was not. Warnings had already drifted 2406 → 2433, leaving **18** of headroom — about eighteen new UI strings from red again. A warning budget over a rule that fires once per hardcoded string is a ratchet, not a gate.
* **The gate now measures code quality, and the i18n debt is reported instead of capped.** `lint:ci` became `eslint src --rule "{'no-restricted-syntax':'off'}" --max-warnings 0` — a real zero, matching the CI step's existing name ("Lint (zero warnings)"), which until now was untrue. A non-blocking `Untranslated UI strings (report only)` step runs the pre-existing `lint:ui` reporter so the 2425 hardcoded strings stay visible as BUG-042 rather than invisible inside a budget. Verified the gate is real: injecting an unused variable makes it exit 1, removing it exits 0.
* **Reaching zero meant fixing 8 warnings, and one was a live bug.** Five were unused variables in tests (trivial). Three were `react-hooks/exhaustive-deps`, and inspecting them rather than suppressing them found that **`src/pages/RMATickets/index.jsx` had a dependency array that had drifted from its own signature**: `filterOverdue` was in the signature but not the deps, so toggling the overdue filter never reset the page — you stayed on page 7 of a now-shorter list looking at an empty table — while `filterAssigned`, `filterCustomer` and `sortConfig` were in the deps but not the signature, re-running the effect only to hit the early return. Deps now mirror the signature exactly. `Customers/index.jsx` needed only the missing setter. `src/lib/useUrlState.js` is a genuine intentional exclusion (including `params` would give `setValue` a new identity on every URL change and break the one-navigation-per-tick batching the hook exists for) and is now an explicit `eslint-disable-next-line` with that reason, rather than an unexplained warning.
* Full suite **49 files, 1241 tests passing**; production build clean.

#### [HIGH] Known-vulnerable dependencies in the production bundle

* ID: BUG-017
* Category: Security
* Location: `package.json` / `package-lock.json`
* Description: `npm audit` reports 11 high. Directly reachable from the app: **react-router / react-router-dom 7.15.1** (open redirect via backslash in `<Link>`/`useNavigate` — CVE-2025-68470 bypass; RSCErrorHandler XSS) — fixed in 7.18.3; **xlsx 0.18.5** (prototype pollution, ReDoS on crafted workbooks; no fixed npm release — the app parses user-supplied CSV only with its own parser but *imports* SheetJS for export, and `XLSX.read` is not used, so exposure is limited to the bundle); **dompurify** (moderate, via jspdf); **vite ≤ 6.4.2** dev-server `server.fs.deny` bypass on Windows (dev only); build-time only: `sharp`/`@vite-pwa/assets-generator`, `undici`, `postcss`, `browserslist`, `brace-expansion`, `nanoid`, `fast-uri`, `@babel/core`.
* How to reproduce: `npm audit` (exit 1).
* Expected: no high-severity advisories on runtime dependencies.
* Actual: as listed.
* Impact: open-redirect on any navigation built from user input; latent XSS.
* Suggested fix: `npm i react-router-dom@^7.18.3 vite@^6.4.3 jspdf@latest`; replace `xlsx` with `exceljs` or the vendor's CDN build; run `npm audit --omit=dev` in CI.
* Confidence: Confirmed by execution
* **Status: FIXED — upgraded and verified 2026-09-06.** `npm audit` went from **16 vulnerabilities (11 high, 2 moderate, 2 low, 1 critical-free)** to **3 (3 high, 0 moderate, 0 low)**. Upgrades: `react-router-dom` 7.15.1 → **7.18.3** (closes the open redirect via backslash in `<Link>`/`useNavigate`, CVE-2025-68470 bypass, and the RSCErrorHandler XSS), `vite` 6.4.2 → **6.4.3** (`server.fs.deny` bypass on Windows alternate paths; launch-editor NTLMv2 hash disclosure), `postcss` → **8.5.28** (sourceMappingURL path traversal). `npm audit fix` then cleared `brace-expansion`, `browserslist`, `fast-uri`, `undici` and `nanoid` non-breakingly.
* **What actually ships to users was measured separately, and matters more than the headline count.** `npm audit --omit=dev` now reports **one** issue in the production bundle: `xlsx`. The other two remaining highs — `@vite-pwa/assets-generator` and its pinned `sharp` — are dev-only PWA icon generation with no fix available upstream, and never reach a user.
* **`xlsx` was left in place deliberately, on evidence rather than convenience.** Both advisories (prototype pollution, ReDoS) are triggered by *parsing* an attacker-supplied workbook. This app never parses one: grepping `src/**` finds no `XLSX.read` or `XLSX.readFile` anywhere — only `utils.aoa_to_sheet`, `utils.json_to_sheet`, `utils.book_new`, `utils.book_append_sheet`, `utils.encode_cell/encode_col` and `writeFile`, i.e. export only. Replacing SheetJS with `exceljs` is therefore a large change to close a path that is not reachable. Worth revisiting only if an import-from-xlsx feature is ever added — at which point it becomes urgent.
* **Verified beyond `npm audit`.** Full suite **49 files, 1241 tests passing**; production build clean; `lint:ci` exit 0. React Router is the routing core, so it was also exercised in a real browser rather than trusted to unit tests: the dev server was started, the app mounted and rendered the dashboard, and an in-app `<Link>` navigation to Customers rendered all 888 records — the `<Link>`/`useNavigate` path the CVE concerns. The only console errors were pre-existing accessibility-linter (axe) warnings, unrelated to routing.

#### [HIGH] Admin password-reset function skips the status check and leaves created accounts without a role

* ID: BUG-018
* Category: Permissions / Logic
* Location: `supabase/functions/admin-reset-password/index.ts:44-56` (checks `roleRow?.role !== 'super_admin'` only; `admin-invite-user` and `admin-delete-user` also require `status === 'active'`), `:73-78` (`targetEmail === caller.email` case-sensitive; target not lower-cased before `createUser`), `:99-114` (creates the auth user; the role row is inserted separately by the browser in `src/pages/UserManagement/index.jsx:266-268`)
* Description: A suspended or expired super_admin whose JWT is still valid (sessions are not revoked on suspension) can reset any user's password or mint new auth accounts. The create path is two requests from the browser; if the second (`createRole`) fails or the tab closes, an auth account exists with no role — the live database already has 1 such account and 10 role rows with no auth account.
* How to reproduce: suspend super-admin A while A has an open session; as A call `adminSetPassword(B, …)` → succeeds. Create a user, kill the network after the first response → orphan auth user.
* Expected: `status = 'active'` and `rma_access_is_current` checked; role row written by the function in the same operation (or `inviteUserByEmail` used exclusively).
* Actual: as described.
* Impact: account takeover by a de-provisioned admin; orphaned logins.
* Suggested fix: reuse the invite function's `role, status` check; insert the `user_roles` row inside the function with rollback of the auth user on failure; lower-case emails.
* Confidence: Confirmed by code reading
* **Status: FIXED — deployed to production 2026-09-03** (`admin-reset-password` v16). Edge function plus `src/api/auth.js` and `src/pages/UserManagement/index.jsx` — **the two client files still ship with the next front-end deploy**; until then the older browser writes the role itself, which the function still supports, so nothing is broken in the meantime. All three defects addressed: (1) the caller check now matches `rma_access_is_current()` — role **and** `status = 'active'` **and** `access_expires_at` not passed — and looks the caller up on a lower-cased address so a case mismatch cannot silently deny a legitimate administrator; (2) the self-lockout guard compares lower-cased; (3) creating a user is now one server-side operation — the function writes `user_roles` itself and **deletes the auth account it just made** if that write fails, so the half-made account this finding describes can no longer be produced. Server-side password strength was added, mirroring `validatePasswordStrength()` in `src/pages/UserManagement/_utils.js` exactly (min 8, upper, lower, digit) — deliberately identical rather than stricter, since a server rule tighter than the browser's would reject a password the Add User screen had already accepted and offered to copy.
* **Deployment order does not matter**, by design: `role` is optional on the create path, so the new function with an old browser behaves exactly as before (browser writes the role, as today), and the new browser with an old function sees no `roleCreated` flag and writes the role itself. Neither combination breaks Add User and neither creates a role-less account once both are out.
* **Not fixed, and not this finding's to fix:** suspension still does not revoke existing sessions (BUG-049) — the status check stops a suspended super_admin using *this* function, and RLS already denies them everywhere in the app, but `send-whatsapp`, `notification-worker` and `ai-assist` still read `role` without `status` (BUG-021).
* **Existing orphans need an owner decision, not a code change.** Re-measured 2026-09-03: the **10 role rows with no auth account are all `@test.com`, all dated 2026-06-24** — the seed fixtures from `20260706_seed_test_users_and_deals.sql`, whose purge is deferred, not orphans from this bug. One of them, `youssef.nagy@test.com`, holds **super_admin**; roles are keyed by email, so if that address were ever registered it would inherit super_admin — worth deleting ahead of the rest of the fixtures. The **1 auth account with no role is `ahmed@qdsegypt.com`**, a real company address created 2026-05-17 that **has signed in**: a person who can authenticate but sees only the access-denied screen. Provision it or delete it — both are the owner's call.

#### [HIGH] Notifications targeted at roles the creator does not hold are never created

* ID: BUG-079
* Category: Logic / Error Handling
* Location: `src/api/db/notifications.ts:47-70` (`create()` does `.insert([...]).select()`); live policy `notifications.user_read_targeted` (SELECT `USING rma_is_staff() AND (target_roles IS NULL OR … rma_user_role() = ANY(target_roles) OR rma_current_user_email() = ANY(target_emails))`); callers `src/pages/Customers/index.jsx:436,470,559` and `src/pages/Products/index.jsx:788,821` (`targetRoles: ['admin','super_admin']`), `src/pages/RMATickets/index.jsx:244` (`targetRoles: ['admin','manager']`)
* Description: PostgREST's `.select()` compiles to `INSERT … RETURNING`, and `RETURNING` is subject to the **SELECT** policy. `user_read_targeted` only lets a user read a notification aimed at their own role or address. So when a technician or sales_rep creates a notification targeted at `['admin','super_admin']`, the RETURNING clause is refused and **the whole statement aborts** — the row is never inserted. `create()` swallows the error (`if (error) … return null`), so nothing surfaces.
* How to reproduce: rolled-back probe as the live technician account. `INSERT INTO notifications (… target_roles=ARRAY['admin','manager'])` → **1 row**. The same statement with `RETURNING id` → **refused, SQLSTATE 42501**. The same statement with `target_roles=ARRAY['technician']` and `RETURNING` → succeeds. The discriminator is purely whether the creator can read what they just wrote.
* Expected: staff can raise an alert for admins without being able to read the admin inbox; creation should not depend on readability.
* Actual: every escalation notification created by a non-admin silently fails. Bulk customer import, bulk product import, product deletion and ticket status changes performed by technicians or sales reps produce no notification at all.
* Impact: the alerting path that admins rely on to notice bulk data changes has never worked for the roles most likely to trigger it — and because the caller returns `null` on both success and failure, no error was ever visible. Distinct from BUG-007 (transport was dead); here the row is not written in the first place.
* Suggested fix: drop the `.select()` from `notifications.create()` — the return value is discarded by every caller — or route creation through a `SECURITY DEFINER` RPC that inserts without RETURNING. Do not widen `user_read_targeted`: not being able to read other roles' notifications is correct.
* Confidence: Confirmed by execution
* **Found 2026-09-06** while verifying the BUG-011 fix; **pre-existing and not caused by it** — both `user_read_targeted` and the `.select()` predate that change, and the behaviour reproduces identically against the old `rma_is_staff()` insert policy. Not yet fixed.
* **Status: FIXED (client) 2026-09-06, ships with the next front-end deploy.** `src/api/db/notifications.ts` no longer chains `.select()` onto the insert, so the statement is a plain INSERT and the SELECT policy is never consulted. Verified against the live database first: the same insert targeting `['admin','manager']` as a technician succeeds **without** `RETURNING` and is refused with 42501 **with** it. `user_read_targeted` was deliberately left alone — not being able to read other roles' notifications is correct. The return type became `Promise<void>`, which is safe because no call site uses the value (every one is `db.notifications.create({…}).catch(…)`); a genuine insert error is now reported to Sentry instead of being swallowed.
#### [HIGH] The RMA ticket table's row menu crashes the page: the row map shadows the translation function

* ID: BUG-083
* Category: Logic / UX
* Location: `src/pages/RMATickets/index.jsx` — `const { t } = useTranslation()` (line 26) and `const tr = t` (line 32), with table rows rendered by `paginatedTickets.map((t, idx) => …)`; inside that callback `t` is the **ticket**, and five calls used `t('…')`: `common.unassigned`, `common.view`, `common.edit`, `tickets.exportPDF`, `common.delete`
* Description: the `tr` alias exists precisely because the row map shadows the translator — the rest of the row already uses it. Five calls did not. Calling the ticket object as a function raises `TypeError: t is not a function` during render, and the error boundary replaces the page with the crash screen.
* How to reproduce: RMA Tickets → table view → open any row's ⋯ action menu. View, Edit, Export PDF and Delete all sit inside it, so the menu cannot open at all.
* Expected: the menu opens.
* Actual: the page crashes.
* Impact: row actions are unusable in table view. The fifth call, `common.unassigned`, throws for any row with no assignee — production has 0 unassigned tickets of 13 today, so that one is latent rather than active.
* Suggested fix: use `tr` inside the map, or rename the map parameter.
* Confidence: Confirmed by code reading — `git blame` dates the lines to dedda598 (2026-06-05) and ed8215de (2026-06-06), and the working tree matches HEAD, so this is in the deployed build. Not reproduced in a browser.
* Found: 2026-09-13, while applying BUG-071 to the same rows. Neither the audit nor the lint rules caught it: no rule flags a call to a shadowed identifier.
* **Status: FIXED 2026-09-13** (ships with the next front-end deploy). The five calls now use `tr`, and a comment at the top of the map says plainly that `t` there is the ticket.
* Verified by parsing rather than grepping: an espree pass over every file in `src/` finds **48** functions with a parameter named `t` and **0** calls of such a parameter as a function. A text scan was tried first and was wrong twice — it mis-detected where the callback ended and reported three correct calls in the empty-state block as broken.

#### [HIGH] The audit log can be forged by any authenticated user

* ID: BUG-019
* Category: Security / Data Integrity
* Location: live policy `user_activity_log.auth_insert` — `WITH CHECK (rma_is_authenticated())`; `src/api/db/audit.ts` (`auditInsert` writes `user_email` from the caller; failed writes are queued in `localStorage` and replayed on next app start by whoever is signed in); `src/App.jsx:790-792`
* Description: `user_email` is free text. Any staff account can insert `{user_email: 'admin@…', action_type: 'ticket_deleted', …}`; the queue in localStorage can also be edited before replay. `handleLogout` logs `logout` **after** `signOut()`, so that insert is refused (no session) and ends up in the queue, attributed to a later session or lost.
* How to reproduce: as a viewer `POST /rest/v1/user_activity_log {"user_email":"someone@else","action_type":"payment_voided","action_details":"…","created_date":…}`.
* Expected: `WITH CHECK (user_email = rma_current_user_email())` or a trigger that stamps the actor from the JWT (as `stock_moves_stamp_actor` does).
* Actual: any value accepted.
* Impact: the audit trail admins rely on can be poisoned or used to frame a colleague.
* Suggested fix: stamp `user_email` from `auth.jwt()` in a `BEFORE INSERT` trigger; log logout before signing out.
* Confidence: Confirmed by code reading (policy text from live catalog)
* **Status: FIXED (database half) — applied and verified in production 2026-09-06** (`20260821_stamp_audit_log_actor.sql`; verifier `supabase/manual/20260858_verify_audit_log_stamp.sql`: **3 passed, 0 failed**). A `BEFORE INSERT` trigger stamps `user_email` from the JWT, matching the existing `stock_moves_stamp_actor`. The policy is unchanged — any authenticated staff member may still append to the log, they just cannot choose whose name is on it. Probed live: a viewer submitting `user_email = <an admin>` with `action_type='payment_voided'` had it rewritten to their own address; an honest write was accepted unchanged; a server-side write with no JWT kept its own actor (`system`), so cron and Edge Function entries are unaffected.
* **Client half written, ships with the next front-end deploy** (`src/App.jsx` and `src/api/db/audit.ts`). Two changes: (1) `handleLogout` now logs **before** `auth.signOut()` and awaits it — previously the insert ran after the session was destroyed, so RLS always refused it and it fell into the localStorage retry queue, which is exactly why 'logout' entries were missing or wrongly attributed; (2) `auditFlushQueue` now drops queued entries belonging to a different user rather than replaying them. That second change is required *because* of the trigger: the queue is per-browser, not per-user, so replaying A's entry while B is signed in would now file it under B. A lost log line is better than a false one.
* **Interim behaviour, stated rather than left to be discovered:** until the client half deploys, a queued entry replayed by a different user is attributed to the replayer instead of the original actor. Both the old and new behaviour are wrong in that case — the old one recorded a name the session did not belong to — and neither is now forgeable, which is what this finding is about.
* **Test coverage added.** `src/test/audit.test.js` had no coverage of `auditFlushQueue` at all and its Supabase mock had no `auth` object, so the existing tests passed regardless of what the flush did. Six tests added (own entries flushed; foreign entries dropped without insert; mixed queue flushes only the caller's; case-insensitive address match; queue preserved when there is no session; queue preserved when the insert fails). Full suite: **47 files, 1224 tests, all passing.**


#### [HIGH] A role waiting for whoever registers the address

* ID: BUG-084
* Category: Security / Access Control
* Location: `public.user_roles` (live data) — 10 rows created 2026-06-24, all on `@test.com`, all `status = 'active'`, none ever signed in; one holds `super_admin` and one `admin`. Resolution path: `src/api/db/users.ts` `userRoles.getUserRole(email)`.
* Description: a role is resolved by matching `user_roles.user_email` against the signed-in address. Nothing ties the row to an account — the row simply waits. So each of these is a standing grant to whoever first creates an account with that address, and the project has `disable_signup = false` (read from `/auth/v1/settings`, 2026-09-13).
* How to reproduce: `SELECT role, user_email FROM user_roles ur WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = lower(ur.user_email));` — or run `rma_data_integrity_summary()`, where these now appear as `role_without_account`.
* Expected: a role row names somebody who exists, and a new account starts with no access.
* Actual: registering one of those addresses signs you in as an administrator.
* Impact: what stands in the way is only that sign-up requires confirming the email and `test.com` is a domain the company does not own — that is a stranger's mail server, not a control. Two of the ten are administrative.
* Suggested fix: turn off public sign-up (dashboard, and already on the owner list), and suspend the orphaned rows — the exact `UPDATE` is written at the foot of `supabase/migrations/20260843_integrity_identity_and_due_dates.sql`. Suspension rather than deletion keeps the fixture rows visible and is one statement to undo; any status other than `active` denies in both the database (`rma_access_is_current`) and the app (`accessDenialReason`).
* Confidence: Confirmed. Counts and roles read from production today; `disable_signup` read from the live auth settings endpoint. Not exploited — establishing that would mean registering one of those addresses.
* **Status: PARTLY FIXED 2026-09-13.** The waiting grants are closed; the mechanism that made them dangerous is an owner action.
* **All 10 rows suspended, on the owner's instruction.** `status = 'suspended'`, reason recorded on each row. Suspension rather than deletion: the fixture rows stay visible for demonstrations and one `UPDATE` undoes it. Verified afterwards — 0 orphaned rows left active, `rma_access_is_current()` returns **false** for the former `super_admin`, and all 7 rows belonging to real accounts were untouched and still active. The check that found them now reports 0 high-severity rows.
* **Still open, and only the owner can do it: public sign-up is still enabled.** Suspending these rows closes today's ten grants; it does not stop the eleventh. While `disable_signup = false`, any address that acquires a `user_roles` row before its account exists is the same hazard again, and someone registering with no role at all can still create an account.
* `role_without_account` stays in `rma_data_integrity_issues()` permanently, rated **high** whenever an administrative grant is waiting, so a recurrence surfaces instead of sitting.

### 4.3 Medium


#### [MEDIUM] 40% of the customer phone numbers cannot be dialled

* ID: BUG-085
* Category: Data Integrity
* Location: `public.customers.mobile` (live data); `src/lib/customerDuplicates.js`; `rma_data_integrity_issues()` case 5
* Description: found while examining BUG-063's 14 "duplicate" mobiles, six of whose seven pairs turned out not to be duplicates at all. The numbers themselves are the problem. Of 470 customers holding a mobile (418 of 888 have none), **186 could not be dialled as an Egyptian mobile** — and 28 of those had simply lost their leading zero, 27 of them replaced by a `+`, so `01091768465` was stored as `+1091768465`.
* How to reproduce: `SELECT count(*) FROM customers WHERE btrim(coalesce(mobile,'')) <> '' AND NOT rma_is_egyptian_mobile(mobile);` — or read `malformed_customer_mobile` in `rma_data_integrity_summary()`.
* Expected: a stored mobile can be dialled, and can be found by someone typing the number they were given.
* Actual: a customer whose number is stored as `+1091768465` is invisible to anyone searching `01091768465`. RMA intake finds a customer by phone, so this is the one moment the field matters.
* Impact: the counter cannot find the customer, so a new record gets created — which is how the duplicates the audit noticed came to exist in the first place. A quiet feedback loop rather than a one-off.
* Suggested fix: repair the mechanically certain ones, report the rest, and warn at both entry points so the book stops degrading.
* Confidence: Confirmed. Every count measured against production on 2026-09-13, before and after.
* **Status: FIXED 2026-09-13 — closed.** The protections are shipped: format warnings on the customer form and the CSV importer, the shared mobile key, and the `malformed_customer_mobile` check. What remained was correcting existing numbers, and the owner has confirmed all current data will be erased — the correction worksheet is no longer needed.
* **Status: PARTLY FIXED 2026-09-13** — the certain repairs are done, the judgement calls are reported rather than guessed at.
* **28 repaired, and the reading is certain rather than inferred.** A number beginning `+1 0…` cannot be North American either: NANP area codes never begin with 0 or 1. So `+1091768465` has exactly one possible meaning. All 28 were listed before the write and each carries its previous value in the customer's `notes`. Well-formed local numbers went **276 → 304**; not-dialable went **186 → 158**.
* **Repairing them immediately proved the wider point.** The duplicate check jumped from 14 to 16 the moment the formats were normalised — two pairs had been the same number all along, spelled differently. Formatting damage was hiding duplicates, not just breaking search.
* **The two checks were asking different questions.** The front end compares the last nine digits (`mobileKey`); the database compared trimmed strings. So the database missed five records the app would catch, and flagged two unrelated companies whose entire "mobile" is the character `+`. `20260845` adds `rma_mobile_key()` and `rma_is_egyptian_mobile()` as the SQL twins, `20260846` rewrites the check to use them, and the count is now **17** — the honest number — with the junk pair gone.
* **New check `malformed_customer_mobile` (low), 158 rows.** Low because a landline in the mobile field is something a person meant to do. Reported anyway, because the field is what intake searches. The remainder — 43 landline-length, 7 too long, 1 too short, 2 holding no digits, and a `+116777789` that is genuinely ambiguous — need someone who knows the customer, not a rule.
* **Both entry points now warn without refusing.** The single-record form names the specific problem ("looks like a mobile missing its leading 0") and asks; the CSV importer imports the row, lists every bad number in the console and says how many. Never a rejection: a foreign customer has a foreign number.
* **The remaining 158, examined 2026-09-13 — nearly half are not damaged, they are old.** 73 are ten-digit mobiles from before Egypt moved mobiles to eleven digits on 6 October 2011. Eight of them use prefixes (014, 016, 017, 018, 019) that only existed in the old scheme, which settles it: the customer book was exported from a system whose numbers predate 2011, and nobody updated them. The published rule converts each one mechanically (016 → 0106, 012 → 0122, …) — but a fifteen-year-old number may no longer reach the customer, so these are suggestions to verify by calling, not repairs to apply. Sources: [Ahram Online](https://english.ahram.org.eg/News/22664.aspx), [Wikipedia](https://en.wikipedia.org/wiki/Telephone_numbers_in_Egypt).
* **54 are landlines sitting in the mobile field**, and their area codes match the company's city where the name says one: Tanta rows start 040, Alexandria 03, Port Said 066, Mansoura 050. Every one of those customers has an empty `landline` field. 6 more are a mobile and a landline typed into one field, several hiding a perfectly valid mobile.
* **Only 15 of the 158 have no safe suggestion**: 8 wrong-length or unrecognised, 5 seven-digit landlines with no city code, 2 holding no digits. Plus 4 placeholders (`01000000` and similar) and 3 valid Saudi numbers on test records.
* **Not written back.** A worksheet grouping all 158 with a suggestion, a confidence rating and a verification step was handed to the owner; it holds customer names and numbers, so it is deliberately not in this repository. The classifier behind it was checked against 25 real shapes from the data before it was run. Nothing changes in production until the confirmed column comes back.
* **The seven pairs, for the record, since this closes BUG-063's live-data half too:** two were branch locations of one company, two were the USD-currency twin of an existing account, one was a pair of the owner's own test records, one was the `+` junk, and only one — the same contact person under two company names — was genuinely ambiguous. **Nothing was merged, and nothing should be** — sharing a number is ordinary here, which is why there is no unique index. (Customer names removed 2026-09-14, when the repository became public.)


#### [LOW] Invoice and credit-note update policy admitted roles that cannot see the documents

* ID: BUG-086
* Category: Security / Access Control
* Location: live policies on `public.crm_invoices` and `public.credit_notes` (UPDATE), compared with the same tables' SELECT policies and with `quotations` / `sales_orders`
* Description: found while checking which tables were safe for BUG-074's write guard. Every sibling document table gates its update branch on role — `quotations` and `sales_orders` allow `manager_or_above OR (sales_rep AND (assigned_rep = me OR created_by = me))`. `crm_invoices` and `credit_notes` drop the `sales_rep AND`, so their UPDATE policy is `manager_or_above OR assigned_rep = me OR created_by = me` **for any role** — while their SELECT policy admits only managers, sales reps and accountants.
* How to reproduce: `SELECT cmd, qual FROM pg_policies WHERE tablename IN ('crm_invoices','credit_notes','quotations','sales_orders') AND cmd IN ('SELECT','UPDATE');`
* Expected: whoever may change a financial document may also see it, and a technician or viewer may do neither.
* Actual: at the database level, a technician or viewer recorded as `created_by` or `assigned_rep` passed the UPDATE policy for an invoice it cannot read. An active technician was linked to 4 invoices (8 links, counting creator and assignee separately — first misreported as 8 invoices).
* Impact: **not reachable through the app or the API — first reported as Medium, corrected to Low after probing.** Rolled-back probes as that technician: a targeted `UPDATE … WHERE id = …` affected 0 rows, because a WHERE clause naming a column makes PostgreSQL apply the SELECT policy too. Only a constant `UPDATE … SET col = '…'` with no WHERE passed RLS — and was then stopped by the settled-document trigger on those posted invoices. The API cannot send that form: `authenticator` loads `safeupdate`, which rejects an UPDATE without a WHERE, and every WHERE PostgREST builds names a column. So the policy text was wrong, but the gap rested on two incidental protections rather than being open; one draft invoice linked to an active technician was covered only by them.
* Suggested fix: align both UPDATE policies with `quotations`/`sales_orders`. One decision is needed first — whether an accountant who created an invoice should still be able to edit it, since the aligned policy would remove that.
* Confidence: Confirmed from the live catalog and live data on 2026-09-13. Not exploited.
* **Status: FIXED 2026-09-13** — migration `20260847`, on the owner's decision to match quotations exactly (accountants keep read access; payments go through SECURITY DEFINER procedures, which bypass RLS). Both UPDATE policies now equal the quotations one; the migration refuses to finish otherwise, and checks no second permissive UPDATE policy could reopen it.
* **Verified before and after with the same probe.** Before: the technician's constant no-WHERE update reached their invoices. After: 0 rows, and targeted updates refused. Admin, super-admin and the sales rep still update their documents. Integration tier green against production.
* **Consequence for BUG-074:** with the policies aligned, both tables became safe for the write guard, which now covers `crmInvoices.update`, `cancelDraft` and `creditNotes.update`. `creditNotes.restoreUnits` turned out to ignore the result of its second write entirely — the units could be back in stock while the credit note still read as not restocked, silently. It now checks and reports.

#### [MEDIUM] The WhatsApp queue's cancel buttons have never worked — notification_queue had no UPDATE policy

* ID: BUG-080
* Category: Permissions / Logic
* Location: live table `public.notification_queue` — policies were `admin_read_notif_queue` (SELECT) and `staff_insert_notif_queue` (INSERT) only, with **no UPDATE policy**; callers `src/api/db/whatsappNotifications.ts:352` (`cancel`) and `:357` (`cancelAll`)
* Description: RLS is enabled on the table, so an absent UPDATE policy is a deny for every role — including `super_admin`. The WhatsApp queue screen offers Cancel and Cancel All regardless. PostgREST reports the RLS-filtered UPDATE as `200 []`, and neither call site inspected the row count, so both buttons reported success and changed nothing.
* How to reproduce: rolled-back probe. Before the fix, `UPDATE notification_queue SET status = status` as the live admin account → **0 rows**. After → 1 row, while a technician still gets 0.
* Expected: an admin can cancel or requeue a queued notification, as the UI implies.
* Actual: the action was a silent no-op for everyone.
* Impact: a queued WhatsApp or email job could not be stopped from the browser. Combined with the unbounded reminder loop (BUG-043) this was the only UI control over the queue, and it did not work.
* Suggested fix: add an admin-scoped UPDATE policy matching the existing admin SELECT policy.
* Confidence: Confirmed by execution
* **Found 2026-09-06** while scoping BUG-008 — it is the same failure shape (an RLS-filtered write reported as success), which is how it surfaced.
* **Status: FIXED — applied and verified in production 2026-09-06** (`20260823_allow_admin_cancel_notification_queue.sql`; probe: **2 passed, 0 failed** — admin can now update a queued job, technician still cannot). Deliberately not narrowed to `status = 'cancelled'`: an admin managing a stuck queue also needs to requeue a failed job, and a policy permitting only cancellation would produce the next silent no-op the moment that button is added. Queue draining is unaffected — the notification-worker uses the service role and bypasses RLS. The caller now also throws on a zero-row result via BUG-008's `assertAffected`, so a future policy regression here fails loudly instead of silently.
#### [MEDIUM] Accounts-payable aging adds foreign-currency balances into the base-currency totals

* ID: BUG-082
* Category: Logic / Financial reporting
* Location: `src/pages/Accounting/index.jsx` `apAgingByVendor` (`cur[row.bucket] += row.remaining`, `cur.total += row.remaining`), fed by `src/api/db/vendorLedger.ts` `apAgingReport`, which computes both `remaining` (in the invoice's own currency) and `remaining_base`, and documents on its type that bucket totals must use the latter
* Description: Vendor invoices can be raised in a foreign currency (20260792). The payables aging reducer summed `remaining` — each balance in its own currency — into totals presented in the base currency, so a USD balance was added to EGP balances digit for digit.
* How to reproduce: open the payables aging on the Accounting page with an approved foreign-currency vendor invoice carrying a balance; compare its total with `SELECT sum((total - amount_paid) * exchange_rate) FROM vendor_invoices WHERE status IN ('approved','partially_received','received')`.
* Expected: every bucket and the total in base currency.
* Actual: measured in production on 2026-09-10 — one approved USD 3,750 invoice at 48.5 — the page showed **E£4,540** owed to suppliers against a true **E£182,665**, understating payables about forty-fold.
* Impact: the payables figure used to plan cash is wrong by E£178,125 today, and by more with each foreign invoice.
* Suggested fix: sum `remaining_base`.
* Confidence: Confirmed by execution
* Found: 2026-09-10, while fixing BUG-065, which rewrote the same reducer.
* **Status: FIXED 2026-09-10** (ships with the next front-end deploy). The reducer sums `remaining_base` for every bucket and the total. Receivables were checked and are unaffected: sales documents are always raised in the base currency, so `remaining` is already base there.

#### [MEDIUM] MFA challenge is skipped when the assurance-level lookup fails

* ID: BUG-020
* Category: Security
* Location: `src/App.jsx` `handleLogin` and `checkAuth` (`const { data: aalData } = await auth.mfa.getLevel()` — `error` ignored; `if (aalData?.nextLevel === 'aal2' …)` is false when `aalData` is undefined)
* Description: A transient failure of `getAuthenticatorAssuranceLevel` lets an enrolled user straight into the app at AAL1. Today no user has a verified factor (`auth.mfa_factors` verified = 0), so the exposure is latent.
* How to reproduce: enrol TOTP, block the `/auth/v1/factors` request, sign in.
* Expected: fail closed (treat lookup error as "MFA required" or sign out).
* Actual: fail open.
* Impact: MFA bypass under network faults or a targeted request block.
* Suggested fix: check `error` and refuse to call `finishLogin` until the level is known.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-06** (ships with the next front-end deploy). The check was extracted to `src/lib/mfaGate.js` and now fails **closed**: only a definite “no second factor required” admits, and anything else — including not being able to tell — refuses, with the caller signing the session out rather than leaving it half-authenticated.
* **There were two fail-open points, not the one filed.** Besides the ignored error from `getLevel()`, the line immediately after it had the same shape: when `getLevel()` *did* report a second factor was owed but `listFactors()` then failed, `totp` was `undefined` and control fell through to the same `finishLogin` call. A third, subtler case is now also refused — `nextLevel === 'aal2'` with no verified TOTP found is a contradiction, not a green light.
* Extracted from `App.jsx` deliberately: a security check that nothing exercises is how this survived. `src/test/mfaGate.test.js` covers 11 cases, including every failure path asserting it never returns `ok`. Confirmed still latent before changing anything — `auth.mfa_factors` holds **zero rows**, so nobody is locked out by the stricter behaviour.

#### [MEDIUM] Edge functions accept suspended users and expose provider errors; `ai-assist` is unrestricted

* ID: BUG-021
* Category: Security / Error Handling
* Location: `supabase/functions/ai-assist/index.ts` (any authenticated JWT; no role, status or rate limit; `catch` returns HTTP **200** with `error: "NVIDIA error 401: …"`); `send-whatsapp/index.ts:63-70` and `notification-worker/index.ts:80-90` (role read but `status` not checked); `kb-chat/index.ts` (provider response body — up to 400 chars — streamed to the client; CORS hardcoded `*` instead of the shared helper); `manage-sessions/index.ts` (errors returned with 200)
* Description: The database layer fails closed for suspended accounts, but the functions read `user_roles.role` directly with the service key and never consult `status`/`access_expires_at`. `ai-assist` also interpolates arbitrary client-supplied `data` into the prompt (prompt-injection surface) and burns paid LLM quota for any signed-in identity.
* How to reproduce: suspend a technician who keeps a tab open; from that tab call `supabase.functions.invoke('ai-assist', …)` or `send-whatsapp` → succeeds.
* Expected: every function that reads `user_roles` uses the same "role AND status = active AND not expired" rule; errors returned with 4xx/5xx and without upstream detail.
* Actual: as described.
* Impact: de-provisioned staff can still send WhatsApp messages, drain the queue and use AI; clients cannot distinguish success from failure on `ai-assist`.
* Suggested fix: a shared `requireActiveRole(client, allowedRoles)` helper; return proper status codes; limit `ai-assist` to non-viewer staff and add a per-user rate limit.
* Confidence: Confirmed by code reading
* **Status: FIXED — deployed to production 2026-09-03** (`ai-assist` v12, `send-whatsapp` v10, `notification-worker` v15, `kb-chat` v6, `manage-sessions` v11; `verify_jwt` preserved on all). New shared helper `supabase/functions/_shared/access.ts` (`currentAccess`/`canAct`) mirrors `rma_access_is_current()`: a row with a role, `status = 'active'` (NULL reads as active, same COALESCE as the SQL helper), and `access_expires_at` not passed — looked up lower-cased so a case mismatch cannot silently deny a legitimate user. Applied to **send-whatsapp** and **notification-worker** (both previously read `role` alone, so a suspended account with a live JWT kept sending on the company's Meta number and draining the queue) and to **ai-assist**, which had no role or status check whatsoever. Error handling: `ai-assist` returned **every** failure as HTTP 200 with an `error` field, so a caller could not distinguish success from failure by status — now 401/403/500/502/503 as appropriate; `manage-sessions` returned two errors with 200, now 400. Provider-detail leaks closed in both `ai-assist` and `kb-chat`: the upstream body is logged server-side and the client gets the status code only, which is actionable without disclosing request ids or account details. `kb-chat` also moved off its hardcoded `'Access-Control-Allow-Origin': '*'` onto the shared `corsOriginHeaders()` helper — it and `json()` are now per-request closures, matching the pattern the other functions already used; that changes nothing today (the helper falls back to `*` until `ALLOWED_ORIGINS` is set) but means setting that secret will no longer harden every function *except* this one.
* **Worth recording: `ai-assist` has no caller.** The `<AIAssist>` panel is hidden and `_dashboardAIData` in `src/pages/Dashboard.jsx` is underscore-prefixed as unused; `ai.assist()` is retained for future re-enabling. So the wide-open, quota-spending endpoint had no consumer — which is why gating it carried no workflow risk, and also why it went unnoticed. Consider undeploying it until the panel returns.
* **Not done: the per-user rate limit** on `ai-assist`. It needs somewhere to keep counters — a table and a migration — and a half-built limiter is worse than none. With the endpoint now restricted to current non-viewer staff and having no caller, the exposure it was meant to bound is much reduced.
* One test was updated rather than merely relaxed: `src/test/kbChat.test.js` asserted the exact leaking string. It now asserts the *new* property — the provider body is logged and no `fail()` message interpolates it — so the protection is pinned rather than the assertion deleted.

#### [MEDIUM] Anyone holding the public anon key can trigger the notification worker

* ID: BUG-022
* Category: Security
* Location: `supabase/functions/notification-worker/index.ts:83-92` (`else if (triggerSource !== 'pg_cron') return 401` — a literal header value is the credential); live cron sends exactly that header (BUG-005); the comment in the file acknowledges the gap
* Description: Once BUG-005 is fixed by adding a JWT to the cron call, the header check still lets any caller who presents the anon key (it ships in the bundle) plus `x-trigger-source: pg_cron` drain the queue and consume WhatsApp/Resend quota at will.
* How to reproduce: `curl -H "apikey: <anon>" -H "Authorization: Bearer <anon>" -H "x-trigger-source: pg_cron" -X POST …/notification-worker`.
* Expected: only `WORKER_SECRET` or a staff JWT.
* Actual: header string suffices.
* Impact: quota abuse; forced early sends.
* Suggested fix: require `x-worker-secret` for the cron path (store the secret in Vault and pass it from the cron SQL); delete the header branch.
* Confidence: Confirmed by code reading
* **Status: FIXED — deployed to production 2026-09-03** (`notification-worker` v15). The header branch is deleted outright; the function now admits only a matching `x-worker-secret` or a Bearer JWT belonging to a current non-viewer staff member, and every other caller gets a single undifferentiated 401 (saying *which* credential was wrong is free reconnaissance). `x-trigger-source` survives as a label — it is logged and returned in the response as `source`, and grants nothing.
* **The exploit path, stated precisely, because the original note under-described it.** The Functions gateway accepts the project JWT in **either** `Authorization` **or** `apikey`. So a caller sending `apikey: <anon key>` (satisfies the gateway; the anon key ships in the browser bundle) with **no** `Authorization` header (skips the Bearer branch) and `x-trigger-source: pg_cron` fell through every branch without returning, and drained the queue — spending WhatsApp and Resend quota. **Deliberately not tested against production:** the only way to confirm it end to end is to let it drain, which would send real messages from the 341-job backlog. Confidence therefore stays code reading, by choice rather than by omission.
* **No regression for the app or the cron.** All four in-app callers (`ticketEventHandlers`, `crmEventHandlers`, `WALogs`, `WATestCenter`) use `supabase.functions.invoke`, which attaches the session JWT, so they take the Bearer branch and never relied on the bypass. The real cron job is equally unaffected because it is already failing — it sends no Authorization header and has been rejected by the gateway with 401 on every run since June (BUG-005).
* **Removing the bypass makes the cron's credential a prerequisite**, so the BUG-005 path is now written out concretely in `supabase/manual/20260854_wire_cron_worker_secret_DO_NOT_RUN_YET.sql`: set `WORKER_SECRET`, put it in Vault, and re-schedule the job with both an `Authorization` header (any project JWT, to satisfy the gateway) and `x-worker-secret` (what the function actually authorizes on). It is deliberately inert — the file opens with the backlog warning, because the instant the drain works all 341 queued overdue emails send at once, to customers whose tickets may since have been resolved. It also points at BUG-043: the re-queueing loop dedupes only against a 23-hour window, so the backlog rebuilds unless that is fixed too.

#### [MEDIUM] Public tracker accepts unvalidated attachment JSON, emails and cross-ticket parent ids; rate limiting is per-instance and the client lockout is cosmetic

* ID: BUG-023
* Category: Security / Logic
* Location: `supabase/functions/public-track/index.ts:205-250` (`attachments: Array.isArray(c.attachments) ? c.attachments : []` — any JSON, any `url`; `user_email: c.authorEmail` unvalidated; `parent_comment_id: c.parentCommentId` may point at a comment on another ticket; `ticketId` accepted for any UUID without proof of knowing the RMA number); `:19-40` in-memory bucket (resets on cold start, per isolate); `src/pages/RMATracker.jsx:7-45` (localStorage lockout the caller controls)
* Description: Staff see customer attachments as `<a href={att.url}>` in `TicketDrawer.jsx:1105` — a `javascript:` or attacker-hosted URL is rendered as a clickable link with the attacker's chosen `name`. The comment endpoint requires only a ticket UUID, so a leaked/guessed id (they appear in `?ticket=` URLs staff share) lets anyone post to that ticket without the RMA number. Rate limiting does not survive across instances or restarts.
* How to reproduce: `POST public-track {action:'addComment', comment:{ticketId, authorName:'x', commentText:'y', attachments:[{name:'invoice.pdf', url:'javascript:alert(1)'}]}}` → stored; open the ticket as staff.
* Expected: whitelist attachment objects to `{name,url,path,size,type}` with `url` restricted to the project's storage origin; validate email format; verify `parentCommentId` belongs to `ticketId`; require the RMA number (or a per-ticket token) on `addComment`; back the limiter with a table or KV.
* Actual: as described.
* Impact: phishing links inside the staff UI; comment spam on any ticket; weak brute-force protection on RMA numbers.
* Suggested fix: as above; also `rel="noopener noreferrer"` plus URL-origin check before rendering any attachment link.
* Confidence: Confirmed by code reading
* **Status: FIXED (attachment, email and threading) — deployed and verified against production 2026-09-07** (`public-track` redeployed; client changes ship with the next front-end deploy). Fixed in **two halves**, because hardening the writer does nothing about what is already stored or about any other path that writes an attachment.
* **Write side.** `sanitiseAttachments()` keeps only the five fields the UI reads and requires `url` to be https on this project's own storage **origin** — compared as an origin, never as a substring. `authorEmail` is validated instead of stored raw. `parentCommentId` is now looked up and rejected unless it belongs to the same ticket, closing the cross-ticket threading.
* **Read side.** `src/lib/attachmentUrl.js` (`safeAttachmentUrl`/`safeAttachmentHref`) is applied at all **9** render sites across 5 files, so an unsafe value yields no `href` at all rather than a clickable link.
* **Verified by running the finding's own exploit against production.** A single anonymous POST carrying three attachments returned: `javascript:alert(1)` — **dropped**; `https://evil.example/?x=<project>.supabase.co`, which *contains* the expected origin as text — **dropped**, which is precisely why this is an origin comparison and not a substring test; the genuine storage URL — **kept**, with an extra `evil` field stripped. `authorEmail: "not-an-email"` stored as `null`. A reply threaded onto a comment belonging to a different ticket was refused with 400. The probe comments were deleted afterwards (0 remain).
* Tests: `src/test/attachmentUrl.test.js`, 12 cases — `javascript:`, `data:`, `vbscript:`, a foreign host, a host merely containing the origin as text, a lookalike subdomain, plain http on the right host, relative paths, and non-string values; plus the genuine URLs that must pass.
* **Not fixed, and still open:** the endpoint still accepts any ticket UUID without proof the caller knows the RMA number, and the rate limiter is still per-instance rather than backed by a table. Comment spam on a known ticket id remains possible; the phishing vector is what has been closed.

#### [MEDIUM] The service worker caches authenticated API responses and never clears them on logout

* ID: BUG-024
* Category: Security / UX
* Location: `vite.config.js:51-60` (`runtimeCaching` `NetworkFirst` for `https://*.supabase.co/*`, `cacheableResponse: { statuses: [0, 200] }`, 10 s timeout); no `caches.delete` / SW unregister anywhere in `src/` (grep)
* Description: Every REST GET (customers, tickets, invoices, user_roles) is stored in Cache Storage under `supabase-api`. On a shared machine the next user of the same browser profile — or anyone with disk access — can read it after logout. When the network is slow (>10 s) or offline, stale data of a *previous* account can be served to the current one with no indication.
* How to reproduce: log in, browse customers, log out, inspect DevTools → Application → Cache Storage → `supabase-api`.
* Expected: no caching of authenticated data, or a cache purge on `SIGNED_OUT`.
* Actual: persistent cache.
* Impact: data leakage on shared devices; confusing stale views.
* Suggested fix: remove Supabase REST from `runtimeCaching` (keep only static assets), or scope caching to public endpoints and call `caches.delete('supabase-api')` on sign-out.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-06** (ships with the next front-end deploy), in two parts, both needed.
* **Part one — stop caching.** The `runtimeCaching` rule is gone from `vite.config.js`. It matched `/^https:\/\/.*\.supabase\.co\/.*​/i`, which covers REST, Auth and Storage alike, so every authenticated GET was written to Cache Storage under `supabase-api`. The offline benefit did not justify it: `NetworkFirst` serves the network whenever it is reachable, so the cache only mattered when offline — and offline access to someone else's customer list is the problem, not the feature. Static assets are still precached, which is the part that makes this a PWA. Verified in the built artefact: `dist/sw.js` now contains exactly one `registerRoute`, the navigation fallback, and no `NetworkFirst` handler or `supabase-api` cache.
* **Part two — purge what is already there.** Removing the rule only prevents *new* caching; a browser that already holds a populated `supabase-api` cache keeps it until something deletes it. `src/lib/purgeApiCaches()` is called from both `auth.signOut()` and `auth.signOutAll()`. This is the half that actually remediates the existing exposure rather than just preventing more of it — without it, every machine that has ever used the app keeps the data.
* Best-effort by design: Cache Storage is unavailable in private windows and blocked-site-data contexts, and a purge failure must never stop someone signing out. `src/test/purgeCaches.test.js`, 7 cases — deletes the API cache, leaves the static precache alone, deletes every match not just the first, survives a missing Cache Storage, a rejecting `keys()`, and one `delete` failing mid-way.

#### [MEDIUM] Backup export contains password hashes, permission maps and webhook secrets; restore is not transactional

* ID: BUG-025
* Category: Security / Data Integrity
* Location: `src/api/backup.js` (`BACKUP_TABLES` includes `user_roles` (full row incl. `password_hash`, `permissions`, `notes`, `suspended_reason`), `webhooks` (`secret_key`), `notification_settings`, `rma_config`; only `email_settings` is redacted); `importEnvelope` upserts table by table with no transaction and continues past failures
* Description: The JSON file an admin downloads to their laptop carries a legacy credential column (1 live row is non-null) and every integration secret in clear text. A restore that fails at table 20 leaves 19 tables at backup state and the rest live — parents and children out of step.
* How to reproduce: Control Panel → Backup → Export complete backup; open the file; search `password_hash`, `secret_key`.
* Expected: secrets excluded or encrypted; restore via a server-side function in one transaction.
* Actual: as described.
* Impact: credential exposure via backup files; partial restores.
* Suggested fix: add `user_roles`/`webhooks` column allowlists like `EMAIL_SETTINGS_SAFE_COLUMNS`; implement restore as a SECURITY DEFINER RPC wrapping the upserts in one transaction.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-13 — restore is all-or-nothing.** Migrations `20260848` and `20260849`. One housekeeping action remains with the owner and is not code: delete any backup files exported before 2026-09-06, which still contain secrets.
* **How it works now.** The browser uploads the file in chunks to `restore_staging`, then `rma_restore_apply` writes every table in one transaction. If anything fails, PostgreSQL rolls the whole call back and the database is exactly as it was. The functions are SECURITY DEFINER, so the database — not the browser — enforces the rules: administrators only, only the 55 restorable tables in foreign-key order, only real writable columns, upsert on each table's actual primary key.
* **Proven against production with rolled-back probes, as a real administrator.** (1) The **entire current database uploaded and applied onto itself: 43 tables, 3,136 rows, zero row-count mismatches, 485 ms** — about a sixteenth of the 8-second statement limit. (2) A restore that renamed a brand and then failed on a product with a broken foreign key: **the rename did not survive** — while the same rename alone does land, which is what makes the rollback meaningful. (3) A technician is refused at begin, upload and apply. (4) Export-only tables are refused, and the holding table cannot be read directly.
* **The first probe found that restore had never worked on a real database.** `rma_guard_base_currency` let a no-op through only for `UPDATE`. An upsert is `INSERT … ON CONFLICT DO UPDATE`, and PostgreSQL fires BEFORE INSERT triggers before it detects the conflict — so writing back the base currency already stored was refused as a change whenever any invoice, quotation, order or payment existed. `rma_config` restores near the start, so **every restore — by the old path as much as the new — failed on any database with documents.** Measured: plain UPDATE with the same value allowed, the same value as an upsert refused. `20260849` extends the no-op check to the upsert case; a real change is still refused, verified in the migration itself.
* **The screen now tells the truth on failure:** "Your data was not changed" — replacing a message that said part of the backup had been restored, which can no longer happen. Tests rewritten to the new contract, including that a failure at a later table leaves the earlier ones unwritten and discards the upload. Full suite green (69 files, 1,437 tests).
* Verification limit, stated plainly: the database functions were exercised as a real administrator; the browser code was exercised against a test double of those functions, because running a restore through the live screen needs an administrator's login.
* **Status: PARTLY FIXED 2026-09-06** (ships with the next front-end deploy). Column allowlists added for `user_roles` and `webhooks`, following the `EMAIL_SETTINGS_SAFE_COLUMNS` pattern already in the file.
* `webhooks.secret_key` — the HMAC key a receiver uses to verify a delivery genuinely came from us — is excluded, and the table is marked `restore: false` for the same reason `email_settings` is: restoring it would overwrite live secrets with nothing.
* **This also repairs a regression I introduced earlier today.** Migration 20260825 (BUG-009) replaced `authenticated`'s table-wide SELECT on `webhooks` with a column grant omitting `secret_key`, so the backup's bare `select('*')` began failing with “permission denied for table webhooks”. The per-table error handling meant it degraded rather than killed the export, but webhooks would have been absent from every backup and listed under `failed`. Naming the columns is now required, not merely tidier.
* For `user_roles`, `permissions` is deliberately **kept** — it is the permission map, configuration rather than a secret, and a restore that dropped it would put everyone back on default access, a worse outcome than the risk. `notes` and `suspended_reason` are excluded: free text written *about a person* does not belong in a file that circulates on laptops. `suspended_by`/`suspended_date` are kept as facts about the account rather than commentary about the human. `password_hash` is simply gone (BUG-039).
* **The non-transactional restore is NOT fixed.** `importEnvelope` still upserts table by table, so a failure at table 20 leaves 19 at backup state and the rest live. Making it atomic needs a SECURITY DEFINER RPC wrapping the upserts, which is a separate piece of work and is left open rather than implied closed.
* **Old backup files remain a live exposure.** Any export taken before today still contains the webhook secret and the legacy password hash. Those files should be deleted; nothing in this fix reaches them.

#### [MEDIUM] Upload validation is inconsistent and trusts the client; object paths include unsanitised identifiers

* ID: BUG-026
* Category: Security
* Location: `src/api/storage.js` — `uploadBrandLogo` (no size/type check), `uploadProductImage` (resize only), `uploadCommentAttachment`/`uploadFile`/`uploadCustomerAttachment` (`validateAttachment` checks `file.type`, a client-supplied string); `src/api/branding.js` `uploadFavicon`/`uploadLogo` (no checks beyond a 1 MB size check in `BrandingTab.jsx`); paths `products/${productSku}/…`, `brands/${brandName.toLowerCase()}/…` use raw user input
* Description: With a public bucket (BUG-003), an SVG or HTML file uploaded as a "logo" is served from the storage origin and can carry script; a SKU containing `/` or `..` writes outside the product folder.
* How to reproduce: as a manager, set a brand logo to an `.svg` containing `<script>`; open its public URL.
* Expected: server-enforced MIME allowlist on the bucket; sanitised path segments.
* Actual: only client checks.
* Impact: stored content injection on the storage domain; path confusion.
* Suggested fix: bucket `allowed_mime_types`; `encodeURIComponent`/slugify path segments; validate SVG or disallow it.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-07** — in two parts, one of which was already done.
* **The server-enforced MIME allowlist already existed**, added with BUG-003 part 1 and confirmed live: the `rma-attachments` bucket carries `file_size_limit` 26,214,400 (25 MB) and a 15-type `allowed_mime_types` list with **SVG deliberately excluded**, so the “logo containing `<script>`” route in this finding is already refused by the storage API regardless of what the client checks.
* **What remained was path construction**, and that is now fixed. `pathSegment()` and `safeExtension()` in `src/api/storage.js` are applied to all **7** interpolated object paths. The sharp cases were `products/${productSku}/…` and `brands/${brandName.toLowerCase()}/…`, both free text a manager types: a SKU containing `/` wrote into a different folder and one containing `..` walked out of the products tree entirely. Anything outside `[A-Za-z0-9._-]` is replaced, leading dots are stripped so `..` and `.hidden` cannot survive, and an empty result falls back rather than producing a `//`. File extensions are derived safely too.
* **Still open:** `validateAttachment` continues to trust `file.type`, a client-supplied string. That now matters much less, since the bucket enforces its own allowlist server-side and is the thing that actually decides.

#### [MEDIUM] Control-panel RMA Config writes settings nothing reads; custom fields are never rendered; SLA "pause on hold" is unused

* ID: BUG-027
* Category: Logic / UX
* Location: `src/pages/cp/RMAConfig.jsx:90-96` (saves `rma_config` keys `sla_rules`, `auto_assignment_rules`, `default_settings`); the only consumers of SLA are `db.slaConfig` (key `sla_config`, edited by `SLAPolicies.jsx`) — grep finds no reader of `sla_rules`/`auto_assignment_rules`/`default_settings`; `src/pages/cp/CustomFields.jsx` manages `custom_field_definitions` but no form (`TicketForm`, `Customers/_modals`, `CustomerDetails`) renders them (grep: 0 hits outside `cp/`); `slaConfig.DEFAULT.pauseOnHold` is stored and displayed but `computeDueDate` ignores it
* Description: Three admin screens promise behaviour that has no implementation: RMA response/resolution SLA per priority (a second, disconnected SLA editor), auto-assignment rules, ticket defaults, custom fields, SLA pause.
* How to reproduce: set an auto-assignment rule; create a matching ticket → nothing assigned. Add a custom field → open any ticket/customer form → absent.
* Expected: either wired up or removed.
* Actual: dead configuration.
* Impact: administrators configure controls that silently do nothing; two SLA editors disagree.
* Suggested fix: delete `RMAConfig.jsx`'s unused sections (keep one SLA editor), remove Custom Fields until implemented, implement or drop `pauseOnHold`.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-07** (no DB change; ships with the next front-end deploy). Each of the five dead controls was decided on its own evidence rather than deleted wholesale.
* **The two dead editors were duplicates of features that WORK, which the finding did not say.** SLA targets are really set in **SLA Policies** (`sla_config`, read by `slaConfig.computeDueDate` when a ticket is raised), and conditional assignment is really done by **Automation Rules** (the `assign_technician` action, executed by `applyActions` in `api/db/system.ts`). So the app carried two SLA editors and two assignment editors, one live and one silently discarded, with nothing to tell an admin which was which. Both dead copies are removed; no capability is lost, and the page now names where each one lives.
* **Nothing was stranded by the removal.** Checked in production first: `rma_config` holds no `sla_rules` row, no `auto_assignment_rules` row and no `default_settings` row. Nobody has ever pressed Save on that screen in this installation's history.
* **`default_settings` was worth keeping, so it was made real rather than deleted.** Default priority, default status and the auto due-date window are now read by the ticket form through `useTicketDefaults`, and the key is renamed to `ticket_defaults` (free, since no row existed). Applied in an effect rather than as initial state: the config query has not resolved on the first render, so seeding from the hook would bake in the fallbacks and leave the configured values unused, which is the same defect wearing a different hat. Each field is only overwritten while it still holds the built-in fallback, so a value the user already chose is never yanked away when the config lands a moment later.
* **`pauseOnHold` is dropped, not implemented.** `computeDueDate` sets a due date once, from priority, and never revisits it, so the clock could not be paused. Honouring the toggle means accumulating per-ticket on-hold time and somewhere to store it, which is a feature rather than a fix. The toggle and the `SlaConfig.pauseOnHold` field are gone; a stored value on an existing row is ignored.
* **Custom Fields is left standing but no longer silent, and the build-or-drop choice is the owner's.** The screen manages `custom_field_definitions` correctly; what it cannot do is make a field appear, because no form reads the table and **neither `rma_tickets` nor `customers` has any column to store a value in** - so even a rendered field would have nowhere to write. Finishing it means a values column, rendering six field types across three forms, `is_required` validation, then display, export and PDF. The page now says plainly that definitions do not yet reach any form, which removes the harm: an admin defining a required field and finding no trace of it. Production has **zero** definitions, so building it or deleting the screen both lose nothing.
* Tests: `src/test/ticketDefaults.test.js`, 8 cases. One of them caught a bug in this fix: `Number(null)` is 0 and finite, so a missing `auto_due_days` clamped to 1 and would have made every new ticket due tomorrow. The same trap `money.js` guards against in `toBase()`.

#### [MEDIUM] Converting a sales order to an invoice is a check-then-insert race

* ID: BUG-028
* Category: Data Integrity / Async
* Location: `src/api/db/salesOrders.ts:215-255` (`convertToInvoice`: `select … eq('so_id') … neq('doc_status','cancelled')` then `insert`); no unique constraint on `crm_invoices(so_id) WHERE doc_status <> 'cancelled'`
* Description: Two clicks (or two users) within the round-trip create two draft invoices for one order; both can later be posted, delivering the same reservation twice (`deliver_units` moves whatever is still reserved, the second gets nothing but still bills).
* How to reproduce: double-click "Convert to invoice" with network latency.
* Expected: one live invoice per SO, enforced by a partial unique index or an RPC with `FOR UPDATE`.
* Actual: duplicates possible (0 today).
* Impact: double billing.
* Suggested fix: `CREATE UNIQUE INDEX … ON crm_invoices(so_id) WHERE doc_status <> 'cancelled'` and move conversion into an RPC.
* Confidence: Confirmed by code reading
* **Status: FIXED — applied and verified in production 2026-09-06** (`20260827_one_live_invoice_per_sales_order.sql`). A partial unique index, `crm_invoices(so_id) WHERE so_id IS NOT NULL AND doc_status <> 'cancelled'`. The client's check-then-insert stays as the friendly error; the index is the actual guarantee, and indexes do not have race conditions.
* Cancelled invoices are excluded so an order can still be re-invoiced after a cancelled attempt — the rule the application already intended. Existing data checked first: zero orders had more than one live invoice (27 invoices, 20 linked to an order, 7 cancelled), so nothing needed repairing.
* Verified by rolled-back probe (**7 passed, 0 failed**, shared with BUG-030): a first draft is accepted, a second for the same order is refused with 23505, and cancelling the first frees the slot again. Incidentally confirmed on real data — the probe's first attempt used an order that already had a live invoice and was refused by the new index.

#### [MEDIUM] Manufacturer batch numbers are derived from a row count and the batch/unit writes are not atomic

* ID: BUG-029
* Category: Data Integrity
* Location: `src/api/db/inventory.ts` `createBatch` (`BATCH-<date>-<count+1>` from `SELECT count(*)`; `manufacturer_batches.batch_number` is UNIQUE; the subsequent `inventory_units` update is unawaited-for-error and outside any transaction)
* Description: After any batch is deleted, or with two users creating batches at once, the generated number collides and the insert fails; if the units update fails the batch exists with `unit_count` but no linked units.
* How to reproduce: create two batches, delete the first, create a third → unique violation.
* Expected: sequence-backed numbering; single RPC.
* Actual: as described.
* Impact: intermittent "batch create failed"; orphan batches.
* Suggested fix: use `nextval_for_type('batch')` or a DB default; do both writes in an RPC.
* Confidence: Confirmed by code reading
* **Status: FIXED — applied and verified in production 2026-09-06** (`20260830_manufacturer_batch_rpcs.sql`, plus `src/api/db/inventory.ts` wired to the RPCs, shipping with the next front-end deploy). Numbering moved to the existing `nextval_for_type()` / `document_sequences` mechanism every other document code already uses, giving `BATCH-2026-00001`.
* The format change from `BATCH-<yyyymmdd>-<nnn>` is free: there are **zero** `manufacturer_batches` rows and zero units carrying a `manufacturer_batch_id`, so no existing identifier is invalidated. Checked before changing it.
* **The unchecked second write was the worse half and is also fixed.** `createBatch` linked the units in a separate statement whose error was never captured, so a failure left a batch claiming `unit_count` units with none attached. All three actions (`create_manufacturer_batch`, `mark_batch_sent`, `mark_batch_resolved`) are now one transaction each. The RPCs also reject a unit id that does not exist and one already belonging to another batch — checked as a set before anything is written.
* Verified by rolled-back probe (**7 passed, 0 failed**): two consecutive creates produced `BATCH-2026-00001` then `-00002`; **deleting a batch and creating another no longer collides**, which is the original defect; an unknown unit id is refused; a unit cannot be put in two batches; units really are linked in the same transaction; and `mark_batch_sent` moves the units with the batch. The `document_sequences` row was confirmed back at `last_value = 0` afterwards, so the probe left nothing behind.
* **Not changed, deliberately:** `mark_batch_resolved` still sets every unit to `closed` whatever the resolution was, so a repaired unit and a scrapped one end up identical. That is a business rule I cannot settle from the code; the semantics were carried over unchanged and the question is recorded against BUG-032 rather than guessed at.

#### [MEDIUM] Parts consumption is non-atomic and silently clamps at zero

* ID: BUG-030
* Category: Data Integrity / Logic
* Location: `src/api/db/inventory.ts` `ticketParts.add` (calls `adjust_part_quantity(-qty)` **then** inserts `ticket_parts`; `remove` re-adds quantity then deletes); live function `adjust_part_quantity` → `GREATEST(0, quantity + p_delta)` with no insufficient-stock error
* Description: Adding 5 of a part with 3 in stock succeeds, records 5 on the ticket and leaves stock at 0 — no error, 2 units accounted for nowhere. If the `ticket_parts` insert fails after the RPC, stock is decremented with no consumption record (and vice versa on remove).
* How to reproduce: set a part's quantity to 3, add 5 to a ticket.
* Expected: reject when `quantity + delta < 0`; one transaction for both writes.
* Actual: silent clamp; two independent writes.
* Impact: parts stock drifts from reality.
* Suggested fix: raise in `adjust_part_quantity` when the result would be negative; wrap add/remove in an RPC.
* Confidence: Confirmed by code reading
* **Status: HALF FIXED — applied and verified in production 2026-09-06** (`20260828_parts_reject_negative_stock.sql`). `adjust_part_quantity` no longer clamps: `GREATEST(0, quantity + p_delta)` is gone and the function raises when the balance would go below zero, naming the part and both quantities. It also now raises when the part id does not exist, where it previously returned an empty result the caller read as success. A `FOR UPDATE` lock was added so two technicians consuming the last unit at the same moment cannot both pass the check.
* **The atomicity half is NOT fixed and is deliberately left open.** `ticketParts.add()` still calls the RPC and *then* inserts into `ticket_parts` as two separate statements, so a failed insert still decrements stock with no consumption record, and `remove()` has the mirror problem. Closing that needs a single RPC doing both writes, which changes the client contract — a larger change than this migration, and the report says so rather than implying the finding is closed.
* Verified by rolled-back probe: consuming 5 of a part with 3 in stock is refused (“Not enough PROBE PART in stock: 3 available, 5 requested”), the stock is left untouched at 3 after the refusal, consuming exactly the 3 on hand still works, and adjusting a non-existent part raises.

#### [MEDIUM] `restore_units` restores any unit ids without checking they belong to the document or were delivered

* ID: BUG-031
* Category: Data Integrity
* Location: live function `restore_units(p_unit_ids uuid[], p_doc_type, p_doc_id, …)` (manager check only; loops over the ids and sets `reservation_status='available'`, writes `stock_moves` with hard-coded `from_status='delivered'`); called from `creditNotes.restoreUnits` and `void_invoice`
* Description: A manager can pass unit ids delivered on a different invoice (or currently reserved for another sales order) and flip them to available, and the ledger will claim they were "delivered → available" for a credit note that never covered them. `creditNotes.restoreUnits` then sets `restock_status='restocked'` in a second, unguarded write.
* How to reproduce: `rpc('restore_units', {p_unit_ids:[<unit reserved for SO-A>], p_doc_type:'credit_note', p_doc_id:<CN-B>, …})`.
* Expected: verify each unit's last `deliver` move belongs to the invoice the credit note references and that `reservation_status = 'delivered'`.
* Actual: unchecked.
* Impact: stock double-counted; reservations broken.
* Suggested fix: derive unit ids inside the RPC from `stock_moves` for the source invoice, reject others.
* Confidence: Confirmed by code reading
* **Status: FIXED — applied and verified in production 2026-09-06** (`20260829_restore_units_verify_ownership.sql`). A unit may now be restored only by the document that actually delivered it, and only while it is still in a delivered state. All-or-nothing: if any id in the batch fails, the whole call is refused, because a partial restore leaves a ledger nobody can reconcile.
* **The ownership chain had to be derived from the data, not assumed.** Delivery is recorded against the **sales order**, not the invoice — `stock_moves` holds 25 rows of `move_type='deliver', doc_type='sales_order'` and none against an invoice — so the check follows `credit_note → source_invoice_id → crm_invoices.so_id → deliver moves`. Checking against the invoice id directly, which the finding's wording suggests, would have matched nothing and refused every legitimate restore.
* **A second defect in the same function is also fixed.** `from_status` was the literal `'delivered'` regardless of the unit's real state, so a unit pulled out of `reserved` was written into the ledger as though it had been delivered and returned — the audit trail agreed with the corruption. It is now read from the unit.
* An unrecognised `p_doc_type` is now refused rather than waved through, so the function fails closed on anything it cannot verify.
* Verified by rolled-back probe (**7 passed, 0 failed**): a unit the document never delivered is refused; a mixed batch is refused entirely; an unverifiable `doc_type` is refused; the genuine restore still works and leaves the unit available; the ledger records the true `from_status`; and restoring the same unit twice is now refused because it is no longer in a delivered state.

#### [MEDIUM] Legacy direct-mutation inventory paths are still used by four screens and bypass the ledger

* ID: BUG-032
* Category: Data Integrity
* Location: `src/api/db/inventory.ts` `transferUnits` (marked `@deprecated`, no reservation check, no `stock_moves`), `resolveUnits`, `markBatchSent`, `markBatchResolved` (sets every unit in the batch to `closed` regardless of resolution outcome); callers `Inventory/CompanyStockTab.jsx:120,147`, `Inventory/ProductDetailModal.jsx:200,221`, `Inventory/WarehousesTab.jsx:714`, `Inventory/ManufacturerTab.jsx:457,470`
* Description: The Warehouse Dashboard and margin reporting rely on `stock_moves` as history; these paths move/close units with no ledger row, can move a **reserved** unit out from under its sales order, and can move units into system RMA warehouses (`transferUnits` has no `assert_not_system_warehouse`).
* How to reproduce: select a reserved unit in Company Stock → Transfer → any warehouse.
* Expected: all movement through `transfer_stock`/`promote_rma_unit`/`adjust_stock`.
* Actual: parallel unguarded path.
* Impact: inconsistent stock history; broken reservations.
* Suggested fix: route the four screens through the RPCs and delete the deprecated helpers (already planned as "R2").
* Confidence: Confirmed by code reading
* **Status: HALF FIXED — applied and verified in production 2026-09-06** (`20260831_guard_direct_warehouse_moves.sql`). The two behaviours that actually corrupt state are closed: a direct client transfer can no longer move a unit that is **reserved** for a sales order, and can no longer move one **into a protected system location**. Verified by rolled-back probe (**5 passed, 0 failed**), including that ordinary transfers of free units still work, that non-warehouse edits on a reserved unit are unaffected, and that server-side callers pass through so the RMA RPCs keep working.
* **The ledger half remains open and is not claimed as fixed.** These transfers still write no `stock_moves` row, so the Warehouse Dashboard and margin reporting cannot see them. Closing that means routing ByProductTab / CompanyStockTab / ProductDetailModal / WarehousesTab through `transfer_stock` / `move_rma_units` / `promote_rma_unit` — the “Warehouse Module R2” consolidation. The code comment on `transferUnits` warns explicitly that *“the feature sets differ; don't merge blindly”* (the RPC path has no equivalent of the System Pool / null-warehouse case), so that is a design decision for the owner rather than something to settle inside a migration.
* Also still open, inherited from BUG-029: `mark_batch_resolved` closes every unit in a batch regardless of the resolution outcome.
* **A test-fixture trap worth recording.** The first probe reported that a reserved unit *was* moved. It had not been: both reserved units already sat in the warehouse the probe was moving them to, so `warehouse_id` never changed and the guard correctly skipped. Re-run against a genuinely different destination, it refuses. A no-op relocation is not a bypass — check the fixture before believing the failure.

#### [MEDIUM] Deal stage/status can diverge: bulk moves are two writes, terminal stages do not set status, arbitrary status writes are allowed

* ID: BUG-033
* Category: Logic / Data Integrity
* Location: `src/api/db/deals.ts` `bulkMoveStage` (UPDATE stage, then a second UPDATE resetting `status='open', won_at=null…` for terminal deals — no transaction; moving into an `is_won`/`is_lost` stage leaves `status='open'`), `moveStage` (same for single moves via the detail page stage bar), `update()` (accepts `status`, `won_at`, `lost_at` from callers), `Pipeline/index.jsx:483-513` (drag handles won/lost specially, but `PipelineListView`/bulk does not)
* Description: `deals.status` and `deals.stage` are meant to agree (`markWon` sets both). Several paths change one without the other; no trigger enforces the invariant.
* How to reproduce: select two open deals → bulk move to the "Won" stage → `status` stays `open`; Reports "win rate" and deal value (forecast vs actual) misreport them.
* Expected: a single RPC per transition that keeps `stage`, `status`, `won_at`/`lost_at`, `probability` consistent.
* Actual: 0 inconsistent rows today, but the paths exist.
* Impact: pipeline analytics and deal-value rules drift.
* Suggested fix: `move_deal_stage` RPC + check trigger (`status='won' ⇔ stage.is_won`).
* Confidence: Confirmed by code reading
* **Status: FIXED — applied and verified in production 2026-09-06** (`20260835_deal_status_follows_stage.sql`). A `BEFORE INSERT OR UPDATE` trigger derives `status`, `won_at`, `lost_at` and `probability` from the target stage's `is_won`/`is_lost` flags, so the pair cannot come apart however the row is written.
* **It derives rather than refuses, deliberately.** Raising on a mismatch would break the pipeline board: `moveStage`/`bulkMoveStage` legitimately write only `stage`, and dragging a deal into the Won column *is* the user saying they won it. So the stage is the source of truth and the rest follows. A direct `status='won'` written against a non-won stage is normalised back to follow the stage rather than silently accepted.
* Existing data was checked first: all 56 deals already agreed with their stage, so nothing was rewritten.
* Verified by rolled-back probe (**5 passed, 0 failed**): a stage-only move to Won now sets `status='won'`, `won_at` and `probability=100`; moving back to an open stage resets to `open` and clears both timestamps; the Lost stage sets `lost_at` and `probability=0`; a contradictory `status='won'` on an open stage is normalised; and `markWon`'s combined write is unaffected.

#### [MEDIUM] Sales-document state machine is unenforced and inconsistent between screens

* ID: BUG-034
* Category: Logic
* Location: `quotations.reopen()` sets `draft` (used by `DealDetail.jsx:590`) while `SalesDocumentDetail.jsx:251` "reopen" calls `markSent` (`sent`); `quotations.cancel` allowed on a `converted` quotation; `salesOrders.markSent` allowed from `delivered`/`cancelled`; `crmInvoices.cancelDraft` guarded, but nothing stops `update()` on a posted invoice's `line_items` (client) — see BUG-002 for the DB side
* Description: Without a transition table (as `assert_purchase_status_transition` provides for purchasing) the same button means different things on different pages and impossible transitions are one API call away.
* How to reproduce: convert a quotation to an SO, then call "Cancel" on the quotation from the deal tab → quotation `cancelled` while its SO lives on.
* Expected: one transition map per document type, enforced by trigger.
* Actual: none for the four sales tables.
* Impact: documents in contradictory states; reports count them wrongly.
* Suggested fix: port `assert_purchase_status_transition` to `quotations`, `sales_orders`, `crm_invoices`, `credit_notes`; unify the "reopen" semantics.
* Confidence: **Confirmed by execution (2026-09-03)**, and the severity above is understated — see the note below.
* **Severity correction: this finding contained a Critical-grade gap, not a Medium one.** Rated Medium on the assumption it was a consistency problem. Probing it while fixing showed two live bypasses that BUG-002's guard did not cover, because that guard deliberately stands aside while a document is *still a draft*: a sales rep could `PATCH crm_invoices {"doc_status":"posted"}` and `PATCH credit_notes {"status":"issued"}` on their own drafts, both reproduced in a rolled-back transaction. `post_invoice()` and `issue_credit_note()` each open with `IF NOT rma_is_manager_or_above() THEN RAISE`, then assign the gapless document code, and for invoices verify that the serialized units being billed are actually reserved, deliver them and compute COGS. Writing the column by hand skips every one of those, so posted revenue could enter the ledger with a NULL `inv_code`, no stock check and no cost — performed by the one role the RPC would have refused. It is an authority bypass and an integrity bypass at once.
* **Status: FIXED — applied and verified in production 2026-09-03.** All eight checks: *"PASS draft -> posted refused. PASS draft -> cancelled still allowed. PASS draft -> issued refused. PASS converted quotation is terminal. PASS draft -> sent still allowed. PASS declined -> sent (reopen) still allowed. PASS the RPC context can still post. PASS admin restore path still writes status."* `supabase/migrations/20260815_assert_sales_status_transitions.sql` (verify: `supabase/manual/20260853_verify_sales_status_transitions.sql`) adds `rma_assert_sales_status_transition()`, the sales-side sibling of `assert_purchase_status_transition()` in the same house style — one function, a `CASE` on `TG_TABLE_NAME`, a per-status allow-list — expressed as what a *browser* may do, since RPCs return at the first branch. Maps were read off the client helpers and the screens that call them: **crm_invoices** allows only `draft -> cancelled` (`cancelDraft()` is its sole client status write); **credit_notes** allows nothing at all (`creditNotes.update()` is typed `Pick<'line_items'|'reason'|'assigned_rep'|'source_invoice_number'>` and cannot reach the column); **quotations** follow the buttons — Send from draft, Cancel from draft/sent/accepted, Reopen only from cancelled/declined setting `sent`, and `'converted'` terminal, which is the exact inconsistency this finding named (`quotations.cancel()` would orphan the sales order behind it; the UI already hides the button, and now the database agrees rather than depending on that). Both `reopen` targets (`sent` and `draft`) are permitted so neither screen breaks. **Not fixed:** the UI half — "reopen" still means `markSent() -> 'sent'` on Sales Documents and `quotations.reopen() -> 'draft'` in the deal screen's action map. Making the word mean one thing is an application change.

#### [MEDIUM] RMA numbers are generated client-side from the loaded ticket list

* ID: BUG-035
* Category: Data Integrity / Async
* Location: `src/pages/RMATickets/_utils.js` `generateRmaNumber(existingTickets)` (max of today's serials + 1 from the `tickets` prop, which `rmaTickets.list()` caps at 5,000 rows); `TicketForm.jsx:589` (`previewRmaNumber` computed at mount) and `:625` (recomputed at save); `rma_tickets.rma_number` UNIQUE
* Description: Two users creating tickets concurrently get the same number; the second save fails with a unique violation shown as "Failed to save ticket: duplicate key…". The preview shown in the form header may differ from the saved number if another ticket was created meanwhile, and past 5,000 tickets the numbering restarts.
* How to reproduce: open the create form in two tabs, save both.
* Expected: server-generated sequence (`nextval_for_type('rma')` or a default).
* Actual: client max+1.
* Impact: sporadic save failures; misleading preview.
* Suggested fix: DB-side generation in a `BEFORE INSERT` trigger or RPC.
* Confidence: Confirmed by code reading
* **Status: FIXED — applied and verified in production 2026-09-06** (`20260832_server_assigned_rma_numbers.sql`; client changes ship with the next front-end deploy). A `BEFORE INSERT` trigger assigns `rma_number`, always, ignoring whatever the client sent. The `RMA-DDMMYYYY-NNNN` format is unchanged because it is printed on work orders and QR codes.
* Races are settled with a **transaction-scoped advisory lock keyed on the date**, so two concurrent inserts on the same day queue behind it and each reads a maximum that already includes the other. A sequence would not fit: the serial restarts daily and `document_sequences` resets yearly, so locking on the day and taking max+1 preserves the existing numbering exactly.
* Verified by rolled-back probe (**4 passed, 0 failed**): two inserts *both claiming* `RMA-01011999-0001` — the exact collision two users hit — came out as consecutive numbers for today; the bogus 1999 date was overridden; a garbage value was replaced and the run continued.
* **The browser still generates a provisional number**, and that is deliberate: the form uploads attachments before the row exists, under a folder named after the number, so it needs *a* string up front. That value is now only a folder name — `TicketForm` uses `newTicket.rma_number` from the saved row for the audit entry, the side effects and anything the customer sees. Keying attachments by ticket id instead belongs to BUG-026.

#### [MEDIUM] Ticket resolutions default to USD with a hard-coded currency list while the base currency is EGP

* ID: BUG-036
* Category: Logic / UX
* Location: `src/pages/RMATickets/TicketForm.jsx:426,465,710,1433`, `TicketDrawer.jsx:81,209,807,913` (`currency: 'USD'`, list `['USD','EUR','GBP','AED','SAR','EGP']`); `src/lib/money.js` header comment documents this exact defect as fixed elsewhere; `ticket_resolutions.currency` has no FK to `currencies`
* Description: Every refund/credit resolution saved without touching the dropdown is recorded in dollars; the list ignores the `currencies` table and the base-currency config.
* How to reproduce: save a resolution with an amount → `currency = 'USD'`.
* Expected: default to `default_currency` config, options from `currencies.is_active`.
* Actual: USD.
* Impact: financial amounts recorded in the wrong currency.
* Suggested fix: use `useBaseCurrency`/`useCurrencyOptions` hooks already present in `src/hooks`.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-07** (ships with the next front-end deploy).
* Both forms now default the resolution currency to the installation's base currency and take their options from the `currencies` table, through the existing `useBaseCurrency` / `useCurrencyOptions` hooks. The hardcoded `['USD','EUR','GBP','AED','SAR','EGP']` list is gone from both files, and `'USD'` no longer appears as a currency literal anywhere in `src/`.
* **The currency is resolved late, not seeded early, and that matters.** The state still starts empty and becomes `baseCurrency` at render and at save. Seeding the initial state from the hook would freeze whatever it returned on the first render, which is the EGP fallback because the config query has not resolved yet; an installation whose base currency is not EGP would then record every resolution in EGP. That is the same defect with a different wrong answer.
* The drawer's read-only view also went through `formatMoney`, so an amount now prints as `E£ 1,234.00` rather than `EGP 1234.00`.
* **No data repair was needed, checked rather than assumed:** `ticket_resolutions` holds 2 rows, both `currency = 'USD'`, and **both have a null amount**. No financial value is mislabelled, so there is nothing to correct.

#### [MEDIUM] Reports pipeline and sales sections hard-code a dollar sign

* ID: BUG-037
* Category: Logic / UX
* Location: `src/pages/Reports.jsx:850-851` and `:1168-1169` (`fmt$ = (v) => \`$${…}\``), used for open pipeline value, won value, quotation/order/invoice funnel values and collected cash
* Description: Amounts stored in the base currency (EGP) are labelled `$`. `src/lib/money.js` exists precisely to prevent this and is used elsewhere.
* How to reproduce: Reports → Pipeline / Sales tabs.
* Expected: `formatMoney(value, baseCurrency)`.
* Actual: `$1,234.00`.
* Impact: management reports state the wrong currency.
* Suggested fix: replace `fmt$` with `formatMoney` and `useBaseCurrency`.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-07** (ships with the next front-end deploy).
* All three `fmt$` helpers in `Reports.jsx` are replaced by `formatMoney(value, baseCurrency)` across 16 call sites. The finding listed two; there was **a third** in `FinancialTab` (total invoiced, total paid, outstanding, quotation value, and the per-invoice rows), fixed with them.
* **A fourth site the finding did not list:** `CustomerDetails.jsx:1313` rendered deal value with a hardcoded dollar sign. Same defect, same fix.
* Amounts now read `E£ 1,234.00`, using the currency's own decimal count via `money.js` - the module that exists precisely to stop this and was already used elsewhere.

#### [MEDIUM] Date handling mixes UTC and local time; due dates and overdue flags are off by up to a day

* ID: BUG-038
* Category: Logic (date/time)
* Location: `src/pages/RMATickets/_utils.js` `DEFAULT_DUE` and `src/api/db/system.ts` `slaConfig.computeDueDate` (`toISOString().split('T')[0]` → UTC calendar date; for Cairo (UTC+2/+3) any ticket created before 02:00–03:00 local gets yesterday's date + N); `Dashboard.jsx:590,625`, `Reports.jsx:230,244,444,1593`, `TechCalendar.jsx:81`, `TicketDrawer`/`RMATickets` overdue checks (`new Date(due_date) < new Date()` where `due_date` is a `date` column → parsed as UTC midnight, so a ticket due *today* is "overdue" from 02:00–03:00 local); `Reports.jsx:244` on-time = `updated_date <= due_date` (midnight) → anything closed on the due day after 00:00 UTC counts as late; `customerLedger.agingReport` similar
* Description: The app is used in Egypt but every date comparison is UTC-based, and end-of-day is never applied to `date` columns.
* How to reproduce: at 01:00 Cairo time create a ticket; the default due date is 6 days ahead, not 7. Set a due date of today; the dashboard "overdue" count includes it from ~03:00.
* Expected: local-date arithmetic (`format(new Date(), 'yyyy-MM-dd')` from date-fns) and end-of-day comparisons for `date` columns.
* Actual: UTC.
* Impact: SLA/overdue statistics and customer overdue emails (`queue_overdue_ticket_emails` uses `CURRENT_DATE` in the DB timezone, a *third* convention) disagree.
* Suggested fix: centralise date helpers; treat `date` columns as inclusive end-of-day in the business timezone.
* Confidence: Confirmed by code reading
* **Status: FIXED (browser side) 2026-09-06** (ships with the next front-end deploy). New `src/lib/dates.js` centralises the conversions; `DEFAULT_DUE`, `slaConfig.computeDueDate` and the Dashboard's overdue comparisons now use it.
* **Two distinct mistakes, both from mixing local arithmetic with UTC formatting.** *Writing*: `d.setDate(d.getDate() + 7)` followed by `toISOString().split('T')[0]` — local arithmetic, UTC formatting — so at 01:00 Cairo it is still the previous day in UTC and “seven days from today” came out as six. *Reading*: `new Date(t.due_date) < new Date()`, where `new Date('2026-09-06')` is parsed by the spec as **UTC midnight**, so a ticket due today became overdue at 02:00–03:00 Cairo — the dashboard called work late while the person doing it still had the whole day.
* A `date` column carries no time. “Due 6 September” means the *end* of the 6th, so `isPastDueLocal()` compares against end-of-day in the reader's timezone, and `parseDateOnlyLocal()` uses `parseISO`, which treats a bare `yyyy-MM-dd` as local where `new Date()` does not.
* **The third convention is left alone, on purpose.** `queue_overdue_ticket_emails` uses `CURRENT_DATE`, and the database's timezone is **UTC** (verified: `current_setting('TimeZone')` = `'UTC'`). Reconciling that means deciding the business timezone and setting it in one place — an owner decision, not something to hard-code. These helpers make the browser self-consistent, which it was not; the browser-versus-cron difference remains for the first two or three hours of a Cairo morning and is recorded here rather than quietly closed.
* Tests: `src/test/dates.test.js`, 15 cases with the clock pinned to specific local wall-clock times — including the 01:00 case that was wrong, a loop asserting a positive offset never returns yesterday at any hour, and “due today is not overdue” at both 03:00 and 23:30. **Two of my own implementations were wrong and the tests caught them**: `daysUntilDueLocal` used `Math.ceil` on a raw interval, so “due today at 09:00” reported 1 day remaining and “due in 3 days” reported 4. Both now use calendar-day differences.
* Not changed: the sort comparator at `Dashboard.jsx:716` compares two due dates to each other, so both sides parse identically and the ordering is correct regardless of timezone.

#### [MEDIUM] Legacy `user_roles.password_hash` column still holds a value and is readable by admins

* ID: BUG-039
* Category: Security
* Location: live `user_roles.password_hash` (1 non-null row); readable through `listAllRoles()` (`select('*')`) by any admin; exported by backups (BUG-025)
* Description: A credential store nobody maintains, from the Base44 era; the migration comments already flag it.
* How to reproduce: `SELECT count(*) FROM user_roles WHERE password_hash IS NOT NULL` → 1.
* Expected: column dropped.
* Actual: present.
* Impact: credential exposure if the hash is weak or reused.
* Suggested fix: `ALTER TABLE user_roles DROP COLUMN password_hash`.
* Confidence: Confirmed by execution
* **Status: FIXED — applied and verified in production 2026-09-06** (`20260826_drop_legacy_password_hash.sql`). The column is gone; all 17 `user_roles` rows intact.
* **The one stored value was an unsalted SHA-256** (64 hex characters), belonging to `bika.qds@gmail.com` — cheap to attack offline, and a risk beyond this application because people reuse passwords. Nothing in `src/**` or `supabase/functions/**` read the column; the only mention was a comment marking it legacy.
* **The migration's first guard was too strict and refused to run, which was the right outcome.** It demanded a Supabase Auth account for every active row and found 10 without one. Those are the `@test.com` seed fixtures from 20260706 whose purge is deferred, and **none of them carried a hash** — so they cannot authenticate by any route and the column was irrelevant to them. Narrowed to the condition that actually matters: refuse only if a row that *holds* a hash has no auth account. Measured before narrowing, not assumed.
* Deliberately irreversible — destroying the hash is the point, so no rollback restores it. **Old backup files taken before today still contain it** and should be deleted rather than kept; that is BUG-025's remaining work.

#### [MEDIUM] Customer detail "related tickets" matches by display name, leaking tickets between same-named customers

* ID: BUG-040
* Category: Logic / Security
* Location: `src/api/db/customers.ts` `getRelatedTickets(customerId, customerNames)` (second query `in('customer_name', names)`); `CustomerDetails.jsx:41`
* Description: Two customers named "Ahmed Ali" (14 duplicate mobiles already exist, see BUG-063) see each other's RMA history, and a rename detaches history that is linked only by name. The `rma_tickets.customer_id` FK exists (only 1 ticket lacks it).
* How to reproduce: create two customers with the same contact name; create a ticket for one; open the other.
* Expected: FK only.
* Actual: name fallback.
* Impact: wrong history shown; customer PII cross-exposure.
* Suggested fix: drop the name query once the single legacy ticket is linked.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-06** (ships with the next front-end deploy). `getRelatedTickets` matches on the `customer_id` foreign key only; the second query matching `customer_name` against a list of names is gone.
* **Verified that the fallback protected nothing before removing it.** It existed for tickets predating the FK. There is exactly **one** ticket without a `customer_id` today — `RMA-06082026-0001`, “QA Walk-in No CRM Link” — a deliberate walk-in with no customer record, which should not appear under anybody. So the name query could never return a legitimately-owned ticket and could only ever produce cross-exposure.
* The impact was not merely a wrong count: with 14 duplicate mobile numbers already in the data, two customers sharing a contact name each saw the other's RMA history, including fault descriptions and the products involved. Renaming a customer also detached history linked only by name.
* The `customerNames` parameter is kept in the signature and ignored, so `CustomerDetails.jsx` needs no coordinated change and cannot silently start passing something that matters again.

#### [MEDIUM] Live data already violates ledger and stock invariants

* ID: BUG-041
* Category: Data Integrity
* Location: live data — `crm_invoices` INV-2026-00010/11/12/13/14/15 (posted 2026-06-08 by `*@test.com` seed accounts) have `amount_paid > 0` and `payment_status` paid/partial but **zero** `payment_applications`/`credit_note_applications`; 15 `sales_orders` with `status='delivered'` have no `stock_moves` rows; 8 live `inventory_units` have an empty serial; 3 posted invoices have no `due_date`
* Description: The seed/fixture invoices sit on real customer statements (`v_customer_ledger` shows the invoice at full total and no payment, while the invoice itself says "paid"), so those customers' balances are wrong; the delivered orders without moves are either legacy or created via the direct-status path in BUG-004.
* How to reproduce: queries in Appendix B.
* Expected: `amount_paid = Σ applications`; every delivered SO has reserve/deliver moves.
* Actual: 6 + 15 violations.
* Impact: wrong AR balances and aging for the affected customers; misleading stock history.
* Suggested fix: after the fixture purge (deferred by decision), add a scheduled integrity check (`amount_paid` vs applications; delivered SO ⇒ moves) and fix or void the rows.
* Confidence: Confirmed by execution
* **Status: FIXED 2026-09-13 — closed.** The code half is done: `rma_data_integrity_issues()` reports every violation and new ones are prevented where they can be. What remained was repairing the existing rows, and the owner has confirmed the entire current dataset is test data that will be erased before real use — so there is nothing left to do here. The check stays, to watch the fresh data.
* **Status: PARTLY FIXED 2026-09-13** - detection applied in production (`20260839`, extended by `20260843`); the money half is now repaired and the check reports **no high-severity findings at all**. What remains open is the medium tier: 15 delivered orders with no stock moves, 14 duplicate mobiles, 3 due dates, 10 role rows with no account. The 2026-09-07 note said the repair half was blocked on the deferred fixture purge; that was right about the invoices and wrong about the payments, which could be corrected without touching the documents.
* **Re-confirmed against live data today, and the numbers are unchanged:** 6 invoices with `amount_paid` unbacked by any application, 15 of 20 delivered sales orders with no `stock_moves`, 8 inventory units with a blank serial, 3 posted invoices with no due date. 32 violating rows.
* **Nothing was repaired, on purpose.** Most of these rows are the seed/fixture data whose purge the owner explicitly deferred until after launch. Rewriting or voiding financial rows on that basis would turn a reporting problem into a data-loss one, and the decision is not mine to make.
* **What was added is the half that does not depend on the purge:** `rma_data_integrity_issues()` returns one row per violation (check, severity, entity, reference, human-readable detail) and `rma_data_integrity_summary()` the grouped counts, admin-only via `rma_is_admin()`. Surfaced in Control Panel -> Data Cleanup behind an explicit "Run checks" button, because the scan touches every invoice, order and unit while that screen is opened to tidy tickets far more often than to audit the books. The value is not in counting today's known-bad 32; it is that the 33rd, in real trading data after launch, stops being invisible until someone disbelieves a customer statement.
* The migration's own guard refuses to finish if `unbacked_amount_paid` returns nothing, because a check that reports a clean database while six invoices are known bad is worse than no check: it gets believed.
* **A trap worth recording: reversal rows carry a NEGATIVE `amount_applied` AND set `is_reversal`.** My first version of this query subtracted reversals as well, double-counted them, and reported two perfectly healthy invoices (INV-2026-00019, INV-2026-00020) as violations with applications at twice their total. Caught by inspecting the individual rows before drawing any conclusion. The net applied is a plain `SUM`; a rolled-back probe now asserts specifically that a reversed-to-zero invoice is **not** flagged.
* Verified by rolled-back probe (**4 passed, 0 failed**): an admin sees all four checks; the counts are exactly 6/15/8/3; a reversed-to-zero invoice is not flagged; a manager is refused with `insufficient_privilege`.
* **Repaired 2026-09-13, and the finding was mis-severed.** The six are not a code defect. The audit rated this High; the evidence says the payment path is provably correct and what was wrong was the seed data sitting on top of it.
* **What the numbers gave away.** The three `partial` invoices claimed **exactly 40.0000%** of their totals and the three `paid` ones exactly 100.0000% — 00010 through 00015, a contiguous block, all created 2026-06-05 and posted 2026-06-08, four of them by `@test.com` accounts. Nobody pays exactly 40.0000% of three different invoices. A seed script wrote `amount_paid` directly instead of calling `record_payment`.
* **There was nothing to recover.** The whole `payments` table holds 3 rows and `payment_applications` 5, every one of them belonging to the August invoices. Not one payment row exists for any of those six customers, so this was never a lost link between a real payment and its invoice — the money was never there. **E£106,554.11 of payments that never happened.**
* **The application is correct, and that is the more important half.** Every invoice created through the real workflow reconciles: INV-2026-00017 carries three backing rows and balances exactly, and 00019/00020 carry reversals that net to zero and are correctly *not* flagged. The invariant holds for 100% of documents the app produced.
* **What made it worth fixing rather than annotating:** 865 of 888 customers were imported on 2026-05-21, so these are **real customers carrying fabricated invoices**. Anyone opening one of those six statements saw an invoice claiming a payment that never happened, with the ledger and the invoice disagreeing about it — the ledger reads applications and found none.
* **The repair, on the owner's instruction:** `amount_paid = 0`, `payment_status = 'unpaid'`, and a note on each row saying why. The invoices themselves are untouched, per the deferred fixture purge. Inventing `payment_applications` rows to match the claimed figures would have made the check go green by fabricating financial records, which is why it was not done.
* **Verified after the write:** all six now agree — what the invoice says is outstanding equals what the applications say, on every one. `unbacked_amount_paid` reports **0**, and the integrity check has **no high-severity findings left at all**. The settled-document guard from BUG-002 was probe-tested first to confirm it would permit the correction rather than refuse it half-way through.
* **Why zeroing rather than leaving it:** six permanent false positives at `high` would have trained everyone to ignore the one check that catches a real money error later. The check is now quiet, so the seventh violation will be visible.
* **`delivered_without_stock_moves` investigated 2026-09-13; data deliberately left alone.** All 15 are one seed cohort and nothing downstream is wrong.
* **The tell is a single timestamp.** Every one of the 15 carries `updated_at = 2026-07-05` — one script pass flipping `status` to `delivered`. And every one of their totals matches a June invoice exactly: 43,726.22 → INV-2026-00011, 33,934.75 → 00012, 26,218.22 → 00010, 30,842.01 → 00015, and so on, 15 for 15. It is the same seed batch as the invoices and the fabricated payments cleared above: orders → invoices → payments that never happened.
* **Inventory is not wrong, which is the part that mattered.** Zero `inventory_units` are reserved against those orders and zero `stock_moves` reference them in any way. Nothing was decremented — the correct state for a delivery that never occurred. On-hand counts are sound.
* **The delivery path itself works.** All 5 delivered orders that DO carry stock moves are real workflow: four created in August by the owner, plus SO-88753047. SO-78334548 alone wrote 40 moves. So, as with the money, the application is correct and the seed data is not.
* **Why this one was not 'repaired' when the payments were.** Zeroing `amount_paid` was straightforwardly more true: no payment existed, so zero is the fact. Reverting `delivered` to `confirmed` would swap one untrue status for another — the delivery did not happen, but neither did the confirmation — while degrading what the demo data exists to show. Nothing downstream changes either way: no money, no stock, no customer statement. The fixture purge at launch is the real resolution.
* **The cohort is recorded here so the check keeps its meaning:** these 15 are the known baseline, identifiable by `updated_at = 2026-07-05`. A sixteenth `delivered` order with no stock moves is a genuine problem, not more of the same.
* **A false alarm caught before it was reported, recorded because the shape of it will recur.** Reconciling `warehouse_stock` (2 rows, 39 units) against `inventory_units` (424 units across 62 product/warehouse pairs) appears to show 60 pairs disagreeing. It does not. `products.stock_tracking_mode` splits the catalogue: **405 serialized** products tracked as individual units, **1 bulk** product tracked as a quantity, with zero overlap between the two tables. They are two parallel models, each internally consistent, and comparing them invents a discrepancy — the same mistake that once made the AP aging query report two healthy invoices as broken.

#### [MEDIUM] Untranslated UI strings (2,398) and locale key drift break the Arabic experience

* ID: BUG-042
* Category: UX
* Location: eslint `no-restricted-syntax` report (2,398 hardcoded user-visible strings across `src/pages`, `src/components`, `src/App.jsx` — e.g. `App.jsx` "Account Settings", "Sign out", MFA screen; `RMATracker.jsx` "Support Team", "↩ Reply", `alert('Failed to send message…')`); `src/locales/ar.json` missing 7 keys present in `en.json` (`userManagement.moduleCount`, `userManagement.overriddenCount`, `cp.pipelineStages.dealCount`, `cp.pipelineStages.cantDeleteInUse`, `cp.pipelineStages.orphanCount`, `cp.pipelineStages.repairConfirm`, `cp.pipelineStages.repaired`) and carrying 47 keys `en.json` does not
* Description: The project ships RTL/Arabic as a feature; a third of the interface remains English and punctuation renders on the wrong edge (the rule's own message).
* How to reproduce: switch to Arabic; open Account Settings menu, MFA screen, tracker.
* Expected: full coverage; locale files in sync (a unit test comparing key sets would catch this).
* Actual: as measured.
* Impact: inconsistent Arabic UI; CI red (BUG-016).
* Suggested fix: translate the flagged strings; add a locale-parity test.
* Confidence: Confirmed by execution
* **Status: FIXED 2026-09-07** (ships with the next front-end deploy). Both halves are closed, and **both of the finding's numbers were wrong** - verified rather than taken on trust.
* **"2,398 hardcoded strings" was the total `no-restricted-syntax` count, not the i18n one.** That rule carries two messages, and 2,391 of those warnings are the *design-token* rule complaining about raw hex colours (UX-GLOBAL-001). The actual count of hardcoded user-visible text (UX-GLOBAL-003) was **36**, not 2,398 - a tractable number, and now **7**.
* Translated: `ErrorBoundary` (6 strings), `PrintLabel` (17), `NotFoundPage` (5), `RMATracker` (7, including the `alert('Failed to send message...')` the finding named, now a toast and the last native dialog on that page), `AIAssist` (4), `BrandingTab` (13), `EmailSettingsTab` (12), `TemplatesTab` (2), `SLAPolicies` (2), plus the customer bulk-status options, the Login forgot-password intro and the ticket drawer's "Customer" badge.
* `ErrorBoundary` is a class, so it uses the i18next singleton - and every lookup passes a `defaultValue`. This is the screen that renders when something has already gone wrong, and a failed i18n init is one of those things; without a default it would paint the raw key at the user on the one screen where legibility matters most.
* **The 7 left are deliberate**, each a case where translating would be wrong rather than merely undone: `resend.com` and the `Resend` provider option (a URL and a product name); two strings inside `PDFLayout`'s live *preview of the generated PDF*, which is produced in a fixed language, so translating the preview alone would misrepresent the artifact; the WhatsApp/Email/SMS channel identifiers in `WALogs`; an admin diagnostic line in `WATestCenter`; and a button label inside a test fixture.
* **The "missing 7 keys / 47 extras" drift is gone, and the extras were never drift.** `ar.json` is now missing **0** English keys. Of its 207 English-absent keys, **all 207** are Arabic CLDR plural categories (`_zero`, `_two`, `_few`, `_many`) that English does not have - correct translation, not leftovers. A naive set comparison would have failed on correct Arabic.
* Tests: `src/test/localeParity.test.js`, 5 cases - every English key exists in Arabic; no orphaned Arabic key survives a rename (plural variants exempted, with a separate case asserting that exemption still matches something so it cannot quietly decay into a plain set comparison); no Arabic string is blank where English has text (two keys are blank in *both* on purpose and stay allowed); and interpolation placeholders match, except `{{count}}` inside a plural form - Arabic's `_one` and `_two` mean exactly one and exactly two, and idiomatic Arabic names the thing rather than repeating the numeral, so demanding it would force unnatural Arabic to keep a test green.

#### [MEDIUM] Overdue-ticket emails are re-queued daily forever and will flood customers when the drain is repaired

* ID: BUG-043
* Category: Logic
* Location: live function `queue_overdue_ticket_emails()` (cron 08:00; dedupe only against jobs created in the last 23 h; no cap per ticket; no check that a previous email was *sent*); `notification_queue` currently holds 341 pending `ticket.overdue` emails across the open tickets
* Description: A ticket overdue for 60 days has ~60 queued emails. Fixing BUG-005 without draining first sends all of them; even after that, customers receive one reminder per day indefinitely.
* How to reproduce: `SELECT payload->>'ticketId', count(*) FROM notification_queue WHERE event_type='ticket.overdue' AND status='pending' GROUP BY 1 ORDER BY 2 DESC`.
* Expected: one reminder per ticket per escalation step, deduped against `notification_logs`.
* Actual: unbounded.
* Impact: customer spam; domain reputation.
* Suggested fix: dedupe on `notification_logs` (sent within N days), cap reminders, purge the backlog before enabling the drain.
* Confidence: Confirmed by execution
* **Status: FIXED — applied and verified in production 2026-09-03** (`supabase/migrations/20260816_bound_overdue_reminders_and_clear_backlog.sql`, verify `supabase/manual/20260855_verify_overdue_reminder_bounds.sql`). **The harm was already done, not pending:** the 341 queued jobs were for only **six** tickets, and `notification_logs` showed 118 overdue emails had *already been delivered* to those same six — 28, 28, 21, 19 and 18 for a single ticket each. **Correction (2026-09-06):** an earlier revision of this entry said those went to "five customers". They did not. Checking `notification_logs.recipient` shows all 118 went to the project owner's own two addresses (`bika.qds@gmail.com`, `bika_as@hotmail.com`) — the customer records on those tickets carry the owner's email, so no external customer was spammed. The defect was identical in kind and the fix unchanged; only the blast radius was smaller than first reported, and one real address on any of those rows would have made it twenty-eight emails to a stranger. They went out through the app, because the browser fires the worker after ticket events, so the queue drained in bursts even while the scheduled drain was dead. Three conditions now replace the single 23-hour check: nothing queued while a job for that ticket is already `pending`/`processing` (the missing condition that caused the pile-up — the old one asked when a job was *created*, not whether it was still waiting), nothing within `c_min_gap_days` of a delivery recorded in `notification_logs`, and never more than `c_max_reminders` in total. The two numbers (3 days, 5 reminders) are **business policy rather than anything the data dictates**, so they are constants at the top of the function; say the word to change them. Backlog: 341 jobs cancelled (not deleted, so the record survives), the ten pending WhatsApp jobs deliberately left alone. **Consequence worth stating: the five worst-affected tickets are far past a cap of five, so they will receive no further reminders at all** — intended, given they have each had eighteen or more. Verified live: *"PASS first run queued exactly 1. PASS second run added nothing while one was pending. PASS a delivery inside the gap suppressed the next reminder. PASS the cap held with 5 deliveries logged and none recent."*

#### [MEDIUM] CSV/XLSX exports do not neutralise spreadsheet formulas

* ID: BUG-044
* Category: Security
* Location: `src/pages/Inventory/_shared.jsx:140-158` (`downloadCSV` escapes quotes only), `src/pages/Reports.jsx:16` (`downloadCSV`), `Customers/index.jsx`, `Products/index.jsx`, `Leads/index.jsx`, `Pipeline/index.jsx`, `Purchasing/index.jsx`, `SalesDocuments/index.jsx` (`XLSX.utils.aoa_to_sheet` with raw strings)
* Description: A customer named `=HYPERLINK("http://evil","click")` or `=cmd|' /C calc'!A0` (entered by a sales rep, a lead import, or via the public tracker author name) executes when a manager opens the export in Excel.
* How to reproduce: create a lead with `full_name = '=1+1'`, export leads, open in Excel.
* Expected: prefix `=`, `+`, `-`, `@`, tab and CR with `'` (or use SheetJS cell type `s` with `t:'s'` and leading apostrophe).
* Actual: raw.
* Impact: CSV injection on staff workstations.
* Suggested fix: a shared `csvSafe()` applied in every exporter.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-06** (ships with the next front-end deploy). One shared encoder in `src/lib/csv.js` (`csvCell`, `toCsv`, `downloadCsvText`) replaces **three** hand-rolled copies — `Inventory/_shared.jsx`, `Reports.jsx` and `cp/AuditLog.jsx`. A leading `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`, which spreadsheets consume as “treat the rest as text”.
* **A third exporter was found that the finding did not list, and it was the worst of them.** `cp/AuditLog.jsx` built its CSV by hand and escaped only `action_details` — `user_email` and `action_type` were interpolated raw, so a comma in either shifted every later column. `action_details` is free text written by whoever created the log entry.
* **Numbers are deliberately exempt.** Blanket-prefixing anything starting `-` would turn every negative amount in a financial export into the text `'-1234.50` and break the sums the export exists for. A value that parses as a plain number cannot carry a formula, so it is left alone; `-2+3+cmd|x` still is not.
* **XLSX exports were checked and left alone, on evidence.** SheetJS writes strings as string cells (`t:'s'`) unless given an `f` property, so a leading `=` renders literally in Excel rather than evaluating. The CSV path was the reachable one.
* Tests: `src/test/csv.test.js`, 16 cases — the classic `=cmd|' /C calc'!A0` and `=HYPERLINK` payloads, tab-prefixed formulas, negative numbers left intact, RFC 4180 quoting preserved, and the comma-shift the Audit Log exporter had. Two of my own expectations were wrong on first run (a tab is not a CSV delimiter, so those values need the prefix but no quoting); the code was right and the tests were corrected.

#### [MEDIUM] Bulk CSV imports skip validation and insert row by row

* ID: BUG-045
* Category: Logic / Performance
* Location: `src/pages/Customers/index.jsx:741-870` (custom `parseCSVLine`, no email/phone validation — `customerSchema` is used only for single creates; duplicate detection only against the ≤5,000 rows loaded), `src/pages/Products/index.jsx:534-670` (same; header names case-sensitive), `src/pages/Leads/index.jsx:752-812` (`for … await db.leads.create(lead)` — one request per row, no rollback, partial imports on failure; no `assigned_rep`/email validation)
* Description: Invalid emails and phones enter the database (the form-level zod rules are bypassed), a 2,000-row lead file makes 2,000 requests, and a failure mid-way leaves a partial import with no report of which rows landed.
* How to reproduce: import a CSV with `email = "notanemail"`.
* Expected: same schema validation as the forms; batched inserts (`bulkCreate`) with a per-row error report.
* Actual: as described.
* Impact: dirty data; slow imports; partial state.
* Suggested fix: run `customerSchema`/`leadSchema` per row; use `bulkCreate`.
* Confidence: Confirmed by code reading
* **Status: PARTLY FIXED 2026-09-07** (ships with the next front-end deploy). Two of the three problems are closed; the third is a deliberate non-change, explained below.
* **Dirty data.** `src/lib/importValidation.js` is now applied per row in the Customers and Leads importers, and a row with a malformed address is rejected with a reason rather than stored. The finding's own repro — `email = "notanemail"` — no longer reaches the database.
* **2,000 rows, 2,000 requests.** True of Leads only, and now fixed: `db.leads.bulkCreate()` inserts in chunks of 200 (chunked rather than one statement so a large file cannot exceed the request size limit). Customers and Products already used a `bulkCreate`, so the finding was stale on those two — checked before changing them.
* **Partial imports are now reported.** A failing chunk carries `insertedBefore`, so the screen can say how many leads actually landed instead of showing a bare failure after writing several hundred rows.
* **Full schema parity was deliberately NOT applied, and this is the part worth a decision.** Running `customerSchema` per row would change which rows are *accepted*, not merely validate them: the schema requires both a contact person and a mobile, while the importer permits a B2B row with neither. Silently rejecting rows that import successfully today would be a worse failure than the one being fixed, so validation was scoped to the fields where a bad value actually corrupts data. Aligning the importer with the form's rules is an owner decision about import policy.
* Also unchanged: the three hand-rolled `parseCSVLine` implementations, and duplicate detection still comparing against the ≤5,000 rows the page has loaded.
* Tests: `src/test/importValidation.test.js`, 10 cases — the finding's exact value, other malformed addresses, blank treated as allowed because the column is optional, over-length addresses and phone numbers, and clean rows reporting nothing.

#### [MEDIUM] Announcements ignore their target roles and expiry is evaluated client-side only

* ID: BUG-046
* Category: Logic
* Location: `src/App.jsx` `AnnouncementBanner` (`db.announcements.listActive()` then renders all; `target_roles` never read); `system.ts` `listActive` (filters `is_active`/`starts_at`/`ends_at` in JS after fetching every row)
* Description: An announcement targeted at `technician` is shown to everyone; the banner also overlaps the permission-preview banner (both `fixed top-0 z-50`).
* How to reproduce: create an announcement with target role `admin` → sign in as viewer → visible.
* Expected: filter by `target_roles` ∋ current role (or empty = all).
* Actual: shown to all.
* Impact: wrong audience for internal notices.
* Suggested fix: filter in `AnnouncementBanner` by `effectiveUserRole`; stack the banners.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-06** (ships with the next front-end deploy) — but the finding was wrong about the cause, and the real defect was worse.
* **There is no `target_roles` column on `announcements` at all.** The table is `id, title, message, type, is_active, start_date, end_date, created_by, created_date, updated_date`, and the admin screen offers no targeting field. So “an announcement targeted at technician is shown to everyone” cannot happen as described — nothing can be targeted. Role targeting would be a new feature, not a fix, and is not built here.
* **What was actually broken: the whole feature had never worked.** `listActive()` filtered on `a.starts_at` / `a.ends_at` and the admin screen wrote the same names — columns that do not exist. Proved directly: `INSERT … (starts_at, ends_at)` fails with *column “starts_at” of relation “announcements” does not exist*, while the same insert with `start_date`/`end_date` succeeds. So **every attempt to create or edit an announcement failed outright**, which is why the table holds zero rows and nobody had reported it. On the read side both values were always `undefined`, so the scheduling window was never enforced either.
* Fixed by using the real column names in `src/api/db/system.ts` and `src/pages/cp/Announcements.jsx` (18 occurrences). `src/test/announcementsWindow.test.js`, 8 cases: shows inside the window, hides after `end_date`, hides before `start_date`, treats missing dates as always-on, respects `is_active`, ignores the old names, tolerates an unparseable date, and returns empty on a query error.
* Not addressed: the banner still overlaps the permission-preview banner (both `fixed top-0 z-50`). Cosmetic, and untestable until an announcement can exist — which, until today, one could not.

#### [MEDIUM] Login/logout activity entries are wrong or lost

* ID: BUG-047
* Category: Logic
* Location: `src/App.jsx` `handleLogin` (`\`Signed in as ${currentUserRole || 'user'}\`` — `currentUserRole` is the *previous* render's state, so it is always `'user'`), `handleLogout` (activity written after `signOut()`, see BUG-019), `handleMfaVerify` (same pattern)
* Description: The user activity log, surfaced in Account Settings and User Management, never records the role at login and rarely records logouts.
* How to reproduce: log in; open Account → Activity → "Signed in as user".
* Expected: role from `roleData`, logout logged before the session ends.
* Actual: as described.
* Impact: misleading audit data.
* Suggested fix: return the role from `finishLogin`; log logout first.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-06** (ships with the next front-end deploy). `finishLogin` now returns the role it resolved, and `handleLogin` logs that instead of `currentUserRole` — which is the *previous* render's state and on a fresh sign-in is always null, so every entry read “Signed in as user” whoever signed in. `handleMfaVerify` records the role too.
* A sign-in is now only recorded when access was actually granted: `finishLogin`'s denial paths return undefined, and “signed in” is not what happened there.
* The logout half of this finding was already fixed with BUG-019 — `handleLogout` logs before `auth.signOut()` rather than after, so the insert still has a session to be authorised by.

#### [MEDIUM] Credit-note-from-ticket flow closes the ticket in a second, unguarded write

* ID: BUG-048
* Category: Data Integrity
* Location: `src/pages/RMATickets/TicketDrawer.jsx:95-113`, `src/pages/SalesDocuments/SalesDocumentDetail.jsx:376-384` (`issue_credit_note` RPC, then `rmaTickets.update({ticket_status: CLOSED})`, then activity logs)
* Description: If the ticket update fails (RLS 0-row no-op for a technician — BUG-008 — or network), the credit note is issued and applied but the ticket stays open with a "credit_note_created" activity; retrying re-issues nothing (the RPC refuses a non-draft CN) so the UI cannot recover without manual edits.
* How to reproduce: as a technician who is not the assignee, issue a CN from the ticket drawer.
* Expected: one RPC that issues the CN, closes the ticket and writes the activity rows.
* Actual: three independent writes.
* Impact: inconsistent ticket/CN state.
* Suggested fix: extend `issue_credit_note` with an optional `p_close_ticket` step.
* Confidence: Confirmed by code reading
* **Status: FIXED — applied and verified in production 2026-09-06** (`20260833_issue_credit_note_closes_ticket.sql` + `20260834_drop_old_issue_credit_note_overload.sql`; client changes ship with the next front-end deploy). `issue_credit_note` gained an optional `p_close_ticket`, so the note is issued, applied to the invoice and the ticket closed in **one transaction**. Both call sites — `TicketDrawer.jsx` and `SalesDocumentDetail.jsx` — now make a single call.
* **The ticket id is taken from the credit note server-side, never from a caller parameter**, so the flag cannot be used to close an unrelated ticket — the same lesson as BUG-031.
* **This got sharper after BUG-008.** Now that `rmaTickets.update` throws on a zero-row result instead of returning `undefined`, the old two-write sequence would show the user “issue credit note failed” for an operation whose credit note *had* been issued and applied. Visible, but still unrecoverable — retrying could not help, because the RPC refuses a non-draft note.
* **A second migration was needed, and the probe is the only reason it was caught before users were.** Adding the 3-argument form left the original 2-argument function in place, so `issue_credit_note(uuid, text)` matched both and Postgres refused every call with 42725 “function is not unique”. The client invokes it with exactly two named arguments, so **credit-note issuing would have been broken outright**. `20260834` drops the old overload; the surviving function defaults `p_close_ticket` to false, so a two-argument call behaves exactly as before. Its guard asserts there is exactly one function of that name.
* Verified by rolled-back probe (**3 passed, 0 failed**): the 2-argument call resolves and leaves the ticket open; the 3-argument call issues and closes in one transaction; re-issuing a non-draft note is still refused.

#### [MEDIUM] Session management screen lists only the current session and cannot revoke

* ID: BUG-049
* Category: UX / Security
* Location: `supabase/functions/manage-sessions/index.ts` (header comment documents `{action:'revoke', sessionId}`; only `list` is implemented; `list` returns `[currentSession]` decoded from the caller's own JWT); `src/pages/AccountSettings.jsx:374-398` (renders that list as "Active sessions" and offers "Sign out all")
* Description: Users are led to believe they can see and manage every device; they see one entry. Suspending a user in User Management does not end their existing sessions either (nothing calls `auth.admin.signOut(userId)`), so a suspended user keeps API access until token expiry for anything not guarded by `rma_user_role()` (edge functions — BUG-021).
* How to reproduce: sign in on two browsers; Account → Security shows one session.
* Expected: real session list via `auth.admin.listUserSessions` / revoke; admin suspension revokes refresh tokens.
* Actual: cosmetic.
* Impact: false sense of control; lingering access after suspension.
* Suggested fix: implement `revoke`; call `auth.admin.signOut(user.id, 'global')` from an admin function when status changes.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-07** - applied and verified in production (`20260837_real_session_management.sql`, `20260838_revoke_sessions_by_email.sql`); the Edge Function is deployed; the UI ships with the next front-end deploy.
* **Confirmed the screen was structurally incapable of the truth:** the live database held **7 sessions across 2 users** while Account Settings -> Security showed exactly one, always, because it decoded the caller's own JWT and returned it as an array of one. `revoke`, documented in the function's own header comment since it was written, answered "Unknown action", 400.
* Sessions live in `auth.sessions`, which PostgREST does not expose - that is why the original settled for the JWT. Three SECURITY DEFINER functions now cross that boundary: `rma_list_my_sessions()`, `rma_revoke_my_session(uuid)` and `rma_revoke_user_sessions(uuid)` / `_by_email(text)`. Ownership is `user_id = auth.uid()` inside the DELETE itself, not a check before it, so there is no window between them.
* **The Edge Function uses the ANON key with the caller's own Authorization header, not the service-role key.** With service-role, `auth.uid()` would be null and every session in the installation would be reachable, leaving this file's request parsing as the only thing between a user and someone else's devices.
* **Suspension now actually ends access.** `updateUserStatus` calls `rma_revoke_user_sessions_by_email` when a user is suspended or locked; previously nothing signed them out, so every device kept a valid refresh token and a suspended account went on working anywhere not guarded by `rma_user_role()`, Edge Functions included (BUG-021). Best-effort by design: the status change has already committed and must not be rolled back, so a failed revoke is reported to Sentry rather than surfaced as a failed suspension, which would invite an admin to retry an action that already worked.
* **The UI no longer overstates what revocation does.** Each session renders its own row with a device name derived from the User-Agent (`describeUserAgent`), last-active time and IP; only the row matching the caller's `session_id` carries the "this device" badge; every other row gets a Sign out button. The panel states that a signed-out device keeps its current access token until it expires: deleting the session cascades to `refresh_tokens` and `mfa_amr_claims` (both FKs verified ON DELETE CASCADE) and stops renewal, but an already-issued JWT is valid to its `exp` regardless of server state. That is a property of JWT auth, not something the fix can change, and the screen should not imply otherwise.
* No Sign-out button on the current device: signing yourself out from a row you are reading is a surprise, and "Sign Out All Devices" and normal sign-out already cover it.
* Verified by rolled-back probes (**10 passed, 0 failed** across two runs): the list returns all 6 of a user's sessions rather than 1; another user's session never appears in it; revoking an id you do not own returns false and deletes nothing; revoking your own works and the cascade removes its refresh tokens; `anon` has no EXECUTE grant. The first run's non-admin case was **mis-designed** - it impersonated the super_admin, so the refusal it expected correctly did not happen; re-run as the manager, a non-admin is refused and the admin path revokes as intended.
* Tests: `src/test/userAgent.test.js`, 7 cases - Edge is not reported as Chrome and Chrome is not reported as Safari despite carrying each other's tokens, Android is not reported as Linux, and an unrecognisable agent returns null so the caller shows its own wording instead of "Unknown on Unknown".

#### [MEDIUM] Multiple-permissive-policy overlap and legacy duplicates on `notification_preferences`, `user_preferences`, `customers`

* ID: BUG-050
* Category: Permissions / Performance
* Location: live policies — `notification_preferences` has `user_own` (ALL) **plus** three older `Users can … their own preferences` policies using bare `auth.email()` (flagged `auth_rls_initplan`); `user_preferences` has `users_own_prefs` (ALL, no `WITH CHECK`) plus four per-command policies; `customers` has both `manager_insert` and `sales_insert_customers`; 116 advisor warnings in total across 26 tables
* Description: Overlapping permissive policies are OR-ed, so the widest one wins and each extra policy is evaluated per row. `users_own_prefs` (ALL with only `USING`) allows an UPDATE that changes `user_email` to another user (no `WITH CHECK`), then the row is no longer visible to its owner.
* How to reproduce: `UPDATE user_preferences SET user_email='victim@…' WHERE user_email='me@…'` as `me`.
* Expected: one policy per command with `WITH CHECK`.
* Actual: overlaps.
* Impact: hard-to-reason authorisation; per-row function calls (performance); preference row hijack.
* Suggested fix: drop the legacy policies; add `WITH CHECK (user_email = rma_current_user_email())`.
* Confidence: Confirmed by code reading (live catalog)
* **Status: FIXED — applied and verified in production 2026-09-06** (`20260836_consolidate_preference_policies.sql`). Nine overlapping permissive policies reduced to two, one per table, each with an **explicit** `WITH CHECK`. Verified by rolled-back probe (**6 passed, 0 failed**): own row readable and updatable, only own row visible, another user's row untouchable, row reassignment still refused, and an admin retains the wider access `user_own` granted.
* **The headline claim in this finding was wrong, and I checked before acting.** It said `users_own_prefs` (ALL, `USING` only) allowed an UPDATE reassigning `user_email` to another user, hijacking their preference row. It does not: Postgres reuses a policy's `USING` expression as its implicit `WITH CHECK`, so the NEW row is tested too. Probed live as a technician against an admin's address — `UPDATE user_preferences SET user_email='<admin>'` → **42501, new row violates row-level security policy**, while an ordinary self-update succeeded. **No hole was closed here.** This is the same misreading the report already corrected once for BUG-002, repeated.
* **What was real is the overlap.** `user_preferences` carried five permissive policies saying the same thing and `notification_preferences` four, all OR-ed and all evaluated per row — three of them calling bare `auth.email()`, which is what the `auth_rls_initplan` advisor flags (re-evaluated per row rather than once per query). Redundant permissive policies cannot tighten anything, only widen it, so the cost bought nothing: more work per row, and an authorisation model needing four policies to reason about instead of one. `WITH CHECK` is now written out rather than left implicit, so the intent no longer depends on knowing that rule.

### 4.4 Low

#### [LOW] `appearanceScope.test.jsx` fails intermittently under the full parallel suite

* ID: BUG-081
* Category: Testing
* Location: `src/test/appearanceScope.test.jsx:187-188` (`await waitFor(() => expect(api.fontFamily).toBe('poppins'))` then `expect(api.darkMode).toBe(false)`)
* Description: One assertion failed during a full `vitest run` and could not be reproduced afterwards. The `waitFor` covers `fontFamily` only; `darkMode` is asserted immediately after it on the same settled state, so if the two updates land in separate ticks under load the second assertion can read the earlier value.
* How to reproduce: intermittent. Observed once in a full 54-file run; the immediately following full run passed, and the file passed **5 of 5** times in isolation.
* Expected: deterministic.
* Actual: one failure in roughly a dozen full runs.
* Impact: low in itself, but corrosive — a suite that fails occasionally for no reason trains people to re-run rather than read, which is the same habit BUG-016 was about.
* Suggested fix: bring `darkMode` inside the `waitFor` so both values are asserted against the same settled state.
* Confidence: Confirmed by execution (observed once; not reproduced in 5 isolated runs plus 1 further full run)
* **Found 2026-09-06** while verifying the BUG-024/025/046 batch. **Not caused by that work** — none of those changes touch appearance, and the same suite passed immediately before and after. Not fixed: I did not want to edit an assertion I could not first make fail on demand.
* **Status: FIXED 2026-09-10.** **The same race was at five sites, not one.** Each test waited for `fontFamily` to settle and then asserted a second value — `darkMode` in four tests, `dateFormat` in one — outside that wait, so under a loaded parallel run the second read could see the earlier state. All five now assert both values inside a single `waitFor`.
* **A limit on the evidence:** an intermittent failure cannot be proven gone by runs that pass, and this one never reproduced in isolation. What can be shown is that no assertion in the file now reads state outside the wait that settles it.
#### [LOW] TypeScript is not type-checked anywhere; `tsc` reports 83 errors

* ID: BUG-051
* Category: Configuration
* Location: `tsconfig.json` (`strict: true`, no `allowJs`), `package.json` (no `typecheck` script, no `typescript` devDependency), `src/lib/messaging/providers/WhatsAppProvider.ts:39` (imports `../../api/client.js`, a path that does not exist), `src/api/db/inventory.ts:696-920` (18 `TS2339` from untyped Supabase results), `src/lib/stableEmpty.ts:40`, `src/lib/rmaStageMoves.ts:72`
* Description: The `.ts` modules are only transpiled by esbuild; the types they export are never checked, so the "Row types" contract in `src/api/db` can drift silently. The root-level `CLAUDE.md` for another project claims an `npm run typecheck` script exists; this repo has none.
* How to reproduce: `npx -p typescript@5 tsc --noEmit -p tsconfig.json` → exit 2, 83 errors.
* Expected: `typecheck` script in CI with 0 errors (add `allowJs`/`checkJs:false` and generated Supabase types).
* Actual: unchecked.
* Impact: latent type bugs; a dead module with a broken import ships in the bundle.
* Suggested fix: add `typescript` + `supabase gen types`, fix the 83 errors, gate in CI.
* Confidence: Confirmed by execution
* **Not attempted 2026-09-13, and the reason is a blocker rather than a choice.** Closing this means adding `typescript`, fixing the 83 errors and gating CI on it — and the errors cannot be fixed without running `tsc`, which means installing the dependency first. This machine currently has about half a gigabyte of memory free; `npm install` and the production build both fail on it today. Adding the dependency and the CI gate *without* fixing the errors would turn CI red on HEAD, which is the state BUG-016 was raised to get out of. It needs a machine that can run the compiler.

#### [LOW] Formatting drift and CI/documentation mismatch

* ID: BUG-052
* Category: Configuration
* Location: `npx prettier --check src` → 259 files; `.github/workflows/ci.yml` runs only `test`, `lint:ci`, `build` (no `format:check`, no typecheck, no `npm audit`), while `README.md:200-203,293,407` and `CLAUDE.md:28-31` state that `format:check` runs in CI and that the lint gate is "zero warnings"
* Description: Docs describe a stricter pipeline than exists.
* How to reproduce: run the commands.
* Expected: docs match CI; formatting enforced or the check removed.
* Actual: mismatch.
* Impact: noisy diffs; false confidence.
* Suggested fix: add `format:check` and `typecheck` to CI or update the docs.
* Confidence: Confirmed by execution
* **Status: FIXED 2026-09-13** (documentation only). The mismatch was narrower than filed, and the difference matters: README documents `format:check` as a script that exists, which is accurate. What was untrue was **CLAUDE.md calling it "used in CI"**, and **README describing `db-tests` as one of two required jobs** when that job carries `if: false` — Docker was ruled out and the `integration` job replaced it. Both now describe the pipeline that runs, including that `lint:ui` reports without gating.
* **Formatting is still not enforced, and that is stated rather than papered over.** `npx prettier --check src` reports hundreds of files. Adding `format:check` to CI before a formatting sweep would turn the job red on HEAD, and the sweep is a commit of its own — mixing several hundred reformatted files into unrelated work is how a real change becomes unreviewable.
* Two stale claims fixed alongside: both files advertised "305 tests, 9 suites" (the suite is roughly four times that), and README described the service worker as caching Supabase responses `NetworkFirst` — **BUG-024 removed that caching**, precisely because it left one person's records readable on a shared machine after sign-out. The test counts are now gone rather than corrected: a number in prose goes stale again.

#### [LOW] React hook dependency warnings and unused test variables

* ID: BUG-053
* Category: Code quality
* Location: `src/lib/useUrlState.js:91` (`useCallback` missing `params` — intentional but suppressed by a disable comment elsewhere, not here), `src/pages/Customers/index.jsx:165` (missing `setCurrentPage`), `src/pages/RMATickets/index.jsx:162` (missing `filterOverdue`, `setCurrentPage`); `src/test/appearanceScope.test.jsx:18`, `src/test/useUrlState.test.jsx:85,86,130,131` (`no-unused-vars`)
* Description: The two page effects reset the page number when filters change but omit `filterOverdue`, so toggling that filter does not reset pagination (can land on an empty page).
* How to reproduce: go to page 3 of tickets, toggle "overdue only" (fewer results) → empty page.
* Expected: deps complete.
* Actual: stale closure.
* Impact: minor UX; lint noise.
* Suggested fix: include the deps or use `useResetOnFilterChange` consistently.
* Confidence: Confirmed by execution (lint) / code reading
* **Status: FIXED (before this pass) — confirmed 2026-09-10; no code change made.** Both halves were already resolved by earlier remediation. The RMA Tickets page-reset effect now lists `filterOverdue` in its dependencies, with a comment recording that the signature and the dependency list had drifted — exactly the empty-page bug this finding describes. Customers lists `setCurrentPage`. And `lint:ci` runs with `--max-warnings 0` and passes, so no `react-hooks/exhaustive-deps` or `no-unused-vars` warning remains anywhere in `src/`.
* Optional, not done: both pages still carry inline copies of the value-compared reset rather than calling `useResetOnFilterChange`. They are correct as they stand.

#### [LOW] Chunk-load failure triggers an unbounded reload loop

* ID: BUG-054
* Category: Error Handling
* Location: `src/App.jsx` `lazyWithReload` (`window.location.reload()` on `Failed to fetch dynamically imported module`, no attempt counter)
* Description: If a chunk is genuinely missing (CDN outage, bad deploy, ad-blocker), every page load reloads again forever.
* How to reproduce: block a lazy chunk URL in DevTools; navigate to that route.
* Expected: reload once (guard with `sessionStorage`), then show an error.
* Actual: loop.
* Impact: browser tab thrashes; user cannot read an error.
* Suggested fix: `sessionStorage` flag keyed by chunk URL.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-10** (ships with the next front-end deploy). `src/lib/chunkReload.js` gives each session one automatic reload. A second chunk failure in the same session is thrown to the ErrorBoundary, which offers a Reload button the user controls, instead of reloading forever. The flag clears as soon as any chunk loads, so a long-lived tab that outlives a second deploy still gets its silent recovery.
* **No storage means no automatic reload.** sessionStorage can be blocked, or — in older Safari private windows — accept a write and silently drop it. Either way nothing can remember that a reload was tried, and an unremembered reload is exactly the loop being removed. The flag is read back after writing to catch the silent-drop case.
* **A gap the finding did not mention:** only Chromium's and Safari's wording was recognised. Firefox reports `error loading dynamically imported module`, so on Firefox a chunk replaced by a deploy skipped the recovery reload entirely and went straight to the crash screen. Now recognised.
* Tests: `src/test/chunkReload.test.js`, 7 cases — one reload then refusal; re-granted after a successful load; refused with no storage, with throwing storage, and with storage that drops writes; each engine's wording recognised; a genuine module error not treated as a chunk failure.

#### [LOW] Error boundary shows raw error messages in production

* ID: BUG-055
* Category: Error Handling / Security
* Location: `src/components/ErrorBoundary.jsx` (renders `error.message` in production; "Copy error details" includes the full stack and URL)
* Description: Messages from PostgREST/Supabase (constraint names, table names) can surface verbatim; `toUserMessage` exists for toasts but is not applied here.
* How to reproduce: throw a DB error during render.
* Expected: generic message + Sentry id.
* Actual: raw.
* Impact: minor information disclosure.
* Suggested fix: route through `toUserMessage`; keep details in the copy action only.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-10** (ships with the next front-end deploy). In production the crash screen routes the message through `toUserMessage`, which turns Postgres/PostgREST errors into a sentence and drops anything carrying schema vocabulary. The raw message and full stack remain one click away in "Copy error details", which is where diagnosis happens. Development still shows the raw message.
* `toUserMessage` looks its translations up without a default, so if i18n is what broke it returns its own key. The crash screen falls back to plain English rather than printing `errors.generic`.
* **A judgment worth recording:** a JavaScript error with no database vocabulary — `Cannot read properties of undefined` — still shows as-is in production. It reveals no schema, and hiding it would make the reports users paste back less useful.
* Tests: `src/test/errorBoundary.test.jsx`, 4 cases, switching production and development with `vi.stubEnv`. One of my own assertions was initially wrong — development renders the message twice (message box and dev-only stack) — and was corrected; the code was right.

#### [LOW] CSP allows `unsafe-inline`/`unsafe-eval`; function CORS defaults to `*`

* ID: BUG-056
* Category: Security
* Location: `vercel.json` (`script-src 'self' 'unsafe-inline' 'unsafe-eval'`, `img-src https:`); `supabase/functions/_shared/cors.ts` (falls back to `Access-Control-Allow-Origin: *` when `ALLOWED_ORIGINS` is unset — the deployed functions carry no such secret according to the code comments); `kb-chat` ignores the helper and hardcodes `*`
* Description: The CSP would not stop an injected script; the CORS wildcard lets any origin call the functions with a user's token if it obtains one. Because auth uses bearer tokens rather than cookies, the practical risk is low.
* How to reproduce: inspect response headers.
* Expected: nonce-based CSP; `ALLOWED_ORIGINS` set.
* Actual: permissive.
* Impact: reduced defence in depth.
* Suggested fix: set `ALLOWED_ORIGINS`; remove `unsafe-eval` (check jsPDF/html2canvas need), move the inline dark-mode bootstrap in `index.html` to a hashed script.
* Confidence: Confirmed by code reading
* **Not attempted 2026-09-13.** Two of the three parts are not safely doable from here. Removing `unsafe-eval` needs a production build plus a runtime check of jsPDF/html2canvas to see whether anything still needs it, and the build does not run on this machine at present; replacing `unsafe-inline` with a hash needs the built output to hash. **Correction 2026-09-13: the CORS third is already done.** Measured against the live functions rather than assumed — `ALLOWED_ORIGINS` is set. A preflight carrying `Origin: https://myrma.vercel.app` gets that origin echoed back; one carrying `Origin: https://evil.example` gets **no** `Access-Control-Allow-Origin` header at all, which is the correct failure mode. The helper only falls back to `*` when the secret is empty, so this confirms it is populated. That leaves the two CSP parts, which still need a production build this machine cannot run.

#### [LOW] `anon` still holds full DML grants on ~25 tables and can execute trigger and helper functions

* ID: BUG-057
* Category: Security (defence in depth)
* Location: `information_schema.role_table_grants` (anon: DELETE/INSERT/UPDATE/SELECT/TRUNCATE on `activities`, `contacts`, `credit_notes`, `crm_invoices`, `deals`, `document_sequences`, `kb_articles`, `leads`, `notification_logs/queue/settings`, `payments`, `payment_applications`, `pipelines`, `purchase_orders`, `quotations`, `sales_orders`, `stock_moves`, `ticket_resolutions`, `user_preferences`, `vendor_*`, `warehouse_stock`, `whatsapp_templates` and all six views); advisor `anon_security_definer_function_executable` × 15 (`rma_is_admin`, `rma_user_role`, `rma_current_user_email`, trigger bodies `protect_system_warehouse`, `sync_payment_balance`, …); `pg_net` in `public`; Auth "leaked password protection" disabled
* Description: RLS currently blocks every anonymous read/write (the project's own probe confirms it), so this is not exploitable today, but a single future `TO public` policy — like the two found in the pre-launch review — becomes an anonymous write again. Trigger functions callable via `/rpc/` just error, but need not be exposed.
* How to reproduce: run the grant query in Appendix B.
* Expected: `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon` except `kb_articles` SELECT; revoke EXECUTE on helpers/triggers from `anon`.
* Actual: grants present.
* Impact: reduced margin for error.
* Suggested fix: as above; enable HIBP checks; move `pg_net` to `extensions`.
* Confidence: Confirmed by execution
* **Status: FIXED — applied and verified in production 2026-09-10** (`20260841_revoke_anon_grants.sql`). Database only; nothing waits on a deploy.
* **Measured scope was wider than written:** `anon` — anyone holding the public API key, which ships in every page load — held SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER on **26 tables and all 6 views**, and EXECUTE on **44 functions**, 22 of them SECURITY DEFINER.
* **Checked not exploitable before changing anything:** every one of those tables has RLS on with no policy admitting anon; all six views are `security_invoker`, so they run under anon's own RLS; and the four business RPCs anon could call each refuse a non-staff caller in their first lines. Three of those four — `create_manufacturer_batch`, `mark_batch_sent`, `mark_batch_resolved` — were added during this remediation on 2026-09-06, and their bodies were read to confirm that before going further.
* **Root cause, which the finding did not name:** default privileges. For objects `postgres` creates in `public`, the project granted anon full table rights and EXECUTE on every new function — which is exactly how the remediation's own RPCs came out anon-executable. Revoking the existing grants alone would have lasted until the next migration, so the defaults were changed too. **Consequence for future work:** a table or RPC meant for signed-out visitors now needs an explicit `GRANT ... TO anon` in its migration.
* **What anon keeps:** SELECT on `kb_articles`, nothing else. Traced rather than assumed — the public pages are Login and Reset Password (Auth only), the RMA tracker (the `public-track` Edge Function on the service role, plus storage policies scoped to comment attachments) and the public Knowledge Base. Every Edge Function either uses the service role or forwards the caller's own token, so the WhatsApp functions are untouched. PostgREST has no pre-request hook, pg_graphql is not installed, and anon held no sequence grants.
* **No collateral on other roles.** Removing anon's EXECUTE meant revoking PUBLIC, so before each revoke EXECUTE was granted explicitly to every other role that held it (authenticated, service_role and the Supabase service roles); a guard refused to finish unless every one kept exactly its access. EXECUTE on the 13 **trigger** functions was also removed from `authenticated`, after a probe confirmed a trigger fires without it. **That probe's first run was invalid** — the default privileges had left EXECUTE in place, so its pass proved nothing — and was redone with the privilege verified absent.
* **Verified from inside, rolled back — 11 passed, 0 failed:** the admin still gets `rma_is_admin() = true`; UPDATEs on `rma_tickets`, `deals` and `inventory_units` succeed with their triggers firing; `create_manufacturer_batch` is still callable by signed-in staff; anon reads published `kb_articles`; anon is refused at the grant for `payments` and for `rma_is_admin()`; the default ACL no longer grants anon anything.
* **Verified from outside, over the real API with the anon key:** the Knowledge Base loads (200); reading `payments`, `vendor_payments` and `v_customer_ledger`, a DELETE on payments, an INSERT into leads, `rma_is_admin` and `create_manufacturer_batch` are all refused with 42501. A ninth check — a trigger function via `/rpc` — returned 404 PGRST202 instead of the expected 42501. Since `rma_is_admin`, equally non-executable, returned 42501, the difference is the function kind: **PostgREST does not expose trigger functions as RPCs at all**, so the advisor's "callable via /rest/v1/rpc" wording overstated those. The expectation was too narrow, not the fix.
* **Security advisor, before → after:** `anon_security_definer_function_executable` 22 → **0** (the lint no longer appears); `authenticated_security_definer_function_executable` 69 → 56. The remaining 56 are the app's intended RPC surface, each doing its own role check, and are not what this finding is about.
* **Not done, each for a stated reason:** `pg_net` stays in `public` — it is not relocatable (`extrelocatable = false`), its functions live in `net` regardless, and moving it means dropping and recreating it under the cron-driven notification drain. **Leaked-password protection is still off** — it is an Auth setting reached only through the Supabase dashboard, so it is an owner action. Default privileges for objects created by `supabase_admin` cannot be altered from the `postgres` role; in `public` that role creates only extension objects.

#### [LOW] Missing foreign-key indexes and unused indexes

* ID: BUG-058
* Category: Performance
* Location: advisor `unindexed_foreign_keys` × 25 — notably `inventory_units.rma_ticket_id`, `inventory_units.warehouse_id`, `ticket_activity.ticket_id`, `customer_notes.customer_id`, `ticket_comments.parent_comment_id`, `deals.pipeline_id`, `deals.contact_id`, `purchase_orders.vendor_id`, `vendor_invoices.{vendor_id,purchase_order_id,currency}`, `leads.converted_*`, `*_applications.reverses_application_id`; `unused_index` × 19
* Description: `listUnitsByTicket`, ticket cascade deletes, `ticket_activity.list`, `customerNotes.list` and the warehouse breakdowns all filter on unindexed FKs; fine at today's row counts (≤ 900 rows per table) but they are the tables that grow.
* How to reproduce: advisor output (Appendix A).
* Expected: index each FK used in a filter or cascade.
* Actual: sequential scans.
* Impact: latency as data grows; slow cascades.
* Suggested fix: add the indexes; drop the unused ones after confirming with `pg_stat_user_indexes`.
* Confidence: Confirmed by execution
* **Status: FIXED — applied and verified in production 2026-09-10** (`20260840_index_foreign_keys_drop_redundant.sql`). Database only.
* **15 foreign keys indexed** — the relationships the code actually filters and cascades on: a ticket's units, warehouse breakdowns, ticket timelines, customer notes, reply threads, deals by pipeline and contact, vendor purchase orders and invoices, lead conversions, and `reverses_application_id` on all three application tables, which every reversal RPC looks up.
* **10 deliberately left unindexed:** the currency and country-code keys point at fixed reference lists that are never deleted from, the only case such an index serves; `rma_tickets.product_id` is never written (every row is null); `user_permissions.linked_customer_id` is on an empty legacy table; and `notification_logs`' two keys belong to the WhatsApp notification subsystem, left alone under the current instruction.
* **8 redundant indexes dropped, which the finding did not list.** Found by querying for indexes whose columns are the leading columns of a unique index: four exact duplicates (`idx_products_sku`, `idx_customers_code`, `idx_rma_tickets_number`, `idx_user_permissions_email`) and four single-column prefixes of a composite unique index (`idx_categories_brand`, `idx_subcategories_category`, `country_area_codes_country_idx`, `warehouse_stock_product_idx`). Every write to those tables was maintaining two indexes for one lookup. The migration refuses to drop any whose covering unique index is missing or no longer covers it.
* **The 17 "unused" indexes were NOT dropped, against the finding's suggestion.** Zero scans since 2026-05-07 on tables of at most 888 rows means the planner reads the table instead of any index — evidence the tables are small, not that the indexes are useless. Two are the full-text GIN indexes document search will need once there is much to search.
* **Verified:** unindexed foreign keys **25 → 10**, and the ten remaining are exactly the deliberate ones — confirmed both by a catalog query and by the performance advisor's own list. 15 new indexes present, 0 redundant indexes left. The advisor now reports the 15 new indexes as "unused", which is expected on tables this size and not a reason to remove them.
* **Honest scale:** no measurable speed-up today. This is for growth and for deletes on referenced rows, not a fix for anything currently slow.

#### [LOW] Resend API key is stored in a table readable by every admin browser

* ID: BUG-059
* Category: Security
* Location: `email_settings.api_key` (`email_settings.admin_all` policy); `src/api/email.js` `getEmailSettings` (`select('*')`), `src/pages/BrandingSettings/EmailSettingsTab.jsx:70` (rendered into an input)
* Description: The provider secret travels to the browser of every admin and can be exfiltrated by any XSS. `send-email` already runs server-side and could read it from a function secret.
* How to reproduce: Control Panel → Email Settings → inspect network.
* Expected: secret only in Edge Function environment; UI shows "configured / not configured".
* Actual: plain text to the client.
* Impact: key theft.
* Suggested fix: move to `RESEND_API_KEY` secret; drop the column (the backup allowlist already excludes it).
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-10 — migration written and verified but deliberately NOT applied yet; it ships with the next front-end deploy** (`20260842_email_api_key_server_side.sql` plus `src/api/email.js` and the Email Settings tab).
* **Confirmed live:** one `email_settings` row with a 36-character Resend key, readable by any administrator session through `admin_all`, loaded with `select('*')` and rendered into an input — beside help text saying the key is "never exposed to the frontend".
* **Design — the BUG-009 webhook-secret pattern:** a stored generated `has_api_key` column; authenticated's table-level SELECT replaced by a column list that omits `api_key` (a column-level REVOKE alone is a silent no-op against a table grant); INSERT and UPDATE left in place so an administrator can still set a new key without being able to read one back; `send-email` keeps reading it with the service role. The backup export already names safe columns and skips restoring this table, so it is unaffected.
* **Why it is not applied yet — measured, not assumed.** A rolled-back probe applied the change inside a transaction and ran both old and new client queries as the live administrator — **7 passed, 0 failed**: settings readable with `has_api_key = true`; `SELECT api_key` refused; **the production front-end's `select('*')` refused**; saving without a key succeeds and the key survives; the administrator can replace the key; `RETURNING *` refused; `service_role` can still read it. Applying now would break the live Email Settings screen until the new client ships, so the migration is applied immediately after that deploy; its header says so in capitals.
* **Client changes:** reads name their columns and return `api_key` as an empty "type a new key" field; saving writes only the fields the form edits and includes the key only when one was typed. **Two traps avoided:** spreading the loaded settings into the write would have sent `has_api_key`, a generated column, and failed every save; and it would have sent a blank `api_key`, erasing a key the form cannot see. Writes name their returned columns, because a bare `.select()` after a write is `RETURNING *` and is refused. The field shows "Saved — type a new key to replace it" and uses `autocomplete="new-password"` so a password manager does not fill it.
* Tests: `src/test/emailSettings.test.js`, 6 cases — the key is never selected and neither is `*`; no row reports no key; saving without a key leaves it out of the payload, never writes `has_api_key` or `id`, and names its returned columns; whitespace is not a key; a typed key is saved trimmed; the first save inserts without a blank key.

* **Migration 20260842 applied 2026-09-13, after the front-end deploy went live** — in that order, because the previous build loaded settings with `select('*')`, which the new grant makes Postgres refuse. Verified afterwards: `authenticated` can no longer SELECT `api_key`, can still read `has_api_key` and can still UPDATE `api_key` to set a new one; `service_role` can still read it, so `send-email` keeps working. Production's `has_api_key` is `true`, so the screen shows a key is saved without being able to read it.
#### [LOW] Search inputs leave the `_` LIKE wildcard unescaped

* ID: BUG-060
* Category: Logic
* Location: `src/components/CommandPalette.jsx:41` (`q.replace(/[%,()]/g, ' ')`), `src/api/db/catalog.ts:290` (`search()` escapes `%`,`_`,`\` but then strips `(),"`)
* Description: Typing `_` matches any single character; harmless data-wise (RLS applies) but produces surprising results; PostgREST `or()` syntax characters are stripped rather than escaped so a search containing `.` still behaves oddly.
* How to reproduce: search `RMA_` in the command palette.
* Expected: `_` escaped as `\_`.
* Actual: wildcard.
* Impact: minor.
* Suggested fix: shared `escapeLike()`.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-10** (ships with the next front-end deploy). **The finding understated it, and the evidence is measured rather than inferred.** PostgREST's `.or()` takes a text language, not parameters. Probed against the live API using the anon key on the anon-readable `kb_articles`: because `id` is a uuid, the cast error echoes back exactly what PostgREST forwarded to the database, with no rows and no session involved.
* Measured: a **bare** value containing a comma → `HTTP 400 failed to parse logic tree`; bare `(x)` → the database received `(x` (a parenthesis silently eaten); bare backslashes pass through. A **double-quoted** value keeps commas and parentheses, and inside it a backslash escapes the next character (`\\` → `\`, `\"` → `"`).
* **So real searches were broken, not just surprising:** on the notification-logs screen, which spliced the term in raw, a search containing a comma failed the page with a 400. The catalog search avoided that by deleting `( ) , "` — so "Dell, HP" silently searched for "Dell HP" — and the command palette turned `% , ( )` into spaces and left `_` as a wildcard.
* `src/lib/searchPattern.js` does both encodings in one place: `escapeLike` (the three characters ILIKE treats specially), `containsPattern` for plain `.ilike()`, and `orIlike` for `.or()`, which LIKE-escapes then quotes. Applied at all four call sites: `catalog.search`, the command palette, `productDocuments.search` (already correct, now shared) and the notification-logs search. That last screen is shared by WhatsApp, email and SMS logs; the only change there is this escape, in line with the instruction to leave WhatsApp work alone.
* **Verified end to end against production:** the real helper, run through node, produced the value for seven awkward terms (a comma, brackets, `_`, `%`, double quotes, a backslash, plain text); every one reached the database as exactly the intended literal pattern — **7 passed, 0 failed**. Postgres's own escape semantics were confirmed separately by a SQL truth table (`'a_b' ILIKE '%\_%'` true, `'ab' ILIKE '%\_%'` false, and likewise for `%` and `\`, with `standard_conforming_strings = on`).
* Tests: `src/test/searchPattern.test.js`, 15 cases, including a round-trip through PostgREST's unquoting rule as measured above.

#### [LOW] Integration test asserts on a table that does not exist

* ID: BUG-061
* Category: Test coverage
* Location: `tests/integration/_client.ts` `PROTECTED_TABLES` includes `'purchase_documents'` (the view is `v_purchase_documents`; there is no such table); `rls.test.ts` treats *any* error as "correctly denied", so a 404/42P01 passes; `rpc-auth.test.ts` only checks anonymous callers
* Description: The tier gives a green result for a relation it never touched, and no test covers the authenticated-role bypasses in BUG-001/002/010/011.
* How to reproduce: read the file.
* Expected: assert the specific error code (`42501`) and add per-role probes.
* Actual: false positive.
* Impact: misleading coverage.
* Suggested fix: fix the name; assert `error.code === '42501'`; add signed-in role fixtures against a staging project.
* Confidence: Confirmed by code reading
* **Status: PARTLY FIXED 2026-09-13.** The broken assertion is fixed; the coverage gap it sat next to is a provisioning decision, not a code change.
* `PROTECTED_TABLES` listed `purchase_documents`, which has never existed — the relation is the view `v_purchase_documents`. Corrected.
* **The reason nobody noticed is the more important half.** The test counted *any* error as "correctly denied", so PostgREST's 404 for an unknown relation passed exactly like a real refusal: a green assertion pinning a name. It now fails when the relation is missing (PGRST205 from PostgREST, 42P01 from Postgres) and names it, so a typo can never read as protection again.
* The finding's second claim was already addressed: `rpc-auth.test.ts` explicitly rejects PGRST202 as proof, with a comment saying why.
* **Still open, deliberately:** nothing covers the authenticated-role bypasses behind BUG-001/002/010/011. Those need signed-in fixtures writing to a database, and doing that against the live project would create real records — the suite already gates its writing tier behind `SUPABASE_TEST_ALLOW_WRITES` for that reason. Closing it needs a second hosted project to point at, which is an owner decision about provisioning.

#### [LOW] Dead, deprecated or unsafe exports remain in the data layer

* ID: BUG-062
* Category: Code quality
* Location: `src/api/db/crmInvoices.ts` `recordPayment` (client read-modify-write of `amount_paid`, no role check, unused), `src/App.jsx` `handleSignup` (never called — `Login` has no sign-up UI — yet still wires `auth.signUp`), `src/api/db/inventory.ts` `invoices` (legacy module with client-side `generateNumber` max+1), `quotations.getByDeal` (`@deprecated`), `src/lib/messaging/providers/WhatsAppProvider.ts` (unused, broken import), internal `_reverse_*` RPC wrappers
* Description: Unsafe paths that a future caller could reach; bundle weight.
* How to reproduce: grep for callers.
* Expected: removed.
* Actual: present.
* Impact: maintenance hazard.
* Suggested fix: delete.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-13** (ships with the next front-end deploy). Every removal was checked for callers across `src/` including the tests; all four had none.
* `crmInvoices.recordPayment` removed — a client-side read-modify-write of `amount_paid` with no role check. A four-line note stands where it was, naming `payments.record()` and the application RPCs as the only paths, so it is not reintroduced by someone who finds the gap. Two comments still claimed it was in use: `customerLedger.agingReport`'s said payments and credit notes "both write through crmInvoices.recordPayment()", which was simply untrue; both now describe the RPCs.
* `quotations.getByDeal` removed (its own JSDoc deprecated it for hiding all but the most recent quotation).
* The sign-up path removed — `auth.signUp`, `App.handleSignup` and the `onSignup` prop. The login screen never rendered a sign-up control, so the handler was unreachable from the interface.
* **A residual the finding does not mention, and removing code does not close:** whether new accounts can be created is a Supabase **Auth setting**, not client code. If it is on, anyone with the public key can call sign-up directly. The consequence is bounded — a new account has no `user_roles` row, cannot create one (`admin_write` requires `rma_is_admin()`), and is refused by RLS and by the access-denied screen — so it yields an unusable account rather than access. Worth switching off in the dashboard; an owner action.
* The legacy `invoices` module and its `InvoiceRow` type removed from `api/db/inventory.ts`, along with the import, the export and the type re-export in `api/db/index.ts`. It carried its own client-side `generateNumber` (max + 1). `Reports.jsx` already documented that it reads `crmInvoices` instead. The `invoices` **table** is untouched — that is a data decision, not a dead export.
* Two items in the finding needed no work: the internal `_reverse_*` RPC wrappers were already gone, and `src/lib/messaging/providers/WhatsAppProvider.ts` (unused, with a broken import) is **left in place** under the standing instruction to skip WhatsApp work. It is imported by nothing, so it costs only its own bytes.
* Verified: ESLint clean on every touched file, and the backup, backup-resilience, backup-coverage and margin suites pass (86 tests) — they reference the `invoices` **table name**, which the removal does not touch.

#### [LOW] Data-quality issues visible in production

* ID: BUG-063
* Category: Data Integrity
* Location: live data — 14 customers share a mobile number with another customer (the bulk-import dedupe only compares against loaded rows and the single-create form does not check); 8 live (`status <> 'closed'`) `inventory_units` have an empty `serial_number` (the partial unique index excludes them, so duplicates are possible); 3 posted invoices have no `due_date` (aging treats them as "current" forever); 10 `user_roles` rows have no `auth.users` account and 1 auth user has no role
* Description: Each is a small inconsistency the code tolerates but that skews reports and dropdowns.
* How to reproduce: Appendix B queries.
* Expected: unique mobile (or explicit duplicate flag), required due date on post, cleanup of ghost users.
* Actual: as counted.
* Impact: minor reporting errors; confusing user list.
* Suggested fix: constraints + one-off cleanup after the fixture purge.
* Confidence: Confirmed by execution
* **Status: FIXED 2026-09-13 — closed.** The guards are shipped (duplicate-mobile check at both entry points, due dates filled at posting, integrity checks). What remained was cleaning existing records, which the owner has ruled out: the current dataset is test data and will be erased.
* **Status: PARTLY FIXED 2026-09-13.** Every count re-measured against production today and every one reproduces exactly: 14 customers sharing a mobile, 8 live units with a blank serial, 3 posted invoices with no due date, 10 `user_roles` rows with no account, 1 account with no role.
* **What was added — 20260843.** `rma_data_integrity_issues()` covered two of the four; it now covers all of them plus the mirror case, so the whole finding is one query an administrator can run. New checks: `duplicate_customer_mobile`, `role_without_account`, `account_without_role`.
* **The duplicate-mobile guard was worse than filed, in a way worth stating.** The importer built a Set of known mobiles and skipped matches — but it never added the file's own rows to that Set, so a spreadsheet carrying the same number twice imported it twice; nothing in the file was compared against the rest of the file. It also compared `trim().toLowerCase()` strings, so `+20 100 123 4567` and `0100 123 4567` read as two different people. Both fixed: `src/lib/customerDuplicates.js` compares the last nine digits (identical in every spelling of an Egyptian mobile), `db.customers.findByMobileKeys()` asks the database instead of the page's capped in-memory list, and the single-record form — which never checked at all — now names the existing customer and asks before saving. It asks rather than refuses: a household shares a landline and a switchboard is on every contact.
* **Posted invoices can no longer be created without a due date.** Every invoice carrying payment terms has one and every invoice missing one has no terms, so the gap is a blank field rather than a decision. A trigger now fills it at post time from the terms, or the posting date when there are none — an invoice with no stated terms is due on receipt. Probe-verified 6/6 and rolled back: terms parsed, explicit dates never overwritten, drafts left alone, and a draft posted later gets one on the way through.
* **Blank serials are reported, not prevented, deliberately.** All 8 are `active_rma` units — a customer handed over an item whose serial was never recorded, which is an ordinary thing at a service counter. A NOT NULL constraint there would refuse real intake.
* **Not repaired, and not mine to repair:** the 14 duplicate customers, the 3 existing invoices and the 8 serials are live business records. Backfilling three due dates moves those invoices into overdue buckets on the AR aging report, and changing what a financial report says is the owner's call. The check now names every row so the repair can be made deliberately.
* **One part of this finding is not a small inconsistency — see BUG-084.**

#### [LOW] `kb-chat` and `ai-assist` pass provider detail and user text through without limits

* ID: BUG-064
* Category: Error Handling
* Location: `supabase/functions/kb-chat/index.ts` (`fail(\`Provider returned ${status}: ${detail.slice(0,400)}\`)`, `history` up to 6 × 4,000 chars), `ai-assist/index.ts` (`NVIDIA error ${resp.status}: ${errText}` to the client with HTTP 200)
* Description: Upstream error bodies may include request ids or quota details; the app shows them in toasts.
* How to reproduce: misconfigure `KB_LLM_API_KEY`.
* Expected: generic message client-side, detail in function logs.
* Actual: passthrough.
* Impact: minor disclosure.
* Suggested fix: log and return a code.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-13** — `kb-chat` redeployed to production; no front-end change needed.
* **Mostly stale, and checked rather than assumed.** The finding's two headline items were already fixed during the BUG-021 work and are live: both functions log the provider's response body server-side and return a generic sentence, `ai-assist` answers 502/500 instead of its old HTTP 200, chat history is bounded to the last 6 messages at 4,000 characters each, and questions are capped at 2,000. Confirmed by reading the **deployed** source of both functions, not the repository copy.
* **Two raw passthroughs did remain in `kb-chat`, and this is what mattered:** `search_failed` returned `searchError.message` — the database's own error text, which names tables and columns — and the streaming handler's `catch` sent `String(err)`. The Knowledge Center chat panel prints `message` verbatim beneath its heading, so both reached the screen. Each is now logged and replaced with a sentence a person can act on.
* Also removed a comment directly above the provider-error branch claiming "the provider's own message is passed through" — left behind by the earlier fix, and the opposite of what the code does.
* Not behaviour-tested end to end: reaching those branches needs a signed-in session and a provider or database failure. The change is a message substitution plus a `console.error`, and the function deployed cleanly.

#### [LOW] Aging buckets mislabel overdue invoices and undated invoices

* ID: BUG-065
* Category: Logic
* Location: `src/api/db/customerLedger.ts` `bucketFor` (`daysPastDue <= 30 → 'current'`), `agingReport` (`due_date` null → `daysPastDue = 0`); same in `vendorLedger.ts`
* Description: An invoice 29 days past due is reported as "current"; invoices with no due date are never aged.
* How to reproduce: Accounting → AR aging with an invoice due 20 days ago.
* Expected: "current" = not yet due; 1–30 past due as its own bucket; undated flagged.
* Actual: as coded.
* Impact: understated overdue receivables.
* Suggested fix: add a `not_due` bucket and flag `due_date IS NULL`.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-10** (ships with the next front-end deploy). Buckets are now **Not yet due**, **1–30**, 31–60, 61–90, 90+, and **No due date**, defined once in `src/lib/aging.js` and used by both ledgers and the Accounting page, which previously carried identical copies.
* "Current" is gone because it was the defect: it held everything up to 30 days *past* due, so the first month of lateness — the window in which a reminder is still cheap — never appeared as late. Due today counts as not yet due, matching the convention `src/lib/dates.js` already applies elsewhere.
* **Undated invoices get their own column** instead of sitting in Current forever. Production has 3 posted invoices with no due date (BUG-041), and they are now visible as such.
* **The day count was still carrying the BUG-038 mistake:** `(Date.now() - new Date(due_date)) / 86_400_000`, where `new Date("2026-09-10")` is UTC midnight, so the count was a day out for part of every Cairo morning. Both ledgers now use `daysPastDueLocal`.
* The page now shows seven summary tiles (total plus six buckets), and the payables table's empty-state `colSpan` is derived from the bucket list instead of a hard-coded 6, which the new columns would have broken.
* **Found while fixing this: BUG-082**, the payables reducer adding foreign-currency balances into base-currency totals. Filed separately and fixed in the same change.
* Tests: `src/test/aging.test.js`, 11 cases — the finding's 29-days-past-due case; due today; each boundary at 30/31, 60/61 and 90/91 (day counts computed independently with Python's `datetime`); missing and unparseable dates; late-evening calendar-day counting; totals keyed exactly as the report renders.
* Not checked in a running app. The page change is mechanical — its columns now come from the shared list — and it builds and lints clean; the bucketing logic is what the tests cover.

#### [LOW] Whole-table client-side lists capped at 5,000 rows

* ID: BUG-066
* Category: Performance
* Location: `rmaTickets.list()`, `customers.list()`, `products.list()` (`.limit(5000)`), plus unbounded `deals.list()`, `leads.list()`, `activities.listAllPlanned()`, `notificationLogs`, `backup` (paged) — used by Dashboard, Reports, RMATickets, Customers, Products, TechCalendar, DataCleanup
* Description: Filtering, sorting, counting and RMA-number generation are done in memory over the first 5,000 rows; beyond that the UI silently truncates (the paged helpers exist but are used only for counts).
* How to reproduce: insert 5,001 customers.
* Expected: server-side pagination for the list pages.
* Actual: cap.
* Impact: scalability ceiling; wrong totals after growth.
* Suggested fix: adopt `listPaged` + server filters (plan already noted in code comments).
* Confidence: Confirmed by code reading
* **Not attempted 2026-09-13.** This is a server-side pagination and filtering change across seven screens, not a small fix — the code comments already sketch the `listPaged` plan. It is also not yet urgent: the largest table the cap applies to holds 888 rows against a 5,000-row limit, so nothing is being truncated today. It should be done before that number grows, not after.

#### [LOW] Public tracker uses `alert()` and a client-side lockout that the caller controls

* ID: BUG-067
* Category: UX / Security
* Location: `src/pages/RMATracker.jsx:7-45,247`
* Description: Clearing `localStorage` resets the "15-minute lockout"; the only real limit is the per-instance bucket in `public-track` (BUG-023). `alert()` blocks the page and is untranslated.
* How to reproduce: trigger the lockout, clear storage.
* Expected: server-side limiting; toast instead of alert.
* Actual: cosmetic.
* Impact: minor.
* Suggested fix: as in BUG-023.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-13** (deployed). The `alert()` half was already gone: the page uses toast and state-driven UI, and there is no `alert(` left in the file.
* **The real half was that neither limit was a limit.** The browser's 15-minute lockout resets by clearing site data, as the finding says and the code's own comment admitted. But the server-side bucket behind it was a module-level `Map` in the Edge Function — edge functions are many short-lived instances, so the bucket was empty on every cold start and two concurrent instances each granted the full allowance. The only thing throttling RMA-number enumeration was how often a request happened to land on a warm instance.
* **20260844 moves the counter into the database** the function is already talking to — no Redis, no second system to operate. One fixed window per caller, incremented by a single atomic upsert so two instances racing cannot both read 14 and both write 15.
* **Addresses are not stored.** The key is a SHA-256 of the address and a secret salt (`RATE_LIMIT_SALT`, falling back to the service role key). Hashing alone would be theatre — four billion IPv4 digests is minutes of work — so the salt is what makes it non-reversible. The table can say "this same unknown caller again" and nothing else, which matters on a page whose users are customers who never agreed to anything.
* **It fails open.** If the database cannot be reached the tracker keeps working on the in-memory bucket alone, which is where it stood before. Failing closed would turn a database hiccup into a 429 for every customer checking a repair — an outage of the one page that exists to save them a phone call.
* **Verified against the live endpoint after deploying:** 18 requests → 15×200 then 3×429 with `resetIn`, and the stored row shows `request_count = 18`. That number is the proof: the code returns *before* the database call when the in-memory bucket refuses, so a count of 18 means all 18 reached the durable check and the refusals came from it. The stored key is 64 hex characters; no address appears in the table. A real lookup still returns its whitelisted columns.
* The browser lockout stays, now honestly labelled a courtesy layer rather than a defence.

#### [LOW] Sales-document form previews unrounded totals that can differ from the stored, rounded ones

* ID: BUG-068
* Category: Logic
* Location: `src/pages/SalesDocuments/SalesDocumentForm.jsx:69-76` (sums floating-point line values without rounding), `src/api/db/quotations.ts`/`salesOrders.ts`/`crmInvoices.ts` `computeTotals` (rounds each aggregate to 2 dp at the end); `purchasing.ts` line uses `qty_ordered × unit_cost` with `discount_pct`/`tax_pct` but `receive_vendor_invoice` costs stock from `rma_vi_landed_unit_costs` (server) — consistent, but the client preview of "tax in cost" depends on `purchase_tax_in_cost` config the form does not read
* Description: Preview and stored totals can differ by a cent; three copies of `computeTotals` exist (quotations, sales orders, invoices) plus a fourth in purchasing.
* How to reproduce: line 3 × 0.1 with 7% tax.
* Expected: one shared money helper used by form and API.
* Actual: duplicated logic.
* Impact: cosmetic cent differences; drift risk.
* Suggested fix: extract to `src/lib/money.js`.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-13** (ships with the next front-end deploy). The form's preview now calls `computeDocumentTotals` — the single definition introduced for BUG-013 — instead of its own copy.
* The preview was the **fifth** copy of the formula and the only one that did not round each aggregate, which is exactly the cent of drift the finding describes: every writer rounds subtotal, discount and tax to two places before storing, and the preview summed unrounded floats.
* The copies in `quotations.ts` and `salesOrders.ts` were byte-for-byte the same arithmetic and are now the shared function too, so five copies are one.
* `purchasing.ts` keeps its own: it computes from `qty_ordered × unit_cost` with different field names, and folding it in would mean pretending two different document shapes are one. The finding's related note — that the client preview of "tax in cost" ignores the `purchase_tax_in_cost` config the form never reads — is untouched and remains open.
* Verified: the existing `documentTotals` and `money` suites pass (31 tests), and ESLint is clean on the form.

#### [LOW] Vercel installs with `npm install` rather than `npm ci`

* ID: BUG-069
* Category: Configuration
* Location: `vercel.json` (`"installCommand": "npm install --legacy-peer-deps"`), `.npmrc` (`legacy-peer-deps=true`)
* Description: Production installs can drift from `package-lock.json`; peer-dependency conflicts are suppressed globally.
* How to reproduce: read the file.
* Expected: `npm ci`.
* Actual: `npm install`.
* Impact: non-reproducible builds.
* Suggested fix: `npm ci`; resolve the peer conflicts that required the flag.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-13** (takes effect on the next Vercel build). `vercel.json` now installs with `npm ci --legacy-peer-deps`, exactly what CI already ran — production was the only place that could drift from the lockfile.
* **The lockfile is in sync**, so `npm ci` will not fail on it: `lockfileVersion` 3, zero specification mismatches between `package.json` and the lock's root entry, and every declared dependency resolved.
* **`legacy-peer-deps` stays, and the reason is measured rather than assumed.** Exactly two real peer conflicts exist: `eslint-plugin-react@7.37.5` accepts eslint up to 9.x while the project is on 10.4.0, and `@apideck/better-ajv-errors` (reached through the workbox chain inside vite-plugin-pwa) wants `ajv >= 8` but resolves to 6.15.0. A third apparent conflict, `tailwindcss-animate`, is an artifact of the check — its range `>=3.0.0 || insiders` is not valid semver, and 3.4.19 satisfies it. Removing the flag means moving those dependencies, which is a different change from this finding.
* Not verified by running `npm ci` locally: it would delete and reinstall `node_modules`, and this machine is currently short of memory. The next Vercel build is the check, and a failed install fails that build without touching the running site.

#### [LOW] Repository hygiene: generated and unrelated files in the tree

* ID: BUG-070
* Category: Code quality
* Location: `eslint-report.json` (1.4 MB, committed), `MyCRM Manual Test 05-07-2026.xlsx` and `claude/` (untracked in root), `coverage/` and `dist/` present locally, root-level `C:\Users\bika_\CLAUDE.md` describing a Base44 architecture that this repo does not use (misleads any tooling reading it), `supabase/.temp/` committed
* Description: Noise and misleading documentation.
* How to reproduce: `git status`, `ls`.
* Expected: ignored/removed.
* Actual: present.
* Impact: confusion.
* Suggested fix: gitignore and delete; correct or scope the root CLAUDE.md.
* Confidence: Confirmed by execution
* **Status: FIXED 2026-09-13 — closed.** The repository changes are done. The two remaining items were never code: the owner's own files in the repo root, and a user-level instruction file outside the repository.
* **Status: PARTLY FIXED 2026-09-13.** Eleven files are no longer tracked: `eslint-report.json` (1.4 MB of generated output) and the ten files under `supabase/.temp/` (CLI cache and per-machine project metadata). `.gitignore` now covers both, with a note saying why. `dist/` and `coverage/` were already ignored.
* **Not done, and not mine to do:** the stray `MyCRM Manual Test 05-07-2026.xlsx` and the untracked `claude/` directory in the repository root are the owner's files — ignoring or deleting them is their call, so both were left exactly as they are.
* **The misleading root-level `CLAUDE.md` is outside this repository.** It lives in the user profile directory and describes a Base44 architecture this project does not use, so any tool reading it starts from a false picture. It is a user-level instruction file rather than project content; flagged here, deliberately not edited.

#### [LOW] `edit_assigned` and `change_status` permissions are not honoured consistently across the RMA screens

* ID: BUG-071
* Category: Permissions (UI)
* Location: `src/pages/RMATickets/index.jsx:411-416` (edit guard checks assignment), `:505-508` (bulk status requires `edit_all || change_status` — no assignment check), `:555-558` (bulk product status requires `edit_all || edit_assigned` — no assignment check), `TicketForm.jsx:585-592` (no assignment check), `TicketDrawer.jsx:799,834,1506` (`canDo('edit_all') || canDo('edit_assigned')`)
* Description: The client-side model lets a technician attempt bulk changes on anyone's tickets; the DB rejects silently (BUG-008), so the user gets success toasts for nothing.
* How to reproduce: as technician, bulk-select tickets of other technicians → change status.
* Expected: filter the selection to own tickets or disable the action.
* Actual: inconsistent.
* Impact: confusing UX; contributes to BUG-008.
* Suggested fix: a single `canEditTicket(ticket)` helper.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-13** (ships with the next front-end deploy). One rule now lives in `src/lib/ticketPermissions.js`, mirroring the database's `staff_update` policy: `edit_all` covers any ticket, `edit_assigned` covers your own, and `change_status` covers the status of your own.
* Brought to that rule: the bulk status change, the bulk product-status change, the row menu's Edit, the drawer's Edit button and the ticket form's save — each previously checked only that the permission existed. The row pills, the kanban board and `handleEdit` already checked assignment and now call the same helper, so there is one definition rather than four.
* **Bulk actions now partition the selection before acting.** They update only what the caller may change and report what was skipped and what failed, instead of sending everything and turning the database's refusal into a failure of the whole batch.
* **A worse habit fixed alongside it:** the old bulk handler wrote a `status_changed` activity entry for every selected ticket *before* attempting any update, so a refused update still left a false entry on that ticket's timeline. Activity is now written only for tickets that actually changed, and the stock-move dispatch likewise follows only tickets that were written.
* Tests: `src/test/ticketPermissions.test.js`, 10 cases — `edit_all` on someone else's ticket; `edit_assigned` limited to your own; `change_status` scoped the same way; a viewer refused; case-insensitive assignee matching (all 13 assigned tickets in production store lower-case); an empty assignee never matching an empty identity; and the partition keeping order while dropping missing rows.
* Left as it was: the bulk controls still appear for anyone holding the permission flags. Hiding them per selection would be a larger interface change, and the handler now explains itself.

#### [LOW] `activities` route permission differs between the route table and the inline check

* ID: BUG-072
* Category: Permissions (UI)
* Location: `src/App.jsx` `ROUTE_PERMISSIONS` (`/activities → deals.view`) vs the `<Route path="/activities">` element (`deals.view || leads.view`); `/knowledge-center` gated on `products.view` (so a viewer can reach the LLM chat and document upload UI — uploads are RLS-blocked for non-managers but the buttons show)
* Description: A custom role with `leads.view` but not `deals.view` is blocked by `RouteGuard` before the inline OR is evaluated.
* How to reproduce: create such a custom role; open `/activities`.
* Expected: one source of truth.
* Actual: two disagreeing checks.
* Impact: minor.
* Suggested fix: make `ROUTE_PERMISSIONS` accept an OR list.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-10** (ships with the next front-end deploy) — the mismatch this finding names. `src/lib/routePermissions.js` lets a route list alternatives, and Activities now admits `deals.view` **or** `leads.view`, matching its own `<Route>` element, which the guard used to overrule. Every other route keeps exactly the single permission it had, locked by a test that compares the table against its previous contents.
* The table moved out of App.jsx so it can be tested without mounting the app. A comment above it described the table as a source of truth shared with the nav items; grep shows nothing but the route guard ever read it, so that claim was dropped rather than carried over, and the new module says plainly that a route added there still needs its nav entry checked by hand.
* **Left as a decision, not a bug:** the second observation in this finding — a viewer can open the Knowledge Center and see its chat and upload buttons, because the route is gated on `products.view`. Uploads are refused by RLS for non-managers. Whether viewers should see that page at all is a product choice about the role, not two checks disagreeing.
* Tests: `src/test/routePermissions.test.js`, 8 cases — the finding's leads-only role reaching Activities; leads-only still refused at the Pipeline; admins always admitted; unguarded routes open; whole-segment prefix matching (`/products-archive` is not `/products`); every other route unchanged.

### 4.5 Informational

#### [INFORMATIONAL] Consolidate financial writes behind RPCs and lock posted documents with triggers

* ID: BUG-073
* Category: Security / Data Integrity
* Location: schema-wide (see BUG-001/002/004/010)
* Description: The codebase already moved *most* money and stock logic into SECURITY DEFINER RPCs; the remaining exposure comes from table-level policies that still allow the same writes directly. A "RPC-only" posture (`WITH CHECK (false)` on client inserts/updates for financial tables, or a GUC the RPCs set and triggers require) closes the class rather than the instances.
* How to reproduce: n/a
* Expected / Actual: n/a
* Impact: n/a
* Suggested fix: as described; add a `supabase/manual/*_probe_roles.sql` run to CI once a staging project exists.
* Confidence: Suspected (design recommendation)
* **Status: FIXED 2026-09-14 — payments, their applications and warehouse stock are procedure-only.** Migration `20260850`, on the owner's decision.
* **Why it was safe, measured first:** the app never writes these tables directly — every reference in `src/` is a read — and all 21 functions that write them, plus the `trg_sync_payment_balance` trigger, are SECURITY DEFINER, so none depends on the caller's rights. The migration refuses to apply if any writer is not.
* **Worse than filed:** besides the admin-only write policies, `authenticated` held **TRUNCATE** on all five tables — a privilege that ignores row-level security entirely. PostgREST cannot issue it, so it was not reachable through the app, but no client role had reason to hold it. Revoked along with INSERT, UPDATE, DELETE, TRIGGER and REFERENCES; SELECT and every read policy are unchanged.
* **Proven against production with a rolled-back probe as a real administrator:** direct INSERT into payments, UPDATE of warehouse_stock and DELETE from payment_applications are all refused; `record_payment` still creates a payment and `recalculate_stock` still runs; a technician still reads warehouse stock. The ledger rules in the procedures can no longer be bypassed, even by an administrator with API access.
* The document tables (invoices, credit notes, quotations, orders, purchase orders, vendor invoices) keep client writes for drafts, guarded by the transition and settled-document triggers — editing a draft is a legitimate direct write.
* **Status: PARTLY FIXED 2026-09-13** — measured, not assumed. The trigger half is in place; the RPC-only half is an architecture decision that has not been made.
* **Locked by trigger:** every document table carries a status-transition guard, and the money documents a settled-document lock — `crm_invoices` and `credit_notes` (`*_assert_transition`, `*_lock_settled`), `quotations`, `sales_orders`, `purchase_orders` and `vendor_invoices` (transition plus FX-rate guards). `stock_moves` accepts no client writes at all (BUG-010).
* **Still client-writable with no guard trigger:** `payments`, `payment_applications`, `credit_note_applications`, `vendor_payment_applications` and `warehouse_stock`. Since BUG-001 those policies admit administrators only, so this is a narrower exposure than when filed — but it is the class the finding describes, and BUG-086 below is a live example of how a client-writable policy drifts away from its siblings unnoticed.
* Closing it means making the RPCs the only writers of those tables, which changes how drafts and corrections are made. Recorded as a decision to take, not a fix to slip in.

#### [INFORMATIONAL] Add a row-count guard to every update/delete helper

* ID: BUG-074
* Category: Error Handling
* Location: `src/api/db/*.ts`
* Description: A tiny `expectOne(data)` helper would turn the silent 0-row class (BUG-008) into a thrown error everywhere at once.
* Suggested fix: as described.
* Confidence: Suspected (design recommendation)
* **Status: FIXED 2026-09-14.** Every user-initiated write in the data layer now fails loudly when the database quietly changes nothing, bulk actions included. The only writes left without a guard are ones where affecting zero rows is correct — `contacts.clearExistingPrimary` (usually no previous primary) and `activities.deleteForRelated` (a record with no history) — and the WhatsApp helpers, which stay out of scope for now.
* **Bulk actions (the second half).** `assertAllAffected` checks that every selected id came back from the write, and `NotAllUpdatedError` says how many did not — "2 of the 3 selected deal records were not changed … the other 1 were." Applied to product delete and status change, customer status change, deal delete and stage move (including the reopen of won/lost deals), lead delete and bulk edit, ticket bulk delete, and inventory transfer and resolve. Every table involved was already verified safe for a read-back guard.
* **The screens now tell the truth after a partial failure.** Before, a bulk action that RLS partly refused reported "10 updated" when 3 were not. Now the nine screens that run them show the partial message and refresh on error as well as success, so the rows that did change are not left looking untouched.
* **The two archive helpers** (sales and purchasing documents) are guarded too — possible once BUG-086 aligned the invoice policy.
* **Automation rules had two silent failures, both fixed.** The ticket updates ignored their results, so a rule the current user's role could not apply "ran" and changed nothing; they now report to error tracking without interrupting the user's save. And the **"create notification" action had never created a notification**: it ended in `.catch(() => {})` on a Supabase query builder, which has `then` but no `catch` (confirmed against the installed client), so the call threw a TypeError before sending anything and the surrounding `catch {}` swallowed it. A scan of the codebase found no other instance.
* **Verified:** new tests for the bulk guard, and for the automation fix with a test double that behaves like the real builder — those two tests fail against the previous code and pass against the new, which is what shows they test the fix. Lint clean; unit suite 70 files, 1,443 tests; integration tier against production 25/25.
* **Status: PARTLY FIXED 2026-09-13.** The helper the finding asks for already existed — `assertUpdated` / `assertAffected`, added for BUG-008 — but only 25 of 107 write sites used it. **56 more are guarded now.**
* **Why not all of them, and why not blindly.** The guard reads the row back through `RETURNING`, which PostgreSQL evaluates against the SELECT policy. On a table where someone may write a row they may not read, it would throw on a successful save. So every table was checked against production first: for 32 tables the read policy covers the write policy (admin ⊆ manager ⊆ staff, confirmed from the function definitions) and `id` is readable. Only those were touched, by a script that refused any site whose table was not on that list or whose shape it did not recognise.
* **Two tables failed that check, which led to BUG-086:** `crm_invoices` and `credit_notes` let a role pass the update policy for a document it cannot read. Once that policy was aligned the same day, both were guarded too — 60 sites in total now, plus the `restoreUnits` fix.
* **Left unguarded on purpose:** 12 bulk writes (`.in(...)`), where zero-of-N and part-of-N need a different contract; the automation-rule ticket updates, which run in the background and do not check errors at all; `contacts.clearExistingPrimary`, where affecting zero rows is the normal case; the two dynamic `setArchived` helpers, one of which can target `crm_invoices`; and the WhatsApp helpers, out of scope.
* Verified: lint clean and the full suite green (69 files, 1,435 tests). Every changed diff was the intended shape; `updateUserStatus` still revokes sessions only after the status write is confirmed.

#### [INFORMATIONAL] Supabase Auth settings could not be verified from the audit tooling

* ID: BUG-075
* Category: Configuration
* Location: Supabase dashboard → Authentication
* Description: Whether public sign-ups are disabled (the app has no sign-up UI, but `auth.signUp` is wired and 1 auth user has no role), password policy, OTP/recovery-link expiry, refresh-token rotation, "require current password", and MFA enforcement are dashboard settings not exposed to SQL. `auth_leaked_password_protection` is reported disabled by the advisor.
* Suggested fix: confirm sign-ups are off (or that new sign-ups cannot obtain a session), enable HIBP, set session lifetimes, and document them in the repo.
* Confidence: Suspected (unverified)
* **Status: PARTLY FIXED 2026-09-13** — everything readable from outside the dashboard has been read and is recorded here; the remaining changes are owner actions.
* **Read from production:** `disable_signup = false` (public sign-up is **on**), `mailer_autoconfirm = false` (sign-up requires confirming the email), email provider enabled — all from `/auth/v1/settings`. Leaked-password protection is **disabled**, per the security advisor. `ALLOWED_ORIGINS` is set (see BUG-056).
* **Not readable without the dashboard:** session lifetimes, refresh-token rotation, OTP and recovery-link expiry, MFA enforcement.
* **Why sign-up matters more than it looks:** BUG-084 showed a `user_roles` row is a standing grant to whoever registers that address. The ten waiting rows are suspended, but while sign-up is on, the mechanism is intact. The dashboard toggle is the fix.

#### [INFORMATIONAL] `ownershipScope` is documented as "not a security boundary" — and is currently the only boundary for several screens

* ID: BUG-076
* Category: Permissions
* Location: `src/lib/permissions.ts` `ownershipScope`; Sales Documents / Pipeline / Leads pages
* Description: The comment is accurate: RLS is meant to be the boundary. This audit found RLS *reads* for `sales_rep` are correctly scoped (own rows), so the UI filter is cosmetic as intended. Listed so the assumption is on record.
* Confidence: Confirmed by code reading
* **Status: FIXED 2026-09-13 — closed as confirmed; nothing needed changing.** Re-checked against the live policies rather than the earlier audit: for `sales_rep`, reads on `deals`, `leads`, `activities`, `quotations` and `sales_orders` are scoped to rows the rep is assigned to or created. The UI's `ownershipScope` filter is cosmetic, exactly as its comment says, and the database is the boundary.

#### [INFORMATIONAL] Deno `serve` import from `std@0.168.0` in four functions

* ID: BUG-077
* Category: Configuration
* Location: `notification-worker`, `send-whatsapp`, `whatsapp-webhook`, `manage-sessions` (`https://deno.land/std@0.168.0/http/server.ts`), others use `Deno.serve`; supabase-js pulled as `@2` (floating major) in most functions vs pinned `2.45.0` in `kb-chat`
* Description: Floating versions make deploys non-reproducible; `std/http/server.ts` is deprecated.
* Suggested fix: `Deno.serve` everywhere; pin `@supabase/supabase-js@2.x.y`.
* Confidence: Confirmed by code reading
* **Status: PARTLY FIXED 2026-09-13** — every function except the two WhatsApp ones, which stay untouched under the standing instruction to leave WhatsApp work for later.
* `std@0.168.0` replaced with `Deno.serve` in `manage-sessions` and `notification-worker` as filed — and in **`ai-assist`**, a third copy the original finding missed because it uses double quotes. All three redeployed with JWT verification unchanged (read back from the platform before and after).
* **Proven to boot, not just to deploy:** without a token the gateway refuses with its own body (`UNAUTHORIZED_NO_AUTH_HEADER`); with the anon key each function answers from its own code — `x-served-by: supabase-edge-runtime`, an execution id, and the function's own `Unauthorized` check. A function that failed to start would return a 5xx instead.
* `supabase-js` pinned to **2.116.0** in nine functions — the exact version `@2` resolves to today, so the next deploy of each gets what it would have got anyway, only reproducibly. The six that changed only their pin were not redeployed: pinning is about future deploys, and redeploying working auth functions for no behavioural change is risk without benefit. `kb-chat` keeps its existing `2.45.0` pin.

#### [INFORMATIONAL] Bundle size warning and PWA precache of 5 MB

* ID: BUG-078
* Category: Performance
* Location: `vite build` output (one chunk > 500 kB; precache 90 entries / 5.07 MB); `vite.config.js` manual chunks
* Description: First load and SW install are heavy; `xlsx`, `jspdf`, `html2canvas`, `pdfjs-dist`, `recharts` are candidates for lazy loading (pdfjs already is).
* Suggested fix: dynamic-import the export/PDF libraries; exclude large chunks from precache.
* Confidence: Confirmed by execution
* **Status: FIXED 2026-09-14 — closed as decided, precache unchanged.** The owner chose to keep pre-caching every page. It is a one-time background download per deploy, and since no data is cached offline (BUG-024), trimming it would gain little. The main-chunk half was already fixed on 2026-09-13.
* **Status: PARTLY FIXED 2026-09-13.** The main chunk is a fifth smaller; the precache is deliberately unchanged.
* **The finding's premise had gone stale.** `xlsx` (430 KB) and the charting library (385 KB) were already in their own lazy chunks, and every route was already lazy — 68 dynamic chunks. Measured from the live bundle rather than assumed.
* **The actual cause was not on the list: both translation files were imported statically** — 483 KB of JSON, every visitor downloading Arabic and English and using one. English stays bundled, because it is the fallback; Arabic is now fetched by an i18next backend the first time it is needed, so `changeLanguage` waits for the file and no call site changed. First render waits for the saved language, so an Arabic user never sees a flash of English and a layout flipping to right-to-left; an English user waits for nothing.
* **Measured on the live site, before and after the deploy:** entry chunk **1,125,641 → 886,673 bytes (−21%)**; gzipped **304 → 244 KB**. The saving equals the Arabic chunk's own size (241,608 bytes, served with HTTP 200), which is the check that the number is real. Arabic is absent from the entry chunk, English present, and the Arabic chunk is in the service-worker precache, so Arabic keeps working offline.
* **Correction to a number first reported as −33%.** That figure compared a local build against the production one. Production bundles the Sentry SDK because its environment carries the Sentry key, and a local build tree-shakes it away (128 references versus 1) — about 136 KB that has nothing to do with this change. Only live-before against live-after is like for like.
* **Verified in a browser:** English loads with only `en.json` requested; with Arabic saved, `ar.json` is fetched, the document is `dir=rtl lang=ar`, and translated text renders. Five new tests pin the behaviour the app relies on, including that a saved Arabic preference is already translated when the app first renders.
* **Not changed: the precache.** Excluding large chunks from it would break those routes offline, which is a product decision rather than a size optimisation.
* **Found alongside, filed separately:** the public tracker's heading, subtitle and Track button are hardcoded English, so they stay English for Arabic customers. Never translated — not caused by this change.

---

## 5. Permission Matrix

**Expected** = what the client-side model (`ROLE_DEFAULT_PERMISSIONS` + `canDo` + route guards + admin bypass) intends. **Actual** = what the live RLS policies / RPC guards allow through the REST API (`/rest/v1`, `/rpc`) regardless of the UI. ✔ allowed, ✖ denied, **own** = only rows where `assigned_rep`/`created_by`/`assigned_technician` = caller. Cells in **bold** differ from expected. `anon` = no session (public anon key only).

| Resource / action | anon | viewer | technician | sales_rep | accountant | manager | admin / super_admin |
|---|---|---|---|---|---|---|---|
| `customers` read | ✖ / ✖ | ✔ / ✔ | ✔ / ✔ | ✔ / ✔ | ✔ / ✔ | ✔ / ✔ | ✔ / ✔ |
| `customers` create | ✖ | ✖ / ✖ | ✖ / ✖ | ✖ / **✔** (`sales_insert_customers`) | ✖ / ✖ | ✔ / ✔ | ✔ |
| `customers` update | ✖ | ✖ / ✖ | ✖ / ✖ | own / own | ✖ / ✖ | ✔ / ✔ | ✔ |
| `customers` delete | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ / ✖ (RPC admin-only) | ✔ |
| `customers` related tickets (by name) | – | – | – | – | – | – | **leaks across same-named customers (BUG-040)** |
| `products` read / write / delete | ✖ | ✔ / ✖ / ✖ | ✔ / ✖ / ✖ | ✔ / ✖ / ✖ | ✔ / ✖ / ✖ | ✔ / ✔ / ✖ | ✔ |
| `rma_tickets` read | ✖ (tracker via function) | ✔ | ✔ | ✖ / **✔** (`staff_read`) | ✖ / **✔** | ✔ | ✔ |
| `rma_tickets` create | ✖ | ✖ / ✖ | ✖ / **✔** (`staff_insert_tickets`) | ✖ / **✔** | ✖ / **✔** | ✔ | ✔ |
| `rma_tickets` update | ✖ | ✖ / ✖ | own / own (UI lets them try any → silent no-op, BUG-008) | ✖ / ✖ | ✖ / ✖ | ✔ / ✔ | ✔ |
| `rma_tickets` delete | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ |
| `ticket_comments` insert / delete | anon via `public-track` only | ✖ / ✖ | ✔ / own-update | **✔** / – | **✔** / – | ✔ / ✔(update) | ✔ / ✔ |
| `ticket_resolutions` write | ✖ | ✖ / **✔** (BUG-011) | ✔ / ✔ | ✖ / **✔** | ✖ / **✔** | ✔ | ✔ |
| `inventory_units` read | ✖ | ✔ | ✔ | ✖ / **✔** | ✖ / **✔** | ✔ | ✔ |
| `inventory_units` update (any column) | ✖ | ✖ / ✖ | resolve only / **any column** (BUG-010) | ✖ / **any column** | ✖ / **any column** | via RPC / **any column** | ✔ |
| `warehouse_stock` direct write | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ (RPC) / **✔ ALL** | ✔ |
| `stock_moves` insert | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ (RPC only) ✔ correct |
| `receive_stock` / `transfer_stock` / `adjust_stock` RPC | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✔ |
| `move_rma_units` / `link_serial_to_rma_ticket` | ✖ | ✖ | ✔ | ✔ | ✔ (any non-viewer staff) | ✔ | ✔ |
| `promote_rma_unit` | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✔ |
| `leads` / `deals` / `activities` read | ✖ | ✖ | ✖ | own | ✖ | ✔ | ✔ |
| `leads` / `deals` / `activities` insert | ✖ | ✖ | ✖ | ✔ (any `assigned_rep` value) | ✖ | ✔ | ✔ |
| `leads` / `deals` / `activities` update | ✖ | ✖ | ✖ | own (WITH CHECK ✔) | ✖ | ✔ | ✔ |
| `leads` / `deals` delete | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ |
| `crm_convert_lead` | ✖ | ✖ | ✖ | own | ✖ | ✔ | ✔ |
| `pipelines` write | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ |
| `quotations` read | ✖ | ✖ | ✖ | own | ✔ | ✔ | ✔ |
| `quotations` create / update / **set any status** | ✖ | ✖ | ✖ | ✔ / own / **own, any status** (BUG-004) | ✖ / ✖ / ✖ | ✔ | ✔ |
| `convert_quotation_to_so` | ✖ | ✖ | ✖ | ✔ | ✖ | ✔ | ✔ |
| `sales_orders` update / **set delivered directly** | ✖ | ✖ | ✖ | own / **✔** (BUG-004) | ✖ | ✔ / ✔ | ✔ |
| `approve_sales_order` / `reject_sales_order` | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✔ |
| `crm_invoices` create | ✖ | ✖ | ✖ | ✔ | ✖ | ✔ | ✔ |
| `crm_invoices` update posted row (amount_paid, status, total…) | ✖ | ✖ | ✖ | ✖ / **✔ own** (BUG-002) | ✖ | ✖ / **✔** | ✔ |
| `post_invoice` / `void_invoice` | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✔ |
| `credit_notes` create / issue | ✖ | ✖ | ✖ | ✔ / ✖ | ✖ | ✔ / ✔ | ✔ |
| `credit_notes` update issued row | ✖ | ✖ | ✖ | ✖ / **✔ own** | ✖ | ✖ / **✔** | ✔ |
| `payments` **direct insert** | ✖ | ✖ / **✔** (BUG-001) | ✖ / **✔** | ✖ / **✔** | via RPC / **✔** | via RPC / **✔** | ✔ |
| `record_payment` / `apply_payment_to_invoice` / `void_payment` | ✖ | ✖ | ✖ | ✖ | ✔ | ✔ | ✔ |
| `payments` update (any column) | ✖ | ✖ | ✖ | ✖ / **own (created_by)** | ✖ / **own** | ✖ / **✔** | ✔ |
| `payment_applications` direct insert | ✖ | ✖ | ✖ | ✖ | ✖ / ✖ | ✖ / **✔** (`manager_insert_*`) | ✔ |
| `vendor_payments` direct insert / RPC | ✖ | ✖ / **✔** | ✖ / **✔** | ✖ / **✔** | RPC ✔ / **✔** | RPC ✔ / **✔** | ✔ |
| `purchase_orders` / `vendor_invoices` read | ✖ | ✖ | ✖ | ✖ | ✔ | ✔ | ✔ |
| `purchase_orders` / `vendor_invoices` create/edit/cancel | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✔ |
| **approve** PO / VI (incl. own) | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ / **✔** (BUG-004) | ✔ |
| `receive_vendor_invoice` | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✔ |
| `notifications` read | ✖ | targeted | targeted | targeted | targeted | targeted | targeted |
| `notifications` insert (any target/created_by) | ✖ | ✖ / **✔** | ✖ / **✔** | ✖ / **✔** | ✖ / **✔** | ✔ | ✔ |
| `notifications` update any column | ✖ | ✖ / **✔ all rows** (BUG-011) | ✖ / **✔** | ✖ / **✔** | ✖ / **✔** | ✖ / **✔** | ✔ |
| `notification_queue` insert (enqueue WhatsApp) | ✖ | ✖ / **✔** | ✔ | ✔ | ✔ | ✔ | ✔ |
| `rma_config` (`appearance_settings` company row) | ✖ | ✖ / **✔** | ✖ / **✔** | ✖ / **✔** | ✖ / **✔** | ✖ / **✔** | ✔ |
| `rma_config` other keys / `email_settings` / `webhooks` / `announcements` write | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ |
| `user_roles` read | ✖ | own | own | own | own | own | all |
| `user_roles` write (role, permissions, status) | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ (last-super-admin trigger ✔) |
| `custom_roles` read / write | ✖ | ✔ / ✖ | ✔ / ✖ | ✔ / ✖ | ✔ / ✖ | ✔ / ✖ | ✔ |
| `user_activity_log` insert with any `user_email` | ✖ | ✖ / **✔** (BUG-019) | **✔** | **✔** | **✔** | **✔** | ✔ |
| `user_activity_log` read | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ |
| `user_preferences` own row | ✖ | ✔ (can re-key `user_email`, BUG-050) | same | same | same | same | ✔ |
| `kb_articles` read published / write | ✔ / ✖ | ✔ / ✖ | ✔ / ✖ | ✔ / ✖ | ✔ / ✖ | ✔ / ✖ | ✔ / ✔ |
| `product_documents` read / write | ✖ | ✔ / ✖ | ✔ / ✖ | ✔ / ✖ | ✔ / ✖ | ✔ / ✔ | ✔ |
| Storage objects list / read | ✖ / **✔ all** (BUG-003) | **✔ all** | ✔ | ✔ | ✔ | ✔ | ✔ |
| Storage objects upload / delete **any path** | `comments/*` unlimited / ✖ | ✖ / **✔** | **✔** | **✔** | **✔** | **✔** | ✔ |
| `/control-panel` (UI) | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ |
| `admin-invite-user`, `admin-delete-user` functions | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | super_admin (active) ✔ |
| `admin-reset-password` function | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | super_admin (**status not checked**, BUG-018) |
| `send-email` function | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | admin (active) ✔ |
| `send-whatsapp` / `notification-worker` functions | ✖ / **header bypass** (BUG-022) | ✖ | ✔ (**even if suspended**, BUG-021) | ✔ | ✔ | ✔ | ✔ |
| `ai-assist` function | ✖ | ✖ / **✔** | ✖ / **✔** | **✔** | **✔** | ✔ | ✔ |
| `kb-chat` function | ✖ | ✔ (RLS-scoped) | ✔ | ✔ | ✔ | ✔ | ✔ |
| Suspended / expired / pending account, any table | – | ✖ ✔ correct (`rma_user_role()` → NULL) | same | same | same | same | same |

Additional matrix notes:

* **Horizontal escalation:** sales-rep read/update scoping on `leads`/`deals`/`activities`/`quotations`/`sales_orders`/`crm_invoices`/`credit_notes` is correct on the read side. On the write side, **BUG-002 (fixed 2026-09-03)** was that a rep could rewrite any column — `payment_status`, `amount_paid`, `total`, `line_items`, `doc_status`, `inv_code`, `customer_id` — of their own **settled** `crm_invoices`/`credit_notes` row; reassigning a row to another rep specifically was *not* part of that gap, since Postgres already reused `USING` as the implicit check on the new row in the absence of a `WITH CHECK` clause (measured, not assumed — see the correction note on BUG-002).
* **Vertical escalation:** viewer → writes on 6 tables (BUG-011, BUG-001, BUG-019); technician/sales_rep → inventory columns (BUG-010); manager → approvals and direct financial columns (BUG-002/004).
* **Mass assignment:** `user_roles` is admin-only (✔), but every other table accepts any column the row policy permits — `status`, `amount_paid`, `reservation_status`, `created_by`, `target_roles`, `user_email`.
* **Role change propagation:** roles are read once at login (`finishLogin`) and cached in React state; a role/permission change takes effect for the DB immediately (`rma_user_role()` is evaluated per request) but for the UI only after reload; suspension does not revoke sessions (BUG-049).
* **Default role on sign-up:** none (fails closed — `AccessDenied` screen, DB returns NULL). ✔
* **Fail-open checks found:** MFA (BUG-020); `notification-worker` header (BUG-022); `resolvePermissions` for a custom role whose `custom_roles` row is missing → `null` permissions (fails closed ✔).
* **Token/session:** logout uses `signOut()` (local scope) with a separate "sign out everywhere"; password change relies on GoTrue's setting for revoking other sessions (unverified, BUG-075).

---

## 6. Test Coverage Gaps

**Measured:** `vitest run --coverage` → **All files 33.89 % statements / 29.71 % branches / 28.86 % functions / 36.48 % lines** (v8, only files imported by some test are counted, so the true figure over 88 k lines is lower).

| Area | Stmts | Notes |
|---|---|---|
| `src/lib` | 89.98 % | well covered (money, permissions, schemas, stock summary, RMA moves, backup manifest) |
| `src/lib/messaging` | 100 % | TemplateEngine |
| `src/contexts` | 67 % | AppearanceContext |
| `src/components` | 54 % | 8 of 25 components touched |
| `src/api` | 46.5 % | `backup.js` 97 %, `auth.js` 44 %, `ai.js` 14 % |
| **`src/api/db`** | **6.0 %** | 137/2271 statements — the data layer that holds every RLS assumption is essentially untested |
| **`src/pages`** | **18 %** (of the handful of page files that are imported at all) | `Reports`, `Dashboard`, `TicketForm`, `TicketDrawer`, `CustomerDetails`, `Inventory/*`, `Purchasing/*`, `SalesDocuments/*`, `Activities`, `Pipeline`, `Leads`, `BackupRestore`, `DataCleanup`, `KnowledgeCenter`… have **no** tests |
| Edge Functions | 0 % (one syntax-only test) | no handler tests; `verify_jwt` mismatches would have been caught by a single curl in CI |
| SQL / RLS | not executable (`test:db` blocked; `db-tests` job disabled) | the 5 `supabase/tests/*.sql` files are the only RPC assertions and cannot run |
| Integration tier | anonymous only, read-only | no signed-in role probes; asserts on a nonexistent table (BUG-061) |

**Untested behaviours that produced findings in this audit** (each is a candidate test):

1. Per-role RLS write probes for every table (viewer insert into `payments`, technician update of `inventory_units`, rep update of a posted invoice, manager approve own VI) — run against a staging project with fixture users; assert `42501`.
2. Storage policy assertions (anon list refused; delete limited to owner).
3. `update()` helpers throw on 0 affected rows (BUG-008).
4. Credit-note-from-invoice total equals the credited invoice amount incl. discount/tax (BUG-013).
5. `bulkMoveStage` into a won stage sets `status='won'`; `moveStage` invariants (BUG-033).
6. Sales-document transition table (draft→sent→accepted→converted…) rejects illegal moves (BUG-034).
7. `generateRmaNumber` uniqueness under concurrency / server generation (BUG-035).
8. Date helpers: due-date default and overdue at local midnight, DST (BUG-038).
9. Aging buckets incl. undated invoices (BUG-065).
10. `DataCleanup` awaits deletes and reports failures (BUG-012).
11. `WebhooksConfig` save path (BUG-015) — a render + click test would have failed immediately.
12. Announcement targeting (BUG-046); login activity role (BUG-047).
13. Locale key parity `en.json` vs `ar.json` (BUG-042).
14. Edge-function contract tests: cron header path, webhook signature, `ai-assist` status codes, suspended-user rejection.
15. Realtime smoke test (publication contains `notifications`).
16. CSV export escaping (BUG-044); import validation (BUG-045).
17. Backup: secrets never present in the export (BUG-025); restore rollback on mid-way failure.
18. `ticketParts.add` insufficient stock error (BUG-030); `createBatch` numbering (BUG-029).

---

## 7. Appendix

### A. Raw tool output (abridged)

**A.1 `npm audit` (2026-09-03)** — 15 vulnerabilities (0 critical, 11 high, 2 moderate, 2 low), 920 dependencies (226 prod).

```
@babel/core            low       Arbitrary File Read via sourceMappingURL
@vite-pwa/assets-gen   high      via sharp
brace-expansion        high      DoS via exponential-time expansion
browserslist           high      unbounded memory growth / prototype write
dompurify              moderate  CUSTOM_ELEMENT_HANDLING bypass; ALLOWED_ATTR pollution
fast-uri               high      host confusion via backslash
nanoid                 high      infinite loop on negative/zero size
postcss                high      sourceMappingURL path traversal (incomplete fix)
postcss-selector-parser low      DoS via AST recursion
react-router           high      6.0.0-7.18.1  open redirect via backslash (CVE-2025-68470 bypass); RSCErrorHandler XSS
react-router-dom       moderate  6.0.0-alpha.0-7.17.0 (via react-router)
sharp                  high      libvips CVE-2026-33327/33328/35590/35591
undici                 high      TLS validation bypass (SOCKS5); Set-Cookie header injection
vite                   high      <=6.4.2  launch-editor NTLMv2 hash disclosure; server.fs.deny bypass (Windows)
xlsx                   high      *  Prototype pollution; ReDoS (no fix available)
```

**A.2 ESLint** — `errors 0, warnings 2406`: `no-restricted-syntax` 2398, `no-unused-vars` 5, `react-hooks/exhaustive-deps` 3 (files in BUG-053).

**A.3 `tsc --noEmit`** — 83 errors: TS7016 ×35, TS7006 ×24, TS2339 ×18, TS2352 ×2, TS7053 ×1, TS2345 ×1, TS2322 ×1, TS2307 ×1 (`WhatsAppProvider.ts:39`).

**A.4 Prettier** — 259 files would change (e.g. `src/utils/index.ts`, `src/test/useUrlState.test.jsx`, `src/test/WidgetShell.test.jsx`).

**A.5 Vite build** — `✓ built in 13.69s`; warning: some chunks larger than 500 kB; PWA precache 90 entries (5,068.88 KiB). (First attempt, run concurrently with tsc and eslint, died with `[vite:esbuild-transpile] The service was stopped` — Go runtime crash from memory pressure; not reproducible in isolation.)

**A.6 Vitest** — `Test Files 45 passed (45)`, `Tests 1184 passed (1184)`, duration 101.5 s; coverage table in §6.

**A.7 Supabase security advisor** — 74 warnings: `authenticated_security_definer_function_executable` ×57 (all app RPCs — expected for this design), `anon_security_definer_function_executable` ×15 (`crm_update_customer_last_activity`, `protect_system_warehouse`, `rma_current_user_email`, `rma_guard_base_currency`, `rma_guard_charges_before_receipt`, `rma_guard_document_rate`, `rma_is_admin`, `rma_is_manager_or_above`, `rma_is_staff`, `rma_protect_last_super_admin`, `rma_user_role`, `stock_moves_stamp_actor`, `sync_credit_note_balance`, `sync_payment_balance`, `sync_vendor_payment_balance`), `extension_in_public` (`pg_net`), `auth_leaked_password_protection` (disabled).

**A.8 Supabase performance advisor** — 164 items: `multiple_permissive_policies` ×116 (26 tables), `unindexed_foreign_keys` ×25, `unused_index` ×19, `auth_rls_initplan` ×3 (`notification_preferences`), `table_bloat` (`net._http_response`).

**A.9 Live catalog facts used above**

```
public tables: 62 (RLS enabled on all), policies: 199, views: 6 (all security_invoker), non-internal triggers: 29
schema_migrations: ['20260524']
cron.job: (1) 'queue-overdue-ticket-emails' '0 8 * * *'; (2) 'drain-notification-queue' '*/2 * * * *' → net.http_post(... headers {"Content-Type","x-trigger-source":"pg_cron"})
net._http_response (today): 401 × 179 ("Missing authorization header"), NULL × 1
notification_queue: pending 351 (email/ticket.overdue 341, whatsapp/ticket.created 9, whatsapp/ticket.updated 1); completed 135 (last 2026-07-01); failed 13
notification_logs: email sent 118; whatsapp sent 21, failed 53; delivered_at/read_at populated: 0
pg_publication_tables (public): none        [as at 2026-09-03; BUG-007 fixed 2026-09-06 — now 7 tables]
storage.buckets: rma-attachments public=true, file_size_limit=null, allowed_mime_types=null
storage.objects policies: 'Allow public read 1gfjb3d_0' SELECT public true; 'Allow authenticated delete 1gfjb3d_0' DELETE authenticated true; 'Allow authenticated delete 1gfjb3d_1' SELECT authenticated true; 'Allow authenticated uploads 1gfjb3d_0' INSERT authenticated true; 'anon can read/upload comment attachments' (comments/*)
document_sequences: invoice 23 (max INV-2026-00023), credit_note 6 (max CN-2026-00005 → one number consumed by a rolled-back issue), payment 11, vendor_invoice 10, vendor_payment 1
user_roles: 17 rows (super_admin 2, admin 2, manager 3, sales_rep 4, technician 4, viewer 2), all active; auth.users: 8; role rows without auth user: 10; auth users without role: 1; password_hash non-null: 1; verified MFA factors: 0
integrity: posted invoices with amount_paid ≠ Σ applications: 6 (all seed, 2026-06-08); delivered SOs without stock_moves: 15; live units with empty serial: 8; posted invoices without due_date: 3; customers sharing a mobile: 14; tickets with NULL customer_id: 1; deals with invalid stage: 0; open deals in terminal stage: 0; orphan activities: 0
```

**A.10 Rolled-back probes (exact result strings)**

```
viewer   : "viewer direct INSERT into payments succeeded, 1 row"
viewer   : "viewer INSERT ticket_resolutions succeeded (1 row) | viewer UPDATE notifications title affected 155 rows | viewer UPDATE company appearance affected 1 rows"
manager  : "used a draft VI forced to pending | manager self-approved vendor invoice: 0 row | no open SO for the rep"   (inconclusive — no VI in pending_approval existed)
technician: "technician cleared a unit reservation / warehouse directly: 1 row | technician inserted a notification to super_admins as created_by=someone-else: 1 row | technician can read 888 customers | technician reads 1 user_roles rows"
sales_rep: blocked by the audit tool's classifier before execution (reported from policy text)
```

### B. Queries to reproduce the data findings

```sql
-- BUG-005 / 043
SELECT status_code, count(*) FROM net._http_response GROUP BY 1;
SELECT job_type, event_type, status, count(*) FROM notification_queue GROUP BY 1,2,3;
SELECT payload->>'ticketId', count(*) FROM notification_queue
 WHERE event_type='ticket.overdue' AND status='pending' GROUP BY 1 ORDER BY 2 DESC;
-- BUG-006
SELECT provider, delivery_status, count(*), count(delivered_at), count(read_at) FROM notification_logs GROUP BY 1,2;
-- BUG-007
SELECT * FROM pg_publication_tables WHERE schemaname='public';
-- BUG-003
SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets;
SELECT policyname, cmd, roles, qual, with_check FROM pg_policies WHERE schemaname='storage';
-- BUG-014
SELECT version FROM supabase_migrations.schema_migrations;
-- BUG-041 / 063
SELECT inv_code, total, amount_paid, payment_status FROM crm_invoices i
 WHERE doc_status='posted' AND abs(
   (SELECT coalesce(sum(amount_applied),0) FROM payment_applications WHERE invoice_id=i.id)
 + (SELECT coalesce(sum(amount_applied),0) FROM credit_note_applications WHERE invoice_id=i.id)
 - i.amount_paid) > 0.01;
SELECT count(*) FROM sales_orders so WHERE status='delivered'
   AND NOT EXISTS (SELECT 1 FROM stock_moves sm WHERE sm.doc_type='sales_order' AND sm.doc_id=so.id);
SELECT count(*) FROM inventory_units WHERE status<>'closed' AND coalesce(serial_number,'')='';
SELECT count(*) FROM customers c WHERE EXISTS (SELECT 1 FROM customers d WHERE d.id<>c.id AND d.mobile=c.mobile AND coalesce(c.mobile,'')<>'');
-- BUG-039 / 018
SELECT count(*) FROM user_roles WHERE password_hash IS NOT NULL;
SELECT count(*) FROM user_roles r WHERE lower(r.user_email) NOT IN (SELECT lower(email) FROM auth.users);
-- BUG-057
SELECT grantee, table_name, string_agg(privilege_type, ',') FROM information_schema.role_table_grants
 WHERE table_schema='public' AND grantee='anon' GROUP BY 1,2;
-- Policy dump used for §5
SELECT tablename, policyname, cmd, roles, qual, with_check FROM pg_policies WHERE schemaname='public' ORDER BY 1,3,2;
```

### C. Unverified areas

| Area | Why | What would verify it |
|---|---|---|
| Sales-rep UPDATE of a posted invoice (BUG-002) | the rolled-back probe was blocked by the audit tooling; conclusion rests on the live policy text + absence of triggers | run the `DO` probe from A.10 as a sales rep in a transaction, or `PATCH` on staging |
| Manager self-approval (BUG-004) | no vendor invoice in `pending_approval` existed to flip | create a draft VI on staging, submit, approve as the same manager |
| Supabase Auth dashboard settings (sign-ups, password policy, session/refresh lifetimes, "require current password", MFA enforcement) | not readable via SQL/MCP | dashboard review |
| Edge-function secrets (`ALLOWED_ORIGINS`, `WORKER_SECRET`, `KB_LLM_*`, `NVIDIA_API_KEY`, WhatsApp tokens) | not readable | `supabase secrets list` |
| Live behaviour of `whatsapp-webhook` `.catch()` on PostgREST builders with the resolved `@supabase/supabase-js@2` version at deploy time | function loads a floating major from esm.sh | deploy-time pin + unit test |
| Vercel runtime headers actually served (CSP, HSTS) | no browser session against the production URL in this audit | curl the production origin |
| Sentry configuration (PII scrubbing, `sendDefaultPii`) | DSN not present in `.env` | check project settings |
| Resend / Meta account state (domain verification, template approvals) | external | provider dashboards |
| `test:db` SQL assertion suites (`supabase/tests/*.sql`) | cannot run without Docker and a baseline | port to the integration tier against staging |
| Load / concurrency behaviour of the RPCs (`FOR UPDATE` paths were read, not stress-tested) | no staging | k6 or pgbench scripts |
| UI click-through of every screen | out of scope for a static/DB audit; the project's own checklists (`WAREHOUSE_R1_TEST_CHECKLIST.md`, `CRM_QA_CHECKLIST.md`) remain unchecked | manual QA |

### D. Assumptions made

* The Supabase project `ohkynosgscfygtjxbpxq` (`myrma-production`) is the deployment the repository targets (the `.env` URL points at it and the seed scripts hard-code it).
* Business timezone is Africa/Cairo (the company is QDS Egypt; base currency EGP).
* The six seed invoices from `*@test.com` accounts are fixtures (memory notes say the purge is deferred) — reported as data-integrity evidence, not as a code defect.
* "Expected" behaviour in the permission matrix is taken from `ROLE_DEFAULT_PERMISSIONS` comments and the CLAUDE/CONSTITUTION documents, which describe `viewer` as read-only and `manager` as unable to approve spend.
* Severity follows the definitions in the task: Critical = data loss / auth bypass / privilege escalation / corruption; High = core feature broken, wrong results, security weakness; Medium = edge-case failure, poor error handling, inconsistency; Low = cosmetic / code smell; Informational = suggestion.

*End of report.*
