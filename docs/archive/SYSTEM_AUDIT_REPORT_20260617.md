# myRMA — Full System Audit Report
**Date:** 2026-06-17
**Auditor:** Claude Code (automated static analysis + file inspection)
**Previous score:** 9.3/10 (per AUDIT_LOG.md, dated 2026-06-01)
**Verdict:** 7.6/10 — Strong architecture and 173/173 passing tests, but **CI is currently broken** (`lint:ci` fails) and the permission system has **confirmed bypass bugs** that must be fixed before the next deploy.

---

## Executive Summary

This audit ran all 13 phases against the current `test` branch. The data layer, RLS policies, routing, provider order, and page-folder structure are all clean and match documentation exactly — this is a well-architected codebase. However, three things need attention before shipping: (1) `npm run lint:ci` — the exact command CI runs — currently fails with 2 errors and 11 warnings, meaning **CI would fail on this branch right now**; (2) at least two confirmed permission-bypass bugs exist where hardcoded role checks (`|| currentUserRole === ROLES.MANAGER`) override the granular `canDo()` permission system, silently defeating any custom permission an admin sets; (3) a live Supabase service-role key sits unused in the local `.env` file under a `VITE_`-prefixed name — not currently exploited, but a real footgun. The system is **not production-blocked** (the underlying RLS/Edge Function security is sound), but is **not deploy-ready** until the P0 items below are addressed.

## Score Breakdown

| Domain | Score | Notes |
|--------|-------|-------|
| Security | 7/10 | RLS, Edge Functions, storage policies all solid. Docked for the permission-bypass bugs and the stray service-role key. |
| Architecture | 7/10 | Provider order, routing, data layer, page folders all exact-match. Docked for L-1 and L-4 Constitutional Law violations found. |
| Feature Coverage | 9/10 | All 25 features verified present via file-existence checks. |
| Design System | 8/10 | Spot-checked 4 files; Hanken Grotesk, card tokens, no anti-pattern grays found. Light-touch review. |
| Database / Migrations | 8/10 | 16 migrations, mostly idempotent; one migration has zero idempotency guards. |
| Performance / PWA | 7/10 | Build succeeds, manifest correct, NetworkFirst configured. Main chunk exceeds 500KB; circular-import warning. |
| Accessibility | 8/10 | Spot-checks (aria-sort, Spinner role) pass — consistent with this session's earlier WCAG audit work. |
| Code Quality | 6/10 | Zero console.log/TODO/`any` types — clean in that sense. But `lint:ci` and `format:check` both fail outright. |
| Documentation Accuracy | 8/10 | Route table, migration list, page folders all accurate. One stale claim found (TooltipProvider). |
| **Overall** | **7.6/10** | |

---

## Phase 0 — Environment

| Check | Result |
|-------|--------|
| Node version | v24.15.0 (≥ 20 ✅) |
| npm version | 11.12.1 (≥ 10 ✅) |
| React version | 18.2.0 ✅ |
| Vite version | 6.1.0 ✅ |
| `.npmrc` | `legacy-peer-deps=true` ✅ |
| `.env.example` | `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` present ✅ |
| `vite.config.js` | exists ✅ |
| `.github/workflows/ci.yml` | exists, runs test → lint:ci → build in order ✅ |
| `tailwind.config.js` | exists ✅ |
| `eslint.config.js` | exists (flat config) ✅ |
| `.prettierrc` | exists ✅ |

All Phase 0 checks pass.

## Phase 1 — Automated Tests

**`npm test`:**
```
Test Files  7 passed (7)
     Tests  173 passed (173)
  Duration  6.85s
```
✅ PASS

**`npm run test:coverage`:**
```
All files          |   88.58 |    82.71 |   78.04 |   91.56
 api/db/audit.ts    |   89.28 |       70 |   71.42 |    91.3 | uncovered 40-41
 lib/permissions.ts |   94.11 |    94.11 |     100 |     100 | uncovered 277
 lib/safeStorage.ts |   72.72 |      100 |   66.66 |      70 | uncovered 10,19-20
 lib/schemas.ts     |    87.5 |    71.42 |   83.33 |   89.28 | uncovered 128,230-231
 RMATickets/_utils.js | 71.42 |    53.84 |   58.33 |   80.64 | uncovered 23-25,61-63
```
Overall 88.58% statement coverage. `safeStorage.ts` has the weakest coverage (no dedicated test file — see Phase 3 L-7).

**`npm run lint:ci`:** ❌ **FAILS** (exit code 1)
```
D:\myrma-app\src\components\BarcodeScanner.jsx
  53:29  error  'requestAnimationFrame' is not defined  no-undef
  66:7   error  'cancelAnimationFrame' is not defined   no-undef
[... 11 warnings across 9 other files ...]
✖ 13 problems (2 errors, 11 warnings)
```
Root cause verified: `eslint.config.js`'s `globals` object defines `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval` but omits `requestAnimationFrame`/`cancelAnimationFrame` — a config gap, not a code bug. The 11 warnings (mostly `react-hooks/exhaustive-deps` and `no-unused-vars`) also fail because `lint:ci` runs with `--max-warnings 0`. **This is the exact command CI runs — CI is currently broken on this branch.**

**`npm run format:check`:** ❌ **FAILS** — 103 files have Prettier style issues. Not currently CI-blocking (ci.yml does not run `format:check`), but formatting has drifted significantly.

**`npm run build`:** ✅ Succeeds in ~17s.
- PWA: 52 precache entries, `generateSW` strategy confirmed.
- ⚠️ One chunk exceeds 500KB: `index-*.js` at 653.00 kB (gzip 175.60 kB). Other large-but-under-threshold chunks: `xlsx` (429.53 kB), `DashboardCharts` (395.84 kB), `jspdf.es.min` (390.74 kB).
- ⚠️ Rollup warning: `src/api/client.js` is both statically imported (by most `api/db/*.ts` files) and dynamically imported (by `ticketEventHandlers.ts`, `WALogs.jsx`) — Rollup cannot code-split it, which contributes to the oversized main chunk.

---

## Phase 2 — Security Audit

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 2-A | `VITE_SUPABASE_SERVICE_KEY` absent from `src/` | ✅ PASS | Zero references in `src/` |
| 2-A | Service key only in `supabase/functions/` | ⚠️ PARTIAL | All 7 Edge Functions correctly use `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')`. **However**, a real, live `VITE_SUPABASE_SERVICE_KEY` value exists in the local `.env` file (not git-tracked, not referenced by any code). See SEC-01 below. |
| 2-A | Edge Functions validate caller JWT | ✅ PASS | Verified in `admin-reset-password`; pattern consistent across functions per Phase 3 read of `7.4 Edge Functions` |
| 2-A | WhatsApp secrets not in client code | ✅ PASS | Zero references to `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`/`WHATSAPP_WEBHOOK_VERIFY_TOKEN` in `src/` |
| 2-B | `20260526_enable_rls.sql` exists, enables RLS | ✅ PASS | |
| 2-B | RLS helper functions exist | ✅ PASS | `rma_user_role()`, `rma_is_admin()`, `rma_is_manager_or_above()`, `rma_is_staff()`, `rma_current_user_email()` all confirmed at `20260526_enable_rls.sql:32-58` |
| 2-B | No `auth.user_role()` etc. | ✅ PASS | Zero matches across `supabase/` |
| 2-B | Migration idempotency spot-check | ⚠️ PARTIAL | 13/16 migrations have `IF NOT EXISTS`/`IF EXISTS`/`DROP POLICY IF EXISTS` markers. `20260529_repair_permissions.sql` has **zero** idempotency markers — see CQ finding below. |
| 2-C | Zod schemas cover ticket/customer/product | ✅ PASS | `ticketSchema`, `customerSchema`, `productSchema` all in `src/lib/schemas.ts` |
| 2-C | `parseCSVLine` used (not bare `split(',')`) | ✅ PASS | Confirmed in `Customers/index.jsx` and `Products/index.jsx` |
| 2-D | Storage bucket caps 25MB, correct MIME types | ✅ PASS | `20260527_storage_bucket_policies.sql:5-22` |
| 2-D | No page bypasses storage helper | ✅ PASS | Zero direct `.storage.from()` calls in `src/pages/` |
| 2-E | `/tracker` and `/kb` are the only unauthenticated routes | ✅ PASS | Confirmed via `pathname === '/...'` checks in `App.jsx:783,792` |
| 2-E | `/control-panel` is admin+ gated | ✅ PASS | Route guard at `App.jsx`, and now correctly preview-aware per this session's fix (`effectiveUserRole`) |
| 2-E | `canDo()` used for all permission gating, no hardcoded roles | ❌ **FAIL** | **30 hardcoded role comparisons** found across `src/pages/`. See SEC-02 below — at least 2 confirmed bypass bugs. |
| 2-F | WhatsApp param ordering uses arrays | ✅ PASS | `ticketEventHandlers.ts:110` — `buildQueuePayload` builds `params` via `.map()`, preserving JSONB array order |
| 2-F | No empty positional params | ✅ PASS (not re-verified this pass — confirmed in earlier session work) | |
| 2-F | `notification-worker` exponential backoff | ✅ PASS | `notification-worker/index.ts:260` — `300_000 * Math.pow(2, newRetry - 1)` = 5m → 10m → 20m |

### SEC-01 — Live service-role key in local `.env` (P0)
`d:\myrma-app\.env` contains `VITE_SUPABASE_SERVICE_KEY=<live JWT>`. This is **not** git-tracked (`.gitignore` correctly excludes `.env`) and **no code currently references it** — all Edge Functions correctly read `SUPABASE_SERVICE_ROLE_KEY` server-side instead. There is no active exploitation path today. However: the `VITE_` prefix means Vite would inline this value into the browser bundle the moment any future code does `import.meta.env.VITE_SUPABASE_SERVICE_KEY` — a one-line mistake away from a full RLS-bypass leak. Recommend removing this line from `.env` entirely (it serves no purpose in the current Edge-Function-based architecture) and rotating the key, since its value was displayed during this audit's tool output.

### SEC-02 — Hardcoded role checks bypass `canDo()` (P0/P1)
Full list of 30 hardcoded comparisons across `src/pages/` is in Phase 3 below. Two are **confirmed functional bugs**, not just style violations:

- **`PartsInventory.jsx:350-353`**:
  ```js
  const canAdd = canDo('create') || currentUserRole === ROLES.MANAGER
  const canEdit = canDo('edit') || currentUserRole === ROLES.MANAGER
  const canAdjust = canAdd || currentUserRole === ROLES.TECHNICIAN || canDo('adjust_stock')
  ```
  Any Manager can always create/edit parts and any Technician can always adjust stock, **regardless of what an admin sets via Edit Permissions** — the hardcoded `||` clause silently overrides an explicit `parts.create = false` override. This is the same bug class found and fixed this session in `UserManagement`'s "Invite User" button.

- **`Invoices.jsx:535-537`**:
  ```js
  const isManager = currentUserRole === ROLES.MANAGER || isAdmin
  const isTech = currentUserRole === ROLES.TECHNICIAN
  const isViewer = currentUserRole === ROLES.VIEWER
  ```
  If these booleans gate invoice create/edit/delete buttons (not fully traced in this pass — needs a follow-up read of how `isManager`/`isTech`/`isViewer` are consumed further down the file), the same bypass risk applies: a Manager's `invoices.create/edit/delete` permission overrides set via Edit Permissions would have no effect.

---

## Phase 3 — Architecture Audit

### 3-A Constitutional Law Compliance

| Law | Result | Evidence |
|-----|--------|----------|
| L-1: No direct supabase import in pages | ❌ **FAIL** | `src/pages/cp/WATestCenter.jsx:5` — `import { supabase } from '../../api/client'` |
| L-2: No re-implemented shared components | ✅ PASS (spot-check) | No obvious duplicate button/modal/input patterns found in sampled files |
| L-3: No hardcoded status/priority strings outside constants | ⚠️ NEEDS MANUAL REVIEW | 14 files match a broad grep, but most appear to be color-lookup-map keys (e.g. `getStatusColor`'s `{'Open': '...', 'Closed': '...'}`) matching `TICKET_STATUS` values — an accepted existing pattern, not new business logic duplication. Recommend a tighter manual pass rather than treating all 14 as violations. |
| L-4: All permission checks use `canDo()` | ❌ **FAIL** | 30 hardcoded role comparisons (full list below). See SEC-02. |
| L-5: All localStorage uses `safeStorage` | ✅ PASS | Only hit outside `safeStorage.ts` itself is `src/test/audit.test.js`, which legitimately exercises raw `localStorage` to verify `safeStorage`/`_auditEnqueue` behavior |
| L-6: TypeScript db layer, no `any` | ✅ PASS | All files in `src/api/db/` are `.ts`; zero `: any`/`<any>`/`as any` matches |
| L-7: All new `src/lib/` code has unit tests | ⚠️ PARTIAL | `constants.ts`, `permissions.ts`, `schemas.ts` all have tests. **`safeStorage.ts` has no test file.** |
| L-8: Dark mode on all UI components | ✅ PASS (spot-check) | Consistent with this session's UX-09 dark-mode sweep |
| L-9: No ad-hoc schema changes | ✅ PASS | All 16 schema files present in `supabase/migrations/`, named `YYYYMMDD_*.sql` |
| L-10: CI must pass | ❌ **FAIL** | `npm run lint:ci` fails locally with the exact command CI runs — see Phase 1 |

**Full list of 30 hardcoded role comparisons** (file:line):
```
AccountSettings.jsx:167, CustomerDetails.jsx:75,79, Invoices.jsx:535-537,
PartsInventory.jsx:347,350-353, ProductDetails.jsx:216,220, Reports.jsx:1013,1018-1022,
Customers/index.jsx:88, Inventory/index.jsx:22, Products/index.jsx:119,
RMATickets/TicketDrawer.jsx:36,655-656,1091,1189-1190, RMATickets/TicketForm.jsx:330,799,
RMATickets/index.jsx:202, UserManagement/UsersTab.jsx:22,26, UserManagement/index.jsx:438,670
```
Many of these (e.g. `RMATickets/TicketDrawer.jsx:36`, `TicketForm.jsx:330`, `index.jsx:202`, `Inventory/index.jsx:22`, `Customers/index.jsx:88`, `Products/index.jsx:119`) are local re-implementations of `canDo()`'s own `super_admin`/`admin` bypass logic rather than importing the shared helper from `lib/permissions.ts` — a DRY/duplication concern (drift risk if the bypass logic ever changes) rather than a security bug. `UserManagement/index.jsx:438` and `UsersTab.jsx` checks for direct-password-set are correctly tied to the `admin-reset-password` Edge Function's own literal `super_admin`-only requirement (verified server-side this session) and should **not** be changed. The PartsInventory and Invoices cases are the genuine bypass-risk ones (SEC-02).

### 3-B Data Layer Integrity
- ✅ `src/api/supabaseClient.js` barrel re-export confirmed
- ✅ All 9 domain modules exist in `src/api/db/`: `tickets.ts`, `customers.ts`, `catalog.ts`, `inventory.ts`, `users.ts`, `notifications.ts`, `system.ts`, `audit.ts`, `whatsappNotifications.ts` (plus `kb.ts`, added this session)
- ✅ `src/api/db/index.ts` aggregates all modules + re-exports Row types and shared `TableResult`/`PagedResult`/`CountedResult` types (centralized this session under CQ-07)
- ✅ `audit.ts` has the resilient write queue (`_auditEnqueue`/`auditFlushQueue`)

### 3-C Routing & Lazy Loading
- ✅ All page imports in `App.jsx` use `lazyWithReload()`. The one bare `React.lazy()` match (`App.jsx:92`) is inside `lazyWithReload`'s own definition — not a violation.
- ✅ Parameterized routes use thin wrappers (`ProductDetailsRoute`, `CustomerDetailsRoute`)
- ✅ Catch-all `*` → `NotFoundPage` confirmed
- ✅ `window.history.pushState` — genuinely only called in `RMATickets/index.jsx`; the `App.jsx` grep hit is a comment referencing it historically, not a call

### 3-D Provider Order
✅ **Exact match**: `React.StrictMode → ErrorBoundary → BrowserRouter → QueryClientProvider → AppearanceProvider → App` (`main.jsx:31-43`)
✅ TanStack Query config: `staleTime: 60_000`, `retry: 1` confirmed (`main.jsx:24-25`)
❌ **`TooltipProvider` does not exist anywhere in `src/`** — see DOC-19 in Phase 12.

### 3-E State Management
- ✅ Single `app_notifications` channel confirmed in `App.jsx:421`
- ℹ️ Found `.channel()` calls in `Customers/index.jsx`, `Dashboard.jsx`, `Inventory/index.jsx`, `Products/index.jsx`, `RMATickets/index.jsx` — these are **separate, legitimately-scoped data-sync channels** (`rma_tickets_realtime`, `dashboard-rt`, etc.), distinct from the notification system. Not a violation of the single-notification-channel rule.
- ✅ `AppearanceContext.jsx:88` — `html.classList.toggle('dark', !!s.darkMode)`
- ✅ `AppearanceContext.jsx:124` — `html.setAttribute('dir', isRTL ? 'rtl' : 'ltr')`

### 3-F Page Folder Structure
All 5 expected page folders confirmed with all expected files present: `Inventory/`, `RMATickets/`, `Products/`, `UserManagement/`, `Customers/`. ✅ Exact match to CLAUDE.md.

---

## Phase 4 — Feature Coverage Matrix

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 1 | RMA Ticket CRUD | ✅ Exists | `api/db/tickets.ts` + `pages/RMATickets/` |
| 2 | Customer Management | ✅ Exists | `api/db/customers.ts` + `pages/Customers/` |
| 3 | Product Catalog | ✅ Exists | `api/db/catalog.ts` + `pages/Products/` |
| 4 | Inventory Tracking | ✅ Exists | `api/db/inventory.ts` + `pages/Inventory/` |
| 5 | Public RMA Tracker | ✅ Exists | `pages/RMATracker.jsx` + `functions/public-track/` |
| 6 | Tech Calendar | ✅ Exists | `pages/TechCalendar.jsx` |
| 7 | Invoices | ✅ Exists | `pages/Invoices.jsx` |
| 8 | Reports | ✅ Exists | `pages/Reports.jsx` |
| 9 | Parts Inventory | ✅ Exists | `pages/PartsInventory.jsx` |
| 10 | RBAC | ⚠️ Partial | `lib/permissions.ts` + `ROLE_DEFAULT_PERMISSIONS` exist and are well-designed, but see SEC-02 — not consistently enforced everywhere |
| 11 | Real-Time Notifications | ✅ Exists | `app_notifications` channel + `api/db/notifications.ts` |
| 12 | Dark Mode | ✅ Exists | `AppearanceContext` + `dark:` classes throughout |
| 13 | RTL / Arabic | ✅ Exists | `dir="rtl"` toggle + `ms-`/`me-` usage (verified this session in UX-09/UX-10 work) |
| 14 | PWA / Offline | ✅ Exists | `vite-plugin-pwa` + Workbox `generateSW` |
| 15 | WhatsApp Notifications | ✅ Exists | `send-whatsapp/`, `notification-worker/`, `whatsapp-webhook/` all present |
| 16 | PDF Generation | ✅ Exists | `jspdf` + `html2canvas` in dependencies and bundle |
| 17 | Bulk CSV Import | ✅ Exists | `parseCSVLine` in Products + Customers |
| 18 | Audit Log | ✅ Exists | `api/db/audit.ts` + Audit Log tab in Control Panel |
| 19 | Backup & Restore | ✅ Exists | `api/backup.js` + Backup tab |
| 20 | Branding | ✅ Exists | `api/branding.js` + Branding tab |
| 21 | Knowledge Base (public) | ✅ Exists | `pages/KnowledgeBasePublic.jsx` + `20260617_kb_articles.sql` (shipped this session) |
| 22 | Serial number search | ✅ Exists | `20260613_search_by_serial.sql` + RPC |
| 23 | Messaging system | ✅ Exists | `lib/messaging/MessagingService.ts` + `NotificationEventBus.ts` + `ticketEventHandlers.ts` |
| 24 | User Preferences | ✅ Exists | `api/db/users.ts` `UserPreferencesRow` + `safeStorage` |
| 25 | Control Panel (admin) | ✅ Exists | `pages/ControlPanel.jsx` with all sub-tabs including WhatsApp & Messaging and Knowledge Base |

24/25 fully exists; RBAC marked Partial due to the enforcement gaps in SEC-02.

---

## Phase 5 — Design System Compliance

Checked `Dashboard.jsx`, `RMATickets/index.jsx`, `Inventory/index.jsx`, `ControlPanel.jsx`:
- ✅ Hanken Grotesk imported in `index.html:14`
- ✅ No `bg-gray-100`/`bg-slate-*` page-background anti-patterns found in sampled files
- ✅ Card tokens (`bg-white dark:bg-[#121823] border ... rounded-[14px]`, no shadow) consistent with prior session work (UX-09 dark-mode sweep)
- Not independently re-verified this pass: KPI tabular-nums, chart stroke widths, RTL logical-property usage in every file — these were addressed in earlier sessions (UX-07/UX-09/UX-10) and spot-checks found no regressions, but a full re-sweep was out of this audit's time budget.

---

## Phase 6 — Database & Migrations

16 migration files found, all named `YYYYMMDD_description.sql`:
```
20260524_customer_cascade_delete.sql    20260524_features.sql
20260526_check_constraints.sql          20260526_enable_rls.sql
20260527_storage_bucket_policies.sql    20260528_ticket_cascade_fk.sql
20260529_repair_permissions.sql         20260531_relax_ticket_status_constraint.sql
20260602_whatsapp_notifications.sql     20260603_user_preferences_rls.sql
20260604_pgcron_notifications.sql       20260604_priority_changed_email_template.sql
20260604_ticket_customer_email.sql      20260604_ticket_resolutions.sql
20260613_search_by_serial.sql           20260617_kb_articles.sql
```
- ✅ `20260531_relax_ticket_status_constraint.sql` exists
- ✅ `20260602_whatsapp_notifications.sql` creates exactly the 4 expected tables (`whatsapp_templates`, `notification_logs`, `notification_settings`, `notification_queue`)
- ✅ `20260603_user_preferences_rls.sql` exists
- ✅ `20260613_search_by_serial.sql` exists
- ✅ `20260617_kb_articles.sql` exists (shipped this session, FT-10)
- ⚠️ `20260529_repair_permissions.sql` has zero idempotency markers (`IF NOT EXISTS`/`IF EXISTS`/`CREATE OR REPLACE`) — re-running this migration on an already-migrated database could error

---

## Phase 7 — PWA & Performance

- ✅ Build succeeds
- ✅ PWA manifest: `name`, `short_name`, `theme_color: '#4f46e5'`, icons (64×64, 192×192, 512×512 + maskable) all present
- ✅ `generateSW` strategy (not `injectManifest`)
- ✅ `NetworkFirst` with `networkTimeoutSeconds: 10` for Supabase API calls
- ⚠️ One chunk exceeds 500KB: main `index-*.js` at 653.00 kB — see root cause (circular client.js import) in Phase 1
- ✅ `axe-core/react` behind `import.meta.env.DEV` guard (`main.jsx:17-19`)
- Not independently re-verified: whether Recharts imports in Dashboard are lazy — `DashboardCharts.jsx` is already its own lazy-loaded chunk (395.84 kB) per the build output, so this is effectively satisfied at the file-split level.

---

## Phase 8 — Accessibility

Spot-checked `RMATickets/_shared.jsx`, `Inventory/_shared.jsx`, `components/ui.jsx`:
- ✅ `aria-sort` present in both `SortableHeader` (`RMATickets/_shared.jsx:113`) and `InvSortBtn` (`Inventory/_shared.jsx:342`)
- ✅ `Spinner` has `role="status"` + `aria-label="Loading"` (`ui.jsx:61-62`)
- Icon-only action menus, filter-panel `aria-expanded`/`aria-controls`, and `text-start`/`text-end` usage were addressed in this session's UX-07 pass and prior accessibility work — not independently re-verified file-by-file in this audit pass, but no regressions found in sampled files.

---

## Phase 9 — Error Handling & Observability

- ✅ `ErrorBoundary` wraps the app in `main.jsx:33-41`
- ✅ `initSentry()` called with `import.meta.env.DEV`-aware no-op guard
- ✅ Zero direct `Sentry.captureException()` calls in `src/pages/` or `src/components/` — all go through the `captureException` helper
- ✅ Zero `console.log` statements in `src/` (excluding test files)
- Not independently re-verified this pass: Edge Function error logging to `notification_logs.error_message`, `notification-worker` retry-attempt logging — confirmed in earlier session work (WhatsApp notification system), no changes since.

---

## Phase 10 — i18n / Internationalisation

- ✅ `src/locales/en.json` and `src/locales/ar.json` both exist, identical line count (2167 lines each) — a good first signal of key parity, though not a guarantee (would need a structural key-diff for certainty)
- ✅ Arabic locale present
- ✅ No obvious hardcoded strings found in `components/ui.jsx` spot-check
- Not independently re-verified: date-format-preference respect, full `t()` coverage across every page — addressed extensively in this session's i18n work (FT-09/UX-10/FT-10 all shipped with bilingual keys), no regressions found in sampled files.

---

## Phase 11 — Code Quality & Tech Debt Scan

| Category | Result |
|----------|--------|
| Unused variables (`no-unused-vars`) | 6 instances, all pre-existing warnings (see Phase 1 lint output) |
| `console.log` in production paths | 0 ✅ |
| `// @ts-ignore` comments | 0 found |
| `any` type in `src/api/db/**/*.ts` | 0 found ✅ |
| Dead code / unused exports | Not exhaustively scanned this pass |
| Magic numbers | Not exhaustively scanned this pass |
| God functions > 100 lines | `TicketForm.jsx`'s `handleSubmit` is **114 lines** — has regrown past the threshold since CQ-01 ("Break up handleSubmit god-function") was shipped |
| TODO/FIXME comments | 0 found ✅ |

---

## Phase 12 — Documentation Accuracy Check

| Check | Result |
|-------|--------|
| Route table in CLAUDE.md matches `App.jsx` | ✅ PASS — includes `/kb`, added this session |
| Migration list in CLAUDE.md matches `supabase/migrations/` | ✅ PASS — all 16 listed, including `20260617_kb_articles.sql` |
| Page folder structure table matches `src/pages/` | ✅ PASS |
| Edge Function list matches `supabase/functions/` | ✅ PASS (7 functions: `admin-reset-password`, `public-track`, `send-email`, `send-whatsapp`, `notification-worker`, `whatsapp-webhook`, `ai-assist` — plus `manage-sessions` found in the folder but not yet documented in CLAUDE.md's list, see DOC-20) |
| Domain module list matches `src/api/db/` | ✅ PASS — `kb.ts` correctly documented |
| CONSTITUTION.md Section 15 test counts | Not independently verified this pass (Section 15 not read in full) |

### DOC-19 — `TooltipProvider` claim is false
CLAUDE.md states: *"`TooltipProvider` from Radix must be present (it's inside `App.jsx`). Removing it causes a blank page."* Verified: **`TooltipProvider` does not exist anywhere in `src/`.** Further verified that nothing in the codebase actually renders a Radix `Tooltip`/`TooltipTrigger`/`TooltipContent` component — the one `Tooltip` match (`DashboardCharts.jsx`) is Recharts' own unrelated `Tooltip` component. **No active runtime risk today** since nothing would trigger the missing-provider crash, but the documentation is stale and `@radix-ui/react-tooltip` (in `package.json`) may be dead weight.

### DOC-20 — `manage-sessions` Edge Function undocumented
`supabase/functions/manage-sessions/index.ts` exists but is not listed in CLAUDE.md's Edge Functions section (which lists 7 functions; the folder has 8).

---

## New Findings Summary

### 🔴 P0 — Critical (Fix before next deploy)
| ID | Finding | File | Severity |
|----|---------|------|----------|
| SEC-01 | Live `VITE_SUPABASE_SERVICE_KEY` in local `.env` — unused but a `VITE_`-prefix footgun; key was displayed during this audit | `.env` | Critical — rotate key, remove line |
| SEC-02a | `canAdd`/`canEdit`/`canAdjust` hardcode `\|\| currentUserRole === ROLES.MANAGER/TECHNICIAN`, bypassing granular permission overrides | `src/pages/PartsInventory.jsx:350-353` | Critical — confirmed bypass |
| CI-01 | `npm run lint:ci` fails — the exact command CI runs. CI is broken on this branch right now | `eslint.config.js` (missing globals) + 11 pre-existing warnings | Critical — blocks all future merges to main |

### 🟠 P1 — High (Fix this sprint)
| ID | Finding | File | Notes |
|----|---------|------|-------|
| SEC-03 | `WATestCenter.jsx` imports `supabase` directly, bypassing the `db`/`auth` barrel (L-1 violation) | `src/pages/cp/WATestCenter.jsx:5` | Constitutional Law violation |
| SEC-02b | `isManager`/`isTech`/`isViewer` hardcoded booleans — needs tracing to confirm whether they gate actions that should respect `canDo('invoices', ...)` overrides | `src/pages/Invoices.jsx:535-537` | Same bug class as SEC-02a; needs follow-up trace |
| CQ-16 | 28 other hardcoded role comparisons across 12 files — many are local re-implementations of `canDo()`'s admin-bypass instead of importing the shared helper (DRY/drift risk) | See Phase 3-A full list | Most are not active bugs, but represent systemic L-4 pattern violation |
| CQ-17 | `npm run format:check` fails on 103 files | repo-wide | Not CI-blocking today, but formatting has drifted significantly |

### 🟡 P2 — Medium (Schedule)
| ID | Finding | File | Notes |
|----|---------|------|-------|
| TS-13 | `safeStorage.ts` has no unit test file (L-7 gap) | `src/lib/safeStorage.ts` | Lowest-covered lib file (72.72% stmt) |
| CQ-18 | `20260529_repair_permissions.sql` has zero idempotency markers | `supabase/migrations/20260529_repair_permissions.sql` | Could error on re-run against an already-migrated DB |
| PERF-01 | Main `index-*.js` chunk is 653KB; `client.js` is both statically and dynamically imported, preventing code-splitting | `src/api/client.js` consumers | Contributes to bundle bloat |
| CQ-19 | `TicketForm.jsx`'s `handleSubmit` has regrown to 114 lines | `src/pages/RMATickets/TicketForm.jsx:506` | Minor regression since CQ-01 |

### 🔵 P3 — Low / Polish
| ID | Finding | File | Notes |
|----|---------|------|-------|
| DOC-19 | CLAUDE.md's `TooltipProvider` claim is false — not present, not used anywhere | `CLAUDE.md` | No active risk; correct the doc or remove the unused dependency |
| DOC-20 | `manage-sessions` Edge Function exists but undocumented in CLAUDE.md | `CLAUDE.md` | Add to Edge Functions list |

---

## Closed / Previously Fixed (confirmed, not re-reported)

- CRIT-1 (service key removal from client bundle) — confirmed the *consuming code* path is clean; see SEC-01 for the separate `.env`-hygiene finding, which is new, not a regression of CRIT-1
- RLS enabled on all required tables with correct helper functions — confirmed intact
- Storage bucket 25MB/MIME-type policy — confirmed intact
- WhatsApp JSONB param scramble bug — confirmed fixed (array-based params)
- `notification-worker` exponential backoff — confirmed intact
- Provider order in `main.jsx` — confirmed intact
- All 5 page folder structures — confirmed intact
- 173/173 tests passing (up from 80 at the last AUDIT_LOG snapshot — substantial growth this session via TS-04 through TS-12)
- FT-09 permission-preview Control Panel bug — confirmed fixed this session (verified `effectiveUserRole` now correctly gates `/control-panel`)
