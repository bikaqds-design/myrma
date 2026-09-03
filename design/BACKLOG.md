# UI/UX audit backlog

Findings from `design/audit/01-AUDIT.md` that are not closed, and why.

**Status: 18 of 38 closed. 0 Critical, 4 High, 12 Medium, 4 Low remaining.**

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
| UX-GLOBAL-017 | Pagination arrows point the wrong way in Arabic | Medium |
| UX-GLOBAL-016 | 21 Arabic values identical to their English source | Low |

---

## Not audited at all

**Dark mode.** It is implemented, in scope (decided 2026-09-02), and has never
been looked at. All 71 baseline screenshots are light mode only. This is the
largest unknown remaining in the UI: the matrix needs a dark dimension, the
contrast work doubles, and four of the most-repeated hardcoded hex values
(`#0f1520`, `#121823`, `#1a2230`, `#212a38`) are dark-mode surfaces applied as
raw hex via `dark:` variants.

**Phases 4 through 9 of the brief.** No module received the per-screen redesign
pass, and no click/keystroke baselines were ever measured — so the Definition of
Done's "measurably fewer clicks" cannot currently be evidenced either way.
