# Quickstart: Validate IMPROVEMENT_PLAN.md

**Date**: 2026-06-12 · **Feature**: 001-quality-fixes-plan

## Prerequisites

- `IMPROVEMENT_PLAN.md` exists at the repository root (created in the implementation phase).
- Source documents present: `GUARD_SKILL_TEST_REPORT.md`, `COMPETITIVE_ANALYSIS.md`.

## Validation scenarios

### 1. Structure matches the contract

Open `IMPROVEMENT_PLAN.md` and check section order against
[contracts/improvement-plan-format.md](contracts/improvement-plan-format.md):
header → How to use → Now/Next/Later → CQ → TS → DOC → FT → UX → Horizon → Changelog.

**Expected**: all sections present, tables use the contract's columns, rows sorted P0-first.

### 2. Completeness — no open source item is missing

- For each row of the GUARD report's clean-code "Fix Priority Order" table (14 rows) and
  test-guard "Test Fix Priority Order" (8 rows) + coverage gaps (5), and both docs-guard
  fix tables (10 + 8): find its ID in the plan.
- For each non-✅ row of COMPETITIVE_ANALYSIS §3 and §4, and each ⏳ item of §5: find its ID.

**Expected**: every open source item maps to exactly one plan row; counts match the
baseline table in the contract (±1 where items were merged, with a note).

### 3. Status truth — no shipped item listed as Open

Spot-check the known reconciliations:

```powershell
git log --oneline -15   # confirm 4373606 (skeletons), b5d4dff (breadcrumbs), afcd13c (timeline)
```

**Expected**: skeleton loaders, breadcrumbs, unified timeline, MFA, replacement/exchange,
i18n, barcode, report builder, onboarding wizard, AI assist, credit notes, pg_cron,
session management, empty states, inline actions, Cmd+K → all `Shipped` in the plan.

### 4. Traceability — pointers resolve

Pick 5 random rows; follow each `source` pointer into the source document.

**Expected**: the pointed-to section exists and describes the same item.

### 5. Sources untouched

```powershell
git diff --stat -- GUARD_SKILL_TEST_REPORT.md COMPETITIVE_ANALYSIS.md
```

**Expected**: no changes introduced by the implementation of this feature.

## Definition of done

- All 5 scenarios pass.
- File committed to `test` branch as `docs(plan): add unified improvement plan merging guard audits and competitive analysis`.
