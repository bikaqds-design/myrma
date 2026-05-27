# myRMA Engineering Constitution

> **Version:** 2.0 — May 2026  
> **Authority:** This document is the single source of truth for all engineering decisions in myRMA.  
> **Scope:** All contributors, developers, and AI coding agents working on this codebase.  
> **Enforcement:** Rules marked **LAW** are non-negotiable. Rules marked **MUST** require justification to override. Rules marked **SHOULD** are strong defaults.

---

## Table of Contents

1. [Core Engineering Philosophy](#1-core-engineering-philosophy)
2. [Frontend Architecture Rules](#2-frontend-architecture-rules)
3. [Component Standards](#3-component-standards)
4. [Tailwind CSS Rules](#4-tailwind-css-rules)
5. [UI/UX Standards](#5-uiux-standards)
6. [State Management Rules](#6-state-management-rules)
7. [Backend & Supabase Rules](#7-backend--supabase-rules)
8. [Security Rules](#8-security-rules)
9. [Performance Standards](#9-performance-standards)
10. [Accessibility Standards](#10-accessibility-standards)
11. [Responsive Design Rules](#11-responsive-design-rules)
12. [Naming Conventions](#12-naming-conventions)
13. [File & Folder Structure](#13-file--folder-structure)
14. [Code Quality Rules](#14-code-quality-rules)
15. [Testing Standards](#15-testing-standards)
16. [Git & Deployment Standards](#16-git--deployment-standards)
17. [AI Agent Rules](#17-ai-agent-rules)
18. [Final Enforcement Rules](#18-final-enforcement-rules)

---

## 1. Core Engineering Philosophy

### 1.1 Guiding Principles

myRMA is an **enterprise-grade RMA management system** used by real businesses to manage product returns, inventory, customer relationships, and service workflows. Every engineering decision must be evaluated against these principles:

1. **Correctness over cleverness** — A boring, correct solution beats an elegant, broken one.
2. **Explicit over implicit** — Configuration, permissions, and data flow must be readable at a glance.
3. **Stable over trendy** — Only adopt new technology if it solves a problem the current stack cannot.
4. **Data integrity first** — Business data (tickets, inventory, customers) is the product. Never risk it.
5. **Security by default** — Every endpoint, every query, every upload is hostile until proven safe.
6. **User trust above all** — The UI must be honest about what is happening. No silent failures, no deceptive loading states, no optimistic lies that aren't rolled back.

### 1.2 What This System Is

- A **B2B SaaS web application** used by warehouse staff, managers, and admins
- A **data-heavy, operations-focused UI** — not a marketing site, not a consumer app
- A **role-gated system** where data visibility and write access differ by role
- A **multi-tenant-ready platform** where a company's data must be isolated from others

### 1.3 What This System Is Not

- A consumer social app (infinite scroll, likes, feeds)
- A real-time game requiring sub-100ms latency
- A machine learning pipeline
- A microservices platform — it is a well-structured monolith

### 1.4 Decision-Making Framework

When making any engineering decision, ask in order:

1. **Does it violate a LAW?** → Stop. Do not proceed.
2. **Does it match an existing pattern in the codebase?** → Follow the pattern.
3. **Does it have a clear precedent in this constitution?** → Follow the constitution.
4. **Has it been tested against the real app?** → If not, write a test or verify manually before shipping.
5. **Is it reversible?** → Prefer reversible changes. Document irreversible ones.

---

## 2. Frontend Architecture Rules

### 2.1 Technology Stack (LOCKED)

| Layer | Technology | Version | Notes |
|-------|-----------|---------|-------|
| UI Framework | React | 18.x | Hooks only; no class components |
| Build Tool | Vite | 6.x | Dev on port 5173 |
| Routing | React Router | v6.x | `BrowserRouter` in `main.jsx` |
| Data Fetching | TanStack Query | v5.x | `QueryClientProvider` in `main.jsx` |
| Styling | Tailwind CSS | v3.x | Utility-first; no CSS-in-JS |
| Database | Supabase | Latest | PostgreSQL backend |
| Auth | Supabase Auth | Latest | JWT tokens, RLS enforced |
| Storage | Supabase Storage | Latest | `rma-attachments` bucket |
| Error Tracking | Sentry | Latest | Wired into `ErrorBoundary` |
| Testing | Vitest | Latest | Unit tests in `src/lib/` |
| Linting | ESLint 9 (flat config) | 9.x | Zero errors target |
| Formatting | Prettier | Latest | Enforced on CI |
| PWA | vite-plugin-pwa | Latest | Workbox generateSW |
| Virtualization | @tanstack/react-virtual | v3.x | For un-paginated lists |

**LAW: Do not add new framework-level dependencies without explicit team approval and a written rationale in the PR description.**

### 2.2 React Rules

**LAW: All components MUST be functional components using hooks. No class components.**

```jsx
// ✅ CORRECT
function TicketRow({ ticket, onEdit }) {
  const [expanded, setExpanded] = useState(false)
  return (...)
}

// ❌ FORBIDDEN
class TicketRow extends React.Component {
  render() { return (...) }
}
```

**MUST: Avoid `useEffect` for data fetching.** Use TanStack Query's `useQuery` instead.

```jsx
// ✅ CORRECT
const { data: tickets, isLoading } = useQuery({
  queryKey: ['tickets', filters],
  queryFn: () => db.rmaTickets.list(filters),
  staleTime: 60_000,
})

// ❌ WRONG
useEffect(() => {
  db.rmaTickets.list(filters).then(setTickets)
}, [filters])
```

**MUST: Use `React.lazy` for all top-level page components.**

```jsx
const Dashboard = React.lazy(() => import('./pages/Dashboard.jsx'))
const Products = React.lazy(() => import('./pages/Products.jsx'))
```

**SHOULD: Wrap `React.lazy` pages in `<Suspense fallback={<Spinner size="xl" />}>` at the route level.**

### 2.3 React Router v6 Rules

**LAW: All navigation uses React Router v6. `window.history.pushState` is forbidden for top-level navigation.**

The app uses `BrowserRouter` declared in `src/main.jsx`. All route definitions live in `src/App.jsx`.

```jsx
// ✅ CORRECT — navigation
const navigate = useNavigate()
navigate('/rma-tickets')
navigate(-1) // back

// ❌ FORBIDDEN — top-level navigation
window.location.href = '/rma-tickets'
window.history.pushState({}, '', '/rma-tickets')
```

**Exception:** `window.history.pushState` is permitted ONLY for within-route URL state (e.g., `?ticket=<id>` in `RMATickets.jsx` to sync the open ticket modal without triggering a full route transition). This exception MUST be documented in a code comment.

**MUST: Use thin route wrapper components for parameterized routes** to avoid modifying page components.

```jsx
// ✅ CORRECT — thin wrapper absorbs useParams
function ProductDetailsRoute({ currentUserRole, currentUserEmail, currentUserPermissions, onNavigateToTicket }) {
  const { id } = useParams()
  const navigate = useNavigate()
  return (
    <ProductDetails
      productId={id}
      currentUserRole={currentUserRole}
      currentUserEmail={currentUserEmail}
      currentUserPermissions={currentUserPermissions}
      onBack={() => navigate('/products')}
      onNavigateToTicket={onNavigateToTicket}
    />
  )
}

// Route declaration
<Route path="/products/:id" element={<ProductDetailsRoute ... />} />
```

**MUST: Include a catch-all `*` route** that renders a `NotFoundPage` component showing the attempted path and a back-to-dashboard link.

**MUST: All route declarations live in `src/App.jsx`** inside a single `<Routes>` block. No nested `<Routes>` in page components unless absolutely required with clear documentation.

### 2.4 Application Entry Point

The application wraps in this exact order in `src/main.jsx`:

```jsx
<React.StrictMode>
  <ErrorBoundary>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <AppearanceProvider>
          <App />
        </AppearanceProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </ErrorBoundary>
</React.StrictMode>
```

**LAW: This wrapper order is fixed.** New providers are inserted inside `AppearanceProvider`. Never wrap outside `ErrorBoundary`.

### 2.5 Environment Variables

**LAW: All environment variables used in the browser MUST be prefixed with `VITE_`.**

```
VITE_SUPABASE_URL=https://...
VITE_SUPABASE_ANON_KEY=eyJ...
```

**LAW: Never hard-code Supabase credentials in source code.** Always read from `import.meta.env.VITE_*`.

---

## 3. Component Standards

### 3.1 Shared Component Library

**LAW: All UI primitives MUST come from `src/components/ui.jsx`. Do not re-implement buttons, inputs, modals, badges, or spinners in page components.**

The library exports:

| Component | Variants / Props | Use Case |
|-----------|-----------------|----------|
| `Button` | variants: `primary`, `secondary`, `danger`, `success`, `ghost`, `warning`; sizes: `sm`, `md`, `lg` | All clickable actions |
| `Spinner` | sizes: `sm`, `md`, `lg`, `xl`; colors: `indigo`, `white`, `gray` | Loading states |
| `Badge` | 13 color variants | Status labels, tags |
| `Card` | — | Content containers |
| `Input` | — | Text inputs |
| `Select` | — | Dropdown selects |
| `Textarea` | — | Multi-line inputs |
| `Label` | — | Form labels |
| `PageHeader` | — | Page-level headings |
| `SectionTitle` | — | Section headings |
| `Divider` | — | Horizontal rules |
| `IconButton` | — | Icon-only actions |
| `ModalOverlay` | — | Modal backdrop |
| `ModalCard` | — | Modal container |

```jsx
// ✅ CORRECT
import { Button, Spinner, Badge, ModalOverlay, ModalCard } from '../components/ui.jsx'

// ❌ FORBIDDEN
<button className="bg-indigo-600 text-white px-4 py-2 rounded">Submit</button>
// (unless inside a one-off component not meant for reuse)
```

### 3.2 Button Rules

**MUST: Every `<Button>` must have an explicit `variant` prop.**

```jsx
// ✅ CORRECT
<Button variant="primary" onClick={handleSubmit}>Save Changes</Button>
<Button variant="danger" onClick={handleDelete}>Delete</Button>
<Button variant="ghost" onClick={handleCancel}>Cancel</Button>

// ❌ WRONG — missing variant
<Button onClick={handleSubmit}>Save Changes</Button>
```

**Variant semantics:**
- `primary` — Main CTA (save, submit, create)
- `secondary` — Supporting actions (edit, export, view)
- `danger` — Destructive actions (delete, archive, revoke)
- `success` — Completion/approval actions
- `ghost` — Low-emphasis actions (cancel, dismiss)
- `warning` — High-risk but non-destructive actions

### 3.3 Modal Rules

**MUST: All modals use `ModalOverlay` + `ModalCard` from `ui.jsx`.** Never use custom `div` overlays with `position: fixed`.

**MUST: Modals must trap focus** — no keyboard escape to unfocused elements behind the overlay.

**MUST: All modals have a visible close action** (× button or explicit Cancel button).

**SHOULD: Destructive confirmation modals must show the affected item name** in the confirmation text:

```jsx
// ✅ CORRECT
<p>Delete ticket <strong>{ticket.rma_number}</strong>? This cannot be undone.</p>

// ❌ VAGUE
<p>Are you sure you want to delete this item?</p>
```

### 3.4 Form Rules

**MUST: All form inputs use controlled components** with explicit `value` and `onChange`.

**MUST: All forms show inline validation errors** below the relevant field, not just a toast.

**MUST: Submit buttons show a `<Spinner>` while the async operation is pending** and are `disabled` to prevent double-submit.

```jsx
<Button variant="primary" onClick={handleSubmit} disabled={isSubmitting}>
  {isSubmitting ? <Spinner size="sm" color="white" /> : 'Save Changes'}
</Button>
```

**MUST: CSV bulk upload uses the custom `parseCSVLine` helper** defined locally in `Products.jsx` and `Customers.jsx`. Do not use `line.split(',')` — product names can contain commas inside quoted fields.

### 3.5 Table Rules

**MUST: All data tables show a loading skeleton or `<Spinner>` while data is loading.**

**MUST: All data tables show a meaningful empty state** (not just a blank white area):

```jsx
{tickets.length === 0 && (
  <div className="text-center py-12 text-gray-500 dark:text-gray-400">
    <p className="text-lg font-medium">No tickets found</p>
    <p className="text-sm mt-1">Try adjusting your filters or create a new ticket.</p>
  </div>
)}
```

**SHOULD: Long tables (> 50 rows) use pagination or virtualization** — see Section 9.

### 3.6 Error Boundary

`src/components/ErrorBoundary.jsx` wraps the entire app in `main.jsx`. It:
- Catches unhandled render errors
- Calls `captureException()` to send to Sentry
- Shows a recovery UI with a "Reload" button

**MUST: Never suppress errors silently in render.** Let the ErrorBoundary catch them.

**LAW: Do not remove or bypass the ErrorBoundary wrapping in `main.jsx`.**

---

## 4. Tailwind CSS Rules

### 4.1 Core Tailwind Principles

**LAW: Use Tailwind utility classes for all styling. No external CSS files, no CSS modules, no CSS-in-JS.**

**MUST: Never write raw `<style>` blocks in components** unless for third-party library overrides that Tailwind cannot handle.

### 4.2 Spacing Scale

Use Tailwind's 4px base unit consistently:

| Token | px | Use case |
|-------|-----|---------|
| `p-1` | 4px | Icon internal padding |
| `p-2` | 8px | Compact UI elements |
| `p-3` | 12px | Small cards, tight lists |
| `p-4` | 16px | Standard padding |
| `p-6` | 24px | Card sections |
| `p-8` | 32px | Page-level padding |
| `gap-2` | 8px | Button groups, tight rows |
| `gap-4` | 16px | Standard grid gaps |
| `gap-6` | 24px | Section spacing |

**SHOULD: Use `space-y-*` and `space-x-*` for consistent list/stack spacing** rather than per-item margin.

### 4.3 Typography Scale

```
text-xs     — 12px — Secondary labels, metadata
text-sm     — 14px — Table data, form labels, secondary text
text-base   — 16px — Body text (default)
text-lg     — 18px — Section headers
text-xl     — 20px — Sub-page titles
text-2xl    — 24px — Page titles
text-3xl+   — 30px+ — Reserved for dashboard KPI numbers
```

**MUST: Page titles use `text-2xl font-bold`.**  
**MUST: Section titles use `text-lg font-semibold`.**  
**MUST: Table column headers use `text-xs font-semibold uppercase tracking-wider`.**

### 4.4 Dark Mode

**MUST: Every component MUST support dark mode** using Tailwind's `dark:` prefix.

The dark mode class is applied to `<html>` by `AppearanceContext`. Access via `useAppearance()`.

```jsx
// ✅ CORRECT — explicit dark mode classes
<div className="bg-white dark:bg-gray-800 text-gray-900 dark:text-white">

// ❌ WRONG — no dark mode support
<div className="bg-white text-gray-900">
```

**MUST: Use semantic color pairs** consistently:

| Light | Dark | Use |
|-------|------|-----|
| `bg-white` | `dark:bg-gray-800` | Card backgrounds |
| `bg-gray-50` | `dark:bg-gray-900` | Page backgrounds |
| `bg-gray-100` | `dark:bg-gray-700` | Input backgrounds |
| `text-gray-900` | `dark:text-white` | Primary text |
| `text-gray-600` | `dark:text-gray-400` | Secondary text |
| `text-gray-500` | `dark:text-gray-500` | Placeholder, metadata |
| `border-gray-200` | `dark:border-gray-700` | Dividers, borders |

### 4.5 Color Usage

**MUST: Use semantic role colors** for status badges and actions:

```
indigo   — Primary actions, navigation highlights
green    — Success, completed, in-stock
yellow   — Warning, pending, low-stock
red      — Error, danger, destructive, out-of-stock
blue     — Informational, in-progress
gray     — Inactive, disabled, archived
purple   — Special status (escalated, VIP)
```

**MUST: Never use hard-coded hex colors** in className strings. All colors through Tailwind palette names.

### 4.6 Forbidden Anti-Patterns

```jsx
// ❌ FORBIDDEN — inline styles
<div style={{ color: '#333', marginTop: '16px' }}>

// ❌ FORBIDDEN — arbitrary Tailwind values without justification
<div className="w-[347px] mt-[13px]">

// ❌ FORBIDDEN — CSS files for component styles
import './MyComponent.css'

// ❌ FORBIDDEN — overriding Tailwind with !important
<div className="!text-red-500">

// ❌ FORBIDDEN — mixing Tailwind with Bootstrap or other frameworks
<div className="btn btn-primary">
```

---

## 5. UI/UX Standards

### 5.1 Enterprise Data UI Principles

myRMA is used by warehouse operations, technicians, and managers — not casual consumers. UI must optimize for:

1. **Data density** — More information per screen. Not every row needs breathing room.
2. **Keyboard operability** — Power users navigate by keyboard. Tab order must be logical.
3. **Scannable tables** — Right data in right columns. Consistent column widths.
4. **Fast feedback** — Every action must respond within 200ms (even if just showing a spinner).
5. **No dead ends** — Every error state must tell the user what to do next.

### 5.2 Loading States

**MUST: Every async operation has a visible loading indicator.**

| Operation | Loading UI |
|-----------|-----------|
| Page load | Full-page `<Spinner size="xl">` centered |
| Table data | Spinner above table OR skeleton rows |
| Form submit | Spinner inside submit button, button disabled |
| Inline action | Spinner replaces action icon |
| Background sync | No UI required unless > 2 seconds |

**LAW: Never show stale data without a loading indicator when a refresh is in progress.**

### 5.3 Error States

**MUST: All error states show:**
1. What went wrong (plain language, not error codes)
2. What the user can do (retry, contact support, check permissions)

```jsx
// ✅ CORRECT
<div className="text-red-600 text-sm mt-1">
  Could not load tickets. Check your connection and try again.
</div>

// ❌ WRONG
<div className="text-red-600 text-sm mt-1">Error: 500</div>
```

**MUST: Network errors must offer a Retry button.**

### 5.4 Confirmation Patterns

**MUST: Destructive actions require a two-step confirmation** — a modal, not just a `window.confirm()`.

**MUST: Bulk destructive actions (delete all, archive all) require explicit text confirmation** (type the word "DELETE") for items ≥ 10.

**SHOULD: Non-destructive actions can use a single-click with an undo mechanism** via optimistic updates + rollback.

### 5.5 Toast Notifications

**MUST: Show success toasts for completed mutations** (created, updated, deleted, uploaded).

**MUST: Show error toasts for failed mutations** in addition to inline error messages.

**SHOULD: Toasts auto-dismiss after 4–6 seconds.** Critical errors may require explicit dismissal.

**MUST: Toasts do not block page content** — positioned in a corner (bottom-right preferred).

### 5.6 Navigation & Wayfinding

**MUST: Active route is visually highlighted** in the sidebar navigation.

**MUST: The browser title (`document.title`) updates to reflect the current page.**

**MUST: Deep links must work** — loading `/products/123` directly must render the product detail view for authenticated users.

**SHOULD: Breadcrumbs appear on detail pages** (Product Detail, Customer Detail) showing the back path.

### 5.7 Sidebar

The sidebar has two modes: expanded (full labels) and compact (icons only). Controlled by `useAppearance()`.

**MUST: All sidebar items have `title` attributes** for icon-only mode accessibility.

**MUST: The sidebar is responsive** — collapses to a hamburger/drawer on mobile (≤ 768px).

---

## 6. State Management Rules

### 6.1 State Decision Tree

Use this flowchart to decide where state lives:

```
Is this UI-only state (open/closed, tab, hover)?
  → useState (local)

Is this data from Supabase?
  → TanStack Query (useQuery / useMutation)

Is this global appearance/theme?
  → AppearanceContext (via useAppearance())

Is this auth/user state?
  → Loaded in App.jsx, passed as props

Is this a cross-cutting concern (notifications, real-time)?
  → Supabase Realtime channel in App.jsx
```

**LAW: Do not use Redux, Zustand, MobX, Jotai, or any external global state library** without explicit team approval.

### 6.2 TanStack Query Rules

**MUST: Configure QueryClient with standard settings in `main.jsx`:**

```js
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,   // 1 minute
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})
```

**MUST: Query keys must be arrays with a stable prefix and relevant filters:**

```js
// ✅ CORRECT
queryKey: ['tickets']
queryKey: ['tickets', { status: 'open', page: 1 }]
queryKey: ['customers', customerId]
queryKey: ['products', 'low-stock']

// ❌ WRONG — unstable keys
queryKey: [Math.random()]
queryKey: ['data']
```

**MUST: After mutations, invalidate the relevant query** to trigger a re-fetch:

```js
useMutation({
  mutationFn: (id) => db.rmaTickets.delete(id),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['tickets'] })
  },
})
```

### 6.3 Optimistic Updates

**SHOULD: Use optimistic updates for high-frequency user actions** (delete, status toggle, edit) where the operation is very likely to succeed.

**MUST: All optimistic updates include a rollback on error:**

```js
useMutation({
  mutationFn: (id) => db.customers.delete(id),
  onMutate: async (id) => {
    await queryClient.cancelQueries({ queryKey: ['customers'] })
    const previous = queryClient.getQueryData(['customers'])
    queryClient.setQueryData(['customers'], (old) =>
      old.filter((c) => c.id !== id)
    )
    return { previous }
  },
  onError: (err, id, context) => {
    queryClient.setQueryData(['customers'], context.previous)
    toast.error('Failed to delete customer')
  },
  onSettled: () => {
    queryClient.invalidateQueries({ queryKey: ['customers'] })
  },
})
```

### 6.4 Realtime Updates

Supabase Realtime is subscribed in `App.jsx` on a single channel (`app_notifications`).

**MUST: Realtime handlers update the query cache directly** via `queryClient.setQueryData` instead of triggering a full refetch where possible.

**MUST: Only one Realtime subscription per data type.** Do not create per-component subscriptions.

### 6.5 Local Storage

The following keys are used by the app — do not reuse them:

| Key | Owner | Contents |
|-----|-------|---------|
| `mrma_appearance` | AppearanceContext | Theme settings |
| `notif_system_prefs_<email>` | Notifications | Per-type notification preferences |

**MUST: Local storage values are validated before use** — `JSON.parse` errors must be caught with `try/catch`.

---

## 7. Backend & Supabase Rules

### 7.1 Data Access Architecture

**LAW: Page components MUST NEVER import `supabase` directly.** All Supabase access goes through the barrel module and domain helpers.

```
src/api/supabaseClient.js     ← barrel re-export (21 lines, nothing else)
src/api/client.js             ← creates the supabase client instance
src/api/auth.js               ← authentication helpers
src/api/db/index.js           ← aggregates all domain modules
src/api/db/tickets.js         ← RMA ticket CRUD
src/api/db/customers.js       ← customer CRUD
src/api/db/products.js        ← product CRUD
src/api/db/inventory.js       ← inventory CRUD
src/api/db/users.js           ← user role management
src/api/db/notifications.js   ← notification table ops
... (15 domain files total)
src/api/storage.js            ← file upload/download
src/api/branding.js           ← company branding settings
src/api/email.js              ← notification dispatch + Edge Function call
src/api/backup.js             ← full data export/import
```

```js
// ✅ CORRECT — in a page component
import { db, auth, storage } from '../api/supabaseClient.js'
const { data } = await db.rmaTickets.list({ status: 'open' })

// ❌ FORBIDDEN — in a page component
import { supabase } from '../api/client.js'
const { data } = await supabase.from('rma_tickets').select('*')
```

### 7.2 Optional Table Handling

Many tables may not exist in every deployment (`announcements`, `custom_field_definitions`, `inventory_units`, `warehouses`). All `db.*` helpers that target these tables MUST guard against the table-not-found error:

```js
// ✅ CORRECT
async function listWarehouses() {
  const { data, error } = await supabase.from('warehouses').select('*')
  if (error?.code === '42P01') return { missing: true, data: [] }
  if (error) throw error
  return { data }
}

// ❌ WRONG — throws if table doesn't exist
async function listWarehouses() {
  const { data, error } = await supabase.from('warehouses').select('*')
  if (error) throw error
  return data
}
```

### 7.3 Row-Level Security (RLS)

**LAW: RLS is always on for all tables. Never disable RLS in production.**

All RLS policies use the standard helper functions in the `public` schema:

```sql
-- ✅ CORRECT — use public.rma_* functions
public.rma_user_role()
public.rma_is_admin()
public.rma_is_manager_or_above()
public.rma_is_staff()
public.rma_current_user_email()

-- ❌ FORBIDDEN — these functions do not exist
auth.user_role()
auth.is_admin()
auth.current_user_email()
```

**MUST: Every new table gets RLS policies** before it is used in production. Minimum policy set:
- `SELECT` — staff can read; anon cannot
- `INSERT` — staff can create; anon cannot
- `UPDATE` — role-appropriate
- `DELETE` — role-appropriate (often admin-only)

### 7.4 Edge Functions

Edge Functions live in `supabase/functions/<function-name>/index.ts`.

Current functions:
- `admin-reset-password` — Password reset AND new user creation (create-if-missing logic)
- `public-track` — Rate-limited public RMA tracker lookup
- `send-email` — Email dispatch

**MUST: Edge Functions validate the caller's JWT** before performing privileged operations:

```typescript
const authHeader = req.headers.get('Authorization')
const token = authHeader?.replace('Bearer ', '')
const { data: { user }, error } = await adminClient.auth.getUser(token)
if (error || !user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
```

**MUST: Edge Functions return structured JSON** with consistent error shapes:

```typescript
// Success
return new Response(JSON.stringify({ success: true, data: {...} }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' }
})

// Error
return new Response(JSON.stringify({ error: 'Human-readable message' }), {
  status: 4xx | 5xx,
  headers: { 'Content-Type': 'application/json' }
})
```

**MUST: `public-track` Edge Function enforces rate limiting** — no more than N lookups per IP per hour. Verify this is implemented before modifying.

### 7.5 Database Migrations

**MUST: All schema changes are Supabase migrations** in `supabase/migrations/`.

**MUST: Migration files are named `YYYYMMDD_description.sql`** (e.g., `20260527_storage_bucket_policies.sql`).

**MUST: Migrations are idempotent** — use `CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

**LAW: Never alter production schema by running ad-hoc SQL in the Supabase dashboard.** All changes through migration files committed to git.

### 7.6 Storage Bucket Rules

The `rma-attachments` bucket has these enforced policies:

| Role | Allowed operations | Constraints |
|------|--------------------|-------------|
| `anon` | `INSERT` | Max 25MB; MIME: JPEG, PNG, GIF, WebP, PDF only |
| `anon` | `SELECT` | Read only (for serving attachment URLs) |
| `authenticated` | `ALL` | No size/type restrictions |

**LAW: Never remove the anonymous upload size/type restrictions.** These prevent storage abuse via the public tracker.

---

## 8. Security Rules

### 8.1 Authentication Rules

**LAW: All authenticated routes check user session on load.** An expired JWT must redirect to the login page, not show partial data.

**MUST: Password reset uses the `admin-reset-password` Edge Function**, not direct `supabase.auth.resetPasswordForEmail()` — the Edge Function handles both reset (existing user) and create (new user) paths.

**MUST: Session is re-validated on every page load** via `supabase.auth.getSession()`.

### 8.2 Permission System

Roles in order of ascending privilege:

```
viewer < technician < manager < admin < super_admin
```

**LAW: `super_admin` and `admin` bypass all permission checks in the UI.** This is intentional and must not be changed.

**MUST: Use `canDo()` from `src/lib/permissions.ts`** for all permission checks:

```typescript
import { canDo } from '../lib/permissions.ts'

// ✅ CORRECT
if (canDo(currentUserRole, currentUserPermissions, 'tickets', 'delete')) {
  // show delete button
}

// ❌ WRONG — hardcoded role check that bypasses permission matrix
if (currentUserRole === 'admin') {
  // show delete button
}
```

`canDo` automatically handles the `super_admin`/`admin` bypass. Do not replicate that logic in components.

**MUST: `ROLE_DEFAULT_PERMISSIONS` lives in `src/lib/permissions.ts`**, not `App.jsx`. Do not duplicate it.

### 8.3 Secret Management

**LAW: API keys and secrets are ONLY in environment variables** (`.env`, Supabase Edge Function secrets). Never in source code.

**LAW: The service role key (`service_role`) is ONLY used in Edge Functions running server-side.** Never expose it to the browser.

**MUST: The `VITE_SUPABASE_ANON_KEY` (browser-safe public key) is the only key shipped to the client.** The anon key is rate-limited and RLS-restricted by design.

### 8.4 Input Validation

**MUST: All user inputs are validated before being sent to Supabase:**
- Text fields: trim whitespace, enforce length limits
- Numbers: verify range, no NaN
- Files: check MIME type and size client-side (in addition to bucket policy enforcement)
- Emails: regex validation + Supabase email validation

**MUST: SQL injection is impossible via the Supabase client** (uses parameterized queries). Do not construct raw SQL strings with user input in Edge Functions.

### 8.5 CORS and Public Endpoints

**MUST: The `/tracker` route is the ONLY page rendered without authentication.** All other routes check for a valid session.

**MUST: `public-track` Edge Function does not return sensitive customer data** — only the fields needed for the public tracker UI.

---

## 9. Performance Standards

### 9.1 Bundle Size

**MUST: Run `npm run build` and check the bundle size output** after adding any new dependency.

**SHOULD: Page bundles (lazy-loaded) stay under 200KB gzipped each.**

**MUST: Heavy dependencies (PDF generators, chart libraries, date pickers) are lazy-loaded** with `React.lazy` and only imported where needed.

### 9.2 Virtualization

**MUST: Lists with potentially unbounded length use `@tanstack/react-virtual`.**

The current virtualized component is the customer search dropdown in `RMATickets.jsx` (the only un-paginated list).

```jsx
import { useVirtualizer } from '@tanstack/react-virtual'

const rowVirtualizer = useVirtualizer({
  count: customers.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 40,
})
```

**SHOULD: Tables with > 200 rows use pagination** (server-side preferred) rather than client-side rendering all rows.

### 9.3 Memoization

**SHOULD: Use `useMemo` for expensive computations** (filtering large arrays, sorting, aggregating data):

```jsx
const filteredTickets = useMemo(
  () => tickets.filter((t) => t.status === selectedStatus),
  [tickets, selectedStatus]
)
```

**SHOULD: Use `useCallback` for functions passed to child components** that would otherwise cause re-renders.

**MUST NOT: Over-memoize.** Every `useMemo`/`useCallback` has a memory cost. Only use when profiling confirms a re-render problem.

### 9.4 Image Handling

**MUST: User-uploaded images are resized client-side before upload** when they exceed a size threshold. The resize is done via a canvas transform before calling `storage.upload()`.

**MUST: Images served from Supabase Storage use width parameters** when displaying thumbnails to avoid serving full-resolution images in list views.

### 9.5 Query Performance

**MUST: Select only needed columns** in Supabase queries — no `select('*')` in production queries unless all columns are genuinely needed:

```js
// ✅ CORRECT
supabase.from('rma_tickets').select('id, rma_number, status, created_at, customer_id')

// ❌ WASTEFUL
supabase.from('rma_tickets').select('*')
```

**MUST: Use `.range()` pagination for all table queries** that could return more than 100 rows.

**MUST: Use `.limit()` on dropdown/autocomplete queries** — typically 20–50 results maximum.

---

## 10. Accessibility Standards

### 10.1 WCAG AA Compliance

**MUST: All interactive elements meet WCAG AA color contrast** (4.5:1 for normal text, 3:1 for large text).

**MUST: All images have meaningful `alt` text.** Decorative images use `alt=""`.

**MUST: All form inputs have associated `<Label>` elements** with correct `htmlFor` matching the input `id`.

### 10.2 Keyboard Navigation

**MUST: All interactive elements are keyboard-reachable** via Tab.

**MUST: Tab order is logical** — follows visual reading order (left-to-right, top-to-bottom).

**MUST: Modal dialogs trap focus** — Tab cycles through modal elements only while the modal is open.

**MUST: Modals close on Escape key** (unless the user has unsaved changes, in which case confirm first).

**MUST: Dropdown menus support Arrow key navigation.**

### 10.3 ARIA Labels

**MUST: Icon-only buttons have `aria-label`:**

```jsx
// ✅ CORRECT
<IconButton aria-label="Delete ticket" onClick={handleDelete}>
  <TrashIcon />
</IconButton>

// ❌ MISSING aria-label
<IconButton onClick={handleDelete}>
  <TrashIcon />
</IconButton>
```

**MUST: `<Spinner>` has `role="status"` and `aria-label="Loading"`.**

**MUST: Dynamic content updates use `aria-live` regions** for screen reader announcements:

```jsx
<div aria-live="polite" aria-atomic="true">
  {successMessage}
</div>
```

### 10.4 Focus Management

**MUST: After opening a modal, focus moves to the first focusable element inside it.**

**MUST: After closing a modal, focus returns to the trigger element that opened it.**

**MUST: After a page navigation, focus moves to the main heading (`<h1>`)** or the top of the content area.

---

## 11. Responsive Design Rules

### 11.1 Breakpoints

Use Tailwind's standard breakpoints:

```
sm:   640px  — tablet portrait
md:   768px  — tablet landscape
lg:   1024px — laptop
xl:   1280px — desktop
2xl:  1536px — wide desktop
```

**SHOULD: Design mobile-first** — base classes for mobile, `md:` overrides for larger screens.

### 11.2 Layout Rules

**MUST: The sidebar collapses to a hamburger drawer on screens < 768px (`md`).**

**MUST: Data tables on mobile use horizontal scroll** — never truncate columns silently:

```jsx
<div className="overflow-x-auto">
  <table className="min-w-full">
    ...
  </table>
</div>
```

**SHOULD: Cards stack vertically on mobile** (single column) and use a grid on desktop:

```jsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
```

### 11.3 Touch Targets

**MUST: All interactive elements have a minimum touch target of 44×44px** on mobile, even if visually smaller.

**MUST: No hover-only interactions** — all hover-revealed content must also be accessible on tap.

---

## 12. Naming Conventions

### 12.1 Files and Directories

| Type | Convention | Example |
|------|-----------|---------|
| React page component | PascalCase `.jsx` | `RMATickets.jsx` |
| React sub-component | PascalCase `.jsx` | `TicketRow.jsx` |
| Shared UI component | PascalCase `.jsx` in `components/` | `ui.jsx`, `ErrorBoundary.jsx` |
| API domain module | camelCase `.js` in `api/db/` | `tickets.js`, `customers.js` |
| Hook | camelCase `.js` in `hooks/` | `useURLTab.js` |
| Context | PascalCase `Context.jsx` | `AppearanceContext.jsx` |
| TypeScript lib module | camelCase `.ts` in `lib/` | `constants.ts`, `permissions.ts` |
| Supabase migration | `YYYYMMDD_description.sql` | `20260527_storage_bucket_policies.sql` |
| Test file | same name + `.test.js` | `constants.test.js` |

### 12.2 Variables and Functions

```typescript
// ✅ CORRECT
const ticketList = []                     // camelCase for variables
const TICKET_STATUS = { ... } as const    // SCREAMING_SNAKE_CASE for constants
function handleSubmit() {}                // camelCase for functions, "handle" prefix for event handlers
function useRMATickets() {}               // camelCase for hooks, "use" prefix
interface TicketRow { ... }               // PascalCase for types/interfaces
type TicketStatus = ...                   // PascalCase for types
```

```typescript
// ❌ WRONG
const TicketList = []         // PascalCase for non-component
const ticket_list = []        // snake_case in JS/TS
const HANDLE_SUBMIT = () =>   // SCREAMING_SNAKE_CASE for functions
```

### 12.3 Component Props

**MUST: Boolean props use positive names** (not negation):

```jsx
// ✅ CORRECT
<Modal isOpen={true} />
<Button isLoading={true} />
<Table isSelectable={false} />

// ❌ WRONG
<Modal isNotClosed={true} />
<Button notLoading={false} />
```

**MUST: Event handler props are prefixed with `on`:**

```jsx
// ✅ CORRECT
<TicketRow onEdit={handleEdit} onDelete={handleDelete} />

// ❌ WRONG
<TicketRow editFn={handleEdit} deleteCallback={handleDelete} />
```

### 12.4 Database Tables and Columns

Database tables use `snake_case` (enforced by Postgres convention):

```sql
-- ✅ CORRECT
rma_tickets, rma_number, customer_id, created_at, updated_at

-- ❌ WRONG
rmaTickets, RMANumber, customerId, createdAt
```

TypeScript interfaces wrapping database types can use `camelCase` after transformation, but the raw Supabase response always returns `snake_case`.

### 12.5 Query Keys

**MUST: Query keys are lowercase strings** matching the table or resource name:

```js
// ✅ CORRECT
['tickets'], ['customers'], ['products'], ['inventory'], ['users']

// ❌ WRONG
['RMATickets'], ['CUSTOMERS'], ['getProducts']
```

---

## 13. File & Folder Structure

### 13.1 Directory Map

```
d:\myrma-app\
├── public\                     # Static assets, PWA manifest, icons
├── src\
│   ├── api\                    # All Supabase access
│   │   ├── supabaseClient.js   # Barrel re-export (21 lines only)
│   │   ├── client.js           # Supabase client instance
│   │   ├── auth.js             # Auth helpers
│   │   ├── storage.js          # File upload/download
│   │   ├── branding.js         # Company branding
│   │   ├── email.js            # Notification dispatch
│   │   ├── backup.js           # Data export/import
│   │   └── db\
│   │       ├── index.js        # Aggregates all domain modules into `db` export
│   │       ├── tickets.js      # RMA ticket CRUD + rmaTracker public lookup
│   │       ├── customers.js    # Customer CRUD
│   │       ├── products.js     # Product CRUD
│   │       ├── inventory.js    # Inventory CRUD
│   │       ├── users.js        # User role management
│   │       ├── notifications.js # Notification table ops
│   │       └── ...             # (15 domain files total)
│   ├── components\
│   │   ├── ui.jsx              # Shared component library (Button, Input, Modal, etc.)
│   │   ├── ErrorBoundary.jsx   # App-level error boundary
│   │   └── ...                 # Other shared components
│   ├── contexts\
│   │   └── AppearanceContext.jsx # Theme, dark mode, date format
│   ├── hooks\
│   │   └── useURLTab.js        # URL-synced tab state hook
│   ├── lib\                    # TypeScript-first pure logic
│   │   ├── constants.ts        # All magic strings (ROLES, TICKET_STATUS, etc.)
│   │   ├── permissions.ts      # canDo(), ROLE_DEFAULT_PERMISSIONS
│   │   └── schemas.ts          # Zod validation schemas
│   ├── pages\                  # Top-level page components (lazy-loaded)
│   │   ├── Dashboard.jsx
│   │   ├── Products.jsx
│   │   ├── ProductDetails.jsx
│   │   ├── Customers.jsx
│   │   ├── CustomerDetails.jsx
│   │   ├── RMATickets.jsx
│   │   ├── RMATracker.jsx      # Public-facing, no auth required
│   │   ├── ControlPanel.jsx    # Admin-only sub-pages
│   │   └── ...
│   ├── App.jsx                 # Route definitions, auth check, realtime subscription
│   └── main.jsx                # App entry point, providers, BrowserRouter
├── supabase\
│   ├── functions\              # Supabase Edge Functions
│   │   ├── admin-reset-password\
│   │   ├── public-track\
│   │   └── send-email\
│   └── migrations\             # Database migrations (YYYYMMDD_description.sql)
├── .github\
│   └── workflows\
│       └── ci.yml              # CI: test → lint:ci → build
├── .specify\                   # Speckit planning artifacts
├── AUDIT_LOG.md                # Engineering audit history and scorecard
├── CLAUDE.md                   # AI agent instructions (checked into repo)
├── CONSTITUTION.md             # This file
├── vite.config.js              # Vite + PWA configuration
├── tailwind.config.js
├── eslint.config.js            # ESLint 9 flat config
└── package.json
```

### 13.2 Where New Files Go

| Type of file | Where it goes |
|-------------|--------------|
| New page component | `src/pages/NewPage.jsx` |
| New shared UI component | `src/components/NewComponent.jsx` (or extend `ui.jsx` if primitive) |
| New Supabase domain module | `src/api/db/newdomain.js` + export from `src/api/db/index.js` |
| New React hook | `src/hooks/useNewHook.js` |
| New TypeScript utility | `src/lib/newutil.ts` with corresponding test |
| New Edge Function | `supabase/functions/new-function/index.ts` |
| New migration | `supabase/migrations/YYYYMMDD_description.sql` |

**LAW: Do not create files in the root directory** unless they are project-level configs (vite.config.js, tailwind.config.js, etc.) or documentation (CONSTITUTION.md, AUDIT_LOG.md, CLAUDE.md).

### 13.3 Import Order (Enforced by ESLint)

```js
// 1. Node/React built-ins
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

// 2. Third-party libraries
import { useQuery } from '@tanstack/react-query'

// 3. Internal API modules
import { db, storage } from '../api/supabaseClient.js'

// 4. Internal components
import { Button, Spinner, Badge } from '../components/ui.jsx'

// 5. Internal hooks/contexts/lib
import { useAppearance } from '../contexts/AppearanceContext.jsx'
import { canDo } from '../lib/permissions.ts'
import { TICKET_STATUS } from '../lib/constants.ts'
```

---

## 14. Code Quality Rules

### 14.1 File Size Limits

| File type | Soft limit | Hard limit |
|-----------|-----------|-----------|
| Page component | 400 lines | 800 lines |
| Shared component | 200 lines | 400 lines |
| API domain module | 150 lines | 300 lines |
| Hook | 80 lines | 150 lines |

When a file approaches its hard limit, **extract sub-components or split the domain module** rather than continuing to grow the single file.

### 14.2 No Magic Strings

**LAW: All status values, role names, config keys, storage keys, and notification types come from `src/lib/constants.ts`.**

```typescript
// ✅ CORRECT
import { TICKET_STATUS, ROLES } from '../lib/constants.ts'

if (ticket.status === TICKET_STATUS.OPEN) { ... }
if (currentUserRole === ROLES.ADMIN) { ... }

// ❌ FORBIDDEN — magic strings
if (ticket.status === 'open') { ... }
if (currentUserRole === 'admin') { ... }
```

**When adding a new status value or constant, add it to `constants.ts` first, then use it.**

### 14.3 No Dead Code

**MUST: Remove code before merging to main:**
- Commented-out code blocks
- Unused imports
- Unused variables (ESLint catches these)
- Feature flags that are always-on
- `console.log` statements (except intentional debug utilities with `debug:` prefix)

### 14.4 No Duplicate Logic

**MUST: Before writing a utility function, search the codebase** for an existing equivalent.

Key utilities that already exist and must not be duplicated:
- `canDo()` — permission check (`src/lib/permissions.ts`)
- `parseCSVLine()` — CSV parsing (local to `Products.jsx`/`Customers.jsx`)
- `useURLTab()` — URL-synced tab state (`src/hooks/useURLTab.js`)
- `captureException()` — Sentry error capture (wired in `ErrorBoundary.jsx`)
- `useAppearance()` — theme access (`src/contexts/AppearanceContext.jsx`)

### 14.5 TypeScript Adoption Rules

TypeScript is adopted incrementally — currently in `src/lib/` only.

**MUST: All new files in `src/lib/` are `.ts`.**

**MUST: TypeScript files use strict typing** — no `any` without a `// eslint-disable-next-line @typescript-eslint/no-explicit-any` and an explanation comment.

**MUST: `.js` imports in TypeScript files are valid** — the Vite bundler resolves `import foo from './foo.js'` to `./foo.ts`. Do not change this pattern.

**SHOULD: New `src/api/` modules use JSDoc type annotations** as a stepping stone toward TypeScript.

### 14.6 ESLint & Prettier

**LAW: No ESLint errors on main.** CI blocks merges with ESLint errors.

**MUST: Run `npm run lint` before pushing** any commit to a feature branch.

**MUST: Run `npm run format` to ensure Prettier formatting** matches the project standard.

---

## 15. Testing Standards

### 15.1 Current Test Suite

74 tests across 3 suites in `src/lib/`:

| File | Tests | Coverage |
|------|-------|---------|
| `constants.test.js` | Unit tests for all constant values and type correctness | Constants are correct and non-empty |
| `permissions.test.js` | Tests for `canDo()` across all role/permission combinations | All role transitions, bypass logic |
| `schemas.test.js` | Validation schema tests for all Zod schemas | Valid inputs pass, invalid inputs fail |

Run with `npm test` (Vitest).

### 15.2 What Must Be Tested

**MUST: All code in `src/lib/` has unit tests.**

**MUST: `canDo()` has tests for every role at every permission level** (pass and fail cases).

**MUST: All Zod schemas in `schemas.ts` have at least one valid and one invalid test case.**

**SHOULD: New API domain modules have smoke tests** that mock Supabase responses.

### 15.3 What Does Not Need Tests

- React page components (covered by E2E if implemented)
- Tailwind CSS utility classes
- Static configuration objects
- One-off migration scripts

### 15.4 Test Writing Standards

```typescript
// ✅ CORRECT — descriptive test names
describe('canDo', () => {
  it('returns true when super_admin tries any action', () => {
    expect(canDo('super_admin', {}, 'tickets', 'delete')).toBe(true)
  })
  it('returns false when viewer tries to delete a ticket', () => {
    expect(canDo('viewer', {}, 'tickets', 'delete')).toBe(false)
  })
})

// ❌ WRONG — vague test names
it('works correctly', () => { ... })
it('test 1', () => { ... })
```

**MUST: Tests are deterministic** — no reliance on random values, current time, or network calls (mock all external deps).

**MUST: Tests do not modify global state** or depend on test execution order.

---

## 16. Git & Deployment Standards

### 16.1 Branch Naming

```
feature/<short-description>     — new features
fix/<short-description>         — bug fixes
chore/<short-description>       — maintenance, deps, docs
refactor/<short-description>    — code restructuring without behavior change
hotfix/<short-description>      — urgent production fixes
```

Examples:
```
feature/bulk-ticket-export
fix/customer-search-dropdown
chore/update-tanstack-query
hotfix/rls-policy-breakage
```

### 16.2 Commit Message Format

Follow Conventional Commits:

```
<type>(<scope>): <short description>

[optional body]

[optional footer]
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `perf`, `security`

```
feat(tickets): add bulk status update with optimistic UI
fix(auth): redirect to login on expired JWT instead of blank page
docs(constitution): add AI agent rules section
security(storage): add anon upload size and MIME type restrictions
```

**MUST: Scope matches the affected area** (`tickets`, `auth`, `products`, `ui`, `storage`, `migrations`, etc.).

**MUST: Subject line is imperative, lowercase, no period**, ≤ 72 characters.

### 16.3 CI/CD Pipeline

GitHub Actions runs on every push and PR to `main`:

```
1. npm test          — Vitest (74 unit tests, must all pass)
2. npm run lint:ci   — ESLint (zero errors gate)
3. npm run build     — Vite production build (must succeed)
```

**LAW: No merges to `main` with failing CI.** No exceptions.

**MUST: Before pushing, run locally:**
```
npm test && npm run lint && npm run build
```

### 16.4 Production Deployment

**MUST: Database migrations run before frontend deploy** — never deploy code that requires a schema change before that schema change is live.

**MUST: Edge Function deploys are tested in a staging environment first** when they involve auth or data mutation logic.

**MUST: The `rma-attachments` storage bucket is verified to exist** before any storage-dependent feature is enabled.

### 16.5 Secrets Rotation

**MUST: If a Supabase service role key is accidentally committed**, immediately:
1. Revoke the key in the Supabase dashboard
2. Generate a new service role key
3. Update all Edge Function secrets
4. Force-push to remove the commit from history (coordinate with team)
5. Audit access logs for unauthorized use

---

## 17. AI Agent Rules

This section is for Claude Code, GitHub Copilot, and any other AI coding assistant working in this codebase.

### 17.1 The Single Source of Truth

**LAW: Before generating any code, read the relevant domain module and `src/components/ui.jsx`.** Never assume the existing API or component shape — verify it.

Priority order for authoritative information:
1. This `CONSTITUTION.md`
2. `CLAUDE.md` (project-level instructions)
3. `AUDIT_LOG.md` (what was changed and why)
4. The actual source code files
5. READMEs and docs (may be outdated)

### 17.2 Never Bypass the API Layer

**LAW: AI agents must NEVER generate code that imports `supabase` directly in page components.**

```jsx
// ❌ ABSOLUTELY FORBIDDEN — AI must never generate this in a page component
import { supabase } from '../api/client.js'
const { data } = await supabase.from('rma_tickets').select('*')

// ✅ The only correct pattern
import { db } from '../api/supabaseClient.js'
const { data } = await db.rmaTickets.list()
```

### 17.3 Never Re-implement Existing Components

**LAW: AI agents must NEVER generate new `<button>`, `<input>`, `<div className="fixed inset-0...">`, or similar primitives** without first checking if a component in `src/components/ui.jsx` already covers the use case.

Before generating any UI element, ask: _Does `ui.jsx` already export this?_

### 17.4 Never Duplicate Logic

**LAW: Before generating any utility function, search for it** using the Grep or Glob tools. The following functions are ALREADY IMPLEMENTED and must not be reimplemented:

- Permission checking → `canDo()` in `src/lib/permissions.ts`
- CSV parsing → `parseCSVLine()` in `Products.jsx` / `Customers.jsx`
- URL tab sync → `useURLTab()` in `src/hooks/useURLTab.js`
- Sentry capture → `captureException()` (via ErrorBoundary)
- Theme access → `useAppearance()` from `AppearanceContext.jsx`
- All magic strings → `src/lib/constants.ts`

### 17.5 Never Remove Safety Features

**LAW: AI agents must NEVER:**
- Remove or weaken RLS policies
- Remove the anonymous upload size/type restrictions on the storage bucket
- Remove the `ErrorBoundary` from `main.jsx`
- Remove the rate limiting from `public-track` Edge Function
- Remove JWT validation from any Edge Function
- Change the `QueryClientProvider` staleTime below 30 seconds without explanation
- Remove the `TooltipProvider` from `main.jsx` (causes blank page)

### 17.6 Always Use Correct SQL Function Names

**LAW: In any SQL or Edge Function code, use the `public.rma_*` function names:**

```sql
-- ✅ CORRECT
public.rma_user_role()
public.rma_is_admin()
public.rma_is_manager_or_above()
public.rma_is_staff()
public.rma_current_user_email()

-- ❌ THESE DO NOT EXIST — AI must never generate these
auth.user_role()
auth.is_admin()
auth.current_user_email()
```

### 17.7 Code Generation Quality Standards

**MUST: Generated code follows all naming conventions** in Section 12.

**MUST: Generated components include dark mode classes** (`dark:bg-gray-800`, etc.) — never generate a component with light-mode-only Tailwind classes.

**MUST: Generated API calls use the barrel import** (`from '../api/supabaseClient.js'`).

**MUST: Generated mutations include error handling** — never `await someApiCall()` without try/catch or `.catch()`.

**MUST: Generated lists/tables include empty state and loading state** — never generate a `{data.map(...)}` without handling `isLoading` and `data.length === 0`.

**MUST: Generated buttons have explicit `variant` props.**

**SHOULD: Generated code includes JSDoc comments** for non-obvious logic.

### 17.8 Testing Generated Code

**MUST: After generating or modifying `src/lib/` code, the agent MUST run `npm test`** to verify existing tests still pass.

**MUST: After significant UI changes, the agent MUST run `npm run build`** to confirm no bundling errors.

**SHOULD: For critical paths (auth, permissions, storage), the agent SHOULD add tests** if none exist for the modified function.

### 17.9 Documenting Changes

**MUST: When making changes that affect the audit record, update `AUDIT_LOG.md`** changelog section with:
- Date (YYYY-MM-DD)
- Change summary
- ID if it corresponds to an existing finding

**MUST: When changing architectural patterns (routing, state management, data access), update `CLAUDE.md`** to reflect the new pattern.

---

## 18. Final Enforcement Rules

### 18.1 Mandatory Laws (Zero-Tolerance)

These rules have no exceptions. Any violation must be reverted immediately:

| # | Law |
|---|-----|
| L-01 | No class components. All components are functional with hooks. |
| L-02 | No direct Supabase import in page components. Always use the barrel (`supabaseClient.js`). |
| L-03 | No re-implementing components that exist in `src/components/ui.jsx`. |
| L-04 | No magic strings. All constants in `src/lib/constants.ts`. |
| L-05 | No merging to `main` with failing CI (tests, lint, or build). |
| L-06 | No secrets in source code. Always environment variables. |
| L-07 | No disabling RLS in production. |
| L-08 | No removing anonymous upload size/type restrictions on storage bucket. |
| L-09 | No `window.location.href` or `window.history.pushState` for top-level navigation. Use `useNavigate()`. |
| L-10 | No `auth.user_role()` or similar non-existent SQL functions. Use `public.rma_*`. |
| L-11 | No `ErrorBoundary` removal from `main.jsx`. |
| L-12 | No ad-hoc schema changes without a migration file. |
| L-13 | No service role key in browser-side code. Edge Functions only. |
| L-14 | No skipping optimistic rollback on failed mutations (if optimistic updates are used). |
| L-15 | No new framework-level dependency without written team approval in the PR. |

### 18.2 Forbidden Anti-Patterns

```jsx
// FORBIDDEN: Direct Supabase in component
import { supabase } from '../api/client.js'

// FORBIDDEN: Magic string status
if (ticket.status === 'open') {}

// FORBIDDEN: Raw button (not using ui.jsx)
<button className="bg-blue-500 ...">Click</button>

// FORBIDDEN: Light-mode-only component
<div className="bg-white text-gray-900">

// FORBIDDEN: useEffect for data fetching
useEffect(() => { fetchTickets().then(setTickets) }, [])

// FORBIDDEN: window.location for navigation
window.location.href = '/dashboard'

// FORBIDDEN: Non-existent SQL function
public.rma_user_role()  // wait — this IS correct
auth.user_role()         // THIS is forbidden

// FORBIDDEN: Unauthenticated Edge Function call
// (no JWT check at function start)

// FORBIDDEN: select('*') in production queries
supabase.from('rma_tickets').select('*')

// FORBIDDEN: Inline style
<div style={{ color: 'red' }}>

// FORBIDDEN: console.log in production
console.log('ticket data:', data)

// FORBIDDEN: Arbitrary Tailwind values
<div className="w-[347px]">

// FORBIDDEN: Duplicate canDo logic
if (role === 'admin' || role === 'super_admin' || permissions?.tickets?.delete) {}
// Use: canDo(role, permissions, 'tickets', 'delete')
```

### 18.3 Code Review Checklist

Before approving any PR, verify:

- [ ] All tests pass (`npm test`)
- [ ] Zero ESLint errors (`npm run lint`)
- [ ] Build succeeds (`npm run build`)
- [ ] No new magic strings (uses `constants.ts`)
- [ ] No direct Supabase import in page components
- [ ] Dark mode classes present on all new UI
- [ ] Empty state and loading state on all new lists/tables
- [ ] Error handling on all async operations
- [ ] Permissions checked with `canDo()` (not hardcoded role strings)
- [ ] No deleted or weakened security features
- [ ] New constants added to `src/lib/constants.ts`
- [ ] `CLAUDE.md` updated if architectural patterns changed
- [ ] `AUDIT_LOG.md` changelog updated if relevant to audit findings

### 18.4 Living Document

This constitution is a living document. When:
- A new pattern is established and validated → Add it to the relevant section
- A law proves unworkable in practice → File a PR to update it with justification
- A new technology is adopted → Add it to Section 2.1 and document its rules

**MUST: Constitution changes are reviewed by the project lead** and committed as `docs(constitution): <description>`.

**MUST: All constitution changes are documented in the `AUDIT_LOG.md` changelog.**

---

*myRMA Engineering Constitution v2.0 — Established May 2026*  
*"Build it right, keep it right, document why it's right."*
