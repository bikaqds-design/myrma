# Contract: IMPROVEMENT_PLAN.md document format

**Date**: 2026-06-12 · **Feature**: 001-quality-fixes-plan

This contract defines the required structure of `IMPROVEMENT_PLAN.md`. Future sessions updating the file MUST preserve this structure; the quickstart validation checks against it.

## Required sections, in order

```markdown
# myRMA — Improvement Plan
<header block: last-updated date, source doc pointers + their audit dates,
 one-line usage rule: "update Status here; evidence lives in the source docs">

## How to use this file
<status vocabulary, priority vocabulary, ID stability rule — 5–10 lines max>

## Now / Next / Later
<a short curated view: 3–7 item IDs under each of the three headings,
 chosen from the backlog below; this is the only opinionated/editorial section>

## Track CQ — Code Quality
<table: ID | Title | Priority | Effort | Status | Source | Where>

## Track TS — Tests
<same columns>

## Track DOC — Documentation
<same columns>

## Track FT — Features
<table: ID | Title | Priority | Effort | Status | Source | Notes>

## Track UX — UX Improvements
<same columns as FT>

## Horizon (6–12 months)
<table: ID (H-*) | Title | Why it matters | Source — no priority/effort/status>

## Changelog
<append-only list: date — what changed (items shipped, added, re-prioritized)>
```

## Hard rules

1. **IDs are immutable** — never renumber, reuse, or delete a row; shipped/dropped rows remain.
2. **Tables are sorted** by priority (P0 first), then ID, within each track.
3. **Status changes append a Changelog line** with the date.
4. **No evidence duplication** — fix details, code quotes, and competitor rationale stay in the source documents; this file carries one-line titles + pointers.
5. **New items** (from future audits or new feature ideas) take the next free number in their track and cite their source.
6. **Source documents are never edited** to match this file; reconciliation flows one way (sources + git history → this file's statuses).

## Initial population counts (acceptance baseline)

| Track | Expected rows (2026-06-12 baseline) |
|-------|-------------------------------------|
| CQ | 14 (C-1..4, I-1..7 as CQ-01..11, N-1..3 as CQ-12..14) + 1 row covering the nits bundle |
| TS | 13 (8 fix-priority items + 5 coverage gaps incl. `useURLTab`) |
| DOC | 18 (10 from README/CLAUDE/AGENTS/DESIGN table + 8 from CONSTITUTION/AUDIT_LOG table) |
| FT | ~10 unshipped (return portal, payments, public API, mobile app, SMS, self-service portal, warranty validation, supplier integration, impersonation, vendor portal, knowledge base) + shipped rows marked `Shipped` |
| UX | ~9 open after reconciliation (mobile-first ticket view, dashboard role widgets, sidebar grouping, form validation on blur, status workflow view, keyboard shortcuts, WCAG audit, pagination UI, token sweep, notification center) — skeleton loaders / breadcrumbs / unified timeline enter as `Shipped` |
| H | 6 (multi-tenancy, vendor portal*, SSO, AI disposition, SOC2, parts marketplace) — *vendor portal may live in FT or H, not both |
