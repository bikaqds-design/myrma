# Implementation Plan: Sales Funnel Hardening

**Branch**: `003-sales-funnel-hardening` (pinned via `.specify/feature.json`; commits land on `test`) | **Date**: 2026-06-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-sales-funnel-hardening/spec.md` · Source audit: [`sales-funnel-audit.md`](../../sales-funnel-audit.md)

## Summary

Harden the existing Lead→Invoice funnel so every transition connects end-to-end with **database-enforced** invariants. The core problems are: (a) order approval only handles serialized inventory and dead-ends for parts/service lines; (b) approved orders can strand reserved stock with no release path; (c) lifecycle transitions do multiple writes from the client without a transaction, so partial failures desync document↔inventory↔ledger; (d) a destructive reset script sits in the migrations pipeline; plus governance gaps (client-only approval, unguarded bulk edits, unsafe void). The technical approach is to **move each multi-write lifecycle transition into a single `SECURITY DEFINER` Postgres RPC** that is atomic, row-locked, role-checked, and line-type-aware — then thin the API-layer methods to call those RPCs. UI changes are minimal (remove dead controls, surface refusal reasons).

## Technical Context

**Language/Version**: TypeScript (API/lib layer) + JavaScript/JSX (React 18 pages); PostgreSQL (PL/pgSQL) for RPCs.
**Primary Dependencies**: Supabase (Postgres + RLS + RPC), TanStack Query v5, React Router v6, Tailwind v3, react-i18next, Zod. Stack is LOCKED (Constitution) — no new dependencies.
**Storage**: Single Supabase Postgres project/schema. Existing funnel tables: `quotations`, `sales_orders`, `crm_invoices`, `credit_notes`, `credit_note_applications`, `payments`, `payment_applications`, `inventory_units`, `parts`, `stock_moves`, `document_sequences`, `leads`, `deals`, `pipelines`, `activities`, `customers`, `products`.
**Testing**: Vitest unit tests (`src/lib/`). DB RPC behavior validated manually via the quickstart scenarios in Supabase SQL Editor (no automated DB test harness exists in-repo). Existing gate: `npm test` (277), `npm run lint`, `npm run build`.
**Target Platform**: Web PWA (dark mode + Arabic/RTL required on any touched UI).
**Project Type**: Web application (React SPA + Supabase backend). Existing structure — no new top-level projects.
**Performance Goals**: N/A beyond "no regression"; transitions are single-document operations.
**Constraints**: Idempotent SQL migrations only (`IF NOT EXISTS` / `CREATE OR REPLACE` / `DROP … IF EXISTS`); RLS-by-default with `rma_*` helpers; the "who" convention (`assigned_rep`/`created_by` are email text, never uuid); JSONB ordered data stays arrays.
**Scale/Scope**: SMB single-tenant repair-shop SaaS. ~7 lifecycle transitions to make atomic; ~3 inventory dispatch fixes; ~4 governance fixes; 1 file move. No new commercial features.

**Resolved design decisions** (see [research.md](./research.md) for full rationale):
- Line classification (FR-002) derives from the existing catalog at reserve time (look up `inventory_units` presence → serialized; else `parts` row → fungible; else service/non-stock) — **no new column** on line_items, avoiding a data migration of historical JSONB.
- SO reservation lifecycle (FR-003) keeps the current status enum; approval continues to land in `delivered`, but `cancel()` is extended to release reservations for a not-yet-invoiced order regardless of whether it's `confirmed` or `delivered`, with the release RPC handling both units and parts.
- Atomicity (FR-005) is achieved by relocating the multi-step logic from the TS API methods into PL/pgSQL RPCs; the TS methods become thin wrappers (one `rpc()` call each).

## Constitution Check

*GATE: evaluated before Phase 0; re-checked after Phase 1 design.*

| Principle | Compliance |
|-----------|------------|
| **I. Shared UI library & design tokens, i18n** | ✅ UI changes are minimal (remove dead Cancel control L2; show refusal toasts). Any new string ships in `en.json`+`ar.json`. No new components introduced. |
| **II. API layer encapsulation** | ✅ All DB access stays behind `src/api/db/*`. New RPCs are invoked via `supabase.rpc(...)` inside the existing domain modules — pages never call them directly. Optional-table `42P01` guards preserved. JSONB stays arrays. |
| **III. Security & RLS by default** | ✅ New/changed RPCs are `SECURITY DEFINER` with internal `rma_is_manager_or_above()` checks (FR-011). No table loses RLS. Approval governance moves to the data layer — strengthens this principle. |
| **IV. TanStack Query data layer** | ✅ No new fetching pattern. Mutations continue to `invalidateQueries`. No `useEffect`+`setState` introduced. |
| **V. No magic strings + TS discipline** | ✅ Status strings already centralized in `src/lib/constants.ts`; any new constant added there. New/changed `src/api/db/*` stays `.ts` with Row types re-exported from `index.ts`. No `any`. |
| **Architecture: migrations** | ✅ Every schema/RPC change is an idempotent `supabase/migrations/YYYYMMDD_*.sql`. FR-004 **removes** a destructive script from the pipeline. |
| **Quality gates** | ✅ `npm test && npm run lint && npm run build` must pass; existing 14-item funnel + Accounting checklists must not regress. |

**Result: PASS — no violations.** Complexity Tracking table omitted (nothing to justify). The feature *increases* constitutional compliance (atomic, RLS-enforced lifecycle).

## Project Structure

### Documentation (this feature)

```text
specs/003-sales-funnel-hardening/
├── plan.md              # This file
├── research.md          # Phase 0 — design decisions & rationale
├── data-model.md        # Phase 1 — entities, state machines, invariants
├── quickstart.md        # Phase 1 — manual validation scenarios (SQL + UI)
├── contracts/           # Phase 1 — RPC signatures (the funnel's transition API)
│   ├── lifecycle-rpcs.md
│   └── governance-rpcs.md
└── tasks.md             # Phase 2 — created by /speckit-tasks (NOT here)
```

### Source code (repository root) — files this feature touches

```text
supabase/migrations/
├── 20260732_funnel_line_reservation.sql      # FR-001/002: line-type-aware reserve/deliver/release (units + parts + service)
├── 20260733_so_lifecycle_rpcs.sql            # FR-003/005/006/007/011: convert_quotation_to_so, approve/reject_sales_order, cancel_sales_order (atomic, locked, role-checked)
├── 20260734_invoice_lifecycle_rpcs.sql       # FR-005/007/010/011: post_invoice (code+status+deliver in one tx), void_invoice (guarded)
├── 20260735_cn_payment_lifecycle_rpcs.sql    # FR-005/007: issue_credit_note(+apply), record_payment(+apply) atomic
├── 20260736_lead_deal_guards.sql             # FR-008/009: bulk stage-move validation + converted-lead immutability trigger
└── (move) scripts/manual/20260731_crm_funnel_test_data_reset.sql   # FR-004: relocated out of migrations/

src/api/db/
├── salesOrders.ts     # thin wrappers → convert/approve/reject/cancel RPCs
├── crmInvoices.ts     # thin wrappers → post/void RPCs
├── creditNotes.ts     # issue() → single RPC
├── payments.ts        # record() → single RPC
├── quotations.ts      # convertToSalesOrder() → single RPC
├── leads.ts           # bulkUpdate() guard (FR-009)
└── deals.ts           # bulkMoveStage() validation (FR-008)

src/pages/SalesDocuments/SalesDocumentDetail.jsx   # FR-013 remove dead Cancel-on-delivered control (L2/L4); refusal toasts (FR-014)
src/lib/constants.ts                                # any new status/line-type constant
src/locales/{en,ar}.json                            # any new strings (FR-015)
```

**Structure Decision**: Existing web-app structure is kept. The feature's center of gravity is **new PL/pgSQL RPCs under `supabase/migrations/`**; the TypeScript API modules shrink to thin RPC callers; UI edits are surgical. No new directories beyond `scripts/manual/` (for the relocated reset script) and this feature's `specs/` folder.

## Phasing within implementation (for /speckit-tasks)

The fixes are ordered by the audit's remediation priority and by dependency:

1. **P0 — FR-004** (relocate reset script): zero-dependency, prevents catastrophe. Ship first.
2. **P1 — FR-001/002/003** (inventory model): the line-reservation migration + SO lifecycle RPCs. This is what makes the funnel connect for real-world line mixes and adds the release path.
3. **P2 — FR-005/006/007** (atomic transitions): invoice + CN + payment lifecycle RPCs; thin the API methods.
4. **P3 — FR-010/011** (governance): guarded void + server-side approval role checks (folded into the P1/P2 RPCs where natural).
5. **P4 — FR-008/009/012/013** (bulk guards, convert validation, UI dead-control): independent, lower risk.

Each phase ends at the green gate (`npm test && npm run lint && npm run build`) and the relevant rows of the funnel test checklist in `MASTER_UPGRADE_PLAN.md`.

## Complexity Tracking

No constitution violations — table omitted.
