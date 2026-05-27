# myRMA Enterprise — Audit Log

> **Audit period:** 2026-05-26 → 2026-05-27 (initial) · 2026-05-27 (full system test)
> **Baseline commit:** `5085ad2` + post-rollback UI fixes
> **Latest score:** 6/10 (full system test 2026-05-27) — 14 new findings; CI broken; see [Full System Test section](#-full-system-test--2026-05-27)

---

## Contents

- [P0 — Critical findings + deploy guides](#-p0--critical-production-blockers)
- [P1 — High findings](#-p1--high-data-integrity--architecture)
- [P2 — Medium findings](#-p2--medium-frontend-architecture)
- [P3 — Quarter findings](#-p3--quarter)
- [Full System Test — 2026-05-27](#-full-system-test--2026-05-27)
- [Scorecard](#-scorecard)
- [Changelog](#-changelog)

---

## 🔴 P0 — Critical (Production Blockers)

| ✅ | ID | Finding | Location | Status |
|----|----|---------|----------|--------|
| ✅ | CRIT-1 | Supabase service role key exposed to browser via `VITE_SUPABASE_SERVICE_KEY` | [src/api/auth.js](src/api/auth.js) | **Done 2026-05-26.** `admin-reset-password` Edge Function deployed; service key deleted from Vercel. **Fixed 2026-05-27:** Edge Function now creates new auth users when they don't exist yet (`adminCreateUser` was returning 404 — fixed with `createUser` path). |
| ✅ | CRIT-2 | No Row Level Security — all permission checks client-side | All tables | **Done 2026-05-26.** RLS on 28 tables. Helper functions: `public.rma_user_role()`, `public.rma_is_admin()`, `public.rma_is_manager_or_above()`, `public.rma_is_staff()`. Migration: [20260526_enable_rls.sql](supabase/migrations/20260526_enable_rls.sql). |
| ✅ | CRIT-3 | Public `/tracker` route has no rate limit / abuse protection | [supabase/functions/public-track/index.ts](supabase/functions/public-track/index.ts) | **Done 2026-05-26.** Edge Function `public-track` — 15 req/min, whitelisted columns, no direct DB access. **Done 2026-05-27 (follow-up):** Storage bucket anon-upload capped at 25 MB, JPEG/PNG/GIF/WebP/PDF only. Migration: [20260527_storage_bucket_policies.sql](supabase/migrations/20260527_storage_bucket_policies.sql). |
| ✅ | CRIT-4 | `bcryptjs` in browser bundle (anti-pattern or dead weight) | package.json | **Done 2026-05-26.** Confirmed zero usage in src/; package uninstalled. |

---

### CRIT-1 Deploy Guide — Service Key Removal

⚠️ **DO THESE STEPS IN ORDER.** Skipping or reordering will break super_admin password reset / new user creation.

#### Step 1 — Deploy the Edge Function (5 min)

```powershell
supabase functions deploy admin-reset-password
```

Expected output: `Deployed Function admin-reset-password on project <your-project-ref>`

Verify in Supabase Dashboard → Edge Functions → `admin-reset-password` → status **Active**.

#### Step 2 — Test the Edge Function BEFORE removing the browser service key (5 min)

1. Open the app, log in as **super_admin**
2. Control Panel → User Management → reset another user's password → should succeed
3. Create a new user → should succeed and be able to log in

If either fails: Supabase Dashboard → Edge Functions → admin-reset-password → Logs. Common causes:
- `SUPABASE_SERVICE_ROLE_KEY` not injected (auto-injected by Supabase; check function env)
- Caller is not `super_admin` in `user_roles` table

#### Step 3 — Rotate the service key (2 min)

🔴 **Do this even if the key was never publicly exposed** — it will be in browser caches, build artifacts, and possibly Git history.

1. Supabase Dashboard → Settings → API → Project API keys
2. **Reset** `service_role` → confirm
3. Edge Function picks up the new key automatically (injected env var). Test admin password reset once more.

#### Step 4 — Remove the key from `.env` and Vercel (3 min)

Delete from local `.env`:
```
VITE_SUPABASE_SERVICE_KEY=...
```

Vercel Dashboard → project → Settings → Environment Variables → delete `VITE_SUPABASE_SERVICE_KEY` → redeploy.

#### Step 5 — Verify the bundle no longer contains the key (1 min)

```powershell
npm run build
Select-String -Path "dist/**/*.js" -Pattern "VITE_SUPABASE_SERVICE_KEY|service_role"
```

Expected: **zero matches**. Also check DevTools → Sources → search for "service_role" in the production app.

#### Step 6 — Final live test (5 min)

Log in as super_admin on production:
- ✅ Reset another user's password
- ✅ Create a new user (tests the create-if-missing path added 2026-05-27)
- ✅ Browse tickets, customers, products — no errors
- ✅ Browser console — no errors

#### Rollback (if admin ops fail after Step 4)

1. Add the (already-rotated) new service key back to Vercel temporarily as `VITE_SUPABASE_SERVICE_KEY`
2. Check Edge Function logs and network tab to diagnose
3. Once fixed, redo Step 4

Note: the client code in [src/api/auth.js](src/api/auth.js) no longer reads `VITE_SUPABASE_SERVICE_KEY` — adding the env var back will not restore old behaviour without reverting the commit.

---

### CRIT-2 Deploy Guide — Row Level Security

⚠️ **THIS WILL LOCK DOWN YOUR DATABASE.** Read every step before running.

🛡️ The migration is idempotent. Re-running is safe. If something breaks, disable RLS on the affected table (see Step 6).

#### Pre-flight checks

1. **CRIT-1 must be deployed first.** RLS blocks browser service keys. If you still have the old key in `.env`, admin ops will fail once RLS is on.
2. **Confirm `user_roles` is populated.** Every user who logs in must have a row. No row = locked out after RLS activates.
3. **Take a backup.** Supabase Dashboard → Database → Backups → Create manual backup.

#### Step 1 — Apply the migration (5 min)

```powershell
supabase db push
```

Or paste [supabase/migrations/20260526_enable_rls.sql](supabase/migrations/20260526_enable_rls.sql) into Dashboard → SQL Editor → Run.

Uses `IF EXISTS` / `DROP POLICY IF EXISTS` throughout — safe to re-run.

#### Step 2 — Verify RLS is on (1 min)

```sql
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public' AND tablename IN (
  'rma_tickets','customers','products','user_roles','notifications',
  'invoices','parts','inventory_units','email_settings','webhooks'
)
ORDER BY tablename;
```

Every row should show `rowsecurity = true`.

#### Step 3 — List active policies (1 min)

```sql
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
```

#### Step 4 — Test as each role 🧪 (15–20 min — DO NOT SKIP)

Use a fresh incognito window for each role.

**super_admin**
- [ ] Log in → Dashboard loads
- [ ] Can view tickets, customers, products, inventory, invoices
- [ ] Can create + edit + delete a test ticket
- [ ] Can open Control Panel
- [ ] Can reset another user's password
- [ ] Can create a new user

**admin**
- [ ] Same as super_admin except cannot demote a super_admin

**manager**
- [ ] Can view tickets, customers, products
- [ ] Can create + edit tickets, customers, products
- [ ] CANNOT delete (delete is admin+)
- [ ] CANNOT see Control Panel or User Management

**technician**
- [ ] Can view tickets
- [ ] Can edit ONLY tickets where `assigned_technician = their email`
- [ ] Edit attempt on someone else's ticket → fails with error
- [ ] Can add comments
- [ ] CANNOT create customers or products

**viewer**
- [ ] Can view tickets, customers, products (read-only)
- [ ] Cannot create / edit / delete anything

**anon**
- [ ] `/tracker` works (via Edge Function — CRIT-3)
- [ ] Direct DB query from devtools console returns permission error

#### Step 5 — If a role gets locked out

```sql
-- Check the user has a row in user_roles
SELECT * FROM user_roles WHERE user_email = '<their_email>';
```

No row → insert one. Row exists but still blocked → check the policy; the helper functions are in `public` schema:

```sql
-- These are the correct function names (NOT auth.user_role etc.)
SELECT public.rma_user_role();
SELECT public.rma_is_staff();
```

Note: SQL Editor runs without a user JWT so these return null there — run from the app console instead.

#### Step 6 — Emergency rollback

Disable RLS on one table:
```sql
ALTER TABLE public.rma_tickets DISABLE ROW LEVEL SECURITY;
```

Disable on all tables (nuclear — undoes the whole migration):
```sql
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;
```

#### Known limitations (intentional — refine later if needed)

- **Technicians read all tickets.** App filters client-side. To enforce server-side, update `staff_read` on `rma_tickets`:
  ```sql
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'technician' AND assigned_technician = public.rma_current_user_email())
    OR (public.rma_user_role() = 'viewer')
  )
  ```
  Defer until you verify no Dashboard widgets break.
- **No per-customer scoping.** All staff read all customers.
- **`announcements`** visible to all staff regardless of `target_roles`; client filters.
- **`time_entries` for managers** — all entries visible (intended for payroll review).

---

### CRIT-3 Deploy Guide — Public Tracker Lockdown

⚠️ **Run AFTER CRIT-2 is deployed.**

#### What changed

- `public-track` Edge Function handles all three tracker operations server-side (lookup, comments, addComment)
- Rate limit: 15 req/min per IP (in-memory per function instance)
- Input validation: RMA number ≤ 64 chars, comment ≤ 5000 chars, author name ≤ 120 chars
- Whitelisted columns: never returns `assigned_technician`, `internal_notes`, or staff-only fields
- `db.rmaTracker` in [src/api/db/tickets.js](src/api/db/tickets.js) invokes the Edge Function — `RMATracker.jsx` unchanged

#### Step 1 — Deploy the Edge Function (2 min)

```powershell
supabase functions deploy public-track --no-verify-jwt
```

`--no-verify-jwt` is **required** — the public tracker has no authenticated user. The function validates input manually and uses service_role internally.

Verify: Supabase Dashboard → Edge Functions → `public-track` → **Active**.

#### Step 2 — Test the public tracker (3 min)

1. Open an incognito window
2. Go to `/tracker`
3. Enter a valid RMA number → should show details, status, comments
4. Post a comment as a customer → should appear

Troubleshoot: DevTools → Network → find the `public-track` request → check response. `401 Unauthorized` means you forgot `--no-verify-jwt` on deploy.

#### Step 3 — Verify anon can't bypass RLS (1 min)

In incognito devtools console:
```js
const { data, error } = await window.supabase.from('rma_tickets').select('*').limit(1)
console.log(error) // expect: permission denied
```

If this returns data, RLS is not enforced — go back to CRIT-2.

#### Step 4 — Test rate limiting (2 min)

```js
for (let i = 0; i < 20; i++) {
  fetch('https://<your-project>.supabase.co/functions/v1/public-track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'lookup', rmaNumber: 'TEST-000' })
  }).then(r => console.log(i, r.status))
}
```

Requests 16+ should return `429 Too many requests`.

#### Step 5 — Storage bucket policies (2 min)

```powershell
supabase db push
```

This applies [supabase/migrations/20260527_storage_bucket_policies.sql](supabase/migrations/20260527_storage_bucket_policies.sql):

| Policy | Role | Rule |
|--------|------|------|
| `public_upload_small` | anon | `rma-attachments` only · max 25 MB · JPEG/PNG/GIF/WebP/PDF |
| `public_read` | anon | Read from `rma-attachments` (so attachment URLs work) |
| `authenticated_full` | authenticated | Full access |

Verify: open `/tracker` in incognito, post a comment with a file → uploads and link loads. Try uploading a `.exe` → storage error.

---

## 🟠 P1 — High (Data Integrity + Architecture)

| ✅ | ID | Finding | Location | Fix |
|----|----|---------|----------|-----|
| ✅ | H-1 | Duplicate `db.webhooks` definition — second overwrites first | supabaseClient.js (was :527, :1015) | **Done 2026-05-26.** Merged: kept table-based CRUD, added `dispatch()` method, deleted duplicate rma_config-based block. Integrations page no longer silently broken. |
| ✅ | H-2 | N+1 query in `markAllRead` | supabaseClient.js (was :820-836) | **Done 2026-05-26.** RPC `mark_notifications_read(p_email, p_ids)` — single batched UPDATE replaces N queries. |
| ✅ | H-3 | Race condition in `parts.adjustQuantity` (read-modify-write) | supabaseClient.js (was :906-912) | **Done 2026-05-26.** RPC `adjust_part_quantity(p_id, p_delta)` — atomic `GREATEST(0, quantity + delta)`. |
| ✅ | H-4 | All list endpoints return full tables, no pagination | `rmaTickets.list`, `customers.list`, `products.list` | **Done 2026-05-26.** `.limit(500)` safety cap on all three. `listPaged(page, pageSize)` returns `{ data, count, totalPages }`. Warning banner shown in UI when cap is hit. |
| ✅ | H-5 | Notifications filtered client-side after fetching all rows (privacy leak) | supabaseClient.js (was :796-808) | **Done 2026-05-26.** Client-side filter removed — RLS policy `user_read_targeted` handles it server-side. `markRead` uses `mark_notifications_read` RPC (atomic). |
| ✅ | H-6 | Backup export includes plaintext SMTP/SendGrid API keys | `backup` namespace | **Done 2026-05-26.** `exportAll()` selects only non-secret columns. `redactEmailSettings()` replaces known secret fields with `[REDACTED]`. User must re-enter API keys after restore. |
| ✅ | H-7 | Webhook secret sent as plaintext header (no HMAC) | Webhook delivery | **Done 2026-05-26.** `dispatch()` signs body with `crypto.subtle` HMAC-SHA256, sends `X-Signature-256: sha256=<hex>`. Secret never travels over the wire. |
| ✅ | H-8 | Customer bulk delete fallback is non-atomic sequential | supabaseClient.js | **Done 2026-05-26.** Both `delete()` and `bulkDelete()` use atomic RPC only. Throws clear error if RPC missing. |
| ✅ | H-9 | Fire-and-forget audit logging silently drops events | App.jsx (was :274, :287) | **Done 2026-05-26.** `auditInsert()` in [src/api/db/audit.js](src/api/db/audit.js): retry after 600ms → queue to localStorage (capped 50) → flush on next success or app startup. All 86 call sites resilient automatically. |
| ✅ | A-2 | No global ErrorBoundary — any render error = white screen | [src/main.jsx](src/main.jsx) | **Done 2026-05-26.** [src/components/ErrorBoundary.jsx](src/components/ErrorBoundary.jsx) — fallback UI, dev-only stack trace, dark mode, `captureException` wired in. Wraps `<App>` in main.jsx. |

---

## 🟡 P2 — Medium (Frontend Architecture)

| ✅ | ID | Finding | Location | Fix |
|----|----|---------|----------|-----|
| ✅ | A-1 | No React Router — manual `pathToPage` mapping; typo URLs land on Dashboard | App.jsx | **Done 2026-05-27.** React Router v6: `BrowserRouter` in `main.jsx`; `useNavigate` + `useLocation` in App.jsx. 13 routes via `<Routes>`/`<Route>`. `ProductDetailsRoute` + `CustomerDetailsRoute` wrappers use `useParams()`. `NotFoundPage` `*` catch-all — typo URLs show 404. Removed `pathToPage()`, `pageToPath()`, `popstate` listener, `currentPage` state. Note: `RMATickets.jsx` retains one `pushState` for within-route ticket URL sync (`?ticket=<id>`) — intentional in-page state, not top-level routing. Build ✅ + 74 tests ✅. |
| ✅ | A-3 | Notification prefs in `localStorage` only — resets on new device | App.jsx (was :191-194) | **Done 2026-05-26.** `db.userPreferences` added. AccountSettings persists every pref change to DB. App.jsx seeds localStorage from DB on login. Falls back gracefully if table missing. |
| ✅ | A-4 | Dashboard recomputes 8+ aggregations every render | Dashboard.jsx | **Done 2026-05-26.** All 13 aggregations wrapped in `useMemo([tickets])`. |
| ✅ | A-5 | Dashboard realtime refetches everything on each event | Dashboard.jsx | **Done 2026-05-26.** INSERT/UPDATE/DELETE each merge payload into the **query cache** via `queryClient.setQueryData(['rma-tickets'], …)` — no full refetch. |
| ✅ | A-6 | `ROLE_DEFAULT_PERMISSIONS` lives in App.jsx (40 lines) | App.jsx (was :52-95) | **Done 2026-05-26.** Moved to [src/lib/permissions.ts](src/lib/permissions.ts) + `canDo()` helper exported. |
| ✅ | A-7 | Heavy deps eagerly loaded (~1.5 MB initial bundle) | xlsx, jspdf, html2canvas, recharts | **Done 2026-05-26.** `xlsx` + `jspdf` dynamic-imported in Inventory.jsx export handlers. Inventory chunk: 734 KB → 90 KB (−88%). |
| ✅ | P-1 | Adopt TanStack Query for all data fetching | All pages | **Done 2026-05-27 (targeted).** `QueryClientProvider` (staleTime 60s) in main.jsx. `useQuery` on RMATickets, Dashboard, Customers. Return navigation shows cached data instantly — no repeat spinner. Realtime handlers write to query cache via `setQueryData` / `invalidateQueries`. |
| ✅ | M-1 | Zero unit/E2E tests | — | **Done 2026-05-27.** Vitest + jsdom + RTL. 74 tests in 3 suites: `constants.test.js`, `permissions.test.js`, `schemas.test.js`. `npm test` / `npm run test:coverage`. |
| ✅ | M-2 | No ESLint config | — | **Done 2026-05-26.** ESLint 9 flat config + Prettier. 0 errors. `npm run lint` / `npm run lint:ci` / `npm run format`. |
| ✅ | M-4 | `supabaseClient.js` is 1,350 lines | src/api/supabaseClient.js | **Done 2026-05-26.** Split into 15 domain files under `src/api/` + `src/api/db/`. `supabaseClient.js` is now a 21-line barrel re-export. 100% backward compatible. |

---

## 🟡 P2 — Medium (UX & Accessibility)

| ✅ | ID | Finding | Fix |
|----|----|---------|-----|
| ✅ | UX-1 | Modals don't trap focus | **Done 2026-05-26.** `src/components/Modal.jsx` wrapping `@radix-ui/react-dialog`. 13 modals migrated: 7 in UserManagement, 2 in RMATickets, 4 in Products. Focus trap + Escape + scroll-lock + aria-labelledby on all. |
| ✅ | UX-2 | Icon-only buttons missing `aria-label` | **Done 2026-05-26.** `aria-label` added to all icon-only buttons across App.jsx, PartsInventory, RMATickets, Invoices, NotificationBell. |
| ✅ | UX-3 | `text-gray-400` on white = WCAG ratio 2.85 (fails AA) | **Done 2026-05-26.** 318 replacements → `text-gray-500` (ratio 4.57, meets AA) across 32 files. |
| ✅ | UX-4 | Mobile sidebar doesn't trap focus | **Done 2026-05-26.** `inert` attribute on main content when sidebar open. Escape closes + returns focus to hamburger. aria-labels on open/close buttons. |
| ✅ | UX-5 | No realtime toast for new notifications | **Done 2026-05-26.** Supabase realtime INSERT on `notifications` → `toast()` with role/email targeting + per-type localStorage pref check in App.jsx. |
| ✅ | UX-6 | No optimistic UI on CRUD actions | **Done 2026-05-27.** Optimistic delete on tickets + customers (cache updated before `await`, rollback via `setQueryData` on error). Optimistic update on customer edits (row reflects change instantly). |
| ✅ | UX-7 | Empty states lack CTAs and illustrations | **Done 2026-05-26.** `<EmptyState>` wired into RMATickets, Customers, Products, PartsInventory. Inline placeholder divs removed. |
| ✅ | F-1 | `zod` + `react-hook-form` installed but used inconsistently | **Done 2026-05-27.** [src/lib/schemas.ts](src/lib/schemas.ts) — central schemas for login, customer, ticket, product, addUser + `getFirstError`/`getFieldErrors` helpers. Login.jsx fully on `useForm+zodResolver`. Customers.jsx: `handleSaveCustomer` uses `customerSchema.safeParse`. |
| ✅ | F-2 | No server-side validation visible | **Done 2026-05-27.** [supabase/migrations/20260526_check_constraints.sql](supabase/migrations/20260526_check_constraints.sql) — CHECK constraints on 8 tables (ticket_status, priority, user role/status, invoice status/type, notification type, inventory/batch/product/customer statuses). NOT VALID + idempotent. `validate_ticket_fields()` RPC returns JSON error list. |

---

## 🟡 P2 — Dark Mode Gaps

| ✅ | Issue | Where | Fix |
|----|-------|-------|-----|
| ✅ | Recharts tick text not dark-aware | All Dashboard charts | **Done 2026-05-26.** `chartTickStyle` with explicit fill from `darkMode` flag. |
| ✅ | Recharts tooltip stays white | All charts | **Done 2026-05-26.** All `<Tooltip>` get `contentStyle` with dark bg `#1e293b` / border `#334155`. |
| ✅ | `bg-blue-600`/`bg-green-600` banners not overridden | Announcement banner | **Done 2026-05-26.** 4 CSS rules in `appearance.css` override all announcement colour variants in dark mode. |
| ✅ | `react-hot-toast` toasts have no dark theme | All pages | **Done 2026-05-26.** All 4 `<Toaster>` get `toastOptions` with dark `#1e293b` background. |
| ✅ | PDF export tracks theme | Invoices, labels | **N/A — 2026-05-26.** PDFs use jsPDF with hardcoded light colours; no dark bleed. |

---

## 🔍 P-1 / A-1 Reassessment (2026-05-27)

Both were reassessed mid-audit for cost vs benefit before implementation.

### A-1 — React Router

Initially deferred (typo-URL gap cosmetic for internal tool). Implemented same day.

| | Detail |
|---|---|
| **Approach** | Full React Router v6. `BrowserRouter` in `main.jsx`. `useNavigate` + `useLocation` in App.jsx. |
| **Routes** | 13 `<Route>` declarations: all pages + `/dashboard` redirect + `*` `NotFoundPage`. |
| **Parameterised routes** | `/products/:id` and `/customers/:id` via thin `ProductDetailsRoute` / `CustomerDetailsRoute` wrappers — zero changes to detail page components. |
| **Removed** | `pathToPage()`, `pageToPath()`, `currentPage` / `selectedProductId` / `selectedCustomerId` state, `popstate` listener, all App.jsx `pushState` calls. |
| **Retained** | `selectedTicketId` state (cleared on away-navigation); `useURLTab` for in-page tab params; `/tracker` public-route detection via `pathname`. |

### P-1 — TanStack Query

Full migration (15+ pages, 8+ hrs) was too high risk. Targeted 3 pages instead.

| | Detail |
|---|---|
| **Original pattern** | Every page had `useState + useEffect` with spinner on every visit. No caching. |
| **Approach** | RMATickets + Dashboard + Customers only. These cover >80% of daily navigation. Other pages migrate incrementally. |
| **Result** | `staleTime: 60s` — return navigation shows cached data instantly. Realtime handlers write to query cache. UX-6 optimistic UI unlocked at the same time. |

---

## 🟢 P3 — Quarter

| ✅ | ID | Finding | Fix |
|----|----|---------|-----|
| ✅ | M-3 | No TypeScript despite `@types/react` installed | **Done 2026-05-27.** `tsconfig.json` (`moduleResolution: bundler`, `strict: true`, `noEmit: true`). `src/lib/constants.ts`, `permissions.ts`, `schemas.ts` — `as const` objects, exported `Role`/`TicketStatus`/`Priority` types, `z.infer<>` form data types, typed helpers. Build + 74 tests: ✅ clean. |
| ✅ | M-5 | Magic strings (`'super_admin'`, `'Closed'`, …) everywhere | **Done 2026-05-26.** [src/lib/constants.ts](src/lib/constants.ts) — `ROLES`, `TICKET_STATUS`, `PRIORITY`, `INVENTORY_STATUS`, `NOTIF_TYPE`, `AUTOMATION_ACTION`, `CONFIG_KEY`, `STORAGE_KEY`. `permissions.ts` uses `ROLES`. `audit.js` + `system.js` consume `CONFIG_KEY`, `AUTOMATION_ACTION`, `PRIORITY`. |
| ✅ | P-2 | No virtualisation on long lists | **Done 2026-05-27.** Two-pronged: (1) RMATickets, Customers, Products tables paginated at 25/page — max 25 DOM nodes. (2) Customer search dropdown in RMATickets virtualised with `@tanstack/react-virtual` v3 `useVirtualizer` (estimateSize 56px, overscan 3) — only visible rows rendered regardless of dataset size. |
| ✅ | P-3 | Image uploads not resized | **Done 2026-05-27.** [src/lib/resizeImage.js](src/lib/resizeImage.js) — canvas downscale to 1200px max (400px for avatars), JPEG q=0.85, PNG passthrough. Wired into all 5 `storage.js` upload helpers. No-op for non-image types. |
| ✅ | — | No service worker / PWA manifest | **Done 2026-05-27.** `vite-plugin-pwa` + Workbox `generateSW`. 42 assets pre-cached. Supabase API calls: NetworkFirst (10s timeout). `public/icon.svg` → 5 PNG sizes + favicon.ico + apple-touch-icon via `@vite-pwa/assets-generator`. Manifest: `standalone`, indigo `#4f46e5`, dark bg `#0f172a`. `index.html` updated. |
| ✅ | — | No error reporting | **Done 2026-05-27.** [src/lib/sentry.js](src/lib/sentry.js) — `initSentry()` no-op guard (requires `VITE_SENTRY_DSN`), `captureException()` helper (console in DEV, Sentry in PROD). `ErrorBoundary.componentDidCatch` calls `captureException`. `initSentry()` called in `main.jsx`. |
| ✅ | — | No CI/CD with test gating | **Done 2026-05-27.** [.github/workflows/ci.yml](.github/workflows/ci.yml) — ubuntu-latest, Node 20, `npm ci --legacy-peer-deps` → `npm test` → `npm run lint:ci` → `npm run build`. Runs on push to `main` and all PRs. Placeholder Supabase env vars used in build step. |

---

## 🧪 Full System Test — 2026-05-27

**Report:** [SYSTEM_TEST_REPORT_20260527.md](SYSTEM_TEST_REPORT_20260527.md)  
**Method:** Automated tests + full static analysis (Phases 1–3) + manual law compliance check (L-01 through L-15)

### Test Run Results

| Command | Result |
|---------|--------|
| `npm test` | ✅ 74/74 passed |
| `npm run test:coverage` | ✅ 92.59% stmts / 77.77% branches |
| `npm run lint:ci` | ❌ **FAIL** — 1 error + 162 warnings (163 problems) |
| `npm run format:check` | ❌ **FAIL** — 66 files with Prettier violations |
| `npm run build` | ⚠️ PASS with warning — `index` chunk 643 KB exceeds 500 KB threshold |

### New Findings (2026-05-27 Full System Test)

#### 🔴 Critical

| ID | Finding | File | Status |
|----|---------|------|--------|
| CRIT-NEW-1 | CI pipeline broken — `lint:ci` fails (1 error + 162 warnings) and `format:check` fails (66 files) | `Login.jsx:46`, 66 files | **Open** |

#### 🟠 High

| ID | Finding | File | Status |
|----|---------|------|--------|
| HIGH-NEW-1 | Main vendor bundle 643 KB — exceeds 500 KB threshold | `vite.config.js` / `index` chunk | **Open** |
| HIGH-NEW-2 | Dashboard 442 KB — Recharts statically imported at module level | `Dashboard.jsx:7` | **Open** |
| HIGH-NEW-3 | `/control-panel` route has no auth redirect — non-admin direct URL access unblocked | `App.jsx:730` | **Open** |
| HIGH-NEW-4 | 162 ESLint warnings across 41 files — signal-to-noise ratio degraded | 41 files | **Open** |

#### 🟡 Medium

| ID | Finding | File | Status |
|----|---------|------|--------|
| MED-NEW-1 | 52 `console.error/warn/log` in production code | 10+ page files | **Open** |
| MED-NEW-2 | L-04: Hardcoded role strings (`=== 'admin'`) in 7+ pages — not using `ROLES.*` constant | 7 page files | **Open** |
| MED-NEW-3 | L-03: Raw `<button>` (15+) and `<input>` (8+) in pages — not using `ui.jsx` | `AccountSettings.jsx`, `BrandingSettings.jsx` | **Open** |
| MED-NEW-4 | 49 inline `style={{}}` in page components — bypasses dark mode overrides | throughout | **Open** |
| MED-NEW-5 | Dark mode uses CSS `!important` overrides not Tailwind `dark:` prefix — deviates from §4.4 | `appearance.css` / all pages | **Open** |
| MED-NEW-6 | `refetchOnWindowFocus: false` missing from QueryClient config | `main.jsx:15` | **Open** |
| MED-NEW-7 | Magic status strings in `Inventory.jsx` and `Reports.jsx` — `BATCH_STATUS.*` not used | `Inventory.jsx:2117`, `Reports.jsx:481` | **Open** |

#### 🟢 Low

| ID | Finding | File | Status |
|----|---------|------|--------|
| LOW-NEW-1 | Two toast libraries installed (`react-hot-toast` + `sonner`) | `package.json` | **Open** |
| LOW-NEW-2 | `PRODUCT_STATUS` constant defined but never used | `constants.ts` | **Open** |
| LOW-NEW-3 | `NotFoundPage` inline in `App.jsx` rather than `src/pages/NotFoundPage.jsx` | `App.jsx:31` | **Open** |
| LOW-NEW-4 | `Invoices.jsx` PDF generation path not confirmed as dynamic import | `Invoices.jsx` | **Open** |

### Full System Test Scorecard

| Domain | Initial Audit | Full Test | Delta |
|--------|--------------|-----------|-------|
| Security | 9/10 | **8/10** | -1 (console.error + unguarded route) |
| Architecture | 10/10 | **7/10** | -3 (bundle, hardcoded roles, route guard) |
| Performance | 8/10 | **6/10** | -2 (643 KB chunk, static Recharts) |
| Accessibility | 8/10 | **4/10** | -4 (only 20 aria-labels for entire app) |
| UX polish | 8/10 | **7/10** | -1 (raw buttons, inline styles) |
| Dark mode | 8/10 | **6/10** | -2 (deviates from spec, inline style gaps) |
| Code quality | 9/10 | **4/10** | -5 (CI broken, 162 warnings, 66 Prettier fails) |
| Notifications | 8/10 | **8/10** | 0 |
| Mobile | 8/10 | **6/10** | -2 (inline styles, arbitrary widths) |
| Scalability | 8/10 | **7/10** | -1 (bundle size) |
| Maintainability | 9/10 | **5/10** | -4 (warnings noise, magic strings, console.logs) |
| Production readiness | 9/10 | **5/10** | -4 (CI broken, bundle warning) |
| **Overall** | **10/10** | **6/10** | **-4** |

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
| Security | 8/10 | 🟢 Unchanged |
| Architecture | 9/10 | 🟢 Permissions in lib, lazy heavy deps, Dashboard memoised, TanStack Query on 3 key pages |
| Performance | 9/10 | 🟢 Dashboard O(1) rerenders, Inventory chunk −88%, cached navigation |
| Accessibility | 8/10 | 🟢 Focus traps (UX-1 + UX-4) + aria-labels + WCAG AA contrast |
| UX polish | 9/10 | 🟢 Optimistic delete/update on tickets + customers |
| Dark mode | 10/10 | 🟢 Charts, tooltips, toasts, banners all dark-aware |
| Code quality | 9/10 | 🟢 ESLint + Prettier + constants + zod schemas + 74 unit tests |
| Notifications | 9/10 | 🟢 Unchanged |
| Mobile | 8/10 | 🟢 Sidebar inert + Escape + focus restore; modals focus-trapped |
| Scalability | 9/10 | 🟢 Bundle size down, no eager heavy deps, realtime incremental |
| Maintainability | 9/10 | 🟢 Constants module, permissions lib, linter active, 15-file API split |
| Production readiness | 9/10 | 🟢 All P0+P1 resolved, resilient logging |
| **Overall** | **9.5/10** | 🟢 **All P2 items complete. A-1 deferred at this point (done same day). Remaining: P3.** |

### Final (after P3 + A-1 + DEPLOY_CRIT review + storage policies — 2026-05-27)

| Domain | Score | Verdict |
|---|---|---|
| Security | 9/10 | 🟢 RLS + HMAC webhooks + Edge Functions + backup redaction + storage bucket anon-upload policies |
| Architecture | 10/10 | 🟢 React Router v6, TypeScript lib layer, strict tsconfig, CI/CD gates every PR |
| Performance | 10/10 | 🟢 Virtual dropdown, image resize before upload, client pagination |
| Accessibility | 8/10 | 🟢 Focus traps, aria-labels, WCAG AA contrast |
| UX polish | 9/10 | 🟢 404 page, optimistic mutations, realtime toasts, empty states with CTAs |
| Dark mode | 10/10 | 🟢 Charts, tooltips, toasts, banners all dark-aware |
| Code quality | 10/10 | 🟢 TypeScript types, ESLint, CI gates, Sentry, 74 tests |
| Notifications | 9/10 | 🟢 Server-side filtered (RLS), atomic markRead RPC, realtime toasts |
| Mobile | 8/10 | 🟢 Sidebar inert + Escape + focus restore; all modals focus-trapped |
| Scalability | 10/10 | 🟢 Virtual lists, client pagination, image resize, dynamic bundle splits |
| Maintainability | 10/10 | 🟢 Typed constants/permissions/schemas, 15-file API split, full CI pipeline |
| Production readiness | 10/10 | 🟢 CI/CD + Sentry + env.example + Edge Functions — deployable with confidence |
| **Overall** | **10/10** | 🟢 **Audit 100% complete. Zero open items. All P0→P3 + A-1 + storage policies done.** |

---

## 📝 Changelog

- **2026-05-26** — Audit baseline established
- **2026-05-26** — ✅ CRIT-4: removed `bcryptjs` (confirmed unused, 4 packages removed)
- **2026-05-26** — ✅ A-2: added `ErrorBoundary` component, wired into `main.jsx`
- **2026-05-26** — ✅ H-1: merged duplicate `db.webhooks` definitions, restored Integrations page
- **2026-05-26** — 🟡 CRIT-1: client-side code complete (service-key import removed; `adminSetPassword`/`adminCreateUser` invoke Edge Function). Deploy steps above.
- **2026-05-26** — 🟡 CRIT-2: RLS migration written — 28 tables. Deploy steps above.
- **2026-05-26** — ✅ CRIT-3: `public-track` Edge Function deployed with `--no-verify-jwt`. Rate limiter active.
- **2026-05-26** — ✅ CRIT-1: `admin-reset-password` Edge Function deployed. `VITE_SUPABASE_SERVICE_KEY` deleted from Vercel. App redeployed.
- **2026-05-26** — ✅ CRIT-2: RLS migration applied via SQL editor (helper functions in public schema). All 4 P0 findings resolved.
- **2026-05-26** — Verified `npm run build` clean. Bundle has zero references to `VITE_SUPABASE_SERVICE_KEY` or `supabaseAdmin`.
- **2026-05-26** — ✅ H-2: `markAllRead` batched via `mark_notifications_read` RPC — N queries → 1.
- **2026-05-26** — ✅ H-3: `adjustQuantity` replaced with atomic `adjust_part_quantity` RPC.
- **2026-05-26** — ✅ H-5: client-side notification filter removed — RLS handles it server-side. `markRead` atomic via RPC.
- **2026-05-26** — ✅ H-4: `.limit(500)` cap on list calls. `listPaged()` added. Warning banner in UI.
- **2026-05-26** — ✅ H-6: backup export strips `api_key`/`smtp_password`. `redactEmailSettings()` guard added.
- **2026-05-26** — ✅ H-7: webhook dispatch uses HMAC-SHA256 `X-Signature-256`. Plaintext secret header removed.
- **2026-05-26** — ✅ H-8: `customers.delete()` and `bulkDelete()` use atomic RPC only.
- **2026-05-26** — ✅ H-9: `auditInsert()` — retry + localStorage queue + flush on startup. All 86 call sites resilient.
- **2026-05-26** — ✅ M-2: ESLint 9 flat config + Prettier. `lint`, `lint:ci`, `lint:fix`, `format`, `format:check` scripts. 0 errors.
- **2026-05-26** — ✅ A-4: Dashboard — all 13 aggregations in `useMemo([tickets])`.
- **2026-05-26** — ✅ A-5: Dashboard realtime — events write to query cache; full refetch eliminated.
- **2026-05-26** — ✅ DM-1/2/3: Dark-aware Recharts ticks + tooltips + react-hot-toast. DM-4 N/A (PDFs light-only).
- **2026-05-26** — ✅ UX-2: `aria-label` on all icon-only buttons (11 buttons across 5 files).
- **2026-05-26** — ✅ UX-3: 318× `text-gray-400` → `text-gray-500` across 32 files — WCAG AA.
- **2026-05-26** — ✅ A-6: `ROLE_DEFAULT_PERMISSIONS` extracted to `src/lib/permissions.ts`; `canDo()` exported.
- **2026-05-26** — ✅ A-7: `xlsx` + `jspdf` dynamic-imported. Inventory chunk 734 KB → 90 KB (−88%).
- **2026-05-26** — ✅ DM-banner: 4 CSS overrides in `appearance.css` for announcement banner dark mode.
- **2026-05-26** — ✅ UX-5: realtime INSERT on `notifications` → `toast()` with targeting + pref check.
- **2026-05-26** — ✅ UX-7: `<EmptyState>` wired into RMATickets, Customers, Products, PartsInventory.
- **2026-05-26** — ✅ A-3: `db.userPreferences` added. AccountSettings persists prefs to DB. App.jsx seeds from DB on login.
- **2026-05-26** — ✅ M-4: `supabaseClient.js` (1,424 lines) split into 15 domain files. Barrel re-export preserves backward compat.
- **2026-05-26** — ✅ M-5: `src/lib/constants.ts` created. `permissions.ts` + `audit.js` + `system.js` consume constants.
- **2026-05-26** — ✅ UX-4: `inert` on main content when sidebar open. Escape → hamburger focus. aria-labels on both buttons.
- **2026-05-26** — ✅ UX-1: `Modal.jsx` wrapping `@radix-ui/react-dialog`. 13 modals migrated (7 UserManagement, 2 RMATickets, 4 Products).
- **2026-05-27** — ✅ F-2: `20260526_check_constraints.sql` — CHECK constraints on 8 tables. `validate_ticket_fields()` RPC added.
- **2026-05-27** — ✅ F-1: `src/lib/schemas.ts` with 8 zod schemas + helpers. Login.jsx on react-hook-form + zodResolver. Customers.jsx uses `safeParse`.
- **2026-05-27** — ✅ M-1: Vitest + jsdom + RTL. 74 tests in 3 suites. `npm test` passes.
- **2026-05-27** — ✅ P-1 targeted: `QueryClientProvider` (staleTime 60s). `useQuery` in Dashboard, RMATickets, Customers. Realtime → query cache.
- **2026-05-27** — ✅ UX-6: Optimistic delete on tickets + customers. Optimistic update on customer edit. Rollback on error.
- **2026-05-27** — ⏸ A-1: Initially deferred. Reversed and implemented same day.
- **2026-05-27** — ✅ P-3: `src/lib/resizeImage.js` — canvas downscale to 1200px (400px avatars), JPEG q=0.85. Wired into all 5 upload helpers.
- **2026-05-27** — ✅ CI/CD: `.github/workflows/ci.yml` — Node 20, test → lint:ci → build on every push/PR to `main`.
- **2026-05-27** — ✅ Sentry: `src/lib/sentry.js` + `captureException`. `ErrorBoundary.componentDidCatch` reports in PROD. `initSentry()` in `main.jsx`.
- **2026-05-27** — ✅ P-2: Tables paginated 25/page. Customer dropdown virtualised with `useVirtualizer`.
- **2026-05-27** — ✅ M-3: `tsconfig.json` + `constants.ts` / `permissions.ts` / `schemas.ts`. Old `.js` files deleted.
- **2026-05-27** — ✅ PWA: `vite-plugin-pwa` + Workbox generateSW. 42 assets pre-cached. 5 icon sizes. `index.html` updated.
- **2026-05-27** — 🔍 Cross-check pass 1: 7 audit inaccuracies corrected. A-5 "local state" → "query cache". A-6/F-1/M-5 `.js` refs corrected to `.ts`. M-4 line count 19→21. P-2 description clarified. CLAUDE.md fully updated (routing, commands, permissions, notifications).
- **2026-05-27** — ✅ A-1: React Router v6 full migration. `BrowserRouter` in `main.jsx`. 13 routes + `NotFoundPage`. Param wrapper components. Removed `pathToPage`, `pageToPath`, `currentPage` state.
- **2026-05-27** — 🔍 Cross-check pass 2 (DEPLOY_CRIT files): 5 issues found and fixed. (1) `admin-reset-password` Edge Function returned 404 for new users — added `createUser` path. (2) DEPLOY_CRIT2.md SQL used `auth.user_role()` — corrected to `public.rma_user_role()`. (3) Storage bucket policy was untracked — written as migration. (4) DEPLOY_CRIT1.md rollback updated to reference `auth.js`. (5) CRIT-3 location ref updated.
- **2026-05-27** — ✅ CRIT-3 follow-up: `20260527_storage_bucket_policies.sql` — anon upload capped at 25 MB, JPEG/PNG/GIF/WebP/PDF only. Security: 8/10 → 9/10.
- **2026-05-27** — ✅ Merged AUDIT_PROGRESS.md + DEPLOY_CRIT1/2/3.md into AUDIT_LOG.md. Old files removed.
- **2026-05-27** — ✅ `CONSTITUTION.md` written: 18-section engineering constitution. 15 mandatory laws, component standards, AI agent rules, forbidden anti-patterns.
- **2026-05-27** — ✅ `CLAUDE.md` fully updated: all routes, provider order, domain modules, Edge Functions, PWA, Sentry, RLS helpers, CI/CD, all npm scripts.
- **2026-05-27** — ✅ `README.md` rewritten from stub: full feature table, tech stack, quick-start guide, architecture overview, all routes, testing docs.
- **2026-05-27** — 🔍 Full system test run. 14 new findings: 1 critical, 4 high, 7 medium, 4 low. Overall score revised 10/10 → **6/10**. CI broken (lint:ci + format:check both fail). See [SYSTEM_TEST_REPORT_20260527.md](SYSTEM_TEST_REPORT_20260527.md).
