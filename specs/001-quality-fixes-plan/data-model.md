# Data Model: Unified Improvement Plan Document

**Date**: 2026-06-12 · **Feature**: 001-quality-fixes-plan

The document is a structured markdown table set; its "entities" are the row and vocabulary definitions below.

## Entity: PlanItem

One row in a track table of `IMPROVEMENT_PLAN.md`.

| Field | Type | Rules |
|-------|------|-------|
| `id` | string | `<TRACK>-<NN>`, zero-padded, unique across the file, never renumbered or reused |
| `title` | string | One line, imperative ("Break up `handleSubmit`"), ≤ 80 chars |
| `priority` | enum | `P0` \| `P1` \| `P2` \| `P3` (see Priority vocabulary) |
| `effort` | enum | `Low` \| `Medium` \| `High` (carried from source where present, else estimated) |
| `status` | enum | `Open` \| `In Progress` \| `Shipped` \| `Dropped` |
| `source` | string | Pointer to originating section + original ID, e.g. `GUARD → C-3`, `COMP §3`, `COMP §4` |
| `where` | string | File/line refs for code items (`tickets.ts:158`), or `—` for features |
| `notes` | string | Optional; ship date when `Shipped`, reason when `Dropped` |

### Validation rules

- Every **open** finding in `GUARD_SKILL_TEST_REPORT.md` (2026-06-12 sections) maps to exactly one PlanItem.
- Every **unshipped** item in `COMPETITIVE_ANALYSIS.md` §3, §4, §5 maps to exactly one PlanItem.
- No item that has demonstrably shipped (verified against git history / codebase) may have status `Open`.
- An item appearing in both sources (e.g. a docs fix also implied by a feature) gets ONE row with both pointers in `source`.

### State transitions

```
Open → In Progress → Shipped
Open → Dropped            (with reason in notes)
In Progress → Open        (work reverted/paused)
Shipped → (terminal; row stays for history, never deleted)
```

## Vocabulary: Track

| Prefix | Track | Source |
|--------|-------|--------|
| `CQ` | Code quality | GUARD report, clean-code section (C-*, I-*, N-*, nits) |
| `TS` | Tests | GUARD report, test-guard section (rule fixes + coverage gaps) |
| `DOC` | Documentation | GUARD report, both docs-guard sections |
| `FT` | Features | COMPETITIVE_ANALYSIS §3 + §5 (actionable, ≤ 6 months) |
| `UX` | UX improvements | COMPETITIVE_ANALYSIS §4 |
| `H` | Horizon (6–12 mo) | COMPETITIVE_ANALYSIS §5 long-term — separate section, direction markers only |

## Vocabulary: Priority mapping

| Plan | GUARD report | COMPETITIVE_ANALYSIS |
|------|--------------|----------------------|
| `P0` | Critical | 🔴 Critical |
| `P1` | Important | 🟠 High |
| `P2` | mid-table priority items | 🟡 Medium |
| `P3` | Nits | 🟢 Low |

## Relationships

```
IMPROVEMENT_PLAN.md
├── references → GUARD_SKILL_TEST_REPORT.md (read-only, by section + original ID)
├── references → COMPETITIVE_ANALYSIS.md   (read-only, by section)
└── reconciled against → git history (status truth)
```
