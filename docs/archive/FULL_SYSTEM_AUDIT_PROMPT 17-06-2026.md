# myRMA — Full System Audit & Review Prompt
**For:** Claude Code (claude.ai/code)  
**Output file:** `SYSTEM_AUDIT_REPORT_<YYYYMMDD>.md` (use today's date)  
**Follow-up:** Run a SpecKit fix plan after the audit completes  

---

## 🧠 Before You Start — Read These Files

Read all of the following before writing a single line of the report. These are your ground truth:

```
CLAUDE.md          ← architecture rules, data layer, component library, routing, migrations
CONSTITUTION.md    ← 18-section engineering law (LAW / MUST / SHOULD levels)
AUDIT_LOG.md       ← full history of past findings and fixes (do not re-report fixed items)
IMPROVEMENT_PLAN.md ← current open/in-progress items — do not duplicate these
DESIGN.md          ← Design System "Command" — colors, typography, dark mode, RTL rules
```

Also read any relevant Skill files if they apply to a section you are testing (e.g. a test-guard skill for test coverage analysis, a clean-code-guard skill for code quality, a docs-guard skill for documentation accuracy).

---

## 📋 Audit Scope

Run every phase below **in order**. Do not skip a phase. Do not stop on first failure — collect all findings, then report.

---

## Phase 0 — Environment & Toolchain Verification

```bash
node --version          # must be >= 20
npm --version           # must be >= 10
cat package.json        # confirm React 18, Vite 6, dependencies
cat .npmrc              # confirm legacy-peer-deps
cat .env.example        # confirm VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
```

Verify the following exist and are non-empty:
- `vite.config.js` — Vite + PWA config
- `.github/workflows/ci.yml` — CI pipeline (test → lint:ci → build)
- `tailwind.config.js` — Tailwind config (check `darkMode: 'class'`, font family)
- `eslint.config.js` (or `eslint.config.mjs`) — ESLint flat config
- `.prettierrc` or Prettier config block in `package.json`

---

## Phase 1 — Automated Test Suite

Run each command and record the **exact terminal output** (pass/fail counts, errors, warnings):

```bash
npm test
npm run test:coverage
npm run lint:ci
npm run format:check
npm run build
```

For `npm run build`, record:
- ✅ / ❌ build result
- All chunk sizes (flag any > 500 KB)
- PWA pre-cache entry count
- Any TypeScript / Vite warnings

---

## Phase 2 — Security Audit

### 2-A. Supabase Secrets & Keys
- [ ] Confirm `VITE_SUPABASE_SERVICE_KEY` does NOT exist anywhere in `src/` or `.env`
- [ ] Confirm the service role key is only referenced inside `supabase/functions/`
- [ ] Confirm all Edge Functions (`admin-reset-password`, `public-track`, `send-email`, `send-whatsapp`, `notification-worker`, `whatsapp-webhook`) validate the caller's JWT before privileged operations
- [ ] Confirm `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` are NOT in any client-side file

### 2-B. Row Level Security (RLS)
- [ ] Check `supabase/migrations/` — confirm `20260526_enable_rls.sql` exists and enables RLS on all required tables
- [ ] Confirm the helper SQL functions exist: `public.rma_user_role()`, `public.rma_is_admin()`, `public.rma_is_manager_or_above()`, `public.rma_is_staff()`, `public.rma_current_user_email()`
- [ ] Confirm no SQL policy uses `auth.user_role()` — that function does not exist and must never appear
- [ ] Spot-check at least 3 migration files for `DROP POLICY IF EXISTS` + `IF NOT EXISTS` idempotency patterns

### 2-C. Input Validation
- [ ] Confirm Zod schemas exist in `src/lib/schemas.ts` (or equivalent) and cover RMA ticket creation, customer creation, and product creation
- [ ] Confirm `parseCSVLine` custom helper is used in Products and Customers bulk upload (not bare `split(',')`)
- [ ] Check that all Edge Functions sanitize/validate their inputs before touching the DB

### 2-D. Storage Security
- [ ] Confirm `20260527_storage_bucket_policies.sql` exists and caps anonymous uploads at 25 MB, JPEG/PNG/GIF/WebP/PDF only
- [ ] Confirm no page component references the `rma-attachments` bucket directly without going through `storage` helpers in `src/api/supabaseClient.js`

### 2-E. Auth & Route Guards
- [ ] Confirm `/tracker` and `/kb` are the **only** unauthenticated routes
- [ ] Confirm `/control-panel` is admin+ gated (check `App.jsx` route guard logic)
- [ ] Confirm `currentUserRole`, `currentUserEmail`, `currentUserPermissions` props are passed to every authenticated page
- [ ] Check that `canDo()` from `src/lib/permissions.ts` is used for all permission gating — no hardcoded role strings in page components

### 2-F. WhatsApp & Meta API
- [ ] Confirm `whatsapp_templates` JSONB param ordering uses arrays (not objects) to survive JSONB key reordering
- [ ] Confirm no positional param is left empty (handler must substitute `—` for blanks — Meta error 131008)
- [ ] Confirm `notification-worker` Edge Function uses exponential-backoff retry (5 min → 10 min → 20 min)

---

## Phase 3 — Codebase Architecture Audit

### 3-A. Constitutional Law Compliance (from CONSTITUTION.md)

Check each LAW below. Report ✅ PASS or ❌ FAIL with file + line number for failures:

| Law | Check |
|-----|-------|
| L-1: No direct supabase import in page components | Scan `src/pages/**/*.{jsx,tsx}` for `import.*from.*client` or `createClient` |
| L-2: No re-implemented shared components | Scan pages for local `<button`, `<input`, custom modal divs that duplicate `ui.jsx` exports |
| L-3: No hardcoded status/priority strings | Scan for string literals like `'open'`, `'closed'`, `'critical'` outside `src/lib/constants.ts` |
| L-4: All permission checks use `canDo()` | Scan for `currentUserRole ===` or `role === 'admin'` comparisons outside permissions.ts |
| L-5: All localStorage uses `safeStorage` | Scan for bare `localStorage.getItem` / `localStorage.setItem` |
| L-6: TypeScript db layer | Confirm all files in `src/api/db/` are `.ts` not `.js`; check for `any` type usages |
| L-7: All new `src/lib/` code has unit tests | Check that every `.ts` file in `src/lib/` has a corresponding `.test.ts` or `.test.js` |
| L-8: Dark mode on all UI components | Spot-check 5 page files for `dark:` Tailwind variants on major containers |
| L-9: No ad-hoc schema changes | Confirm every migration is in `supabase/migrations/` and named `YYYYMMDD_*.sql` |
| L-10: CI must pass | Check `.github/workflows/ci.yml` — does it run test → lint:ci → build in that order? |

### 3-B. Data Layer Integrity

- [ ] Confirm `src/api/supabaseClient.js` is the barrel re-export (exports `auth`, `db`, `storage`, `branding`, `notifications`, `backup`)
- [ ] Confirm all domain modules exist in `src/api/db/`: `tickets.ts`, `customers.ts`, `catalog.ts`, `inventory.ts`, `users.ts`, `notifications.ts`, `system.ts`, `audit.ts`, `whatsappNotifications.ts`
- [ ] Check `src/api/db/index.ts` aggregates all modules and re-exports all Row types
- [ ] Confirm `audit.ts` has a resilient write queue (H-9 pattern from CLAUDE.md)

### 3-C. Routing & Lazy Loading

- [ ] Confirm all page imports in `App.jsx` use `lazyWithReload()` — not bare `React.lazy()`
- [ ] Confirm parameterized routes (`/products/:id`, `/customers/:id`) use thin wrapper components
- [ ] Confirm catch-all `*` route renders `NotFoundPage`
- [ ] Confirm `window.history.pushState` is only used in `RMATickets/index.jsx` (for `?ticket=<id>` modal URL sync)

### 3-D. Provider Order

Verify `src/main.jsx` wraps in this exact order (outer to inner):
```
React.StrictMode → ErrorBoundary → BrowserRouter → QueryClientProvider → AppearanceProvider → App
```

- [ ] Confirm `TooltipProvider` from Radix is present inside `App.jsx`
- [ ] Confirm `TanStack Query` config: `staleTime: 60000`, `retry: 1`

### 3-E. State Management

- [ ] Confirm no page component calls `supabase` directly for real-time subscriptions — must go through the single `app_notifications` channel in `App.jsx`
- [ ] Confirm TanStack Query cache is updated via `queryClient.setQueryData` in real-time handlers (not a full re-fetch)
- [ ] Confirm `AppearanceContext` writes `document.documentElement.classList.toggle('dark', darkMode)` for dark mode
- [ ] Confirm `AppearanceContext` sets `dir="rtl"` on `<html>` when `language === 'ar'`

### 3-F. Page Folder Structure

Verify the following multi-file page folders exist and contain the correct files:
- `src/pages/Inventory/` — `index.jsx`, `_shared.jsx`, `ExportMenu.jsx`, `TransferModal.jsx`, plus tab files
- `src/pages/RMATickets/` — `index.jsx`, `TicketForm.jsx`, `TicketDrawer.jsx`, `_shared.jsx`, `_utils.js`
- `src/pages/Products/` — `index.jsx`, `ProductsListTab.jsx`, `HierarchyTab.jsx`, `_modals.jsx`
- `src/pages/UserManagement/` — `index.jsx`, `UsersTab.jsx`, `RolesTab.jsx`, `_shared.jsx`, `_utils.js`
- `src/pages/Customers/` — `index.jsx`, `_modals.jsx`, `_constants.js`

---

## Phase 4 — Feature Coverage Matrix

For each feature, check whether the implementation exists and appears functional. Mark ✅ Exists / ⚠️ Partial / ❌ Missing:

| # | Feature | What to check |
|---|---------|---------------|
| 1 | RMA Ticket CRUD | `src/api/db/tickets.ts` + `src/pages/RMATickets/` |
| 2 | Customer Management | `src/api/db/customers.ts` + `src/pages/Customers/` |
| 3 | Product Catalog | `src/api/db/catalog.ts` + `src/pages/Products/` |
| 4 | Inventory Tracking | `src/api/db/inventory.ts` + `src/pages/Inventory/` |
| 5 | Public RMA Tracker | `src/pages/RMATracker/` + `supabase/functions/public-track/` |
| 6 | Tech Calendar | `src/pages/TechCalendar/` (or `Calendar`) |
| 7 | Invoices | `src/pages/Invoices/` |
| 8 | Reports | `src/pages/Reports/` |
| 9 | Parts Inventory | `src/pages/PartsInventory/` |
| 10 | Role-Based Access Control | `src/lib/permissions.ts` + `ROLE_DEFAULT_PERMISSIONS` |
| 11 | Real-Time Notifications | `app_notifications` channel in `App.jsx` + `src/api/db/notifications.ts` |
| 12 | Dark Mode | `AppearanceContext` + `darkMode` toggle + `dark:` classes in components |
| 13 | RTL / Arabic layout | `AppearanceContext` `dir="rtl"` + `ms-`/`me-`/`ps-`/`pe-` usage in components |
| 14 | PWA / Offline | `vite.config.js` PWA config + Workbox `generateSW` |
| 15 | WhatsApp Notifications | `supabase/functions/send-whatsapp/` + `notification-worker/` + `whatsapp-webhook/` |
| 16 | PDF Generation | `jsPDF` + `html2canvas` usage in RMATickets or Invoices |
| 17 | Bulk CSV Import | `parseCSVLine` in Products and Customers pages |
| 18 | Audit Log | `src/api/db/audit.ts` + Audit Log tab in Control Panel |
| 19 | Backup & Restore | `src/api/backup.js` + Backup tab in Control Panel |
| 20 | Branding | `src/api/branding.js` + Branding tab in Control Panel |
| 21 | Knowledge Base (public) | `src/pages/KnowledgeBasePublic/` + `20260617_kb_articles.sql` migration |
| 22 | Serial number search | `20260613_search_by_serial.sql` migration + RPC call in API layer |
| 23 | Messaging system | `src/services/messaging/MessagingService.ts` + `NotificationEventBus.ts` + `ticketEventHandlers.ts` |
| 24 | User Preferences | `src/api/db/users.ts` `UserPreferencesRow` + `safeStorage` per-user prefs |
| 25 | Control Panel (admin) | `src/pages/ControlPanel.jsx` — all sub-tabs including WhatsApp & Messaging |

---

## Phase 5 — Design System Compliance (DESIGN.md "Command")

Check 5 representative files (e.g. Dashboard, RMATickets, Inventory, ControlPanel, one modal) against the DESIGN.md spec:

- [ ] Page background uses `bg-[#f4f6f9]` (light) / `dark:bg-[#0b0f17]` (dark) — **not** `bg-gray-100` or `bg-slate-*`
- [ ] Cards use `bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]` — **no shadow**
- [ ] Accent color is indigo (`#4338ca` / `dark: #a5b4fc`) — not blue-500, not violet
- [ ] Status colors match DESIGN.md spec (`status-open: #3b82f6`, `status-completed: #14b8a6`, etc.)
- [ ] Hanken Grotesk font is imported from Google Fonts in `index.html`
- [ ] KPI numbers use tabular-nums (`tabular-nums` class or `font-variant-numeric: tabular-nums`)
- [ ] Charts use `strokeWidth={2}`, horizontal grid lines only, correct tick colors
- [ ] RTL: No `ml-`/`mr-` spacing for content that should mirror — uses `ms-`/`me-` logical properties
- [ ] Portaled elements (dropdowns, notification panels) have explicit `dir` attribute

---

## Phase 6 — Database & Migrations Audit

List all migration files in `supabase/migrations/` and verify:

- [ ] All 13 expected migrations exist (from CLAUDE.md list, ending with `20260617_kb_articles.sql`)
- [ ] Each migration file name follows `YYYYMMDD_description.sql` format
- [ ] Spot-check 3 migrations for idempotency: `IF NOT EXISTS`, `IF EXISTS`, `DROP POLICY IF EXISTS`
- [ ] Confirm `20260531_relax_ticket_status_constraint.sql` exists (relaxed status enum)
- [ ] Confirm `20260602_whatsapp_notifications.sql` creates: `whatsapp_templates`, `notification_logs`, `notification_settings`, `notification_queue`
- [ ] Confirm `20260603_user_preferences_rls.sql` adds RLS for user preferences table
- [ ] Confirm `20260613_search_by_serial.sql` adds serial number search RPC
- [ ] Confirm `20260617_kb_articles.sql` adds knowledge base articles table

---

## Phase 7 — PWA & Performance

```bash
npm run build
```

- [ ] Build succeeds without errors
- [ ] PWA manifest includes: name, icons (64×64, 192×192, 512×512 + maskable), theme color `#4f46e5`
- [ ] Workbox `generateSW` strategy is used (not `injectManifest`)
- [ ] `NetworkFirst` cache strategy is configured for Supabase API calls with 10s timeout
- [ ] No single chunk exceeds 500 KB (flag any that do with root cause)
- [ ] Recharts imports in Dashboard are lazy-loaded (not statically imported at top of file)
- [ ] `axe-core/react` is behind `import.meta.env.DEV` guard — never in production build

---

## Phase 8 — Accessibility (WCAG / ARIA)

Inspect 3 data-heavy pages (RMATickets, Inventory, a modal):

- [ ] Sort buttons have `aria-sort="ascending|descending|none"` — check `SortableHeader` in `RMATickets/_shared.jsx` and `InvSortBtn` in `Inventory/_shared.jsx`
- [ ] All icon-only action-menu buttons have `aria-label`, `aria-expanded`, `aria-haspopup="menu"`
- [ ] Filter-panel toggles have `aria-expanded` + `aria-controls`
- [ ] `Spinner` component uses `role="status"` and `aria-label="Loading"`
- [ ] No `text-right`/`text-left` for reading-direction-dependent alignment — must be `text-start`/`text-end`

---

## Phase 9 — Error Handling & Observability

- [ ] `ErrorBoundary` is present in `src/main.jsx` wrapping the app
- [ ] `initSentry()` is called in `main.jsx` with a no-op guard when `VITE_SENTRY_DSN` is not set
- [ ] `captureException` is imported from the Sentry integration file — not called as `Sentry.captureException()` directly in page components
- [ ] `ErrorBoundary` shows error message (safe) in production + "Copy error details" button; full stack trace is dev-only
- [ ] All Edge Functions log errors to appropriate tables (e.g. `notification_logs.error_message`)
- [ ] `notification-worker` logs retry attempts and final failure status

---

## Phase 10 — i18n / Internationalisation

- [ ] i18n files exist for all supported languages (check `src/i18n/` or `src/locales/`)
- [ ] `t()` translation function is used for all user-visible strings in at least 3 sampled page files
- [ ] Arabic (`ar`) locale is present
- [ ] Date format respects `AppearanceContext` date format preference
- [ ] No hardcoded English strings in UI components (spot-check `ui.jsx` and 2 page files)

---

## Phase 11 — Code Quality & Tech Debt Scan

Run a static analysis pass across the codebase:

```bash
npm run lint
```

For each category below, count occurrences and list the worst offenders (file + line):

| Category | Check | Threshold |
|----------|-------|-----------|
| Unused variables | ESLint `no-unused-vars` | 0 in new code |
| `console.log` in production paths | Scan `src/` excluding test files | 0 (should use `captureException` or be behind DEV guard) |
| `// @ts-ignore` comments | Scan `src/` | Flag all — each needs justification |
| `any` type in TypeScript files | Scan `src/api/db/**/*.ts` | Flag all |
| Dead code / unused exports | Functions/components exported but never imported | Flag any found |
| Magic numbers | Numeric literals in business logic outside constants | Flag any found |
| God functions > 100 lines | Check `handleSubmit`, form handlers | Flag any |
| TODO/FIXME comments | Scan `src/` | List all — should be tracked in IMPROVEMENT_PLAN.md |

---

## Phase 12 — Documentation Accuracy Check

Cross-reference CLAUDE.md and CONSTITUTION.md against the actual codebase:

- [ ] Route table in CLAUDE.md matches actual routes in `App.jsx` (add `/kb` if now present per `20260617_kb_articles.sql`)
- [ ] Migration list in CLAUDE.md matches actual files in `supabase/migrations/`
- [ ] Page folder structure table in CLAUDE.md matches actual `src/pages/` folders
- [ ] Edge Function list in CLAUDE.md matches actual `supabase/functions/` folders
- [ ] Domain module list in CLAUDE.md matches actual `src/api/db/` files
- [ ] CONSTITUTION.md Section 15 (Testing) — test suite counts match actual test output

---

## 📄 Report Format

Write results to: **`SYSTEM_AUDIT_REPORT_<YYYYMMDD>.md`** (replace `<YYYYMMDD>` with today's date).

The report must follow this structure exactly:

```markdown
# myRMA — Full System Audit Report
**Date:** <date>
**Auditor:** Claude Code (automated static analysis + file inspection)
**Previous score:** 9.3/10 (per AUDIT_LOG.md, 2026-06-05)
**Verdict:** <NEW SCORE>/10 — <one-line summary>

---

## Executive Summary
<3–5 sentences: what was tested, what the headline findings are, whether the system is production-safe>

## Score Breakdown
| Domain | Score | Notes |
|--------|-------|-------|
| Security | X/10 | |
| Architecture | X/10 | |
| Feature Coverage | X/10 | |
| Design System | X/10 | |
| Database / Migrations | X/10 | |
| Performance / PWA | X/10 | |
| Accessibility | X/10 | |
| Code Quality | X/10 | |
| Documentation Accuracy | X/10 | |
| **Overall** | **X/10** | |

---

## Phase 0 — Environment
<findings>

## Phase 1 — Automated Tests
<exact terminal output for each command>

## Phase 2 — Security Audit
<table: check | ✅ PASS / ❌ FAIL / ⚠️ PARTIAL | detail>

## Phase 3 — Architecture Audit
<findings per section>

## Phase 4 — Feature Coverage Matrix
<table with ✅ / ⚠️ / ❌ per feature>

## Phase 5 — Design System Compliance
<findings>

## Phase 6 — Database & Migrations
<findings>

## Phase 7 — PWA & Performance
<findings>

## Phase 8 — Accessibility
<findings>

## Phase 9 — Error Handling & Observability
<findings>

## Phase 10 — i18n
<findings>

## Phase 11 — Code Quality
<findings with tables of offenders>

## Phase 12 — Documentation Accuracy
<delta list: what's accurate / what's stale>

---

## New Findings Summary

### 🔴 P0 — Critical (Fix before next deploy)
| ID | Finding | File | Severity |
|----|---------|------|----------|

### 🟠 P1 — High (Fix this sprint)
| ID | Finding | File | Notes |
|----|---------|------|-------|

### 🟡 P2 — Medium (Schedule)
| ID | Finding | File | Notes |
|----|---------|------|-------|

### 🔵 P3 — Low / Polish
| ID | Finding | File | Notes |
|----|---------|------|-------|

---

## Closed / Previously Fixed
<list items confirmed fixed — brief confirmation only>
```

---

## 🗂️ SpecKit Fix Plan

After the report is written and saved, run a SpecKit planning pass to generate a prioritised fix plan.

Create a second file: **`FIX_PLAN_<YYYYMMDD>.md`**

For every finding rated P0 or P1 in the report, generate a Spec entry:

```markdown
# myRMA — Fix Plan
**Generated from:** SYSTEM_AUDIT_REPORT_<YYYYMMDD>.md
**Date:** <date>

---

## Sprint Proposal

### Sprint A — Critical Fixes (P0)
For each P0 finding:

#### [FINDING-ID] <Short title>
- **Problem:** <one sentence>
- **Root cause:** <one sentence>
- **File(s):** <list>
- **Fix:** <concrete steps — what to change, where, how>
- **Test:** <how to verify the fix is correct>
- **Risk:** Low / Medium / High
- **Estimated effort:** <XS / S / M / L>

---

### Sprint B — High Priority (P1)
<same format>

---

### Sprint C — Medium Priority (P2)
<brief spec per item — title, file, fix, test>

---

## Effort Summary
| Sprint | Items | Est. Total Effort |
|--------|-------|-------------------|
| A (P0) | X | X days |
| B (P1) | X | X days |
| C (P2) | X | X days |

## What NOT to touch
List any areas that are currently working well and should not be modified as part of this fix plan.

## Suggested merge order
List the fix specs in the order they should be applied to minimize conflicts.
```

---

## ✅ Completion Checklist

Before finishing, confirm:

- [ ] Both files saved: `SYSTEM_AUDIT_REPORT_<YYYYMMDD>.md` and `FIX_PLAN_<YYYYMMDD>.md`
- [ ] Every phase (0–12) has a result entry in the report
- [ ] Every P0/P1 finding has a corresponding SpecKit entry in the fix plan
- [ ] New findings do not duplicate items already in IMPROVEMENT_PLAN.md or closed items in AUDIT_LOG.md
- [ ] Overall score is justified by the phase scores

---

## 📌 Notes for Claude Code

- **Do not attempt to fix anything during this audit run.** This is read-only analysis. Record findings only.
- **Do not re-report items already marked ✅ in AUDIT_LOG.md** unless you find a regression.
- **Cross-reference IMPROVEMENT_PLAN.md** before creating new finding IDs — use the next available ID in each category (CQ-xx, TS-xx, UX-xx, DOC-xx, SEC-xx, PERF-xx, A11Y-xx).
- **Be precise with file paths and line numbers.** Vague findings like "permissions might be wrong" are not actionable.
- **If the codebase cannot be read** (e.g. a file doesn't exist that should), record that as a finding — do not assume it exists.
- **Use your skills.** If a clean-code-guard, test-guard, or docs-guard skill is available in your environment, use it for the relevant phase rather than doing a purely manual scan.
