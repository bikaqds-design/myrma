# myCRM — UI/UX Audit & Improvement Prompt (for Claude Code)

> **How to use this file:** drop it in the repo root next to `FULL_SYSTEM_AUDIT_PROMPT.md`.
> Start Claude Code in the repo and say:
> `Read UI_UX_AUDIT_AND_IMPROVEMENT_PROMPT.md and execute Phase 0 and Phase 1 only. Stop and wait for my review.`
> Then advance one phase per session. Never let it run Phases 2–9 unattended in one go.

---

## 1. Role and mission

You are acting as the **lead product designer + senior frontend engineer** on myCRM. The application works functionally, but the interface is inconsistent, visually dated in places, and slow to operate. Your mission is to raise it to the standard of a commercial CRM (the benchmark set is Odoo CRM and Zoho CRM) **without changing business logic or breaking existing behaviour**.

Two things you are explicitly *not* doing:

1. Not a rewrite. No new framework, no component-library swap, no router replacement, no state-management migration — unless you propose it in the audit and I approve it separately.
2. Not a re-skin. Cosmetic polish on a confusing screen is wasted work. Fix information hierarchy and flow first, aesthetics second.

## 2. Project context

- **Stack:** React frontend, Supabase (Postgres + Auth + Storage + RLS), Node.js services.
- **Origin:** started as `myRMA`, an RMA / service-ticket tool, now being expanded into a full CRM. Expect layered-on screens that never got a design pass and older screens that don't match newer ones.
- **Core modules:** Sales Funnel, RMA, Inventory, Approvals, Purchases — plus dashboard, auth, admin/settings, and notification surfaces.
- **Hard constraints (non-negotiable):**
  - **Arabic / RTL is a first-class locale, not an afterthought.** Every change must render correctly in both LTR and RTL. Arabic is the primary language for a large share of users.
  - **Role-based permissions** drive what renders. UI must degrade gracefully per role — never show a control the role cannot use, never leave a blank panel where a permission gate fired.
  - **PWA / mobile:** the app is installed and used on phones in the field. Mobile is a supported target, not a stretch goal.
  - **WhatsApp notification flows** have UI touchpoints (templates, send confirmations, delivery status) — treat them as part of the surface area.

Do not trust this description over the code. **Verify everything against the actual repo** and correct me in your audit where it's wrong.

## 3. Ground rules

1. **Discover before you judge.** Read the code, run the app, look at real screens. No recommendations based on assumptions about what a CRM "usually" looks like.
2. **Evidence per claim.** Every issue you raise cites a file path (and line where useful) or a screenshot. No vague "the design feels cluttered."
3. **Phases are gates.** Finish a phase, write its deliverable, stop, and summarise. Wait for my approval before the next phase.
4. **Small, reviewable commits.** One concern per commit, conventional-commit style: `fix(ui): …`, `refactor(ui): …`, `feat(ui): …`, `a11y: …`, `rtl: …`. Never mix a token refactor with a page redesign.
5. **No behaviour drift.** If a fix requires touching a query, a mutation, a permission check, or a Supabase call, stop and ask. Flag it as `NEEDS-DECISION` in the audit instead of doing it quietly.
6. **Prove it still builds.** After every phase: install, typecheck/lint, build, and exercise the affected screens. Report the actual command output, not "should be fine."
7. **Both directions, every time.** Any visual change gets checked in `dir="ltr"` and `dir="rtl"` before you call it done.
8. **Ask when the intent is unclear.** If you can't tell what a screen is *for*, ask me rather than guessing and redesigning around the wrong job.

## 4. Phase 0 — Discovery and inventory

Goal: know the surface area before touching it.

**Do:**

- Map the app: routes, layouts, page components, shared components, and which module each belongs to. Note orphans and dead routes.
- Inventory the styling reality: which of Tailwind / CSS modules / styled-components / plain CSS / inline styles / a UI kit are actually in use, and where they collide. Count how many different ways a button, input, modal, table, badge, and toast are currently implemented.
- Extract the de-facto design tokens *as they exist today*: every distinct colour, font size, font weight, spacing value, border-radius, shadow, and z-index in the codebase. The size of these lists is itself a finding.
- List the state coverage per screen: does it have loading, empty, error, partial-permission, and offline states — or does it show a blank page?
- Capture screenshots. If Playwright (or similar) is available or installable, script it: for every significant route, capture LTR desktop, RTL desktop, and mobile (390×844). Save to `design/audit/screens/<module>/<route>--<locale>--<viewport>.png`. If you cannot run the app, say so plainly, explain what you tried, and tell me exactly what you need from me (env vars, seed data, a Supabase test project, a login) — do not silently fall back to code-only analysis.
- Note which screens you could not reach and why (permission-gated, needs seed data, broken).

**Deliverable:** `design/audit/00-INVENTORY.md` + the screenshot folder.

## 5. Phase 1 — Audit report

Goal: a prioritised, evidence-backed list of everything wrong, with fixes costed.

Review each screen against these lenses, and organise findings **by module and screen**, not by lens:

1. **Information hierarchy** — is the primary action obvious within two seconds? Is the most important data the most prominent? Are page titles, breadcrumbs, and section headers consistent and truthful?
2. **Consistency** — spacing, type scale, colour use, icon set, button hierarchy (primary/secondary/ghost/destructive), form layout, table conventions, date/number/currency formatting, terminology. Inconsistency is the most likely dominant finding on this codebase.
3. **Flow efficiency** — click and keystroke count for the top task in each module (create a lead, log an RMA, approve a request, receive stock, raise a PO). Where does the user bounce between screens, retype data the system already has, or lose work on navigation?
4. **Feedback and state** — does every action confirm itself? Are destructive actions guarded? Are async operations visibly pending? Are errors specific and recoverable, or a raw Supabase/Postgres message dumped on screen? Are toasts consistent in position, duration, and tone (check RTL positioning)?
5. **Forms** — label placement, required-field marking, inline vs on-submit validation, error-message clarity, tab order, autofocus, unsaved-changes protection, sane defaults, sensible input types on mobile.
6. **Data density** — tables and lists: column choice, alignment (numbers right, text start-aligned per direction), truncation vs wrapping, sort/filter/search discoverability, pagination vs infinite scroll, row actions, bulk actions, saved views. Long-list performance.
7. **Navigation** — sidebar/topbar structure, module grouping, active-state clarity, depth, mobile navigation, deep-link and back-button behaviour, RTL mirroring of the nav.
8. **RTL and i18n** — hardcoded strings, physical CSS properties (`margin-left`, `padding-right`, `left`, `right`, `text-align: left`) where logical ones belong (`margin-inline-start`, `inset-inline-start`, `text-align: start`), unmirrored directional icons (chevrons, arrows, back buttons), mixed-direction text (Arabic labels with Latin SKUs/serials/phone numbers — check bidi isolation), Arabic numeral handling, Arabic-appropriate font and line-height, date/calendar direction, Arabic text in charts and PDFs/exports.
9. **Accessibility (WCAG 2.2 AA)** — colour contrast, keyboard reachability of every interactive element, visible focus, semantic HTML vs `div` soup, form-label association, modal focus trap and restore, `aria-live` for async results, icon-only buttons without accessible names, hit-target size, `prefers-reduced-motion`.
10. **Responsive and PWA** — breakpoint behaviour, tables on narrow screens, modal/drawer choice on mobile, touch-target size, safe-area insets, install/update prompt, offline and reconnect messaging.
11. **Perceived performance** — layout shift, spinner-only screens where skeletons belong, over-fetching, unvirtualised long tables, unnecessary full-page reloads, bundle weight of the heaviest routes.
12. **Visual craft** — alignment and optical rhythm, contrast and colour harmony, elevation logic, empty-state design, iconography coherence, dark mode if present (and whether it should be).

**Findings format** — one entry per issue, in a table per screen plus expanded detail for anything Critical/High:

| ID | Screen | Issue | Lens | Severity | Effort | Fix summary | Files |
|----|--------|-------|------|----------|--------|-------------|-------|

- **ID:** `UX-<MODULE>-<nnn>`, e.g. `UX-RMA-014`. IDs are permanent — later phases reference them.
- **Severity:** `Critical` (blocks or corrupts a task, or breaks RTL/permissions), `High` (frequent friction or accessibility failure), `Medium` (inconsistency, avoidable confusion), `Low` (polish).
- **Effort:** `S` (< 1h), `M` (half day), `L` (multi-day / needs design decision).
- Mark anything needing my input as `NEEDS-DECISION` with the specific question and 2–3 options.

**Deliverables:**

- `design/audit/01-AUDIT.md` — full findings, grouped by module.
- `design/audit/01-SUMMARY.md` — max two pages: top 10 issues by impact, the 3–5 systemic root causes, a recommended sequencing plan, and a "quick wins" list of Critical/High + `S` items.

Then **stop**. Do not start fixing.

## 6. Phase 2 — Design foundation

Goal: one source of truth for visual decisions, so later phases stop reinventing.

- Propose a token system first, in `design/DESIGN_SYSTEM.md`, and get my sign-off before applying it: colour palette (with semantic roles — surface, border, text, primary, success, warning, danger, plus module accents if justified), type scale, spacing scale, radii, shadows, z-index ladder, motion durations and easings, breakpoints.
- **Typography must work in both scripts.** Pick a Latin/Arabic pairing that shares weight and rhythm, set Arabic-specific line-height and letter-spacing (Arabic needs more leading and no tracking), and check numeral rendering. Say what you chose and why.
- Ground the palette in this product's actual job: dense internal B2B tooling used all day, often on cheap screens in bright rooms. Prioritise legibility, contrast, and calm over decoration. Do not reach for the default "AI-generated SaaS" look — identical rounded cards with the same soft grey shadow, gradient washes as decoration, tracked-out all-caps eyebrow labels, arrows appended to button text. Make deliberate choices and defend them in one line each.
- Implement tokens in the existing styling system (extend the Tailwind theme, or a CSS custom-property layer — whichever the repo already leans on). **Do not introduce a second styling paradigm.**
- Colour contrast: every text/background pair must pass AA. Report the computed ratios for the palette in a table.
- Dark mode: recommend in or out, with reasoning. If out, still structure tokens so it's possible later.

**Deliverables:** `design/DESIGN_SYSTEM.md`, the token implementation, and a `/design-system` preview route (dev-only, gated out of production builds) rendering every token and component state in LTR and RTL.

## 7. Phase 3 — Component normalisation

Goal: kill the duplicates. Every screen uses the same primitives.

- Consolidate the duplicate implementations found in Phase 0 into a single canonical component each: Button, IconButton, Input, Select, Combobox/search, DatePicker, Checkbox/Radio/Switch, Textarea, FormField (label + hint + error), Table (with sort/filter/pagination/bulk-select), Card, Modal/Drawer, Tabs, Badge/StatusChip, Toast, Tooltip, Pagination, Avatar, Skeleton, EmptyState, ErrorState, ConfirmDialog, PermissionGate.
- Every component ships with: all interaction states (default/hover/focus-visible/active/disabled/loading/error/read-only), RTL correctness, keyboard support, accessible names and roles, and mobile sizing.
- **Status chips** need one shared vocabulary and colour mapping across modules — RMA status, approval status, PO status, and lead stage should not each invent their own colours.
- Migrate callers incrementally, one component per commit, and delete the old implementation in the same commit. No parallel component sets left standing.
- Report a migration table: component → number of call sites migrated → call sites remaining → why.

**Deliverable:** `design/03-COMPONENTS.md` with the migration table and usage examples per component.

## 8. Phase 4 — Screen and flow redesign, module by module

Handle **one module per session**, in the order I approve (suggest an order based on impact in your summary). For each module:

1. State the module's top 3 user tasks and the current click/keystroke cost of each.
2. Propose the redesign in text + ASCII wireframe *before* coding. Cover: layout, hierarchy, what gets promoted, what gets cut, what moves.
3. After my approval, implement, referencing the audit IDs each change closes.
4. Re-screenshot LTR/RTL/mobile, and put before/after pairs in `design/audit/after/<module>/`.
5. Report the new click/keystroke cost against the old.

Module-specific expectations:

- **Sales Funnel** — pipeline legibility at a glance, stage transitions (drag-and-drop must have a keyboard-accessible equivalent), lead detail as a single coherent page rather than scattered tabs, activity timeline, next-action prominence.
- **RMA / service tickets** — fast intake (this is a counter/phone workflow: minimise fields, maximise defaults and lookups), clear status lifecycle, serial/SKU input that tolerates scanners and mixed-direction text, customer comms history including WhatsApp sends and delivery state, attachment handling.
- **Inventory** — dense tables that stay readable, search and filter that find things in one try, stock-level visual encoding, movement history, mobile scanning-friendly layouts.
- **Approvals** — the whole point is deciding quickly: queue with sufficient context inline, approve/reject without leaving the list, bulk handling where safe, unambiguous audit trail, reason capture on rejection.
- **Purchases** — multi-line document editing that doesn't lose work, running totals always visible, supplier context at hand, clear draft→submitted→received progression.
- **Dashboard** — answer "what needs me today," per role. Cut vanity metrics. Every widget links to the filtered list behind it.
- **Auth, settings, admin** — usually the most neglected screens; they set first impressions and are where role/permission UI lives.

## 9. Phase 5 — Cross-cutting UX passes

Run these as separate focused passes, each with its own commits:

- **Forms and data entry:** consistent validation timing, specific error copy in both languages, unsaved-changes guard, autosave for long forms, keyboard-first flow, sane mobile keyboards.
- **Errors and permissions:** map every raw Supabase/Postgres error class to human copy (AR + EN). Never surface a constraint name to a user. Permission denials explain what's needed and who to ask.
- **Empty and first-run states:** every list, table, and widget gets a designed empty state with the primary action in it.
- **Search, filter, saved views:** one consistent pattern app-wide; filters reflected in the URL so views are shareable and survive refresh.
- **Keyboard and power-user affordances:** global search/command palette, per-row shortcuts, `Esc`/`Enter` conventions in modals, a discoverable shortcut reference.
- **Notifications:** in-app notification surface consistent with WhatsApp send states; no silent failures.

## 10. Phase 6 — Accessibility and RTL hardening

- Run automated checks (axe/Lighthouse) on every route in both directions; fix all Critical/Serious, triage the rest.
- Manual keyboard-only pass through the top task of each module. Manual screen-reader spot-check of forms, tables, and modals.
- Add a lint rule or CI check against physical CSS properties and hardcoded strings, so RTL and i18n regressions can't creep back.
- **Deliverable:** `design/06-ACCESSIBILITY.md` — before/after scores per route, remaining known gaps, and the guard rules added.

## 11. Phase 7 — Responsive, PWA, and perceived performance

- Breakpoint pass on every screen; tables get a deliberate narrow-screen strategy (card view, horizontal scroll with sticky first column, or column priority — choose per table and justify).
- Touch targets ≥ 44px, safe-area insets, no hover-only affordances.
- PWA: install prompt, update-available prompt, offline shell, clear offline/reconnect messaging, and honest behaviour for actions attempted offline.
- Perceived speed: skeletons matched to final layout, route-level code splitting, virtualisation for long lists, pagination pushed to Supabase queries, eliminate layout shift.
- **Deliverable:** `design/07-PERFORMANCE.md` — Lighthouse and bundle-size before/after for the five heaviest routes.

## 12. Phase 8 — Verification and regression guard

- Full manual regression pass over the top task per module, per role (at minimum: admin, sales, technician, approver — use the roles actually in the code), in both directions, on desktop and mobile.
- Visual regression baseline captured, so future changes are diffable.
- **Deliverable:** `design/08-QA-CHECKLIST.md` — a reusable checklist for future UI work, plus results of this run.

## 13. Phase 9 — Handover

- `design/UI_GUIDELINES.md`: how to build a new screen in this app — which primitives to use, layout patterns, RTL rules, permission-gating pattern, copy tone in AR and EN, do's and don'ts with code snippets. Written so a new developer needs no further explanation.
- `design/BACKLOG.md`: every audit ID not closed, with severity, effort, and reason deferred.
- Final report: what changed, what it closed, what it cost, what's left, and the three highest-value next steps.

## 14. Deliverable file layout

```
design/
  DESIGN_SYSTEM.md
  UI_GUIDELINES.md
  BACKLOG.md
  audit/
    00-INVENTORY.md
    01-AUDIT.md
    01-SUMMARY.md
    03-COMPONENTS.md
    06-ACCESSIBILITY.md
    07-PERFORMANCE.md
    08-QA-CHECKLIST.md
    screens/<module>/...
    after/<module>/...
```

## 15. Reporting format for every session

End each session with exactly this, and nothing padded around it:

1. **Phase and scope** — what you covered.
2. **Findings or changes** — audit IDs opened or closed.
3. **Commands run and their real output** — build, lint, typecheck, tests.
4. **Verified** — screens checked, directions, viewports, roles.
5. **Not done** — what you skipped and why.
6. **`NEEDS-DECISION`** — numbered questions with options and your recommendation.
7. **Next phase** — what you propose doing next, and roughly how long.

If you cannot complete something, say so directly. Do not report a phase as finished when part of it was inferred rather than verified, and do not claim a screen renders correctly if you never rendered it.

## 16. Definition of done for the whole engagement

- One canonical implementation of each UI primitive; duplicates deleted.
- One token system; no orphan hex values or magic spacing in application code.
- Every route: LTR + RTL + mobile verified, with designed loading/empty/error/permission states.
- Zero Critical or Serious automated accessibility violations; AA contrast throughout.
- Top task per module measurably fewer clicks and keystrokes than at the start, with before/after numbers recorded.
- Build, lint, and typecheck clean; no functional regressions found in the Phase 8 pass.
- Documentation complete enough that the next developer changes nothing about how they'd approach a new screen.

---

### Appendix A — Start command

```
Read UI_UX_AUDIT_AND_IMPROVEMENT_PROMPT.md.
Execute Phase 0 and Phase 1 only.
Do not modify any application code in this session.
Deliver 00-INVENTORY.md, 01-AUDIT.md, 01-SUMMARY.md and the screenshot set, then stop and report.
If you cannot run the app, tell me what you need instead of working from the code alone.
```

### Appendix B — Severity definitions (use these exactly)

- **Critical** — user cannot complete a task, loses data, sees another role's data, or the screen is broken in RTL.
- **High** — task completes but with significant avoidable friction, or a WCAG AA failure on a required control.
- **Medium** — inconsistency, unclear labelling, missing state, or a slow path with a workaround.
- **Low** — visual polish, alignment, spacing, and refinement.
