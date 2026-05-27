# myRMA Enterprise Audit — Progress Tracker

> Audit date: 2026-05-26 → 2026-05-27
> Baseline commit: `5085ad2` + post-rollback UI fixes
> Overall score: **10/10** — all P0/P1/P2/P3 items complete (or consciously deferred). PWA done 2026-05-27. Only deferral: A-1 React Router (cosmetic gap, low ROI).

---

## 🔴 P0 — CRITICAL (Production Blockers, This Week)

| ✅ | ID | Finding | Location | Status |
|----|----|---------|----------|--------|
| ✅ | CRIT-1 | Supabase service role key exposed to browser via `VITE_SUPABASE_SERVICE_KEY` | [supabaseClient.js:5](src/api/supabaseClient.js#L5) | **Done 2026-05-26.** Edge Function deployed, service key deleted from Vercel, app redeployed. |
| ✅ | CRIT-2 | No Row Level Security — all permission checks client-side | All tables | **Done 2026-05-26.** RLS migration applied, all tables locked down, app tested and working. |
| ✅ | CRIT-3 | Public `/tracker` route has no rate limit / abuse protection | [App.jsx:388-396](src/App.jsx#L388-L396) | **Done 2026-05-26.** Edge Function `public-track` deployed with 15 req/min rate limit active. |
| ✅ | CRIT-4 | `bcryptjs` in browser bundle (anti-pattern or dead weight) | [package.json:39](package.json#L39) | **Done 2026-05-26.** Confirmed zero usage in src/; package uninstalled. |

---

## 🟠 P1 — HIGH (Data Integrity + Architecture, 2 Weeks)

| ✅ | ID | Finding | Location | Fix |
|----|----|---------|----------|-----|
| ✅ | H-1 | Duplicate `db.webhooks` definition — second overwrites first | supabaseClient.js:527, :1015 | **Done 2026-05-26.** Merged: kept table-based CRUD (matches Integrations.jsx), added `dispatch` method, deleted duplicate rma_config-based block. Integrations page no longer silently broken. |
| ✅ | H-2 | N+1 query in `markAllRead` | supabaseClient.js:820-836 | **Done 2026-05-26.** RPC `mark_notifications_read(p_email, p_ids)` — single batched UPDATE replaces N queries. |
| ✅ | H-3 | Race condition in `parts.adjustQuantity` (read-modify-write) | supabaseClient.js:906-912 | **Done 2026-05-26.** RPC `adjust_part_quantity(p_id, p_delta)` — atomic `GREATEST(0, quantity + delta)` in one SQL statement. |
| ✅ | H-4 | All list endpoints return full tables, no pagination | `rmaTickets.list`, `customers.list`, `products.list` | **Done 2026-05-26.** Added `.limit(500)` safety cap to all three `list()` calls. Added `listPaged(page, pageSize)` returning `{ data, count, totalPages }`. Warning banner shown in UI when total exceeds cap. |
| ✅ | H-5 | Notifications filtered client-side after fetching all rows (privacy leak) | supabaseClient.js:796-808 | **Done 2026-05-26.** Removed client-side filter — RLS policy `user_read_targeted` handles it server-side. `markRead` now uses `mark_notifications_read` RPC (atomic, no read-then-write). |
| ✅ | H-6 | Backup export includes plaintext SMTP/SendGrid API keys | `backup` namespace | **Done 2026-05-26.** `exportAll()` now selects only non-secret columns from `email_settings`. `redactEmailSettings()` guard replaces known secret fields with `[REDACTED]` as belt-and-braces. User must re-enter API keys after restore. |
| ✅ | H-7 | Webhook secret sent as plaintext header (no HMAC) | Webhook delivery | **Done 2026-05-26.** `dispatch()` now signs request body with `crypto.subtle` HMAC-SHA256, sends `X-Signature-256: sha256=<hex>`. Secret never travels over the wire. |
| ✅ | H-8 | Customer bulk delete fallback is non-atomic sequential | supabaseClient.js | **Done 2026-05-26.** Both `delete()` and `bulkDelete()` now call RPC exclusively — no sequential fallback. Throws clear error if RPC missing. |
| ✅ | H-9 | Fire-and-forget audit logging silently drops events | App.jsx:274, 287 | **Done 2026-05-26.** `auditInsert()` helper: retry after 600ms, then queue to localStorage (capped 50). Queue flushed on next success or app startup. All 86 call sites fixed automatically. |
| ✅ | A-2 | No global ErrorBoundary — any render error = white screen | [main.jsx](src/main.jsx) | **Done 2026-05-26.** Added [src/components/ErrorBoundary.jsx](src/components/ErrorBoundary.jsx) with fallback UI (reload/home), dev-only stack trace, dark mode support. Wraps `<App>` in main.jsx. |

---

## 🟡 P2 — MEDIUM (Frontend Architecture, 1 Month)

| ✅ | ID | Finding | Location | Fix |
|----|----|---------|----------|-----|
| ⏸ | A-1 | No React Router — manual `pathToPage` mapping; typo URLs land on Dashboard | [App.jsx:97-119](src/App.jsx#L97-L119) | **Deferred — low priority.** Custom routing works correctly. `useURLTab` handles deep-linking. Main gap: typo URLs silently land on Dashboard instead of 404. Not worth 6h migration risk unless team grows significantly or 10+ new routes are added. |
| ✅ | A-3 | Notification prefs in `localStorage` only — resets on new device | App.jsx:191-194 | **Done 2026-05-26.** `db.userPreferences` added. AccountSettings calls `persistPrefsToDb()` on every pref toggle. App.jsx seeds localStorage from DB on login. |
| ✅ | A-4 | Dashboard recomputes 8+ aggregations every render | [Dashboard.jsx:169-243](src/pages/Dashboard.jsx#L169-L243) | **Done 2026-05-26.** All 13 aggregations wrapped in `useMemo([tickets])`. |
| ✅ | A-5 | Dashboard realtime refetches everything on each event | [Dashboard.jsx:119-124](src/pages/Dashboard.jsx#L119-L124) | **Done 2026-05-26.** INSERT/UPDATE/DELETE each merge payload into the **query cache** via `queryClient.setQueryData(['rma-tickets'], …)` — no full refetch. (After P-1 migrated Dashboard to TanStack Query, realtime handlers write to the cache, not local state.) |
| ✅ | A-6 | `ROLE_DEFAULT_PERMISSIONS` lives in App.jsx (40 lines) | [App.jsx:52-95](src/App.jsx#L52-L95) | **Done 2026-05-26.** Moved to [src/lib/permissions.ts](src/lib/permissions.ts) + `canDo()` helper exported. App.jsx imports from lib. (File later converted to `.ts` in M-3.) |
| ✅ | A-7 | Heavy deps eagerly loaded (~1.5MB initial bundle) | xlsx, jspdf, html2canvas, recharts | **Done 2026-05-26.** `xlsx` + `jspdf` dynamic-imported in Inventory.jsx export handlers. Inventory chunk: 734 KB → 90 KB. |
| ✅ | P-1 | Adopt TanStack Query for all data fetching | All pages | **Done 2026-05-27 (targeted).** `QueryClientProvider` in main.jsx. `useQuery` replaces `useState+useEffect` fetch in RMATickets, Dashboard, Customers. `staleTime: 60s` — return navigation shows cached data instantly, no repeat spinner. Realtime handlers updated to write to query cache instead of local state. All `loadData()`/`loadAll()` calls replaced with `queryClient.invalidateQueries`. |
| ✅ | M-1 | Zero unit/E2E tests | — | **Done 2026-05-27.** Vitest + jsdom + RTL installed. 74 tests in 3 suites (schemas, permissions, constants). `npm test` / `npm run test:coverage`. All pass. |
| ✅ | M-2 | No ESLint config | — | **Done 2026-05-26.** ESLint 9 flat config + Prettier. 0 errors, 167 warnings. `npm run lint` / `npm run format` now available. |
| ✅ | M-4 | `supabaseClient.js` is 1350 lines | src/api/supabaseClient.js | **Done 2026-05-26.** Split into 15 domain files under `src/api/`. `supabaseClient.js` is now a 21-line barrel re-export. 100% backward compatible. Build clean. |

---

## 🟡 P2 — MEDIUM (UX & Accessibility, 1 Month)

| ✅ | ID | Finding | Fix |
|----|----|---------|-----|
| ✅ | UX-1 | Modals don't trap focus | **Done 2026-05-26.** `src/components/Modal.jsx` wrapping `@radix-ui/react-dialog`. 13 modals migrated: 7 in UserManagement, 2 in RMATickets, 4 in Products. Focus trap + Escape + scroll-lock + aria-labelledby on all. |
| ✅ | UX-2 | Icon-only buttons missing `aria-label` | **Done 2026-05-26.** `aria-label` added to all icon-only buttons with `title=` across App.jsx, PartsInventory, RMATickets, Invoices, NotificationBell. |
| ✅ | UX-3 | `text-gray-400` on white = WCAG ratio 2.85 (fails AA) | **Done 2026-05-26.** 318 replacements → `text-gray-500` (ratio 4.57, meets AA) across 32 files. |
| ✅ | UX-4 | Mobile sidebar doesn't trap focus | **Done 2026-05-26.** `inert` attribute on main content when sidebar open. Escape key closes + returns focus to hamburger. aria-labels on open/close buttons. |
| ✅ | UX-5 | No realtime toast for new notifications | **Done 2026-05-26.** Supabase realtime INSERT on `notifications` table → `toast()` with role/email targeting + pref check in App.jsx. |
| ✅ | UX-6 | No optimistic UI on CRUD actions | **Done 2026-05-27.** Optimistic delete on tickets (RMATickets) and customers (Customers): cache updated before `await`, rollback via `setQueryData` on error. Optimistic update on customer edits: table row reflects changes instantly while network call is in-flight. |
| ✅ | UX-7 | Empty states lack CTAs and illustrations | **Done 2026-05-26.** `<EmptyState>` component wired into RMATickets, Customers, Products, PartsInventory. Inline placeholder divs removed. |
| ✅ | F-1 | `zod` + `react-hook-form` installed but used inconsistently | **Done 2026-05-27.** `src/lib/schemas.ts` — central schemas for login, customer, ticket, product, addUser + `getFirstError`/`getFieldErrors` helpers. Login.jsx fully migrated to `useForm+zodResolver` (inline field errors, isSubmitting, noValidate, role=alert). Customers.jsx: `handleSaveCustomer` uses `customerSchema.safeParse`. |
| ✅ | F-2 | No server-side validation visible | **Done 2026-05-27.** `supabase/migrations/20260526_check_constraints.sql` — CHECK constraints on 8 tables (ticket_status, priority, user role/status, invoice status/type, notification type, inventory/batch/product/customer statuses). All NOT VALID + idempotent. `validate_ticket_fields()` RPC returns JSON error list. |

---

## 🟡 P2 — Dark Mode Gaps

| ✅ | Issue | Where | Fix |
|----|-------|-------|-----|
| ✅ | Recharts tick text not dark-aware | All Dashboard charts | **Done 2026-05-26.** `chartTickStyle` with explicit fill colour from `darkMode` flag. |
| ✅ | Recharts tooltip stays white | All charts | **Done 2026-05-26.** All `<Tooltip>` get `contentStyle` with dark bg `#1e293b` / border `#334155`. |
| ✅ | `bg-blue-600`/`bg-green-600` saturated banners not overridden | Announcement banner | **Done 2026-05-26.** 4 CSS rules in `appearance.css` override all announcement colour variants in dark mode. |
| ✅ | `react-hot-toast` toasts have no dark theme | All pages | **Done 2026-05-26.** All 4 `<Toaster>` get `toastOptions` with dark `#1e293b` background. |
| ✅ | PDF export tracks theme (should stay light) | Invoices, labels | **N/A — 2026-05-26.** PDFs use popup HTML / jsPDF with hardcoded light colours; no dark bleed. |

---

## 🔍 A-1 / P-1 Reassessment (2026-05-27)

After completing all other P2 items, A-1 and P-1 were re-evaluated against actual cost vs. benefit for this app.

### A-1 — React Router: **Deferred**

| | Detail |
|---|---|
| **Current routing** | `pathToPage()` / `pageToPath()` in App.jsx + `useURLTab` hook. Works correctly for all navigation, deep-links, and browser history. |
| **Real gap** | Typo URLs land on Dashboard silently (no 404). |
| **Migration cost** | ~6 hrs, HIGH breakage risk across all navigation. |
| **Verdict** | The gap is cosmetic for an internal tool. No user is harmed. Defer until team grows or 10+ new routes are needed. |

### P-1 — TanStack Query: **Rescoped to 3 pages**

| | Detail |
|---|---|
| **Current pattern** | Every page has `useState + useEffect` fetch with spinner on every visit. No caching. |
| **User-visible problem** | Navigating back to RMA Tickets, Dashboard, or Customers always shows a loading spinner even if data is seconds old. |
| **Full migration cost** | 8+ hrs touching all 15+ pages, high risk of subtle bugs. |
| **Targeted approach** | RMATickets + Dashboard + Customers only (~2–3 hrs). These 3 pages cover >80% of daily navigation. Other pages get migrated incrementally as they're touched for other reasons. |
| **Unlocks** | UX-6 (optimistic UI on ticket create/edit/delete) at the same time. |

---

## 🟢 P3 — Quarter

| ✅ | ID | Finding | Fix |
|----|----|---------|-----|
| ✅ | M-3 | No TypeScript despite `@types/react` installed | **Done 2026-05-27.** `tsconfig.json` added (`moduleResolution: bundler`, `strict: true`, `noEmit: true`). `src/lib/constants.js`, `permissions.js`, `schemas.js` converted to `.ts` with full type annotations — `as const` objects, exported `Role`/`TicketStatus`/`Priority` types, `z.infer<>` form data types, typed helpers. Build + 74 tests: ✅ clean. |
| ✅ | M-5 | Magic strings (`'super_admin'`, `'Closed'`, …) everywhere | **Done 2026-05-26.** `src/lib/constants.ts` with ROLES, TICKET_STATUS, PRIORITY, INVENTORY_STATUS, NOTIF_TYPE, AUTOMATION_ACTION, CONFIG_KEY, STORAGE_KEY + helpers. `permissions.ts` updated to use ROLES constants. `audit.js` and `system.js` consume CONFIG_KEY, AUTOMATION_ACTION, PRIORITY. (Files converted from `.js` → `.ts` in M-3.) |
| ✅ | P-2 | No virtualization on long lists | **Done 2026-05-27.** Two-pronged solution: (1) Main tables (RMATickets, Customers, Products) are client-side paginated at 25 items/page — never more than 25 DOM nodes in any table. (2) Customer search dropdown in RMATickets had no pagination and rendered all 500+ customers simultaneously — virtualised with `@tanstack/react-virtual` v3 `useVirtualizer` (estimateSize 56px, overscan 3, `customerDropdownRef`). Only visible rows rendered regardless of dataset size. |
| ✅ | P-3 | Image uploads not resized | **Done 2026-05-27.** `src/lib/resizeImage.js` — canvas-based downscale to 1200px max width (400px for avatars), JPEG quality 0.85, PNG passthrough. Wired into `storage.js`: `uploadFile`, `uploadProductImage`, `uploadAvatar`, `uploadCustomerAttachment`, `uploadCommentAttachment` all call `resizeImage()` before upload. No-op for non-image types. |
| ✅ | — | No service worker / PWA manifest | **Done 2026-05-27.** `vite-plugin-pwa` + Workbox `generateSW`. App-shell pre-caches all 42 static assets (`sw.js` + `workbox-*.js` emitted at build). Supabase API calls use NetworkFirst (10s timeout, falls back to cache). `public/icon.svg` → 5 PNG sizes + `favicon.ico` + `apple-touch-icon` via `@vite-pwa/assets-generator`. Manifest: `standalone` display, indigo theme `#4f46e5`, dark background `#0f172a`. `index.html` updated with correct `<link>` tags. |
| ✅ | — | No error reporting | **Done 2026-05-27.** `src/lib/sentry.js` — `initSentry()` no-op guard (requires `VITE_SENTRY_DSN`), `captureException()` helper (logs to console in DEV, sends to Sentry in PROD). `ErrorBoundary.jsx` calls `captureException` in `componentDidCatch`. `initSentry()` called in `main.jsx`. `.env.example` documents `VITE_SENTRY_DSN`. |
| ✅ | — | No CI/CD with test gating | **Done 2026-05-27.** `.github/workflows/ci.yml` — ubuntu-latest, Node 20, `npm ci --legacy-peer-deps`, then `npm test` → `npm run lint:ci` → `npm run build`. Runs on push to `main` and all PRs targeting `main`. Build step uses placeholder Supabase env vars so it succeeds without secrets. |

---

## 📊 Scorecard

### Baseline (2026-05-26 start)

| Domain | Score | Verdict |
|---|---|---|
| Security | 2/10 | 🔴 Not production-ready |
| Architecture | 6/10 | 🟡 Solid SPA, missing router/ErrorBoundary/TS |
| Performance | 5/10 | 🟡 Struggles past 5k rows |
| Accessibility | 4/10 | 🟡 No focus traps, contrast gaps |
| UX polish | 7/10 | 🟢 Good baseline |
| Dark mode | 7/10 | 🟢 Comprehensive, chart gaps |
| Code quality | 5/10 | 🟡 No tests/linter/types |
| Notifications | 6/10 | 🟡 Client-side filtering |
| Mobile | 6/10 | 🟡 Responsive, missing focus traps |
| Scalability | 4/10 | 🟠 Full-table loads |
| Maintainability | 4/10 | 🟠 Magic strings, monolithic API |
| Production readiness | 3/10 | 🔴 Blocked by CRIT-1..4 |
| **Overall** | **5/10** | 🔴 **Cannot ship to public until CRIT-1..4 land** |

### After P0 + P1 (2026-05-26)

| Domain | Score | Verdict |
|---|---|---|
| Security | 8/10 | 🟢 RLS, HMAC webhooks, backup secrets stripped, service key hidden |
| Architecture | 7/10 | 🟢 ErrorBoundary, atomic deletes, webhooks fixed |
| Performance | 8/10 | 🟢 Pagination cap, atomic RPCs, no N+1, no race conditions |
| Accessibility | 4/10 | 🟡 No focus traps, contrast gaps |
| UX polish | 7/10 | 🟢 Good baseline |
| Dark mode | 7/10 | 🟢 Comprehensive, chart gaps |
| Code quality | 5/10 | 🟡 No tests/linter/types |
| Notifications | 9/10 | 🟢 Server-side filtered, atomic, resilient audit log |
| Mobile | 6/10 | 🟡 Responsive, missing focus traps |
| Scalability | 7/10 | 🟢 500-row cap, listPaged(), atomic inventory |
| Maintainability | 4/10 | 🟠 Magic strings, monolithic API |
| Production readiness | 9/10 | 🟢 All P0+P1 resolved, resilient logging |
| **Overall** | **8/10** | 🟢 **Production-ready. P2 improves quality of life.** |

### After P2 complete (2026-05-27)

| Domain | Score | Verdict |
|---|---|---|
| Security | 8/10 | 🟢 Unchanged — all P0 fixes still in place |
| Architecture | 9/10 | 🟢 Permissions in lib, lazy heavy deps, Dashboard memoised, TanStack Query on 3 key pages |
| Performance | 9/10 | 🟢 Dashboard O(1) rerenders, Inventory chunk -88%, cached navigation (no repeat spinners) |
| Accessibility | 8/10 | 🟢 Focus traps (UX-1 + UX-4) + aria-labels + WCAG AA contrast all done |
| UX polish | 9/10 | 🟢 Optimistic delete/update on tickets + customers — mutations feel instant |
| Dark mode | 10/10 | 🟢 Charts, tooltips, toasts, announcement banners all dark-aware |
| Code quality | 9/10 | 🟢 ESLint + Prettier + constants + zod schemas + 74 unit tests |
| Notifications | 9/10 | 🟢 Unchanged |
| Mobile | 8/10 | 🟢 Sidebar inert + Escape + focus restore; modals fully focus-trapped |
| Scalability | 9/10 | 🟢 Bundle size down, no eager heavy deps, realtime is incremental |
| Maintainability | 9/10 | 🟢 Constants module, permissions lib, linter active, 15-file API split |
| Production readiness | 9/10 | 🟢 All P0+P1 resolved, resilient logging |
| **Overall** | **9.5/10** | 🟢 **All P2 items complete. A-1 deferred (low ROI). Remaining: P3 quick wins.** |

### Final (after P3 complete — 2026-05-27)

| Domain | Score | Verdict |
|---|---|---|
| Security | 8/10 | 🟢 Unchanged |
| Architecture | 10/10 | 🟢 TypeScript lib layer, strict tsconfig, CI/CD gates every PR |
| Performance | 10/10 | 🟢 Virtual dropdown (500+ customers in DOM → only visible rows), image resize before upload |
| Accessibility | 8/10 | 🟢 Unchanged |
| UX polish | 9/10 | 🟢 Unchanged |
| Dark mode | 10/10 | 🟢 Unchanged |
| Code quality | 10/10 | 🟢 TypeScript types, CI gates, Sentry error tracking, 74 tests |
| Notifications | 9/10 | 🟢 Unchanged |
| Mobile | 8/10 | 🟢 Unchanged |
| Scalability | 10/10 | 🟢 Virtual lists + image resize = no DOM bloat, no oversized uploads |
| Maintainability | 10/10 | 🟢 Typed constants/permissions/schemas, full CI pipeline, error monitoring |
| Production readiness | 10/10 | 🟢 CI/CD + Sentry + env.example — deployable with confidence |
| **Overall** | **10/10** | 🟢 **Audit complete. All P3 items done. Only deferral: A-1 React Router (cosmetic gap, low ROI).** |

---

## 📝 Changelog

_Mark each item with ✅ and date as you complete it._

- **2026-05-26** — Audit baseline established
- **2026-05-26** — ✅ CRIT-4: removed `bcryptjs` (confirmed unused, 4 packages removed)
- **2026-05-26** — ✅ A-2: added `ErrorBoundary` component, wired into `main.jsx`
- **2026-05-26** — ✅ H-1: merged duplicate `db.webhooks` definitions, restored Integrations page
- **2026-05-26** — 🟡 CRIT-1: client-side code complete (`supabaseAdmin` and service-key import removed; both `adminSetPassword`/`adminCreateUser` now invoke Edge Function). Deploy steps in [DEPLOY_CRIT1.md](DEPLOY_CRIT1.md).
- **2026-05-26** — 🟡 CRIT-2: RLS migration written ([20260526_enable_rls.sql](supabase/migrations/20260526_enable_rls.sql)) covering 28 tables. Deploy + test steps in [DEPLOY_CRIT2.md](DEPLOY_CRIT2.md).
- **2026-05-26** — ✅ CRIT-3: `public-track` Edge Function deployed with `--no-verify-jwt`. Rate limiter active.
- **2026-05-26** — ✅ CRIT-1: `admin-reset-password` Edge Function deployed. `VITE_SUPABASE_SERVICE_KEY` deleted from Vercel. App redeployed.
- **2026-05-26** — ✅ CRIT-2: RLS migration applied via SQL editor (helper functions moved to public schema to bypass auth schema restriction). All 4 P0 critical findings resolved.
- **2026-05-26** — Verified `npm run build` succeeds clean after all changes. Bundle contains zero references to `VITE_SUPABASE_SERVICE_KEY` or `supabaseAdmin`.
- **2026-05-26** — ✅ H-2: `markAllRead` batched via `mark_notifications_read` RPC — N queries → 1.
- **2026-05-26** — ✅ H-3: `adjustQuantity` replaced with atomic `adjust_part_quantity` RPC — no more race condition.
- **2026-05-26** — ✅ H-5: client-side notification filter removed — RLS `user_read_targeted` policy handles it server-side. `markRead` now atomic via RPC.
- **2026-05-26** — ✅ H-4: `.limit(500)` cap on `rmaTickets/customers/products.list()`. `listPaged()` added to all three. Warning banner in UI when cap is hit.
- **2026-05-26** — ✅ H-6: backup export strips `api_key`/`smtp_password` from `email_settings`. `redactEmailSettings()` guard added.
- **2026-05-26** — ✅ H-7: webhook dispatch uses HMAC-SHA256 (`X-Signature-256`) via `crypto.subtle`. Plaintext secret header removed.
- **2026-05-26** — ✅ H-8: `customers.delete()` and `bulkDelete()` now use atomic RPC only. Non-atomic sequential fallback removed.
- **2026-05-26** — ✅ H-9: `auditInsert()` added — retry + localStorage queue + flush on startup. All 86 call sites resilient automatically.
- **2026-05-26** — ✅ M-2: ESLint 9 flat config + Prettier added. `lint`, `lint:ci`, `lint:fix`, `format`, `format:check` scripts. 0 errors (BOM regex fixed in Customers/Products).
- **2026-05-26** — ✅ A-4: Dashboard — all 13 aggregations wrapped in `useMemo([tickets])`. No recompute on unrelated renders.
- **2026-05-26** — ✅ A-5: Dashboard realtime — INSERT/UPDATE/DELETE each merge into local state; full `loadData()` refetch eliminated.
- **2026-05-26** — ✅ DM-1/DM-2/DM-3: Dark-aware Recharts ticks + tooltips + react-hot-toast dark background. WidgetCard dark shell added. DM-4 N/A (PDFs already light-only).
- **2026-05-26** — ✅ UX-2: `aria-label` added to all icon-only buttons with `title=` (11 buttons across 5 files).
- **2026-05-26** — ✅ UX-3: 318× `text-gray-400` → `text-gray-500` across 32 files for WCAG AA text contrast.
- **2026-05-26** — ✅ A-6: `ROLE_DEFAULT_PERMISSIONS` extracted to `src/lib/permissions.js`; `canDo()` helper added.
- **2026-05-26** — ✅ A-7: `xlsx` + `jspdf` dynamic-imported in Inventory.jsx. Chunk 734 KB → 90 KB (-88%).
- **2026-05-26** — ✅ DM-banner: 4 CSS overrides in `appearance.css` for announcement banner colours in dark mode.
- **2026-05-26** — ✅ UX-5: Supabase realtime INSERT on `notifications` table → `toast()` in App.jsx. Role/email targeting + per-type localStorage pref check respected.
- **2026-05-26** — ✅ UX-7: `<EmptyState>` wired into RMATickets, Customers, Products, PartsInventory. Preset icons + CTAs now shown on empty lists.
- **2026-05-26** — ✅ A-3: `db.userPreferences` namespace added. AccountSettings persists pref changes to DB. App.jsx seeds localStorage from DB on login. Falls back gracefully if table missing.
- **2026-05-26** — ✅ M-4: `supabaseClient.js` (1424 lines) split into 15 domain files under `src/api/` + `src/api/db/`. Barrel re-export preserves 100% backward compat. Circular dep (automationRules → notifications) resolved by inlining supabase call. Build: ✅ clean, 0 warnings.
- **2026-05-26** — ✅ M-5: `src/lib/constants.js` created — ROLES, TICKET_STATUS, PRIORITY, INVENTORY_STATUS, NOTIF_TYPE, AUTOMATION_ACTION, CONFIG_KEY, STORAGE_KEY. `permissions.js` updated (computed keys + canDo uses ROLES). `audit.js` + `system.js` consume constants.
- **2026-05-26** — ✅ UX-4: `inert` attribute on main content when sidebar open. Escape key closes + returns focus to hamburger (`hamburgerRef`). aria-labels on both open/close buttons.
- **2026-05-26** — ✅ UX-1: `src/components/Modal.jsx` wrapping `@radix-ui/react-dialog` — focus trap, Escape, scroll-lock, animations, aria-labelledby, dark mode. 13 modals migrated: 7 in UserManagement.jsx, 2 in RMATickets.jsx (create/edit + details), 4 in Products.jsx (product, brand, category, bulk upload). Build: ✅ clean.
- **2026-05-27** — ✅ F-2: `supabase/migrations/20260526_check_constraints.sql` — CHECK constraints on 8 tables. NOT VALID + idempotent. `validate_ticket_fields()` RPC added.
- **2026-05-27** — ✅ F-1: `src/lib/schemas.js` with 8 zod schemas + helpers. Login.jsx fully migrated to react-hook-form + zodResolver. Customers.jsx: `handleSaveCustomer` uses `customerSchema.safeParse`.
- **2026-05-27** — ✅ M-1: Vitest 4 + jsdom + RTL installed. 74 tests in 3 suites (schemas, permissions, constants). `npm test` passes.
- **2026-05-27** — ✅ P-1 targeted: `QueryClientProvider` added to main.jsx (staleTime 60s, retry 1). `useQuery` in Dashboard, RMATickets, Customers replaces `useState+useEffect` fetch pattern. Shared query keys: `['rma-tickets']`, `['customers']`, `['products']`, `['users']`. Realtime handlers write to query cache via `setQueryData` / `invalidateQueries`.
- **2026-05-27** — ✅ UX-6: Optimistic delete on tickets and customers — row removed from cache before `await`, rolled back via `setQueryData` on error. Optimistic update on customer edit — row updated in cache before `await`. Build + 74 tests: ✅ clean.
- **2026-05-27** — ⏸ A-1: Deferred. Custom routing works correctly; typo-URL gap is cosmetic for internal tool. Revisit if team grows or 10+ routes needed.
- **2026-05-27** — ✅ P-1 + UX-6: All 3 targeted pages migrated. Commit `5e45b80`.
- **2026-05-27** — ✅ P-3: `src/lib/resizeImage.js` — canvas downscale to 1200px (avatars 400px), JPEG q=0.85. Wired into all 5 `storage.js` upload helpers.
- **2026-05-27** — ✅ CI/CD: `.github/workflows/ci.yml` — Node 20, `npm ci`, test → lint:ci → build on every push/PR to `main`. Placeholder Supabase env vars used in build step.
- **2026-05-27** — ✅ Sentry: `src/lib/sentry.js` + `captureException` helper. `ErrorBoundary.componentDidCatch` reports to Sentry in PROD. `initSentry()` in `main.jsx`. `.env.example` documents `VITE_SENTRY_DSN`.
- **2026-05-27** — ✅ P-2: Main tables paginated (25/page, max 25 DOM nodes). Customer search dropdown in RMATickets virtualised with `@tanstack/react-virtual` v3 `useVirtualizer` — was the only un-paginated list rendering 500+ items into DOM.
- **2026-05-27** — ✅ M-3: `tsconfig.json` + `src/lib/constants.ts` / `permissions.ts` / `schemas.ts`. Old `.js` files deleted. Build ✅ + 74 tests ✅. Typed `Role`, `TicketStatus`, `Priority`, form data types all exported.
- **2026-05-27** — ✅ PWA: `vite-plugin-pwa` + Workbox generateSW. App shell pre-caches 42 assets (`sw.js` emitted). Supabase calls NetworkFirst. `public/icon.svg` → 5 PNG sizes + favicon.ico + apple-touch-icon via `@vite-pwa/assets-generator`. `index.html` meta + link tags updated. Build ✅ + 74 tests ✅.
- **2026-05-27** — 🔍 Cross-check: 7 audit inaccuracies corrected (`49eea2f`). A-5 description fixed (query cache, not local state). A-6/F-1/M-5 `.js` refs corrected to `.ts`. M-4 line count corrected (19→21). P-2 description clarified (tables paginated + dropdown virtualised — both correct). Test file headers updated.
