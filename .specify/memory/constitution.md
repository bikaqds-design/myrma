<!--
  SYNC IMPACT REPORT
  ==================
  Version change: [blank template] → 1.0.0
  Status: Initial population — derived from CONSTITUTION.md v2.0 (May 2026)

  Principles filled:
    I.   Shared UI Library & Design Tokens (new)
    II.  API Layer Encapsulation (new)
    III. Security & RLS by Default (new)
    IV.  TanStack Query as the Data Layer (new)
    V.   No Magic Strings + TypeScript Discipline (new)

  Sections filled:
    "Architecture & Stack Constraints" (new)
    "Quality Gates & Workflow" (new)

  Templates reviewed:
    ✅ .specify/templates/plan-template.md — "Constitution Check" gate present; no stale references
    ✅ .specify/templates/spec-template.md — no principle references; no update needed
    ✅ .specify/templates/tasks-template.md — no principle references; no update needed
    ✅ No .specify/templates/commands/ directory exists

  Deferred items: none
-->

# myRMA Constitution

## Core Principles

### I. Shared UI Library & Design Tokens

All UI primitives MUST come from `src/components/ui.jsx` — Button, Input, Spinner, Badge,
ModalOverlay, ModalCard, Card, etc. Never re-implement these in page components.

Every new component MUST include dark mode classes using the Direction B design token pairs
(e.g. `bg-white dark:bg-[#121823]`, `border-[#e6e9ef] dark:border-[#212a38]`,
`text-[#211f1b] dark:text-[#e8ebf0]`). Stale `dark:bg-slate-*` or `dark:bg-gray-*` classes
MUST NOT be introduced in new code.

Card style is flat hairline — no shadows:
`bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px]`

Every user-visible string in new pages, components, and modals MUST use `t()` from
`react-i18next`. Both `en.json` and `ar.json` MUST be updated together. This is part of
the definition of done.

### II. API Layer Encapsulation

Page components MUST NEVER import `supabase` directly. All Supabase access goes through
the barrel re-export `src/api/supabaseClient.js` and the domain helpers in `src/api/db/`.

```js
// ✅ CORRECT
import { db } from '../api/supabaseClient.js'
const { data } = await db.rmaTickets.list()

// ❌ FORBIDDEN
import { supabase } from '../api/client.js'
supabase.from('rma_tickets').select('*')
```

Optional tables (those that may not exist in every deployment) MUST guard against
`error.code === '42P01'` and return `{ missing: true, data: [] }` instead of throwing.

JSONB columns in Postgres do NOT preserve object key order. Any ordered data crossing a
`jsonb` column MUST be stored as an **array**, never rely on `Object.values()` or
`Object.keys()` order after a JSONB round-trip.

### III. Security & RLS by Default

RLS is ALWAYS enabled on all tables — never disabled in production.

All RLS policies MUST use `public.rma_*` helper functions (`public.rma_user_role()`,
`public.rma_is_admin()`, etc.). `auth.user_role()` and similar do not exist.

Every new table MUST have RLS policies (SELECT, INSERT, UPDATE, DELETE) before use
in production.

Permission checks in UI MUST use `canDo(role, permissions, section, action)` from
`src/lib/permissions.ts`. `super_admin` and `admin` bypass all checks automatically —
do not replicate this logic in components.

Permissions MUST be resolved with `resolvePermissions(role, stored)` — never use
`stored || ROLE_DEFAULT_PERMISSIONS[role]` directly (empty `{}` is truthy and strips all perms).

Secrets (API keys, service role key) are ONLY in environment variables / Supabase Edge
Function secrets. The service role key MUST NEVER appear in browser-side code.

All Edge Functions MUST validate the caller's JWT before performing privileged operations.

XSS: never use `dangerouslySetInnerHTML` with user-controlled data. Code that writes raw
HTML MUST use the `esc()` helper to escape user-controlled fields.

### IV. TanStack Query as the Data Layer

`useQuery` is the ONLY permitted pattern for data fetching. `useEffect` + `setState` for
async data is FORBIDDEN.

Query keys MUST be stable lowercase arrays: `['tickets']`, `['customers', customerId]`.

After mutations, invalidate with `queryClient.invalidateQueries`. Optimistic updates MUST
always include a rollback on error via `onError` restoring the previous cache snapshot.

All local storage access MUST go through `safeStorage` from `src/lib/safeStorage.ts` —
never call `localStorage.*` directly (silently handles quota errors and Safari private mode).

### V. No Magic Strings + TypeScript Discipline

All status values, role names, config keys, storage keys, and notification types MUST come
from `src/lib/constants.ts`. Hard-coding strings like `'open'` or `'admin'` is FORBIDDEN.

All new files in `src/lib/` and `src/api/db/` MUST be TypeScript (`.ts`). Every
`src/api/db/` module exports Row type interfaces re-exported from `src/api/db/index.ts`.

No `any` without an `// eslint-disable-next-line @typescript-eslint/no-explicit-any` line
and an explanation comment. `no-undef` ESLint rule is set to `'error'` and MUST NOT be
weakened.

Before writing any utility function, search the codebase for an existing equivalent.
Key utilities that MUST NOT be duplicated: `canDo()`, `parseCSVLine()`, `safeStorage`,
`useURLTab()`, `captureException()`, `useAppearance()`.

## Architecture & Stack Constraints

The technology stack is **LOCKED**. No framework-level dependency may be added without
written team approval in the PR description.

| Layer | Technology |
|-------|-----------|
| UI | React 18 — functional components + hooks only; no class components |
| Build | Vite 6 (dev port 5173) |
| Routing | React Router v6 — `BrowserRouter` in `main.jsx`, routes in `App.jsx` |
| Data | TanStack Query v5 — `QueryClientProvider` in `main.jsx` |
| Styling | Tailwind CSS v3 — utility-first, no CSS-in-JS, no external CSS files |
| Database | Supabase (PostgreSQL) |
| Auth | Supabase Auth — JWT tokens, RLS enforced |
| Testing | Vitest — unit tests in `src/lib/` |
| Linting | ESLint 9 flat config — zero errors target |

Provider order in `src/main.jsx` is **fixed**:
`StrictMode > ErrorBoundary > BrowserRouter > QueryClientProvider > AppearanceProvider > App`

`TooltipProvider` from Radix MUST remain inside `App.jsx`. Removing it causes a blank page.

All top-level page routes use `lazyWithReload()` (not bare `React.lazy`). Route declarations
live exclusively in `src/App.jsx`. `window.location.href` and `window.history.pushState`
are FORBIDDEN for top-level navigation — use `useNavigate()`. The sole exception is the
`?ticket=<id>` in-page state in `RMATickets/index.jsx`, which MUST be documented in a comment.

All schema changes are SQL migration files in `supabase/migrations/YYYYMMDD_description.sql`.
Migrations are idempotent (`IF NOT EXISTS`, `DROP POLICY IF EXISTS`). No ad-hoc schema
changes via the Supabase dashboard without a corresponding migration file committed to git.

## Quality Gates & Workflow

CI pipeline (GitHub Actions, runs on every push/PR to `main`):

```
1. npm test          — Vitest (currently 80 unit tests — must all pass)
2. npm run lint:ci   — ESLint (zero errors gate)
3. npm run build     — Vite production build (must succeed)
```

No merges to `main` with failing CI. No exceptions.

Before pushing any commit, run locally:
```
npm test && npm run lint && npm run build
```

After generating or modifying `src/lib/` code, run `npm test` to verify tests still pass.
After significant UI changes, run `npm run build` to confirm no bundling errors.

Commit format: Conventional Commits `<type>(<scope>): <description>`. Types: `feat`, `fix`,
`chore`, `refactor`, `docs`, `test`, `perf`, `security`. Subject is imperative, lowercase,
no period, ≤ 72 characters.

Database migrations run **before** frontend deploy. Edge Function deploys are tested in
staging when they involve auth or data mutation logic.

If a service role key is accidentally committed: revoke immediately, rotate, update Edge
Function secrets, force-push to scrub history, audit access logs.

## Governance

**Authoritative document**: `CONSTITUTION.md` in the repository root is the single source
of truth for all engineering decisions. This file (`constitution.md`) is the Speckit
planning digest — it captures the key non-negotiable principles used during feature
specification and plan reviews.

**Amendments**: Constitution changes require a PR reviewed by the project lead, committed
as `docs(constitution): <description>`. All changes MUST be logged in `AUDIT_LOG.md`.

**Versioning policy**:
- MAJOR — backward-incompatible governance changes; principle removals or redefinitions
- MINOR — new principle or section added; materially expanded guidance
- PATCH — clarifications, wording fixes, non-semantic refinements

**Compliance review**: The "Constitution Check" gate in `plan-template.md` MUST be
evaluated before Phase 0 research and re-checked after Phase 1 design on every feature plan.

**AI agent compliance**: AI coding agents (Claude Code, etc.) are governed by Section 17
of `CONSTITUTION.md`. The 16 mandatory laws (L-01 through L-16) in Section 18 are
zero-tolerance — any violation must be reverted immediately.

**Version**: 1.0.0 | **Ratified**: 2026-06-08 | **Last Amended**: 2026-06-08
