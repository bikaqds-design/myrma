# Phase 1 — Audit Findings

Date: 2026-09-02 · Commit `2d8c17d`

**18 of 38 findings are closed** (rows marked ✅), including **all 6 Criticals**.
Remaining: 0 Critical, **4 High**, 12 Medium, 4 Low.

IDs are permanent. `[rendered, not persisted]` marks a finding observed in the
running app but without a saved screenshot (see `00-INVENTORY.md §8`).

Severity per Appendix B. Effort: `S` < 1h, `M` half day, `L` multi-day.

---

## GLOBAL — cross-cutting

| ID | Screen | Issue | Lens | Sev | Eff | Fix summary | Files |
|---|---|---|---|---|---|---|---|
| UX-GLOBAL-001 | All | 125 distinct hardcoded hex colours and 5,648 arbitrary Tailwind values bypass the 52 tokens already declared | Consistency | High | L | Map the top 20 colours (covering ~85% of uses) to semantic tokens; codemod; lint against raw hex | `src/styles/tokens.css`, app-wide |
| ✅ UX-GLOBAL-002 (CLOSED — named z-index ladder) | All | No z-index ladder. Tailwind `z-10…z-50` coexists with `z-[60]`, `z-[70]`, `z-[200]`, `z-[400]`, `z-[500]` | Consistency | Medium | S | Define 6 named layers; replace all | app-wide |
| ✅ UX-GLOBAL-003 (CLOSED e49bde5) | All (RTL) | Signed numbers and trailing punctuation render wrong in Arabic. `+8%` displays as `8%+`; `Forgot password?` displays as `?Forgot password` | RTL | **Critical** | M | Apply the existing `<Ltr>` wrapper to every number, currency, percentage, SKU, serial, phone and ID | `src/components/ui.jsx` (Ltr), all value renderers |
| ✅ UX-GLOBAL-004 (CLOSED — codemod) | All (RTL) | 378 `text-left`/`text-right` against 8 `text-start`/`text-end`; 103 `ml-/mr-`, 85 `left-/right-` | RTL | High | L | Codemod physical → logical; add an ESLint rule to prevent regression | app-wide, `src/styles/rtl.css` |
| ✅ UX-GLOBAL-005 (CLOSED 18e6ed5) | All | 40 sites dump raw Postgres/Supabase errors into toasts | Feedback | High | M | Central `toUserMessage(error)` mapping constraint/RLS classes to AR+EN copy | `CommentPanel.jsx:96,125,151`, `ProductDocuments.jsx:92,122`, +35 |
| UX-GLOBAL-006 | All | Only 14 of 115 page files have an empty state | Feedback | High | L | `EmptyState` on every list/table/widget, with its primary action | `src/components/EmptyState.jsx` (exists, 14 uses) |
| ⏸ UX-GLOBAL-007 (DEFERRED — opportunistic; primitive built, 4 of ~64 migrated) | All | No shared Table. 72 raw `<table>` across 50 files | Consistency | High | L | Build `Table` with sort/filter/pagination/bulk-select; migrate per module | `src/components/ui/Table/` (empty dir) |
| UX-GLOBAL-008 | All | Kit adoption: Button 57%, Input 41%, Textarea 40%, Select 29% | Consistency | High | L | Migrate call sites per component per commit | `src/components/ui.jsx` |
| UX-GLOBAL-009 | All | Loading is a spinner (24 files) far more often than a skeleton (15) | Perceived perf | Medium | M | Skeletons matched to final layout on list/detail routes | per module |
| ✅ UX-GLOBAL-010 (CLOSED c543dee) | All | Toasts hardcode `position="top-right"` in all 8 mounts regardless of direction | RTL | Medium | S | Derive position from direction (top-left in RTL) | `src/App.jsx:1074–1175` |
| ✅ UX-GLOBAL-011 (CLOSED c543dee) | All | The app-shell Toaster is the only one without `toastOptions`, so in-app toasts are styled differently from auth/tracker toasts | Consistency | Low | S | Pass `toastOptions` to the shell mount | `src/App.jsx:1175` |
| UX-GLOBAL-012 | — | ~~`ar.json` has more keys than `en.json`~~ **RETRACTED — not a defect.** The 47 extra Arabic keys are CLDR plural forms (`_zero/_one/_two/_few/_many`) that Arabic requires and English does not. Correct i18n practice. | i18n | ~~Medium~~ **None** | — | No action | `src/locales/*.json` |
| ~~UX-GLOBAL-016~~ (RETRACTED — 23 of 26 are legitimately identical, 2 are language names correctly in their own script, 1 is a technical term with no standard Arabic form) | — | 21 keys have an Arabic value identical to the English. Most are legitimate (CLI commands, `English (en)`, `VIP`, phone placeholders) but a few are genuinely untranslated, e.g. `cp.webhooks.header = "Webhooks"` | i18n | Low | S | Review the 21; translate the real ones, add a comment marker to the deliberate ones | `src/locales/ar.json` |
| ~~UX-GLOBAL-017~~ | Lists with pagination (RTL) | ~~Pagination arrows point the wrong way in Arabic~~ **RETRACTED — measured in the running app and they are correct.** Previous carries a right-arrow at x=196, Next a left-arrow at x=10; in RTL that is right. Raised from misreading a screenshot. | RTL | ~~Medium~~ **None** | — | No action | — |
| ✅ UX-GLOBAL-013 (CLOSED c543dee) | — | Empty `src/components/ui/Form/` and `ui/Table/` directories, untracked by git | Consistency | Low | S | Delete, or build the Table that was intended | `src/components/ui/` |

### UX-GLOBAL-003 — detail (Critical)

Evidence: `design/audit/screens/auth/login--ar--desktop.png` shows the link
rendering as **`?Forgot password`**. The Arabic dashboard `[rendered, not persisted]`
shows trend deltas as **`8%+ ↑`** instead of `↑ +8%`.

This is Critical rather than High because it corrupts *displayed data*: a
mis-ordered number is a wrong number to the reader, and this appears on
financial figures. The RMA/warehouse team already hit this class of bug in
manual QA on 2026-08-05 and the fix was written — `<Ltr>` in `ui.jsx`, whose
comment documents exactly this. It is used **6 times** in the whole codebase.
The remedy is adoption, not invention.

### UX-GLOBAL-004 — detail (High)

`rtl.css` is 48 lines of `!important` overrides patching the sidebar by hand,
which is the symptom of 640+ physical properties underneath. Every new screen
adds to the debt. The lint rule matters more than the codemod: without it this
regresses within weeks.

---

## AUTH — Login, password reset, invitation

| ID | Screen | Issue | Lens | Sev | Eff | Fix summary | Files |
|---|---|---|---|---|---|---|---|
| ✅ UX-AUTH-001 (CLOSED e49bde5) | Login | **Zero `t()` calls.** Entire screen hardcoded English — "Email", "Password", "Forgot password?", "Sign In", "RMA Management System" | i18n | **Critical** | M | Route every string through `t()`; add keys to both locales | `src/pages/Login.jsx` |
| ✅ UX-AUTH-002 (CLOSED c543dee) | Set password | **Zero `t()` calls.** Same problem on the invitation screen | i18n | **Critical** | S | Route through `t()` | `src/pages/ResetPassword.jsx` |
| ✅ UX-AUTH-003 (CLOSED c543dee) | Login | Subtitle reads "RMA Management System" while `index.html` and the PWA manifest now say "Business Management" — three taglines in one product | Consistency | Medium | S | Single source for the tagline | `src/pages/Login.jsx:79` |
| ✅ UX-AUTH-004 (CLOSED c543dee) | Login (RTL) | Email/password inputs right-align Latin placeholders (`admin@example.com`); no `dir="ltr"` isolation on identifier fields | RTL | High | S | `dir="ltr"` on email, password, phone, serial inputs | `src/pages/Login.jsx:93,117` |
| ✅ UX-AUTH-005 (CLOSED 18e6ed5) | Login | No language switcher before sign-in. An Arabic user cannot change language until after logging into an English-only screen | i18n | High | M | Language toggle on the auth screens | `src/pages/Login.jsx` |

### UX-AUTH-001/002 — detail (Critical)

Evidence: `grep -c "t('" src/pages/Login.jsx` → **0**. Same for
`ResetPassword.jsx`. Screenshot `login--ar--desktop.png` shows the page fully in
English with `dir="rtl"` applied — so labels are right-aligned English, which is
the worst of both.

Severity is Critical under Appendix B ("the screen is broken in RTL") and because
these are the **first and second screens a new Arabic-speaking colleague ever
sees**: the login page, and the invitation page where they set their password.

**Disclosure:** `ResetPassword.jsx`'s invitation copy was written by me earlier
today (commit `f35e833`). I typed English directly into the component instead of
adding locale keys. UX-AUTH-002 is my defect.

---

## DASHBOARD

| ID | Screen | Issue | Lens | Sev | Eff | Fix summary | Files |
|---|---|---|---|---|---|---|---|
| ✅ UX-DASH-001 (CLOSED c543dee) | `/` (RTL) | Date-range chips "All / 30d / 7d / Today" remain untranslated English and in LTR order while the rest of the page is Arabic | i18n | High | S | Translate; order by direction | `src/pages/Dashboard.jsx` |
| ✅ UX-DASH-002 (CLOSED c543dee) | `/` (RTL) | Trend deltas render `8%+ ↑` — instance of UX-GLOBAL-003 | RTL | Critical | S | Wrap in `<Ltr>` | `src/pages/Dashboard.jsx` |
| UX-DASH-003 | `/` | Sparklines run left-to-right in RTL, so time flows against reading direction | RTL | Low | M | Mirror the time axis in RTL, or state the convention deliberately | `DashboardCharts.jsx` |
| ✅ UX-DASH-004 (CLOSED — "View all" was an inert span; now a real link) | `/` | Widgets show counts but it is not established whether each links to the filtered list behind it | Flow | Medium | M | Verify every widget deep-links | `src/pages/Dashboard.jsx` |

`[rendered, not persisted]` — verified live in Arabic at 1440×900.

---

## FIRST-RUN / ONBOARDING

Evidence: `design/audit/screens/rma/rma-tickets--admin--ar--desktop.png`

| ID | Screen | Issue | Lens | Sev | Eff | Fix summary | Files |
|---|---|---|---|---|---|---|---|
| ✅ UX-ONBOARD-001 (CLOSED e49bde5) | Onboarding modal | Modal body is English inside an Arabic RTL page: "Welcome to myCRM!", "Your RMA and repair management system is ready…", "Reports & analytics", "Next", "Skip". Only 4 `t()` calls in the file | i18n | **Critical** | M | Route all copy through `t()` | `src/components/OnboardingWizard.jsx` |
| ✅ UX-ONBOARD-002 (CLOSED e49bde5) | Onboarding modal | Bidi punctuation: renders `!Welcome to myCRM` and `.minutes` — terminal punctuation jumps to the leading edge | RTL | Critical | S | Wrap English strings in `<Ltr>`, or translate (which removes the cause) | same |
| ✅ UX-ONBOARD-003 (CLOSED e49bde5) | Onboarding modal | `→ Next` arrow points right in RTL, i.e. backwards | RTL | High | S | Mirror directional glyphs by direction, or use a logical icon | same |
| ~~UX-ONBOARD-004~~ (RETRACTED as written — the wizard is gated to admin/super_admin, not "every new user", and is dismissible) | Onboarding modal | Blocks the whole screen on first login for every new user, over the ticket table | Flow | Medium | S | Make dismissable without covering the primary table, or defer to first idle | same |

This is the **first thing a newly invited Arabic-speaking colleague sees** after
setting their password — an English modal with punctuation on the wrong side and
an arrow pointing the wrong way.

---

## PERMISSIONS — degradation behaviour

Verified across 5 roles by scripted capture (`design/audit/capture-log.json`).

**Access control itself is sound.** Sidebar items filter correctly per role —
admin 15 nav items, manager 14, sales_rep 8, technician 7, viewer 7 — and a
`viewer` requesting `/control-panel` does **not** get the Control Panel.

| ID | Screen | Issue | Lens | Sev | Eff | Fix summary | Files |
|---|---|---|---|---|---|---|---|
| ✅ UX-GLOBAL-014 (CLOSED 18e6ed5) | Any gated route | A role without access is **silently redirected to the Dashboard** with no message. The user clicks a link and lands somewhere else with no explanation | Feedback | High | M | Show a denial that names the permission needed and who to ask, per the brief §9 | `src/App.jsx` route guards |
| ✅ UX-GLOBAL-015 (CLOSED 18e6ed5) | Shared components | `Modal.jsx` and `EmptyState.jsx` contain **zero** `t()` calls, so any default copy they render cannot be translated by callers | i18n | High | S | Thread `t()` through, or require callers to pass translated copy | `src/components/Modal.jsx`, `EmptyState.jsx` |

Evidence for UX-GLOBAL-014: `control-panel--viewer--en--desktop.png` shows the
Dashboard, not a denial screen.

---

## Modules not yet individually audited

The following were inventoried (routes, file sizes, kit adoption, state coverage
all counted in `00-INVENTORY.md`) but **not yet walked screen by screen**, because
authenticated screenshot capture is blocked pending your decision in
`00-INVENTORY.md §8`:

RMA, Inventory, Sales Funnel (Leads + Pipeline), Purchases, Sales Documents,
Accounting, Activities, Products, Customers, Reports, Calendar, Knowledge Center,
Control Panel (~12 sub-tabs), Account Settings.

Global findings above apply to all of them — the adoption, token, RTL, empty-state
and error-handling numbers are whole-codebase measurements. What is missing is
the per-screen hierarchy and flow-efficiency analysis, which requires rendering
each screen with real data.

Their largest components are already flagged as risk:
`Reports.jsx` (1,976 lines), `CustomerDetails.jsx` (1,914),
`RMATickets/index.jsx` (1,779).

---

## DECISIONS (resolved 2026-09-02)

| # | Question | Decision |
|---|---|---|
| ND-1 | How to capture authenticated screens | **(a)** Disposable per-role fixtures. Done: 60 screenshots across 5 roles; fixtures deleted and deletion verified. |
| ND-2 | 40-key gap between `ar.json` and `en.json` | **Closed by investigation, not a defect.** The extra Arabic keys are CLDR plural forms. `UX-GLOBAL-012` retracted; `UX-GLOBAL-016` opened for 21 genuinely-identical values. |
| ND-3 | Which tagline is canonical | **"Business Management" hardcoded everywhere.** The login subtitle changes from "RMA Management System" to match the tab and installed app. No branding lookup on the login screen. Closes `UX-AUTH-003`. |
| ND-4 | Is dark mode in scope | **In scope — audit and fix it too.** |
| — | Next session | Quick wins, then the lint guards. |

### What ND-4 adds to remaining scope

Dark mode being in scope changes three things, and none of it is done yet:

1. **The 69 screenshots captured so far are light-mode only.** The matrix grows to
   light/dark × LTR/RTL × desktop/mobile. The capture scripts need a `dark`
   dimension (toggle `html.dark` in `addInitScript`) and a re-run.
2. **Phase 2 contrast work roughly doubles** — every text/background pair needs an
   AA ratio in both themes, not one.
3. **New finding class:** the 125 hardcoded hex colours include dark-mode values
   (`#0f1520`, `#121823`, `#1a2230`, `#212a38` are among the most repeated). Those
   are currently applied via `dark:` variants on raw hex rather than semantic
   tokens, so the token migration in `UX-GLOBAL-001` must carry a dark value for
   every semantic role rather than a single colour.

No dark-mode findings have been raised yet. That is the first thing the per-module
audit must add.

