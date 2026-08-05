# Manual Test Checklist — all pending QA

> **This is the single place where every outstanding manual test lives.** It began as
> the Warehouse R1 checklist and now also carries the CRM Leads/Pipeline round and the
> older "BUILT ≠ VERIFIED" items from earlier sprints.
>
> Mark each row ⬜ → ✅ (pass) or ❌ (fail) as you go.
>
> **Sections:**
> 1. Warehouse Module R1 (§0–§9) — migrations applied ✅, UI walkthrough pending
> 2. Other pending QA from earlier sprints (Purchase, Sprint 8, sales funnel, credit limits)
> 3. CRM Leads/Pipeline round, 2026-08-04/05 (§A–§E) — code only, nothing to apply

---

## Part 1 — Warehouse Module R1

> Migrations `20260764`–`20260767` were applied and SQL-verified on **2026-08-04**.
> Code status: BUILT + gate-green at build time (287/287 tests, `inventory_hardening3.sql` 12 checks, 0 lint errors, build ✓). **Manual QA below is pending.**

## 0. Prerequisites

| Status | Step | Detail |
|--------|------|--------|
| ⬜ | Back up first | Supabase → Database → Backups: take a manual backup (or note PITR time). `20260767` edits real inventory rows. |
| ✅ | Apply migrations in order | `20260764` → `20260765` → `20260766` → `20260767`, each "Success" before the next. — **applied 2026-08-04** |
| ✅ | System locations exist | Warehouses tab lists RMA Received / Under Repair / Repaired / Can't Repair / Stock, Replacement Holding, Credit Note Holding, Scrap. |
| ✅ | Backfill placed old units | SQL: `SELECT count(*) FROM inventory_units WHERE status='active_rma' AND warehouse_id IS NULL AND rma_ticket_id IN (SELECT id FROM rma_tickets WHERE ticket_status <> 'Cancelled');` → **0**. |

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

**Note:** Commit 4 (removal of the 5 old RMA-stage tabs + `ProductStatusTab.jsx`) is already committed on `test`. The dashboard + RMA drawer replace them.

---

## Part 2 — Other pending QA from earlier sprints

These "BUILT ≠ VERIFIED" items are still open from earlier work — listed here so all outstanding manual testing is in one place.

| Status | Area | What still needs a manual click-through | Reference |
|--------|------|------------------------------------------|-----------|
| ⬜ | Purchase Module redesign (2026-07-05) | PO → Vendor Invoice funnel, approval pool, PO PDF export, Vendor Payments (AP) ledger, AP aging — full click-through incl. Arabic + dark mode. | migrations `20260756`–`20260763`; CLAUDE.md Purchase Module section |
| ⬜ | Sprint 8 Inventory UI | Dashboard/Stock Breakdown/Receive/Transfer/Adjust/Warehouses click-through (RPC layer already proven by CI). | CLAUDE.md active-sprint note |
| ⬜ | Sales-funnel 52-item checklist | The deferred 52-row Lead→Deal→QT→SO→Invoice→CN + Accounting v1 checklist. | lives in Claude memory `project-sales-funnel-test-checklist.md` (not in repo) |
| ⬜ | Credit-limit enforcement policy | Decision still deferred (block / warn / advisory) — not a test, a business call before it can be tested. | CLAUDE.md Accounting section |

---

## Part 3 — CRM Leads/Pipeline round (2026-08-04/05)

Closes the 8 findings from `MyCRM Manual Test 05-07-2026.xlsx` plus 3 gaps found while working. No migrations — code only, so nothing to apply first.

### A. Leads

| Status | Check | Expected |
|--------|-------|----------|
| ⬜ | Open a lead **that has a company name**, click Full Name in the Lead Info panel | An input appears (previously the field vanished). Enter saves, Escape cancels. |
| ⬜ | Lead tabs | Four tabs: **All Leads / Active / Converted / Disqualified**, each with a count. |
| ⬜ | Active tab contents | Excludes both converted **and** disqualified leads. |
| ⬜ | Kanban button | Visible **only** on the All Leads tab. |
| ⬜ | Open `/leads?status=converted&view=kanban` | Falls back to the list view, not an empty board. |
| ⬜ | Switch to All Leads → Kanban → other tab → back to All | The Kanban choice is remembered. |
| ⬜ | Disqualify a lead | Leaves Active, appears under Disqualified. |
| ⬜ | Disqualified lead → row menu → **Reopen Lead** | Returns to `new` and back into Active. |

### B. Deal edit dialog

| Status | Check | Expected |
|--------|-------|----------|
| ⬜ | Open any **open** deal | "Edit Deal" button top-right, next to Back. |
| ⬜ | Open a **won/lost** deal | Button absent; "Reopen Deal" shown instead. |
| ⬜ | Edit Deal → change **Customer** | Contact dropdown repopulates for the new customer and the old contact is cleared. |
| ⬜ | Customer with no contacts | Contact field is hidden entirely (not an empty dropdown). |
| ⬜ | Save changes | Persist correctly; the **deal log** shows entries naming the customer/contact, not UUIDs. |
| ⬜ | Change **Pipeline** | A Stage picker appears with an amber hint; defaults to the destination's first open stage. |
| ⬜ | Save the pipeline change | Deal lands in the new pipeline at that stage; deal log records the move. |
| ⬜ | Change pipeline, then change it **back** before saving | The deal's original stage is restored. |
| ⬜ | Deal log generally | Field edits appear (title, value, close date, probability, rep) — not only stage changes. |

### C. Multiple quotations per deal

| Status | Check | Expected |
|--------|-------|----------|
| ⬜ | Create **two** quotations on one deal (e.g. 10 and 15) | Both listed as separate cards; creating the second does not replace the first. |
| ⬜ | Deal value | Equals the **sum** (25). |
| ⬜ | Tab badge | Shows the QT code with one quotation, the **count** with several. |
| ⬜ | Send one for approval → approve from Activities | **Only that** quotation changes status; the other is untouched. |
| ⬜ | Approve a quotation | Its **Edit** button disappears (locked once approved). |
| ⬜ | Same check on `/sales/quotation/:id` | Edit also hidden there once approved. |
| ⬜ | Convert one to a Sales Order | It locks with a "View SO" link; **no Download PDF button** at that stage. |
| ⬜ | The other quotation | Still fully editable and independently convertible. |
| ⬜ | **Archive** a quotation | "Archived" badge appears; it shows under `/sales` → Archive tab. |
| ⬜ | **Restore** it | Returns to the active list. |
| ⬜ | Save/approve/archive anything | The quotation list refreshes immediately (no stale screen). |

### D. Deal value — forecast vs actual

Set up one deal with three quotations: **10 (converted)**, **15 (pending)**, **20 (pending)**.

| Status | Check | Expected |
|--------|-------|----------|
| ⬜ | Deal open | Value = **45** (all live quotations). |
| ⬜ | Decline or cancel the 20 | Value drops to **25** (dead quotations don't count). |
| ⬜ | Reopen that quotation for approval | Value returns to **45**. |
| ⬜ | Archive the 15 | Value drops to **30**. |
| ⬜ | Mark the deal **won** | Value drops to **10** (converted only). |
| ⬜ | **Reopen** the deal | Value climbs back to **45**. |
| ⬜ | Deal where nothing has converted → Mark Won | Button is **greyed out** with a tooltip explaining why. |
| ⬜ | Deal with **no quotations** and a hand-typed value → mark won | The typed value is **preserved**, not zeroed. |

### E. Regression

| Status | Check | Expected |
|--------|-------|----------|
| ⬜ | Create a **new** deal (not edit) | Unchanged: customer searchable, Stage picker present, no Contact field. |
| ⬜ | Lead → Convert to deal | Still works end to end. |
| ⬜ | Arabic + dark mode | All new UI (tabs, Edit Deal dialog, quotation cards, badges) reads correctly in both. |
