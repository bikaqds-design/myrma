# UI/UX audit backlog

Findings from `design/audit/01-AUDIT.md` that are not closed, and why.

**Status: 27 of 44 closed, 3 further retracted. 0 Critical, 3 High, 1 Medium, 1 Low remaining.**

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
| UX-GLOBAL-009 | Loading is a spinner in 27 files, a skeleton in 5 | Medium |
| UX-DASH-003 | Sparklines run left-to-right in RTL — **needs a decision**, see below | Low |

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
