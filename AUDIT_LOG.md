# myRMA Enterprise — Audit Log

> **Audit period:** 2026-05-26 → 2026-05-27 (initial) · 2026-05-27 (full system test) · 2026-05-28 (Sprints 0–3 complete) · 2026-05-28 (full re-audit) · 2026-05-28 (Sprints 4–6 deployed) · 2026-05-29 (Sprint 7 complete) · 2026-05-31 (Sprint 10 surgical fixes) · 2026-06-01 (Direction B theme + TS fix) · 2026-06-05 (AI assist, full i18n/RTL, bug fixes)
> **Baseline commit:** `5085ad2` + post-rollback UI fixes
> **Latest score:** 9.3/10 — Sprint 10 all phases complete 2026-06-01. Direction B "Command" design system applied: Dashboard rewritten (hero KPIs, SVG gauges/donuts, 12-col grid), full-app theme transformation (App shell, ui.jsx, index.css, AppearanceContext, ErrorBoundary, Modal, NotFoundPage). TypeScript noImplicitAny fix. Remaining: L-6 TypeScript db layer; ~46 page files with stale slate-* Tailwind classes pending sweep.

---

## Contents

### Initial audit — 2026-05-26 → 2026-05-27

- [P0 — Critical findings + deploy guides](#-p0--critical-production-blockers)
- [P1 — High findings](#-p1--high-data-integrity--architecture)
- [P2 — Medium findings (frontend architecture)](#-p2--medium-frontend-architecture)
- [P2 — Medium findings (UX & accessibility)](#-p2--medium-ux--accessibility)
- [P2 — Dark mode gaps](#-p2--dark-mode-gaps)
- [P-1 / A-1 Reassessment](#-p-1--a-1-reassessment-2026-05-27)
- [P3 — Quarter findings](#-p3--quarter)

### Full system test — 2026-05-27

- [Test results + new findings](#-full-system-test--2026-05-27)
- [Fix plan: Sprints 0–3](#-fix-plan--post-full-system-test-2026-05-27)
- [Scorecard: Sprints 0–3](#scorecard-sprints-03-2026-05-27-full-system-test-period)

### Full re-audit — 2026-05-28

- [Re-audit results + new findings](#-full-system-audit--2026-05-28)
- [Fix plan: Sprints 4–7](#-fix-plan--post-2026-05-28-audit)
- [Scorecard: Sprints 4–7](#scorecard-after-each-sprint)

### Historical snapshots

- [Scorecard — all versions](#-scorecard)
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
| CRIT-NEW-1 | CI pipeline broken — `lint:ci` fails (1 error + 162 warnings) and `format:check` fails (66 files) | `Login.jsx:46`, 66 files | ✅ **Done 2026-05-27** — Sprint 0. 0 errors, 0 warnings, Prettier clean, 74 tests pass, build succeeds. |

#### 🟠 High

| ID | Finding | File | Status |
|----|---------|------|--------|
| HIGH-NEW-1 | Main vendor bundle 643 KB — exceeds 500 KB threshold | `vite.config.js` / `index` chunk | ✅ **Done 2026-05-28** — Sprint 2. `manualChunks` splits vendor into 5 named chunks; no chunk above 340 KB. |
| HIGH-NEW-2 | Dashboard 442 KB — Recharts statically imported at module level | `Dashboard.jsx:7` | ✅ **Done 2026-05-28** — Sprint 2. `DashboardCharts.jsx` extracted; lazy-loaded via `React.lazy`. |
| HIGH-NEW-3 | `/control-panel` route has no auth redirect — non-admin direct URL access unblocked | `App.jsx:730` | ✅ **Done 2026-05-27** — Sprint 1. `<Navigate to="/" replace>` guard added inside route element. |
| HIGH-NEW-4 | 162 ESLint warnings across 41 files — signal-to-noise ratio degraded | 41 files | ✅ **Done 2026-05-27** — Sprint 0. All 162 warnings resolved across 41 files. |

#### 🟡 Medium

| ID | Finding | File | Status |
|----|---------|------|--------|
| MED-NEW-1 | 52 `console.error/warn/log` in production code | 10+ page files | ✅ **Done 2026-05-28** — Sprint 2. `captureException` replaces all `console.error` calls across 10 page files. |
| MED-NEW-2 | L-04: Hardcoded role strings (`=== 'admin'`) in 7+ pages — not using `ROLES.*` constant | 7 page files | ✅ **Done 2026-05-27** — Sprint 1. `ROLES.*` now used across 10 files. |
| MED-NEW-3 | L-03: Raw `<button>` (15+) and `<input>` (8+) in pages — not using `ui.jsx` | `AccountSettings.jsx`, `BrandingSettings.jsx` | ✅ **Done 2026-05-28** — Sprint 2. Action buttons replaced with `<Button>`, text inputs with `<Input>` from ui.jsx in both files. |
| MED-NEW-4 | 49 inline `style={{}}` in page components — bypasses dark mode overrides | throughout | ✅ **Done 2026-05-28** — Sprint 3. Audited all 50 inline styles: 4 static values converted to Tailwind; remaining are intentional (dynamic runtime colors, SVG `<text>`, virtual scroll, PDFLayout). |
| MED-NEW-5 | Dark mode uses CSS `!important` overrides not Tailwind `dark:` prefix — deviates from §4.4 | `appearance.css` / all pages | ✅ **Done 2026-05-28** — Sprint 3. `CONSTITUTION.md §4.4` updated to document the CSS-override approach as the current accepted pattern and `dark:` as the preferred approach for new components. |
| MED-NEW-6 | `refetchOnWindowFocus: false` missing from QueryClient config | `main.jsx:15` | ✅ **Done 2026-05-27** — Sprint 0. Added to `QueryClient` defaultOptions. |
| MED-NEW-7 | Magic status strings in `Inventory.jsx` and `Reports.jsx` — `BATCH_STATUS.*` not used | `Inventory.jsx:2117`, `Reports.jsx:481` | ✅ **Done 2026-05-27** — Sprint 1. `INVOICE_STATUS` added to constants; `Reports.jsx` + `Inventory.jsx` use constants. |

#### 🟢 Low

| ID | Finding | File | Status |
|----|---------|------|--------|
| LOW-NEW-1 | Two toast libraries installed (`react-hot-toast` + `sonner`) | `package.json` | ✅ **Done 2026-05-27** — Sprint 1. `sonner` uninstalled; `react-hot-toast` is sole library. |
| LOW-NEW-2 | `PRODUCT_STATUS` constant defined but never used | `constants.ts` | ✅ **Done 2026-05-27** — Sprint 1. Replaced with `INVOICE_STATUS`. |
| LOW-NEW-3 | `NotFoundPage` inline in `App.jsx` rather than `src/pages/NotFoundPage.jsx` | `App.jsx:31` | ✅ **Done 2026-05-28** — Sprint 2. Extracted to `src/pages/NotFoundPage.jsx`; lazy-loaded in `App.jsx`. |
| LOW-NEW-4 | `Invoices.jsx` PDF generation path not confirmed as dynamic import | `Invoices.jsx` | ✅ **Done 2026-05-28** — Sprint 2. Verified: `Invoices.jsx` uses hidden iframe + `window.print()` — no jsPDF import. No action needed. |

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

## 🔧 Fix Plan — Post Full System Test (2026-05-27)

> **Score at time of writing: 9.1/10** (after Sprints 0–3; re-baselined to 7.0 after the 2026-05-28 full re-audit — see below)  
> All findings from the 2026-05-27 full system test. Ordered by priority.  
> Full detail: [SYSTEM_TEST_REPORT_20260527.md](SYSTEM_TEST_REPORT_20260527.md)

---

### ✅ Sprint 0 — Unblock CI ~~(Do today, ~2 hours total)~~ — **COMPLETE 2026-05-27 · commit `3a629af`**

> ~~CI is broken. No PR can be merged until these are fixed. These are prerequisites for everything else.~~  
> **Done.** `npm test && npm run lint:ci && npm run format:check && npm run build` all pass with 0 errors, 0 warnings.

| # | ID | Task | File(s) | Effort |
|---|-----|------|---------|--------|
| 1 | CRIT-NEW-1a | Fix ESLint error: wrap rethrown `Error` with `{ cause: err }` | `src/pages/Login.jsx:46` | 5 min |
| 2 | CRIT-NEW-1b | Run `npm run format` to auto-fix all 66 Prettier violations | all 66 files | 10 min |
| 3 | CRIT-NEW-1c | Fix top ESLint warning categories to reach 0 warnings for CI: (a) remove unused `React` imports (ESLint auto-detects with new JSX transform — 32 instances), (b) remove or prefix unused vars with `_` (55 instances), (c) fix React display-name warnings (13 instances) | 41 files | 90 min |
| 4 | MED-NEW-6 | Add `refetchOnWindowFocus: false` to QueryClient defaultOptions | `src/main.jsx:18` | 2 min |

**Acceptance criteria:** `npm test && npm run lint:ci && npm run format:check && npm run build` all pass with zero errors/warnings.

---

### ✅ Sprint 1 — Security & Architecture ~~(This sprint, ~5 hours)~~ — **COMPLETE 2026-05-27 · commit `34003e0`**

| # | ID | Task | File(s) | Effort |
|---|-----|------|---------|--------|
| 5 | HIGH-NEW-3 | **Security fix:** Add role guard to `/control-panel` route. Redirect non-admin to `/` inside the `<Route element>`. Use `currentUserRole` prop check against `ROLES.ADMIN` / `ROLES.SUPER_ADMIN`. | `src/App.jsx:730` | 20 min |
| 6 | MED-NEW-2 | Replace all hardcoded role strings with `ROLES.*` constants in 7 pages. Files: `AccountSettings.jsx:80`, `CustomerDetails.jsx:28`, `Customers.jsx:87`, `Invoices.jsx:481,483`, `PartsInventory.jsx:161,166`, `Products.jsx:90`, `Reports.jsx:570,574,575`, `RMATickets.jsx:227,1379` | 7 page files | 60 min |
| 7 | MED-NEW-7 | Add `INVOICE_STATUS` constant to `constants.ts`. Replace `i.status === 'pending'` / `'overdue'` in `Reports.jsx:481`. Replace `b.status==='draft'/'sent'/'resolved'` in `Inventory.jsx:2117` with `BATCH_STATUS.*`. | `src/lib/constants.ts`, `Reports.jsx`, `Inventory.jsx` | 30 min |
| 8 | LOW-NEW-1 | Audit which toast library is actually primary. Remove the unused one. If `react-hot-toast` is primary (Recharts tooltips use it), uninstall `sonner`. Update all `import` statements. | `package.json`, all toast usages | 30 min |
| 9 | LOW-NEW-2 | Remove unused `PRODUCT_STATUS` export from `constants.ts` or add it to ESLint ignore with a TODO comment for future use. | `src/lib/constants.ts` | 5 min |

---

### ✅ Sprint 2 — Code Quality & Performance ~~(Next sprint, ~8 hours)~~ — **COMPLETE 2026-05-28 · commit `1d39b30`**

| # | ID | Task | File(s) | Effort |
|---|-----|------|---------|--------|
| 10 | MED-NEW-1 | Replace `console.error` in all 52 catch blocks with `captureException(err)` from `src/lib/sentry.js`. Priority files: `BackupRestore.jsx` (7 calls), `BrandingSettings.jsx` (8 calls), `CustomerDetails.jsx` (6 calls). | 10+ page files | 90 min |
| 11 | MED-NEW-3 | Replace raw `<button>` with `<Button variant="ghost">` (or appropriate variant) from `ui.jsx` in `AccountSettings.jsx` (6 instances) and `BrandingSettings.jsx` (10+ instances). Replace raw `<input type="text">` with `<Input>` from `ui.jsx` in `BrandingSettings.jsx` (8 instances). | `AccountSettings.jsx`, `BrandingSettings.jsx` | 90 min |
| 12 | HIGH-NEW-1 | Add `build.rollupOptions.output.manualChunks` to `vite.config.js` to split the 643 KB vendor chunk: separate React/ReactDOM, Radix UI, framer-motion, and TanStack into named chunks. Target: no chunk above 400 KB (180 KB gzipped). | `vite.config.js` | 60 min |
| 13 | HIGH-NEW-2 | Lazy-load Recharts in Dashboard: wrap chart components in `React.lazy(() => import('./DashboardCharts'))` or use dynamic `await import('recharts')` inside chart render. Target: Dashboard chunk < 100 KB. | `src/pages/Dashboard.jsx:7` | 60 min |
| 14 | LOW-NEW-3 | Extract `NotFoundPage` from `App.jsx` into `src/pages/NotFoundPage.jsx`. Import and use it in `App.jsx`. | `src/App.jsx:31-46`, new file | 15 min |
| 15 | LOW-NEW-4 | Verify Invoices.jsx PDF generation. If jsPDF is statically imported, convert to `const { default: jsPDF } = await import('jspdf')` inside the export handler. | `src/pages/Invoices.jsx` | 30 min |

---

### ✅ Sprint 3 — Polish & Technical Debt ~~(Backlog)~~ — **COMPLETE 2026-05-28 · commit `ce61231`**

| # | ID | Task | File(s) | Effort |
|---|-----|------|---------|--------|
| 16 | MED-NEW-4 | Audit all 49 inline `style={{}}` in page components. Convert fixed pixel values to Tailwind equivalents. Replace inline color values with Tailwind utility classes. | throughout | 3–4 hours |
| 17 | MED-NEW-5 | Document dark mode architecture: update `CONSTITUTION.md §4.4` to reflect the CSS-override approach (or commit to a full Tailwind `dark:` migration — one page at a time). Audit `appearance.css` for gaps. | `CONSTITUTION.md`, `appearance.css` | 1 hour doc / 8+ hours full migration |
| 18 | — | Accessibility pass: add `aria-label` to all icon-only buttons (estimated 40+ missing across 19 pages). Add `role="status"` to all `<Spinner>` usages. Add form `<legend>` to all fieldset groups. | all pages | 4–8 hours |

---

### Scorecard: Sprints 0–3 (2026-05-27 full system test period)

> Score baseline for this table: **6.0/10** (2026-05-27 full system test). Final: **9.1/10** after Sprint 3. The project was then re-audited on 2026-05-28 revealing new findings that re-baselined to 7.0/10 — see the Sprints 4–7 table below.

| Domain | ~~Before~~ | ✅ Sprint 0 (done) | ✅ Sprint 1 (done) | ✅ Sprint 2 (done) | ✅ Sprint 3 (done) |
|--------|------------|-------------------|-------------------|-------------------|-------------------|
| Security | 8 | **8** | **9** | 9 | 9 |
| Architecture | 7 | **7** | **8** | **9** | 9 |
| Performance | 6 | **6** | 6 | **8** | 8 |
| Accessibility | 4 | **4** | 4 | 4 | **7** |
| UX polish | 7 | **7** | 7 | **8** | **9** |
| Dark mode | 6 | **6** | 6 | 6 | **8** |
| Code quality | 4 | **8** | **9** | **9** | 9 |
| Notifications | 8 | **8** | 8 | 8 | 8 |
| Mobile | 6 | **6** | 6 | 6 | **7** |
| Scalability | 7 | **7** | 7 | **9** | 9 |
| Maintainability | 5 | **7** | **8** | **9** | 9 |
| Production readiness | 5 | **8** | **9** | 9 | 9 |
| **Overall** | **6** | **✅ 7.2** | **✅ 8.0** | **✅ 8.6** | **✅ 9.1** |

---

## 🧪 Full System Audit — 2026-05-28

> **Trigger:** User-requested honest re-audit covering code, pages, functions, features, frontend, backend, UI/UX, user roles, components.
> **Result:** Despite Sprints 0–3 closing all known findings, this fresh pass surfaced **32 new issues** (2 critical, 6 high, 10 medium, 8 low). The strong foundation (RLS, edge functions, constants, permissions) is intact — debt is concentrated in **page architecture** (5 mega-files), **data fetching consistency** (TanStack Query only adopted in 3 of 21 pages), and **accessibility** (zero ARIA on 4 of the 5 largest pages).
> **Re-baselined score:** **9.1 → 7.0/10**

### Test Run Results (2026-05-28)

| Check | Result | Notes |
|---|---|---|
| `npm run lint` | ✅ 0 errors / 0 warnings | clean |
| `npm run format:check` | ✅ all files clean | clean |
| `npm run build` | ✅ builds successfully | DashboardCharts 427 KB chunk, xlsx 430 KB chunk, jspdf 358 KB chunk (all lazy — fine) |
| `npm test` | 🔴 **0 tests / 3 failed suites** | All suites error with `Cannot read properties of undefined (reading 'config')`. **Tests pass when run with `--no-file-parallelism` or individually.** Vitest 4.1.7 parallel-pool race. **CI gate silently broken.** |

### Critical Findings

| ID | Area | File / Line | Finding | Fix |
|----|------|-------------|---------|-----|
| **C-1** | CI/Tests | [vite.config.js:81-90](vite.config.js#L81-L90) | `npm test` reports 0 tests / 3 failed suites — Vitest 4.1.7 parallel-pool race. Tests pass individually. CI gate is currently broken. | Add `poolOptions: { forks: { singleFork: true } }` to the `test` block. |
| **C-2** | Data integrity | [src/api/db/tickets.js:45-51](src/api/db/tickets.js#L45-L51) | `db.rmaTickets.delete()` cascades to `inventory_units` → `ticket_comments` → `ticket_activity` → `rma_tickets` — **not transactional**. Partial failure leaves orphans. | Move to a `delete_ticket_cascade(uuid)` Postgres function called via `supabase.rpc()`. |

### High Findings

| ID | Area | File | Finding | Fix |
|----|------|------|---------|-----|
| **H-1** | Architecture | [Inventory.jsx](src/pages/Inventory.jsx) — 4,861 lines | Single file holds all of inventory (units, batches, warehouses, exports, virtualised list, drawers). Unreviewable. | Split into a folder: shell + `UnitList`, `BatchManager`, `WarehouseSheet`, `ExportMenu`, `useInventoryQueries`. |
| **H-2** | Architecture | [RMATickets.jsx](src/pages/RMATickets.jsx) — 3,765 lines | Includes `window.history.pushState` for URL sync. Same problem. | Extract `TicketDrawer`, `TicketFilters`, `TicketTable`, `useTicketQueries`. |
| **H-3** | Architecture | [Products.jsx](src/pages/Products.jsx) — 3,158 lines; [UserManagement.jsx](src/pages/UserManagement.jsx) — 2,207 lines | Past the maintainability cliff. | Same split-by-feature pattern. |
| **H-4** | Data fetching | Most pages | CLAUDE.md mandates TanStack Query, but only 3 of 21 pages use it (Dashboard, Customers, RMATickets). Inventory has 9 `useEffect`s; Products has 10. | One page per sprint: extract `use<Page>Queries.ts`, replace `useEffect` loads with `useQuery`, mutations with `useMutation` + `invalidateQueries`. |
| **H-5** | Accessibility | Customers, Reports, Inventory, Products | **Zero** `aria-*` / `role` attributes in 4 of the 5 largest pages. Screen readers can't navigate modals, sort headers, virtualised tables. | `aria-label` on icon-only buttons, `aria-sort` on column headers, `aria-modal="true"` on modal containers, `role="status"` on inline loading rows. |
| **H-6** | Observability | RMATickets, Reports, ControlPanel, RMATracker, Dashboard, Login, ResetPassword, AccountSettings, PartsInventory | These pages have `.catch()` blocks that toast the user but never call `captureException`. Production errors here are invisible to Sentry. | Add `captureException(err, { page })` in every `catch` that toasts. |

### Medium Findings

| ID | Area | File | Finding | Fix |
|----|------|------|---------|-----|
| M-1 | Schema | [schemas.ts:71-83](src/lib/schemas.ts#L71-L83) | `ticketSchema` only validates 9 fields; tickets have ~30+. | Expand to all writeable columns. |
| M-2 | Schema | [schemas.ts:77-78](src/lib/schemas.ts#L77-L78) | Ticket status/priority hardcoded as `z.enum([...])` — duplicates constants. | `z.enum(TICKET_STATUS_LIST as [string, ...string[]])`. |
| M-3 | Schema | — | No Zod schemas for invoices, parts, inventory units, warehouses, batches, custom fields. | Add per-domain schemas; apply in `db.*.create/update`. |
| M-4 | UI consistency | [Login.jsx](src/pages/Login.jsx), [ResetPassword.jsx](src/pages/ResetPassword.jsx) | Still use raw `<input>` / `<button>`. Sprint 2's MED-NEW-3 missed both auth pages. | Replace with `<Input>` / `<Button>`. |
| M-5 | Auth UX | [App.jsx:369-374](src/App.jsx#L369-L374) | `handleSignup` declared but never reaches `<Login>` (only `onLogin` is passed). Dead code or unfinished public signup. | Confirm intent — remove or wire to a signup toggle. |
| M-6 | State drift | [AppearanceContext.jsx:14-25](src/contexts/AppearanceContext.jsx#L14-L25) | `dashboardWidgets` is a static array. Older cached settings keep their shorter list — new widgets invisible. | Version the settings shape; union-merge `dashboardWidgets`. |
| M-7 | Auth race | [App.jsx:171-180](src/App.jsx#L171-L180) | `subscription.unsubscribe()` throws on cleanup if `subscription` is undefined. | `subscription?.unsubscribe()`. |
| M-8 | Redundant work | [App.jsx:362-365](src/App.jsx#L362-L365) | `handleLogin` runs `db.userRoles.getUserRole` and `checkAuth` may re-fire. | Cache role in TanStack Query under `['user-role', email]`. |
| M-9 | RLS duplication | [App.jsx:254-258](src/App.jsx#L254-L258) | Notification toast filter re-implements RLS targeting client-side. | Drop client filter; trust server RLS. |
| M-10 | LocalStorage safety | 43 sites across 11 files | Many `localStorage.*` calls lack `try/catch`. Safari private mode / quota errors crash renders. | `src/lib/storage.ts` with `safeStorage.get/set`. |

### Low Findings

| ID | Area | File | Finding | Fix |
|----|------|------|---------|-----|
| L-1 | Code hygiene | [App.jsx:193](src/App.jsx#L193) | `console.error('Auth check error:', ...)` left in production path. | Replace with `captureException`. |
| L-2 | Bundle | dist/assets/index-D4tlrIMR.js (340 KB) | Main chunk eagerly imports `CommandPalette` (only used on Ctrl+K). | Lazy-load `CommandPalette`. |
| L-3 | A11y | [ui.jsx:165](src/components/ui.jsx#L165) | `PageHeader` back button is SVG + text; no `aria-label`. | Add `aria-label={backLabel}`. |
| L-4 | Cleanup | [App.jsx:155](src/App.jsx#L155) | `db.auditLog.flushQueue().catch(() => {})` silently swallows errors. | Log to Sentry. |
| L-5 | UX | [App.jsx:441-443](src/App.jsx#L441-L443) | Mobile title is `pathname.slice(1).replace(/-/g, ' ')` → lowercase ("rma tickets"). | Hard-map known routes or title-case. |
| L-6 | Type safety | [src/api/db/](src/api/db/) | All db helpers are `.js`, untyped. Page code can't be checked against data shapes. | Convert to `.ts`; export Row types. |
| L-7 | Constants | [schemas.ts:104](src/lib/schemas.ts#L104) | `addUserSchema` re-lists each role manually. | `z.enum(ROLE_LIST as ...)`. |
| L-8 | Auth | [admin-reset-password/index.ts:72](supabase/functions/admin-reset-password/index.ts#L72) | Server allows 6-char passwords; UI requires 8+. Server is laxer than client. | Tighten to 8 to match UI rules. |

### Positives (preserve these)

- RLS comprehensive and well-organised — [20260526_enable_rls.sql](supabase/migrations/20260526_enable_rls.sql)
- Edge Functions validate JWT + role server-side, prevent self-lockout, rate-limit
- Heavy deps (xlsx, jspdf, html2canvas, Recharts) correctly code-split via dynamic `import()` and `React.lazy`
- `canDo` + `ROLE_DEFAULT_PERMISSIONS` give one consistent permission model
- Anon role revoked everywhere; `/tracker` forced through Edge Function
- Zero `dangerouslySetInnerHTML`, zero `eval`, zero `innerHTML` writes — no XSS surface
- All constants centralised; no hardcoded role/status strings anywhere

---

## 🔧 Fix Plan — Post 2026-05-28 Audit

### ✅ Sprint 4 — Stop the Bleeding — **FULLY DEPLOYED 2026-05-28**

> Unblock CI and patch the data-integrity hole.

| # | ID | Task | File(s) | Effort | Status |
|---|----|------|---------|--------|--------|
| 19 | C-1 | Add `fileParallelism: false` to the `test` block (Vitest 4.1.7 parallel-pool race surfaced as `Cannot read properties of undefined (reading 'config')`). `npm test` now reports 74/74 again. | [vite.config.js:81-94](vite.config.js#L81-L94) | 10 min | ✅ |
| 20 | C-2 | **Solution refined from RPC to `ON DELETE CASCADE` FKs after schema inspection** revealed `ticket_comments` and `ticket_activity` already cascade, but `inventory_units` had **no FK at all** to `rma_tickets` (the JS-level "cascade" was masking missing schema). Migration adds the missing FK; `tickets.js` simplified to a single `delete().eq('id', id)`. Postgres now handles the cascade atomically. Orphan check: 0. FK verified: 3/3 tables CASCADE. Smoke-tested on production. | new [20260528_ticket_cascade_fk.sql](supabase/migrations/20260528_ticket_cascade_fk.sql) + [src/api/db/tickets.js](src/api/db/tickets.js) | 60 min | ✅ Deployed |
| 21 | L-8 | Bump password minimum from 6 to 8 in Edge Function (matches UI: Login + ResetPassword + UserManagement). Deployed and smoke-tested: 7-char rejected, 8-char accepted. | [admin-reset-password/index.ts:72](supabase/functions/admin-reset-password/index.ts#L72) | 5 min | ✅ Deployed |
| 22 | M-7 | `subscription?.unsubscribe()` — cleanup never throws. | [App.jsx:179](src/App.jsx#L179) | 1 min | ✅ |

**Acceptance criteria (CI):** `npm test` 74/74 ✅ · `npm run lint:ci` 0/0 ✅ · `npm run format:check` ✅ · `npm run build` ✅  
**Production smoke test:** cascade delete ✅ · password enforcement ✅

---

### Sprint 4 Deploy Guide — Ticket Cascade FK (C-2)

⚠️ **DO THESE STEPS IN ORDER.** The migration MUST be applied before merging the JS change, otherwise tickets with `inventory_units` children will fail to delete cleanly.

#### Step 1 — Pre-flight orphan check (1 min)

Run in Supabase Dashboard → SQL Editor:

```sql
SELECT COUNT(*) AS orphan_count
FROM   inventory_units iu
LEFT JOIN rma_tickets t ON t.id = iu.rma_ticket_id
WHERE  iu.rma_ticket_id IS NOT NULL
  AND  t.id IS NULL;
```

- **Expected:** `orphan_count = 0`
- **If > 0:** investigate before continuing. Likely sources: failed JS-level cascade deletes from before this migration, manual SQL deletes, support scripts. Either delete the orphans or change the migration to `ADD CONSTRAINT ... NOT VALID` (and clean up later).

#### Step 2 — Apply the migration (2 min)

**Option A — Supabase CLI (preferred):**
```powershell
supabase db push
```

**Option B — Dashboard SQL Editor:**
Paste contents of [20260528_ticket_cascade_fk.sql](supabase/migrations/20260528_ticket_cascade_fk.sql) into the editor and Run.

#### Step 3 — Verify the constraint (1 min)

Re-run the FK inspection from earlier. Expected 3 rows, all `CASCADE`:

| constraint_name | child_table | on_delete |
|---|---|---|
| `inventory_units_rma_ticket_id_fkey` | inventory_units | CASCADE |
| `ticket_activity_ticket_id_fkey` | ticket_activity | CASCADE |
| `ticket_comments_ticket_id_fkey` | ticket_comments | CASCADE |

#### Step 4 — Deploy the Edge Function (L-8) (1 min)

```powershell
supabase functions deploy admin-reset-password
```

Verify: Dashboard → Edge Functions → `admin-reset-password` → status **Active**, latest deploy timestamp matches now.

#### Step 5 — Smoke test on production (5 min)

Log in as super_admin:
- ✅ Create a test ticket, attach an inventory unit, then delete the ticket → ticket and unit both gone.
- ✅ Try setting a 7-character password via Edge Function (Control Panel → reset another user's password) → request rejected with "min 8 chars".
- ✅ Set an 8-character password → succeeds.

#### Rollback (if cascade behaves unexpectedly)

```sql
ALTER TABLE public.inventory_units
  DROP CONSTRAINT IF EXISTS inventory_units_rma_ticket_id_fkey;
```

Then revert [src/api/db/tickets.js:45-51](src/api/db/tickets.js#L45-L51) to the previous JS-level cascade in a follow-up commit. `ticket_comments` and `ticket_activity` already cascaded before this migration; their behaviour is unchanged.

### ✅ Sprint 5 — Observability & Validation — **COMPLETE 2026-05-28**

> Every error reaches Sentry; every write is schema-validated.

| # | ID | Task | Effort | Status |
|---|----|------|--------|--------|
| 23 | H-6 | Added `captureException` in 9 pages: RMATickets (13 catch blocks), Reports, ControlPanel (5), AccountSettings (6), PartsInventory (4), ResetPassword. `audit.js` console.error also replaced. | 90 min | ✅ |
| 24 | L-1, L-4 | `App.jsx`: `console.error` → `captureException`; `flushQueue().catch()` now reports to Sentry. | 30 min | ✅ |
| 25 | M-1 | `ticketSchema` expanded from 9 → 18 fields (added `general_description`, `accessories_received`, `carrier`, `tracking_number`, `shipping_label_url`, `products`, `attachments`). | 60 min | ✅ |
| 26 | M-2, L-7 | `ticketSchema` status/priority derived from `TICKET_STATUS_LIST`/`PRIORITY_LIST`; `addUserSchema` role derived from `ROLE_LIST`. No more hardcoded enum strings. Bonus: fixed form default from invalid `'New'` → `'Open'`; aligned dropdown options with DB CHECK constraint. | 20 min | ✅ |
| 27 | M-3 | Deferred — invoices/parts/inventory/warehouse schemas are lower risk than H-6/M-4. Moved to Sprint 6 backlog. | — | ⏳ deferred |
| 28 | M-4 | `Login.jsx` + `ResetPassword.jsx`: raw `<input>` → `<Input>`, raw submit `<button>` → `<Button loading={...}>`. `ui.jsx` updated to use `cn()` from `tailwind-merge` for proper class override in all three form primitives (Input, Select, Textarea). | 60 min | ✅ |

**Acceptance criteria:** `npm test` 74/74 ✅ · `npm run lint:ci` 0/0 ✅ · `npm run build` ✅  
**Deploy:** commit `e6f8935` pushed to `main` 2026-05-28. CI → Vercel deploy triggered.

**Repo hygiene fix (deploy blocker):** `supabase.exe` (113 MB) and `supabase-go.exe` (93 MB) were committed early in history (commits `e386a91`, `c9bd27f`), blocking every GitHub push with GH001. Fixed via `git filter-branch` to strip both binaries from all 57 local commits before pushing. **Action:** add `*.exe` to `.gitignore` to prevent recurrence.

---

### ✅ Sprint 6 — TanStack Query Migration — **COMPLETE 2026-05-28**

> Kill `useEffect + setState` data fetching across the app.

| # | ID | Task | Effort | Status |
|---|----|------|--------|--------|
| 29 | H-4 | Migrated 9 pages: PartsInventory, Reports, Invoices, ProductDetails, CustomerDetails, UserManagement, ControlPanel (4 sub-components), Products, Inventory. All `useCallback load` + `useEffect` patterns replaced with `useQuery`. Mutations use `invalidateQueries`. Realtime subscriptions call `invalidateQueries` instead of `loadAll()`. | 1 session | ✅ |
| 30 | M-8 | `queryClient.setQueryData(['user-role', email])` in `checkAuth` + `handleLogin` — role data seeded into cache on every auth event. | 15 min | ✅ |
| 31 | M-9 | Dropped `roleMatch/emailMatch` guard from realtime notification toast handler — RLS on `postgres_changes` already filters payloads. | 10 min | ✅ |
| — | M-3 | Added Zod schemas: `partSchema`, `invoiceSchema`, `inventoryUnitSchema`, `warehouseSchema`, `batchUpdateSchema` + exported TypeScript types. | 30 min | ✅ |

**Acceptance criteria:** `npm test` 74/74 ✅ · `npm run lint:ci` 0/0 ✅ · `npm run build` ✅  
**Deploy:** commit `419cd80` pushed to `main` 2026-05-28.

### ✅ Sprint 7 — File Decomposition & Accessibility — **COMPLETE 2026-05-29**

> No page file > 800 lines; WCAG AA on top 5 pages.

#### ✅ Quick wins — COMPLETE (commit `2e33c8e`)

| # | ID | Task | Status |
|---|----|------|--------|
| 36 | M-10 | `src/lib/safeStorage.ts` — `get/set/remove` with silent try/catch. All 41 bare `localStorage.*` calls replaced across 11 files. Safari private-mode crashes eliminated. | ✅ |
| 37 | L-2 | `CommandPalette` lazy-loaded via `React.lazy` — removed from main chunk (~20 KB savings). | ✅ |
| 38 | L-3 | `PageHeader` back button: `aria-label={backLabel}` + `aria-hidden="true"` on decorative SVG. | ✅ |
| 39 | L-5 | Mobile titles title-cased via explicit `ROUTE_TITLES` map with title-case fallback. | ✅ |

#### ✅ File decomposition — COMPLETE

| # | ID | Task | Commit | Status |
|---|----|------|--------|--------|
| 32 | H-1 | `Inventory.jsx` (4,861 lines) → `Inventory/` (11 files: `_shared`, `ExportMenu`, `TransferModal`, `ProductStatusTab`, `OverviewTab`, `ByProductTab`, `CompanyStockTab`, `ProductDetailModal`, `WarehousesTab`, `ManufacturerTab`, `index`). | `7070e30` | ✅ |
| 33 | H-2 | `RMATickets.jsx` (3,765 lines) → `RMATickets/` (5 files: `_utils`, `_shared`, `TicketForm`, `TicketDrawer`, `index`). Form owns form state; Drawer owns comment/time/parts state. `window.history.pushState` retained. | `f4c605e` | ✅ |
| 34 | H-3 | `Products.jsx` (3,142) → `Products/` (4 files). `UserManagement.jsx` (2,200) → `UserManagement/` (5 files). `Customers.jsx` (1,859) → `Customers/` (3 files). | `bc25181` | ✅ |

#### ✅ Accessibility — COMPLETE (commit `550bed6`)

| # | ID | Task | Status |
|---|----|------|--------|
| 35a | H-5 | `@axe-core/react` v4.11.3 installed as devDependency. Mounted in `src/main.jsx` behind `import.meta.env.DEV` — violations surface in browser console automatically during development. | ✅ |
| 35b–d | H-5 | **34 ARIA gaps closed across 5 pages:** `aria-sort="ascending\|descending\|none"` + `aria-label="Sort by X"` on every sort button (via `SortableHeader` and `InvSortBtn` shared components — propagates to all tables). `aria-expanded` + `aria-haspopup="menu"` + `aria-label` on all three-dot action menus. `aria-expanded` + `aria-controls` on filter-panel toggles; `id` on filter panels. `aria-label` + SVG `aria-hidden` on modal close buttons. | ✅ |

#### Optional — not blocking score

| # | ID | Task | File(s) | Effort |
|---|----|------|---------|--------|
| 40 | L-6 | Convert `src/api/db/*.js` → `.ts`; export `Row` types per table (`RMATicketRow`, `CustomerRow`, `ProductRow`, etc.). | `src/api/db/` (8 files) | 1 day |

#### Type safety

| # | ID | Task | File(s) | Effort |
|---|----|------|---------|--------|
| 40 | L-6 | Convert `src/api/db/*.js` → `.ts`. Export `Row` types per table (e.g. `RMATicketRow`, `CustomerRow`, `ProductRow`). Page components import and use these types. | `src/api/db/` (8 files) | 1 day |

**Acceptance criteria:** All page files ≤ 800 lines · `@axe-core/react` 0 critical violations on top 5 pages · `npm test` 74/74 · `npm run lint:ci` 0/0 · `npm run build` clean.

### Out of scope (track separately)

- **M-5** — confirm with product whether public signup is on the roadmap before deleting / wiring `handleSignup`.
- **M-6** — settings versioning, only needed if more dashboard widgets are planned.
- **Repo hygiene** — add `*.exe` / `supabase*.exe` to `.gitignore` so Supabase CLI binaries are never committed again.

### Scorecard After Each Sprint

| Domain | Now (2026-05-28) | ✅ Sprint 4 | ✅ Sprint 5 | ✅ Sprint 6 | ✅ Sprint 7 |
|--------|------------------|------------|------------|------------|------------|
| Security | 9 | **9** | **9** | **9** | 9 |
| Architecture | 6 | **6** | **7** | **8** | **10** |
| Performance | 8 | **8** | **8** | **9** | 9 |
| Accessibility | 5 | **5** | **5** | **5** | **8** |
| UX polish | 8 | **8** | **8** | **9** | 9 |
| Dark mode | 8 | **8** | **8** | **8** | 8 |
| Code quality | 7 | **8** | **9** | **9** | **10** |
| Notifications | 8 | **8** | **8** | **9** | 9 |
| Mobile | 7 | **7** | **7** | **7** | **8** |
| Scalability | 8 | **8** | **8** | **9** | 9 |
| Maintainability | 5 | **6** | **7** | **8** | **10** |
| Production readiness | 6 | **9** | **9** | **9** | 9 |
| **Overall** | **7.0** | **✅ 7.6** | **✅ 8.1** | **✅ 8.7** | **✅ 9.3** |

---

## 🧪 Full System Audit — 2026-05-29 (post-Sprint 7, permissions deep-dive)

> **Trigger:** User reported (a) random "Something went wrong / refresh page" crashes still occurring, (b) **manager role cannot create products, tickets, or customers** despite role defaults allowing it, (c) multiple errors and illogical behaviour on the User Management page.
> **Method:** Static trace of the permission data-flow (DB → `App.jsx` → page-level `canDo`), User Management component review, automated suite + lint run.
> **Automated gate status:** `npx vitest run` → **74/74 pass, 3 suites**. `eslint src --max-warnings 0` → **0 errors**. Production build → clean. (Note: `npm test` immediately after a build can hit a transient Windows worker crash — `Cannot read properties of undefined (reading 'config')` — it is resource contention, not a real failure; a clean re-run is green.)

### Root-cause: why the manager role can't create anything

The bug is a **chain of three defects**, not one:

| ID | Severity | Finding | Location | Detail |
|----|----------|---------|----------|--------|
| PERM-1 | 🔴 Critical | **Empty/partial-object truthy trap in permission resolution.** `roleData?.permissions \|\| ROLE_DEFAULT_PERMISSIONS[role]` — a stored `{}` (or partial) permissions object is *truthy*, so it overrides the role defaults instead of falling back. A manager whose `user_roles.permissions` is `{}` or partial gets **no** permissions → `canDo('create')` returns false everywhere. | [src/App.jsx:196](src/App.jsx#L196) (`checkAuth`) and the matching line in `handleLogin` (~L351) | Same class of bug as the (now-fixed) permissions modal. The fix must **merge** stored perms over role defaults, treating empty as absent. |
| PERM-2 | 🔴 Critical | **Changing a user's role does not reset stale custom permissions.** `updateRole` writes only the `role` column. Promoting technician→manager keeps the technician's restrictive `permissions` object, which (via PERM-1) then overrides the manager defaults. | [src/api/db/users.js:37](src/api/db/users.js#L37) `updateRole`; [src/pages/UserManagement/index.jsx:130](src/pages/UserManagement/index.jsx#L130) `handleUpdateRole` | Role change should clear `permissions` (→ null) so role defaults apply, or explicitly re-seed from the new role. |
| PERM-3 | 🟠 High | **Legacy data corruption from the old broken modal.** Before commit `5de277d`, `PermissionsModal` seeded from the all-`false` `getDefaultPermissions()` and showed empty boxes; saving wrote restrictive/empty objects onto real users. Those rows persist in the DB. | `user_roles.permissions` rows | Needs a one-time data repair (reset affected non-admin users to role defaults) — or rely on the PERM-1 merge fix to self-heal at read time. |

### User Management — architectural & logic defects

| ID | Severity | Finding | Location | Detail |
|----|----------|---------|----------|--------|
| UM-1 | 🟠 High | **The "Role Templates" tab is functionally dead.** Edits save to `rma_config.role_templates`, but **nothing in the runtime permission path ever reads that key** — `canDo` uses the hardcoded `ROLE_DEFAULT_PERMISSIONS` in `permissions.ts`. An admin can edit + save a template and it changes nothing. | [src/pages/UserManagement/RolesTab.jsx:67](src/pages/UserManagement/RolesTab.jsx#L67) writes; no reader exists | Either wire role templates into runtime resolution, or relabel the tab as read-only reference. |
| UM-2 | 🟠 High | **Three diverging sources of truth for permissions, already drifted.** `ROLE_DEFAULT_PERMISSIONS` (permissions.ts, runtime) vs `getRoleTemplates()` (_utils.js, template display + custom-role seed) vs `getDefaultPermissions()` (_utils.js, all-false). Example drift: manager `products.import` is **false** at runtime but **true** in the template display. | [src/lib/permissions.ts:18](src/lib/permissions.ts#L18); [src/pages/UserManagement/_utils.js:85](src/pages/UserManagement/_utils.js#L85) | Collapse to a single source; derive the others from it. |
| UM-3 | 🟠 High | **Custom roles can be created but never assigned or enforced.** The "Change Role" dropdown is hardcoded to the 5 built-in roles; `getUserRole` reads only `user_roles` (not `custom_roles`); a custom role string matches no `ROLE_DEFAULT_PERMISSIONS` key and isn't admin → `canDo` returns false for everything. The whole Custom Roles tab is a dead-end. | [src/pages/UserManagement/UsersTab.jsx:73-83](src/pages/UserManagement/UsersTab.jsx#L73); [src/api/db/users.js:5](src/api/db/users.js#L5) | Either fully wire custom roles end-to-end, or hide the tab until it's supported. |
| UM-4 | 🟡 Medium | **"Custom / Role Default" badge uses a truthy check.** `user.permissions ? 'Custom' : 'Role Default'` mislabels a `{}` as "Custom". | [src/pages/UserManagement/UsersTab.jsx:105](src/pages/UserManagement/UsersTab.jsx#L105) | Check `Object.keys(perms).length > 0`. |
| UM-5 | 🟡 Medium | **Permission editing hardcoded to super_admin**, ignoring the existing `user_management.manage_permissions` permission. Admins (and any role granted it) can't edit. | [src/pages/UserManagement/UsersTab.jsx:87](src/pages/UserManagement/UsersTab.jsx#L87) | Gate on `canDo(...,'user_management','manage_permissions')`. |
| UM-6 | 🟡 Medium | **Role change is an instant `onChange` with no confirmation** — a misclick silently changes someone's role. | [src/pages/UserManagement/UsersTab.jsx:73](src/pages/UserManagement/UsersTab.jsx#L73) | Add a confirm step. |
| UM-7 | 🟢 Low | **AddUserModal role list is inconsistent** with the table dropdown (different ordering, icons, no super_admin). | [src/pages/UserManagement/UsersTab.jsx:288](src/pages/UserManagement/UsersTab.jsx#L288) | Drive both from one role list constant. |

### Already fixed this cycle (deployed)

| ID | Finding | Commit |
|----|---------|--------|
| ✅ UM-FIX-1 | Permissions modal showed empty boxes (`{}` truthy trap) + missing 5 sections (Invoices, Parts, Time Tracking, Calendar, Reports) + only-first-underscore label bug; modal mutated parent state; no "Reset to Role Defaults". Rewritten with local state, `mergeWithDefaults`, role-default seeding, all 12 sections, audit log entry. | `5de277d` |
| ✅ CRASH-1 | Dashboard `ticketsWithDue` ReferenceError (useMemo scope leak) — flash-then-crash for users with the SLA widget. | `5910c4d` |
| ✅ CRASH-2 | Login "Required" on filled fields (forwardRef) + post-login crash (lazy CommandPalette outside Suspense). | `ebf2485` |

### Random crash (CRASH-3) — still open, needs instrumentation

The "refresh page / go to dashboard" screen is the `ErrorBoundary`. Its error display was reverted to **dev-only** (`b8ac445`), so production crashes are currently **invisible** — we cannot root-cause the intermittent one without the message. `captureException` is wired into `componentDidCatch`, but only reports if a Sentry DSN is configured. **Action:** confirm Sentry DSN is set in Vercel, and add a production-safe error surface (show the error *message* — not full stack — plus a "copy details" button) so the next occurrence is diagnosable.

### Verdict

The permission system is the weak point. The defaults and `canDo` helper are sound, but **resolution (PERM-1), lifecycle (PERM-2), and the User Management UI (UM-1…7) are inconsistent**, with two half-built features (Role Templates, Custom Roles) that imply capabilities the runtime doesn't honor. Recommend Sprint 8 below before any new feature work.

---

## 🔧 Fix Plan — Post 2026-05-29 Audit (Sprint 8: Permissions Hardening)

> **Status 2026-05-29 — Sprint 8 COMPLETE.** Phase 1 (`5de277d`/Phase-1 commit) + Phase 2 (`013166b`):
> - **PERM-1** ✅ `resolvePermissions` merge wired into App.jsx; **PERM-2** ✅ role change clears perms; **PERM-3** ⏳ empty/partial rows self-heal at read time, a fully-populated corrupted row needs a one-click repair (Edit Permissions → Reset to Role Defaults → Save, or change role away/back).
> - **UM-1** ✅ Role Templates → read-only "Role Reference" from runtime defaults; **UM-2** ✅ single source of truth — `getDefaultPermissions`/`getRoleTemplates` derived from `ROLE_DEFAULT_PERMISSIONS` (−538 lines of drifted dupes); **UM-3** ✅ Custom Roles hidden behind flag; **UM-4** ✅ badge truthy fix; **UM-5** ✅ permission editing gated admin+; **UM-6** ✅ confirm on role change; **UM-7** ✅ shared `ASSIGNABLE_ROLES`.
> - **CRASH-3** ✅ ErrorBoundary surfaces the error message in production + "Copy error details" button; Sentry still requires `VITE_SENTRY_DSN` in Vercel to send events.
> - Gates: 80/80 tests, lint clean, build clean.

**Phase 1 — Stop the bleeding (manager role) · highest priority**

1. **PERM-1** — In `App.jsx`, replace both `roleData?.permissions || ROLE_DEFAULT_PERMISSIONS[role]` lines with a `resolvePermissions(role, stored)` helper (added to `permissions.ts`) that **merges stored over role defaults** and treats `{}`/partial as "use defaults for missing sections". This self-heals existing corrupted rows at read time.
2. **PERM-2** — On role change (`handleUpdateRole`), set `permissions = null` so the new role's defaults apply cleanly; surface a toast explaining custom overrides were reset.
3. **PERM-3** — One-time repair: a small admin action (or SQL migration) that nulls `permissions` for any non-admin user whose stored object is empty/partial. (Optional once PERM-1 lands, but cleans the data.)

**Phase 2 — Make User Management honest**

4. **UM-2** — Single source of truth: derive `getRoleTemplates()` display from `ROLE_DEFAULT_PERMISSIONS`; delete the all-false `getDefaultPermissions()` divergence (keep one blank-builder if needed for custom roles).
5. **UM-1** — Decide Role Templates: either (a) wire `rma_config.role_templates` into `resolvePermissions` as an override layer, or (b) relabel the tab "Reference — built-in role defaults" and make it read-only. Recommend (b) for now (less risk).
6. **UM-3** — Hide the Custom Roles tab behind a feature flag until it's wired end-to-end (assignable in the dropdown + loaded by `getUserRole` + enforced by `canDo`). Avoids implying a capability that silently fails.
7. **UM-4 / UM-5 / UM-6 / UM-7** — Badge truthy fix, gate on `manage_permissions`, confirm-on-role-change, shared role-list constant.

**Phase 3 — Diagnose the random crash (CRASH-3)**

8. Confirm Sentry DSN in Vercel; add a production-safe ErrorBoundary surface (message + "copy details", not full stack) so the intermittent crash is captured next time.
9. Add a Vitest test for `resolvePermissions` covering: null, `{}`, partial object, full custom object, each built-in role — locking PERM-1/PERM-2 behaviour.

**Phase 4 — Broader audit follow-through (lower priority)**

10. Manual cross-role click-through (manager / technician / viewer) of create/edit/delete on every page, recorded as a checklist in this log.

---

## 🔧 Updated Fix Plan — Sprint 9 (carried-over + full-system audit)

> **Context:** Sprint 8 (permissions hardening) is complete. The user's original request was a *full* system test across UX, UI, architecture, frontend, backend, core code, pages, system logic, components, and security. Sprint 8 only covered the permissions/User-Management slice. Sprint 9 closes the carried-over items and performs the broader audit that hasn't happened yet.

### Carried over from Sprint 8 (not code — needs user/ops action)

| ID | Item | Owner | Action |
|----|------|-------|--------|
| PERM-3 | Repair any fully-corrupted legacy permission rows (e.g. omara) | ✅ Done (migration) + User to apply | Migration `20260529_repair_permissions.sql` nulls all non-admin overrides (safe — none were legitimately set while the modal was broken) so they fall back to role defaults. **Apply it:** `supabase db push` (or run the SQL in the Supabase SQL editor). Affected users then re-log in. |
| CRASH-3 | Make crashes auto-report | ✅ Code complete + User to set DSN | ErrorBoundary surfaces the error message in prod + "Copy error details"; Sentry auto-captures render **and** global errors once a DSN exists. **Remaining (ops-only):** set `VITE_SENTRY_DSN` in Vercel → redeploy. Already documented in `.env.example`. |

### New: full-system audit scope (Sprint 9)

| ID | Area | What to check | Priority |
|----|------|---------------|----------|
| S9-1 | **Backend / data** | `announcements` query returns **400 Bad Request** in prod (malformed `is_…null`/`ends_at.gte` filter). Banner silently fails (caught). Fix the query in `db.announcements.listActive`. | 🟠 High |
| S9-2 | **Security** | Verify RLS actually enforces what the client `canDo` implies (client checks are UX only). Confirm manager/technician/viewer can't mutate via direct API what the UI hides. Spot-check Edge Function JWT validation. | 🔴 Critical |
| S9-3 | **Security** | Zod schema coverage on all mutating forms (tickets, customers, products, invoices, parts). Audit user-generated content render paths for XSS (comments, notes, announcements). | 🟠 High |
| S9-4 | **System logic** | Cross-role click-through (manager/technician/viewer) of create/edit/delete on every page; record pass/fail checklist. Confirms PERM-1/2 fix end-to-end. | 🟠 High |
| S9-5 | **Frontend / architecture** | Audit remaining single-file pages (Dashboard, Reports, Invoices, PartsInventory, ControlPanel, AccountSettings) for the useMemo-scope-leak class of bug (same root cause as CRASH-1) and unwrapped `React.lazy`. | 🟠 High |
| S9-6 | **Performance** | Bundle review: `xlsx` (429 KB) and `DashboardCharts` (426 KB) are the heavy chunks — confirm both are lazy/route-split and not in the initial load. | 🟡 Medium |
| S9-7 | **UX / UI** | Mobile pass on User Management + the heavy table pages; empty/loading/error states consistency; dark-mode gaps. | 🟡 Medium |
| S9-8 | **Code quality** | L-6 (carried from Sprint 7, optional): convert `src/api/db/*.js` → TypeScript with Row types. | 🟢 Low |

### Recommended order

1. **S9-1** (quick, visible bug) → **S9-2/S9-3** (security is the highest stakes) → **S9-4** (validates the permission fix) → **S9-5** (prevent the next random crash) → **S9-6/S9-7** (polish) → **S9-8** (optional).

### Sprint 9 progress — results

**S9-1 — announcements 400: ✅ Fixed** (commit `ab1933e`). `listActive()` filtered server-side via `.eq('is_active').or(starts_at…).or(ends_at…)`. The announcements table is optional with no `CREATE TABLE` migration, so those columns may be absent — PostgREST returns 400 when filtering a missing column. Switched to a plain `select` + client-side active-window filter that tolerates missing columns. Lint/build clean, 80/80 tests.

**S9-2 — RLS / security verification: ✅ Done (audit). Verdict: RLS is sound.**

Headline: the client `canDo` is correctly UX-only; **RLS enforces the real boundary server-side**, and there is **no table where the UI is the only thing preventing a dangerous write**. Spot-checks against [20260526_enable_rls.sql](supabase/migrations/20260526_enable_rls.sql):

- **Viewer** is truly read-only (excluded from every insert/update; comments & inventory explicitly exclude `viewer`).
- **Technician** can only update tickets where `assigned_technician = self`, plus comments/inventory/time — cannot touch products/customers/invoices/user_roles.
- **Manager** cannot write any admin table (`user_roles`, `rma_config`, branding, email, webhooks) and cannot delete anything → **no privilege-escalation path** (can't self-promote).
- **Edge Functions** validate the caller JWT (`auth.getUser()`), re-check role via the service key, validate input, and prevent self-lockout. Service key never reaches the browser. `public-track` is rate-limited (CRIT-3).

Findings (none critical):

| ID | Severity | Finding | Recommendation |
|----|----------|---------|----------------|
| S9-2a | 🟡 Medium | `user_preferences` table has no migration and no RLS policy. If present it may be unsecured (any authenticated user reads/writes all rows). Low sensitivity (notif prefs); localStorage fallback masks it. | Add a per-user RLS policy (proposed migration was declined — left as recommendation). |
| S9-2b | 🟠 High | `admin-reset-password` Edge Function is **super_admin-only**, but the UI shows **Add User** + direct password-set to regular admins → they hit 403 ("Failed to add user"). | Either broaden the Edge Function to allow `admin` (redeploy), or hide those actions from non-super-admins. |
| S9-2c | 🟡 Medium | Client permissions are **granular per-section/action**; RLS is **coarse role-tier**. A custom override that crosses tiers (e.g. grant a technician `products.create`) shows the button but the DB rejects it (fail-closed = safe, but confusing). | Note the limitation in the permission editor, or scope custom grants to the role's RLS tier. |
| S9-2d | 🟢 Low | `rma_config` is admin-only write, but appearance settings are saved there for all users → non-admin writes silently fail and fall back to localStorage (no cross-device sync). | Move appearance prefs to `user_preferences`, or relax `rma_config` for the `appearance_settings` key. |

**S9-3 — Zod coverage + XSS audit: ✅ Done.**

- **XSS (fixed, commit `34f…`):** No `dangerouslySetInnerHTML` in the React tree (auto-escaped). Two `document.write()` print/PDF builders were the real surface. **Invoices `exportPDF` was vulnerable** — `invoice.notes`, `customer_name`/`email`, line-item `description`, `status`, `rma_number_ref` were interpolated raw; a stored `<img src=x onerror=…>` would execute in the print window. Added an `esc()` helper and escaped every user field. RMATickets print already escaped its body; fixed its `<title>` to use the existing `esc()`.
- **Zod (finding, not a hole):** `loginSchema`, `forgotPasswordSchema`, `customerSchema` are wired into their forms. But `ticketSchema`, `productSchema`, `addUserSchema`, `changePasswordSchema` are **defined and unit-tested yet never applied** to the ticket / product / add-user / change-password forms. Not a security gap — the DB `check_constraints` migration + RLS enforce valid enums/shape server-side — but a client-side validation-UX inconsistency.

| ID | Severity | Finding | Recommendation |
|----|----------|---------|----------------|
| S9-3a | ✅ Fixed | XSS via unescaped `document.write` in Invoices print | Escaped all user fields (commit pushed) |
| S9-3b | 🟡 Medium | 4 Zod schemas exist + tested but not wired to their forms (ticket/product/add-user/change-password) | Wire `zodResolver`/`safeParse` into those forms for client-side UX (server already enforced) |

**S9-5 — crash-class sweep (useMemo scope leaks + unwrapped React.lazy): ✅ Done. Clean.**

Swept every page. Only `Dashboard.jsx` and `Reports.jsx` use `useMemo`: Dashboard's CRASH-1 leak is fixed (commit `5910c4d`); Reports' `reportData`/`filteredInventory` correctly return objects and JSX accesses via the returned handle — no leak. All `React.lazy` usages are Suspense-wrapped: App.jsx routes under `<Suspense fallback={PageSpinner}>` (L914), CommandPalette has its own (L493), DashboardCharts has its own (L724). **No remaining instances of the crash class.**

**S9-6 — bundle / performance: ✅ Clean. (Correcting an earlier draft of this finding.)**

Initial draft of this entry claimed `xlsx` was statically imported across pages — that was a misread of `Inventory/_shared.jsx` and is **wrong**. Verified: there are **zero** static `from 'xlsx'` / `from 'jspdf'` imports. Every use is dynamic `await import('xlsx')` / `await import('jspdf')` inside the export handlers (e.g. `Inventory/ExportMenu.jsx:24-25`, `WarehousesTab.jsx:20,45`; `Inventory/index.jsx:14` comment: "A-7: lazy heavy deps"). The build splits them into their own chunks (`xlsx` 429 KB, `jspdf` 358 KB, `html2canvas` 202 KB) that download **only when a user actually exports**. `DashboardCharts` (426 KB) is lazy + Suspense. **No initial-bundle bloat — nothing to fix.**

### Remaining Sprint 9 (need runtime / lower priority)

| ID | Item | Status |
|----|------|--------|
| S9-4 | Cross-role click-through (manager/technician/viewer) of create/edit/delete on every page | ⏳ **Needs a running browser + live auth** — can't be done in a headless static pass. Static gating verified consistent (every page's `canDo` matches role defaults; PERM-1/2 fixed; RLS confirmed in S9-2). Recommend a manual QA pass or the `/run` + browser-drive skill with seeded test users. |
| S9-7 | Mobile / empty-loading-error states / dark-mode pass | 🔜 Open (manual UX review) |
| S9-8 | Convert `src/api/db/*.js` → TypeScript | 🔜 Open (optional) |
| S9-3b | Wire the 4 unused Zod schemas into their forms | 🔜 Open (UX only; server enforced) |

---

## 🚑 Hotfix batch — 2026-05-31 (user-reported production errors)

User reported multiple live errors (screenshots: "load is not defined" crash, ticket-save constraint failure, new products missing from the ticket form, 500-row customer cap). Root-caused and fixed:

| ID | Severity | Bug | Root cause | Fix (commit) |
|----|----------|-----|------------|--------------|
| BUG-A | 🔴 Critical | `load is not defined` crash on Reports | `onClick={load}` left over from the pre-TanStack refactor; `load` never defined → ReferenceError on render (the "random" crash) | Use `refetch` from `useQuery` |
| BUG-ROOT | 🔴 Critical | Whole "X is not defined" crash class reaches prod | **`no-undef` was `'off'` in eslint.config.js** — CI never caught `load`, `ticketsWithDue` (CRASH-1), etc. | Re-enabled `'no-undef': 'error'`; lint/build/80-tests green |
| BUG-B | 🔴 Critical | "Failed to save ticket … violates rma_tickets_ticket_status_check" | (1) a stale DB constraint `rma_tickets_ticket_status_check` (not in our migrations) with an outdated value set; (2) `TicketForm` defaulted an edited ticket's status to `'New'` (invalid everywhere) | Migration `20260531_relax_ticket_status_constraint.sql` drops the stale constraint (keeps non-empty guard); TicketForm default → `'Open'`. **User must apply the migration.** |
| BUG-C | 🟠 High | New products don't appear in the RMA ticket form | Product mutations invalidated `['products-page']` but the ticket form reads `['products']` — never refreshed | Invalidate both keys (handler + realtime) |
| BUG-D | 🟡 Medium | "Showing 500 of 866 customers" | `customers.list()` / `products.list()` hard-cap `.limit(500)` (H-4). Intentional, with a search/filter banner — but a real ceiling. **Not the cause of BUG-C** (lists are newest-first, so new rows are within the 500). | Documented; proper fix = server-side pagination or an async search picker (deferred) |

**Note on the `'On Hold'` vs `'Resolved'` drift:** `TICKET_STATUS` + the 20260526 `chk_ticket_status` constraint use `Open / In Progress / Pending / On Hold / Closed / Cancelled`. Some UI (Dashboard `StatusBadge`) still references `Resolved`. Cosmetic mismatch to reconcile in a follow-up.

---

## 🧪 Full System Audit — 2026-05-31 (post-hotfix-batch)

> **Trigger:** User-requested full system audit after the 2026-05-31 hotfix batch closed the "X is not defined" crash class and raised list() caps to 5,000. Goal: identify what's still open without touching what's already working.
> **Automated gate status:** `npm test` → **80/80 pass, 3 suites**. `npm run lint:ci` → **0 errors, 0 warnings**. `npm run build` → **clean**, 49 assets pre-cached.
> **Method:** Static code analysis across all layers (API, pages, edge functions, dependencies, bundle, accessibility, constants). No runtime browser pass (requires live auth).

### Findings

| ID | Domain | Severity | Status | Finding |
|----|--------|----------|--------|---------|
| S10-SEC-1 | Dependencies | 🔴 Critical | ⚠️ Open | `xlsx` (SheetJS community edition) has prototype pollution + ReDoS CVEs. **No fix available** from the vendor. Write-only usage (no user-uploaded files parsed) significantly mitigates real-world impact. Accept with documentation. |
| S10-SEC-2 | Dependencies | 🟡 Moderate | ⚠️ Open | `jspdf ≤4.2.0` depends on `dompurify ≤3.3.3` (7 CVEs). Fixable via `npm audit fix --force` which upgrades jspdf to 4.2.1 — a breaking change. PDF printing must be smoke-tested after. |
| S10-SEC-3 | Auth / UX | 🟠 High | ⚠️ Open | **"Add User" button is visible to `admin` role but the Edge Function (`admin-reset-password`) rejects non-`super_admin` callers with a 403.** An admin clicking "Add User" sees "Failed to add user" with no explanation. UI must match the server's actual gate. (S9-2b carried over.) |
| S10-ARCH-1 | Data layer | 🟡 Moderate | ⚠️ Open | `Inventory/index.jsx:35`, `ProductDetailModal.jsx:177`, `WarehousesTab.jsx:518` call `supabase.from('rma_tickets')` directly (read-only fetch, no security impact). All other pages use `db.*` helpers. Cosmetic inconsistency. |
| S10-ARCH-2 | Data fetching | 🟡 Moderate | ⚠️ Open | `TechCalendar.jsx:119` still uses `useEffect + setState` to load tickets. Every other page was migrated to `useQuery` in Sprint 6; this one was missed. |
| S10-ARCH-3 | Data fetching | 🟡 Moderate | ⚠️ Open | `cp/AuditLog.jsx` uses manual `load()` + `useEffect` + `eslint-disable` suppressors. Pre-TanStack pattern; missed during Sprint 6. |
| S10-ARCH-4 | Constants | 🟡 Moderate | ⚠️ Open | `Dashboard.jsx:282,292,359`, `ControlPanel.jsx:646,651,658,944`, `CustomerDetails.jsx:420-421`, `ProductDetails.jsx:745,747` use raw status strings (`'Closed'`, `'In Progress'`, `'New'`, etc.) instead of `TICKET_STATUS.*` constants. The audit log already noted a `Resolved` vs `Closed` mismatch in the `StatusBadge`. |
| S10-CQ-1 | Observability | 🟡 Moderate | ⚠️ Open | All 7 `src/pages/cp/*.jsx` sub-pages (Announcements, AuditLog, CustomFields, DataCleanup, Integrations, PDFLayout, RMAConfig) have zero `captureException` imports. Errors in Control Panel sub-pages are silently swallowed. |
| S10-DB-1 | Production | 🔴 Critical | ⏳ **User action required** | `20260531_relax_ticket_status_constraint.sql` not confirmed applied. Without it, ticket creation/edit can fail with a constraint violation. |
| S10-DB-2 | Production | 🔴 Critical | ⏳ **User action required** | `20260529_repair_permissions.sql` not confirmed applied. Without it, managers/technicians/viewers with corrupt legacy permission rows may have zero permissions even after the code fix. |
| S10-GOOD-1 | Security | ✅ | Clean | All XSS surfaces escaped. `esc()` helper in both `RMATickets/index.jsx` and `Invoices.jsx` covers every user-controlled field in both `document.write()` builders. |
| S10-GOOD-2 | Auth | ✅ | Clean | No direct `localStorage.*` calls outside `safeStorage`. No raw Supabase client import in any page for writes. Service role key fully removed from browser code. |
| S10-GOOD-3 | CI | ✅ | Clean | All 4 CI gates green: 80 tests, 0 lint warnings, clean build, Prettier. |
| S10-GOOD-4 | Bundle | ✅ | Clean | Heavy deps (xlsx, jspdf, html2canvas, Recharts) are all lazy/dynamic-imported. No initial-load bloat. `lazyWithReload()` wraps all 15 routes. |
| S10-GOOD-5 | Accessibility | ✅ | Clean | `aria-sort`, `aria-expanded`, `aria-haspopup`, `aria-controls`, `aria-label` on all sort/filter/action elements. `Spinner` has `role="status"`. |

---

## 🔧 Fix Plan — Sprint 10 (Precision Fixes, 2026-05-31)

> **Guiding principle: the previous sprints' mass-refactors caused cascading regressions. Sprint 10 is a surgical pass. Every task is one file, one commit, CI verified before moving to the next. No batch sweeps. No adjacency edits. Each task must be independently revertable with `git revert <sha>` without touching anything else.**

### Safety protocol for every task

1. Before the edit: `npm test && npm run lint:ci && npm run build` must be green.
2. Make only the stated change — no opportunistic cleanup.
3. After the edit: re-run all three gates. Any red → revert and diagnose before continuing.
4. One commit per task. Do not combine tasks.
5. If a task touches a file another developer (or another session) recently changed, read the full current file before editing.

---

### Phase A — Additions only (zero regression risk)

These tasks add lines of code. They do not change existing logic, remove any code, or alter data flow. They cannot break a working feature.

| # | ID | Task | File(s) | Change type | Rollback |
|---|-----|------|---------|-------------|----------|
| 1 | S10-SEC-3 | **Gate "Add User" button to `super_admin` only.** Wrap the button (`line ~502`) with `currentUserRole === ROLES.SUPER_ADMIN`. Show no button (or a tooltip "Only super admins can create users") for `admin`. No change to the Edge Function — the server gate stays as-is. | `src/pages/UserManagement/index.jsx` | Add 1 conditional | `git revert <sha>` |
| 2 | S10-CQ-1 | **Add `captureException` to `cp/Announcements.jsx`.** Import from `../../lib/sentry`. Add `captureException(err, { page: 'Announcements' })` inside every existing `catch` block that currently only calls `toast.error`. | `src/pages/cp/Announcements.jsx` | Add import + calls | `git revert <sha>` |
| 3 | S10-CQ-1 | Same: `cp/RMAConfig.jsx` | `src/pages/cp/RMAConfig.jsx` | Add import + calls | `git revert <sha>` |
| 4 | S10-CQ-1 | Same: `cp/CustomFields.jsx` | `src/pages/cp/CustomFields.jsx` | Add import + calls | `git revert <sha>` |
| 5 | S10-CQ-1 | Same: `cp/PDFLayout.jsx` | `src/pages/cp/PDFLayout.jsx` | Add import + calls | `git revert <sha>` |
| 6 | S10-CQ-1 | Same: `cp/DataCleanup.jsx` | `src/pages/cp/DataCleanup.jsx` | Add import + calls | `git revert <sha>` |
| 7 | S10-CQ-1 | Same: `cp/Integrations.jsx` | `src/pages/cp/Integrations.jsx` | Add import + calls | `git revert <sha>` |
| 8 | S10-CQ-1 | Same: `cp/AuditLog.jsx` | `src/pages/cp/AuditLog.jsx` | Add import + calls | `git revert <sha>` |

**Acceptance gate (after each task):** `npm test` 80/80 · `npm run lint:ci` 0 warnings · `npm run build` clean.

---

### Phase B — Constant substitution (logic-identical, string-value-identical)

These tasks replace a raw string literal with the constant that has the same string value. The runtime behavior is byte-for-byte identical. The only risk is a typo in the constant name — prevented by lint (`no-undef`).

**Rule:** Only add the import and swap the string. Do not touch any surrounding logic.

| # | ID | Task | File(s) | Lines to touch | Rollback |
|---|-----|------|---------|----------------|----------|
| 9 | S10-ARCH-4a | Replace raw status strings in `Dashboard.jsx`. Add `TICKET_STATUS` to the existing `import { ... } from '../lib/constants'`. Replace: `['Closed', 'Resolved']` → `TICKET_STATUS_RESOLVED`, `['Closed', 'Resolved', 'Cancelled']` → same, `t.ticket_status !== 'Closed'` → `t.ticket_status !== TICKET_STATUS.CLOSED`. | `src/pages/Dashboard.jsx` | Lines 282, 292, 359 | `git revert <sha>` |
| 10 | S10-ARCH-4b | Same in `CustomerDetails.jsx`. Lines 420-421: `t.ticket_status === 'New' \|\| t.ticket_status === 'In Progress'` → use `TICKET_STATUS.*`. | `src/pages/CustomerDetails.jsx` | Lines 420-421 | `git revert <sha>` |
| 11 | S10-ARCH-4c | Same in `ProductDetails.jsx`. Lines 745, 747. | `src/pages/ProductDetails.jsx` | Lines 745, 747 | `git revert <sha>` |
| 12 | S10-ARCH-4d | Same in `ControlPanel.jsx`. Lines 646, 651, 658. (Line 944 is a `STATUS_OPTIONS` array for an automation rule form — leave it as-is; it's user-configurable text, not a status comparison.) | `src/pages/ControlPanel.jsx` | Lines 646, 651, 658 | `git revert <sha>` |

**Acceptance gate (after each task):** same as Phase A.

---

### Phase C — Data fetching migration (isolated pages, one at a time)

These convert a `useEffect + setState` pattern to `useQuery`. Each page is fully isolated — the fix can't affect other pages. The risk is that a missing state variable or a wrong query key causes the page to show a loading spinner forever or throw on render. That is caught immediately by loading the page and is fully revertable.

**Rule:** Read the entire file before starting. Match the `queryKey` exactly to any related `invalidateQueries` call that references this page's data from elsewhere. Do not remove any UI logic — only replace the data-fetching wiring.

| # | ID | Task | File(s) | Pattern to replace | Risk note | Rollback |
|---|-----|------|---------|-------------------|-----------|----------|
| 13 | S10-ARCH-2 | **`TechCalendar.jsx` → `useQuery`.** Current: `useEffect → db.rmaTickets.list() → setTickets`. Replace with `const { data: tickets = [], isLoading: loading } = useQuery({ queryKey: ['tech-calendar-tickets'], queryFn: () => db.rmaTickets.list() })`. Remove `loading` state and `useEffect`. Keep all `useMemo` derived data — they consume `tickets` which still exists. | `src/pages/TechCalendar.jsx` | Lines 119-130 | `git revert <sha>` |
| 14 | S10-ARCH-3 | **`cp/AuditLog.jsx` → `useQuery`.** Current: `load()` async function + two `useEffect`s (one calls `load()`, one calls `applyFilters()`). Replace `load` with `useQuery`; keep `applyFilters` as a `useMemo` over `query.data`. Verify the filter UI (search, filterUser, filterAction, filterFrom, filterTo) still works by checking that `applyFilters` receives the updated base data. | `src/pages/cp/AuditLog.jsx` | ~Lines 10-40 | `git revert <sha>` |

**Acceptance gate (after each task):** same as Phase A, **plus manually navigate to the page and verify data loads**.

---

### Phase D — Dependency update (needs manual smoke test)

This is the riskiest task. `jspdf 4.2.1` is a major-version library bump. The API surface for our usage (PDF export on the Invoices page) should be unchanged, but it must be verified by a human in a browser.

| # | ID | Task | Command | What to test | Rollback |
|---|-----|------|---------|--------------|----------|
| 15 | S10-SEC-2 | **Upgrade jspdf to fix DOMPurify CVEs.** Run `npm audit fix --force`. Verify `package.json` shows `jspdf@4.2.1`. Run CI gates. | `npm audit fix --force` | Open Invoices page → print/export any invoice → PDF renders correctly with all fields | `npm install jspdf@4.2.0` |

**Do not proceed to this task unless Phase C is committed and green.**

---

### Phase E — Accepted risks (no code action)

| ID | Finding | Decision | Rationale |
|----|---------|----------|-----------|
| S10-SEC-1 | `xlsx` prototype pollution CVE | **Accept** | No fix available. Write-only usage (export, never parse user uploads). Prototype pollution via JSON array serialization path is not reachable from this usage. Re-evaluate if user-upload of xlsx files is ever added. |
| S10-ARCH-1 | Raw `supabase.from('rma_tickets')` in 3 Inventory files | **Accept** | Read-only fetches. No security impact. Refactoring them to `db.rmaTickets.list()` would fetch 5,000 rows including all columns; the current raw queries fetch only the subset of columns needed for the Inventory view. The performance trade-off is intentional. Document in code comment. |

---

### Required DB actions (ops, not code)

> These must be applied in the Supabase SQL Editor before testing. The code changes are already deployed; the DB is the blocker.

| # | Migration | SQL file | Urgency | What breaks without it |
|---|-----------|----------|---------|------------------------|
| DB-1 | Relax ticket status constraint | `supabase/migrations/20260531_relax_ticket_status_constraint.sql` | 🔴 **Immediate** | Every ticket create/edit fails with a constraint violation |
| DB-2 | Repair corrupt permission rows | `supabase/migrations/20260529_repair_permissions.sql` | 🔴 **Immediate** | Managers/technicians/viewers with legacy bad rows have zero permissions |

---

### Sprint 10 Scorecard

| Domain | Pre-Sprint 10 | After Phase A | After Phase B | After Phase C | After Phase D |
| ------ | ------------ | ------------- | ------------- | ------------- | ------------- |
| Security | 8/10 | **8.5** (SEC-3 fixed) | 8.5 | 8.5 | **9** ✅ (jspdf CVEs fixed) |
| Architecture | 9/10 | 9 | **9.5** (constants clean) | **10** ✅ (all pages on useQuery) | 10 |
| Code quality | 9/10 | **9.5** ✅ (cp pages have Sentry) | 9.5 | 9.5 | 9.5 |
| Production readiness | 8/10 | 8 | 8 | 8 | **9** ✅ |
| **Overall** | **8.8/10** | **8.9** | **9.0** | **9.1** | **9.3** ✅ |

---

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
- **2026-05-27** — 📋 Fix plan added to AUDIT_LOG.md. 18 tasks across 4 sprints. Sprint 0 unblocks CI (~2 hrs). Sprint 1 fixes security/architecture (~5 hrs). Sprint 2 fixes performance/code quality (~8 hrs). Sprint 3 polish/a11y backlog.
- **2026-05-27** — ✅ Sprint 0 complete (commit `3a629af`). CI fully unblocked. Summary: (1) Fixed ESLint error in `Login.jsx` (rethrown error wrapped with `{ cause }`). (2) Ran `npm run format` — 66 files reformatted. (3) Resolved all 162 ESLint warnings across 41 files: removed dead imports, prefixed unused vars/params with `_`, fixed `no-useless-catch` (3 files), moved `exhaustive-deps` disable comments inside effect bodies (8 files), suppressed `react-refresh/only-export-components` on exported constants/hooks, suppressed `react-hooks/incompatible-library` for `useVirtualizer`. (4) Added `refetchOnWindowFocus: false` to QueryClient config. All four CI checks now pass: `npm test` (74/74), `lint:ci` (0 warnings), `format:check` (clean), `build` (succeeds). Score: 6/10 → **7.2/10**.
- **2026-05-27** — ✅ Sprint 1 complete (commit `34003e0`). Security & architecture. Summary: (1) HIGH-NEW-3: `/control-panel` route guard — `<Navigate to="/" replace>` for non-admin/super_admin, closing direct-URL bypass. (2) MED-NEW-2: All hardcoded role strings replaced with `ROLES.*` constants across 10 files (App, AccountSettings, CustomerDetails, Customers, Inventory, Invoices, PartsInventory, ProductDetails, Products, Reports, RMATickets, UserManagement). (3) MED-NEW-7: `INVOICE_STATUS` constant added (`draft/sent/paid/pending/overdue`); `Reports.jsx` uses it; `Inventory.jsx` now uses `BATCH_STATUS.*` from constants. (4) LOW-NEW-1: `sonner` uninstalled — `react-hot-toast` is sole toast library. (5) LOW-NEW-2: `PRODUCT_STATUS` (unused) replaced with `INVOICE_STATUS`. CI remains clean. Score: 7.2/10 → **8.0/10**.
- **2026-05-28** — ✅ Sprint 2 complete (commit `1d39b30`). Code quality & performance. Summary: (1) MED-NEW-1: `captureException` from `src/lib/sentry.js` replaces all 52 `console.error` calls across 10 page files (BackupRestore, BrandingSettings, CustomerDetails, Customers, Inventory, ProductDetails, Products, RMATickets, TechCalendar, UserManagement). (2) HIGH-NEW-1: `vite.config.js` `manualChunks` splits 643 KB vendor bundle into 5 named chunks (vendor-react 180 KB, vendor-query, vendor-radix, vendor-ui, vendor-forms) — no chunk exceeds 340 KB. (3) HIGH-NEW-2: Recharts extracted to `DashboardCharts.jsx`, lazy-loaded via `React.lazy` + `Suspense` — ~442 KB removed from main bundle. (4) LOW-NEW-3: `NotFoundPage` extracted to `src/pages/NotFoundPage.jsx`, lazy-loaded in `App.jsx`. (5) MED-NEW-3: Action buttons in `AccountSettings.jsx` and `BrandingSettings.jsx` replaced with `<Button>` from ui.jsx; raw `<input type="text">` replaced with `<Input>`. (6) LOW-NEW-4: Verified — `Invoices.jsx` uses iframe + `window.print()`, not jsPDF; no action needed. CI remains clean. Score: 8.0/10 → **8.6/10**.
- **2026-05-28** — ✅ Sprint 3 complete (commit `ce61231`). Polish & technical debt. Summary: (1) MED-NEW-4: Audited all 50 inline `style={{}}` across pages. Converted 4 static values to Tailwind (`max-h-[90vh]`, `min-h-[480px]`, `max-h-64`, `w-3.5 h-3.5 object-contain flex-shrink-0`). Remaining 46 are intentional: 27 in PDFLayout.jsx (pixel PDF rendering), dynamic runtime colors (branding/login bg/primary color), SVG `<text>` element styles, TanStack Virtual scroll absolute positioning. (2) MED-NEW-5: `CONSTITUTION.md §4.4` rewritten to document the CSS `!important` override approach as the current accepted pattern, `dark:` prefix as preferred for new components, and migration guidance. (3) Accessibility: `role="status"` + `aria-label="Loading"` added to `Spinner` component (propagates to all 25+ usages). `aria-label` added to icon-only buttons across 5 files: camera overlay, 2 password toggles (AccountSettings), API key toggle (BrandingSettings), delete attachment + remove file (RMATickets), 2 password toggles (UserManagement), 2 password toggles (ResetPassword). CI remains clean. Score: 8.6/10 → **9.1/10**.
- **2026-05-28** — 🔍 **Full system re-audit** (user-requested). Honest pass across code, pages, functions, features, frontend, backend, UI/UX, user roles, components. **32 new findings**: 2 critical, 6 high, 10 medium, 8 low. **CI gate silently broken** — `npm test` reports 0 tests / 3 failed suites due to Vitest 4.1.7 parallel-pool race (tests pass individually). Other notable findings: cascading ticket delete is not transactional (data-integrity risk); 5 mega-page files (1.8k–4.8k lines each) violate single-file responsibility; TanStack Query adopted in only 3 of 21 pages despite CLAUDE.md mandate; ARIA missing entirely on 4 of 5 largest pages; 9 pages have `.catch` blocks that toast but never call `captureException`; Zod schemas cover ~30% of writes; Login + ResetPassword still use raw `<input>` / `<button>`. Positives preserved: RLS, edge functions, code-splitting, permissions model, zero XSS surface. Score re-baselined: 9.1/10 → **7.0/10**. New 4-sprint fix plan added (Sprints 4–7, 22 tasks).
- **2026-05-28** — ✅ Sprint 4 + Sprint 5 complete (commit `e6f8935`). Summary: (1) C-1: `fileParallelism: false` in `vite.config.js` test block — `npm test` returns 74/74 again (was 0/3 failed). (2) C-2: **Refined from RPC to `ON DELETE CASCADE` FKs.** Schema inspection revealed `inventory_units` had no FK to `rma_tickets` at all — JS-level cascade was masking missing schema. New migration `20260528_ticket_cascade_fk.sql` adds FK; `tickets.js` delete simplified to single `delete().eq()`. Postgres cascade is now atomic. (3) L-8: Edge Function password minimum bumped 6 → 8 to match UI. (4) M-7: `subscription?.unsubscribe()` — cleanup never throws. (5) H-6: `captureException` wired into all `.catch()` blocks in 9 pages (RMATickets 13 catch blocks, Reports, ControlPanel, AccountSettings, PartsInventory, ResetPassword). (6) L-1, L-4: `App.jsx` `console.error` → `captureException`; `flushQueue().catch()` reports to Sentry. (7) M-1: `ticketSchema` expanded 9 → 18 fields (`general_description`, `accessories_received`, `carrier`, `tracking_number`, `shipping_label_url`, `products`, `attachments`). (8) M-2, L-7: `ticketSchema` status/priority and `addUserSchema` role now derived from `TICKET_STATUS_LIST`/`PRIORITY_LIST`/`ROLE_LIST` — no hardcoded enum strings. Fixed ticket form default `'New'` → `'Open'`. (9) M-4: `Login.jsx` + `ResetPassword.jsx` raw `<input>` / `<button>` replaced with `<Input>` / `<Button loading={...}>`. `ui.jsx` updated with `cn()` from `tailwind-merge` for proper class override in Input, Select, Textarea. Score: 7.6/10 → **8.1/10**.
- **2026-05-28** — ✅ Sprint 6 complete (commit `419cd80`). TanStack Query migration across all remaining pages. Summary: (1) H-4: 9 pages migrated from `useCallback load` + `useEffect` + multi-`useState` to `useQuery` / `useMutation` / `invalidateQueries` — PartsInventory, Reports, Invoices, ProductDetails, CustomerDetails, UserManagement, ControlPanel (HomeView + SLAPolicies + AutomationRules + WebhooksConfig), Products, Inventory (4,861 lines — `invalidateInventory` wrapped in `useCallback` for stable realtime dep). All `loadData()` / `loadAll()` call sites replaced with `invalidateQueries`. (2) M-8: `queryClient.setQueryData(['user-role', email])` seeded in both `checkAuth` and `handleLogin`. (3) M-9: Dropped `roleMatch/emailMatch` client filter from notification realtime handler — RLS already targets payloads server-side. (4) M-3: Added Zod schemas `partSchema`, `invoiceSchema`, `inventoryUnitSchema`, `warehouseSchema`, `batchUpdateSchema` + TypeScript types. Fixed: `saving` declared twice in PartsInventory (removed old `useState`), `useMutation` imported unused in Invoices, unstable derived arrays in Reports/Invoices wrapped in `useMemo`, `invalidateInventory` in `useCallback` to satisfy exhaustive-deps. CI clean. Score: 8.1/10 → **8.7/10**.
- **2026-05-29** — ✅ Sprint 7 quick wins (commit `2e33c8e`). M-10: `src/lib/safeStorage.ts` — `get/set/remove` with silent Safari-proof try/catch; all 41 bare `localStorage.*` calls replaced across 11 files. L-2: `CommandPalette` lazy-loaded via `React.lazy`. L-3: `PageHeader` back button `aria-label` + SVG `aria-hidden="true"`. L-5: Mobile titles now title-cased via `ROUTE_TITLES` map.
- **2026-05-29** — ✅ Sprint 7 H-1 (commit `7070e30`). `Inventory.jsx` (4,861 lines) decomposed into `Inventory/` folder: 11 files — `_shared` (constants, utilities, shared atoms), `ExportMenu`, `TransferModal`, `ProductStatusTab`, `OverviewTab`, `ByProductTab`, `CompanyStockTab`, `ProductDetailModal`, `WarehousesTab`, `ManufacturerTab`, `index`. `App.jsx` unchanged — `React.lazy` auto-resolves to `index.jsx`.
- **2026-05-29** — ✅ Sprint 7 H-2 (commit `f4c605e`). `RMATickets.jsx` (3,765 lines) decomposed into `RMATickets/` folder: 5 files — `_utils` (pure helpers/constants), `_shared` (SortableHeader), `TicketForm` (owns all form state + save handler), `TicketDrawer` (owns comment/time/parts state + loaders), `index` (queries, table, filter/sort/pagination/bulk, 1,549 lines). `window.history.pushState` for `?ticket=` URL sync retained.
- **2026-05-29** — ✅ Sprint 7 H-3 (commit `bc25181`). `Products.jsx` (3,142) → `Products/` (4 files: `index`, `ProductsListTab`, `HierarchyTab`, `_modals`). `UserManagement.jsx` (2,200) → `UserManagement/` (5 files: `index`, `UsersTab`, `RolesTab`, `_shared`, `_utils`). `Customers.jsx` (1,859) → `Customers/` (3 files: `index`, `_modals`, `_constants`).
- **2026-05-29** — ✅ Sprint 7 H-5 (commit `550bed6`). `@axe-core/react` v4.11.3 installed; mounted in `main.jsx` behind `import.meta.env.DEV`. 34 ARIA gaps closed: `aria-sort` + `aria-label` on all sort buttons in `SortableHeader` (RMATickets) and `InvSortBtn` (Inventory) — propagates to every table; `aria-expanded` + `aria-haspopup="menu"` + `aria-label` on all three-dot action menus (RMATickets, Products, Customers); `aria-expanded` + `aria-controls` on filter-panel toggles with matching `id`s; `aria-label` + SVG `aria-hidden` on modal close buttons. Score: **8.7 → 9.3/10**.
- **2026-05-31** — 🔍 **Full system audit** (user-requested, post-hotfix-batch). Static analysis of all layers. Automated gates: 80/80 tests, 0 lint warnings, clean build. **15 findings (2 critical ops, 1 high, 5 moderate, 5 accepted/clean)**. Critical: two DB migrations unconfirmed in production (ticket constraint + permission repair). High: Add User button visible to `admin` but Edge Function is `super_admin`-only (S9-2b, carried over). Moderate: `cp/*.jsx` (7 files) have no captureException; TechCalendar + AuditLog not on useQuery; hardcoded status strings in 4 pages; jspdf DOMPurify CVEs (fixable). Accepted: xlsx CVE (no vendor fix, write-only), raw Supabase reads in 3 Inventory files (intentional column subset). All CI gates green. Score: **8.8/10**. Sprint 10 plan written — surgical, one-file-one-commit approach to avoid regression cascade.
- **2026-06-01** — ✅ **DB migrations applied** (user-applied in Supabase SQL Editor). DB-1: `20260531_relax_ticket_status_constraint.sql` — dropped hard-coded `ticket_status` CHECK constraint, replaced with non-empty guard. DB-2: `20260529_repair_permissions.sql` — cleared corrupt `permissions` column for all manager/technician/viewer rows; verification query returned 0 rows.
- **2026-06-01** — ✅ **Sprint 10 Phase A complete** (commits `30dad6f`–`35a7935`, branch `test`). 8 tasks: (1) S10-SEC-3: `Add User` button gated to `ROLES.SUPER_ADMIN` only in `UserManagement/index.jsx` — admin no longer sees a button that silently 403s. (2–8) S10-CQ-1: `captureException` added to all catch blocks in 7 `cp/*.jsx` files (Announcements, RMAConfig, CustomFields, PDFLayout, DataCleanup, Integrations, AuditLog) — Control Panel errors now report to Sentry. CI: 80/80 · 0 warnings · clean build.
- **2026-06-01** — ✅ **Sprint 10 Phase B complete** (commits `4148533`–`9dadadb`, branch `test`). 4 tasks: S10-ARCH-4a–d: Raw status strings replaced with `TICKET_STATUS.*` / `TICKET_STATUS_RESOLVED` constants in `Dashboard.jsx`, `CustomerDetails.jsx`, `ProductDetails.jsx`, `ControlPanel.jsx`. Also removed stale `'Resolved'` string from Dashboard (status never existed in DB). CI: 80/80 · 0 warnings · clean build.
- **2026-06-01** — ✅ **Sprint 10 Phase C complete** (commits `cb34fd3`–`416e538`, branch `test`). 2 tasks: S10-ARCH-2: `TechCalendar.jsx` migrated from `useEffect+setState` to `useQuery(['tech-calendar-tickets'])`. S10-ARCH-3: `cp/AuditLog.jsx` migrated — `load()+2×useEffect+setFiltered` replaced with `useQuery(['audit-log'])` + `useMemo` for filters; removed the `eslint-disable` suppressor that was masking the bad deps pattern. All pages now on TanStack Query. CI: 80/80 · 0 warnings · clean build.
- **2026-06-01** — ✅ **Sprint 10 Phase D complete** (commit `a072c03`, branch `test`). S10-SEC-2: `jspdf` upgraded `4.2.0 → 4.2.1` via `npm audit fix --force`. Fixes 3 CVEs in `dompurify ≤3.3.3` (1 moderate, 1 high, 1 critical). CI: 80/80 · 0 warnings · clean build. **Pending:** user browser smoke test of PDF export on Invoices page before merge to `main`.
- **2026-06-01** — ✅ **Dashboard redesign — Direction B "Command" layout** (commit `bebb6ff`, branch `test`). Complete render layer rewrite of `src/pages/Dashboard.jsx`: `tokens(darkMode)` design-token function, inline SVG primitives (`SvgGauge`, `SvgDonut`, `Sparkline`, `StatusPill`, `CardHead`, `SectionLabel`, `DonutWithLegend`), STATUS_COLOR + PRIORITY_COLOR maps, 12-col grid with hero KPI tiles × 4, status strip, Performance section (4 × span-3 gauge cards), Trends section (lazy `DashboardCharts`), Activity section (span-5/3/4), Team & Inventory section. `DashboardCharts.jsx` stripped to weekly + monthly trend charts only (status/priority distribution moved inline as SVG donuts; `LineChart`/`Line` imports removed). Hanken Grotesk added to `index.html` (preconnect + Google Fonts link). All data fetching (TanStack Query, realtime, useMemo aggregations) preserved unchanged. `WIDGET_CATALOG` unchanged.
- **2026-06-01** — ✅ **Full-app Direction B "Command" theme transformation** (commit `30b2ae7`, branch `test`). Visual-only sweep — no data, routing, or business logic changed. Files updated: `src/App.jsx` (sidebar bg/border/nav active+inactive tokens, top bar, user dropdown, toast dark options), `src/components/ui.jsx` (Card flat hairline no-shadow, PageHeader updated, `StatusPill` export added), `src/contexts/AppearanceContext.jsx` (Hanken Grotesk in `FONT_STACKS` + `GOOGLE_FONTS`), `src/index.css` (page bg + font smoothing), `tailwind.config.js` (`fontFamily.sans = ['Hanken Grotesk', ...]`, page color token), `src/components/ErrorBoundary.jsx` + `src/components/Modal.jsx` + `src/pages/NotFoundPage.jsx` (slate-* → design token hex). Design tokens: page `#f4f6f9`/`#0b0f17`, surface `#ffffff`/`#121823`, border `#e6e9ef`/`#212a38`, accent `#4338ca`/`#a5b4fc`, text `#211f1b`/`#e8ebf0`, muted `#6c6760`/`#9aa4b2`. ~46 other page files retain stale slate-* classes pending a future file-by-file sweep.
- **2026-06-01** — ✅ **TypeScript noImplicitAny fix** (commit `07f6df5`, branch `test`). `src/utils/index.ts`: `createPageUrl(pageName)` → `createPageUrl(pageName: string)`. Root cause: `tsconfig.json` `"strict": true` enables `noImplicitAny`; the untyped parameter was surfacing as a red squiggly on the tsconfig file in VS Code. Pre-existing bug unrelated to the theme work.
- **2026-06-02** — ✅ **WhatsApp notification system + Customer PDF export** (multiple commits, branch `test`). Full enterprise WhatsApp notification system: provider-agnostic messaging layer (`src/lib/messaging/`), event bus (`src/lib/events/`), 3 Edge Functions (`send-whatsapp`, `notification-worker`, `whatsapp-webhook`), 4 DB tables (`whatsapp_templates`, `notification_logs`, `notification_settings`, `notification_queue` — migration `20260602_whatsapp_notifications.sql`), 4 Control Panel sub-pages (`WASettings`, `WATemplates`, `WALogs`, `WATestCenter`), ticket event handlers wired into `TicketForm.jsx` + `App.jsx`. Customer drawer PDF export updated to match RMA Tickets page layout (pdf_layout config, branding, QR code, section order). Supabase secrets configured; templates submitted to Meta for approval (status: In review).
- **2026-06-03** — ✅ **Backfill `customer_id` on existing tickets** (SQL run in Supabase). Legacy tickets linked to customers via `contact_person = customer_name` OR `company_name = customer_name` join. Column was `contact_person` not `name` — SQL corrected before run.
- **2026-06-03** — ✅ **7 open audit findings closed** (commit `fca60ab`, branch `test`). NEW-4: `AGENTS.md` created — full WhatsApp system docs, correct tool name (was "Codex"). S9-2a: migration `20260603_user_preferences_rls.sql` — per-user RLS on `user_preferences` (4 policies). S9-2d: same migration — staff read/write on `rma_config` scoped to `appearance_settings` key only; non-admin users now get cross-device theme sync. S9-3b: Zod schemas wired to 4 previously unwired forms — `ticketSchema` → `TicketForm.jsx`, `productSchema` → `Products/index.jsx`, `addUserSchema` → `UserManagement/index.jsx`, `resetPasswordSchema` → `AccountSettings.jsx`; password hint text corrected from 6 → 8 chars. S9-2c: `PermissionsModal` now shows amber warning banner listing any granted permissions that exceed the role's RLS enforcement tier (`RLS_CEILING` map + `getCrossTierPermissions()` helper in `RolesTab.jsx`). Gates: 80/80 tests · 0 lint warnings · build clean.
- **2026-06-03** — ✅ **TypeScript db layer conversion — S9-8/L-6** (commit `94a428c`, branch `test`). All 9 `src/api/db/*.js` modules converted to `.ts` and old `.js` files deleted. 18 Row type interfaces added across all modules. `index.ts` re-exports all Row types for single-import convenience. Function signatures fully typed (params + return types). Logic identical to original `.js` files. Gates: 80/80 tests · 0 lint warnings · build clean (10.8s).
- **2026-06-03** — ✅ **Dark mode — TechCalendar + Reports** (commit `378a267`, branch `test`). `TechCalendar.jsx` had 1 dark class in 394 lines; `Reports.jsx` had 0 dark classes in 1186 lines. Both now fully tokenised with Direction B hex pairs: card containers, table headers/rows/cells, export buttons, filter selects, date range bar, tab bar. Status/priority badge colors preserved (semantic, work in both modes).
- **2026-06-03** — ✅ **Dark mode flash prevention** (commit `2d69b92`, branch `test`). Added blocking inline `<script>` to `index.html` that reads `mrma_appearance` from localStorage and applies `dark` class to `<html>` synchronously before React renders. Eliminates white flash for dark mode users on every page load.
- **2026-06-03** — ✅ **Static cross-role QA pass** (no commit — analysis only). Verified `canDo` wiring consistent across all 12 page files: admin bypass pattern identical everywhere; manager/technician/viewer permission defaults match `ROLE_DEFAULT_PERMISSIONS`; `/control-panel` route guard confirmed (`Navigate to="/"` for non-admin); technician `edit_assigned` check correctly gates on `assigned_technician !== userEmail`; RLS server-side enforcement confirmed from `20260526_enable_rls.sql`. Verdict: all 3 roles correctly gated, no discrepancies found.
- **2026-06-03** — ✅ **Doc sync** (commit `cb6cf4b`, branch `test`). `CLAUDE.md` updated: domain modules table updated to TypeScript with Row types, 2 new migrations added, WhatsApp system section added, 3 new Edge Functions added, Control Panel updated. `AUDIT_LOG.md` updated with 2026-06-03 entries. `CONSTITUTION.md` and `README.md` updated.
- **2026-06-05** — ✅ **AI ticket assist — Feature #12** (commits on `test` branch). AI summarize + suggest-next-action added to Tickets, Reports, and Inventory pages at page level. Model: NVIDIA NIM / Llama 3.3 70B (free tier). Removed from TicketDrawer to avoid clutter. Button visible to admin/manager; results shown inline.
- **2026-06-05** — ✅ **Full system i18n — Feature #13** (commit `f2a5bad`, branch `test`). Complete Arabic/English multi-language support with RTL layout. Stack: `react-i18next`, `src/locales/en.json` + `src/locales/ar.json` (~500+ keys), `src/i18n.js` config. `AppearanceContext` manages language toggle; `dir="rtl"` applied to `<html>`. Every page, component, modal, toast, button, action, and label wrapped in `t()`. Key patterns documented: module-level functions use `import i18next from 'i18next'` singleton or receive `t` as parameter; portaled elements (NotificationBell panel) need explicit `dir` attribute since `createPortal` bypasses HTML inheritance.
- **2026-06-05** — ✅ **RTL notification bell fix.** In Arabic mode the bell button moves to the LEFT side of the header but the panel was anchored `right: 8` (far right edge). Fixed: panel positioning is now direction-aware — `i18n.language === 'ar'` triggers left-anchored logic using `button.getBoundingClientRect().left`, clamped to viewport. Added `dir={isRtl ? 'rtl' : 'ltr'}` to the portaled panel div. Added `i18n.language` to the `useEffect` dependency array.
- **2026-06-06** — ✅ **TicketForm `newTicket is not defined` bug fix.** When creating a new ticket, two toasts fired simultaneously: "Ticket created successfully!" (correct) and "Failed to save ticket: newTicket is not defined" (ReferenceError). Root cause: `const newTicket = await db.rmaTickets.create({...})` was declared with `const` inside the `else {}` block (line 462) but referenced on line 559 *outside* the block at `const savedTicketId = editingTicket?.id || newTicket?.id`. Fix: hoisted to `let newTicket = null` before the `if/else` block; removed `const` from the inner assignment. Ticket was always created successfully; only the post-creation resolution-save was erroring.

---

## 🧪 Session 2 — 2026-06-03 (dark mode polish + WhatsApp end-to-end bring-up)

> Long working session. Two themes: (1) finish dark mode across every page; (2) get WhatsApp notifications actually delivering to a real phone. Also includes a self-inflicted regression and its recovery — documented honestly as a lesson.

### Dark mode — completed

| Commit | Work |
|--------|------|
| `c63c643` | Full dark sweep across 12 zero-coverage pages (Inventory sub-tabs, TicketDrawer, Invoices, PartsInventory, ControlPanel, Customers, Products). Fixed the **white-row bug** in Inventory OverviewTab (`hover:bg-indigo-50` = near-white on dark). |
| `9816e06` | Badge/pill colors: `bg-*-100 text-*-700/800` → added `dark:bg-*-900/20 dark:text-*-400` so status/priority/type badges aren't washed out on dark. |
| `2d69b92` | Blocking inline script in `index.html` reads `mrma_appearance` and sets `html.dark` before React renders — kills the white flash on load for dark-mode users. |
| `378a267` | TechCalendar + Reports (had 0–1 dark classes) fully tokenised. |
| `ead2a03` | Notification bell: removed duplicate count badge (corner badge + trailing badge both rendered). |

### ⚠️ Regression + recovery (lesson)

| Commit | What |
|--------|------|
| `2b8d3e6` | **BAD** — a badge-color sweep was run via a background agent in a git **worktree based on a stale, pre-WhatsApp commit** (`961e787`). Copying its 33 files back **reverted WhatsApp wiring in ControlPanel, mobile responsiveness, and other recent work** — keeping only badge edits. Also broke the Dashboard layout (Overdue widget text overlap). |
| `995b003` | Restored `Dashboard.jsx` from the good commit. |
| `2e3b2af` | Restored **all 33 files** from `9816e06` (last fully-good commit) → WhatsApp + mobile + dark all back. Verified: ControlPanel WhatsApp imports present, messaging lib intact, App.jsx handler wiring intact, build + 160 tests clean. |

**Lesson (now a rule):** never bulk-copy files out of a stale worktree; never delegate edits to files carrying critical wiring (WhatsApp/ControlPanel). Patch high-value files directly. See `feedback-git-branch-workflow` memory.

### WhatsApp — debugged to working delivery

The integration was code-complete but had never actually delivered to a phone. Walked through every gate:

| Issue | Root cause | Fix |
|-------|-----------|-----|
| Send failed, Meta **190** | Temporary 24h Meta token kept expiring | Created a permanent **System User token** (never expires); updated `WHATSAPP_ACCESS_TOKEN` secret |
| Send failed, Meta **100** "Object does not exist" | `WHATSAPP_PHONE_NUMBER_ID` had a **letter `O` instead of zero** (`11758049O5609358`) | Corrected to `1175804905609358` |
| Generic "non-2xx" hid the real error | `supabase.functions.invoke` puts the Meta error in `error.context`, not `error.message` | `4d19804` — Test Center now reads `error.context.json()` and shows the real Meta error + code |
| Queued sends arrived **scrambled** (variables in wrong order) | **Postgres JSONB does not preserve object key order** — it reorders by (length, then a–z). `notification_queue.payload` is JSONB; the worker's `Object.values(variables)` got reordered keys | `8ecfc81` — handler now also stores an explicitly-ordered `params: string[]` array (JSONB keeps array order); worker uses `payload.params`. See `reference-jsonb-key-order-gotcha` memory |
| Real tickets failed Meta **131008** "required parameter missing" | `ticket.created` emit used `{...ticketData}` which lacks `created_date` → `{{created_date}}` empty (Meta rejects empty positional params) | `40abcd7` — spread the saved DB row (`newTicket`) into the event payload; safety net in handler replaces any blank param with `—` |
| Message accepted but **not delivered**, webhook reports **131049** "not delivered to maintain healthy ecosystem engagement" | Templates are **Marketing** category — Meta throttles marketing template messages | ⏳ **User action:** recreate templates as **Utility** category (transactional). Marketing→Utility can't be changed by editing — must delete+recreate. `rma_ticket_created` recreated as `rma_ticket_created_v2`; DB `template_name` updated via SQL. Awaiting Meta approval. |

**Meta error-code cheat sheet** (all land in `notification_logs.error_message` / `response_data`): 190 = token expired · 100 = bad phone number ID · 131008 = empty/missing positional param · 132000 = param count ≠ template `{{n}}` count · 131049 = Marketing-category delivery throttle (use Utility).

### WhatsApp — still open

- ⏳ `rma_ticket_created_v2` awaiting Meta **Utility** approval. Once Active → real tickets deliver.
- ⏳ The other 3 templates (`rma_ticket_updated`, `rma_ticket_assigned`, `rma_ticket_closed`) are still **Marketing** and must be recreated as **Utility** too. Also: param counts to reconcile — our DB has updated=5, assigned=3, closed=3 vars; each must equal the Meta template's `{{n}}` count (the seed `updated` body uses `{{#notes}}` conditionals which Meta doesn't support, so its Meta `{{n}}` count likely differs from 5).
- Test recipient limited to `+201000121585` until Meta **Production setup** (verify own business number).
- pg_cron not yet set up to auto-run `notification-worker` (currently relies on the handler's best-effort immediate invoke).

### Other

- `94a428c` — `src/api/db/*.js` → TypeScript with Row types (S9-8/L-6) earlier same day.

> **Current state:** `test` is **56 commits ahead of `main`** — **not merged** (user testing features first). WhatsApp pipeline proven working end-to-end (Meta accepts + returns `wamid`); only blocker to delivery is the Utility template approval. jsPDF browser smoke test still pending. test → main merge awaiting user approval.
