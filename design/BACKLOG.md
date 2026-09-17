# UI/UX audit backlog

Findings from `design/audit/01-AUDIT.md` that are not closed, and why.

**Status: 29 of 47 closed, 3 retracted, 1 won't-fix. 0 Critical, 3 High, 0 Medium, 1 Low remaining.**
(Three search findings added 2026-09-03.)

No Medium is open: UX-GLOBAL-009 (spinners rather than skeletons) closed on
2026-09-17. The one Low left is UX-SEARCH-003 (Arabic search normalisation),
which is latent and needs a database change.

### UX-DASH-003 — charts stay left-to-right (decided 2026-09-03)

Sparklines and trend charts do not mirror in RTL, so in Arabic the oldest point
sits on the left and time runs against the reading direction. **Deliberate.**
Time flows left-to-right in Odoo, Zoho, Excel and most Arabic-language
dashboards: a chart reads as a universal notation rather than as text, and an
Arabic reader accustomed to that would misread a mirrored axis at a glance.

Recorded so it is not raised again. Everything that *is* text — labels, legends,
axis titles, tooltips — still mirrors normally.

Of the six Medium/Low findings checked on 2026-09-03, **three were wrong as
written** and were retracted after measurement, two were fixed, and one needs a
product decision. That is now five retractions across this audit — the pattern is
consistent: findings raised from reading source or screenshots have a much worse
hit rate than findings raised from measuring the running app.
(UX-GLOBAL-017 retracted; UX-PAGE-001/002 added and closed — see `design/audit/03-PAGINATION.md`.)
Every dark-mode finding is closed; both light and dark measure 0 AA contrast failures.
(Five dark-mode findings added 2026-09-03.)

Every Critical is closed. Nothing here blocks launch.

---

## Deliberately deferred

### UX-GLOBAL-007 — Table migration: opportunistic, not scheduled

**Decision (2026-09-03): migrate a table only when already changing that screen
for another reason. Do not run a bulk migration.**

The primitive is built, tested (27 tests) and proven on 4 call sites. About 60
hand-written tables remain across 44 files.

The reasoning, so this is not re-litigated:

- The tables are not copies of one thing. Each has its own columns, conditional
  cell rendering, nested components, row actions and formatting. Converting one
  is a reading-and-rewriting job, not a substitution. **A codemod was considered
  and rejected** — it would produce code that compiles and renders the wrong
  thing.
- Two errors occurred in the first three migrations: a line range taken from
  `awk` across two files (`NR` does not reset, so it pointed 240 lines off) and a
  constant renamed by hand. Both were caught — by an assertion and by `no-undef`
  — but 60 more unattended would ship broken screens.
- Nothing is broken today. Every remaining table works; it simply carries its own
  copy of decisions the primitive would make once.
- The lint guard prevents new drift, so the problem does not grow while it waits.

Recipe in `design/UI_GUIDELINES.md`. Two carve-outs: `cp/PDFLayout.jsx` (2
tables) must never migrate — printed-document layout — and `Skeleton.jsx` (2) are
superseded by the primitive's own skeleton rows.

---

## Remaining High

| ID | Issue | Effort | Note |
|---|---|---|---|
| UX-GLOBAL-001 | 2,365 raw hex values in markup | L | Needs the semantic token set defined first, **with a dark value per role**. Guarded — cannot grow. |
| UX-GLOBAL-006 | 101 of 115 page files have no empty state | L | Per-screen copy and a primary action each. `EmptyState` exists and is now translatable. |
| UX-GLOBAL-008 | Kit adoption 29–57% by primitive | L | ~250 hand-rolled controls. Same opportunistic argument as tables applies. |
| UX-GLOBAL-007 | Table migration | L | Deferred above. |

---

## Remaining Medium and Low

See `design/audit/01-AUDIT.md` for the full table. The notable ones:

| ID | Issue | Sev |
|---|---|---|
| ~~UX-GLOBAL-017~~ | ~~Pagination arrows wrong way in Arabic~~ **RETRACTED** — measured, correct | — |
| ~~UX-GLOBAL-016~~ | ~~21 Arabic values identical to English~~ **RETRACTED** — 23 of 26 legitimately identical (code, addresses, format examples), 2 are language names correctly in their own script, 1 is a technical term | — |
| ~~UX-ONBOARD-004~~ | ~~Onboarding blocks the screen for every new user~~ **RETRACTED as written** — gated to admin/super_admin only, and dismissible | — |
| ✅ UX-GLOBAL-002 | ~~No z-index ladder~~ **CLOSED** — named rungs in tailwind.config, relative order preserved | Medium |
| ✅ UX-DASH-004 | ~~Unclear whether widgets link~~ **CLOSED** — "View all" was an inert span; now navigates | Medium |
| ✅ UX-GLOBAL-009 | ~~Loading is a spinner in 27 files, a skeleton in 5~~ **CLOSED** (2026-09-17) — every list and detail content area loads as a skeleton (`src/components/Skeleton.jsx`, each a `role="status"` region); `src/test/loadingSkeletons.test.jsx` fails if a converted screen goes back to a spinner. Spinners remain where they are right: inside buttons, small inline loads (comments, sessions) and Control Panel settings forms | Medium |
| ⏹ UX-DASH-003 | ~~Sparklines run left-to-right in RTL~~ **WON'T FIX** (decided 2026-09-03) | — |

---

## Search and filters — audited 2026-09-03

Full report: `design/audit/04-SEARCH-AND-FILTERS.md`. Thirty-seven files carry a
search box; two real findings, one latent.

| ID | Issue | Sev | Effort |
|---|---|---|---|
| ✅ UX-SEARCH-001 | ~~Search and filters not in the URL~~ **CLOSED** — all 7 standalone list routes, each verified from a cold link. Tabbed screens need tab-scoped param names; Leads' Set-based multi-selects need list encoding | Medium | — |
| ✅ UX-SEARCH-002 | ~~No clear control on a search box~~ **CLOSED** (2026-09-17) — every list search box is the shared `SearchInput` (`type="search"`, clear button that keeps focus); `src/test/SearchInput.test.jsx` fails on a raw one. Pickers and the `/tracker` lookup are left as they are | Low | — |
| UX-SEARCH-003 | Arabic not normalised for search (`احمد` will not find `أحمد`). **Latent** — zero Arabic text in 888 customers, 406 products, 33 leads | Low | S |

Three candidates were dropped after measuring: debouncing is already correct
(220 ms with a 2-character minimum in `CommandPalette`), page search runs at
27–38 ms over 888 records, and the Customers placeholder honours all four fields
it promises.

---

## Dark mode — audited 2026-09-03

**Audited and in good shape.** 32 of 32 route/direction combinations render
correctly with zero light surfaces, and contrast is at near-parity with light
mode (18 AA failures against 16). Full report: `design/audit/02-DARK-MODE.md`.

Five findings opened, one of them High:

| ID | Issue | Sev |
|---|---|---|
| ✅ UX-DARK-001 | ~~Appearance settings are global~~ **CLOSED** — split personal vs company, no migration needed | High |
| ✅ UX-DARK-002 | ~~Never follows the operating system~~ **CLOSED** | Medium |
| ✅ UX-DARK-003 | ~~88 KB config blob fetched on every app mount~~ **CLOSED** — it was the favicon; now in Storage, row is 354 chars | Medium |
| ✅ UX-GLOBAL-018 | ~~Notification badge fails AA in both modes~~ **CLOSED** — red-600, 4.83:1 | Medium |
| ✅ UX-DARK-004 | ~~Knowledge Center muted text fails AA in dark~~ **CLOSED** — 7.05:1 | Low |

Still unexamined in dark: **modals and drawers** (behind interactions the sweep
did not perform), **mobile width**, and whether `RMATracker.jsx` — the public
customer tracker — is deliberately light-only or merely unconverted.

**Phases 4 through 9 of the brief.** No module received the per-screen redesign
pass, and no click/keystroke baselines were ever measured — so the Definition of
Done's "measurably fewer clicks" cannot currently be evidenced either way.
