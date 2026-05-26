# myRMA Enterprise Audit — Progress Tracker

> Audit date: 2026-05-26
> Baseline commit: `5085ad2` + post-rollback UI fixes
> Overall score: **5/10** — functional but blocked from production by security findings

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
| ☐ | H-6 | Backup export includes plaintext SMTP/SendGrid API keys | `backup` namespace | Strip `email_settings` secrets from export, or encrypt with user passphrase |
| ☐ | H-7 | Webhook secret sent as plaintext header (no HMAC) | Webhook delivery | HMAC-SHA256 signature: `X-Signature-256: sha256=<hex>` |
| ☐ | H-8 | Customer bulk delete fallback is non-atomic sequential | supabaseClient.js | Require RPC or wrap fallback in transactional Postgres function |
| ☐ | H-9 | Fire-and-forget audit logging silently drops events | App.jsx:274, 287 | Surface failures + retry; or DB-trigger-based audit log |
| ✅ | A-2 | No global ErrorBoundary — any render error = white screen | [main.jsx](src/main.jsx) | **Done 2026-05-26.** Added [src/components/ErrorBoundary.jsx](src/components/ErrorBoundary.jsx) with fallback UI (reload/home), dev-only stack trace, dark mode support. Wraps `<App>` in main.jsx. |

---

## 🟡 P2 — MEDIUM (Frontend Architecture, 1 Month)

| ✅ | ID | Finding | Location | Fix |
|----|----|---------|----------|-----|
| ☐ | A-1 | No React Router — manual `pathToPage` mapping; typo URLs land on Dashboard | [App.jsx:97-119](src/App.jsx#L97-L119) | Migrate to React Router v6 |
| ☐ | A-3 | Notification prefs in `localStorage` only — resets on new device | App.jsx:191-194 | Persist to `user_preferences` table; localStorage = cache |
| ☐ | A-4 | Dashboard recomputes 8+ aggregations every render | [Dashboard.jsx:169-243](src/pages/Dashboard.jsx#L169-L243) | Wrap each in `useMemo([tickets])` |
| ☐ | A-5 | Dashboard realtime refetches everything on each event | [Dashboard.jsx:119-124](src/pages/Dashboard.jsx#L119-L124) | Merge payload into local state instead of refetching |
| ☐ | A-6 | `ROLE_DEFAULT_PERMISSIONS` lives in App.jsx (40 lines) | [App.jsx:52-95](src/App.jsx#L52-L95) | Move to `src/lib/permissions.js` + `canDo(role, perms, section, action)` helper |
| ☐ | A-7 | Heavy deps eagerly loaded (~1.5MB initial bundle) | xlsx, jspdf, html2canvas, recharts | Dynamic-import inside event handlers: `const XLSX = await import('xlsx')` |
| ☐ | P-1 | Adopt TanStack Query for all data fetching | All pages | Replace manual `useState + useEffect` patterns with `useQuery`/`useMutation` + optimistic updates |
| ☐ | M-1 | Zero unit/E2E tests | — | Vitest for components, Playwright for smoke flows |
| ☐ | M-2 | No ESLint config | — | Add ESLint + Prettier with React rules |
| ☐ | M-4 | `supabaseClient.js` is 1350 lines | src/api/supabaseClient.js | Split: `auth.js`, `db/tickets.js`, `db/customers.js`, `db/products.js`, `db/notifications.js`, `db/parts.js`, `db/backup.js` |

---

## 🟡 P2 — MEDIUM (UX & Accessibility, 1 Month)

| ✅ | ID | Finding | Fix |
|----|----|---------|-----|
| ☐ | UX-1 | Modals don't trap focus | Use Radix Dialog (already installed) for all modals |
| ☐ | UX-2 | Icon-only buttons missing `aria-label` | Audit `<button><svg>…` patterns, add labels |
| ☐ | UX-3 | `text-gray-400` on white = WCAG ratio 2.85 (fails AA) | Replace with `text-gray-500` (ratio 4.57) for text under 18pt |
| ☐ | UX-4 | Mobile sidebar doesn't trap focus | Add `inert` to main when sidebar open |
| ☐ | UX-5 | No realtime toast for new notifications | Hook realtime INSERT → `toast()` |
| ☐ | UX-6 | No optimistic UI on CRUD actions | TanStack `useMutation` with `onMutate`/`onError` |
| ☐ | UX-7 | Empty states lack CTAs and illustrations | Add `<EmptyState>` component |
| ☐ | F-1 | `zod` + `react-hook-form` installed but used inconsistently | Standardize on `useForm({ resolver: zodResolver(schema) })` |
| ☐ | F-2 | No server-side validation visible | Add Postgres CHECK constraints + RPC validation |

---

## 🟡 P2 — Dark Mode Gaps

| ✅ | Issue | Where | Fix |
|----|-------|-------|-----|
| ☐ | Recharts tick text not dark-aware | All Dashboard charts | `tick={{ fill: 'currentColor' }}` + theme-aware parent |
| ☐ | Recharts tooltip stays white | All charts | Custom `<Tooltip contentStyle={…}>` with CSS var |
| ☐ | `bg-blue-600`/`bg-green-600` saturated banners not overridden | Announcement banner | Add `html.dark .bg-blue-600 { background-color: #1e40af !important; }` etc. |
| ☐ | `react-hot-toast` toasts have no dark theme | All pages | `<Toaster toastOptions={{ className: 'dark:bg-slate-800 dark:text-slate-100' }} />` |
| ☐ | PDF export tracks theme (should stay light) | Invoices, labels | Force light rendering always |

---

## 🟢 P3 — Quarter

| ✅ | ID | Finding | Fix |
|----|----|---------|-----|
| ☐ | M-3 | No TypeScript despite `@types/react` installed | Incremental `.jsx` → `.tsx` migration |
| ☐ | M-5 | Magic strings (`'super_admin'`, `'Closed'`, …) everywhere | Extract to enums/constants module |
| ☐ | P-2 | No virtualization on long lists | `@tanstack/react-virtual` for tables >100 rows |
| ☐ | P-3 | Image uploads not resized | Client-side resize to 1200px max before Storage upload |
| ☐ | — | No service worker / PWA manifest | Add Vite PWA plugin + offline shell |
| ☐ | — | No error reporting | Wire Sentry to ErrorBoundary + supabase calls |
| ☐ | — | No CI/CD with test gating | GitHub Actions: run Vitest + Playwright on PR; block merge on red |

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

### Current (after P0 + P1 H-1..H-5 complete)

| Domain | Score | Verdict |
|---|---|---|
| Security | 7/10 | 🟢 RLS on, service key hidden, tracker rate-limited |
| Architecture | 7/10 | 🟢 ErrorBoundary added, webhooks fixed |
| Performance | 7/10 | 🟢 Pagination cap, atomic RPCs, no N+1 |
| Accessibility | 4/10 | 🟡 No focus traps, contrast gaps |
| UX polish | 7/10 | 🟢 Good baseline |
| Dark mode | 7/10 | 🟢 Comprehensive, chart gaps |
| Code quality | 5/10 | 🟡 No tests/linter/types |
| Notifications | 8/10 | 🟢 Server-side filtered, atomic reads |
| Mobile | 6/10 | 🟡 Responsive, missing focus traps |
| Scalability | 6/10 | 🟡 500-row cap + listPaged() added |
| Maintainability | 4/10 | 🟠 Magic strings, monolithic API |
| Production readiness | 7/10 | 🟢 All P0 blockers resolved |
| **Overall** | **7/10** | 🟢 **Safe to ship. P1 remainder improves stability.** |

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
