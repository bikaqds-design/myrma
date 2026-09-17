# Archive

Documents that are **finished, superseded or historical**. Nothing here describes
the current system — for that, read [`CLAUDE.md`](../../CLAUDE.md) and the live
audit [`AUDIT_REPORT.md`](../../AUDIT_REPORT.md) (§0 is the current scorecard).

Files are kept rather than deleted because their evidence and reasoning are still
cited from findings, migrations and code comments. Links *inside* these files were
written for their original location and may point at files that have since moved.

## Audits and reviews

| File | Date | What it was | Superseded by |
|------|------|-------------|---------------|
| `SYSTEM_TEST_REPORT_20260527.md` | 2026-05-27 | First full system test | Later audits |
| `AUDIT_LOG.md` | 2026-05-26 → 06-17 | Running audit log and scorecard of the first engineering passes | `AUDIT_REPORT.md` |
| `GUARD_SKILL_TEST_REPORT.md` | 2026-06-12 | clean-code / test / docs guard review of `src/` | — |
| `COMPETITIVE_ANALYSIS.md` | 2026-06-06 | Feature-gap and UX comparison with competing products | `MASTER_UPGRADE_PLAN.md` |
| `FULL_SYSTEM_AUDIT_PROMPT 17-06-2026.md` | 2026-06-17 | The prompt used to run the June audit | — |
| `SYSTEM_AUDIT_REPORT_20260617.md` | 2026-06-17 | June full-system audit | `AUDIT_REPORT_2026-07-02.md` |
| `FIX_PLAN_20260617.md` | 2026-06-17 | Fix plan for the June audit | — |
| `sales-funnel-audit.md` | 2026-06-30 | Lead → Invoice funnel audit | `MASTER_UPGRADE_PLAN.md` (Sprint 7.5) |
| `AUDIT_REPORT_2026-07-02.md` | 2026-07-02 | CTO-level audit after the CRM, accounting and inventory sprints | `AUDIT_REPORT.md` |
| `FULL_SYSTEM_AUDIT_2026-07-02.md` | 2026-07-02 | Companion checklist to the July audit | `AUDIT_REPORT.md` |
| `PRELAUNCH_REVIEW.md` | 2026-08-18 → 09-02 | Pre-launch review measured against the live database | `AUDIT_REPORT.md` (2026-09-03), which cites it |

## Plans — all shipped

| File | Date | What it planned |
|------|------|-----------------|
| `CRM_UPGRADE_STUDY.md` | 2026-06 | The original study for turning myRMA into a CRM |
| `CRM_UPGRADE_PLAN.md`, `SYSTEM_UPGRADE_PLAN.md` | 2026-06 | Stubs: merged into `MASTER_UPGRADE_PLAN.md` |
| `IMPROVEMENT_PLAN.md` | 2026-06-17 | Prioritised improvement backlog from the June reviews |
| `MASTER_UPGRADE_PLAN.md` | 2026-06 → 08-16 | Sprint-by-sprint build tracker for the CRM (Track A) and system upgrades (Track B) — the build phase it tracked is finished |
| `DASHBOARD_CRM_PLAN.md` | 2026-08-16 | Dashboard rebuild |
| `REPORTS_CRM_PLAN.md`, `CONTROL_PANEL_CRM_PLAN.md`, `CALENDAR_CRM_PLAN.md` | 2026-08-17 | Reports, Control Panel and Calendar rebuilds |
| `PERMISSIONS_CRM_PLAN.md` | 2026-08-18 | Permission sections and role matrix |
| `CURRENCY_COSTING_PLAN.md` | 2026-09-02 | Multi-currency, landed cost and COGS at posting (migrations `20260791`–`20260798`, which cite it) |
| `UI_UX_AUDIT_AND_IMPROVEMENT_PROMPT.md` | 2026-09-02 | The prompt behind the UI/UX audit — its results live in [`design/`](../../design/) |

## Manual QA runs — all completed

| File | Date | Module |
|------|------|--------|
| `QA_SESSION_2026-08-05.md` | 2026-08-05 | Read-only pass over the Warehouse R1 checklist |
| `CRM_QA_CHECKLIST.md` | 2026-08-08 | Leads (Sprint 2.5) and Pipeline Kanban (Sprint 3) |
| `RMA_TICKETS_QA_CHECKLIST.md` | 2026-08-10 | RMA Tickets |
| `PUBLIC_TRACKER_QA_CHECKLIST.md`, `CUSTOMERS_QA_CHECKLIST.md` | 2026-08-12 | Public tracker; Customers |
| `PRODUCTS_QA_CHECKLIST.md` | 2026-08-13 | Products |
| `WAREHOUSE_R1_TEST_CHECKLIST.md` | 2026-08-05 → 08-17, re-run 2026-09-17 | Warehouse Module R1, plus the pending-QA rows of earlier sprints — cited by code comments and migrations `20260768`–`20260770` |

## SpecKit feature specs — all shipped

`specs/001-quality-fixes-plan/` (2026-06-12), `specs/002-crm-upgrade/` (2026-06-18 → 06-24) and `specs/003-sales-funnel-hardening/` (2026-07-02) moved to [`specs/`](specs/). Early CRM migrations (`20260618`–`20260620`) cite `specs/002-crm-upgrade/` by its old path. A new SpecKit feature will be created under a fresh top-level `specs/` directory as usual.

## Agent instructions

| File | Date | Why archived |
|------|------|--------------|
| `AGENTS_2026-08-05.md` | 2026-08-05 | A separate copy of `CLAUDE.md` that had drifted; `AGENTS.md` at the root is now a pointer |
