# Research: Unified Improvement Plan Document

**Date**: 2026-06-12 · **Feature**: 001-quality-fixes-plan

No NEEDS CLARIFICATION items remained after reading both source documents; the open questions were design decisions, resolved below.

## D1 — Target filename and location

- **Decision**: `IMPROVEMENT_PLAN.md` at the repository root.
- **Rationale**: Sits beside the docs it merges and the docs that reference project state (`README.md`, `AUDIT_LOG.md`). The name says what it is — neither "roadmap" (which implies features only) nor "fixes" (which implies quality only); the file contains both.
- **Alternatives considered**: `ROADMAP.md` (rejected — half the content is code-quality debt, not roadmap); `docs/PLAN.md` (rejected — no `docs/` directory exists in this repo; all project docs live at root).

## D2 — One backlog or parallel sections per source?

- **Decision**: One unified backlog table set, grouped by track (5 tracks), with a single normalized priority scale across all tracks.
- **Rationale**: The user's goal is "one file to update my future update and fixes plan." Two pasted reports side by side would force the same cross-referencing the merge is meant to eliminate. A single priority scale lets a session answer "what's next?" without comparing 🔴/🟠/🟡 emojis against Critical/Important/Nit labels.
- **Alternatives considered**: Verbatim concatenation of both reports (rejected — duplicates content that will drift from the source reports); separate file per track (rejected — recreates the problem).

## D3 — Track taxonomy

- **Decision**: Five tracks: **CQ** (code quality — from clean-code-guard), **TS** (tests — from test-guard), **DOC** (documentation — from docs-guard), **FT** (features — from competitive analysis §3/§5), **UX** (UX improvements — from competitive analysis §4).
- **Rationale**: Mirrors the source structure so every item has an unambiguous home, and ID prefixes make the origin readable at a glance.

## D4 — ID scheme

- **Decision**: `<TRACK>-<NN>` (e.g. `CQ-01`, `FT-07`). IDs are stable forever — never renumbered, never reused. Source IDs from the guard report (C-1, I-2, N-3) are kept in a Source column for traceability.
- **Rationale**: The guard report's C/I/N prefixes encode severity, which changes as items are fixed or re-triaged; a neutral track prefix survives re-prioritization.

## D5 — Priority normalization

- **Decision**: Four levels mapped from both sources:
  - **P0** — correctness/security risk now, or revenue-blocking gap (guard Critical; competitive 🔴 Critical)
  - **P1** — high-value, should be next (guard Important; competitive 🟠 High)
  - **P2** — worthwhile, not urgent (guard priority-table mid items; competitive 🟡 Medium)
  - **P3** — polish / nits (guard Nits; competitive 🟢 Low)
- **Rationale**: Both sources already use 3–4 tier scales; mapping is mechanical and documented per item via the Source column, so the original severity is never lost.

## D6 — Status vocabulary and reconciliation

- **Decision**: `Open` / `In Progress` / `Shipped` / `Dropped`. Statuses are reconciled against the codebase at merge time, not copied from the sources. Known corrections to apply: COMPETITIVE_ANALYSIS §4 lists skeleton loaders, breadcrumbs, and unified comment/activity timeline as open — all three shipped in commits `4373606` (P2-3), `b5d4dff` (P2-2), `afcd13c`/`39c5d78` (P2-4). §3's stale rows (MFA, replacement/exchange, i18n marked MISSING but shipped per §5) are recorded as `Shipped`.
- **Rationale**: The merged file is only useful if its statuses are true on day one; the docs-guard report already flagged §3 as internally contradictory.

## D7 — Relationship to source documents

- **Decision**: `GUARD_SKILL_TEST_REPORT.md` and `COMPETITIVE_ANALYSIS.md` remain unchanged as dated audit evidence. `IMPROVEMENT_PLAN.md` becomes the single working backlog going forward; future audits update the report *and* the plan's statuses. The plan links to source sections rather than duplicating evidence/fix details — each item carries a one-line description plus a pointer (e.g. "GUARD report → C-3" or "COMP §3").
- **Rationale**: Duplicating the full evidence blocks (~700 lines) would guarantee drift. The plan needs only enough to act on; deep detail stays in the sources.
- **Alternatives considered**: Deprecating the source files (rejected — they are dated audit artifacts referenced by `AUDIT_LOG.md` history).

## D8 — Long-term enterprise items (COMP §5, 6–12 months)

- **Decision**: Include as a separate low-detail "Horizon" section (no effort estimates, no IDs in the main backlog — `H-1`…`H-6`), not interleaved with the actionable backlog.
- **Rationale**: Multi-tenancy, SSO, SOC2 etc. are direction markers, not plannable work items; mixing them into the P0–P3 backlog would bury actionable items under aspirational ones.
