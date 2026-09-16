# Implementation Plan: Unified Improvement Plan Document (merge guard reports + competitive analysis)

**Branch**: `test` (feature pinned via `SPECIFY_FEATURE=001-quality-fixes-plan`) | **Date**: 2026-06-12 | **Spec**: none (planned directly from source documents)

**Input**: User request — merge `GUARD_SKILL_TEST_REPORT.md` (clean-code / test-guard / docs-guard audits) and `COMPETITIVE_ANALYSIS.md` (feature gaps, UX audit, roadmap) into one new markdown file that serves as the project's future updates and fixes plan.

## Summary

Create a single living backlog document — **`IMPROVEMENT_PLAN.md`** at the repository root — that consolidates every open finding from the 2026-06-12 guard audits and every unshipped item from the competitive analysis into one prioritized, status-tracked table set. The two source documents remain untouched as audit evidence; the new file becomes the working plan that future sessions update as items ship. Each item carries a stable ID, a source pointer back to the originating report section, a normalized priority (P0–P3), effort, and status, so progress is trackable without re-reading either source.

## Technical Context

**Language/Version**: Markdown (GitHub-flavored) — no code changes in this feature

**Primary Dependencies**: Source documents `GUARD_SKILL_TEST_REPORT.md` (updated 2026-06-12) and `COMPETITIVE_ANALYSIS.md` (updated 2026-06-06); reconciliation against recent git history (P2-2 breadcrumbs, P2-3 skeleton loaders, P2-4 unified timeline shipped after the competitive analysis was last updated)

**Storage**: Repository root file `IMPROVEMENT_PLAN.md`, committed to git on the `test` branch

**Testing**: Manual validation per `quickstart.md` — every open source-document item maps to exactly one plan item; no shipped item appears as open

**Target Platform**: N/A (documentation)

**Project Type**: Documentation / planning artifact

**Performance Goals**: N/A

**Constraints**: Source documents are read-only inputs (audit history must not be rewritten); statuses must be reconciled against the codebase, not copied blindly (COMPETITIVE_ANALYSIS Section 4 lists items as open that have since shipped)

**Scale/Scope**: ~75 items total — 14 clean-code findings, 8 test fixes + 5 coverage gaps, 18 docs fixes, ~12 unshipped features, ~14 open UX items, 6 long-term enterprise items

## Constitution Check

*GATE: evaluated pre-Phase-0 and re-checked post-Phase-1.*

| Principle | Applies? | Status |
|-----------|----------|--------|
| I. Shared UI Library & Design Tokens | No — no UI code produced | ✅ N/A |
| II. API Layer Encapsulation | No — no data access code | ✅ N/A |
| III. Security & RLS by Default | No — no schema/auth changes | ✅ N/A |
| IV. TanStack Query as Data Layer | No — no fetching code | ✅ N/A |
| V. No Magic Strings + TS Discipline | No — no `src/` files | ✅ N/A |
| Quality Gates & Workflow | Yes — commit must use Conventional Commits (`docs(plan): ...`); commit to `test` branch per project workflow; CI unaffected (markdown only) | ✅ PASS |
| Governance | Yes — this plan does not amend `CONSTITUTION.md`; `IMPROVEMENT_PLAN.md` is a backlog, not an engineering-rules document, so no constitution versioning is triggered | ✅ PASS |

**Pre-Phase-0 result: PASS** — no violations, no Complexity Tracking entries needed.

**Post-Phase-1 re-check: PASS** — design introduces one new root-level markdown file and edits no governed artifact.

## Project Structure

### Documentation (this feature)

```text
specs/001-quality-fixes-plan/
├── plan.md              # This file
├── research.md          # Phase 0 — merge-design decisions
├── data-model.md        # Phase 1 — PlanItem entity + status/priority vocabularies
├── quickstart.md        # Phase 1 — validation guide
├── contracts/
│   └── improvement-plan-format.md   # Phase 1 — required structure of IMPROVEMENT_PLAN.md
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
IMPROVEMENT_PLAN.md          # NEW — the merged living plan (deliverable)
GUARD_SKILL_TEST_REPORT.md   # read-only input (audit evidence, unchanged)
COMPETITIVE_ANALYSIS.md      # read-only input (audit evidence, unchanged)
```

**Structure Decision**: Single new root-level markdown file alongside the existing project docs (`README.md`, `AUDIT_LOG.md`, etc.). No `src/` changes. The two source reports are preserved untouched; `IMPROVEMENT_PLAN.md` links back to them by section for full traceability.

## Complexity Tracking

No constitution violations — table not required.
