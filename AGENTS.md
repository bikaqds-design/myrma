# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Full engineering rules are in [`CONSTITUTION.md`](CONSTITUTION.md).**  
> **Audit history and scorecard are in [`docs/archive/AUDIT_LOG.md`](docs/archive/AUDIT_LOG.md).**

## Commands

```bash
npm run dev            # start dev server (Vite, port 5173)
npm run build          # production build
npm run preview        # preview production build
npm test               # Vitest unit tests (277 tests, 7 suites) — run before every push
npm run test:watch     # Vitest in watch mode
npm run test:coverage  # test with coverage report
npm run lint           # ESLint (0 errors target)
npm run lint:ci        # ESLint strict for CI (blocks on warnings too)
npm run lint:fix       # ESLint auto-fix
npm run format         # Prettier write
npm run format:check   # Prettier check (used in CI)
```

## Environment

Copy `.env` and populate:
```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Both variables must be prefixed with `VITE_` to be visible in Vite. The service role key is only used in Edge Functions (never in browser code).

## Architecture

### React Router v6

The app uses **React Router v6** (`react-router-dom`). `BrowserRouter` wraps the app in `src/main.jsx`. Navigation is handled via `useNavigate` and `useLocation` hooks in `src/App.jsx`.

All top-level pages are lazy-loaded via the `lazyWithReload()` wrapper in `App.jsx` (not bare `React.lazy`). `lazyWithReload` catches "Failed to fetch dynamically imported module" errors that occur when a new Vite deploy changes chunk filenames while a user still has the old app loaded — it auto-reloads the page so they get the new chunks transparently. `App.jsx` declares routes with `<Routes>` / `<Route>`. Parameterized routes (`/products/:id`, `/customers/:id`) are served by thin wrapper components (`ProductDetailsRoute`, `CustomerDetailsRoute`) that call `useParams()` and pass the id prop to the underlying page component. A catch-all `*` route renders `NotFoundPage`. Active sidebar state is derived from `location.pathname`.

**All routes:**

| Path | Component | Auth |
|------|-----------|------|
| `/` | `Dashboard` | required |
| `/dashboard` | `<Navigate to="/" replace />` | — |
| `/products` | `Products` | required |
| `/products/:id` | `ProductDetailsRoute` → `ProductDetails` | required |
| `/customers` | `Customers` | required |
| `/customers/:id` | `CustomerDetailsRoute` → `CustomerDetails` | required |
| `/rma-tickets` | `RMATickets` | required |
| `/inventory` | `Inventory` | required |
| `/account` | `AccountSettings` | required |
| `/control-panel` | `ControlPanel` | admin+ |
| `/calendar` | `TechCalendar` | required |
| `/invoices` | `Invoices` | required |
| `/parts` | `PartsInventory` | required |
| `/reports` | `Reports` | required |
| `/leads` | `Leads` | required (`leads.view`) |
| `/leads/:id` | `LeadDetailsRoute` → `LeadDetails` | required (`leads.view`) |
| `/pipeline` | `Pipeline` | required (`deals.view`) |
| `/pipeline/:id` | `PipelineDealRoute` → `DealDetail` | required (`deals.view`) |
| `/sales` | `SalesDocuments` | required (`deals.view`) |
| `/sales/:type/:id` | `SalesDocumentDetail` | required (`deals.view`) |
| `/accounting` | `Accounting` | required (`deals.view`) |
| `/tracker` | `RMATracker` | **none (public)** |
| `/kb` | `KnowledgeBasePublic` | **none (public)** |
| `*` | `NotFoundPage` | — |

Props passed to every authenticated page component: `currentUserRole`, `currentUserEmail`, `currentUserPermissions`.

`/tracker` and `/kb` are the only unauthenticated routes — each detected via a `pathname === '/...'` check before the auth check renders.

**Exception:** `window.history.pushState` is used ONLY inside `RMATickets/index.jsx` to sync `?ticket=<id>` (open ticket modal URL) without triggering a full route transition. This is intentional in-page state, not top-level navigation.

### Provider order in `src/main.jsx`

```jsx
<React.StrictMode>
  <ErrorBoundary>          // catches render crashes → Sentry
    <BrowserRouter>
      <QueryClientProvider>  // TanStack Query (staleTime 60s, retry 1)
        <AppearanceProvider> // dark mode, font, date format
          <App />
        </AppearanceProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </ErrorBoundary>
</React.StrictMode>
```

**`TooltipProvider` from Radix must be present** (it's inside `App.jsx`). Removing it causes a blank page.

### Data layer

All Supabase access goes through `src/api/supabaseClient.js`, which exports:
- `auth` — sign-in, sign-out, password reset, profile updates
- `db` — namespaced CRUD helpers for every table (`db.products`, `db.customers`, `db.rmaTickets`, `db.inventory`, etc.)
- `storage` — file uploads (attachments, avatars, brand logos) to the `rma-attachments` bucket
- `branding` — company branding settings
- `notifications` — email templates, preferences, and the `send-email` Edge Function call
- `backup` — full data export/import

**Never query `supabase` directly from page components; use these helpers.**

Domain modules in `src/api/db/`:

| Module | Covers |
|--------|--------|
| `tickets.ts` | RMA ticket CRUD + `rmaTracker` public lookup (via Edge Function) |
| `customers.ts` | Customer CRUD |
| `catalog.ts` | Product/catalog CRUD |
| `inventory.ts` | Inventory CRUD |
| `users.ts` | User role management |
| `notifications.ts` | Notification table ops |
| `system.ts` | System config (`rma_config` table) |
| `audit.ts` | Audit log reads |
| `whatsappNotifications.ts` | WhatsApp templates, notification logs, settings, queue |
| `leads.ts` | Lead CRUD + `convert()` atomic RPC (CRM) |
| `deals.ts` | Deal CRUD + `moveStage()`, `markWon()`, `markLost()`, `reopen()`, `bulkDelete()`, `bulkMoveStage()` with auto-log (CRM Sprint 3) |
| `activities.ts` | Activity/chatter CRUD + `listForRelated()` bulk query + `delete()` (CRM) |
| `pipelines.ts` | Pipeline + stage CRUD (CRM) |
| `contacts.ts` | Contact CRUD (CRM) |
| `quotations.ts` | Quotation CRUD + lifecycle, `QT-` random codes (CRM Sprint 6) |
| `salesOrders.ts` | Sales Order CRUD + `markAccepted()` (approval-pool: reserves inventory + lands directly in `delivered`), `convertToInvoice()`, `SO-` random codes (CRM Sprint 6) |
| `crmInvoices.ts` | Invoice CRUD + `post()` (gapless `INV-YYYY-NNNNN`, decrements inventory), `recordPayment()`, `void_()` (CRM Sprint 6) |
| `creditNotes.ts` | Credit Note CRUD + `issue()` (gapless `CN-YYYY-NNNNN`, auto-applies to a linked invoice), `restoreUnits()`, `void_()` (CRM Sprint 6) |
| `salesDocuments.ts` | Read-only `listAll()` over `v_sales_documents` (the "All" tab) + `setArchived()` (CRM Sprint 6) |
| `payments.ts` | Payment CRUD + `record()` (gapless `PAY-YYYY-NNNNN`, allocates across one or more invoices), `applyToInvoice()`, `void_()` (Accounting v1) |
| `customerLedger.ts` | Read-only `list(customerId)` over `v_customer_ledger` (Billing tab statement) + `agingReport()` (Accounting v1) |

Many optional tables (e.g. `announcements`, `custom_field_definitions`, `inventory_units`, `warehouses`) may not exist in every deployment. All `db.*` helpers that target these tables guard with `error.code === '42P01'` (table not found) and return `{ missing: true, data: [] }` instead of throwing.

**List caps:** `db.customers.list()`, `db.rmaTickets.list()`, and `db.products.list()` cap at **5 000 rows** (raised from 500). These pages filter/sort client-side so all rows must be in memory. If any dataset exceeds 5 000, switch that page to server-side pagination using the existing `listPaged()` method. Do not lower the cap; it is intentional headroom.

### TanStack Query

`QueryClientProvider` wraps the app in `main.jsx` with `staleTime: 60_000`, `retry: 1`, `refetchOnWindowFocus: false`. Use `useQuery` for all data fetching; avoid `useEffect` + `setState` for async data. After mutations, invalidate with `queryClient.invalidateQueries`. Optimistic updates (`queryClient.setQueryData`) are used for ticket/customer delete and customer edit — always include rollback on error.

### TypeScript lib layer

`src/lib/` is TypeScript:
- `constants.ts` — every magic string (`ROLES`, `TICKET_STATUS`, `PRIORITY`, `INVENTORY_STATUS`, `INVOICE_STATUS`, `NOTIF_TYPE`, `AUTOMATION_ACTION`, `CONFIG_KEY`, `STORAGE_KEY`). Always import from here; never hard-code status strings.
- `permissions.ts` — `canDo(role, permissions, section, action)` helper + `ROLE_DEFAULT_PERMISSIONS` + `resolvePermissions(role, stored)`. `super_admin` and `admin` bypass all checks automatically.
- `schemas.ts` — Zod validation schemas.
- `safeStorage.ts` — `safeStorage.get(key, fallback)` / `safeStorage.set(key, value)` / `safeStorage.remove(key)`. All `localStorage` access must go through this helper — it silently catches quota errors and Safari private-mode restrictions. Never call `localStorage.*` directly.

`.js` extensions in imports resolve to `.ts` files via Vite/TypeScript bundler resolution.

### Permissions

Roles: `super_admin`, `admin`, `manager`, `technician`, `viewer`.

`super_admin` and `admin` bypass all permission checks. Other roles carry a `permissions` JSON object loaded from the `user_roles` table and passed down from `App.jsx` as `currentUserPermissions`. Default permission sets for `manager`, `technician`, and `viewer` are defined in `ROLE_DEFAULT_PERMISSIONS` in **`src/lib/permissions.ts`** (not App.jsx). The `canDo(role, permissions, section, action)` helper is exported from the same file.

**Critical:** always resolve permissions with `resolvePermissions(role, stored)` (also in `permissions.ts`) before storing them in state — never use `stored || ROLE_DEFAULT_PERMISSIONS[role]`. An empty `{}` object is truthy and would override role defaults, stripping all permissions. `resolvePermissions` merges stored overrides on top of role defaults and treats `{}` / `null` / partial objects correctly.

Use the `canDo` pattern when gating UI actions — import `canDo` from `src/lib/permissions` and call `canDo(currentUserRole, currentUserPermissions, 'section', 'action')`.

### URL tab state

`src/hooks/useURLTab.js` — a lightweight hook that syncs a tab or sub-section selection with a URL query parameter. Used throughout page components so deep-links and browser back/forward work within a page:

```js
const [activeTab, setActiveTab] = useURLTab('tab', 'products')
```

### Appearance / theming

`src/contexts/AppearanceContext.jsx` provides global theming (dark mode, font, date/time format, sidebar compact mode, dashboard widget order). Settings are persisted to `rma_config` (key `appearance_settings`) and also cached via `safeStorage` under the key `mrma_appearance`. Access via `useAppearance()`.

**Font:** Primary font is **Hanken Grotesk** (Google Fonts, weights 400–800). Loaded via `index.html` preconnect + stylesheet, and dynamically by `AppearanceContext` when selected. `tailwind.config.js` sets `fontFamily.sans: ['Hanken Grotesk', 'system-ui', 'sans-serif']`. `FONT_STACKS` and `GOOGLE_FONTS` in `AppearanceContext.jsx` include `hanken` as a selectable option.

**Dark mode:** `AppearanceContext` toggles the `dark` class on `<html>` (`darkMode: 'class'` Tailwind strategy). Use `dark:` Tailwind prefix classes with Direction B design tokens — see the Design tokens section below.

### Internationalisation (i18n) / RTL

The app supports **Arabic** and **English** with full RTL layout via `react-i18next`.

**Files:**
- `src/lib/i18n.js` — i18next config (language detection, `en` default)
- `src/locales/en.json` — English strings (~500+ keys)
- `src/locales/ar.json` — Arabic strings (same key structure)

**Usage in components:**
```jsx
import { useTranslation } from 'react-i18next'
const { t, i18n } = useTranslation()
// simple key
t('tickets.createTicket')
// interpolation
t('tickets.pageMustBeBetween', { total: totalPages })
```

**Language toggle:** `AppearanceContext` exposes `language` / `setLanguage`. Changing language sets `i18n.changeLanguage(lang)` and toggles `dir="rtl"` on `<html>` (applied via `AppearanceContext` — same mechanism as dark mode).

**Module-level functions** cannot use React hooks. Two patterns:

| Situation | Pattern |
|-----------|---------|
| Function called from one component that already has `t` | Pass `t` as parameter: `exportPDF(invoice, t)` |
| Utility called from many places | Import singleton: `import i18next from 'i18next'` then `i18next.t('key')` |

**RTL portals:** Elements rendered via `createPortal` do NOT inherit `dir="rtl"` from `<html>` automatically. Always add an explicit `dir` attribute:
```jsx
const isRtl = i18n.language === 'ar'
<div dir={isRtl ? 'rtl' : 'ltr'} ...>
```

**RTL floating panel positioning:** When a button moves in RTL (e.g. notification bell shifts to the left side of the header), anchor the panel to match — use `getBoundingClientRect().left` + clamp logic instead of a fixed `right: 8`. See `NotificationBell.jsx` for the reference implementation.

**LAW: Every new page, component, modal, or function must use `t()` for all user-visible strings at build time.** Translation is part of the definition of done — never leave hardcoded English strings in new code.

### Design tokens (Direction B "Command")

All new UI uses these hex token pairs. Never use `dark:bg-slate-*` or `dark:bg-gray-*` for new components.

| Token | Light | Dark |
|-------|-------|------|
| Page background | `#f4f6f9` | `#0b0f17` |
| Surface (card) | `#ffffff` | `#121823` |
| Surface inset | `#f8f9fb` | `#0f1520` |
| Border | `#e6e9ef` | `#212a38` |
| Border soft | `#f0f2f6` | `#1a2230` |
| Accent | `#4338ca` | `#a5b4fc` |
| Text primary | `#211f1b` | `#e8ebf0` |
| Text muted | `#6c6760` | `#9aa4b2` |
| Text faint | `#a09d99` | `#4a5568` |

Card style: `bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px]` — no shadow.

In `Dashboard.jsx`, these tokens are computed at render time via `tokens(darkMode)` and passed as a `tk` prop to sub-components. For SVG/inline-style values, use the `darkMode` boolean from `useAppearance()` and pick from the table above.

### Control Panel

`src/pages/ControlPanel.jsx` hosts all admin-only sub-pages (User Management, Branding, RMA Config, Custom Fields, PDF Layout, Announcements, Audit Log, Data Cleanup, Backup/Restore, Integrations, **WhatsApp & Messaging**). It uses `useURLTab` to keep the active feature in the URL as `?feature=...`.

The **WhatsApp & Messaging** group (`?feature=wa-settings|wa-templates|wa-logs|wa-test`) contains four sub-pages: `WASettings` (provider toggles, per-event toggles, retry/rate config), `WATemplates` (full CRUD with phone preview), `WALogs` (paginated delivery log with retry + CSV export), `WATestCenter` (send test message, simulate event, run worker, queue stats).

### CSV bulk upload

The Products and Customers pages support bulk CSV import. A custom `parseCSVLine` helper (local to those pages) handles quoted fields — do not use plain `split(',')` because product names can contain commas inside quotes.

### Notifications

Real-time notifications use a single Supabase Realtime channel (`app_notifications`) subscribed in `App.jsx`. Notification visibility is filtered **server-side** via RLS policy `user_read_targeted` — the query only returns rows the current user is allowed to see. Per-type preferences are stored via `safeStorage` under the key `notif_system_prefs_<email>` and also persisted to `db.userPreferences` (synced on login). Changes propagate via a `notif-system-prefs-changed` window event.

### Edge Functions

Live in `supabase/functions/`:
- `admin-reset-password` — handles password reset (existing user) AND account creation (new user, create-if-missing logic)
- `public-track` — rate-limited public RMA lookup by RMA number (used by `/tracker`)
- `send-email` — email dispatch via the notifications system
- `send-whatsapp` — WhatsApp message dispatch via Meta Cloud API (template + free-form); reads `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` from Supabase secrets; writes audit log to `notification_logs`
- `notification-worker` — queue processor; fetches up to 10 pending jobs from `notification_queue`, invokes `send-whatsapp`, exponential-backoff retry (5 min → 10 min → 20 min), 200 ms rate limit between messages
- `whatsapp-webhook` — Meta delivery-status callbacks (GET: verification handshake using `WHATSAPP_WEBHOOK_VERIFY_TOKEN`; POST: updates `notification_logs` delivery status on sent/delivered/read/failed)

All Edge Functions validate the caller's JWT before performing privileged operations. Never expose the service role key to the browser.

### WhatsApp / Messaging system

Provider-agnostic notification layer that fires on ticket lifecycle events.

**Library layer** (`src/lib/`):
- `messaging/types.ts` — `IMessagingProvider`, `NotificationEvent`, `EventType`, `DeliveryStatus`, `QueueJob`, `QueueJobPayload`, `NotificationSettings`
- `messaging/TemplateEngine.ts` — `render(template, variables)` with `{{key}}` substitution + `{{#key}}…{{/key}}` conditionals; `resolveVariables(defs, payload)` dot-path resolution; `toWhatsAppParams(variables)` builds positional Meta API params
- `messaging/MessagingService.ts` — `messagingService` singleton; `registerProvider()`, `send()`, `sendBatch()` with bounded concurrency
- `messaging/providers/WhatsAppProvider.ts` — browser-side adapter; calls `send-whatsapp` Edge Function via `supabase.functions.invoke()`; never calls Meta API directly
- `events/NotificationEventBus.ts` — `notificationEventBus` singleton; `on(eventType, handler)` returns unsubscribe; `emit(event)` async; `emitAsync(event)` fire-and-forget
- `events/ticketEventHandlers.ts` — `registerTicketEventHandlers()` called once at app load from `App.jsx`; handles `ticket.created`, `ticket.updated`, `ticket.assigned`, `ticket.closed`, `ticket.cancelled`

**Event flow:** `TicketForm.jsx` saves ticket → emits event via `notificationEventBus.emitAsync()` → handler checks `whatsapp_enabled` + per-event flag → loads template → resolves phone + variables → INSERTs into `notification_queue` → invokes `notification-worker` Edge Function immediately for fast delivery.

**DB tables** (migration `20260602_whatsapp_notifications.sql`): `whatsapp_templates`, `notification_logs`, `notification_settings`, `notification_queue`.

**Secrets required in Supabase Edge Functions → Secrets:**
- `WHATSAPP_ACCESS_TOKEN` — permanent **System User** token (the temporary API-Setup token expires every 24h → Meta error 190)
- `WHATSAPP_PHONE_NUMBER_ID` — phone number ID, all digits (a letter `O` for zero `0` → Meta error 100)
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN` — arbitrary string matching Meta webhook config

**Template param ordering (JSONB pitfall):** the handler stores an explicitly-ordered `params: string[]` in `notification_queue.payload`; the worker sends that. **Never** use `Object.values(variables)` for param order — Postgres JSONB reorders object keys (length, then a–z), scrambling positional `{{1}}..{{n}}` params. Arrays preserve order in JSONB; objects do not. No positional param may be empty (Meta 131008 — handler substitutes `—`).

**`whatsapp_templates.template_name`** is the Meta-registered name sent to the API. Point the system at a renamed template via `UPDATE whatsapp_templates SET template_name='<new>' WHERE event_type='<event>'` — no code change.

**Meta template category:** transactional notifications must be **Utility**, not **Marketing** (Marketing is delivery-throttled → error 131049). Category can't be edited — delete + recreate as Utility; keep bodies purely transactional. Meta error cheat sheet (in `notification_logs.error_message`): 190 token expired · 100 bad phone ID · 131008 empty param · 132000 param count ≠ `{{n}}` · 131049 Marketing throttle.

### PWA

`vite-plugin-pwa` (Workbox `generateSW` strategy) pre-caches ~42 static assets. Supabase API calls use `NetworkFirst` with a 10-second timeout and fall back to cache. The manifest is defined in `vite.config.js`. Dev mode SW is disabled by default (set `devOptions.enabled: true` to test locally).

### Page folder structure

Five large pages are organized as folders. `React.lazy(() => import('./pages/X'))` auto-resolves to `index.jsx` — no changes needed in `App.jsx` when adding files inside a page folder.

| Folder | Files |
|--------|-------|
| `src/pages/Inventory/` | `index.jsx` (shell), `_shared.jsx`, `ExportMenu.jsx`, `TransferModal.jsx`, `ProductStatusTab.jsx`, `OverviewTab.jsx`, `ByProductTab.jsx`, `CompanyStockTab.jsx`, `ProductDetailModal.jsx`, `WarehousesTab.jsx`, `ManufacturerTab.jsx` |
| `src/pages/RMATickets/` | `index.jsx` (shell + table), `TicketForm.jsx` (owns form state), `TicketDrawer.jsx` (owns comment/time/parts state), `_shared.jsx` (SortableHeader), `_utils.js` (pure helpers) |
| `src/pages/Products/` | `index.jsx`, `ProductsListTab.jsx`, `HierarchyTab.jsx`, `_modals.jsx` |
| `src/pages/UserManagement/` | `index.jsx`, `UsersTab.jsx`, `RolesTab.jsx`, `_shared.jsx`, `_utils.js` — "Role Templates" tab is now a read-only **"Role Reference"** (displays runtime `ROLE_DEFAULT_PERMISSIONS`). "Custom Roles" tab is hidden behind `ENABLE_CUSTOM_ROLES = false` flag (not yet wired end-to-end). |
| `src/pages/Customers/` | `index.jsx`, `_modals.jsx`, `_constants.js` |
| `src/pages/Leads/` | `index.jsx` (list + filters), `LeadDetails.jsx` (detail page), `_modals.jsx` (Create/Convert), `_constants.js`, `_shared.jsx` (SortableHeader) |
| `src/pages/Pipeline/` | `index.jsx` (view switcher, kanban, XLSX export, search/filters, multi-select stage/rep filters, export dropdown, lifted `selectedDeals` state), `DealDetail.jsx` (inline editing, product lines, stages), `DealCommentPanel.jsx` (right-side comment panel), `PipelineListView.jsx` (sortable table, stage pin dropdown, bulk select/delete/move, indigo bulk bar), `PipelineGraphView.jsx`, `PipelinePivotView.jsx`, `PipelineActivityView.jsx`, `_modals.jsx`, `_constants.js`, `_shared.jsx` |
| `src/pages/SalesDocuments/` | `index.jsx` (unified Quotation/SO/Invoice/Credit Note list via `v_sales_documents`), `SalesDocumentDetail.jsx` (per-type lifecycle actions), `SalesDocumentForm.jsx`, `_modals.jsx` |
| `src/pages/Accounting/` | `index.jsx` (Payments ledger tab + AR Aging tab), `_modals.jsx` (`RecordPaymentModal` — multi-invoice allocation) (Accounting v1) |

The remaining pages (`Dashboard`, `Reports`, `Invoices`, `PartsInventory`, `ControlPanel`, `AccountSettings`, etc.) are still single files.

**Shared CRM component:** `src/components/ActivityChatter.jsx` — generalized chatter panel (note/schedule/reply/reschedule/reopen/attachments) used by both `LeadDetails.jsx` and `DealDetail.jsx`. Do not re-implement this per-page.

**AI Assist:** `src/components/AIAssist.jsx` exists but is hidden — all `<AIAssist>` usage has been removed from page files. The `ai-assist` Edge Function and `ai.assist()` helper still exist.

### Sales Documents & Accounting (CRM Sprint 6 + Accounting v1)

Funnel: **Lead → Deal → Quotation → Sales Order → Invoice → Credit Note**, payments tracked separately against invoices. Lives at `/sales` and `/accounting`.

**Approval-pool pattern:** an `activities` row with `type: 'approval'` (title encodes `approval|docType|docId|code|total|customer`) is raised when a document needs sign-off; `approveDocument()`/`rejectDocument()` in `Activities/index.jsx` dispatch to the lifecycle action. SO approval lands directly in `delivered` (inventory reserved) in one step.

**Codes:** `INV-`/`CN-`/`PAY-` are gapless `PREFIX-YYYY-NNNNN` via `nextval_for_type()`, assigned at issue/post time. `QT-`/`SO-` are random 8-digit, assigned at creation. Deal codes use `OPP-`.

**Application-table pattern:** `credit_note_applications` and `payment_applications` both link to one or more invoices with sync triggers recalculating the parent's balance; `crmInvoices.recordPayment()` is the single setter for `amount_paid`/`payment_status`. Voiding an applied credit note or payment is **blocked**, not reversed.

**Accounting v1** is a lightweight AR layer, not a full ERP: payments ledger (multi-invoice allocation), AR aging report (Current/31-60/61-90/90+), customer statement (`v_customer_ledger`). `customers.credit_limit` is a soft warning only, never enforced.

### Accessibility

`@axe-core/react` is installed as a devDependency and mounted in `src/main.jsx` behind an `import.meta.env.DEV` guard. In development, it logs WCAG violations to the browser console automatically — no setup needed. It is never included in production builds.

All sort buttons use `aria-sort="ascending|descending|none"` (via `SortableHeader` in `RMATickets/_shared.jsx` and `InvSortBtn` in `Inventory/_shared.jsx`). All icon-only action-menu buttons have `aria-label`, `aria-expanded`, and `aria-haspopup="menu"`. Filter-panel toggles have `aria-expanded` + `aria-controls` pointing to the panel's `id`.

### Sentry

`initSentry()` is called in `main.jsx` with a no-op guard (skips if DSN is not set). `captureException()` helper is wired into `ErrorBoundary.componentDidCatch`. Import `captureException` from the Sentry integration file — do not call `Sentry.captureException()` directly in page components. Set `VITE_SENTRY_DSN` in Vercel environment variables to enable automatic error capture in production.

The `ErrorBoundary` shows the error **message** in production (safe, user-diagnosable) plus a "Copy error details" button that captures the full stack + URL + timestamp. The full stack trace is dev-only.

### Database migrations

All schema changes are SQL migration files in `supabase/migrations/` named `YYYYMMDD_description.sql`. All migrations are idempotent (`IF NOT EXISTS`, `IF EXISTS`, `DROP POLICY IF EXISTS`). Never alter production schema via the Supabase dashboard without a corresponding migration file.

Current migrations:
- `20260524_customer_cascade_delete.sql`
- `20260524_features.sql`
- `20260526_enable_rls.sql`
- `20260526_check_constraints.sql`
- `20260527_storage_bucket_policies.sql`
- `20260528_ticket_cascade_fk.sql`
- `20260529_repair_permissions.sql`
- `20260531_relax_ticket_status_constraint.sql`
- `20260602_whatsapp_notifications.sql`
- `20260603_user_preferences_rls.sql`
- `20260604_pgcron_notifications.sql`
- `20260604_priority_changed_email_template.sql`
- `20260604_ticket_customer_email.sql`
- `20260604_ticket_resolutions.sql`
- `20260613_search_by_serial.sql`
- `20260617_kb_articles.sql`

CRM upgrade (Track A), applied in order:

- `20260618_crm_add_sales_rep_role.sql` — adds `sales_rep` role
- `20260619_crm_contacts.sql`
- `20260620_crm_pipelines.sql`
- `20260621_crm_leads.sql`
- `20260622_crm_deals.sql`
- `20260623_crm_activities.sql`
- `20260624_crm_customers_extend.sql`
- `20260625_crm_notification_events.sql`
- `20260626_crm_leads_convert_rpc.sql` — `convert_lead_to_deal` RPC
- `20260627_crm_fix_duplicate_user_roles_check.sql`
- `20260628_crm_assigned_rep_use_email.sql` — `assigned_rep` is `text`/email, not uuid FK
- `20260629_crm_created_by_use_email.sql` — `created_by` is `text`/email, not uuid FK
- `20260630_crm_convert_lead_customer_code.sql`
- `20260701_crm_leads_add_statuses.sql` — adds `active`/`inactive` lead statuses
- `20260702_crm_activities_chatter.sql` — `attachments jsonb`, `log` activity type
- `20260703_crm_activities_replies.sql` — `parent_id` for threaded replies
- `20260704_crm_pipeline_rename_new_lead_stage.sql`
- `20260705_crm_remove_b2c_pipeline.sql`
- `20260706_seed_test_users_and_deals.sql`
- `20260707_crm_rename_new_deal_stage_plural.sql`
- `20260708_crm_sync_deal_values.sql` — back-fills `deals.value` from product lines; enforces probability 100/0 for won/lost
- `20260709_crm_lead_deal_codes.sql` — adds `lead_code` (LD- prefix) and `deal_code` (DL- prefix) columns; backfills existing rows
- `20260710_crm_deal_code_rename.sql` — renames backfilled deal codes from DL- to QT- (Quotation lifecycle)
- `20260711_crm_convert_rpc_deal_code.sql` — updates `crm_convert_lead` RPC to generate QT- `deal_code` atomically on conversion

Sales Documents (CRM Sprint 6), applied in order:

- `20260712_document_sequences.sql` — `nextval_for_type()` RPC (gapless `INV-`/`CN-`) + `generate_doc_code()` (random `QT-`/`SO-`)
- `20260713_stock_moves.sql` — append-only inventory move ledger
- `20260714_quotations.sql`, `20260715_sales_orders.sql`, `20260716_crm_invoices.sql`, `20260717_credit_notes.sql` — the four document tables + RLS
- `20260718_credit_note_applications.sql` — `sync_credit_note_balance` trigger
- `20260719_inventory_reservation.sql` — two-stage stock model RPCs
- `20260720_sales_documents_view.sql` — `v_sales_documents` UNION view
- `20260721_crm_activities_approval_type.sql` — allows `'approval'` activity type
- `20260722_sales_documents_archive.sql` — archive flag on all four document tables
- `20260723_sales_orders_approval_statuses.sql` — adds `sent`/`accepted`/`declined` to SO status
- `20260724_crm_convert_lead_created_by_email.sql`, `20260725_quotations_add_converted_status.sql`
- `20260726_crm_deal_code_prefix_opp.sql` — renames deal-code prefix `QT-` → `OPP-`

Accounting Module v1, applied in order:

- `20260727_crm_payments.sql` — `payments` + `payment_applications` tables, `sync_payment_balance` trigger, `record_payment` RPC
- `20260728_crm_payment_sequence.sql` — registers `payment` seq type (`PAY-YYYY-NNNNN`)
- `20260729_crm_customer_credit_limit.sql` — `customers.credit_limit` (soft warning only)
- `20260730_crm_customer_ledger_view.sql` — `v_customer_ledger` UNION view

### RLS SQL helper functions

In any SQL policy, use the `public.rma_*` functions:

```sql
public.rma_user_role()          -- current user's role string
public.rma_is_admin()           -- true for admin / super_admin
public.rma_is_manager_or_above() -- true for manager, admin, super_admin
public.rma_is_staff()           -- true for any authenticated staff
public.rma_current_user_email() -- current user's email
```

**`auth.user_role()` and similar do not exist — never use them.**

### Shared component library

All UI primitives come from `src/components/ui.jsx`. Never re-implement buttons, inputs, modals, badges, or spinners in page components. Key exports: `Button` (variants: primary, secondary, danger, success, ghost, warning), `Spinner` (has built-in `role="status"` and `aria-label="Loading"`), `Badge`, `Card` (flat hairline, no shadow), `Input`, `Select`, `Textarea`, `Label`, `PageHeader`, `SectionTitle`, `Divider`, `IconButton`, `ModalOverlay`, `ModalCard`, `StatusPill` (dot + label pill, colored by status string — uses its own internal color map, no props beyond `status` and optional `className`).

### CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to `main`:  
**test → lint:ci → build** — all three must pass. Node 20, `npm ci` (`--legacy-peer-deps` is set in `.npmrc`).

