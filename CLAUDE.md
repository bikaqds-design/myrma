# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # start dev server (Vite, port 5173)
npm run build      # production build
npm run preview    # preview production build
```

No test runner or linter is configured — there are no `test` or `lint` scripts.

## Environment

Copy `.env` and populate:
```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Both variables must be prefixed with `VITE_` to be visible in Vite.

## Architecture

### Single-page app with manual routing

The app uses **no React Router**. Navigation is managed entirely in `src/App.jsx` via `useState` (`currentPage`, `selectedProductId`, `selectedCustomerId`) combined with `window.history.pushState` / `popstate`. URL paths map to page names via `pathToPage()` and `pageToPath()` helpers at the top of `App.jsx`.

All top-level pages are lazy-loaded with `React.lazy`. `App.jsx` renders the correct page component based on `currentPage` state, passing down `currentUserRole`, `currentUserEmail`, and `currentUserPermissions` as props.

### Data layer

All Supabase access goes through `src/api/supabaseClient.js`, which exports:
- `auth` — sign-in, sign-out, password reset, profile updates
- `db` — namespaced CRUD helpers for every table (`db.products`, `db.customers`, `db.rmaTickets`, `db.inventory`, etc.)
- `storage` — file uploads (attachments, avatars, brand logos) to the `rma-attachments` bucket
- `branding` — company branding settings
- `notifications` — email templates, preferences, and the `send-email` Edge Function call
- `backup` — full data export/import

Never query `supabase` directly from page components; use these helpers.

Many optional tables (e.g. `announcements`, `custom_field_definitions`, `inventory_units`, `warehouses`) may not exist in every deployment. All `db.*` helpers that target these tables guard with `error.code === '42P01'` (table not found) and return `{ missing: true, data: [] }` instead of throwing.

### Permissions

Roles: `super_admin`, `admin`, `manager`, `technician`, `viewer`.

`super_admin` and `admin` bypass all permission checks. Other roles carry a `permissions` JSON object loaded from the `user_roles` table and passed down from `App.jsx` as `currentUserPermissions`. Default permission sets for `manager`, `technician`, and `viewer` are defined in `ROLE_DEFAULT_PERMISSIONS` in `App.jsx`.

Use the `canDo` pattern when gating UI actions — check `currentUserRole === 'super_admin' || currentUserRole === 'admin' || currentUserPermissions?.section?.action`.

### URL tab state

`src/hooks/useURLTab.js` — a lightweight hook that syncs a tab or sub-section selection with a URL query parameter. Used throughout page components so deep-links and browser back/forward work within a page:

```js
const [activeTab, setActiveTab] = useURLTab('tab', 'products')
```

### Appearance / theming

`src/contexts/AppearanceContext.jsx` provides global theming (dark mode, font, date/time format, sidebar compact mode, dashboard widget order). Settings are persisted to `rma_config` (key `appearance_settings`) and also cached in `localStorage` under `mrma_appearance`. Access via `useAppearance()`.

### Special routes

- `/tracker` — public-facing customer RMA tracker (`src/pages/RMATracker.jsx`), rendered without authentication, detected in `App.jsx` before the auth check.
- `/` through `/control-panel` — authenticated internal app.

### Control Panel

`src/pages/ControlPanel.jsx` hosts all admin-only sub-pages (User Management, Branding, RMA Config, Custom Fields, PDF Layout, Announcements, Audit Log, Data Cleanup, Backup/Restore, Integrations). It uses `useURLTab` to keep the active feature in the URL as `?feature=...`.

### CSV bulk upload

The Products and Customers pages support bulk CSV import. A custom `parseCSVLine` helper (local to those pages) handles quoted fields — do not use plain `split(',')` because product names can contain commas inside quotes.

### Notifications

Real-time notifications use a single Supabase Realtime channel (`app_notifications`) subscribed in `App.jsx`. Notification visibility is filtered client-side by `target_roles` and `target_emails`. Per-type preferences are stored in `localStorage` under `notif_system_prefs_<email>` and applied via a `notif-system-prefs-changed` window event.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
<!-- SPECKIT END -->
