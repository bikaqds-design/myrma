# myRMA Enterprise RMA Management System

> A full-stack, enterprise-grade **Return Merchandise Authorization (RMA)** management platform built for warehouse operations, technical teams, and customer service staff.

[![CI](https://github.com/your-org/myrma-app/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/myrma-app/actions/workflows/ci.yml)

---

## Overview

myRMA provides end-to-end lifecycle management for product returns, warranty claims, and service tickets. It supports multi-role access, real-time updates, a public customer tracker, and a full suite of admin tools — all in a responsive, dark-mode-capable PWA.

### Key Features

| Feature | Description |
|---------|-------------|
| **RMA Ticket Management** | Create, assign, track, and resolve return tickets with full audit trail |
| **Customer Management** | Customer directory with RMA history and communication log |
| **Product Catalog** | Product/SKU management with inventory tie-in |
| **Inventory Tracking** | Parts inventory, stock levels, warehouse locations |
| **Public RMA Tracker** | Customer-facing portal to look up ticket status without logging in |
| **Tech Calendar** | Technician scheduling and workload calendar |
| **Invoices & Reports** | Invoice generation, reporting dashboards, data exports |
| **Parts Inventory** | Spare parts tracking for repair operations |
| **Role-Based Access Control** | 5 roles: `super_admin`, `admin`, `manager`, `technician`, `viewer` |
| **Real-Time Notifications** | Live updates via Supabase Realtime, per-user preference controls |
| **Dark Mode** | Full dark/light theme toggle, persisted per user |
| **PWA / Offline** | Installable app with offline shell via Workbox service worker |
| **WhatsApp Notifications** | Automated WhatsApp messages on ticket lifecycle events via Meta Cloud API |
| **PDF Generation** | Ticket and invoice PDF export |
| **Bulk CSV Import** | Mass upload for products and customers |
| **Audit Log** | Full system audit trail visible in the Control Panel |
| **Backup & Restore** | Full data export/import for disaster recovery |
| **Branding** | Customizable company name, logo, and colors |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 18 (functional components + hooks) |
| Build | Vite 6 |
| Routing | React Router v6 |
| Styling | Tailwind CSS v3 |
| Data fetching | TanStack Query v5 |
| Backend | Supabase (PostgreSQL + Auth + Storage + Realtime + Edge Functions) |
| Forms | React Hook Form + Zod |
| UI Components | Radix UI primitives + custom `src/components/ui.jsx` library |
| Charts | Recharts |
| PDF | jsPDF + html2canvas |
| Animations | Framer Motion |
| Drag & Drop | @hello-pangea/dnd |
| Error tracking | Sentry |
| PWA | vite-plugin-pwa (Workbox) |
| Virtualization | @tanstack/react-virtual |
| Accessibility (dev) | @axe-core/react (WCAG violation logging in browser console) |
| Testing | Vitest + Testing Library |
| Linting | ESLint 9 (flat config) |
| Formatting | Prettier |
| CI/CD | GitHub Actions |

---

## Quick Start

### Prerequisites

- **Node.js** >= 20
- **npm** >= 10
- A **Supabase** project (free tier works for development)

### 1. Clone & install

```bash
git clone https://github.com/your-org/myrma-app.git
cd myrma-app
npm install --legacy-peer-deps
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here
```

Both variables **must** be prefixed with `VITE_` to be exposed by Vite.

### 3. Set up the database

Run the migrations in order from the Supabase SQL editor or CLI:

```bash
# Using Supabase CLI (recommended)
supabase db push

# Or apply manually in this order:
supabase/migrations/20260524_customer_cascade_delete.sql
supabase/migrations/20260524_features.sql
supabase/migrations/20260526_enable_rls.sql
supabase/migrations/20260526_check_constraints.sql
supabase/migrations/20260527_storage_bucket_policies.sql
supabase/migrations/20260528_ticket_cascade_fk.sql
supabase/migrations/20260529_repair_permissions.sql
supabase/migrations/20260531_relax_ticket_status_constraint.sql
supabase/migrations/20260602_whatsapp_notifications.sql
supabase/migrations/20260603_user_preferences_rls.sql
```

### 4. Set up storage

Create a storage bucket named **`rma-attachments`** in your Supabase project. The bucket policies are applied by the `20260527_storage_bucket_policies.sql` migration.

### 5. Deploy Edge Functions

```bash
supabase functions deploy admin-reset-password
supabase functions deploy public-track
supabase functions deploy send-email
supabase functions deploy send-whatsapp
supabase functions deploy notification-worker
supabase functions deploy whatsapp-webhook
```

Set the required secrets in Supabase Dashboard → Edge Functions → Secrets:
```
WHATSAPP_ACCESS_TOKEN         # permanent system-user token from Meta
WHATSAPP_PHONE_NUMBER_ID      # phone number ID from WhatsApp Business API
WHATSAPP_WEBHOOK_VERIFY_TOKEN # arbitrary string matching Meta webhook config
```

### 6. Start development

```bash
npm run dev
# → http://localhost:5173
```

---

## Development

### Available Scripts

```bash
npm run dev                    # Vite dev server (hot reload, port 5173)
npm run build                  # Production build → dist/
npm run preview                # Preview production build locally
npm test                       # Vitest unit tests (80 tests, ~1s)
npm run test:watch             # Vitest in watch mode
npm run test:coverage          # Coverage report (HTML + text)
npm run lint                   # ESLint check
npm run lint:ci                # ESLint strict (zero warnings — used in CI)
npm run lint:fix               # ESLint auto-fix
npm run format                 # Prettier auto-format
npm run format:check           # Prettier check (no write)
```

### Project Structure

```
myrma-app/
├── public/                                   # Static assets, PWA icons
├── src/
│   ├── api/                                  # All Supabase access (never import supabase directly in pages)
│   │   ├── supabaseClient.js                 # Barrel re-export — the only import pages should use
│   │   ├── client.js                         # Supabase client instance
│   │   ├── auth.js                           # Auth helpers (sign-in, sign-out, reset)
│   │   ├── storage.js                        # File upload/download
│   │   ├── branding.js                       # Company branding settings
│   │   ├── email.js                          # Notification dispatch + send-email Edge Function
│   │   ├── backup.js                         # Full data export/import
│   │   └── db/                               # All TypeScript — export Row types
│   │       ├── index.ts                      # Aggregates all domain modules → `db` export + re-exports all Row types
│   │       ├── tickets.ts                    # RMA ticket CRUD + public tracker lookup
│   │       ├── customers.ts                  # Customer CRUD
│   │       ├── catalog.ts                    # Product catalog CRUD
│   │       ├── inventory.js                  # Inventory CRUD
│   │       ├── users.js                      # User role management
│   │       ├── notifications.js              # Notification table ops
│   │       ├── system.js                     # System config (rma_config table)
│   │       └── audit.js                      # Audit log reads
│   ├── components/
│   │   ├── ui.jsx                            # Shared component library (Button, Input, Modal, Badge…)
│   │   ├── ErrorBoundary.jsx                 # App-level error boundary → Sentry
│   │   └── ...                               # Other shared components
│   ├── contexts/
│   │   └── AppearanceContext.jsx             # Theme, dark mode, date format, sidebar mode
│   ├── hooks/
│   │   └── useURLTab.js                      # URL-synced tab/section state hook
│   ├── lib/                                  # TypeScript-first pure utilities
│   │   ├── constants.ts                      # All magic strings (ROLES, TICKET_STATUS, PRIORITY…)
│   │   ├── permissions.ts                    # canDo() helper + ROLE_DEFAULT_PERMISSIONS
│   │   ├── schemas.ts                        # Zod validation schemas
│   │   └── safeStorage.ts                    # localStorage wrapper (get/set/remove — Safari-safe)
│   ├── pages/                                # Top-level page components (all lazy-loaded)
│   │   ├── Dashboard.jsx
│   │   ├── Inventory/                        # index.jsx + 10 sub-files (ExportMenu, tabs, modals…)
│   │   ├── RMATickets/                       # index.jsx + TicketForm, TicketDrawer, _shared, _utils
│   │   ├── Products/                         # index.jsx + ProductsListTab, HierarchyTab, _modals
│   │   ├── Customers/                        # index.jsx + _modals, _constants
│   │   ├── UserManagement/                   # index.jsx + UsersTab, RolesTab, _shared, _utils
│   │   ├── ProductDetails.jsx
│   │   ├── CustomerDetails.jsx
│   │   ├── PartsInventory.jsx
│   │   ├── TechCalendar.jsx
│   │   ├── Invoices.jsx
│   │   ├── Reports.jsx
│   │   ├── AccountSettings.jsx
│   │   ├── ControlPanel.jsx                  # Admin: User Mgmt, Branding, Config, Audit Log…
│   │   ├── RMATracker.jsx                    # Public customer tracker (no auth)
│   │   ├── Login.jsx
│   │   ├── ResetPassword.jsx
│   │   └── BackupRestore.jsx
│   ├── App.jsx                               # Route declarations, auth guard, Realtime subscription
│   └── main.jsx                              # Entry point — providers + BrowserRouter + axe-core (dev)
├── supabase/
│   ├── functions/                            # Supabase Edge Functions
│   │   ├── admin-reset-password/             # Password reset + user creation (create-if-missing)
│   │   ├── public-track/                     # Rate-limited public RMA lookup
│   │   └── send-email/                       # Email dispatch
│   └── migrations/                           # Database migrations (run in date order)
├── .github/
│   └── workflows/
│       └── ci.yml                            # CI: test → lint:ci → build
├── AUDIT_LOG.md                              # Engineering audit history + scorecard
├── CLAUDE.md                                 # AI agent instructions
├── CONSTITUTION.md                           # Engineering constitution (rules + standards)
└── vite.config.js                            # Vite + PWA configuration
```

### Architecture Overview

#### Data flow

```
Page Component
  → import { db, auth, storage } from '../api/supabaseClient.js'
  → db.rmaTickets.list() / db.customers.get(id) / etc.
  → src/api/db/<domain>.js
  → supabase client (src/api/client.js)
  → Supabase PostgreSQL (RLS enforced)
```

Page components **never** import `supabase` directly. The barrel re-export at `src/api/supabaseClient.js` is the only import they use.

#### Permission system

```
super_admin  ├── bypass all checks (always full access)
admin        ┤
manager      ├── canDo(role, permissions, 'section', 'action')
technician   ┤
viewer       ┘
```

Use `canDo()` from `src/lib/permissions.ts` for all permission gating. Do not hardcode role strings — import from `ROLES` in `src/lib/constants.ts`.

#### Routing

React Router v6 with all routes declared in `App.jsx`. All pages are lazy-loaded. Parameterized routes use thin wrapper components (`ProductDetailsRoute`, `CustomerDetailsRoute`) so page components receive typed `id` props rather than calling `useParams()` themselves.

#### Real-time

Single Supabase Realtime channel `app_notifications` subscribed in `App.jsx`. RLS policy `user_read_targeted` filters row visibility server-side. Handlers write directly to the TanStack Query cache (`queryClient.setQueryData`) for instant UI updates.

---

## User Roles

| Role | Description | Key Access |
|------|-------------|-----------|
| `super_admin` | Full system access | Everything |
| `admin` | Full operational access | Everything except system internals |
| `manager` | Team lead access | Tickets, customers, inventory, reports |
| `technician` | Technician access | Assigned tickets, parts inventory |
| `viewer` | Read-only access | View-only on permitted sections |

Roles are stored in the `user_roles` table. Default permission sets are defined in `src/lib/permissions.ts` (`ROLE_DEFAULT_PERMISSIONS`). Admins can customize per-user permissions via the Control Panel.

---

## Routes

| URL | Page | Auth Required |
|-----|------|--------------|
| `/` | Dashboard | ✓ |
| `/rma-tickets` | RMA Tickets | ✓ |
| `/products` | Product Catalog | ✓ |
| `/products/:id` | Product Detail | ✓ |
| `/customers` | Customers | ✓ |
| `/customers/:id` | Customer Detail | ✓ |
| `/inventory` | Inventory | ✓ |
| `/parts` | Parts Inventory | ✓ |
| `/calendar` | Tech Calendar | ✓ |
| `/invoices` | Invoices | ✓ |
| `/reports` | Reports | ✓ |
| `/account` | Account Settings | ✓ |
| `/control-panel` | Control Panel | ✓ admin+ |
| `/tracker` | Public RMA Tracker | ✗ public |
| `/dashboard` | → redirects to `/` | |

---

## Testing

```bash
npm test
```

80 unit tests across 3 suites in `src/lib/`:

| Suite | Coverage |
|-------|---------|
| `constants.test.js` | All constant values and type correctness |
| `permissions.test.js` | `canDo()` across all role/permission combinations |
| `schemas.test.js` | Zod schemas with valid + invalid inputs |

Tests run in under 1 second via Vitest with jsdom environment.

---

## CI/CD

GitHub Actions runs automatically on every push and PR to `main`:

```
1. npm test              → all 80 tests must pass
2. npm run lint:ci       → zero ESLint warnings allowed
3. npm run build         → production build must succeed
```

The build step uses Supabase placeholder values from GitHub Secrets (falls back gracefully in CI).

---

## PWA

The app is installable as a Progressive Web App:

- **Manifest:** defined in `vite.config.js` — name, icons (`64×64`, `192×192`, `512×512`, maskable), theme color `#4f46e5`
- **Service worker:** Workbox `generateSW` strategy (auto-registered)
- **Pre-cached:** all static assets emitted by Vite
- **Supabase API:** `NetworkFirst` with 10s timeout, falls back to cache
- **Offline shell:** `/index.html` served for all navigation fallbacks

---

## Security

- **RLS enabled** on all tables — row visibility enforced at the database level
- **Anonymous uploads** restricted to 25 MB max; JPEG, PNG, GIF, WebP, PDF only
- **Edge Functions** validate the caller's JWT before any privileged operation
- **Service role key** lives only in Edge Function secrets — never in browser code
- **Public tracker** rate-limited via `public-track` Edge Function
- **Input validation** via Zod schemas before any database write

---

## Engineering Standards

This project follows the **myRMA Engineering Constitution** ([`CONSTITUTION.md`](CONSTITUTION.md)) — 18 sections covering every coding standard, architectural rule, and enforcement law.

Key rules for contributors:

1. **Never import `supabase` directly in page components** — always use `src/api/supabaseClient.js`
2. **Never re-implement shared components** — use `src/components/ui.jsx`
3. **Never hard-code status strings** — import from `src/lib/constants.ts`
4. **All permission checks use `canDo()`** from `src/lib/permissions.ts`
5. **All `localStorage` access uses `safeStorage`** from `src/lib/safeStorage.ts`
6. **All new `src/lib/` code has unit tests**
7. **Dark mode classes on every new UI component** (`dark:bg-gray-800` etc.)
8. **CI must pass** before merging to `main`
9. **All schema changes are SQL migration files** — no ad-hoc dashboard edits

---

## Contributing

1. Branch from `main`: `git checkout -b feature/your-feature`
2. Make changes following [`CONSTITUTION.md`](CONSTITUTION.md)
3. Run `npm test && npm run lint && npm run build` locally — all must pass
4. Open a PR — CI runs automatically
5. All checks must pass before merge

### Commit format

Follows [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(tickets): add bulk status update with optimistic UI
fix(auth): redirect to login on expired JWT
docs(readme): update setup guide
chore(deps): update tanstack query to v5.84
security(storage): restrict anonymous upload MIME types
```

---

## Reference Documents

| File | Purpose |
|------|---------|
| [`CLAUDE.md`](CLAUDE.md) | AI agent instructions — architecture patterns, gotchas, and rules |
| [`CONSTITUTION.md`](CONSTITUTION.md) | Engineering constitution — 18 sections of laws, standards, and enforcement |
| [`AUDIT_LOG.md`](AUDIT_LOG.md) | Full engineering audit history — all findings, fixes, and project scorecard |

---

*myRMA v2.0 · Built with React 18 · Vite 6 · Supabase · Tailwind CSS*
