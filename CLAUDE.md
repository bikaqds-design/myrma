# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Engineering rules:** [`CONSTITUTION.md`](CONSTITUTION.md) · **Audit status:** [`AUDIT_REPORT.md`](AUDIT_REPORT.md) — §0 is the live scorecard · **Archive:** [`docs/archive/README.md`](docs/archive/README.md) (finished plans, past audits, completed QA runs)

**Current state (2026-09-17).** The build phase is finished: CRM core, Sales Documents, Accounting, the redesigned Purchase Module and Warehouse Module R1 all shipped (history in [`docs/archive/MASTER_UPGRADE_PLAN.md`](docs/archive/MASTER_UPGRADE_PLAN.md)). Work is now pre-launch hardening driven by `AUDIT_REPORT.md`: **87 findings — 85 fixed, 1 partly fixed (BUG-077, WhatsApp imports), 1 open** (BUG-006, WhatsApp webhook, on hold). What each open item waits on is in the report's §0.

**Standing rules for working in this repo:**
- **WhatsApp work is on hold.** Do not fix or refactor WhatsApp code, functions or templates unless the owner lifts the hold.
- **All current production data is disposable test data** and will be erased before launch. Use it for testing; never "repair" rows — fix code, constraints and guards instead.
- **Migrations and Edge Functions reach production only with the owner's explicit OK.** Dry-run first inside a transaction that ends in a forced rollback.
- **After every `apply_migration` (dashboard/MCP), set that ledger row's `version` to the file prefix** — those tools record a generated timestamp, and the `Migration drift` workflow fails on the mismatch.
- **`main` is protected:** push a branch and open a PR. CI must be green before merging.
- **Verify what you claim.** A green job is not proof a check ran — the `db-tests` job is `if: false`, and the integration tier skips without secrets. Read the log or the annotations.

## Commands

```bash
npm run dev            # start dev server (Vite, port 5173)
npm run build          # production build
npm run preview        # preview production build
npm test               # Vitest unit tests — run before every push
npm run test:watch     # Vitest in watch mode
npm run test:coverage  # test with coverage report
npm run lint           # ESLint (0 errors target)
npm run lint:ci        # ESLint strict for CI (blocks on warnings too)
npm run lint:fix       # ESLint auto-fix
npm run format         # Prettier write
npm run format:check   # Prettier check (NOT run in CI; formatting is not enforced)
npm run typecheck      # tsc --noEmit — zero errors, gated in CI
npm run test:integration  # read-only checks against the hosted project; needs VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
node scripts/migration-drift.mjs  # production migration ledger vs supabase/migrations/ (same env vars)
npm run test:db        # NOT runnable here: needs Docker + a rebuildable schema (see CI/CD). Run supabase/tests/*.sql by hand, rolled back, instead
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
| `/reports` | `Reports` | required |
| `/leads` | `Leads` | required (`leads.view`) |
| `/leads/:id` | `LeadDetailsRoute` → `LeadDetails` | required (`leads.view`) |
| `/pipeline` | `Pipeline` | required (`deals.view`) |
| `/pipeline/:id` | `PipelineDealRoute` → `DealDetail` | required (`deals.view`) |
| `/sales` | `SalesDocuments` | required (`deals.view`) |
| `/sales/:type/:id` | `SalesDocumentDetail` | required (`deals.view`) |
| `/accounting` | `Accounting` | required (`deals.view`) |
| `/purchasing` | `Purchasing` | required (`deals.view`) |
| `/purchasing/:type/:id` | `PurchaseDocumentDetailRoute` → `PurchaseDocumentDetail` | required (`deals.view`) |
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

Domain modules in `src/api/db/` (all TypeScript — export Row types):

| Module | Covers | Key Row Types |
|--------|--------|---------------|
| `tickets.ts` | RMA ticket CRUD + `rmaTracker` public lookup (via Edge Function) | `RMATicketRow`, `TicketCommentRow`, `TicketActivityRow` |
| `customers.ts` | Customer CRUD | `CustomerRow`, `CustomerNoteRow` |
| `catalog.ts` | Product/catalog CRUD | `ProductRow`, `BrandRow`, `CategoryRow`, `SubcategoryRow` |
| `inventory.ts` | Inventory units, warehouses, parts, time entries, invoices; **dual-mode stock (Sprint 8)**: `warehouseStock`/`stockMoves` read modules, `getStockSummary()`, `warehouses.archive()`, and RPC wrappers `receiveStock()`/`transferStock()`/`adjustStock()`/`recalculateStock()` | `InventoryUnitRow` (now incl. `product_id`/`reservation_status`/`reserved_by_*`), `WarehouseStockRow`, `StockMoveRow`, `ProductStockSummary`, `PartRow`, `InvoiceRow`, `WarehouseRow` |
| `users.ts` | User role management | `UserRoleRow`, `UserActivityRow`, `UserPreferencesRow` |
| `notifications.ts` | Notification table ops | `NotificationRow` |
| `system.ts` | System config, announcements, webhooks, SLA, automation rules | `RmaConfigRow`, `WebhookRow`, `SlaConfig`, `AutomationRule` |
| `audit.ts` | Audit log reads + resilient write queue (H-9) | `AuditLogRow` |
| `whatsappNotifications.ts` | WhatsApp templates, notification logs, settings, queue | `WhatsAppTemplateRow`, `NotificationLogRow`, `NotificationQueueRow` |
| `leads.ts` | Lead CRUD + `convert()` atomic RPC (CRM Sprint 2) | `LeadRow` |
| `deals.ts` | Deal CRUD + `moveStage()`, `markWon()`, `markLost()`, `reopen()`, `bulkDelete()`, `bulkMoveStage()` with auto-log (CRM Sprint 3) | `DealRow` |
| `activities.ts` | Activity/chatter CRUD + `listForRelated()` bulk query + `delete()` + `reopen()` + `reschedule()`; Activities page `listPage()`/`tabCounts()`/`assignees()` over `v_activities_list`, `countOverdue()` (sidebar badge), Tech Calendar `listPlannedBetween()`/`calendarAssignees()` (CRM Sprints 2.5, 4; BUG-066) | `ActivityRow`, `ActivityListRow` |
| `pipelines.ts` | Pipeline + stage CRUD (CRM Sprint 1) | `PipelineRow`, `PipelineStage` |
| `contacts.ts` | Contact CRUD (CRM Sprint 1) | `ContactRow` |
| `quotations.ts` | Quotation CRUD + lifecycle (`draft→sent→accepted→converted`/`declined`/`cancelled`), `QT-` random codes (CRM Sprint 6) | `QuotationRow`, `QuotationLine` |
| `salesOrders.ts` | Sales Order CRUD + `markAccepted()` (approval-pool action: reserves inventory + lands directly in `delivered`), `confirm()`/`markDelivered()`/`cancel()`/`convertToInvoice()`, `SO-` random codes (CRM Sprint 6) | `SalesOrderRow`, `SalesOrderLine` |
| `crmInvoices.ts` | Invoice CRUD + `post()` (assigns gapless `INV-YYYY-NNNNN` via `nextval_for_type` RPC, decrements inventory), `recordPayment()`, `void_()` (CRM Sprint 6) | `CrmInvoiceRow`, `CrmInvoiceLine` |
| `creditNotes.ts` | Credit Note CRUD + `issue()` (assigns gapless `CN-YYYY-NNNNN`, auto-applies to a linked invoice via `applyToInvoice()` + `crmInvoices.recordPayment()`), `restoreUnits()`, `void_()` (CRM Sprint 6) | `CreditNoteRow`, `CreditNoteLine`, `CreditNoteApplicationRow` |
| `salesDocuments.ts` | Sales Documents list: `listPage()` / `listAllMatching()` over `v_sales_documents_list` (the `v_sales_documents` UNION + customer name + sort keys) and `summary()` (tab counts + filter options, `rma_sales_document_summary`), + `setArchived()` (CRM Sprint 6; BUG-066) | `SalesDocumentRow`, `SalesDocumentListRow`, `SalesDocType` |
| `payments.ts` | Payment CRUD + `record()` (assigns gapless `PAY-YYYY-NNNNN`, allocates across one or more invoices in one call), `applyToInvoice()`, `void_()` (blocks once applied) (Accounting v1) | `PaymentRow`, `PaymentApplicationRow` |
| `customerLedger.ts` | Read-only `list(customerId)` over the `v_customer_ledger` UNION view (Customer Details "Billing" tab statement) + `agingReport()` (Current/31-60/61-90/90+ buckets from `crm_invoices`) (Accounting v1) | `LedgerEntryRow`, `AgingInvoiceRow` |
| `purchasing.ts` | Purchase Module (Sprint 9, redesigned 2026-07-05 — Brands ARE the vendors, Proforma Invoices removed): `purchaseOrders` (`PO-` codes, new fields incl. `currency`/`payment_terms`/`delivery_terms`/`shipping_address`/`billing_address`/`terms_conditions`, `convertToVendorInvoice()` with optional edit overrides, `setArchived` via `purchaseDocuments`), `vendorInvoices` (`submitForApproval()`/`approve()`/`rejectToDraft()`/`receive()` → atomic `receive_vendor_invoice` RPC which also syncs the linked PO's `completed`/`partially_completed` status, `VI-YYYY-NNNNN` gapless code at receipt), `purchaseDocuments.listAll()` over `v_purchase_documents` (2 doc types now) | `PurchaseOrderRow`, `VendorInvoiceRow`, `PurchaseLine` (now carries `discount_pct`/`tax_pct`), `PurchaseDocumentRow`, `PurchaseDocType` |
| `vendorPayments.ts` | Vendor payments (Accounts Payable) ledger + `record()` (assigns gapless `VP-YYYY-NNNNN`, allocates across one or more vendor invoices), `applyToInvoice()`, `void_()`, `reverseApplication()` — hardened-from-day-one mirror of `payments.ts` (Purchasing redesign) | `VendorPaymentRow`, `VendorPaymentApplicationRow` |
| `vendorLedger.ts` | Read-only `list(vendorId)` over the `v_vendor_ledger` UNION view + `apAgingReport()` (Current/31-60/61-90/90+ buckets from payable `vendor_invoices`) (Purchasing redesign) | `VendorLedgerEntryRow`, `ApAgingInvoiceRow` |

Import Row types from `src/api/db/index.ts` — all are re-exported there for convenience.

Many optional tables (e.g. `announcements`, `custom_field_definitions`, `inventory_units`, `warehouses`) may not exist in every deployment. All `db.*` helpers that target these tables guard with `error.code === '42P01'` (table not found) and return `{ missing: true, data: [] }` instead of throwing. The return type for these helpers is the shared `TableResult<T>` alias (or `PagedResult<T>` / `CountedResult<T>` for paged results) — all exported from `src/api/db/index.ts`. Never inline `{ missing: boolean; data: T[] }` in new helper signatures; import and use these shared types.

**Paging (BUG-066):** the Supabase Data API returns at most **1 000 rows per request** (dashboard → Data API → Max rows), whatever `.limit()` asks for, and says nothing when it truncates. So a screen must never load a whole table and filter, sort or page it in the browser. Use `src/api/db/_paging.ts`: `fetchPage(run, page, pageSize)` for a list screen (one page + exact count, filters and sort in the database, `id` as the last order so pages neither repeat nor skip) and `fetchAllRows(run)` only where every row is genuinely required, e.g. an "Export all" (reads in chunks until an empty one, so it walks past any cap). The Customers page is the reference implementation; RMA Tickets adds a searchable SETOF function (`rma_tickets_matching`, 20260852) for matches PostgREST cannot express (product serials inside jsonb) and a Kanban loaded per column (`rmaTickets.listColumn`: first cards + exact count, "Show more"); Products resolves brand/category NAMES to ids first (names live in other tables) and sorts by `brand(brand_name)` through the embedded to-one relation, with Hierarchy counts from `rma_product_hierarchy_counts` (20260853) (`customers.listPage` / `listAllMatching`, `ExportMenu` in counts-plus-`loadRows` mode, selection cleared when the page, filters or sort change). Pickers and name columns use `src/lib/useLookups.js` (`useCustomerSearch`, `useCustomer`, `useCustomersById`, `useProductSearch`, `useProductsById`) — never pass a `customers`/`products` array into a form. Inventory reads through `db.inventoryLists` (`src/api/db/inventoryLists.ts`) over the security-invoker views of `20260854_inventory_list_views.sql`: `v_product_stock_summary` (the Overview dashboard's stock arithmetic, formerly `getStockSummary`/`src/lib/stockSummary.ts`, now pinned by `supabase/tests/inventory_list_views.sql`), `v_inventory_product_groups` (All Units), `v_stock_moves_listing` (ledger + searchable `ref_label`), `v_inventory_units` (units + brand, grouping key, ticket customer/status), `v_bulk_stock_reservations`, `v_warehouse_unit_counts`; per-product drill-downs read that product's rows only, and every query key starts with `'inventory'` so one invalidation refreshes all tabs. The Knowledge Center Vault reads through `db.knowledgeLists` (`src/api/db/knowledgeLists.ts`) over `20260855_knowledge_explorer_views.sql`: `v_knowledge_nodes` (the Brand > Category > Subcategory > Product folder tree with placement, child counts and rolled-up sizes, formerly built in the browser by `src/lib/knowledgeTree.js`), `v_knowledge_documents` (documents + `path` for folder scope + `folder_path` label), `rma_knowledge_documents_matching` (search: text, SKU or product name) and `rma_knowledge_folder_stats`; pinned by `supabase/tests/knowledge_explorer_views.sql`. Company Docs pages and searches with `companyDocuments.listPage` (websearch `textSearch` + exact count); the KB lists use `kbArticles.listPage` (`publishedOnly` for the public `/kb`); bulk upload runs `skuMatch.matchFiles` over `products.skuCandidates()` (`rma_product_sku_candidates`, 20260856 — every product that could match a filename, so the result equals matching the whole catalogue) and picks products by search. Leads reads `v_leads_list` (20260857: `leads` + `sort_name`, the Name-column key) through `leads.listPage` / `listAllMatching` / `listColumn` (Kanban: first 50 + count per status, the first column also holds unknown statuses) / `tabCounts`; The Pipeline reads through 20260858: `v_deals_list` (deals + `customer_name` and the column sort keys `title_sort`/`customer_sort`/`stage_order`/`value_sort`), `rma_deals_matching(pipeline, term)` (search over title, code, rep, customer name) behind `deals.listPage` / `listAllMatching` / `listColumn` (Kanban: newest 50 + count per stage) / `getMany`, and grouped sums for every number on screen — `deals.buckets` (`rma_deal_buckets`: count + value per stage × rep × status × created month (viewer's time zone) × close month; graph, pivot, list total, column totals, header count via `src/lib/pipelineBuckets.js`), `deals.activityValues` (Kanban activity bar), `deals.activityTypeCounts` (Activity view headers, with done counts); pinned by `supabase/tests/pipeline_deal_functions.sql`. The Activities page reads `v_activities_list` (20260859: activities + `source`, `customer_name`, `source_code`, `related_exists`, sort keys — the names it used to build from every lead and deal) through `activities.listPage` / `tabCounts` (today/overdue use the due date's UTC day, as before) / `assignees` (`rma_activity_assignees`); the sidebar badge is `activities.countOverdue()` (a head count); the Tech Calendar reads one week (`rmaTickets.listDueBetween`, `activities.listPlannedBetween`), `rmaTickets.listUnscheduled` (first 60 + count) and `activities.calendarAssignees` (`rma_calendar_assignees`); a record's history (`activities.list`, `ticketActivity.list`, `ticketComments.list`) is read in full with `fetchAllRows`. Pinned by `supabase/tests/activities_list_view.sql`. Sales Documents reads `v_sales_documents_list` (20260860) through `salesDocuments.listPage` / `listAllMatching` (the header Export) and `salesDocuments.summary` (one call: tab counts, statuses in the tab, reps); a rep's own documents are assigned-to OR raised-by; pinned by `supabase/tests/sales_documents_list_view.sql`. Accounting reads 20260861: `payments.listPage` / `vendorPayments.listPage` over `v_payments_list` / `v_vendor_payments_list` (payment + counterpart name, searchable), and the aging tabs call `customerLedger.arAging` / `vendorLedger.apAging` (`rma_ar_aging` / `rma_ap_aging(p_today)`: one row per counterpart, buckets from `rma_aging_bucket`, payables converted to the base currency per invoice before summing; the viewer's local today); `crmInvoices.list`, `vendorInvoices.list` (now with `vendorId`/`statuses`), `brands.list`, the ledgers and `payments.list` read in full. Pinned by `supabase/tests/accounting_lists.sql`. Purchasing reads 20260862: `purchaseDocuments.listPage` / `listAllMatching` (Export All = tab `'any'`) over `v_purchase_documents_list` (documents + `vendor_name`, sort keys, `total_base_value` = docTotalBase), `purchaseDocuments.summary` (`rma_purchase_document_summary`: tab counts + `total` + statuses in the tab) and `purchaseDocuments.buckets` (`rma_purchase_document_buckets`: count + base-currency spend per type x status x vendor x created month in the viewer's time zone, cancelled included) behind the graph, the pivot and Vendor Details' totals (`groupBuckets` / `summarizeBuckets` in `Purchasing/_shared.js` drop cancelled documents from spend); the Vendors tab pages `v_vendors_list` (`brands.listVendorsPage`, blanks sort last) with `brands.count()`; a single vendor is `brands.get(id)`; `brands.list()` (full read) only feeds the vendor filter and pickers. Pinned by `supabase/tests/purchasing_lists.sql`. The Dashboard reads `db.dashboard` (`src/api/db/dashboard.ts`, 20260863: `rma_dashboard_ticket_summary(since, now, tz)` for every ticket figure, `rma_dashboard_crm(month_start)`, `recentTickets` / `overdueTickets` / `myOpenTickets` short ordered reads) plus `inventory.getStats()` (`rma_inventory_status_counts`) and `activities.countOverdue` / `listOverdueFirst`; the Control Panel home is `controlPanel.stats()` (`rma_control_panel_stats`), Pipelines & Stages `deals.stageCounts()` / `idsOnStage()`, Data Cleanup `dataCleanup.summary()` / `orphanCustomers()` / `duplicateGroups()` + `rmaTickets.staleIds()` (lists read only when opened). Reports reads `db.reports` (`src/api/db/reports.ts`, 20260864): each tab loads its own figures for `reportRange(from, to)` (local day bounds) — `rma_report_ticket_summary` / `_customer_summary` / `_customers` / `_technicians` / `_pipeline` / `_sales` (lineage funnel) / `_financial` — and pages its table (`ticketsPage`, `customersPage`, `invoicesPage` over `v_report_invoices`), exports reading every matching row; Profitability sums `rma_margin_totals` (`marginTotalsFromRaw` rounds like `summariseMargin`) and pages `margin.byInvoicePage`. Customer Details pages tickets (`customers.relatedTicketsPage` + `relatedTicketCounts`), deals (`deals.listPageForCustomer`) and the activity log (`customers.activityPage` over `v_customer_activity`, 20260865); Product Details pages `products.relatedTicketsPage` (`rma_product_tickets`); ticket unit linking looks up only the typed names (`rma_products_by_name_keys`). All pinned by `supabase/tests/dashboard_reports_summaries.sql`. The whole-table helpers (`customers.list`, `rmaTickets.list`, `products.list`, `deals.list`, `leads.list`, `timeEntries.listAll`, `margin.byInvoice`, …) are **removed**, and `src/test/fullTableReadGuard.test.js` fails CI if one comes back, if any `.limit()` asks for more than 1 000, or if a read in `src/api/db` has no range/chunking outside its short allowlist (WhatsApp reads are allowlisted while that work is on hold).

### TanStack Query

`QueryClientProvider` wraps the app in `main.jsx` with `staleTime: 60_000`, `retry: 1`, `refetchOnWindowFocus: false`. Use `useQuery` for all data fetching; avoid `useEffect` + `setState` for async data. After mutations, invalidate with `queryClient.invalidateQueries`. Optimistic updates (`queryClient.setQueryData`) are used for ticket/customer delete and customer edit — always include rollback on error.

### TypeScript lib layer

`src/lib/` is TypeScript:
- `constants.ts` — every magic string (`ROLES`, `TICKET_STATUS`, `PRIORITY`, `INVENTORY_STATUS`, `INVOICE_STATUS`, `NOTIF_TYPE`, `AUTOMATION_ACTION`, `CONFIG_KEY`, `STORAGE_KEY`). Always import from here; never hard-code status strings.
- `permissions.ts` — `canDo(role, permissions, section, action)` helper + `ROLE_DEFAULT_PERMISSIONS` + `resolvePermissions(role, stored)`. `super_admin` and `admin` bypass all checks automatically.
- `schemas.ts` — Zod validation schemas.
- `safeStorage.ts` — `safeStorage.get(key, fallback)` / `safeStorage.set(key, value)` / `safeStorage.remove(key)`. All `localStorage` access must go through this helper — it silently catches quota errors and Safari private-mode restrictions. Never call `localStorage.*` directly.
- `dealValue.ts` — `dealValueFor(quotations, dealStatus)` / `canMarkDealWon(quotations)` / `liveQuotations()` / `convertedQuotations()`. The forecast-vs-actual deal-value rule, extracted from `DealDetail.jsx` so it is unit-testable and CI-verified — see the Sales Documents section. Never re-implement this inline.
- `rmaStageMoves.ts` — `buildRmaMoves()` pure client half of the Warehouse R1 RMA auto-move (see the Inventory section).

`.js` extensions in imports resolve to `.ts` files via Vite/TypeScript bundler resolution.

### Permissions

Roles: `super_admin`, `admin`, `manager`, `technician`, `viewer`, `sales_rep`, `accountant` (the canonical list is `ROLES` in `src/lib/constants.ts`).

`super_admin` and `admin` bypass all permission checks. Other roles carry a `permissions` JSON object loaded from the `user_roles` table and passed down from `App.jsx` as `currentUserPermissions`. Default permission sets for the non-admin roles are defined in `ROLE_DEFAULT_PERMISSIONS` in **`src/lib/permissions.ts`** (not App.jsx). The `canDo(role, permissions, section, action)` helper is exported from the same file.

**Critical:** always resolve permissions with `resolvePermissions(role, stored)` (also in `permissions.ts`) before storing them in state — never use `stored || ROLE_DEFAULT_PERMISSIONS[role]`. An empty `{}` object is truthy and would override role defaults, stripping all permissions. `resolvePermissions` merges stored overrides on top of role defaults and treats `{}` / `null` / partial objects correctly.

Use the `canDo` pattern when gating UI actions — import `canDo` from `src/lib/permissions` and call `canDo(currentUserRole, currentUserPermissions, 'section', 'action')`.

**Permission preview ("view as user"):** Admin/super_admin can preview the app as another user's role+permissions from User Management's per-user action menu (cannot target admin/super_admin or yourself). `App.jsx` holds `previewUser` state; `effectiveUserRole`/`effectiveUserPermissions` are derived (`previewUser ? previewUser.role/.permissions : currentUserRole/.currentUserPermissions`) and passed to every route **including Control Panel** — Control Panel correctly redirects away when previewing a role that can't access it, same as a real login would. This is a **UI/`canDo()` gating preview only** — it does not swap the real Supabase session, so RLS-scoped data (e.g. that previewed user's own notifications) is unaffected. `AccountSettings` is the one route kept on the real role (it's "my own account," not a permission-gated module). The persistent `PreviewBanner` renders above `<Routes>` in the app shell, so "Exit preview" is always reachable regardless of which page the previewed role redirects to.

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

### WhatsApp / Messaging system

Provider-agnostic notification layer that fires on ticket lifecycle events. Ticket saves emit events via `notificationEventBus.emitAsync()` → handlers in `src/lib/events/ticketEventHandlers.ts` check settings → INSERT into `notification_queue` → invoke `notification-worker` for fast delivery with queue persistence for retry.

**Library (`src/lib/`):**
- `messaging/types.ts` — `IMessagingProvider`, `NotificationEvent`, `EventType`, `DeliveryStatus`, `QueueJob`, `QueueJobPayload`, `NotificationSettings`
- `messaging/TemplateEngine.ts` — `{{key}}` substitution + `{{#key}}…{{/key}}` conditionals; `toWhatsAppParams()` builds positional Meta API params
- `messaging/MessagingService.ts` — `messagingService` singleton; `registerProvider()`, `send()`, `sendBatch()`
- `messaging/providers/WhatsAppProvider.ts` — calls `send-whatsapp` Edge Function; never calls Meta API directly
- `events/NotificationEventBus.ts` — `notificationEventBus` singleton; `on()`, `emit()`, `emitAsync()`
- `events/ticketEventHandlers.ts` — `registerTicketEventHandlers()` called once from `App.jsx`

**DB tables** (`20260602_whatsapp_notifications.sql`): `whatsapp_templates`, `notification_logs`, `notification_settings`, `notification_queue`.

**Required Supabase secrets:** `WHATSAPP_ACCESS_TOKEN` (use a permanent **System User** token — the temporary API-Setup token expires every 24h → Meta error 190), `WHATSAPP_PHONE_NUMBER_ID` (all digits — a letter `O` for zero `0` causes Meta error 100), `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.

**Control Panel UI:** `src/pages/cp/WASettings.jsx` (provider + per-event toggles), `WATemplates.jsx` (CRUD + phone preview), `WALogs.jsx` (paginated delivery log), `WATestCenter.jsx` (send test, simulate event, run worker).

**Template param ordering (CRITICAL — JSONB pitfall):** WhatsApp templates use positional `{{1}}…{{n}}` params. The handler stores an explicitly-ordered `params: string[]` array in `notification_queue.payload` and the worker sends *that* — **never** rely on `Object.values(variables)` for the param order. **Postgres JSONB does not preserve object key order** (it reorders keys by length, then alphabetically), so an object round-tripped through the JSONB `payload` column comes back scrambled. Arrays preserve order in JSONB; objects do not. The number of params must exactly equal the Meta template's `{{n}}` count, and no param may be empty (Meta rejects empty positional params with error 131008 — the handler substitutes `—` for blanks).

**`whatsapp_templates.template_name`** is the Meta-registered template name actually sent to the API (e.g. `rma_ticket_created_v2`). The DB `body_content` is only for the in-app preview; only the `{{n}}` count must match Meta. To point the system at a renamed Meta template, `UPDATE whatsapp_templates SET template_name = '<new>' WHERE event_type = '<event>'` — no code change.

**Meta template category:** transactional notifications (ticket created/updated/closed) must be **Utility** category. **Marketing** templates are throttled by Meta (error 131049 "not delivered to maintain healthy ecosystem engagement"). Category can't be changed by editing — delete + recreate as Utility, and keep the body purely transactional (no "thank you for choosing us" promo lines, which trigger Marketing classification).

**Meta error cheat sheet** (all logged to `notification_logs.error_message` / `response_data`): 190 token expired · 100 bad phone number ID · 131008 empty/missing param · 132000 param count ≠ template `{{n}}` · 131049 Marketing-throttle (use Utility).

### Control Panel

`src/pages/ControlPanel.jsx` hosts all admin-only sub-pages (User Management, Branding, RMA Config, Custom Fields, PDF Layout, Announcements, Audit Log, Data Cleanup, Backup/Restore, Integrations, **WhatsApp & Messaging**). It uses `useURLTab` to keep the active feature in the URL as `?feature=...`.

### CSV bulk upload

The Products and Customers pages support bulk CSV import. A custom `parseCSVLine` helper (local to those pages) handles quoted fields — do not use plain `split(',')` because product names can contain commas inside quotes.

### Notifications

Real-time notifications use a single Supabase Realtime channel (`app_notifications`) subscribed in `App.jsx`. Notification visibility is filtered **server-side** via RLS policy `user_read_targeted` — the query only returns rows the current user is allowed to see. Per-type preferences are stored via `safeStorage` under the key `notif_system_prefs_<email>` and also persisted to `db.userPreferences` (synced on login). Changes propagate via a `notif-system-prefs-changed` window event.

### Edge Functions

Live in `supabase/functions/`:
- `admin-reset-password` — handles password reset (existing user) AND account creation (new user, create-if-missing logic)
- `public-track` — rate-limited public RMA lookup by RMA number (used by `/tracker`)
- `send-email` — email dispatch via the notifications system
- `send-whatsapp` — WhatsApp message dispatch via Meta Cloud API; reads `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` from Supabase secrets; writes audit log to `notification_logs`
- `notification-worker` — queue processor; fetches up to 10 pending `notification_queue` jobs, invokes `send-whatsapp`, exponential-backoff retry (5 min → 10 min → 20 min), 200 ms rate limit
- `whatsapp-webhook` — Meta delivery-status callbacks (GET: verification handshake via `WHATSAPP_WEBHOOK_VERIFY_TOKEN`; POST: updates `notification_logs` delivery status on sent/delivered/read/failed)

All Edge Functions validate the caller's JWT before performing privileged operations. Never expose the service role key to the browser.

**CORS (audit HIGH-4 residual, closed):** every function previously hardcoded `'Access-Control-Allow-Origin': '*'`. All 8 now import `corsOriginHeaders(req)` from `supabase/functions/_shared/cors.ts`, which reflects the request's `Origin` header only if it's on the `ALLOWED_ORIGINS` secret (comma-separated list) — falls back to `*` if that secret is unset, so this is opt-in: **set `ALLOWED_ORIGINS` in the Supabase project's Edge Function secrets to actually pin CORS in production.** CORS headers must be computed **per-request inside the handler**, not as a module-level constant — Deno's runtime can interleave concurrent requests within one isolate, so a shared mutable CORS value risks one request's response carrying another request's Origin. Where a function has its own `json()` response helper, that helper is now also defined per-request (closure) rather than module-level, for the same reason.

**`notification-worker` had a real pre-auth bypass (found and fixed while closing MED-7):** its third auth branch checked `!req.headers.get('x-trigger-source')` — i.e. "reject only if the header is absent" — so *any* value (attacker-chosen, not just the intended `pg_cron`) satisfied it, letting an unauthenticated caller drain the queue and burn WhatsApp/email send quota. Tightened to an exact match against what `20260604_pgcron_notifications.sql`'s `net.http_post` call actually sends (`x-trigger-source: pg_cron`), so the real cron job is unaffected. This is still a client-supplied string, not a real secret — fully closing it requires the cron job to also send `x-worker-secret` (would need Supabase Vault to store it without committing the value to a migration file), which is a follow-up, not done. Both `notification-worker` and `send-whatsapp` also gained a role check on the Bearer-token path (MED-7: `getUser()` alone proved authentication, not authorization — a `viewer` could trigger sends) — gated to non-viewer staff, matching the `rma_is_staff() AND role <> 'viewer'` idiom already used throughout the RLS policies.

### PWA

`vite-plugin-pwa` (Workbox `generateSW` strategy) pre-caches ~42 static assets. Supabase API calls use `NetworkFirst` with a 10-second timeout and fall back to cache. The manifest is defined in `vite.config.js`. Dev mode SW is disabled by default (set `devOptions.enabled: true` to test locally).

### Page folder structure

Five large pages are organized as folders. `React.lazy(() => import('./pages/X'))` auto-resolves to `index.jsx` — no changes needed in `App.jsx` when adding files inside a page folder.

| Folder | Files |
|--------|-------|
| `src/pages/Inventory/` | `index.jsx` (shell — 4 tabs: Overview/All Units/Stock Movements/Warehouses; the 5 RMA-stage tabs were removed in Warehouse Module R1, unknown-tab URLs fall back to Overview), `_shared.jsx` (incl. `locationI18nKey()`), `ExportMenu.jsx`, `TransferModal.jsx` (RMA-workflow only; the `'__system'` null-warehouse destination was removed in R1, `is_system` locations are excluded from its destination list), `OverviewTab.jsx` (the **Warehouse Dashboard** — Product/Available/Reserved/Physical Total/Main/Branches/RMA, R1 rebuild), `BranchesDrawer.jsx`/`RmaDrawer.jsx` (R1 drill-downs; RmaDrawer has the move-to-location + promote-to-sellable actions), `ByProductTab.jsx`, `CompanyStockTab.jsx`/`ManufacturerTab.jsx` (dead as top-level tabs — only their modal exports are live), `ProductDetailModal.jsx`, `WarehousesTab.jsx` (type/manager/notes + archive; R1 groups Sellable/Other/System + System badge + locks system rows), `StockMovementsTab.jsx` (`rma_ticket` doc-type links to the ticket), `StockBreakdownModal.jsx` (RMA section reads real unit locations), `ReceiveStockModal.jsx`, `TransferStockModal.jsx`, `AdjustStockModal.jsx`, `BulkStockActionModal.jsx` (Sprint 8). **`ProductStatusTab.jsx` was deleted in R1.** |
| `src/pages/RMATickets/` | `index.jsx` (shell + table), `TicketForm.jsx` (owns form state), `TicketDrawer.jsx` (owns comment/time/parts state), `_shared.jsx` (SortableHeader), `_utils.js` (pure helpers) |
| `src/pages/Products/` | `index.jsx`, `ProductsListTab.jsx`, `HierarchyTab.jsx`, `_modals.jsx` |
| `src/pages/UserManagement/` | `index.jsx`, `UsersTab.jsx`, `RolesTab.jsx`, `_shared.jsx`, `_utils.js` — "Role Templates" tab is now a read-only **"Role Reference"** (displays runtime `ROLE_DEFAULT_PERMISSIONS`). "Custom Roles" tab is hidden behind `ENABLE_CUSTOM_ROLES = false` flag (not yet wired end-to-end). |
| `src/pages/Customers/` | `index.jsx`, `_modals.jsx`, `_constants.js` |
| `src/pages/Leads/` | `index.jsx` (list + filters; 4 status tabs All/Active/Converted/Disqualified — **Kanban is offered only on the All tab**, and the rendered view is derived (`effectiveView`) rather than forced into state so a stale `?view=kanban` deep link degrades to list), `LeadDetails.jsx` (detail page; the header and the Lead Info panel have **separate** name-edit flags — one shared flag opens two `autoFocus` inputs), `_modals.jsx` (Create/Convert), `_constants.js`, `_shared.jsx` (SortableHeader) |
| `src/pages/Pipeline/` | `index.jsx` (view switcher, kanban, XLSX export, search/filters, multi-select stage/rep filters, export dropdown, lifted `selectedDeals` state), `DealDetail.jsx` (inline editing, **quotation LIST** — a deal holds many, product lines, stages), `DealCommentPanel.jsx` (right-side comment panel), `PipelineListView.jsx` (sortable table, stage pin dropdown, bulk select/delete/move, indigo bulk bar), `PipelineGraphView.jsx`, `PipelinePivotView.jsx`, `PipelineActivityView.jsx`, `_modals.jsx` (`CreateDealModal` doubles as the **edit** modal — in edit mode it hides Stage unless the pipeline changed), `_constants.js`, `_shared.jsx` |
| `src/pages/SalesDocuments/` | `index.jsx` (unified Quotation/SO/Invoice/Credit Note list, "All" tab via `v_sales_documents` view, archive tab), `SalesDocumentDetail.jsx` (per-type lifecycle actions: send/approve/convert/post/void, approval-activity raising), `SalesDocumentForm.jsx` (shared create/edit form for QT/SO/Invoice), `_modals.jsx` (`DocumentFormModal`, `RecordPaymentModal`, `VoidModal`, `CreateCreditNoteModal`, `CreateStandaloneCreditNoteModal`) |
| `src/pages/Accounting/` | `index.jsx` (Payments ledger tab + AR Aging tab), `_modals.jsx` (`RecordPaymentModal` — multi-invoice allocation, oldest-due-first auto-allocate) (Accounting v1) |
| `src/pages/Purchasing/` | `index.jsx` (5-tab list: All/Proforma Invoices/Purchase Orders/Vendor Invoices/Vendors via `v_purchase_documents`), `PurchaseDocumentDetail.jsx` (per-type lifecycle actions + dual-mode `ReceiveVendorInvoiceModal`), `_modals.jsx` (4 create modals) (Sprint 9) |

The remaining pages (`Dashboard`, `Reports`, `Invoices`, `PartsInventory`, `ControlPanel`, `AccountSettings`, etc.) are still single files.

**Shared CRM component:** `src/components/ActivityChatter.jsx` — generalized chatter panel (note/schedule/reply/reschedule/reopen/attachments) used by both `LeadDetails.jsx` and `DealDetail.jsx`. Accepts `relatedType`/`relatedId`/`controlledTab`/`onControlledTabChange`/`hideNoteComposer`/`hideHistory` props. Do not re-implement this per-page — always import the shared component.

**AI Assist component:** `src/components/AIAssist.jsx` exists but is **hidden** — all `<AIAssist>` imports and JSX have been removed from Dashboard, Reports, Inventory, CustomerDetails, and RMATickets. The `ai-assist` Edge Function and `ai.assist()` API helper still exist for future re-enabling.

### Sales Documents & Accounting (CRM Sprint 6 + Accounting v1)

The funnel is **Lead → Deal → Quotation → Sales Order → Invoice → Credit Note**, with payments tracked separately against invoices. All four document types (`quotations`, `sales_orders`, `crm_invoices`, `credit_notes`) plus `payments` live under `/sales` and `/accounting`.

**A deal holds MANY quotations (2026-08-05).** Each is fully independent: its own approval cycle, its own conversion to a Sales Order, and approving or converting one does nothing to the others. `quotations.getByDeal()` is `@deprecated` — it returns only the newest and will silently hide the rest; use `quotations.list({ dealId })`. `salesOrders.list()` takes `quotationIds[]` to resolve the SOs for several quotations in one query. Because a deal's approval activities can now target different quotations, `ActivityChatter` passes the **activity object** alongside its id to `onApproveActivity`/`onRejectActivity` — the `approval|quotation|<id>|…` title is the only thing that says which document is being approved (legacy single-quotation activities fall back to the sole quotation).

**Deal value = forecast while open, actual once closed.** The rule lives in **`src/lib/dealValue.ts`** (pure + 18 Vitest cases) rather than inside `DealDetail.jsx`, because it decides money and must be CI-verified:

| Deal `status` | Value | Rationale |
|---------------|-------|-----------|
| `open` | Σ of every **live** quotation (`draft`/`sent`/`accepted`/`converted`) | what the deal could be worth |
| `won` / `lost` | Σ of **converted** quotations only | what actually materialised |

Cancelled, declined, expired, and archived quotations count toward **neither**. **Deals with no quotations keep a hand-typed value — `syncDealValue()` returns early rather than writing 0 over it.** Keyed off `deal.status`, **never stage names**: stages are user-configurable in Control Panel, so a name-matching rule would break the first time one is renamed. `canMarkDealWon()` blocks marking a deal won until at least one quotation has converted (a win with 0 actual value isn't backed by a real order); deals without quotations are unaffected. The value must be re-synced on **every** transition that changes either set — quotation create/edit/archive/decline/cancel/convert **and** deal won/lost/**reopen** (reopening has to push the value back up from actual to forecast).

**Changing a deal's pipeline requires a stage remap.** Stages belong to a pipeline, so `deals.moveStage()` deliberately validates against the deal's *current* pipeline and structurally cannot express a cross-pipeline move. `deals.movePipeline(id, pipelineId, stage, actor)` validates the stage against the **destination** pipeline and writes `pipeline_id` + `stage` in one update, so a deal is never left pointing at a stage that doesn't exist in its own pipeline.

**Approval-pool pattern:** instead of a separate approvals table, an `activities` row with `type: 'approval'` is raised whenever a document needs manager sign-off. Its `title` field encodes `approval|docType|docId|code|total|customer` (parsed via `parseApprovalTitle()`); `approveDocument(docType, docId)` / `rejectDocument(docType, docId)` in `src/pages/Activities/index.jsx` dispatch to each document type's lifecycle action (`salesOrders.markAccepted()`, `crmInvoices.post()`, etc.). A Sales Order approval **lands directly in `delivered`** (inventory reserved) in one step — there is no separate "Confirm Order"/"Mark Delivered" click. An Invoice's approval activity is raised the moment a draft invoice is created (from SO conversion); approving it calls `post()` (assigns `inv_code`, decrements inventory); rejecting it calls `void_()`.

**Gapless vs. random codes:** `INV-`, `CN-`, and `PAY-` codes are assigned atomically via `nextval_for_type()` (`20260712_document_sequences.sql`) only at issue/post time, not at draft creation — format `PREFIX-YYYY-NNNNN`, resets yearly. `QT-` and `SO-` codes are random 8-digit (`generate_doc_code()`), assigned at creation time since they carry no legal/sequential requirement. Deal codes use `OPP-` (renamed from a colliding `QT-` in `20260726_crm_deal_code_prefix_opp.sql`).

**Two-stage inventory reservation:** `reserve_units`/`deliver_units`/`release_units`/`restore_units` RPCs (`20260719_inventory_reservation.sql`) move serialized units through reserved→delivered, with every state change appended to `stock_moves` (`20260713_stock_moves.sql`, append-only audit trail).

**Application-table pattern (credit notes & payments) — append-only ledger, not one-row-per-pair:** both `credit_note_applications` and `payment_applications` link a credit note / payment to one or more invoices with a per-invoice applied amount, each with a sync trigger (`sync_credit_note_balance` / `sync_payment_balance`) that recalculates the parent's `remaining_balance` / `unapplied_amount` from a `SUM(amount_applied)` over all rows for that parent — never a stored running total. As of the 2026-07-02 audit hardening (`20260754_payment_cn_reversal.sql`), these tables have **no `UNIQUE(parent_id, invoice_id)` constraint** — a reversal is a new row with a negative `amount_applied` (never a delete or an UPDATE of history, matching the `stock_moves` discipline), so the same pair can be applied → reversed → re-applied any number of times. `amount_paid`/`payment_status` on `crm_invoices` are set directly inside the `SECURITY DEFINER` RPCs that insert these rows (`record_payment`, `issue_credit_note`, `apply_payment_to_invoice`, `apply_credit_note_to_invoice`, `_reverse_payment_application`, `_reverse_credit_note_application`) — **not** via `crmInvoices.recordPayment()`, which is dead code, superseded when the invoice-balance update moved server-side (closing HIGH-2's non-atomic read-then-write). **Voiding an applied credit note or payment now reverses every active application first** (`void_payment`/`void_credit_note` RPCs), then marks it voided — closing the audit's CRIT-5 finding that this was previously blocked outright with no correction path. A single application line can also be reversed on its own via `reverse_payment_application`/`reverse_credit_note_application`, without voiding the whole payment/CN — the fix for a payment misapplied to the wrong invoice (the exact scenario CRIT-2 hardened against). `void_invoice`'s guard was changed from "any application row exists" to "net applied amount > 0" for the same reason — the old EXISTS check would have permanently blocked voiding an invoice the instant any payment ever touched it, since a reversal leaves both the original and its reversal row in place.

**Accounting module v1** (`src/pages/Accounting/`) is a lightweight AR layer, not a full ERP: a `payments` ledger (one payment can be split across multiple open invoices, oldest-`due_date`-first auto-allocate), an AR aging report (Current/31-60/61-90/90+ vs. `due_date`, computed client-side from `crm_invoices`), and a per-customer statement (`v_customer_ledger` view, signed amounts, running balance) on the Customer Details "Billing" tab. `customers.credit_limit` is a soft warning only — it is never enforced and never blocks document creation.

### Inventory (Sprint 7.6 + 8) & Purchase Module (Sprint 9)

**Two orthogonal status axes on `inventory_units` — never conflate them:** `status` is the physical/RMA lifecycle (`active_rma`/`company_stock`/`sent_to_manufacturer`/`closed`, enforced by `chk_inventory_status`); `reservation_status` is the funnel state (`available`/`reserved`/`delivered`). **Sellable = `status = 'company_stock'` only** — an `active_rma` unit can never be reserved for a sale, even if `reservation_status` shows `available`. **`restore_units`' own code violated this rule until `20260755_fix_restore_units_status_conflation.sql`** (found 2026-07-02 while extending DB test coverage): it set `reservation_status = p_to_status` directly, so the documented damaged/scrapped-return call (`p_to_status='active_rma'`) tried to write an invalid `reservation_status` and raised a CHECK violation — masked in production because the only caller, `creditNotes.restoreUnits()`, always passed `'available'`. Fixed to always resolve `reservation_status` to `'available'` on restore, independent of which physical `status` the unit returns to.

**Dual stock-tracking model:** `products.stock_tracking_mode` (`serialized` default, or `bulk`) governs *how* a non-service product's stock is tracked — independent of `product_type` (which governs *whether* a line touches inventory at all; `service` never does). `serialized` products use one `inventory_units` row per physical unit (availability = live `COUNT(*)`, never a stored number). `bulk` products use `warehouse_stock` (product × warehouse → `quantity`/`reserved_quantity` counters, mirroring `parts` but with a warehouse dimension `parts` never had — a genuinely separate table, not a rollup, per an explicit 2026-07-01 decision). `funnel_reserve_line` branches 3 ways: `service` → no-op, `serialized` → `reserve_units`, `bulk` → `reserve_warehouse_stock`.

**`warehouse_stock` has no per-document reservation marker** (unlike `inventory_units.reserved_by_doc_id`) — a single row's `reserved_quantity` can be a shared counter across multiple concurrent documents. `release_warehouse_stock`/`deliver_warehouse_stock` compute "how much of *this* document's reservation is on *this* row" by reading it back out of the `stock_moves` ledger (net `reserve` minus prior `release`/`deliver` per row), which makes them idempotent by construction — a duplicate call finds nothing net-positive left and safely no-ops. **When filtering `stock_moves` by `doc_id`, always use `IS NOT DISTINCT FROM`, never `=`** — `doc_type='manual'` calls legitimately pass `NULL` for `doc_id`, and plain `=` silently matches zero rows against NULL (a real bug found and fixed in this exact code, Sprint 8a).

**Two "Receive Stock" paths, by design:** `receive_stock()` (Sprint 8) is the *interim* manual entry point — no vendor/audit trail, just product + warehouse + serial-or-qty. `vendorInvoices.receive()` → `receive_vendor_invoice` RPC (Sprint 9) is the *permanent* path — every unit/quantity traces back to a `vendor_invoices.id` via `inventory_units.vendor_invoice_id`. Both remain in the codebase; Sprint 8's button is a fallback for stock with no vendor paperwork.

**`stock_moves.doc_type` has a `vendor_invoice` value distinct from `invoice`** — a `vendor_invoices.id` and a sales `crm_invoices.id` are different entities; reusing `invoice` would make `doc_id` ambiguous and break the Stock Movements tab's document links (which route sales doc types to `/sales/:type/:id`, not `/purchasing/...`).

**Two transfer components, and since 2026-09-16 both are on the ledger**: `TransferStockModal.jsx`/`AdjustStockModal.jsx` (funnel stock, one unit or quantity at a time, `transfer_stock`/`adjust_stock`) vs. `TransferModal.jsx`/`db.inventory.transferUnits()` (RMA-workflow screens, a whole selection at once, now `transfer_units` — 20260866). The "System Pool"/null-warehouse destination that kept them apart is gone (dropped from the modal in R1; no unit is unplaced), and `transfer_units` refuses reserved units and system/archived destinations itself, because a `SECURITY DEFINER` call skips the 20260831 browser guard. What still separates them is shape: `transfer_stock` is the bulk/serialized dispatcher for one line, `transfer_units` is set-based and serialized-only, and splitting a selection across calls would break its all-or-nothing transaction. **Any new direct write to `inventory_units.warehouse_id` is a regression** — `src/test/transferLedger.test.js` fails on one.

**Purchase Module document flow (redesigned 2026-07-05):** Brands ARE the vendors — the standalone `vendors` table and Proforma Invoices are gone (`20260756`–`20260762`, a user-approved destructive reset of all prior purchasing data). Flow: **Purchase Order** (`PO-` random code; non-financial, never touches inventory; `draft → sent → pending_confirmation → confirmed`, plus `cancelled`/`expired`) → **Vendor Invoice** (the financial document; `draft → pending_approval → approved → partially_received → received`, plus `cancelled`; approval raises the same activities-pool `type: 'approval'` row the sales funnel uses, dispatched from `src/pages/Activities/index.jsx`, reject sends it back to `draft`) → `receive_vendor_invoice` (dual-mode, same serialized/bulk branch as `receive_stock`; also syncs the linked PO to `completed`/`partially_completed`) → `inventory_units`/`warehouse_stock`. Partial receipt is representable: each `vendor_invoices.line_items` entry carries `qty_ordered` + `qty_received` (now also `discount_pct`/`tax_pct`, mirroring `QuotationLine`). Confirmed/approved+ Vendor Invoices also drive a **Vendor Payments (AP)** ledger — `vendor_payments`/`vendor_payment_applications` (hardened from day one: manager+ guard, server-derived actor, allocation validation, ledger-style reversals — the AR layer needed a follow-up pass for this, AP didn't), surfaced on `/accounting`'s "Vendor Payments"/"AP Aging" tabs. Purchase Orders get a professional PDF (`src/lib/purchaseOrderPdf.js`, reuses the shared `documentPdf.js` engine and the Sales Documents `sales_doc_layout` Control Panel config — no separate PDF layout tab). Vendor details (contact/email/phone/tax ID/payment terms) are editable from both the Products → Brands modal and Purchasing's Vendors tab (managers can now write to `brands`, widened from admin-only). Lives at `/purchasing`, gated by the existing `deals.view` permission (no new permission section, matching the project's "no new gates yet" standing rule).

### Accessibility

`@axe-core/react` is installed as a devDependency and mounted in `src/main.jsx` behind an `import.meta.env.DEV` guard. In development, it logs WCAG violations to the browser console automatically — no setup needed. It is never included in production builds.

All sort buttons use `aria-sort="ascending|descending|none"` (via `SortableHeader` in `RMATickets/_shared.jsx` and `InvSortBtn` in `Inventory/_shared.jsx`). All icon-only action-menu buttons have `aria-label`, `aria-expanded`, and `aria-haspopup="menu"`. Filter-panel toggles have `aria-expanded` + `aria-controls` pointing to the panel's `id`.

### Sentry

`initSentry()` is called in `main.jsx` with a no-op guard (skips if DSN is not set). `captureException()` helper is wired into `ErrorBoundary.componentDidCatch`. Import `captureException` from the Sentry integration file — do not call `Sentry.captureException()` directly in page components. Set `VITE_SENTRY_DSN` in Vercel environment variables to enable automatic error capture in production.

The `ErrorBoundary` shows the error **message** in production (safe, user-diagnosable) plus a "Copy error details" button that captures the full stack + URL + timestamp. The full stack trace is dev-only.

### Database migrations

All schema changes are SQL migration files in `supabase/migrations/` named `YYYYMMDD_description.sql`. All migrations are idempotent (`IF NOT EXISTS`, `IF EXISTS`, `DROP POLICY IF EXISTS`). Never alter production schema via the Supabase dashboard without a corresponding migration file.

The list below is **curated, not exhaustive** — `supabase/migrations/` is authoritative, and the `Migration drift` workflow keeps production in step with it. Migrations `20260768`–`20260865` (Warehouse R1 follow-ups, the currency/costing work and the September audit fixes) are described in `AUDIT_REPORT.md` under the finding each one fixes, and in their own header comments.

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
- `20260604_pgcron_notifications.sql` — pg_cron scheduled notifications (requires Supabase Pro)
- `20260604_priority_changed_email_template.sql`
- `20260604_ticket_customer_email.sql` — adds `customer_email` to `rma_tickets`
- `20260604_ticket_resolutions.sql` — replacement/exchange/credit-note/refund outcomes, one per ticket
- `20260613_search_by_serial.sql`
- `20260617_kb_articles.sql`

CRM upgrade (Track A — `docs/archive/specs/002-crm-upgrade/`), applied in order:
- `20260618_crm_add_sales_rep_role.sql` — adds the `sales_rep` role (prerequisite, sequenced first)
- `20260619_crm_contacts.sql`
- `20260620_crm_pipelines.sql`
- `20260621_crm_leads.sql`
- `20260622_crm_deals.sql`
- `20260623_crm_activities.sql`
- `20260624_crm_customers_extend.sql`
- `20260625_crm_notification_events.sql`
- `20260626_crm_leads_convert_rpc.sql` — `convert_lead_to_deal` RPC
- `20260627_crm_fix_duplicate_user_roles_check.sql`
- `20260628_crm_assigned_rep_use_email.sql` — `assigned_rep` is `text`/email, not a uuid FK
- `20260629_crm_created_by_use_email.sql` — `created_by` is `text`/email, not a uuid FK
- `20260630_crm_convert_lead_customer_code.sql` — RPC sets `customer_code` (was NOT NULL violation)
- `20260701_crm_leads_add_statuses.sql` — adds `active`/`inactive` lead statuses
- `20260702_crm_activities_chatter.sql` — chatter columns (`attachments`, system `log` type)
- `20260703_crm_activities_replies.sql` — `parent_id` for comment replies
- `20260704_crm_pipeline_rename_new_lead_stage.sql` — renames B2B "New Lead" stage label to "New Deal" (data UPDATE only)
- `20260705_crm_remove_b2c_pipeline.sql`
- `20260706_seed_test_users_and_deals.sql` — 10 test users + 31 deals across all stages
- `20260707_crm_rename_new_deal_stage_plural.sql` — "New Deal" → "New Deals" label
- `20260708_crm_sync_deal_values.sql` — back-fills `deals.value` from product lines; enforces probability 100/0 for won/lost
- `20260709_crm_lead_deal_codes.sql` — adds `lead_code` (LD- prefix) and `deal_code` (DL- prefix) columns; backfills existing rows
- `20260710_crm_deal_code_rename.sql` — renames backfilled deal codes from DL- to QT- (Quotation lifecycle)
- `20260711_crm_convert_rpc_deal_code.sql` — updates `crm_convert_lead` RPC to generate QT- `deal_code` atomically on conversion

Sales Documents (CRM Sprint 6 — Quotation → Sales Order → Invoice → Credit Note), applied in order:

- `20260712_document_sequences.sql` — `document_sequences` table + `nextval_for_type()` RPC (gapless `INV-`/`CN-` codes) + `generate_doc_code()` (random `QT-`/`SO-` codes)
- `20260713_stock_moves.sql` — append-only ledger for every inventory state change (reserve/deliver/release/restore)
- `20260714_quotations.sql` — `quotations` table + RLS
- `20260715_sales_orders.sql` — `sales_orders` table + RLS
- `20260716_crm_invoices.sql` — `crm_invoices` table + RLS + `post_invoice` RPC
- `20260717_credit_notes.sql` — `credit_notes` table + RLS + `issue_credit_note` RPC
- `20260718_credit_note_applications.sql` — `credit_note_applications` table; `sync_credit_note_balance` trigger keeps `applied_amount`/`remaining_balance` in sync
- `20260719_inventory_reservation.sql` — two-stage stock model (`reserve_units`/`deliver_units`/`release_units`/`restore_units` RPCs)
- `20260720_sales_documents_view.sql` — `v_sales_documents` UNION view (powers the "All" tab)
- `20260721_crm_activities_approval_type.sql` — allows `'approval'` as an activity type
- `20260722_sales_documents_archive.sql` — `archived`/`archived_at`/`archived_by` columns across all four document tables
- `20260723_sales_orders_approval_statuses.sql` — adds `sent`/`accepted`/`declined` to `sales_orders.status`
- `20260724_crm_convert_lead_created_by_email.sql` — fixes `crm_convert_lead` to use email (not `auth.uid()`) for `created_by`
- `20260725_quotations_add_converted_status.sql` — allows `'converted'` quotation status (locks the QT once converted to an SO)
- `20260726_crm_deal_code_prefix_opp.sql` — renames the deal-code prefix from the colliding `QT-` to `OPP-` (backfill + RPC update)

Accounting Module v1 (payments ledger, AR aging, customer statement, credit limits), applied in order:

- `20260727_crm_payments.sql` — `payments` + `payment_applications` tables + RLS (mirrors `credit_notes`/`credit_note_applications`); `sync_payment_balance` trigger; `record_payment` RPC
- `20260728_crm_payment_sequence.sql` — registers the `payment` sequence type (`PAY-YYYY-NNNNN`) in `nextval_for_type()`
- `20260729_crm_customer_credit_limit.sql` — adds `customers.credit_limit` (soft warning only, never enforced)
- `20260730_crm_customer_ledger_view.sql` — `v_customer_ledger` UNION view (signed invoice/credit-note/payment feed, powers the Billing tab statement)

Sales Funnel Hardening (Sprint 7.5 — atomic lifecycle RPCs, inventory reservation guards), applied in order:

- `20260732_funnel_line_reservation.sql` — `funnel_reserve_line` helper; classifies product lines as serialized (→ `reserve_units`) vs. service/non-stock (→ no-op) at reserve time
- `20260733_so_lifecycle_rpcs.sql` — `confirm_sales_order` + `cancel_sales_order` SECURITY DEFINER RPCs; `cancel` works from any non-invoiced status and calls `release_units`
- `20260734_invoice_lifecycle_rpcs.sql` — `post_invoice` + `void_invoice` SECURITY DEFINER RPCs; `void` blocks on applied payments/CNs and restores stock via `stock_moves` lookup; both enforce `rma_is_manager_or_above()`
- `20260735_cn_payment_lifecycle_rpcs.sql` — `issue_credit_note` + `void_credit_note` + `record_payment` SECURITY DEFINER RPCs; void blocks once applied; all enforce role
- `20260736_lead_deal_guards.sql` — `guard_converted_lead()` BEFORE UPDATE trigger (converted leads are immutable except `notes`); fixes `crm_convert_lead` `created_by` regression (was `auth.uid()` in `20260726`, now `rma_current_user_email()`); validates `p_existing_customer_id` existence before accepting

Inventory Model Reconciliation (Sprint 7.6), applied in order:

- `20260737_inventory_units_add_product_id.sql` — adds `inventory_units.product_id` (nullable FK to `products`, no backfill) — `reserve_units`/`funnel_reserve_line` had referenced this column since creation but it never existed (discovered live)
- `20260738_inventory_model_reconciliation.sql` — fixes `reserve_units`' `ORDER BY created_at` → `created_date` (same class of latent bug as above); documents the `status` (RMA lifecycle) vs `reservation_status` (funnel state) contract via `COMMENT ON COLUMN`; `funnel_reserve_line` classifies by `products.product_type` (`service` → no-op) instead of row existence; `reserve_units` restricted to `status = 'company_stock'` only
- `20260739_inventory_serial_uniqueness.sql` — partial UNIQUE index on `inventory_units.serial_number` (excludes NULL/`''`/`closed`)

Inventory & Warehouse Management (Sprint 8), applied in order:

- `20260740_inventory_bulk_stock_schema.sql` — `products.stock_tracking_mode` (`serialized`/`bulk`); new `warehouse_stock` table + RLS; `warehouses` gains `warehouse_type`/`manager`/`notes`; extends `stock_moves.move_type` (+`receive`,`transfer`) and `ref_type` (+`warehouse_stock`)
- `20260741_warehouse_stock_reservation_rpcs.sql` — `reserve_warehouse_stock`/`release_warehouse_stock`/`deliver_warehouse_stock`/`restore_warehouse_stock` (bulk-quantity counterpart to the serialized RPCs; release/deliver compute net-reserved-per-row from the `stock_moves` ledger since a shared counter row has no per-document marker)
- `20260742_funnel_reserve_line_bulk_branch.sql` — `funnel_reserve_line` extended to a 3-way branch (service/serialized/bulk)
- `20260743_receive_stock_rpc.sql` — `receive_stock` dual-mode manual receive (interim path, replaced by Sprint 9 for the permanent audit trail)
- `20260744_transfer_stock_rpc.sql` — `transfer_stock` atomic dual-mode warehouse transfer
- `20260745_adjust_archive_recalculate_rpcs.sql` — `adjust_stock`, `archive_warehouse` (soft-delete guard), `recalculate_stock` (bulk `reserved_quantity` reconciliation only)

Purchase Module (Sprint 9), applied in order:

- `20260746_purchase_vendors.sql` — `vendors` table + RLS
- `20260747_purchase_documents.sql` — `proforma_invoices`/`purchase_orders`/`vendor_invoices` tables + RLS; registers `vendor_invoice` sequence type (`VI-` prefix) in `nextval_for_type()`; extends `stock_moves.doc_type` with `vendor_invoice` (distinct from sales `invoice` to avoid `doc_id` ambiguity)
- `20260748_inventory_units_vendor_invoice_fk.sql` — `inventory_units.vendor_invoice_id` nullable FK
- `20260749_receive_vendor_invoice_rpc.sql` — `receive_vendor_invoice` atomic dual-mode RPC; assigns `VI-YYYY-NNNNN` only on first receipt, supports partial (multi-shipment) receipt via per-line `qty_received`
- `20260750_purchase_documents_view.sql` — `v_purchase_documents` UNION view (same pattern as `v_sales_documents`)

Audit hardening (2026-07-02 — see [`docs/archive/AUDIT_REPORT_2026-07-02.md`](docs/archive/AUDIT_REPORT_2026-07-02.md)), applied in order:

- `20260751_harden_money_rpcs.sql` — closes audit CRIT-1/2/3 + HIGH-2 for the money layer: `record_payment` and `issue_credit_note` gain a `rma_is_manager_or_above()` guard and a **server-derived actor** (`COALESCE(rma_current_user_email(), p_actor_email)` — the passed-in actor is no longer trusted); `record_payment` validates each allocation (running-sum ≤ payment amount, invoice is `posted` and belongs to the paying customer, `FOR UPDATE`); `sync_payment_balance` de-clamped (no more `GREATEST(…,0)`) so over-allocation drives `unapplied_amount` negative and trips the new `CHECK (unapplied_amount >= 0)`; adds transactional `apply_payment_to_invoice` + `apply_credit_note_to_invoice` RPCs (the client `applyToInvoice` helpers now delegate to these instead of a non-atomic read-then-write). **`SECURITY DEFINER` bypasses RLS** — so these in-body guards, not the table policies, are what enforce authz on the RPC path.
- `20260752_lockdown_rpc_execute.sql` — closes CRIT-1's "no REVOKE" half comprehensively: dynamically `REVOKE`s PUBLIC/anon `EXECUTE` and `GRANT`s only `authenticated`/`service_role` on all 24 client-invoked RPCs (resolves overloads via `pg_proc`). The `rma_*` RLS helpers are intentionally excluded (policies must keep calling them).
- `20260753_stock_moves_actor_from_jwt.sql` — closes CRIT-3 for the inventory ledger: a `BEFORE INSERT` trigger on the append-only `stock_moves` table overwrites `actor_email` with `rma_current_user_email()` whenever a JWT is present. One trigger covers every inventory/reservation/receipt RPC's ledger write — chosen over full-body rewrites of ~14 functions (several already amended by `20260738`/`20260742`, so blind rewrites risked reintroducing fixed bugs). `inventory_units.reserved_by_email` is a known minor residual; the authoritative audit trail (`stock_moves`) is now spoof-proof.
- `20260754_payment_cn_reversal.sql` — closes CRIT-5: adds `reverse_payment_application`/`reverse_credit_note_application` (reverse one application line) and `void_payment`/`void_credit_note` (reverse every active line, then void) RPCs. Drops the `UNIQUE(parent_id, invoice_id)` constraint on both application tables and relaxes their `amount_applied` CHECK to permit negative reversal rows — see the Application-table pattern note above for the full ledger-semantics rationale. Also fixes `sync_credit_note_balance`'s one-directional status flip (`issued→applied` only, never back) and `void_invoice`'s now-permanent `EXISTS`-based guard (rewritten to a net-`SUM` check).
- `20260755_fix_restore_units_status_conflation.sql` — found while extending DB test coverage to `restore_units`: it set `reservation_status = p_to_status` directly, so the documented damaged/scrapped-return call (`p_to_status='active_rma'`) tried to write an invalid `reservation_status` value and raised a CHECK violation — conflating the two status axes this file's own architecture note (above) says must never be conflated. Masked in production because the only caller, `creditNotes.restoreUnits()`, always passed `'available'`. Fixed to always resolve `reservation_status` to `'available'` on restore, independent of the physical `status` requested.

Purchase Module redesign (2026-07-05 — Brands as vendors, PO→VI funnel, AP payments), applied in order:

- `20260756_brands_vendor_fields.sql` — bootstraps `brands` (first-ever migration touching it — predates the migration history) and adds vendor fields (`contact_person`/`email`/`phone`/`tax_id`/`payment_terms`); widens write RLS from admin-only to manager+ (user-approved — vendor editing needs manager access, same tier as the rest of Purchasing)
- `20260757_purchasing_reset.sql` — **user-approved destructive reset**: wipes all existing `purchase_orders`/`vendor_invoices` rows, drops `proforma_invoices` and the standalone `vendors` table entirely, repoints `vendor_id` FKs to `brands(id)`; adds PO fields (`issue_date`/`currency`/`payment_terms`/`delivery_terms`/`shipping_address`/`billing_address`/`terms_conditions`/`subtotal`/`discount_amount`/`tax_amount`/`archived*`) and VI fields (`due_date`/`subtotal`/`discount_amount`/`tax_amount`/`archived*`, renames `confirmed_at`→`approved_at`); new status CHECKs — PO: `draft/sent/pending_confirmation/confirmed/partially_completed/completed/cancelled/expired`; VI: `draft/pending_approval/approved/partially_received/received/cancelled`
- `20260758_receive_vi_po_completion.sql` — `receive_vendor_invoice` status guard updated to `approved`/`partially_received`; now also syncs the linked PO to `completed`/`partially_completed`
- `20260759_activities_purchase_related_types.sql` — widens `chk_activity_related_type` to allow `purchase_order`/`vendor_invoice` (VI submit-for-approval reuses the activities-pool pattern)
- `20260760_vendor_payments.sql` — `vendor_payments`/`vendor_payment_applications` (Accounts Payable), **hardened from day one** (unlike the AR `payments` table, which needed `20260751`/`20260754` as a follow-up pass): manager+ guard, server-derived actor, allocation validation, `CHECK(unapplied_amount >= 0)` from creation, ledger-style reversals (no `UNIQUE(payment,invoice)`); `record_vendor_payment`/`apply_vendor_payment_to_invoice`/`reverse_vendor_payment_application`/`void_vendor_payment` RPCs; registers the `vendor_payment` → `VP-` sequence; `vendor_invoices` gains `amount_paid`/`payment_status`/`paid_at`
- `20260761_vendor_ledger_view.sql` — `v_vendor_ledger`, the AP mirror of `v_customer_ledger`
- `20260762_purchase_documents_view.sql` — rebuilds `v_purchase_documents` down to 2 branches (proforma gone), adds `payment_status`/`archived`/`archived_at` for parity with `v_sales_documents`
- `20260763_vendor_invoices_updated_at.sql` — bug fix, found 2026-07-05 during live manual testing: `record_vendor_payment`/`apply_vendor_payment_to_invoice`/`_reverse_vendor_payment_application` (all `20260760`) set `vendor_invoices.updated_at`, but that column was never added — `purchase_orders` has had `updated_at` since `20260747`, `vendor_invoices` never did, and `20260757` (which added a batch of columns to both tables) missed it. Adds the missing column; no RPC body changes needed.

Warehouse Module Redesign R1 (2026-07-09 — RMA stages become real inventory locations + Warehouse Dashboard), applied in order:

- `20260764_warehouse_system_locations.sql` — `warehouses.is_system` + a partial unique index on `code WHERE is_system`; a BEFORE UPDATE/DELETE **protection trigger** (blocks delete/rename/re-code/re-type/deactivate of system rows; manager/notes/description stay editable); re-CREATEs `archive_warehouse` with an `is_system` guard ahead of the existing live-stock check; idempotent seed of the **8 system locations** — `RMA-RECEIVED`/`RMA-REPAIR`/`RMA-REPAIRED`/`RMA-CANTREPAIR`/`RMA-STOCK` (type `rma`), `REPLACEMENT` (type `transit`), `CREDIT-NOTE` (type `rma`), `SCRAP` (type `virtual`). Closes the gap where RMA ticket stages lived as free-text `product_status` inside ticket JSONB, disconnected from real inventory (`resolve_units()` — the only active_rma→company_stock path — had **zero callers** anywhere in `src/`).
- `20260765_stock_moves_rma_ticket_doctype.sql` — extends `stock_moves.doc_type` CHECK with `'rma_ticket'` (catalog-lookup drop pattern) so an RMA auto-move traces back to its ticket.
- `20260766_rma_move_rpcs.sql` — `move_rma_units(p_ticket_id, p_moves jsonb, p_actor_email)` (staff-non-viewer; relocates each active_rma unit to the matching system location, **idempotent** — a unit already at target is a no-op, so re-saving a ticket is safe) + `promote_rma_unit(p_unit_id, p_warehouse_id, p_actor_email, p_resolution_type)` (manager+; **the previously-missing active_rma→company_stock path**; blocked for reserved units and `is_system`/non-sellable destinations). Both get the standard EXECUTE lockdown.
- `20260767_backfill_rma_unit_locations.sql` — one-time DO block placing existing unplaced (`warehouse_id NULL`) active_rma units on non-Cancelled tickets into the matching location (serial-first/name-fallback/RMA-RECEIVED-fallback), writing a `stock_moves` row with actor `system@backfill`. Idempotent via the NULL-warehouse predicate.

BUG-032 ledger close-out (2026-09-16):

- `20260866_transfer_units_ledger.sql` — `transfer_units(p_unit_ids uuid[], p_to_warehouse_id uuid, p_actor_email text)`: the set-based serialized sibling of `transfer_stock`, behind `db.inventory.transferUnits()` (returns how many units actually moved). One transaction, one `stock_moves` row per unit that moves, a unit already at the destination a no-op; refuses reserved units and system/archived destinations **in its own body**, because `SECURITY DEFINER` skips the `20260831` guard; `rma_is_manager_or_above()`, actor from the JWT, standard EXECUTE lockdown. `mark_batch_sent`/`mark_batch_resolved` now ledger their unit status changes under the new `stock_moves.doc_type` value `manufacturer_batch` (resolution semantics unchanged by owner's decision — every unit still closes). Dead `resolveUnits` removed. Pinned by `src/test/transferLedger.test.js` (in CI); `supabase/tests/transfer_units_ledger.sql` is a reference script run against production in a rolled-back transaction — **not** in CI, because `db-tests` is disabled.

BUG-087 role guards (2026-09-16):

- `20260867_role_guards_fail_closed.sql` — `rma_is_staff`/`rma_is_admin`/`rma_is_manager_or_above`/`rma_can_handle_cash` return `COALESCE(…, false)`; the seven guards that compare `rma_user_role()` directly (`cancel_sales_order`, `convert_quotation_to_so`, `crm_convert_lead`, `adjust_part_quantity`, `create_manufacturer_batch`, `link_serial_to_rma_ticket`, `move_rma_units`) are wrapped in COALESCE by rewriting only the guard text in their live definitions. Refuses to apply if any RLS policy negates a helper, and to finish if a role-less caller gets anything but false or any unwrapped direct role guard remains. Pinned by `src/test/roleGuardsFailClosed.test.js` (in CI); `supabase/tests/role_guards_fail_closed.sql` is a reference script — **not** in CI, because `db-tests` is disabled. Its seeded accounts are suspended on production, so running it there needs live-active accounts substituted.

BUG-014 ledger check (2026-09-16):

- `20260868_applied_migration_versions.sql` — `rma_applied_migration_versions()` returns `text[]` of applied versions for the CI drift check; a deliberate, named anon-executable exception to `20260841`'s default (refuses to finish if the grant did not take). See the `Migration drift` workflow under CI/CD.

Security invariants in CI (2026-09-16):

- `20260869_security_invariant_counts.sql` — `rma_security_invariant_counts()` returns counts only (`unwrapped_role_guards`, `helpers_without_coalesce`, `policies_negating_helpers`, `anon_executable_functions`), executable by anon so the integration tier can read them from production. `tests/integration/security-invariants.test.ts` requires the first three to be 0 and the last to equal `EXPECTED_ANON_EXECUTABLE` (2: this function and `rma_applied_migration_versions`) — **adding an anon-executable function means updating that constant and its list in the same PR**. This is the production-side regression check for BUG-087; the SQL test files cannot provide it because `db-tests` is disabled.

Sessions end on loss of access (2026-09-16):

- `20260870_revoke_sessions_on_access_loss.sql` — trigger `trg_user_roles_end_sessions_on_access_loss` (AFTER UPDATE OF status/access_expires_at/user_email OR DELETE on `user_roles`) deletes the user's `auth.sessions` in the same transaction for `suspended`/`locked`/`deactivated`, a past expiry, an email change or deletion — **never for `pending`** (invitees sign in while pending). pg_cron `end-sessions-without-access` (every 15 min) sweeps users with a role row whose access is no longer current. Internal functions `rma_end_sessions_for_email` / `rma_end_sessions_without_access` have no auth check and are **not** client-executable. `users.updateUserStatus()` no longer revokes from the browser.

Parts used on a ticket (2026-09-17, BUG-030):

- `20260871_ticket_parts_atomic.sql` — `rma_ticket_part_add(ticket, part, quantity, unit_cost?, notes?)` (staff except viewer) and `rma_ticket_part_remove(id)` (admin) change stock through `adjust_part_quantity` and write `ticket_parts` in one transaction, behind `db.ticketParts.add()` / `remove(id)`. `ticket_parts` is **read-only to client roles** — no INSERT/UPDATE/DELETE grant, no write policy — so any new write must go through these functions. Pinned by `src/test/ticketPartsAtomic.test.js`; `supabase/tests/ticket_parts_atomic.sql` is the rolled-back reference probe (13/13).

Vendor payments procedure-only (2026-09-17, BUG-073 follow-up):

- `20260872_vendor_payments_procedure_only.sql` — `vendor_payments` joins the tables `20260850` made procedure-only (`payments`, the three application tables, `warehouse_stock`): no client INSERT/UPDATE/DELETE/TRUNCATE, no write policy, reads unchanged. Write only through `record_vendor_payment` / `void_vendor_payment` / the application RPCs. Pinned by `src/test/moneyTablesProcedureOnly.test.js`.

Authenticated-role probes (2026-09-16, BUG-061):

- `supabase/tests/authenticated_role_probes.sql` — reference script, **not CI**: reproduces a signed-in call without a password (sets PostgREST's JWT claims + `SET LOCAL ROLE authenticated`) for one active account per role, checks the BUG-001/002/004/010/011/034/087 loopholes are refused and the legitimate action beside each still works, then forces a rollback. Run it by hand after any change to RLS, grants or guard triggers; last run 28/28 (2026-09-17).

**Warehouse Module R1 runtime model:** ticket `product_status` (Received/Under Repair/Repaired/Can't Repair/Replacement/Credit Note) auto-maps to a system location on every ticket save (create/edit/bulk) — **Replacement AND Credit Note both → RMA-STOCK** (ticket status is intent; the real onward move is an R2 item). The client half is pure `buildRmaMoves()` in `src/lib/rmaStageMoves.ts` (serial-first/name-fallback pairing, skips ambiguous matches, 10 Vitest cases) → `move_rma_units`; the RPC's idempotency means the client never needs each unit's current location. **Sellable = warehouse_type `main`/`branch` OR legacy `NULL` type** (never made more restrictive than pre-model). "Main" column = main/legacy-NULL company_stock; "Branches" = per-`branch` breakdown; "RMA" = per-system-location active_rma counts; "Physical Total" = sellable + RMA locations, **excluding SCRAP + closed**. Non-catalog RMA units (`product_id NULL`) surface as synthetic `in_catalog:false` dashboard rows. **BUILT + gate-green at build time (287/287 tests, `inventory_hardening3.sql` 12 checks, 0 lint errors, build ✓). Migrations `20260764`–`20260767` applied + SQL-verified 2026-08-04; manual click-through QA still pending** (see `docs/archive/WAREHOUSE_R1_TEST_CHECKLIST.md`). **R2 (deferred):** server-side sellable-location guard in `reserve_units` (currently display-only — it still counts all company_stock regardless of location), document-driven onward moves (CN issue → CN location, replacement shipment), (the unledgered `transferUnits` path was consolidated on 2026-09-16 — see `20260866` above).

**The "who" convention for CRM tables:** `assigned_rep` and `created_by` are `text` columns holding the user's **email**, NOT `uuid REFERENCES auth.users`. This was a repeated source of "Invalid uuid" bugs — Zod schemas must validate these as email/string, never `.uuid()`.

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

**These helpers return false — never NULL — for a caller with no current role** (suspended, expired, or an auth account with no `user_roles` row), since `20260867` (BUG-087). Before that they passed `rma_user_role()`'s NULL on, and while an RLS policy treats NULL as "no", **a plpgsql `IF NOT helper() THEN RAISE` is an `IF` on NULL that does not fire** — every such guard let the caller through (measured live: a role-less caller got the whole manager-only `rma_staff_directory()`). Two rules follow. **(1) Any new or re-declared helper must keep its `COALESCE(…, false)`**; `src/test/roleGuardsFailClosed.test.js` fails CI otherwise. **(2) `rma_user_role()` still returns NULL**, so a guard that compares it directly — `IF NOT (rma_is_manager_or_above() OR rma_user_role() = 'sales_rep')` — must be wrapped as `IF NOT COALESCE(…, false) THEN`; the helper fix cannot reach it, and CI fails on a bare one. Never give `rma_user_role()` a sentinel return instead: `'' <> 'viewer'` is TRUE, which would widen every policy written that way.

### Shared component library

All UI primitives come from `src/components/ui.jsx`. Never re-implement buttons, inputs, modals, badges, or spinners in page components. Key exports: `Button` (variants: primary, secondary, danger, success, ghost, warning), `Spinner` (has built-in `role="status"` and `aria-label="Loading"`), `Badge`, `Card` (flat hairline, no shadow), `Input`, `Select`, `Textarea`, `Label`, `PageHeader`, `SectionTitle`, `Divider`, `IconButton`, `ModalOverlay`, `ModalCard`, `StatusPill` (dot + label pill, colored by status string — uses its own internal color map, no props beyond `status` and optional `className`).

### CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs on push to `main` **and `test`**, plus every PR (audit HIGH-1 fix — it previously ran on `main` only, which the team never pushes to, so CI effectively never ran). Three jobs, of which two actually run:

- **`ci`** — `test → lint:ci → typecheck → lint:ui (report only) → build`. Node 20, `npm ci` (`--legacy-peer-deps` is set in `.npmrc`).
- **`integration`** — `npm run test:integration` against the **hosted production project**, read-only, **Node 22** (supabase-js needs a built-in WebSocket; on Node 20 every test crashed before running). Uses the `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` repository secrets (added 2026-09-16 — before that the tier had silently skipped since it was written). Covers anon RLS refusals, anon RPC refusals, the columns the app selects, and `security-invariants.test.ts`.
- **`db-tests`** (audit HIGH-3) — **DISABLED (`if: false`) since 2026-08-07 and not coming back** (the Base44-created schema can't be rebuilt without a baseline, and Docker is ruled out), so none of the SQL files below run in CI; they are reference scripts, run against production inside a rolled-back transaction when needed. Where the rest of this file says a `supabase/tests/*.sql` file is "in CI", read it as this. As originally designed, it installs the Supabase CLI, runs `supabase start` (spins up a real local Postgres and applies every migration in `supabase/migrations/` from scratch — this doubles as an ongoing regression check that the full migration history still applies cleanly, generalizing the exact failure class behind CRIT-4), then runs four SQL test files (plus `vendor_payments.sql`) via `psql -v ON_ERROR_STOP=1`, all `RAISE EXCEPTION`ing with the specific failing check if any assertion breaks:
  - `supabase/tests/audit_hardening.sql` — CRIT-1/2/3/5 + HIGH-2 invariants (role guard, allocation validation, server-derived actor, payment/CN reversal, atomic apply).
  - `supabase/tests/inventory_hardening.sql` — reserve/deliver/release conservation for both serialized (`inventory_units`) and bulk (`warehouse_stock`) stock, over-reservation rejection, duplicate-serial rejection, and idempotency of `release_warehouse_stock`/`deliver_warehouse_stock` under a duplicate call — the exact property `20260741_warehouse_stock_reservation_rpcs.sql`'s own header comment flags as needing explicit verification, not assumption.
  - `supabase/tests/inventory_hardening2.sql` — `transfer_stock` (both modes + reserved-unit and insufficient-stock guards), `adjust_stock` (both modes + negative-quantity guard), `recalculate_stock` (drift reconciliation), `restore_units`/`restore_warehouse_stock`, `receive_vendor_invoice` (both modes, partial-then-complete receipt, duplicate-serial rejection). Found and fixed a real bug while writing this file — see `20260755_fix_restore_units_status_conflation.sql` above.
  - `supabase/tests/inventory_hardening3.sql` (Warehouse Module R1) — 12 checks: 8 system locations seeded; `move_rma_units` happy path + ledger shape + idempotent repeat (0 new rows) + unit-not-on-ticket/company_stock-unit/bad-code rejections; `promote_rma_unit` happy path into a legacy NULL-type warehouse + reserved-unit/is_system-destination rejections; protection trigger blocks a system-row rename + `archive_warehouse` on a system row; and a global invariant that no active_rma unit on a non-cancelled ticket is left unplaced.

- **`Migration drift`** (`.github/workflows/migration-drift.yml`, BUG-014) — separate workflow on push to `main`, daily and on demand, **not** on PRs. `scripts/migration-drift.mjs` reads production's applied versions through `rma_applied_migration_versions()` (20260868, anon-executable, returns one `text[]`) with the existing `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` secrets and fails on a file with no ledger row, a ledger row with no file, or two files sharing a version. **`apply_migration` (dashboard/MCP) records a generated timestamp, not the file's version — after every apply, update that row's `version` to the file prefix, or this workflow goes red on the next push to `main`.** It compares the ledger with the files; it is not `supabase db diff` and cannot see a change made in the SQL editor outside a migration.

  No Supabase account/secrets needed — `supabase start` is purely local. Run the same suite locally with `npm run test:db` (requires Docker + `psql`).
