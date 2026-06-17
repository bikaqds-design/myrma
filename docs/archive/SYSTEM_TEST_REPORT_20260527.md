# myRMA — Full System Test Report
**Date:** 2026-05-27  
**Auditor:** Senior QA / Code Audit pass (automated + static analysis)  
**Prior claimed score:** 10/10  
**Verdict:** Score revised downward — significant regressions found.

---

## Table of Contents
1. [Phase 1 — Automated Test Results](#phase-1--automated-test-results)
2. [Phase 2 — Static Code Analysis](#phase-2--static-code-analysis)
3. [Phase 3 — Feature Coverage Matrix](#phase-3--feature-coverage-matrix)
4. [Phase 4 — Honest Assessment](#phase-4--honest-assessment)
5. [Phase 5 — Fix Plan](#phase-5--fix-plan)

---

## Phase 1 — Automated Test Results

### Unit Tests (`npm test`)
```
Test Files:  3 passed (3)
Tests:       74 passed (74) — 0 failed, 0 skipped
Duration:    ~19s
Result:      ✅ PASS
```

### Coverage (`npm run test:coverage`)
```
File          | Stmts  | Branch | Funcs  | Lines  | Uncovered
schemas.ts    | 84.00% | 71.42% | 83.33% | 85.71% | 104, 132-133
─────────────────────────────────────────────────────────────
All files     | 92.59% | 77.77% | 87.50% | 93.87% |
```
Coverage applies only to `src/lib/` (3 TypeScript files). Branches at 77.77% — schemas.ts has 3 uncovered lines.

### Lint (`npm run lint:ci` — zero-warnings gate)
```
Result:   ❌ FAIL
Errors:   1  (Login.jsx:46 — preserve-caught-error: no `cause` on rethrown Error)
Warnings: 162 (across 41 files — unused vars, React import, ts-ignore, etc.)
Total:    163 problems — CI gate blocks at any warning
```
**CI is broken.** `npm run lint:ci` (`--max-warnings 0`) fails on 162 warnings alone. 

### Prettier (`npm run format:check`)
```
Result:         ❌ FAIL
Files failing:  66 (virtually every source file)
```
**CI is broken.** The `format:check` step fails. No code has been formatted since project inception.

### Build (`npm run build`)
```
Result:   ✅ PASS (builds successfully)
Duration: ~28s
PWA:      generateSW — 42 entries pre-cached (3029 KB)

⚠️  Chunk size warning — 2 chunks exceed 500 KB:
  index-DoiLdlqO.js      643.80 KB  (180.71 KB gzipped)  ← OVER THRESHOLD
  Dashboard-BSm06l-N.js  442.60 KB  (119.26 KB gzipped)  ← near threshold

Notable chunks (gzipped):
  xlsx-CkFp8p6R.js          429.53 KB  (143 KB gzip)   — separate chunk ✅
  jspdf.es.min-*            358.15 KB  (118 KB gzip)    — separate chunk ✅
  html2canvas.esm-*         202.38 KB  ( 48 KB gzip)    — separate chunk ✅
  ControlPanel-Cok7YG2-.js  210.86 KB  ( 42 KB gzip)
  index.es-DgefQ8xA.js      159.64 KB  ( 53 KB gzip)    — vendor libs
  RMATickets-8n-njOeW.js    133.83 KB  ( 35 KB gzip)
```

Root cause of large `index` chunk: React, React Router, TanStack Query, Radix UI, framer-motion all share one vendor chunk. Dashboard's size is driven by statically-imported Recharts (BarChart, LineChart, PieChart all imported at the top of Dashboard.jsx).

---

## Phase 2 — Static Code Analysis

### 2-A. Constitutional Laws (L-01 through L-15)

| Law | Status | Detail |
|-----|--------|--------|
| **L-01** No class components | ⚠️ EXCEPTION | `ErrorBoundary.jsx` extends `React.Component` — necessary because `componentDidCatch` has no hook equivalent. Accepted React exception. |
| **L-02** No direct supabase in pages | ✅ PASS | Zero direct imports of `supabase` in `src/pages/` or `src/App.jsx`. All access via barrel. |
| **L-03** No raw `<button>`/`<input>` re-impl | ❌ FAIL | 15+ raw `<button>` in `AccountSettings.jsx` and `BrandingSettings.jsx`. 10+ raw `<input>` in `BrandingSettings.jsx`. Not using `Button`/`Input` from `ui.jsx`. |
| **L-04** No magic strings | ❌ FAIL | (a) Hardcoded role strings `=== 'admin'`, `=== 'super_admin'` in 7 page files instead of `ROLES.ADMIN`. (b) Status strings `=== 'pending'`, `=== 'draft'`, `=== 'resolved'` in `Reports.jsx`, `Inventory.jsx` instead of `TICKET_STATUS.*`/`BATCH_STATUS.*`. |
| **L-05** CI pipeline correct | ✅ PASS | `.github/workflows/ci.yml` exists — test → lint:ci → build, Node 20. |
| **L-06** No secrets in source | ✅ PASS | Zero matches for `SUPABASE_SERVICE`, `service_role`, `sk_live` in `src/`. |
| **L-07** RLS not disabled | ✅ PASS | Only commented-out examples in migration comments. No live `DISABLE ROW LEVEL SECURITY`. |
| **L-08** Storage bucket policies | ✅ PASS | `20260527_storage_bucket_policies.sql` exists. anon: 25MB max, JPEG/PNG/GIF/WebP/PDF only. |
| **L-09** No window.location for nav | ✅ PASS | `window.history.pushState` appears in 2 permitted locations: `useURLTab.js` (in-page URL state sync) and `RMATickets.jsx:626` (ticket modal URL sync). Both are documented exceptions. |
| **L-10** No forbidden SQL functions | ✅ PASS | No `auth.user_role()` or `auth.is_admin()` found anywhere in `supabase/`. |
| **L-11** ErrorBoundary in main.jsx | ✅ PASS | `<ErrorBoundary>` wraps `<BrowserRouter>` in `main.jsx` at line 25. |
| **L-12** Schema changes as migrations | ✅ PASS | 5 migration files in `supabase/migrations/`, all dated and named correctly. |
| **L-13** Service role key not in src/ | ✅ PASS | Zero matches. Key only in Edge Function environment (auto-injected by Supabase). |
| **L-14** Optimistic rollback on mutations | ✅ PASS | `RMATickets.jsx:531` rolls back on error. `Customers.jsx:301` and `:350` roll back. |
| **L-15** No unapproved deps | ⚠️ WARN | Two toast libraries present: `react-hot-toast` AND `sonner`. Duplication — one should be canonical. All other deps appear intentional. |

**Laws: 10 PASS / 3 FAIL / 2 WARN**

### 2-B. Data Layer Integrity

| Check | Result |
|-------|--------|
| Barrel re-exports (7 exports) | ✅ PASS — `auth`, `db`, `storage`, `branding`, `notifications`, `backup`, `supabase` |
| All 8 domain modules exist | ✅ PASS — `tickets`, `customers`, `catalog`, `inventory`, `users`, `notifications`, `system`, `audit` |
| `42P01` guards on optional tables | ✅ PASS — verified in `notifications.js`, `system.js` (4 guards each) |
| `rmaTracker` uses Edge Function | ✅ PASS — `supabase.functions.invoke('public-track', ...)` at tickets.js:92, 102, 110 |
| Direct supabase in pages/components | ✅ PASS — zero violations |

### 2-C. Auth & Routing

| Check | Result |
|-------|--------|
| Provider order in `main.jsx` | ✅ PASS — `StrictMode > ErrorBoundary > BrowserRouter > QueryClientProvider > AppearanceProvider > App` |
| All 16 routes present | ✅ PASS — all 15 declared paths + `*` catch-all found in App.jsx |
| `/tracker` has no auth check | ✅ PASS — `if (pathname === '/tracker')` returns early at App.jsx:382 |
| All other routes guard with auth | ✅ PASS — session check runs before route rendering |
| `NotFoundPage` catch-all | ✅ PASS — `<Route path="*" element={<NotFoundPage />} />` at App.jsx:771 |
| Thin wrapper components | ✅ PASS — `ProductDetailsRoute`, `CustomerDetailsRoute` call `useParams()` |
| `useNavigate` for navigation | ✅ PASS — no `window.location.href` top-level navigation found |
| `/control-panel` admin guard | ⚠️ PARTIAL — sidebar hides the link for non-admin roles but the Route itself at App.jsx:730 has no redirect guard — a non-admin who navigates directly to `/control-panel` by URL will see the page. |

### 2-D. Permissions System

| Check | Result |
|-------|--------|
| `canDo()` exported from `permissions.ts` | ✅ PASS |
| `ROLE_DEFAULT_PERMISSIONS` covers `manager`, `technician`, `viewer` | ✅ PASS — all 3 roles defined with granular section-level permissions |
| `super_admin`/`admin` bypass | ✅ PASS — bypass implemented in `canDo()` |
| Hardcoded role strings bypassing `canDo()` | ❌ FAIL — `currentUserRole === 'admin'` found in `AccountSettings.jsx:80`, `CustomerDetails.jsx:28`, `Customers.jsx:87`, `Invoices.jsx:481`, `PartsInventory.jsx:161,166`, `Products.jsx:90`, `Reports.jsx:570,574,575`, `RMATickets.jsx:227,1379` |

**Note:** These hardcoded checks are often paired alongside `canDo()` or are guard-shortcuts, but they still violate L-04 by not using `ROLES.ADMIN` constant and not going through `canDo()`.

### 2-E. Constants & Magic Strings

All required exports exist in `src/lib/constants.ts`:  
`ROLES` ✅ `TICKET_STATUS` ✅ `PRIORITY` ✅ `INVENTORY_STATUS` ✅ `NOTIF_TYPE` ✅ `AUTOMATION_ACTION` ✅ `CONFIG_KEY` — not confirmed present | `STORAGE_KEY` — not confirmed present

**Magic string violations found:**
- `Reports.jsx:481` — `i.status === 'pending' || i.status === 'overdue'` (invoice statuses — no constant defined)
- `Inventory.jsx:2117` — `b.status==='draft'`, `b.status==='sent'`, `b.status==='resolved'` (should use `BATCH_STATUS.*`)
- `DataCleanup.jsx:130` — `handleDeleteTickets(staleCancelled, 'cancelled')` raw string passed

**Bonus finding:** `PRODUCT_STATUS` is defined in `constants.ts` but flagged as never used by ESLint.

### 2-F. Zod Schemas & Form Validation

| Check | Result |
|-------|--------|
| ≥ 8 Zod schemas | ✅ PASS — `loginSchema`, `forgotPasswordSchema`, `changePasswordSchema`, `customerSchema`, and more |
| `Login.jsx` uses react-hook-form + zodResolver | ✅ PASS |
| `Customers.jsx` uses `safeParse` before writes | ✅ PASS |

**schemas.ts coverage gap:** Lines 104 and 132-133 uncovered. Branch coverage 71.42% — some validation paths untested.

### 2-G. TanStack Query Usage

| Check | Result |
|-------|--------|
| `Dashboard.jsx` uses `useQuery` | ✅ PASS — `useQuery` at lines 110, 115 |
| `RMATickets.jsx` uses `useQuery` | ✅ PASS — `useQuery` at lines 67, 72, 77, 82, 87 |
| `Customers.jsx` uses `useQuery` | ✅ PASS — `useQuery` at lines 35, 40, 45 |
| No `useEffect` + `setState` data fetching | ✅ PASS in these 3 pages |
| `refetchOnWindowFocus: false` in QueryClient | ❌ MISSING — `main.jsx` QueryClient config has `staleTime` and `retry` but NOT `refetchOnWindowFocus: false`. CLAUDE.md says it should be set. |

### 2-H. Optimistic Updates

| Check | Result |
|-------|--------|
| `RMATickets.jsx` optimistic delete | ✅ PASS — `setQueryData` at :517, rollback at :531 |
| `Customers.jsx` optimistic delete | ✅ PASS — `setQueryData` at :335, rollback at :350 |
| `Customers.jsx` optimistic edit | ✅ PASS — `setQueryData` at :262, rollback at :301 |

### 2-I. Performance & Bundle

| Check | Result |
|-------|--------|
| Any chunk > 500 KB | ❌ FAIL — `index-DoiLdlqO.js` is **643.80 KB** (180 KB gzipped) |
| Dashboard chunk | ⚠️ WARN — 442 KB (119 KB gzipped) — recharts statically imported at Dashboard.jsx:7 |
| `xlsx` dynamic import | ✅ PASS — builds as separate chunk (429 KB) |
| `jspdf` dynamic import | ✅ PASS — dynamic `await import('jspdf')` in Inventory.jsx:1549 |
| `html2canvas` | ✅ PASS — builds as separate chunk (202 KB), not in main bundle |
| `@tanstack/react-virtual` in use | ✅ PASS — `useVirtualizer` in RMATickets.jsx customer dropdown |

### 2-J. PWA & Service Worker

| Check | Result |
|-------|--------|
| `generateSW` strategy | ✅ PASS |
| `NetworkFirst` for Supabase API | ✅ PASS — `urlPattern: /^https:\/\/.*\.supabase\.co\/.*/i` with 10s timeout |
| Icons in manifest | ✅ PASS — 4 sizes: 64×64, 192×192, 512×512, maskable 512×512 |
| `devOptions.enabled: false` | ✅ PASS |
| Pre-cached assets | ✅ PASS — 42 entries, 3029 KB |

### 2-K. Sentry & Error Tracking

| Check | Result |
|-------|--------|
| `initSentry()` no-op guard | ✅ PASS — skips if `VITE_SENTRY_DSN` not set; `enabled: PROD` flag prevents dev traffic |
| `ErrorBoundary.componentDidCatch` calls `captureException` | ✅ PASS — `captureException(error, { componentStack })` at ErrorBoundary.jsx:17 |
| No direct `Sentry.captureException()` in page components | ✅ PASS — pages import `captureException` from `../lib/sentry.js` |
| `captureException` no-ops in dev | ✅ PASS — falls back to `console.error` in DEV mode |

### 2-L. Edge Functions

| Check | Result |
|-------|--------|
| `admin-reset-password` JWT validation | ✅ PASS — `Authorization` header checked; `getUser()` called at lines 24-41 |
| `admin-reset-password` create-if-missing path | ✅ PASS — fixed 2026-05-27 |
| `public-track` rate limiting | ✅ PASS — 15 req/min per-IP in-memory token bucket |
| `public-track` whitelisted columns | ✅ PASS — whitelist in Edge Function, no raw `*` select |
| `send-email` JWT validation | Assumed present — not re-read this pass |
| Service role key not exposed in responses | ✅ PASS |

### 2-M. Dark Mode

**Dark mode architecture finding — IMPORTANT:**  
The app does NOT use Tailwind `dark:` prefix classes on page components. Instead, it uses a global CSS override file `src/styles/appearance.css` that applies `html.dark .bg-white { background-color: #1e293b !important; }` and similar rules for all standard Tailwind color classes.

This means:
- `dark:` class count across ALL pages: **23** (very low — mostly in `Dashboard.jsx` and `UserManagement.jsx`)
- Pages with **zero** `dark:` classes: `AccountSettings`, `Inventory`, `Invoices`, `Reports`, `TechCalendar`, `PartsInventory`, `BackupRestore`, `Products`, `Customers`, `RMATickets`, `ControlPanel`, `CustomerDetails`, `ProductDetails`, `Login`, `RMATracker`, `BrandingSettings` (16 of 19 page files)

**Verdict:** Dark mode works via CSS overrides for standard Tailwind colors. This deviates from Constitution §4.4 ("Every component MUST support dark mode using Tailwind's `dark:` prefix") but is functional for standard colors. Risk: 49 inline `style={{}}` usages and custom non-standard colors will NOT be overridden by `appearance.css`, causing light-mode leakage in dark mode.

### 2-N. Accessibility

| Check | Result |
|-------|--------|
| Total aria-label/role attributes | ⚠️ LOW — only **20** across all pages + components |
| Modal focus traps | ✅ PASS — Radix UI `@radix-ui/react-dialog` provides built-in focus trap |
| Sidebar `inert` when closed on mobile | ✅ PASS — `App.jsx:567` applies `inert=""` to main content when sidebar open |
| Icon-only buttons with `aria-label` | ⚠️ WARN — only verified in limited grep; most IconButton usages lack aria-label |

20 aria-labels for an app this size (19 pages, hundreds of interactive elements) is critically low. Many icon-only action buttons (edit, delete, filter icons) are presumably not labelled.

### 2-O. Notifications

| Check | Result |
|-------|--------|
| Single Realtime channel | ✅ PASS — `supabase.channel('app_notifications')` at App.jsx:214 |
| No client-side row filtering | ✅ PASS — RLS policy `user_read_targeted` handles it server-side |
| Toast on notification INSERT | ✅ PASS — preference check + toast in App.jsx |
| Per-user notification preferences | ✅ PASS — localStorage + `db.userPreferences` |

### 2-P. RLS Migrations

| Check | Result |
|-------|--------|
| Tables with RLS enabled | ✅ PASS — 13 `ENABLE ROW LEVEL SECURITY` statements in `20260526_enable_rls.sql` |
| Total policies | ✅ PASS — 80 `CREATE POLICY`/`DROP POLICY` statements |
| Helper functions defined | ✅ PASS — `public.rma_user_role()`, `public.rma_is_admin()`, etc. |
| Check constraints | ✅ PASS — `20260526_check_constraints.sql` applies constraints |

**Note:** 13 tables with RLS enabled. AUDIT_LOG states "28 tables" — discrepancy not investigated further; may reflect optional tables enabled only in some deployments.

### 2-Q. UI Component Library Compliance

| Check | Result |
|-------|--------|
| Raw `<button>` in pages | ❌ FAIL — `AccountSettings.jsx`: 6 instances; `BrandingSettings.jsx`: 10+ instances; `DataCleanup.jsx:130`: 1 instance |
| Raw `<input>` in pages | ❌ FAIL — `AccountSettings.jsx:345` (hidden file input — acceptable exception); `BrandingSettings.jsx`: 8+ raw inputs including text fields, color pickers that should use `Input` from ui.jsx |

### 2-R. CSS & Styling

| Check | Result |
|-------|--------|
| Inline `style={{}}` usage | ❌ FAIL — **49 instances** in pages + components. Constitution says zero. |
| Arbitrary Tailwind values `[...]` | ⚠️ WARN — 10+ found (`max-h-[600px]`, `max-h-[70vh]`, `text-[10px]`, `min-w-[180px]`, etc.) — mostly for viewport-relative heights which have no standard Tailwind equivalent |

### 2-S. console.log in Production Code

| Check | Result |
|-------|--------|
| `console.log/warn/error` in src/ | ❌ FAIL — **52 instances** across `BackupRestore.jsx`, `BrandingSettings.jsx`, `CustomerDetails.jsx`, and many others |

All instances are `console.error` calls in catch blocks — they are not debug `console.log` statements, but they still violate Constitution §14 ("zero `console.log` in production") and leak error details to the browser console in production.

---

## Phase 3 — Feature Coverage Matrix

### Core CRUD

| Feature | Create | Read | Update | Delete | Bulk |
|---------|--------|------|--------|--------|------|
| RMA Tickets | ✅ | ✅ | ✅ | ✅ (+ bulk) | N/A |
| Customers | ✅ | ✅ | ✅ (optimistic) | ✅ (optimistic) | ✅ CSV import |
| Products/Catalog | ✅ | ✅ | ✅ | ✅ | ✅ CSV import |
| Inventory | ✅ | ✅ | ✅ (RPC `adjust_part_quantity`) | ✅ | N/A |
| Parts Inventory | ✅ | ✅ | ✅ | ✅ | N/A |
| Invoices | ✅ | ✅ | ✅ | ✅ | N/A |

### Pages Checklist

All expected page files present: ✅  
```
AccountSettings.jsx  ✅      BackupRestore.jsx   ✅
BrandingSettings.jsx ✅      ControlPanel.jsx    ✅
CustomerDetails.jsx  ✅      Customers.jsx       ✅
Dashboard.jsx        ✅      Inventory.jsx       ✅
Invoices.jsx         ✅      Login.jsx           ✅
PartsInventory.jsx   ✅      ProductDetails.jsx  ✅
Products.jsx         ✅      RMATickets.jsx      ✅
RMATracker.jsx       ✅      Reports.jsx         ✅
ResetPassword.jsx    ✅      TechCalendar.jsx    ✅
UserManagement.jsx   ✅

cp/Announcements.jsx ✅      cp/AuditLog.jsx     ✅
cp/CustomFields.jsx  ✅      cp/DataCleanup.jsx  ✅
cp/Integrations.jsx  ✅      cp/PDFLayout.jsx    ✅
cp/RMAConfig.jsx     ✅
```
**Missing from routes:** `NotFoundPage` is defined inline in `App.jsx` rather than as its own file — functional but inconsistent with the file naming convention.

### Control Panel Sub-Features

All 10 sub-features present: ✅  
`users`, `appearance`, `email`, `backup`, `announcements`, `audit`, `rmaconfig`, `cleanup`, `integrations`, `customfields` — all imported and rendered in `ControlPanel.jsx`.

**Finding:** Control Panel route has NO role guard at the route level — only the sidebar link is hidden. Direct URL navigation to `/control-panel` by a non-admin role is not blocked. The constitution says `/control-panel` requires `admin+` auth.

### Role-Based Access Matrix

| Check | Result |
|-------|--------|
| `/control-panel` sidebar hidden for non-admin | ✅ PASS — `App.jsx:523` conditionally renders link |
| `/control-panel` route guard | ❌ FAIL — no redirect in the `<Route>` element for non-admin users |
| Pages use `canDo()` for section gating | ✅ PARTIAL — `RMATickets.jsx`, `Customers.jsx`, `Products.jsx` use `canDo()` for many actions, but many pages use hardcoded role string checks |

### Notification System

✅ PASS — `send-email` called via `db.notifications` (`email.js`), not directly.

### Public Tracker (Unauthenticated)

✅ PASS — `rmaTracker.getTicketByRmaNumber()` invokes `public-track` Edge Function, not direct DB.  
✅ PASS — `/tracker` auth bypass via `pathname === '/tracker'` check in App.jsx.

### CSV Bulk Import

✅ PASS — Both `Products.jsx:376` and `Customers.jsx:392` define a `parseCSVLine` helper that handles quoted fields (not plain `split(',')`).

### PDF Generation

⚠️ PARTIAL — `jsPDF` is dynamically imported in `Inventory.jsx:1549` (`await import('jspdf')`). However there is no dynamic import found in `Invoices.jsx` — the `Invoices` page is 25.98 KB and jsPDF builds as a static separate chunk (358 KB), suggesting it may be imported at module level in a shared utility rather than lazily in `Invoices.jsx`. Requires deeper investigation.

### Backup & Restore

✅ PASS — `backup.js:4` defines `EMAIL_SETTINGS_SECRET_FIELDS = ['api_key', 'smtp_password', ...]` and `redactEmailSettings()` strips secrets from export.

### Webhook Security (H-7)

✅ PASS — `system.js:115-127` implements HMAC-SHA256 signature via `crypto.subtle.sign`. Header `X-Signature-256` sent with `sha256=<hex>`.

### Atomic Parts Quantity (H-3)

✅ PASS — `inventory.js:156` calls `supabase.rpc('adjust_part_quantity', { p_id, p_delta })` — no read-modify-write race condition.

### Image Resize Before Upload (P-3)

✅ PASS — `storage.js:2` imports `resizeImage`; called before upload in 5 helpers (attachments, avatars, logos, favicons).

---

## Phase 4 — Honest Assessment

### 4-A. Test Results Summary

```
npm test:              74 passed / 0 failed / 0 skipped   ✅
npm run test:coverage: 92.59% stmts / 77.77% branches    ✅ (lib only)
npm run lint:ci:       1 error + 162 warnings = FAIL      ❌
npm run format:check:  66 files failing                   ❌
npm run build:         PASS (1 chunk size warning)        ⚠️
```

### 4-B. Laws Compliance Table

| Law | Result | File:Line |
|-----|--------|-----------|
| L-01 No class components | ⚠️ EXCEPTION | `ErrorBoundary.jsx:4` — necessary, accepted |
| L-02 No direct supabase in pages | ✅ PASS | — |
| L-03 No raw button/input re-impl | ❌ FAIL | `AccountSettings.jsx:414,430,519,522,565,568` · `BrandingSettings.jsx:293,299,305,311,476,527,534,675` |
| L-04 No magic strings | ❌ FAIL | `AccountSettings.jsx:80` · `Customers.jsx:87` · `RMATickets.jsx:227` · `Reports.jsx:481,570,574` · `Inventory.jsx:2117` · 5 more |
| L-05 CI pipeline correct | ✅ PASS | — |
| L-06 No secrets in source | ✅ PASS | — |
| L-07 RLS not disabled | ✅ PASS | — |
| L-08 Storage bucket policies | ✅ PASS | — |
| L-09 No window.location nav | ✅ PASS | `useURLTab.js:20`, `RMATickets.jsx:626` both permitted |
| L-10 No forbidden SQL functions | ✅ PASS | — |
| L-11 ErrorBoundary in main.jsx | ✅ PASS | `main.jsx:25` |
| L-12 Schema changes as migrations | ✅ PASS | — |
| L-13 Service role not in src/ | ✅ PASS | — |
| L-14 Optimistic rollback | ✅ PASS | `RMATickets.jsx:531`, `Customers.jsx:301,350` |
| L-15 No unapproved deps | ⚠️ WARN | Two toast libraries: `react-hot-toast` + `sonner` |

### 4-C. Feature Coverage Table

| Feature | Status |
|---------|--------|
| RMA Ticket CRUD (full) | ✅ VERIFIED |
| Customer CRUD + CSV | ✅ VERIFIED |
| Product CRUD + CSV | ✅ VERIFIED |
| Inventory CRUD (atomic RPC) | ✅ VERIFIED |
| Parts Inventory CRUD | ✅ VERIFIED |
| Invoices CRUD | ✅ VERIFIED |
| Dashboard (TanStack Query) | ✅ VERIFIED |
| All 16 Routes | ✅ VERIFIED |
| Control Panel (10 sub-features) | ✅ VERIFIED |
| `/control-panel` route auth guard | ❌ MISSING — no server-side or client-side redirect for non-admin direct URL |
| Public Tracker (Edge Function) | ✅ VERIFIED |
| CSV Bulk Import (quoted fields) | ✅ VERIFIED |
| PDF generation (dynamic import) | ⚠️ PARTIAL — dynamic in Inventory, uncertain for Invoices |
| Backup with secret redaction (H-6) | ✅ VERIFIED |
| HMAC webhooks (H-7) | ✅ VERIFIED |
| Atomic parts quantity (H-3) | ✅ VERIFIED |
| Image resize before upload (P-3) | ✅ VERIFIED |
| Optimistic updates + rollback | ✅ VERIFIED |
| Realtime notifications | ✅ VERIFIED |
| Dark mode (CSS override approach) | ✅ VERIFIED (deviates from spec but works) |
| PWA + service worker | ✅ VERIFIED |
| Sentry error tracking | ✅ VERIFIED |

### 4-D. Findings

```
[CRITICAL] CRIT-NEW-1: CI pipeline is broken — cannot deploy
Files: Login.jsx:46, all 66 Prettier-unformatted files
Description: npm run lint:ci fails on 1 error + 162 warnings (max-warnings 0).
             npm run format:check fails on 66 files. Both are CI gates.
Impact: No PR can pass CI. Automated deployment is blocked.

[HIGH] HIGH-NEW-1: Main vendor bundle exceeds 500 KB threshold
File: dist/assets/index-DoiLdlqO.js (643.80 KB, 180 KB gzipped)
Description: React + React Router + TanStack Query + Radix + Framer Motion all
             land in the same vendor chunk with no manual splitting.
Impact: Slower initial page load, especially on mobile/slow connections.
        Fails build.rollupOptions chunk size recommendation.

[HIGH] HIGH-NEW-2: Dashboard chunk 442 KB — Recharts statically imported
File: src/pages/Dashboard.jsx:7
Description: `import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell } from 'recharts'`
             is a static top-level import. Recharts (~250 KB) lands in the
             Dashboard chunk rather than being lazy-loaded.
Impact: All users pay the Recharts cost on first visit, even non-dashboard pages.

[HIGH] HIGH-NEW-3: /control-panel route has no auth guard at route level
File: src/App.jsx:730
Description: The sidebar link is hidden for non-admin users but the <Route>
             element has no redirect. A viewer/technician who navigates to
             /control-panel directly via URL will see the admin panel.
Impact: Privilege escalation via direct URL — admin tools accessible to all roles.

[HIGH] HIGH-NEW-4: 162 ESLint warnings — code quality signal degraded
Files: 41 files (App.jsx, RMATickets.jsx, Dashboard.jsx, BrandingSettings.jsx, …)
Description: Primary categories: 55x "Error(...)" unused-vars pattern,
             32x 'React' is defined but never used, 13x React display name.
             No single file has been cleaned up.
Impact: ESLint noise drowns signal. CI blocked. New bugs harder to spot.

[MEDIUM] MED-NEW-1: 52 console.error/warn/log in production code
Files: BackupRestore.jsx, BrandingSettings.jsx, CustomerDetails.jsx, + others
Description: All are console.error in catch blocks, not debug console.logs.
             Constitution §14 requires zero console.* in production.
Impact: Leaks internal error structure to browser console in production.
        User-visible in DevTools, potential information disclosure.

[MEDIUM] MED-NEW-2: L-04 violation — hardcoded role strings in 7+ pages
Files: AccountSettings.jsx:80, CustomerDetails.jsx:28, Customers.jsx:87,
       Invoices.jsx:481,483, PartsInventory.jsx:161,166, Products.jsx:90,
       Reports.jsx:570,574,575, RMATickets.jsx:227,1379
Description: `currentUserRole === 'admin'` instead of `currentUserRole === ROLES.ADMIN`.
             If role strings ever change, these break silently.
Impact: Fragile — not refactor-safe. Bypasses the centralized constant.

[MEDIUM] MED-NEW-3: L-03 violation — raw <button> and <input> in pages
Files: AccountSettings.jsx (6 raw buttons), BrandingSettings.jsx (10+ raw buttons + 8 raw inputs)
Description: Native HTML elements styled with raw Tailwind classes instead of
             using Button/Input from src/components/ui.jsx.
Impact: Inconsistent styling, missing dark mode override coverage for custom styles,
        violates Constitution L-03 and §3.1.

[MEDIUM] MED-NEW-4: 49 inline style={{}} in page components
Files: Throughout pages/ and components/ (49 total)
Description: Constitution §4.6 forbids inline styles. These bypass dark mode
             CSS overrides in appearance.css and Tailwind's utility system.
Impact: Dark mode leakage on any element with custom inline colors.
        Inconsistent theming, harder to maintain.

[MEDIUM] MED-NEW-5: Dark mode deviates from Constitution §4.4
Description: Dark mode uses CSS !important overrides in src/styles/appearance.css
             rather than Tailwind dark: prefix classes. Only 23 dark: classes
             across entire app; 16 of 19 pages have zero dark: classes.
Impact: Works for standard Tailwind colors but fragile — inline styles, custom
        colors, and future additions won't be covered unless manually added
        to appearance.css. Architectural drift from Constitution spec.

[MEDIUM] MED-NEW-6: refetchOnWindowFocus not set in QueryClient
File: src/main.jsx:15
Description: QueryClient config has staleTime and retry but is missing
             `refetchOnWindowFocus: false`. CLAUDE.md specifies this must be false.
Impact: Users switching back to the browser tab trigger background refetches,
        causing unexpected loading states and wasted network requests.

[MEDIUM] MED-NEW-7: Magic status strings in Inventory.jsx and Reports.jsx
Files: Inventory.jsx:2117 (b.status==='draft','sent','resolved')
       Reports.jsx:481 (i.status==='pending','overdue')
Description: BATCH_STATUS.* and invoice status constants not used.
             Invoice statuses have no defined constant at all.
Impact: Fragile comparisons, refactoring risk, L-04 violation.

[LOW] LOW-NEW-1: Two toast libraries in production bundle
File: package.json
Description: Both react-hot-toast and sonner are installed. One should be
             removed and usage consolidated.
Impact: ~15 KB of duplicate library code in the bundle. Inconsistent toast UX.

[LOW] LOW-NEW-2: PRODUCT_STATUS constant defined but never used
File: src/lib/constants.ts:16 (approx)
Description: ESLint no-unused-vars flag on PRODUCT_STATUS export.
Impact: Dead code; confusing for future developers.

[LOW] LOW-NEW-3: NotFoundPage defined inline in App.jsx instead of own file
File: src/App.jsx:31-46
Description: `NotFoundPage` function is defined inside App.jsx rather than
             as src/pages/NotFoundPage.jsx per the folder structure convention.
Impact: Minor — inconsistency with the project structure convention.

[LOW] LOW-NEW-4: Invoices.jsx PDF generation not confirmed as dynamic import
File: src/pages/Invoices.jsx
Description: jsPDF dynamic import verified in Inventory.jsx but not found in
             Invoices.jsx. The Invoices chunk is 25 KB (likely doesn't include
             jsPDF directly) but path from Invoices to PDF generation unclear.
Impact: If statically imported transitively, adds ~118 KB to Invoices chunk.
```

### 4-E. Honest Scorecard

| Domain | Previous | Now | Verdict |
|--------|----------|-----|---------|
| Security | 9/10 | **8/10** | Strong RLS, HMAC webhooks, JWT guards. Minor: 52 console.errors leak internals; /control-panel route unguarded. |
| Architecture | 10/10 | **7/10** | Barrel pattern solid, React Router good, data layer clean. Hurt by: two toast libs, main chunk 643 KB, hardcoded role strings, no /control-panel route guard. |
| Performance | 8/10 | **6/10** | Main chunk exceeds 500 KB threshold. Dashboard 442 KB from static Recharts import. virtualization, dynamic jsPDF, resizeImage all good. |
| Accessibility | 8/10 | **4/10** | Only 20 aria-labels across entire app. Radix modals save the focus-trap story. Sidebar inert ✅. But icon-only buttons are almost all unlabelled. |
| UX polish | 8/10 | **7/10** | Optimistic updates, loading states, error states all present. Hurt by raw buttons, inline styles, 52 console.errors visible to developers in DevTools. |
| Dark mode | 8/10 | **6/10** | Works via CSS override approach but deviates from constitution spec. 49 inline styles bypass overrides. Not all edge cases covered. |
| Code quality | 9/10 | **4/10** | 1 ESLint error, 162 warnings, 66 files failing Prettier. 52 console.logs. 49 inline styles. Magic strings throughout. CI is broken. |
| Notifications | 8/10 | **8/10** | Single channel, RLS server-side filtering, preference controls, toast on insert. No regression. |
| Mobile | 8/10 | **6/10** | Sidebar inert + collapse present. Horizontal table scroll present in most tables. 49 inline styles create layout risks. min-w-[180px] arbitrary values. |
| Scalability | 8/10 | **7/10** | TanStack Query caching good. Pagination in key lists. Virtualization for customer dropdown. Main chunk size a scalability concern. |
| Maintainability | 9/10 | **5/10** | 162 ESLint warnings create noise that hides real bugs. Hardcoded role strings in 7+ files. Console.errors everywhere. Good: barrel API, TypeScript lib layer, 74 unit tests. |
| Production readiness | 9/10 | **5/10** | CI is broken — lint:ci and format:check both fail. Cannot merge a PR through CI right now. Build succeeds but with size warnings. |
| **Overall** | **10/10** | **6/10** | |

**Summary:** The system has strong foundations — security (RLS, Edge Functions, HMAC), data layer architecture (barrel pattern, TanStack Query, optimistic updates), and feature completeness are all solid. However, the codebase has accumulated significant code quality debt: CI is broken, ESLint has 163 problems, Prettier has never been run across the codebase (66 files), and accessibility (20 aria-labels across 19 pages) is critically low. The previous 10/10 was awarded for architectural correctness, not code hygiene. Honest current score: **6/10**.

---

## Phase 5 — Fix Plan

### 🔴 Immediate — Fix before next deploy (CI is blocked)

| ID | Fix | Files | Effort |
|----|-----|-------|--------|
| CRIT-NEW-1a | Fix Login.jsx ESLint error: wrap rethrown Error with `{ cause: err }` | `Login.jsx:46` | 5 min |
| CRIT-NEW-1b | Run `npm run format` to fix all 66 Prettier violations | all 66 files | 10 min |
| CRIT-NEW-1c | Suppress or fix the top ESLint warnings to get below 0 for CI: add `/* eslint-disable */` on legit unused vars, fix React display name warnings | top 41 files | 2–4 hours |
| HIGH-NEW-3 | Add route-level guard for `/control-panel`: redirect non-admin to `/` | `App.jsx:730` | 15 min |

### 🟠 High Priority — Fix this sprint

| ID | Fix | Files | Effort |
|----|-----|-------|--------|
| HIGH-NEW-1 | Split vendor chunk via `build.rollupOptions.output.manualChunks` — separate React, Radix, framer-motion into distinct chunks | `vite.config.js` | 1 hour |
| HIGH-NEW-2 | Lazy-load Recharts in Dashboard: `const { BarChart, ... } = await import('recharts')` inside a wrapper component | `Dashboard.jsx:7` | 45 min |
| MED-NEW-6 | Add `refetchOnWindowFocus: false` to QueryClient defaultOptions | `main.jsx:18` | 2 min |
| LOW-NEW-1 | Remove duplicate toast library — audit which is actually used and uninstall the other | `package.json` | 30 min |

### 🟡 Medium Priority — Fix next sprint

| ID | Fix | Files | Effort |
|----|-----|-------|--------|
| MED-NEW-2 | Replace all `=== 'admin'` with `=== ROLES.ADMIN` (and `ROLES.SUPER_ADMIN` etc.) across 7 pages | 7 page files | 1 hour |
| MED-NEW-3 | Replace raw `<button>` with `<Button variant="...">` from ui.jsx in AccountSettings + BrandingSettings | `AccountSettings.jsx`, `BrandingSettings.jsx` | 2 hours |
| MED-NEW-4 | Audit 49 inline `style={{}}` — convert fixed pixel sizes to Tailwind equivalents, replace color values with Tailwind color classes | throughout | 3 hours |
| MED-NEW-7 | Create `INVOICE_STATUS` constant in `constants.ts`; replace magic strings in `Reports.jsx` and `Inventory.jsx` | `constants.ts`, `Reports.jsx:481`, `Inventory.jsx:2117` | 30 min |
| MED-NEW-1 | Replace `console.error` in catch blocks with `captureException` from `src/lib/sentry.js` — all 52 instances | `BackupRestore.jsx`, `BrandingSettings.jsx`, `CustomerDetails.jsx`, + 8 more | 2 hours |

### 🟢 Low Priority / Backlog

| ID | Fix | Files | Effort |
|----|-----|-------|--------|
| MED-NEW-5 | Document dark mode architecture decision in CONSTITUTION.md §4.4 to reflect the CSS-override approach; OR incrementally add `dark:` prefix classes page-by-page | `CONSTITUTION.md` or all pages | 30 min doc / 8+ hours code |
| LOW-NEW-2 | Remove `PRODUCT_STATUS` constant or start using it | `constants.ts` | 10 min |
| LOW-NEW-3 | Extract `NotFoundPage` to `src/pages/NotFoundPage.jsx` | `App.jsx`, new file | 15 min |
| LOW-NEW-4 | Confirm/fix PDF generation in Invoices.jsx — add `await import('jspdf')` if missing | `Invoices.jsx` | 30 min |
| — | Accessibility pass: add `aria-label` to all icon-only buttons, form landmarks, live regions | all pages | 4–8 hours |

---

*Report generated: 2026-05-27 | Auditor: Claude Sonnet 4.6*
