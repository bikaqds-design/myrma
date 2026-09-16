# Phase 0 — Discovery and Inventory

Date: 2026-09-02 · Commit at time of audit: `2d8c17d` · App version: myCRM

Everything below was measured against the repo and the running app. Where a number
is a count, the command that produced it is reproducible with `git grep`.

---

## 1. Corrections to the brief

The brief asked to be corrected where it is wrong about the code.

| Brief says | Reality |
|---|---|
| "Node.js services" | There are none. The backend is Supabase Postgres + **11 Deno Edge Functions** (`supabase/functions/`). No Node service exists. |
| Core modules: Sales Funnel, RMA, Inventory, Approvals, Purchases | Understated. There are also **Accounting, Sales Documents, Leads, Pipeline, Activities, Products, Customers, Reports, Calendar, Knowledge Center** and a Control Panel with ~12 sub-tabs. Approvals is **not** a module — it is a surface inside Activities/Dashboard. |
| — | `CLAUDE.md` is stale and will mislead: it documents a Base44 platform, `base44.entities.*`, and a `hasPermission(module, action)` API from `src/components/common/PermissionContext.jsx`. **None of these exist.** The real permission API is `canDo(...)` from `src/lib/permissions.ts` (113 call sites). |

---

## 2. Route map

29 `<Route>` declarations in `src/App.jsx`, plus 3 routes handled by early return
*before* the router.

### Pre-router routes (no app shell)

| Path | Component | Auth | Notes |
|---|---|---|---|
| `/tracker` | `RMATracker.jsx` | none | Public customer-facing RMA lookup |
| `/kb` | `KnowledgeBasePublic.jsx` | none | Public knowledge base |
| `/set-password` | `ResetPassword.jsx` | session required | Invitation password screen |

### Router routes

| Path | Module | Component |
|---|---|---|
| `/` , `/dashboard` | Dashboard | `Dashboard.jsx` |
| `/products` , `/products/:id` | Products | `Products/`, `ProductDetails.jsx` |
| `/customers` , `/customers/:id` | Customers | `Customers/`, `CustomerDetails.jsx` |
| `/leads` , `/leads/:id` | Sales Funnel | `Leads/` |
| `/pipeline` , `/pipeline/:id` | Sales Funnel | `Pipeline/` |
| `/activities` | Activities | `Activities/` |
| `/sales` , `/sales/:type/:id` | Sales Documents | `SalesDocuments/` |
| `/accounting` | Accounting | `Accounting/` |
| `/purchasing` , `/purchasing/vendor/:id` , `/purchasing/:type/:id` | Purchases | `Purchasing/` |
| `/rma-tickets` | RMA | `RMATickets/` |
| `/inventory` | Inventory | `Inventory/` |
| `/calendar` | Calendar | `TechCalendar.jsx` |
| `/reports` | Reports | `Reports.jsx` |
| `/knowledge-center` | Knowledge | `KnowledgeCenter.jsx` |
| `/account` | Settings | `AccountSettings.jsx` |
| `/control-panel` | Admin | `ControlPanel.jsx` (hosts UserManagement, BrandingSettings, cp/*) |
| `*` | — | `NotFoundPage.jsx` |

**Orphans / dead code found:**

- `src/components/ui/Form/` and `src/components/ui/Table/` — **two empty directories**, untracked by git. Imports resolve to `src/components/ui.jsx` instead. Dead scaffolding.
- `/UserManagement` and `/ControlPanel` are **not routes** — user management lives inside `/control-panel`. Guessing the obvious URL 404s.

---

## 3. Styling reality

One paradigm, consistently: **Tailwind utility classes**. No CSS modules, no
styled-components, no UI kit dependency.

| | count |
|---|---|
| `className=` usages | 6,964 |
| inline `style={{...}}` | 222 across 20 files |
| `.css` files | 4 (`index.css`, `tokens.css`, `rtl.css`, `appearance.css`) |
| CSS modules / styled-components | 0 |

That is good news: there is no paradigm war to resolve. The problem is not
*which* system, it is that the system is bypassed.

### The design system exists — and is half-ignored

`src/components/ui.jsx` (303 lines) exports 17 primitives and is imported by
**66 files**: `Badge, Button, Card, Divider, IconButton, Input, Label, Ltr,
ModalCard, ModalOverlay, PageHeader, PageLoading, SectionTitle, Select, Spinner,
StatusPill, Textarea`.

Adoption, measured as kit component vs raw HTML element:

| Primitive | Kit used | Hand-rolled | Adoption |
|---|---:|---:|---:|
| Button | 173 | 127 | **57%** |
| Input | 43 | 61 | **41%** |
| Textarea | 9 | 13 | **40%** |
| Select | 22 | 53 | **29%** |

**Table has no primitive at all.** 72 raw `<table>` elements across 50 files,
64 hand-written `<thead>`. The empty `ui/Table/` directory suggests one was
intended and never built.

### Modal implementations

16 files define modal markup. The kit offers `ModalOverlay` + `ModalCard`, plus
a standalone `src/components/Modal.jsx`, and each module carries its own
`_modals.jsx` (Accounting, Customers, Leads, Pipeline, Products, Purchasing,
SalesDocuments) plus 7 bespoke Inventory modals.

### Toasts

`react-hot-toast` in 79 files. 8 `<Toaster>` mounts — **all in `App.jsx` on
mutually exclusive early-return branches**, so only one renders at a time. This
is *not* a duplicate-mount bug. However the main app-shell Toaster (line 1175)
is the only one without `toastOptions`, so toasts inside the app look different
from toasts on the auth/tracker screens. All 8 hardcode `position="top-right"`
irrespective of direction.

---

## 4. De-facto design tokens

`src/styles/tokens.css` declares **52 custom properties**. Application code
largely ignores them.

| Measured in `src/` | Distinct values |
|---|---:|
| Hardcoded hex colours | **125** |
| Tailwind arbitrary values `[...]` | **5,648 uses** |
| `text-*` sizes | 10 |
| `rounded-*` | 12 |
| `shadow-*` | 6 |
| `z-*` | 10 |

Most-repeated hardcoded colours (top 6 of 125):

| Hex | Occurrences |
|---|---:|
| `#9aa4b2` | 1,000 |
| `#212a38` | 661 |
| `#e8ebf0` | 610 |
| `#6c6760` | 447 |
| `#e6e9ef` | 435 |
| `#121823` | 291 |

**Z-index has no ladder.** Two schemes coexist: the Tailwind scale
(`z-10 … z-50`) and arbitrary escapes (`z-[60]`, `z-[70]`, `z-[200]`, `z-[400]`,
`z-[500]`). Stacking conflicts are decided by whoever picked the bigger number.

---

## 5. State coverage

Across **115 page component files** under `src/pages`:

| State | Files with it | % |
|---|---:|---:|
| Loading of any kind | 67 | 58% |
| — of which a skeleton | 15 | 13% |
| — of which a `<Spinner>` | 24 | 21% |
| Error branch | 69 | 60% |
| **Empty state** | **14** | **12%** |
| Permission gate (`canDo`) | 20 files, 113 call sites | — |

**Error handling leaks the database to users.** 40 call sites pass a raw error
straight to a toast (`toast.error(err.message)`), e.g.
`src/components/CommentPanel.jsx:96,125,151`, `src/components/ProductDocuments.jsx:92,122`.
Any Postgres constraint name or RLS message reaches the user verbatim.

---

## 6. RTL and i18n

Translation coverage is genuinely good; **CSS direction handling is not**.

| | count |
|---|---:|
| Keys in `en.json` | 4,001 |
| Keys in `ar.json` | 4,041 (**40 more than English — orphans or structural drift**) |
| `.jsx` files calling `t()` | 124 of 146 |

Direction is applied correctly at the root: `AppearanceContext.jsx:119` sets
`html[dir]` from the language. Verified live — the Arabic dashboard mirrors
properly.

**But the CSS underneath is physical, not logical:**

| Physical | count | Logical equivalent | count |
|---|---:|---|---:|
| `text-left` / `text-right` | **378** | `text-start` / `text-end` | **8** |
| `ml-*` / `mr-*` | 103 | `ms-*` / `me-*` | 16 |
| `pl-*` / `pr-*` | 76 | `ps-*` / `pe-*` | (in the 16 above) |
| `left-*` / `right-*` | 85 | `start-*` / `end-*` | 5 |

`src/styles/rtl.css` is 48 lines of `!important` sidebar patches compensating
for this by hand.

**Bidi isolation exists and is unused.** `ui.jsx` exports an `Ltr` component
whose own comment records that this bug was found in manual QA on 2026-08-05
(`docs/archive/WAREHOUSE_R1_TEST_CHECKLIST.md §E`). It is used **6 times** in the entire
codebase; `unicodeBidi` appears once. Consequences are visible in the captured
screenshots (see `01-AUDIT.md` UX-GLOBAL-003).

---

## 7. Largest components

| File | Lines |
|---|---:|
| `src/pages/Reports.jsx` | 1,976 |
| `src/pages/CustomerDetails.jsx` | 1,914 |
| `src/pages/RMATickets/index.jsx` | 1,779 |
| `src/pages/Customers/index.jsx` | 1,572 |
| `src/pages/RMATickets/TicketDrawer.jsx` | 1,545 |
| `src/pages/RMATickets/TicketForm.jsx` | 1,501 |
| `src/App.jsx` | 1,829 |

---

## 8. Screenshots captured

Tooling: Playwright 1.62.1 + Chromium, installed this session. Reusable script
at `design/audit/capture-screens.mjs`.

Captured to `design/audit/screens/`:

| Route | en desktop | ar desktop | en mobile |
|---|:--:|:--:|:--:|
| `/` (Login, unauthenticated) | ✅ | ✅ | ✅ |
| `/tracker` | ✅ | ✅ | ✅ |
| `/kb` | ✅ | ✅ | ✅ |

`dir` attribute verified per capture: `ltr` for `en`, `rtl` for `ar`. Zero page
errors on all 9.

### Authenticated capture — completed

Approach ND-1(a), approved. Five disposable fixtures were created via the app's
own admin API (`zz-audit-<role>@qdsegypt.com`, roles admin / manager /
technician / sales_rep / viewer), used only by the capture script, and **deleted
immediately afterwards** — deletion verified against `auth.users` and
`user_roles`. Passwords were generated for the run; no credential of yours was
used or handled. Sign-in was performed headlessly through the Supabase client
and the session injected into the browser, so the capture never types into the
login form.

**60 authenticated screenshots** captured, 0 page errors, 0 failed navigations.
Machine-readable results in `design/audit/capture-log.json`.

| Role | Routes | Matrix |
|---|---|---|
| admin | all 16 | en desktop, ar desktop, en mobile |
| manager, technician, sales_rep, viewer | `/`, `/purchasing`, `/control-panel` | en desktop |

Nav filtering verified per role: admin 15 items, manager 14, sales_rep 8,
technician 7, viewer 7.

### Still not captured

- The ~12 Control Panel sub-tabs (each needs interaction, not just navigation).
- All `:id` detail routes — they need deliberately chosen seed records rather
  than whatever happens to be in production.
- RTL and mobile for the four non-admin roles; only the admin matrix is complete
  in all three viewports.
