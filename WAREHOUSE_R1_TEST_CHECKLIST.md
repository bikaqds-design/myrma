# Warehouse Module R1 — Manual Test Checklist

> Run after applying migrations `20260764`–`20260767` in the Supabase SQL editor.
> Status: code BUILT + gate-green (287/287 tests, 0 lint errors, build ✓) — manual QA pending.

## 0. Prerequisites

- [ ] Apply migrations `20260764`, `20260765`, `20260766`, `20260767` in Supabase (in order).
- [ ] Confirm 8 system locations exist: **Warehouses tab** should list RMA Received / Under Repair / Repaired / Can't Repair / Stock, Replacement Holding, Credit Note Holding, Scrap.
- [ ] (Optional) In the SQL editor, confirm the backfill placed existing RMA units:
      `SELECT count(*) FROM inventory_units WHERE status='active_rma' AND warehouse_id IS NULL AND rma_ticket_id IN (SELECT id FROM rma_tickets WHERE ticket_status <> 'Cancelled');`
      → should be **0**.

## 1. System locations are protected

- [ ] Try to rename or delete one of the 8 system warehouses from the Warehouses tab → should be blocked / not offered.
- [ ] Confirm they still show manager/notes as editable (those are allowed).

## 2. Auto-move on ticket create

- [ ] Create a new RMA ticket with 2 products, one serialized. Save.
- [ ] Open Inventory → Overview → the product's **RMA** count should be ≥1; click it → RmaDrawer shows the unit(s) under **RMA – Received**.
- [ ] Stock Movements tab shows a `Transfer` row with doc type **RMA Ticket** (clickable → opens the ticket).

## 3. Auto-move on ticket edit

- [ ] Edit that ticket, change one product's status to **Under Repair**. Save.
- [ ] RMA drawer / Overview → that unit is now under **RMA – Under Repair**.
- [ ] Change it to **Repaired** → moves to **RMA – Repaired**. Change to **Replacement** or **Credit Note** → moves to **RMA – Stock**.
- [ ] Each change adds a new Stock Movements row.

## 4. Auto-move on bulk product-status

- [ ] Select multiple tickets in the RMA Tickets list, bulk-change product status.
- [ ] Confirm units moved for all of them (no error toast). If one fails you'll see "Ticket saved, but moving the unit(s)… failed."

## 5. Promote to sellable (the previously-missing path)

- [ ] From the RMA drawer, on a unit, pick a **Main** or **Branch** warehouse under "Promote to…".
- [ ] Unit disappears from RMA, and the product's **Available** / **Main** (or **Branches**) count goes up — it's now sellable stock.
- [ ] Try promoting a **reserved** unit → should be blocked with an error toast.
- [ ] Confirm a non-manager (viewer/technician) does **not** see the promote/move controls.

## 6. Dashboard columns

- [ ] Overview shows: Product | Tracking | Available | Reserved | Physical Total | Main | Branches | RMA.
- [ ] **Physical Total** = sellable + RMA locations, excluding Scrap.
- [ ] Move a unit to **Scrap** from the RMA drawer → it should NOT count in Available or Physical Total.
- [ ] Branches number → opens BranchesDrawer (Main + per-branch breakdown; bulk products show transfer/adjust shortcuts).

## 7. Non-catalog RMA products

- [ ] If any RMA ticket has a product name that doesn't match a catalog product, it appears as a row with a **"Not in catalog"** badge (RMA counts only, no checkbox).

## 8. Stock Breakdown modal

- [ ] Click a product name → the modal's **RMA Distribution** section lists real system locations (not old ticket-status text), and **Physical Total** shows in Product Info.

## 9. Regression — nothing else broke

- [ ] Existing Available/Reserved counts still correct for normal sellable products.
- [ ] Receive Stock, Transfer, Adjust, Warehouses CRUD all still work.
- [ ] Sales funnel (reserve/deliver) unaffected.

---

**After QA passes:** Commit 4 removes the 5 old RMA-stage tabs (Received/Under Repair/Repaired/Can't Repair/RMA Stock) and `ProductStatusTab.jsx`, since the dashboard + RMA drawer replace them. Deep links to `?tab=received` etc. fall back to Overview.
