# Warehouse Module R1 — Manual Test Checklist

> Run after applying migrations `20260764`–`20260767` in the Supabase SQL editor.
> Code status: BUILT + gate-green (287/287 tests, `inventory_hardening3.sql` 12 checks, 0 lint errors, build ✓). **Manual QA below is pending.**
> Mark each row ⬜ → ✅ (pass) or ❌ (fail) as you go.

## 0. Prerequisites

| Status | Step | Detail |
|--------|------|--------|
| ⬜ | Back up first | Supabase → Database → Backups: take a manual backup (or note PITR time). `20260767` edits real inventory rows. |
| ⬜ | Apply migrations in order | `20260764` → `20260765` → `20260766` → `20260767`, each "Success" before the next. |
| ⬜ | System locations exist | Warehouses tab lists RMA Received / Under Repair / Repaired / Can't Repair / Stock, Replacement Holding, Credit Note Holding, Scrap. |
| ⬜ | Backfill placed old units | SQL: `SELECT count(*) FROM inventory_units WHERE status='active_rma' AND warehouse_id IS NULL AND rma_ticket_id IN (SELECT id FROM rma_tickets WHERE ticket_status <> 'Cancelled');` → **0**. |

## 1. System locations are protected

| Status | Check | Expected |
|--------|-------|----------|
| ⬜ | Try to rename or delete a system warehouse | Blocked / not offered (lock icon instead of edit/archive). |
| ⬜ | Edit a system warehouse's manager/notes | Allowed (those fields stay editable). |
| ⬜ | Warehouses tab grouping | Rows grouped Sellable / Other / System; system rows show a "System" badge. |

## 2. Auto-move on ticket create

| Status | Check | Expected |
|--------|-------|----------|
| ⬜ | Create an RMA ticket with 2 products (one serialized), save | Ticket saves normally. |
| ⬜ | Overview → RMA column for that product | Count ≥ 1; clicking opens the RMA drawer showing the unit(s) under **RMA – Received**. |
| ⬜ | Stock Movements tab | A `Transfer` row, doc type **RMA Ticket**, clickable back to the ticket. |

## 3. Auto-move on ticket edit

| Status | Check | Expected |
|--------|-------|----------|
| ⬜ | Change a product to **Under Repair**, save | Unit moves to **RMA – Under Repair**. |
| ⬜ | Change it to **Repaired** | Unit moves to **RMA – Repaired**. |
| ⬜ | Change to **Replacement** or **Credit Note** | Unit moves to **RMA – Stock**. |
| ⬜ | Each change | Adds a new Stock Movements row. |

## 4. Auto-move on bulk product-status

| Status | Check | Expected |
|--------|-------|----------|
| ⬜ | Select several tickets, bulk-change product status | Units move for all of them, no error toast. |
| ⬜ | (If one fails) | Toast: "Ticket saved, but moving the unit(s)… failed." |

## 5. Promote to sellable (the previously-missing path)

| Status | Check | Expected |
|--------|-------|----------|
| ⬜ | RMA drawer → a unit → "Promote to…" → pick a Main/Branch warehouse | Unit leaves RMA; product's Available / Main (or Branches) count rises. |
| ⬜ | Try promoting a **reserved** unit | Blocked with an error toast. |
| ⬜ | Log in as viewer/technician | Promote/move controls are **not** shown (manager+ only). |

## 6. Dashboard columns

| Status | Check | Expected |
|--------|-------|----------|
| ⬜ | Overview columns | Product / Tracking / Available / Reserved / Physical Total / Main / Branches / RMA. |
| ⬜ | Move a unit to **Scrap** (RMA drawer) | Not counted in Available or Physical Total. |
| ⬜ | Click a Branches number | Opens the Branches drawer (Main + per-branch; bulk products show transfer/adjust). |

## 7. Non-catalog RMA products

| Status | Check | Expected |
|--------|-------|----------|
| ⬜ | RMA ticket with a product name not in the catalog | Appears as a row with a **"Not in catalog"** badge, RMA counts only, no checkbox. |

## 8. Stock Breakdown modal

| Status | Check | Expected |
|--------|-------|----------|
| ⬜ | Click a product name | RMA Distribution lists real system locations (not old ticket-status text); Physical Total shown in Product Info. |

## 9. Regression — nothing else broke

| Status | Check | Expected |
|--------|-------|----------|
| ⬜ | Normal sellable products | Available/Reserved counts still correct. |
| ⬜ | Receive Stock / Transfer / Adjust / Warehouses CRUD | All still work. |
| ⬜ | Sales funnel (reserve/deliver on an SO/Invoice) | Unaffected. |
| ⬜ | Old deep link `/inventory?tab=received` | Falls back to Overview (no blank page). |

---

**After all rows above pass:** tell me, and I push Commit 4 (which removes the 5 old RMA-stage tabs + `ProductStatusTab.jsx` — the dashboard + RMA drawer replace them). If anything fails, the old tabs are still on the branch as a fallback while I fix it.

---

## Other pending QA across the project (not part of R1)

These "BUILT ≠ VERIFIED" items are still open from earlier work — listed here so all outstanding manual testing is in one place.

| Status | Area | What still needs a manual click-through | Reference |
|--------|------|------------------------------------------|-----------|
| ⬜ | Purchase Module redesign (2026-07-05) | PO → Vendor Invoice funnel, approval pool, PO PDF export, Vendor Payments (AP) ledger, AP aging — full click-through incl. Arabic + dark mode. | migrations `20260756`–`20260763`; CLAUDE.md Purchase Module section |
| ⬜ | Sprint 8 Inventory UI | Dashboard/Stock Breakdown/Receive/Transfer/Adjust/Warehouses click-through (RPC layer already proven by CI). | CLAUDE.md active-sprint note |
| ⬜ | Sales-funnel 52-item checklist | The deferred 52-row Lead→Deal→QT→SO→Invoice→CN + Accounting v1 checklist. | lives in Claude memory `project-sales-funnel-test-checklist.md` (not in repo) |
| ⬜ | Credit-limit enforcement policy | Decision still deferred (block / warn / advisory) — not a test, a business call before it can be tested. | CLAUDE.md Accounting section |
