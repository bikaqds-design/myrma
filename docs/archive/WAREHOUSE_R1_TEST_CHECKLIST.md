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

## Current status — 2026-08-13

**Every module on the finished list now has a completed QA run.** The dated run logs below are
historical: read them for what was found, not for what is outstanding. A statement like "43 rows
remain ⬜" was true on the day it was written and has since been overtaken.

| Module | Where it was run | State |
|---|---|---|
| Inventory / Warehouse R1 | this file, §0–§9 | ✅ closed 2026-08-05/06; regression re-run ✅ 2026-09-17 (4 findings, see below; #1 fixed by `20260874`) |
| Sales, Accounting, Leads, Deals, Activities (funnel) | this file, "Sales-Funnel 52-Item Checklist" | ✅ 52/52 closed 2026-08-06/07 |
| Purchasing | this file, "Purchase Module (Sprint 9R)" | ✅ closed 2026-08-07 |
| Leads / Pipeline (Sprints 2.5 + 3) | `CRM_QA_CHECKLIST.md` | ✅ closed 2026-08-08, bar row 40 |
| RMA Tickets | `RMA_TICKETS_QA_CHECKLIST.md` | ✅ 55/55 closed 2026-08-12 |
| Customers | `CUSTOMERS_QA_CHECKLIST.md` | ✅ 36/36 closed 2026-08-12 |
| Public Tracker | `PUBLIC_TRACKER_QA_CHECKLIST.md` | ✅ 15/15 closed 2026-08-12 |
| Products | `PRODUCTS_QA_CHECKLIST.md` | ✅ 40/40 closed 2026-08-13 |

Not run, deliberately: **Dashboard, Calendar, Control Panel and Reports** are being rebuilt for the
CRM direction, and **permissions/roles**, which the user parked until the project is finalised.

**Migration `20260775_post_invoice_requires_reservations.sql` — APPLIED AND VERIFIED 2026-08-16.**
The BUG #44 fix is live. Verified against the exact record that exposed the bug; see the write-up
under BUG #44.

**What is genuinely still open** — three items, none of them a code defect:

1. **Touch/mobile drag** (`CRM_QA_CHECKLIST.md` row 40) — needs a real touch device; no emulator
   substitute. Open since the sprint that built it.
2. **`db-tests` CI job** — **superseded 2026-08-16, not pending.** Docker is ruled out, and that
   job could never have passed anyway: it applies migrations to an empty Postgres, but 13 core
   tables were created by Base44 and no migration creates them. Replaced by the `DB · Integration`
   job, which runs `npm run test:integration` against the hosted project — no container, no
   baseline dump. The old job should be deleted once its `supabase/tests/*.sql` assertions are
   ported.
3. **Speed Technology System** — contact fields blank after the delete incident of 2026-08-12;
   needs the user's original import source. The record and its code `CB-50916011` exist.

The three cosmetic snags listed here previously are now closed (2026-08-13). Two were real and
fixed — the products empty state reading "Showing 1-0 of 0", and the bulk-delete dialog titled
"Delete Product" (singular) with a hardcoded English message. The third, the PO Currency
placeholder promising `USD` while the effective default is `EGP`, turned out to have been fixed
already in commit `d9e1564`; this note was stale.

Chasing those two turned up **BUG #42** — a render loop firing "Maximum update depth exceeded" on
every page load, present at HEAD and long predating the QA runs. Row 40 of
`PRODUCTS_QA_CHECKLIST.md` had passed it; see the write-up there for why.

A follow-up sweep found it on **three** pages, not one. Products used `?? []`; **Customers** and
**RMA Tickets** used the React Query destructuring default `const { data: x = [] } = useQuery(…)`,
which has the same effect and is the more common spelling. Both comment panels shared it. All
five sites now use one shared frozen `EMPTY_ARRAY` (`src/lib/stableEmpty.ts`), which documents the
trap. Re-verified by loading all nine finished modules in separate fresh tabs against a restarted
server: zero occurrences.

~28 `useMemo`/`useCallback` deps on the same unstable bindings were left alone on purpose — they
defeat memoisation during the loading window only, then go stable, so there is no loop and no
warning.

Two product decisions are logged rather than fixed, both in `RMA_TICKETS_QA_CHECKLIST.md`: there is
no stock summary on the product detail page, and a credit note closes its RMA ticket (now warned
about and logged, but still an implicit rule).

---

### Regression re-run — 2026-09-17

Owner asked for §1–§9 again after September's changes (BUG-066 paged inventory views, BUG-032
`transfer_units` ledger, BUG-087 fail-closed guards, BUG-030 ticket parts). Run in the owner's
Chrome as `bika.qds@gmail.com` (super_admin) against production test data, every step checked in
the UI **and** in the database. Baseline: 441 units, 557 stock moves, 13 tickets.

| § | Result | Evidence |
|---|---|---|
| 1 | ✅ | 8 system rows show only the padlock; sellable rows can be archived. Padlock opens the editor with name/code/type disabled and no Active toggle. Manager `qa-r1@example.com` saved on `CREDIT-NOTE` (name/code/type/active unchanged in the DB), then cleared. |
| 2 | ✅ | Ticket with an already-tracked serial (`TEST-CB86E9-0022`) **blocked** with the named-serial message; DB unchanged (13 / 441 / 557). With a fresh serial: `RMA-17092026-0001` created, `test 3` unit `QA-R1-0917-A` (with `product_id`) and non-catalog `QA-R1-0917-B` both in **RMA-RECEIVED**, 2 `transfer` moves `doc_type=rma_ticket`, actor from the session. Overview `test 3` RMA 3→4, Physical Total 20. |
| 3 | ✅ | Under Repair → RMA-REPAIR, Repaired → RMA-REPAIRED, Replacement → **RMA-STOCK** (Replacement Holding stayed 0); moves 559→560→561→562, one per edit. |
| 4 | ✅ | Bulk product-status *Can't Repair* on `RMA-17092026-0001` + `RMA-06082026-0001`: all three units (including `QA-NOCRM-001` on the second ticket) → RMA-CANTREPAIR, moves 562→565, no error. |
| 5 | ✅ | RMA drawer: *Promote to…* lists only Main Warehouse / Branch – Cairo; *Move to…* only system locations. Promote `QA-R1-0917-A` → Main: toast "Unit promoted to sellable stock", Available 15→16, Main 16→17, RMA 4→3, Physical Total unchanged, 1 move. **Technician gate not re-run** — it needs signing in as a technician, and passwords are not entered by the agent; the database side is covered by `authenticated_role_probes.sql` (28/28 today). |
| 6 | ✅ | Columns unchanged. `QA-NOCRM-001` → Scrap: Physical Total 20→19, Available 16, RMA 3 (drawer regroups under SCRAP (1)). Branches drawer, serialized `test2`: Main 21 / Cairo 27, no controls. **Bulk** `QA Bulk Widget` (unchecked in August for lack of data): Main 33 / Cairo 6 with Transfer/Adjust; transferred 1 Cairo → Main — `warehouse_stock` Cairo 5 / Main 34, `transfer` move `ref_type=warehouse_stock`, toast shown, Overview row updated. |
| 7 | ✅ | `QA R1 Non Catalog Device`: "Not in catalog" badge, no checkbox, Available/Main 0, RMA 1. |
| 8 | ✅ | Stock Breakdown for `test 3`: RMA Distribution "RMA – Received 2, Scrap 1" (real locations), Physical Total 19. |
| 9 | ✅ | For all 406 non-service products the Overview's Available, Reserved and RMA equal a direct count of units / `warehouse_stock` — **0 mismatches**. No active unit unplaced; no RMA unit reserved. |

**Findings (not fixed in this run):**

1. **FIXED 2026-09-17 (`20260874_delivered_units_not_on_hand.sql`, owner request) — delivered units still counted as stock on hand.** After the fix, applied and verified: test2 Main 21 → 1 and Physical 50 → 30, test 3 Main 17 → 16, MAIN warehouse units 398 → 377 in the UI; a warehouse holding only delivered stock can be archived. Original finding: A serialized unit delivered on a sales order keeps
   `status = 'company_stock'` with `reservation_status = 'delivered'`. `v_product_stock_summary`
   excludes it from Available but still counts it in **Main** (or Branches) and **Physical Total**, and
   the Stock Breakdown shows it in "Total" and the warehouse distribution. 21 units today: `test2`
   shows Main 21 where 20 were delivered to customers, `test 3` Main 17 with one delivered. The
   dashboard overstates physical stock by every unit ever sold. Needs a decision: exclude delivered
   units from Main/Branches/Physical Total, or move a delivered unit out of `company_stock`.
2. **Branches drawer does not refresh after a transfer.** After a successful bulk transfer the open
   drawer still showed Main 33 / Cairo 6 while the table and the database had 34 / 5; closing and
   reopening showed the right numbers.
3. **Escape discards the Create Ticket form without asking.** Pressing Escape to dismiss the product
   suggestion list closed the whole dialog and lost everything typed.
4. *(cosmetic)* The RMA drawer's *Move to…* list offers the unit's current location.

Left in the test data: ticket `RMA-17092026-0001` (units `QA-R1-0917-A` in Main, `QA-R1-0917-B` in
RMA-CANTREPAIR), `QA-NOCRM-001` in Scrap, `RMA-06082026-0001` product status Can't Repair, and
`QA Bulk Widget` Main 34 / Cairo 5. All production data is disposable test data.

### Run log — 2026-08-05

Ran against the **live** project (`ohkynosgscfygtjxbpxq`) via a local dev server, signed in as
super_admin. Docker is not installed on this machine, so the local-Supabase option was
unavailable and no seeded fixtures could be created.

Two phases: a read-only observation pass first, then a mutating pass. **The §0 backup was
explicitly waived by the user**, on the condition that writes stay confined to test data created
for the run — no existing customer ticket, deal, or stock row was modified.

**26 rows verified this session, 0 outstanding failures** (29 ✅ in the file overall — the other 3
are §0 prerequisites ticked on 2026-08-04). **43 rows remain ⬜.** Two defects were found, both
fixed and re-verified the same day:

1. **§1 — system-warehouse metadata was uneditable.** The padlock replaced the whole action cell,
   so the edit modal was unreachable even though the `20260764` trigger permits
   location/description/manager/notes. Fixed in `WarehousesTab.jsx` (metadata-only edit mode) plus
   `whSystemLocked` / `whSystemEditHint` copy in `en.json` / `ar.json`.
2. **§2 — a duplicate serial silently voided every unit on a ticket.** See the full write-up under
   §2. Fixed in `src/lib/rmaUnitCreate.ts` + `createUnitsFromTicket` + `TicketForm`, and confirmed
   live: the save is now rejected with a message naming the tracked serial.

- Gates: **305/305 → 343/343 vitest** (11 suites) after the §2 fix, `lint:ci` 0 errors, build ✓.
- §8 remains **⬜ and cannot be closed as written** — see the `product_id` note under §2.
- Two cosmetic snags, neither a checklist row: stale "Received" breadcrumb on the
  `?tab=received` fallback, and non-catalog Overview rows are not clickable.

**Test data — cleaned up 2026-08-05.**

Removed: RMA tickets `05082026-0001/0002/0003` (tickets 14 → 11; the `ON DELETE CASCADE` on
`inventory_units.rma_ticket_id` took the fabricated units with them — **All Units 435 → 433**, and
`test 3` back to its original **15 / 15 / 15, RMA 0**, so the unit promoted into Main during §5 is
gone). Deal `OPP-46593354` deleted. Quotations `QT-17864855` / `QT-23780393` archived — sales
documents are never deleted, only archived — which returned `OPP-96369062` to its original value
of **"—"**.

> **🐞 EIGHTH BUG — the records created by a lead conversion cannot be removed through the app.**
> Found 2026-08-05 while cleaning up. Converting lead `LD-82701445` produced three linked records,
> and **none of them can be deleted from the UI**:
> - **Lead** `LD-82701445` — converted leads are locked read-only; the row menu offers only *View*
>   (no Edit, no Delete, no Reopen — unlike a *disqualified* lead, which does get *Reopen Lead*).
> - **Deal** `OPP-97835765` — delete returns **HTTP 409** (foreign-key conflict) because the lead
>   still references it. The UI surfaces nothing: the confirm accepts, the row stays, no error toast.
> - **Customer** `CB-36415389` — `delete_customer_cascade` (`20260524`) covers tickets, units,
>   comments, activity and notes, **but not deals**, so the deal's FK blocks it too.
>
> The three form a cycle with no UI exit. Deleting them needs direct SQL. Worth either cascading
> the conversion artifacts, allowing a converted lead to be unlinked, or surfacing the 409 as a
> real error instead of a silent no-op.
>
> **Three QA records deliberately left in place** — user opted to skip the SQL cleanup on
> 2026-08-05. They are harmless but not removable through the UI:
>
> | Record | Code | Note |
> |---|---|---|
> | Lead | `LD-82701445` | *QA Convert Throwaway* — converted, locked read-only |
> | Deal | `OPP-97835765` | *QA Convert Throwaway — Deal Title*, 777 EGP, stage *New Deals* |
> | Customer | `CB-36415389` | *QA Throwaway Co*, B2B, `qa-throwaway@example.com` |
>
> They inflate the deal count by one and add **777 EGP** to the pipeline forecast total. If they
> are ever removed, delete in this order (the lead's FK is what causes the 409):
>
> ```sql
> DELETE FROM deals     WHERE deal_code     = 'OPP-97835765';
> DELETE FROM leads     WHERE lead_code     = 'LD-82701445';
> DELETE FROM customers WHERE customer_code = 'CB-36415389';
> ```
>
> The underlying defect — a conversion cycle with no UI exit, and a silent 409 — stands regardless
> of whether these particular rows are cleaned up.

**Sections still to run:** §4 bulk product-status, §5 promote-to-sellable, §6 scrap + Branches
drawer, §9 regression, and the §B / §C / §D write paths in Part 3. All of Part 2 is untouched.

---

## Part 1 — Warehouse Module R1

> Migrations `20260764`–`20260767` were applied and SQL-verified on **2026-08-04**.
> Code status: BUILT + gate-green at build time (287/287 tests, `inventory_hardening3.sql` 12 checks, 0 lint errors, build ✓). **Manual QA below is pending.**

## 0. Prerequisites

| Status | Step | Detail |
|--------|------|--------|
| ✅ | ~~Back up first~~ → **all migrations applied** | Closed 2026-08-06 as historical. This row guarded the migration run; migrations **`20260764`–`20260770` are all applied and confirmed** (`20260764`–`20260767` on 2026-08-04; `20260768` backfill, `20260769` link-serial RPC and `20260770` transfer guard during this QA pass, each verified in the app afterwards). Nothing left to back up *for*. |
| ✅ | Apply migrations in order | `20260764` → `20260765` → `20260766` → `20260767`, each "Success" before the next. — **applied 2026-08-04** |
| ✅ | System locations exist | Warehouses tab lists RMA Received / Under Repair / Repaired / Can't Repair / Stock, Replacement Holding, Credit Note Holding, Scrap. |
| ✅ | Backfill placed old units | SQL: `SELECT count(*) FROM inventory_units WHERE status='active_rma' AND warehouse_id IS NULL AND rma_ticket_id IN (SELECT id FROM rma_tickets WHERE ticket_status <> 'Cancelled');` → **0**. |

## 1. System locations are protected

| Status | Check | Expected |
|--------|-------|----------|
| ✅ | Try to rename or delete a system warehouse | Blocked / not offered (lock icon instead of edit/archive). — **verified 2026-08-05**: all 8 system rows render a padlock; only the 2 sellable rows have edit/archive. |
| ✅ | Edit a system warehouse's manager/notes | Allowed (those fields stay editable). — **failed then FIXED + verified 2026-08-05.** Was: the lock replaced the whole action cell, so the edit modal was unreachable. Now the lock is a button that opens the modal in metadata-only mode — name/code/type disabled, Active checkbox hidden, location/description/manager/notes editable, and the payload omits the protected fields entirely. Round-tripped a manager value on `CREDIT-NOTE` against the live DB (trigger accepted it, value persisted, then cleared). |
| ✅ | Warehouses tab grouping | Rows grouped Sellable / Other / System; system rows show a "System" badge. — **verified 2026-08-05** (the "Other" group is empty in this data, so correctly not rendered). |

## 2. Auto-move on ticket create

| Status | Check | Expected |
|--------|-------|----------|
| ✅ | Create an RMA ticket with 2 products (one serialized), save | Ticket saves normally. — **verified 2026-08-05** (RMA-05082026-0001, RMA-05082026-0002). |
| ✅ | Overview → RMA column for that product | Count ≥ 1; clicking opens the RMA drawer showing the unit(s) under **RMA – Received**. — **verified 2026-08-05** on RMA-05082026-0002: unit created, `All Units` 433→434, Overview row shows RMA 1 / Physical Total 1. |
| ✅ | **Re-test after the duplicate-serial fix** | Ticket with a fresh serial + an already-tracked serial → save is **blocked** with a message naming the tracked serial. Remove that product → the remaining product saves and gets its unit. — **verified 2026-08-05** against the landed fix: a ticket using `TEST-CB86E9-0022` is now rejected with *"Serial number TEST-CB86E9-0022 is already tracked in inventory. Correct the serial, or resolve the existing unit before opening a new RMA for it."* No ticket row and no partial units were written. Gates after the fix: **343/343 tests** (up from 305), 11 suites. |
| ✅ | Stock Movements tab | A `Transfer` row, doc type **RMA Ticket**, clickable back to the ticket. — **verified 2026-08-05**: `Transfer` / QA-DIAG-PROBE (QA-DIAG-SN-1) / qty 1 / document **RMA Ticket** (linked) / actor; count 474→475. |

> **🐞 BUG found while running §2 — a duplicate serial silently voided every unit on the ticket. FIXED + RE-TESTED LIVE 2026-08-05.**
> `createUnitsFromTicket` inserted all of a ticket's units in **one batch** (`.insert(units)`) and
> then swallowed every error, `return []` on any failure. RMA-05082026-0001 was created with two
> products — a **catalog** product (`test2`, serial `TEST-CB86E9-0022`, a serial that already
> exists in `inventory_units`) plus a non-catalog one. The duplicate serial failed the batch, so
> **neither** product got a unit, no stock movement was written, and **the UI showed no error at
> all** — the ticket saved "successfully". RMA-05082026-0002, with a single fresh serial, worked.
>
> Three changes landed:
> - **(a) no more all-or-nothing.** The batch insert is still the fast path, but on failure each
>   row is retried individually, so a bad row only costs itself. (A multi-row INSERT is one atomic
>   statement, so nothing was written when the batch errored — the retry cannot double-insert.)
> - **(b) failures are visible.** `createUnitsFromTicket` now returns
>   `{ created, failed, missing }` instead of a bare array, and `dispatchCreateSideEffects`
>   toasts `inventory.unitCreateFailed` naming the offending serial(s), mirroring the edit path's
>   `inventory.autoMoveFailed`. A `42P01` missing table stays silent (optional-table deployments).
> - **(c) rejected up front.** The create path now pre-checks serials against live
>   `inventory_units` rows (`findTrackedSerials`, `status <> 'closed'` — same filter as
>   `inv_units_serial_unique_idx`) plus same-serial-twice-on-one-ticket, and blocks the save with
>   `ticketForm.serialAlreadyTracked` / `ticketForm.serialDuplicateInTicket`.
>
> Pure logic lives in `src/lib/rmaUnitCreate.ts`; covered by `src/test/rmaUnitCreate.test.js` and
> `src/test/inventoryCreateUnits.test.js` (38 tests).
>
> **⚠️ Open design decision — an RMA on an already-sold serial is now blocked, not linked.**
> The correct long-term behaviour is arguably to **link the existing unit** (move the
> `company_stock` unit into `RMA-RECEIVED` and attach it to the new ticket) rather than reject the
> save. That was left out deliberately: it changes inventory state, needs `stock_moves` entries and
> a reserved-unit guard, and belongs with the reservation model rather than a defect fix. Until
> then the user gets a clear message naming the serial instead of silent data loss.

> **🐞 SECOND BUG found while running §2 — RMA units were invisible to the dashboard. FIXED + VERIFIED 2026-08-05.**
> `getStockSummary` groups units by `product_id`, but `createUnitsFromTicket` only ever set
> `product_name`. **Every** RMA-ticket unit therefore landed in the "Not in catalog" bucket even
> when the ticket named a real catalog product — the RMA column was structurally dead for the
> whole catalog, and §8 could not be closed.
>
> Fixed on both sides:
> - **Forward path.** The product picker now captures `product_id` (`_shared.jsx`,
>   `TicketForm.jsx` via `setProductChoice`, `EMPTY_PRODUCT`), and `buildTicketUnits` resolves it —
>   the captured id wins, a name match covers typed and legacy lines, and a name shared by two
>   catalog products is skipped rather than guessed. Verified live: RMA-05082026-0003 against
>   `test 3` moved it to **RMA 1 / Physical 16**, with product count staying 405 — no phantom
>   "Not in catalog" row.
> - **Historical rows.** Migration `20260768` backfills by name under the same conservative rules.
>   Applied 2026-08-05: product count **415 → 405**, `test2` → RMA 4, `Z490 Steel Legend` → RMA 3,
>   `24G2SP` → RMA 1.
>
> **⚠️ The backfill exposed a third bug — see §9.** Making RMA units visible made them count as
> sellable. Do not apply `20260768` without the `stockSummary` fix.

## 3. Auto-move on ticket edit

| Status | Check | Expected |
|--------|-------|----------|
| ✅ | Change a product to **Under Repair**, save | Unit moves to **RMA – Under Repair**. — **verified 2026-08-05** on RMA-05082026-0002: RMA-RECEIVED 11→10, RMA-REPAIR 2→3. |
| ✅ | Change it to **Repaired** | Unit moves to **RMA – Repaired**. — **verified 2026-08-05**: RMA-REPAIR 3→2, RMA-REPAIRED 1→2. |
| ✅ | Change to **Replacement** or **Credit Note** | Unit moves to **RMA – Stock**. — **verified 2026-08-05** with `Replacement`: RMA-REPAIRED 2→1, RMA-STOCK 1→2. Confirms it lands in RMA-STOCK, *not* the REPLACEMENT holding location (which stayed 0) — matching `buildRmaMoves`. |
| ✅ | Each change | Adds a new Stock Movements row. — **verified 2026-08-05**: 475 → 476 → 477 → 478 across the three edits, exactly one per change. |

## 4. Auto-move on bulk product-status

| Status | Check | Expected |
|--------|-------|----------|
| ✅ | Select several tickets, bulk-change product status | Units move for all of them, no error toast. — **verified 2026-08-05**: selected RMA-05082026-0001/0002/0003, bulk-set **Can't Repair**. RMA-CANTREPAIR 1→**3**, RMA-RECEIVED 11→**10**, RMA-STOCK 2→**1**, Stock Movements 479→**481** (one row per moved unit). Success toast only, no error. Ticket 0001 carries no units and did **not** break the batch. |
| ✅ | ~~(If one fails) — toast~~ → **the rejection behind the toast is asserted in CI** | Reworded + covered 2026-08-06, by decision: moved from a manual UI step to the SQL hardening suite. <br><br>**Why it could never be run manually:** the toast fires when `move_rma_units` rejects. A technician was tried on 2026-08-06 — `move_rma_units` requires only `rma_is_staff() AND role <> 'viewer'`, so it **succeeded** (RMA-13062026-0001's unit moved *Under Repair → Repaired*, reverted afterwards). Only a *viewer* trips the auth guard, and a viewer has no bulk control to trigger it with. The other rejections need a reserved unit, a foreign unit, or a missing location — states the application cannot produce. <br><br>**Now covered by `inventory_hardening3.sql` CHECK 6b** (new): stages an `active_rma` + `reserved` unit and asserts `move_rma_units` refuses it with `P0001` — the exact rejection the toast reports. Asserts the SQLSTATE rather than "something threw", so a malformed fixture cannot make it pass by accident. Runs in CI on every push instead of needing a tester who can never reach the state. <br><br>The UI half — that a rejection surfaces as `inventory.autoMoveFailed` — remains confirmed by inspection (`RMATickets/index.jsx:548-557`, copy matching in both locales). |

## 5. Promote to sellable (the previously-missing path)

| Status | Check | Expected |
|--------|-------|----------|
| ✅ | RMA drawer → a unit → "Promote to…" → pick a Main/Branch warehouse | Unit leaves RMA; product's Available / Main (or Branches) count rises. — **verified 2026-08-05** on `test 3` / `QA-CAT-SN-1`: Available 15→**16**, Main 15→**16**, RMA 1→**0**, Stock Movements 481→**482**. Physical Total stayed **16**, which is correct — the unit was already physically present, it only became sellable. Drawer then reads "No RMA ticket activity for this product". The **Promote to…** list offers only Main Warehouse / Branch – Cairo, correctly excluding all 8 system locations, while **Move to…** offers only system locations. |
| ✅ | ~~Try promoting a **reserved** unit~~ → **`promote_rma_unit` refuses a non-available unit** | Reworded 2026-08-06 — the original wording described a state the application cannot produce. Reservations are only ever placed on `company_stock` units by the sales funnel; a unit that is simultaneously `active_rma` **and** `reserved` has no route into existence through the UI, so "try promoting a reserved unit" can never be performed by a tester. <br><br>**What is actually verifiable, and is verified:** `promote_rma_unit` (`20260766`, lines 125-129) raises `P0001` when `reservation_status <> 'available'`, and `RmaDrawer.jsx` has no client-side pre-check — so the RPC is the sole gate and any such unit would be refused server-side. This is **defence in depth against a state the UI cannot reach**, not a user-facing flow. <br><br>**Belongs in the SQL hardening suite, not a UI checklist** — assert the rejection directly (insert a unit as `active_rma` + `reserved`, call the RPC, expect `P0001`) alongside the other `inventory_hardening` checks. Tracked as a test-suite item, not a manual step. |
| ✅ | Log in as viewer/technician | Promote/move controls are **not** shown (manager+ only). — **verified 2026-08-06** signed in as `omara@qdsegypt.com` (**technician**). Opening the RMA drawer for `test2` lists the units grouped by location with serial / warranty / days-here / ticket link, but **neither "Move to…" nor "Promote to…" renders** — the only `<select>` on the page is the pagination control. Under super_admin every unit carried both. <br><br>Three further gates confirmed in the same session, all correct: <br>• **Navigation** filtered to Dashboard / Products / Customers / RMA Tickets / Inventory / Calendar / Customer Tracker — Leads, Pipeline, Activities, Sales, Accounting, Purchasing, Reports and Control Panel all hidden. <br>• **Receive Stock** button absent from the Inventory header (present for super_admin). <br>• **Warehouses tab fully read-only** — no *New Warehouse*, no Archive, no row actions at all (super_admin sees edit/archive on sellable rows and the padlock on system rows). |

## 6. Dashboard columns

| Status | Check | Expected |
|--------|-------|----------|
| ✅ | Overview columns | Product / Tracking / Available / Reserved / Physical Total / Main / Branches / RMA. — **verified 2026-08-05**, exact match; the 5 old RMA-stage tabs are gone (only Overview / All Units / Stock Movements / Warehouses). |
| ✅ | Move a unit to **Scrap** (RMA drawer) | Not counted in Available or Physical Total. — **verified 2026-08-05** on `test2` / unit `dsdsa` (RMA-04062026-0001): Physical Total 52→**51**, Available stayed **27**, Main stayed 48, Stock Movements 482→**483**. The drawer regrouped it under a new **SCRAP (1)** heading and RMA – Received fell 2→1. The RMA column stays **4**, which is correct — SCRAP is itself a system RMA location, so the unit is still *in* RMA, just no longer physical stock. |
| ✅ | Click a Branches number | Opens the Branches drawer (Main + per-branch; bulk products show transfer/adjust). — **verified 2026-08-05** once real branch stock existed: the drawer lists **Main 21** and **Branch – Cairo 27** for `test2`. Earlier in the run `BR-CAIRO` held 0 units and the drawer correctly showed "No stock at any branch"; the manual transfer of 27 units made the per-branch row observable. *Bulk-product transfer/adjust controls remain unchecked* — no bulk-tracked product with branch stock exists in this data. |

## 7. Non-catalog RMA products

| Status | Check | Expected |
|--------|-------|----------|
| ✅ | RMA ticket with a product name not in the catalog | Appears as a row with a **"Not in catalog"** badge, RMA counts only, no checkbox. — **verified 2026-08-05** on `test2`: catalog row (RMA 0, checkbox present) and non-catalog row (RMA 4, Available/Main 0, no checkbox) sit side by side. Non-catalog rows are also not clickable (no product record to open). |

## 8. Stock Breakdown modal

| Status | Check | Expected |
|--------|-------|----------|
| ✅ | Click a product name | RMA Distribution lists real system locations (not old ticket-status text); Physical Total shown in Product Info. — **verified 2026-08-05** on catalog product `test 3` (RMA-05082026-0003): RMA Distribution reads **"RMA – Received  1"** — a real system location, not ticket-status text — with Physical Total **16** in Product Info, Warehouse Distribution Main **15**, and Reserved empty. Could only be closed once the `product_id` fix landed; before it, no catalog product could hold an RMA unit at all. |

## 9. Regression — nothing else broke

| Status | Check | Expected |
|--------|-------|----------|
| ✅ | Normal sellable products | Available/Reserved counts still correct. — **caught a real bug 2026-08-05, now fixed + verified.** See below. |

> **🐞 THIRD BUG — RMA units were counted as sellable stock. FIXED + VERIFIED 2026-08-05.**
> Immediately after the `20260768` backfill, `test2` jumped from **27 Available to 31** — exactly
> its 4 RMA units. `getStockSummary` computed `available` / `reserved` / `delivered` over *every*
> unit belonging to the product, and an `active_rma` unit carries `reservation_status: 'available'`
> because nothing has reserved it. So every unit sitting in an RMA location was reported as
> available to sell.
>
> **Latent, not introduced.** Before RMA units had a `product_id` they matched no product and were
> silently skipped. The second fix made them visible, and the overcount appeared. Had the backfill
> shipped without this check, every serialized product with an open RMA would have overstated
> sellable stock — the kind of error that gets a unit sold twice.
>
> Fixed by scoping all three counts to company stock. The arithmetic was extracted to
> `src/lib/stockSummary.ts` (`summarizeSerializedUnits`) so it is testable without a Supabase mock;
> `src/test/stockSummary.test.js` adds 20 tests, 6 aimed at this defect. The regression tests were
> validated by temporarily reinstating the bug — 5 failed, including `expected 4 to be 2`, the
> production symptom in miniature — then reverting.
>
> Verified live: `test2` back to **27**, `24G2SP` to **10 available / 11 physical / 1 RMA**.
| ✅ | Receive Stock / Transfer / Adjust / Warehouses CRUD | All still work. — **all four verified.** <br>• **Transfer** — regression found and fixed 2026-08-05 (see below); a real 27-unit Main → Branch – Cairo transfer completed 2026-08-05 against the rewritten `transfer_stock`. <br>• **Warehouses CRUD** — verified in §1 (edit modal, metadata save, system-row protection). <br>• **Receive Stock** — verified 2026-08-06 as admin: received `QA-RECEIVE-SN-1` of *test 3* into Main. All Units 433→**434**, movements 512→**513**, `test 3` 15→**16** across Available / Physical / Main. The destination dropdown offered only *Branch – Cairo* / *Main Warehouse* — confirming the `destinationWarehouses` fix in `ReceiveStockModal`, which previously had **no filter at all**. <br>• **Adjust** — verified 2026-08-06 on that same unit: status *Company Stock → Sent to Manufacturer* dropped `test 3` to **15 / 15 / 15** while All Units held at **434** (the unit still exists, it is simply no longer stock) and movements logged **514**. |

> **🐞 ELEVENTH — Adjust was a one-way door for non-stock statuses. FIXED + VERIFIED 2026-08-06.**
> Found while running the row above — and the fix was proven by using it to recover the very unit
> the bug had stranded.
>
> The Breakdown modal's `availableUnits` filters `status === 'company_stock' && reservation_status
> === 'available'` (`StockBreakdownModal.jsx:72-78`), and **only those rows render Transfer /
> Adjust** (line 198). The Reserved and RMA-distribution sections offer no actions.
>
> So adjusting a unit to **Sent to Manufacturer** or **Closed** removes it from the only surface
> that can adjust it. Afterwards it appears solely in the read-only All Units drill-in (Serial /
> Warranty / Status / Warehouse — no per-row actions, no checkbox), and **there is no UI path to
> return it to Company Stock.** The same trap as the lead-conversion cycle: an action the app
> offers, with no route back.
>
> **Fix:** a new **Off-Stock Units** section in `StockBreakdownModal.jsx` lists every unit that is
> neither `company_stock` nor `active_rma`, showing its status and an **Adjust** action so it can be
> returned to stock. Transfer is deliberately *not* offered there — `transfer_stock` requires an
> available company-stock unit and would reject them anyway. The section only renders when such
> units exist, so the modal is unchanged for healthy products. Copy added to `en.json` / `ar.json`
> (`offStockUnits`, `offStockUnitsHint`); manager+ gated like the Available Units section.
>
> **Verified by recovering the stranded unit:** `QA-RECEIVE-SN-1` appeared under *Off-Stock Units*
> as `sent_to_manufacturer`, and adjusting it back to **Company Stock** restored `test 3` to
> **16 / 16 / 16** (movements 515). No residue — the round trip Receive → Adjust off stock →
> Adjust back is now complete in both directions. Gates: 392 tests, lint clean, build ✓.

> **🐞 FOURTH BUG — sellable stock could be transferred straight into a system RMA location. FIXED + VERIFIED 2026-08-05.**
> Inventory → click a product → Stock Breakdown → **Transfer** on any available unit. The
> destination dropdown lists **every** active warehouse, including all 8 protected system
> locations — **Scrap**, Credit Note Holding, Replacement Holding and every RMA stage.
>
> The guard exists in one modal but not the other:
> - `TransferModal.jsx:18-19` filters `w.is_active && !w.is_system && …`, with a comment stating
>   units reach system locations "only via the RMA auto-move / promote flow, never a manual
>   transfer".
> - `TransferStockModal.jsx:85` filters only `w.is_active && w.id !== fromWarehouseId` — the
>   `!w.is_system` clause is **missing**. This is the modal behind the Stock Breakdown Transfer
>   link, i.e. the primary user path.
>
> **No server-side backstop either**: `public.transfer_stock` (`20260744`) predates system
> locations and never checks `is_system` on the destination.
>
> Impact: a unit can be written off to SCRAP with no RMA ticket, or land in RMA-RECEIVED with a
> NULL `rma_ticket_id` — corrupting the dashboard's RMA counts and Physical Total, and silently
> removing stock from inventory value. **Not demonstrated on live data on purpose** — the dropdown
> contents plus the two source filters are the evidence.
>
> **The audit found it was worse than the one modal.** All four destination lists were wrong:
> `TransferStockModal` and both `BulkStockActionModal` lists omitted `!is_system`, and
> **`ReceiveStockModal` had no filter at all** — it offered archived warehouses too.
>
> Fixed by replacing four inlined filters with one tested helper,
> `src/lib/warehouseDestinations.ts` (`destinationWarehouses`), covered by
> `src/test/warehouseDestinations.test.js` (14 tests). Server-side backstop added in migration
> **`20260770`**: `assert_not_system_warehouse` plus a full restatement of `transfer_stock`
> carrying the guard on **both** ends — destination (the defect) and source (moving stock *out* of
> an RMA location must go through `promote_rma_unit`, which enforces reservation rules
> `transfer_stock` does not). The RPC body is restated verbatim from `20260744` rather than
> patched at runtime, so the change reviews as a diff.
>
> Verified live 2026-08-05: the Transfer destination list went from **10 options to 2**
> (Select + Branch – Cairo); all 8 system locations gone, source warehouse still excluded.
>
> **`20260770` applied successfully 2026-08-05, and the happy path is confirmed.** A manual
> transfer of **27 `test2` units from Main → Branch – Cairo** succeeded against the rewritten
> `transfer_stock`: Main 48 → **21**, Branches 0 → **27**, Stock Movements 483 → **510** (one row
> per unit), All Units unchanged at 435 (a transfer moves units, it does not create them).
> Available stayed **27** and Reserved **1** — moving stock between two sellable warehouses must
> not change availability, and it did not. Physical Total **51** = 48 company stock + 3 RMA (the
> 4th RMA unit is in SCRAP and correctly excluded).
>
> Both layers of the fix are therefore verified: the destination list is filtered (10 options → 2)
> **and** a legitimate transfer still completes end to end.
| ✅ | Sales funnel (reserve/deliver on an SO/Invoice) | **RUN AND PASSED 2026-08-16 — and it found BUG #44.** Reserve and deliver are unaffected by R1. Full write-up below. <br><br>*The 2026-08-06 deferral was over-cautious.* It reasoned that sales documents have no UI delete path, so running this would strand financial records on production. True of the **documents**; not true of the **inventory**, which is what the row actually tests. Every step reverses: `approve_sales_order` reserves ↔ `cancel_sales_order` releases, `post_invoice` delivers ↔ `void_invoice` restores. And archiving rather than deleting a sales document is this system's stated rule, not residue — the same disposal the funnel run used for its own throwaway documents in August. |
| ✅ | Old deep link `/inventory?tab=received` | Falls back to Overview (no blank page). — **verified 2026-08-05**. Minor cosmetic snag: the breadcrumb still reads "Inventory › Received" for a tab that no longer exists. |

---

**Note:** Commit 4 (removal of the 5 old RMA-stage tabs + `ProductStatusTab.jsx`) is already committed on `test`. The dashboard + RMA drawer replace them.

---

## Reserve/deliver run — 2026-08-16

Ran against **QA Throwaway Co** (`CB-36415389`) and **QA Serialized Widget** (`QA-PO-SER`,
5 units, all `available`/`company_stock` in one warehouse). No live customer, product or stock
was touched at any point.

| Step | Expected | Actual |
|---|---|---|
| Create SO for 2x the serialized product | draft, nothing reserved | `SO-89405717` draft, all 5 units still `available` ✅ |
| Approve it in the Activities pool | 2 units reserved | status `delivered`, `QA-SER-001`/`002` → **reserved**, other 3 untouched ✅ |
| Create invoice from the SO, approve it | those 2 delivered | `INV-2026-00021` posted with a gapless code, both units → **delivered** ✅ |
| Void the invoice | the 2 restored | `cancelled`/`reversed`, both units → **available**/`company_stock` ✅ |

**Reserve and deliver work, and R1 did not affect them.** That closes the row as written.

Final state: both invoices cancelled and archived, the SO archived, all 5 units back to
`available`/`company_stock` in the original warehouse — byte-identical to the baseline.

### BUG #44 — an invoice can be posted that bills stock it never delivers

The void in step 4 restores the units to `available` **and clears their
`reserved_by_doc_id`**, while the SO stays `status='delivered'` and keeps offering
**Create Invoice**. So I raised a second invoice off the same order and approved it:

> `INV-2026-00022` — **posted**, gapless code assigned, customer billed 200 EGP,
> **zero units delivered.** All 5 still `available`. No error, no warning, no toast.

`deliver_units` selects on `reserved_by_doc_id = <so>`; after the void nothing matches, and a
`FOR..LOOP` over zero rows is indistinguishable from success. AR goes up, inventory does not come
down, and nothing anywhere reports the divergence. That is a money-versus-stock inconsistency
created by a normal sequence of UI actions — void an invoice, re-invoice the order.

**Fixed by migration `20260775_post_invoice_requires_reservations.sql` — applied by the user and
verified 2026-08-16.** It makes `post_invoice` refuse when the serialized quantity billed exceeds the
units actually reserved on the linked SO, naming both numbers. A precondition rather than a change
to void semantics, so it also catches a manually-linked invoice or a reservation released some
other way. Only serialized lines count — bulk decrements `warehouse_stock` on a different path and
service lines hold no stock, so counting either would make every mixed invoice unpostable.

**Verification, 2026-08-16.** Run against `SO-89405717` — the delivered order that produced the
bug, still holding 2 serialized units billed and 0 reserved after its two invoices were voided.
A third invoice was raised from it and posting attempted at three reservation levels:

| Reserved | Result |
|---|---|
| 0 of 2 | **Refused.** `P0001` — *"it bills 2 serialized unit(s) but only 0 are reserved … Posting would charge the customer for stock the system never hands over."* Invoice stayed `draft`, **no gapless code burned**. |
| 1 of 2 | **Refused**, and the message now reads **1**, not 0 — the count is read live, so this is a real comparison and not a blanket refusal. |
| 2 of 2 | **Posted.** `INV-2026-00023`, and `QA-SER-001`/`002` moved available → **delivered**. The guard does not over-fire on the legitimate path. |

That third row is the one that mattered: a precondition that refused everything would have been
worse than the bug it replaced.

Cleaned up — `INV-2026-00023` voided (`204`), and all five units of QA Serialized Widget are back
to `available`. The voided invoice remains on QA Throwaway Co, as sales documents are never
deleted.

### Two smaller things seen during the run, neither fixed

- **A delivered SO whose invoice was voided is a dead end.** It still shows *Create Invoice*, but
  there is no UI path to re-reserve its stock, so the order can never be legitimately fulfilled.
  The migration's error message says so plainly rather than suggesting a recovery that does not
  exist. The real fix is a product decision: either the void returns units to `reserved` against
  the still-live SO, or the SO moves to a state that stops offering re-invoicing.
- ~~**Cancel does nothing on that SO.**~~ **WRONG — corrected 2026-08-16.** I reported this as a
  silent no-op in the same shape as BUG #14. It is not. `handleCancelSO` opens a native
  `window.confirm`, which the browser automation auto-dismisses, so the handler returned early
  exactly as it should have. `cancel_sales_order` is correct and would have run. The bug was in my
  test, not the code.

  It did surface a real one, though: **10 native `window.confirm` calls across 7 files** in an app
  that has its own `ConfirmDialog`. Native confirms ignore the theme, block the main thread, and
  take their OK/Cancel labels from the browser locale — English buttons in an otherwise
  right-to-left Arabic UI. Tracked as BUG #45.

---

## Part 2 — Other pending QA from earlier sprints

These "BUILT ≠ VERIFIED" items are still open from earlier work — listed here so all outstanding manual testing is in one place.

| Status | Area | What still needs a manual click-through | Reference |
|--------|------|------------------------------------------|-----------|
| ✅ | Purchase Module redesign (2026-07-05) | **RUN AND CLOSED 2026-08-07** — this row's "DEFERRED 2026-08-06" note was overtaken the next day. See **"Purchase Module (Sprint 9R) — manual QA click-through (2026-08-07)"** at the end of this file: the full PO → approval → Vendor Invoice → partial receipt → full receipt → inventory + audit → AP payment → aging → void chain was click-tested end to end, and the verdict records *"Nothing in the Purchase Module is left unverified."* Four defects found and fixed (**#17** functional, **#18**/**#19** copy, **#20** the bulk-tracking gap with its `20260772` database guard applied and verified against a deliberate bypass). One unfixed cosmetic observation: the PO Currency placeholder says `USD` while the effective default is `EGP`. | migrations `20260756`–`20260763`; CLAUDE.md Purchase Module section |
| ✅ | Sprint 8 Inventory UI | **Superseded by the R1 rows — all six surfaces were click-tested during this pass, against the same code.** <br>• **Dashboard** → §6 (all 8 columns, scrap excluded from Available/Physical, Branches drawer showing Main 21 / Branch – Cairo 27) and §7 (non-catalog badge) <br>• **Stock Breakdown** → §8 (Product Info, Warehouse Distribution, Available Units, Reserved, RMA Distribution populated) <br>• **Receive** → §9, 2026-08-06 (unit received into Main, counts moved 433→434) <br>• **Transfer** → §9 (27-unit Main → Branch – Cairo, plus the system-location regression found and fixed) <br>• **Adjust** → §9, 2026-08-06 (status change off stock and back, plus the one-way-door bug found and fixed) <br>• **Warehouses** → §1 (grouping, system-row protection, metadata edit) and §9 (CRUD) <br><br>Four defects were found and fixed across those surfaces, so this is stronger coverage than the original row asked for. Nothing here is untested. | CLAUDE.md active-sprint note |
| ✅ | Sales-funnel 52-item checklist | **ALL 52 ROWS RUN, ALL 52 PASS — closed 2026-08-06/07.** The "Still unrun" wording below was written while the checklist was being located and was never updated once it ran; the run log lives in this file under **"Sales-Funnel 52-Item Checklist — run log (2026-08-06)"**, ending in "Funnel checklist — final state". Five defects found and fixed (**#12** via migration `20260771`, **#13**, **#14**, **#15**, **#16**), each confirmed live after the fix and #16 in both locales. Row 46 passed against the code while its written expectation was stale; `MASTER_UPGRADE_PLAN.md` row 46 was reworded 2026-08-07 with a note explaining why the behaviour must not be changed back. <br><br>*Original locating note, kept for the record:* the 52 rows live in **`MASTER_UPGRADE_PLAN.md` → "Sales Funnel Test Checklist (Sprint 6 round-2 fixes + Sprint 7 Accounting v1)"** (#1 Activities search → #52 build gate), covering Activities, Leads, Deals, Quotations, Sales Orders, Invoices, Credit Notes, Payments, Accounting and i18n. Prerequisite migrations `20260726`–`20260730` were already applied. | **`MASTER_UPGRADE_PLAN.md`, section "Sales Funnel Test Checklist"** (was wrongly cited as Claude memory `project-sales-funnel-test-checklist.md`, which never existed) |
| ✅ | Credit-limit enforcement policy | **DECIDED 2026-08-06: no credit-limit policy will be enforced at this time.** Not block, not warn, not advisory — the feature stays unenforced. Nothing to test, so this row is closed rather than deferred. **If a policy is adopted later**, re-open it with the chosen mode and test the enforcement point in the sales funnel (order/invoice creation against an over-limit customer). | CLAUDE.md Accounting section |

---

## Part 3 — CRM Leads/Pipeline round (2026-08-04/05)

Closes the 8 findings from `MyCRM Manual Test 05-07-2026.xlsx` plus 3 gaps found while working. No migrations — code only, so nothing to apply first.

### A. Leads

| Status | Check | Expected |
|--------|-------|----------|
| ✅ | Open a lead **that has a company name**, click Full Name in the Lead Info panel | An input appears (previously the field vanished). Enter saves, Escape cancels. — **verified 2026-08-05** on LD-79632812 (*Test Lead 211* / *Test Company 211*): clicking the value swapped the `span[title="Click to edit"]` for a text input pre-filled with "Test Lead 211"; **Escape** reverted it to the span with no change written. (Enter-saves not separately exercised — Escape was the safer half to test on live data.) |
| ✅ | Lead tabs | Four tabs: **All Leads / Active / Converted / Disqualified**, each with a count. — **verified 2026-08-05**: 31 / 20 / 6 / 5. |
| ✅ | Active tab contents | Excludes both converted **and** disqualified leads. — **verified 2026-08-05** arithmetically: 31 − 6 − 5 = 20 = the Active count. |
| ✅ | Kanban button | Visible **only** on the All Leads tab. — **verified 2026-08-05**: present on All Leads, absent on Active / Converted / Disqualified. |
| ✅ | Open `/leads?status=converted&view=kanban` | Falls back to the list view, not an empty board. — **verified 2026-08-05**: Converted tab, list view, 6 leads. |
| ✅ | Switch to All Leads → Kanban → other tab → back to All | The Kanban choice is remembered. — **verified 2026-08-05** (All → Kanban → Converted → All = still Kanban; column counts sum to 31). |
| ✅ | Disqualify a lead | Leaves Active, appears under Disqualified. — **verified 2026-08-05** on LD-79632812: Active **20 → 19**, Disqualified **5 → 6**, All Leads unchanged at 31 (31 − 6 − 6 = 19 ✓). History logged "Status changed from Qualified to Disqualified" and the *Disqualify* action disappeared from the header. |
| ✅ | Disqualified lead → row menu → **Reopen Lead** | Returns to `new` and back into Active. — **verified 2026-08-05**: the row menu offers *View / Edit / Convert to Deal / **Reopen Lead***. Reopening moved Active **19 → 20**, Disqualified **6 → 5**, and the lead's status came back as **New** — not its previous *Qualified*, which matches the row's wording. Original state restored. |

> **Minor copy bug found here:** the Disqualify confirmation dialog reads *"Disqualify Test Lead 211?
> This lead will be marked as not actionable."* but its confirm button is labelled **"Delete"**.
> Disqualifying is reversible (the very next row reopens it); deleting is not. The label should
> read *Disqualify*, otherwise it discourages a safe action by making it look destructive.

### B. Deal edit dialog

| Status | Check | Expected |
|--------|-------|----------|
| ✅ | Open any **open** deal | "Edit Deal" button top-right, next to Back. — **verified 2026-08-05** on OPP-96369062; dialog opens with Title / Customer / Pipeline / Value (disabled, "Calculated from product lines") / Close Date / Probability / Rep / Notes. |
| ✅ | Open a **won/lost** deal | Button absent; "Reopen Deal" shown instead. — **verified 2026-08-05** on OPP-16218686 (Won): no Edit Deal, "Reopen Deal" present, banner "This deal is closed (read-only)". |
| ✅ | ~~Edit Deal → change **Customer** → Contact dropdown repopulates~~ → **Changing the customer swaps the deal to the new customer** | Reworded 2026-08-06 — split from the contact half, which no data can exercise. **Verified 2026-08-05**: on OPP-96369062 the customer search matched and selected **Maximum Hardware**, replacing *Test Company 3* in the form. Cancelled without saving; the deal still reads *Test Company 3*. |
| ✅ | **Contact dropdown behaviour** (repopulates on customer change, clears the old contact, hidden when the customer has none) | **VERIFIED 2026-08-06**, once a contact was added to *QA Throwaway Co* (`CB-36415389`, Contacts (1)). Tested on that customer's deal `OPP-97835765`; cancelled without saving, deal still reads *QA Throwaway Co*. <br>• **Renders when the customer has contacts** — Edit Deal showed a **Contact Person** select offering *No contact* / *Ahmed Saeed · PM*. <br>• **Selectable** — choosing *Ahmed Saeed · PM* held correctly. <br>• **Clears + hides on customer change** — clearing the customer removed the field immediately; selecting **Maximum Hardware** (Contacts (0)) left only *Pipeline* and *Assign Rep*, with the previously-chosen contact gone. <br><br>Confirms the design intent in `_modals.jsx:179` — the field renders only when `contacts.length > 0`, and the query is keyed on the **form's** customer, not the deal's saved one, so it tracks edits live. **Feature confirmed in use** — multiple contacts per customer is a real requirement, so it stays. |

> **⚠️ Possible RLS inconsistency spotted while checking (needs confirmation before it matters).**
> Querying with the **anon key only** (no user session): `public.contacts` returned **HTTP 200**
> with `count=0`, while `public.customers` returned **HTTP 401**. The differing status codes suggest
> the anon role has a SELECT grant on `contacts` that it does not have on `customers`.
>
> With the table empty this exposes nothing today, and 200+0 is also consistent with RLS simply
> filtering every row. **But if contact records are ever added, verify the policy first** — customer
> contact names, phones and emails should not be readable with the publishable anon key alone.
| ✅ | Customer with no contacts | Contact field is hidden entirely (not an empty dropdown). — **verified 2026-08-05** on OPP-96369062 (Test Company 3): no Contact field rendered at all. Pair with the row above to confirm it *appears* for a customer that has contacts. |
| ✅ | Save changes | Persist correctly; the **deal log** shows entries naming the customer/contact, not UUIDs. — **verified 2026-08-05**: saved probability 0→40 and close date →2026-09-30; both persisted and the log recorded them as **"Updated Probability: 40"** / **"Updated Expected Close Date: 2026-09-30"** — plain values, no UUIDs. All changes reverted afterwards. *The customer/contact naming specifically was not exercised* — the customer could not be changed (see the row above). |
| ✅ | Change **Pipeline** | A Stage picker appears with an amber hint; defaults to the destination's first open stage. — **verified 2026-08-05** on OPP-96369062: switching *B2B Dealer Pipeline* → *B2C Retail Pipeline* inserted a **Stage\*** select offering the destination's stages (New Inquiry / Contacted / Quote Sent), defaulted to **New Inquiry** (its first open stage), under the hint *"Changing pipeline moves this deal to a new stage — pick the stage it should land on."* styled `text-amber-600` (computed `rgb(217,119,6)`). |
| ✅ | Save the pipeline change | Deal lands in the new pipeline at that stage; deal log records the move. — **verified 2026-08-05**: moved OPP-96369062 B2B → **B2C Retail Pipeline**; it landed on **new_inquiry** (the destination's first open stage, as the picker defaulted) and the log recorded *"Stage changed from Quote Sent to New Inquiry"*. Moving it back logged *"Stage changed from New Inquiry to Quote Sent"*. Deal fully restored to B2B / Quote Sent. |
| ✅ | Change pipeline, then change it **back** before saving | The deal's original stage is restored. — **verified 2026-08-05**: switching back to *B2B Dealer Pipeline* removed the Stage picker **and** the amber hint entirely, leaving the deal on its own stage (*Quote Sent*) with no pending override. Dialog stayed open; closing without saving left the deal untouched. |
| ✅ | Deal log generally | Field edits appear (title, value, close date, probability, rep) — not only stage changes. — **verified 2026-08-05**: close-date and probability edits both logged as their own entries alongside the stage moves. The stale-refresh problem seen while testing this has since been **fixed and re-verified** — see below. |

> **🐞 SEVENTH BUG — the Deal Log showed a stale feed until the page was reloaded. FIXED + VERIFIED 2026-08-05.**
> Hit three times during this run: a quotation submitted for approval (§C), and deal field edits
> (§B, twice). Each time the entry was genuinely written but invisible until a manual reload —
> which briefly looked like the activity had never been created at all.
>
> **Cause:** activity-log writes are fire-and-forget by design (a failed log must never fail the
> user's save), but `refresh()` invalidated the `['activities','deal',id]` query *immediately*
> afterwards. The refetch raced the INSERTs and usually won, so it returned the pre-write rows —
> and nothing invalidated again once the writes landed.
>
> **Fix** (`DealDetail.jsx`): a `logEvent()` helper records every in-flight log promise in a ref,
> and `refresh()` now `await`s `Promise.allSettled(...)` on them before invalidating. All **7**
> fire-and-forget `logSystem` call sites were converted, so the fix covers the quotation
> create/reopen/convert/approve paths too, not just the two rows that exposed it. Failures are
> still swallowed — awaiting a settled rejection is enough to know the refetch will see whatever
> did land.
>
> **Verified live:** saved a probability change and the entry *"Updated Probability: 15"* appeared
> at the top of the Deal Log **with no reload**. Test value reverted afterwards.
> Gates: 392 tests, lint clean, build ✓.

> **🐞 SIXTH BUG — the Pipeline page could only ever show ONE pipeline. FIXED + VERIFIED 2026-08-05.**
>
> **Far worse than first written up.** The original note below described this as "a moved deal
> becomes unreachable". Adding the switcher revealed the real scope: the **B2C Retail Pipeline held
> 50 deals worth 2,766,838.10 EGP** — real records with real customers (*AlMadina - AlBostan*,
> *Genina City - Sharm El Sheikh*, *Hi Techno - Kafr El Sheikh*…) and assigned reps — **none of
> which had ever been visible in the application**. Not a stray test deal: an entire book of
> business, invisible on every view, absent from every pipeline total and export.
>
> **Fix** (`Pipeline/index.jsx`): the hardcoded `pipelines[0]` is replaced with a URL-backed
> selection (`useURLTab('pipeline', '')`, matching how `view` already works), falling back to the
> first pipeline when the param is missing or names a pipeline that no longer exists — so a stale
> bookmark degrades to a working board rather than an empty one. A `<select>` renders in the page
> header whenever more than one pipeline exists, with `pipeline.selectPipeline` added to `en.json`
> and `ar.json`.
>
> **Verified live:** the switcher lists both pipelines; selecting *B2C Retail Pipeline* loads
> **50 deals / 2,766,838.10 EGP**, writes `?pipeline=<id>` to the URL, and the choice survives a
> reload. Gates: 392 tests, lint clean, build ✓.
>
> ---
> *Original write-up, kept for the record:*
> Found 2026-08-05 while running the row above. `src/pages/Pipeline/index.jsx:276` hardcodes
> **`const pipelineId = pipelines[0]?.id ?? null`** — the Pipeline page always loads the *first*
> pipeline and offers **no pipeline switcher** in List, Kanban, Graph, Pivot or the Filters panel
> (Filters exposes only All Stages / All Reps).
>
> Yet the Edit Deal dialog happily moves a deal to another pipeline. After moving OPP-96369062 to
> *B2C Retail Pipeline* it vanished from the deals list (5 → 4), its own pipeline search returned
> "0 of 4 deals", and there was **no route back to it from the Pipeline module at all**. It was only
> recoverable via **Customers → Test Company 3 → Deals tab**, whose row click navigates to
> `/pipeline/:id`.
>
> So the app offers an action that effectively orphans the record for anyone who does not know that
> back door. Either add a pipeline selector, or block moves into a pipeline the UI cannot display.
>
> **Also spotted:** the Edit Deal **Assign Rep** select showed *"Unassigned"* while the deal was
> assigned to `nour.ali@test.com`. `salesReps` filters users to `sales_rep|manager|admin|super_admin`
> (`DealDetail.jsx:130`), and that user is not in the set, so the select has a value with no matching
> option and falls back to the first. The value itself survives a save (verified — the rep was still
> `nour.ali@test.com` afterwards), but the display is misleading and the current assignee cannot be
> re-selected once changed. Consider always including the current assignee as an option.

### C. Multiple quotations per deal

| Status | Check | Expected |
|--------|-------|----------|
| ✅ | Create **two** quotations on one deal (e.g. 10 and 15) | Both listed as separate cards; creating the second does not replace the first. — **verified 2026-08-05** on existing data: OPP-16218686 carries three independent cards (QT-75402660 Draft 700, QT-17104557 → SO 500, QT-44493508 → SO 16,000). |
| ✅ | Deal value | Equals the **sum** (25). — **verified 2026-08-05** twice over: OPP-16218686 open = 17,200 (700 + 500 + 16,000), and OPP-96369062 moved "—" → **500** the moment its only quotation was restored from Archive. |
| ✅ | Tab badge | Shows the QT code with one quotation, the **count** with several. — **verified 2026-08-05**: OPP-96369062 (1 QT) shows `QT-93682892`; OPP-16218686 (3 QTs) shows `3`. |
| ✅ | Send one for approval → approve from Activities | **Only that** quotation changes status; the other is untouched. — **verified 2026-08-05** on OPP-96369062 with three quotations (QT-23780393 draft 300, QT-17864855 draft 250, QT-93682892 approved+archived 500). Sent **only** QT-17864855 for approval → it alone went `Pending Approval`; approved it from the Deal Log → it alone became `Approved`. QT-23780393 stayed **Draft with Edit intact**, and QT-93682892 kept both its status *and* its Archived flag. The two stale QT-93682892 approval requests also stayed in PLANNED. |
| ✅ | Approve a quotation | Its **Edit** button disappears (locked once approved). — **verified 2026-08-05**: approved QT-93682892 from the Deal Log; badge went *Pending Approval* → **Approved**, the **Edit button vanished**, and *Download PDF* + *Convert to Sales Order* appeared. Neatly confirms the row below it too — PDF appears at `accepted` and disappears again at `converted`, when you export the SO instead. |
| ✅ | Same check on `/sales/quotation/:id` | Edit also hidden there once approved. — **verified 2026-08-05**: the detail page shows **Approved / Archived** with only a *Restore* action and **no Edit**. Lock holds on both surfaces. |
| ✅ | Convert one to a Sales Order | It locks with a "View SO" link; **no Download PDF button** at that stage. — **verified 2026-08-05**: both converted QTs show "Converted to SO" + "→ View Sales Order: SO-36594637 / SO-78334548"; DOM check found 0 Edit and 0 PDF buttons on the card. |
| ✅ | The other quotation | Still fully editable and independently convertible. — **verified 2026-08-05**: with one sibling approved and another approved+archived, QT-23780393 kept **Edit**, **Send for Approval** and **Archive**, while both siblings showed only *Download PDF* / *Convert to Sales Order*. Deal value stayed **550** (250 + 300 live, archived 500 excluded) — approval changes lock state, not forecast. |

> **Minor, not a row failure:** *Send for Approval* updates the quotation card immediately, but the
> **Deal Log tab does not pick up the new approval activity until the page is reloaded** — it kept
> showing only the older requests. Briefly looked like the activity had not been created at all;
> a reload showed it present, with the matching "submitted for approval" history entry. Worth a
> `queryClient.invalidateQueries` on the activities key when a quotation is submitted.
| ✅ | **Archive** a quotation | "Archived" badge appears; it shows under `/sales` → Archive tab. — **verified 2026-08-05** on QT-93682892: badge appears, button flips to Restore, and the deal value drops out of the forecast. (`/sales` Archive tab listing not separately re-checked.) |
| ✅ | **Restore** it | Returns to the active list. — **verified 2026-08-05**: badge cleared, button flipped to Archive, deal value "—" → **500 EGP**. |
| ✅ | Save/approve/archive anything | The quotation list refreshes immediately (no stale screen). — **verified 2026-08-05**: both archive and restore re-rendered the card, badge and button without a manual reload. |

> **🐞 FIFTH BUG — archiving a quotation from `/sales` leaves the deal's stored value stale.**
> Found 2026-08-05 while running the rows above. QT-93682892 was already archived, yet the
> Pipeline **list** showed its deal at **500 EGP** while the deal **detail** showed **"—"**.
>
> The two disagree because they read different things: `DealDetail` computes
> `dealValueFor(quotations, status)` live, whereas the Pipeline list, the pipeline header total
> and everything else read the stored `deals.value` column.
>
> Only the deal-side archive keeps that column in step — `DealDetail.jsx:401-404` follows
> `setArchived` with `syncDealValue`. **Neither Sales Documents path does**:
> `SalesDocumentDetail.jsx:365` and the bulk action at `SalesDocuments/index.jsx:341` both call
> `db.salesDocuments.setArchived` and then only `refresh()` / `invalidateQueries`. The db layer
> (`salesDocuments.ts:65`) just flips the flag.
>
> Proven by contrast: archiving the same quotation **from the deal** moved the Pipeline list to
> "—" and dropped the header total 27,296.9 → **26,796.9**. Archiving from `/sales` would have
> left both unchanged.
>
> **Impact: pipeline forecast totals are overstated** whenever a quotation is archived from the
> Sales Documents page — a number sales leadership reads directly off the pipeline header.

### D. Deal value — forecast vs actual

Set up one deal with three quotations: **10 (converted)**, **15 (pending)**, **20 (pending)**.

| Status | Check | Expected |
|--------|-------|----------|
| ✅ | Deal open | Value = **45** (all live quotations). — **verified 2026-08-05** on OPP-96369062: **550** = 300 (draft) + 250 (approved), with the archived 500 correctly excluded. |
| ✅ | Decline or cancel the 20 | Value drops to **25** (dead quotations don't count). — **verified 2026-08-05**: rejecting the live 300 from the Deal Log dropped the deal **550 → 250** and logged *"Quotation QT-23780393 declined"*. |
| ✅ | Reopen that quotation for approval | Value returns to **45**. — **verified 2026-08-05**: *Reopen for Approval* on the declined 300 restored **250 → 550**, quotation back to *Pending Approval*. |
| ✅ | Archive the 15 | Value drops to **30**. — **verified 2026-08-05**: archiving the 300 dropped **550 → 250** (card showed *Draft / Archived*); restoring it returned **250 → 550**. |

> **Note on a mis-click during this section (no lasting effect).** While rejecting the 300, a
> button-to-card selector walked too far up the DOM and matched a container holding *all* the
> quotation cards, so the Reject landed on **QT-93682892** instead — flipping it from *Approved* to
> *Rejected*. **No value impact** (that quotation is archived, so excluded from the deal value
> either way, which stayed 550), and it was **fully restored** to *Approved + Archived* via
> *Reopen for Approval* → *Approve*. The rows above were then re-run with a corrected selector that
> only accepts an ancestor containing exactly one QT code.
| ✅ | Mark the deal **won** | Value drops to **10** (converted only). — **transition verified live 2026-08-05** on OPP-16218686 (3 quotations: 700 draft, 500 + 16,000 converted). Marking won moved the value **17,200 → 16,500**, i.e. forecast → actual, dropping the 700 draft. Deal became read-only with "Reopen Deal" replacing "Edit Deal". |
| ✅ | **Reopen** the deal | Value climbs back to **45**. — **verified live 2026-08-05** on OPP-16218686: reopening to the *Negotiation* stage moved the value **16,500 → 17,200**, i.e. actual → forecast, re-including the 700 draft. "Edit Deal" returned and **Mark Won** was enabled (two quotations converted). Marking won again restored 16,500 — the round trip is symmetric and the deal is back in its original state. |
| ✅ | Deal where nothing has converted → Mark Won | Button is **greyed out** with a tooltip explaining why. — **verified 2026-08-05** on OPP-96369062: `disabled=true`, `cursor-not-allowed`, tooltip "Convert at least one quotation to a Sales Order before marking this deal won." |
| ✅ | Deal with **no quotations** and a hand-typed value → mark won | The typed value is **preserved**, not zeroed. — **verified 2026-08-05**: created OPP-46593354 (*QA no-quotation value check*, Maximum Hardware) with a hand-typed **1,234 EGP** and no quotations. **Mark Won was enabled** (correct — `canMarkDealWon` permits quotation-less deals) and after winning the value still read **1,234 EGP**. Confirms `syncDealValue`'s empty-list guard: a deal with no quotations must never have its typed value overwritten by a computed 0. |

### E. Regression

| Status | Check | Expected |
|--------|-------|----------|
| ✅ | Create a **new** deal (not edit) | Unchanged: customer searchable, Stage picker present, no Contact field. — **verified 2026-08-05** creating OPP-46593354: customer search worked (typing *"Maximum Hardware"* matched and selected it), **Stage\*** picker present with the pipeline's 5 stages defaulting to *New Deals*, **no Contact field** rendered even for a customer that has one — the Contact field is an edit-dialog feature only. Deal Value stayed editable, correct for a deal with no quotations. |
| ✅ | Lead → Convert to deal | Still works end to end. — **verified 2026-08-05 on a purpose-made throwaway lead** (not an existing record, since conversion has no revert path). Created **LD-82701445** *QA Convert Throwaway / QA Throwaway Co* (All Leads 31→32, Active 20→21), then converted it with a deal value of 777. All three sides landed atomically: <br>• **Lead** → *Converted*, banner *"This lead is converted and locked (read-only)"*, history *"Lead converted to a deal"*<br>• **Deal** → **OPP-97835765** *QA Convert Throwaway — Deal Title*, customer *QA Throwaway Co*, stage *New Deals*, **777 EGP** (deals 6→7)<br>• **Customer** → **CB-36415389** *QA Throwaway Co*, type B2B, phone and email carried across from the lead<br><br>**Cleanup:** these three records are test data and can be removed together. |
| ✅ | Arabic + dark mode | All new UI (tabs, Edit Deal dialog, quotation cards, badges) reads correctly in both. — **verified 2026-08-05** with Arabic **and** dark mode on simultaneously (Account Settings → Appearance → العربية). `dir="rtl"`, `lang="ar"` applied; layout mirrors correctly. **Leads**: all four tabs translated with counts (كل العملاء المحتملين 32 / العملاء النشطون 20 / المحولون 7 / المستبعدون 5), table headers, status badges (جديد / غير نشط), search and filters. **Deal detail**: تعديل الصفقة, معلومات الصفقة, العميل, مسار المبيعات, الاحتمالية, المندوب المسؤول, تحديد كخاسرة / كرابحة, currency as **م.ج**. Contrast readable throughout in dark. Settings reverted to English/LTR/light afterwards. **Two gaps found — see below.** |

> **🐞 NINTH + TENTH — two i18n gaps found while running this row. BOTH FIXED + VERIFIED 2026-08-05.**
>
> **9. The top app-bar title stayed English** while the page body was translated — the bar read
> *"Deal Details"* / *"Leads"* over fully Arabic content. `App.jsx` built `mobileTitle` from a
> hardcoded English map. Now routed through `t()`, reusing the existing `nav.*` keys so the header
> and the sidebar entry for a page can never disagree; seven new keys
> (`productDetails`, `customerDetails`, `leadDetails`, `dealDetails`, `salesDocuments`,
> `salesDocument`, `accountSettings`) added to `en.json` and `ar.json`.
> **Verified:** header now reads **العملاء المحتملون** and **تفاصيل الصفقة**.
>
> **10. Phone numbers rendered backwards in RTL** — `+966520968114` displayed as `966520968114+`,
> which reads as a different number. The Unicode bidi algorithm moves a leading `+` to the visual
> other end unless the value is isolated. Fixed with a new **`<Ltr>`** primitive in
> `components/ui.jsx` (`dir="ltr"` + `unicode-bidi: isolate`), applied to the Leads list contact
> column, the Lead Details phone field, and the Customer Details contacts table.
> **Verified:** phones now render **+966520968114** with the plus correctly on the left.
>
> Language and theme were returned to English / LTR / light afterwards.
>
> Stage chips (*New Deals*, *Quote Sent*…) also stay English, but those are user-configured
> pipeline data rather than UI strings, so that is arguably correct — left alone.
>
> **`<Ltr>` is worth reusing** anywhere else latin-script data appears in RTL: emails, SKUs,
> serials, document codes (`QT-…`, `OPP-…`), and IBANs. Only the three phone sites above were
> changed here.

---

## Sales-Funnel 52-Item Checklist — run log (2026-08-06)

Source: `MASTER_UPGRADE_PLAN.md` → "Sales Funnel Test Checklist (Sprint 6 round-2 fixes +
Sprint 7 Accounting v1)". Row numbers below are that table's.

### Passed (8)

| # | Area | Result |
|---|------|--------|
| 1 | Activities | Search by code works — `QT-93682892` returned exactly its approval activity. Placeholder documents the supported prefixes (LD-/OPP-/QT-/SO-/INV-/CN-). |
| 2 | Activities | Table carries a **Created** column alongside Due Date. |
| 41 | Build | 392/392 tests, 0 lint errors, build ✓ (row says 277 — historical). |
| 42 | Accounting | Sidebar item present, routes to `/accounting`, tabs Payments / AR Aging / Vendor Payments / AP Aging. |
| 47 | AR Aging | Buckets exactly **Current / 31-60 / 61-90 / 90+ / Total**; 8 customers bucketed correctly (Compu Line → 61-90, Smart Technology → 90+). |
| 49 | Billing | Credit limit set to 1,000 on *Compu Line* and persisted across reload. Reverted afterwards. |
| 50 | Billing | With the limit below the 43,726.22 balance, Billing shows a **red panel + "Over credit limit"** — display-only, no enforcement, matching the policy decision. |
| 52 | Build | Same gate as #41. |

### Partly checked (1)

| # | Area | Result |
|---|------|--------|
| 48 | Billing | Ledger renders **Date / Type / Code / Amount / Balance** with a running balance, verified on *Compu Line* (1 invoice). **Not fully closed** — the row wants a customer holding an invoice **and** a credit note **and** a payment; no such customer was found. |

### Blocked — creates accounting records with no delete path (≈30 rows)

Rows **13-24** (SO create/approve/cancel/invoice/post/void), **25-33** (Credit Notes),
**34-39** (RMA → CN, which also force-closes tickets), **43-46** (Payments), plus **5/10**
(lead conversion, already known to leave three undeletable records).

Running these means creating posted invoices, issued credit notes and payment rows against
**live customers**, all of which alter AR balances and the aging report, and none of which the
UI can remove. Deferred pending an explicit decision or a disposable database.

### Second pass — safe rows (2026-08-06): 10 passed, 1 partial

| # | Area | Result |
|---|------|--------|
| 6 | Leads | Converted tab is read-only — row checkbox `disabled`, Status and Source render as plain text (on Active they are dropdown buttons). |
| 7 | Deal | Schedule Activity with an empty due date is **blocked at the control** — date input `required`, Schedule button `disabled`. |
| 9 | Deal | Create Deal dialog pre-generates **`OPP-32568060`** — prefix confirmed without saving anything. |
| 11 | Deal | All 6 deals carry `OPP-` codes, **zero legacy `QT-`** remain, including deals created 3/5/2026 (pre-migration). |
| 15 | Sales Order | No "Confirm Order" / "Mark Delivered" button on a delivered SO. |
| 18 | Sales Order | Delivered SO offers **Download PDF**. |
| 23 | Invoice | Posted invoice shows **no "Create Credit Note"** and no "Post Invoice" — only *Record Payment* / *Void Invoice*. (Also covers half of #20.) |
| 25 | Credit Note | `+ New` menu includes **New Credit Note**. |
| 26 | Credit Note | Empty CN modal → **Create Credit Note is `disabled`**. |
| 31 | Credit Note | "Link to an open invoice" checkbox `disabled` before a customer is chosen. |

> **Row 32 — CORRECTION (2026-08-06). My earlier finding here was wrong; there is no bug.**
> I first reported that the sales Credit Note modal has no "no open invoices" message and that the
> link checkbox is permanently greyed. Both claims were mistaken:
> - The message **does exist** — `salesDocuments.cnNoOpenInvoices`, *"This customer has no open
>   invoices with a remaining balance."* (`en.json:3158`). It renders inside the `{linkInvoice && …}`
>   block (`_modals.jsx:625`), i.e. **only after the checkbox is ticked** — which I never reached.
> - The checkbox is `disabled={!customerId}` (`_modals.jsx:613`). It stayed disabled in my earlier
>   attempts because my scripted click set the input's *text* without setting React state, so no
>   customer was actually selected. Clicking the dropdown entry properly enables it immediately.
>
> **Verified working 2026-08-06**: with *QA Throwaway Co* genuinely selected, ticking the box
> revealed the invoice picker listing **`INV-2026-00017 — 60.00 remaining`**. The
> `purchasing.noOpenInvoices` string I cited is the vendor-side equivalent, not evidence of a gap.
> Row 31 (disabled until a customer is chosen) stands as ✅.

### Third pass — the document-creating rows (2026-08-06), authorised by the user

> "go ahead and run the remaining rows and create any records that needed for your tests"

The previously-blocked block was unblocked by running everything against a throwaway B2B
customer, **QA Throwaway Co** (`CB-36415389`), instead of live accounts. Every document below
belongs to that customer; no live customer's AR balance was touched.

#### Credit notes — rows 27-33

| # | Result |
|---|--------|
| 27 | Standalone CN, no invoice link → issued as **`CN-2026-00003`**, status **`issued`**. |
| 28 | CN linked to `INV-2026-00017` → on issue the invoice's `amount_paid` moved 40 → 60 by itself (`CN-2026-00001`, 20.00). Linked CNs land on status **`applied`**, not `issued`. |
| 29 | That 20.00 CN was less than the 60.00 remaining → invoice stayed **`partial`**, remaining 60 → 40. |
| 30 | `CN-2026-00002` (40.00) covered the rest → invoice went **`paid`**, remaining 0, amount_paid 100/100. |
| 31 | Re-confirmed: link checkbox is `disabled` with no customer chosen. |
| 32 | Re-confirmed live, this time with a customer who genuinely has **no** open invoices (all of QA Throwaway's were settled by rows 29-30): ticking the box renders *"This customer has no open invoices with a remaining balance."* — no empty dropdown. Closes the correction noted above. |
| 33 | `CN-2026-00003` voided via **Void → Confirm Void** (reason optional) → status **`voided`**. Note: an **`applied`** CN offers no Void button, only Archive — voiding is available on `draft`/`issued`, which is exactly what the row asks for. |

#### RMA ticket → credit note — rows 34-39

| # | Result |
|---|--------|
| 34 | Created `RMA-06082026-0001` for a free-typed customer name (never picked from the dropdown, so `customer_id` is null) → **"Issue Credit Note" is absent**; the rest of the header (Export PDF) still renders. |
| 35 | `RMA-06082026-0002`, linked to QA Throwaway Co and Open → button **visible**. Gate is `ticket.customer_id && !TICKET_STATUS_RESOLVED.includes(status)` (`TicketDrawer.jsx:329`). |
| 36 | Filled the CN form from the ticket (customer pre-filled and locked, Type pre-set to **RMA Return**) → **`CN-2026-00004`** came out already **`issued`**, one step, no separate Issue click. |
| 37 | Ticket flipped to **Closed** in the same action. |
| 38 | ❌ on first run — see BUG #12 — then ✅ **after migration `20260771` was applied.** Re-ran the whole flow on a fresh ticket `RMA-06082026-0003`: the timeline now shows `Created for QA Throwaway Co · Medium priority · Open` (11:18 PM) and, after issuing, **`CN-2026-00005 issued — Row 38 verification - logged reason`** (11:20 PM) — the CN code **and** the reason, exactly as the row requires. Console is clean of `PGRST204`. |
| 39 | Re-opened the now-Closed ticket → **"Issue Credit Note" no longer shows** (the `TICKET_STATUS_RESOLVED` half of the same gate). |

#### Accounting — rows 43-48

| # | Result |
|---|--------|
| 43 | Recording a payment from a posted invoice creates the `payments` + `payment_applications` rows and moves the invoice's `amount_paid`/`payment_status`. This is the row that surfaced **BUG #11** (`p_allocations` sent as a JSON string, so every payment failed with *"cannot extract elements from a scalar"*); passing after that fix. |
| 46 | ✅ **Passes. The row's stated expectation was out of date — the code was right, the row was wrong; `MASTER_UPGRADE_PLAN.md` row 46 has since been reworded (2026-08-07) with a note explaining why the behaviour must not be "fixed" back.** The row originally expected *"void a payment that has at least one allocation → Blocked with an error."* Verified live on `PAY-2026-00011` (80.00, allocated 60 + 5): the void **succeeds**, reverses every application, and restores each invoice — `INV-2026-00019` Paid → **Unpaid**, `INV-2026-00020` Partial → **Unpaid**, the payment's `unapplied_amount` 15.00 → **80.00**, status **Voided**. <br><br>That is deliberate. Migration `20260754_payment_cn_reversal.sql` states it outright: *"void_payment / void_credit_note: reverse EVERY still-active application of a payment/CN, then mark it voided. This is what a 'Void' button now does even when the payment/CN has been applied — the exact fix the audit asked for."* The row predates that migration. What **is** still blocked is voiding an **invoice** that has payments applied (`void_invoice` → *"Reverse payments/credit notes before voiding"*) — a different operation. **Row 46 should be reworded** to the reverse-and-void expectation. **Done.** |
| 44 | With three open invoices for one customer, **Auto-allocate (oldest first)** spread an 80.00 payment as **60.00 → `INV-2026-00019` (due 7/5)**, **20.00 → `INV-2026-00020` (due 9/28)**, **0 → `INV-2026-00018` (no due date, sorted last)**. Each row is an editable number input — changed the second to 5.00 by hand and it held. |
| 45 | Submitted 80.00 against 65.00 of allocations. The modal previewed **Allocated: 65.00 · Unapplied: 15.00** before submit, and **`PAY-2026-00011`** persisted with `unapplied_amount` **15.00**. |
| 47 | Re-verified with real data. Buckets sum exactly: 31,835.93 + 1,823.91 + 42,438.31 + 58,811.84 = **134,909.99** = Total Outstanding. QA Throwaway Co's **105.00 in Current** is provably right (35.00 remaining on `INV-…20` due 9/28 + 70.00 on `INV-…18`, both not yet due). |
| 48 | **Now fully closed.** QA Throwaway Co's Billing tab lists all three document types in date order with a correct running balance: Payment −40 → −40, Invoice +100 → 60, CN −20 → 40, CN −40 → 0, CN −25 → **−25.00** outstanding (customer in credit). The **voided** `CN-2026-00003` is correctly excluded. |

#### Invoice approval — rows 20-22

| # | Result |
|---|--------|
| 20 | A newly created invoice shows **"Awaiting approval in Activities"** and no Post button. |
| 21 | Approving from the pool posted it and assigned **`INV-2026-00018`** (and 19, 20). |
| 22 | ❌ **FAILED first run — see BUG #14.** Fixed and re-verified: rejecting the approval now leaves the invoice **`cancelled`**. |

### Bugs found in this pass

#### BUG #12 — every RMA ticket activity write fails silently (funnel row 38)

`ACTIVITY TIMELINE` is empty on **every** ticket, new or old, and survives a full drawer
remount. The console shows the real reason:

```
PGRST204: Could not find the 'details' column of 'ticket_activity' in the schema cache
  {context: ticketActivity.log, actionType: ticket_created}
  {context: ticketActivity.log, actionType: credit_note_created}
```

`public.ticket_activity` has no `details` column, but every reader and writer expects one —
`TicketActivityRow.details`, `ticketActivity.log()` (`tickets.ts:139`), `TicketDrawer.logActivity`,
`TicketForm`, `ActivityTimeline`. Worse, `log()` swallows the error (`captureException` then
`return undefined`), so nothing surfaces in the UI. Nothing has ever been written to that table.

**Fix:** `supabase/migrations/20260771_ticket_activity_details.sql` — `add column if not exists
details text` plus a PostgREST schema reload. **Applied by the user 2026-08-06 and verified
live** — see row 38 above. Ticket activity logging works for the first time.

> **Correction 2026-08-09.** Above, this write-up says the error was "swallowed" and implies it was
> invisible. That is wrong on the facts: `captureException()` writes
> `console.error('[Sentry]', …)` in dev and reports to Sentry in production, so every failed insert
> *was* recorded in both places — that console line is precisely how this bug was found. The
> swallow itself is correct by design, keeping a broken audit write from blocking ticket creation.
> What actually hid the problem was the UI: an empty ACTIVITY TIMELINE reading "No activity
> recorded yet" looks like *nothing happened* rather than *logging is broken*. No change made to
> the logger.

#### BUG #13 — a standalone invoice could never be posted (dead end)

`+ New → New Invoice` created a draft that showed *"Awaiting approval in Activities"* — but no
approval activity was ever filed, and the detail page deliberately offers no Post button. The
invoice was stranded in draft with nothing left to click.

Only `handleConvertToInvoice` (the SO → Invoice path) called `createInvoiceApprovalActivity`;
the shared create form (`SalesDocumentForm.handleSave`) just called `db.crmInvoices.create` and
stopped.

**Fix:** `SalesDocumentForm.jsx` now raises the same approval activity when `docType ===
'invoice'`, so the invariant "a draft invoice always has a pending approval" holds on both paths.
**Verified:** a standalone invoice now appears in the pool and approves to
**`INV-2026-00018` / posted**.

#### BUG #14 — rejecting an invoice approval did nothing (funnel row 22)

Rejecting threw `P0001: Only posted invoices can be voided (current: draft)` and the invoice
stayed `draft`. `rejectDocument` sent every invoice to `crmInvoices.void_` → `void_invoice`,
whose job is to *undo a post* by restoring delivered units — so its posted-only guard is correct;
drafts simply had no path. (The approval row survived, so nothing was lost.)

**Fix:** new `crmInvoices.cancelDraft()` (sets `doc_status='cancelled'` + `void_reason`, guarded
by `.eq('doc_status','draft')`, no stock touched), and `Activities/index.jsx` now routes by the
invoice's actual state — draft → `cancelDraft`, posted → `void_`. **Verified:** the rejected
invoice now reads **Cancelled**.

#### BUG #16 — every approval-pool row claimed to be a quotation

`activityChatter.approvalRequest` was the fixed string *"Quotation Approval Request"*, rendered
for all six approval doc types across three call sites, so Sales Orders, Invoices, Credit Notes,
Purchase Orders and Vendor Invoices all announced themselves as quotations — in the Activities
table, the ActivityChatter approval card, and the compact timeline row. The doc type was always
available (it is the second segment of the encoded `approval|docType|…` title); nothing read it.

**Fix:** new `src/lib/approvalLabels.ts` holds one map of doc type → translated noun and an
`approvalRequestLabel(t, docType)` helper. The label string now interpolates —
`"{{docType}} Approval Request"` / `"طلب اعتماد {{docType}}"` — reusing the existing
`activities.source*` nouns rather than adding six duplicate translations per locale. All three
call sites go through the helper; an unrecognised doc type falls back to the quotation noun,
matching `parseApprovalTitle()`'s own default, so a malformed row still reads as a sentence
instead of leaking a raw key.

`Activities/index.jsx` also stopped keeping its own copies: `SOURCE_LABEL_KEY` now spreads the
shared map (adding only lead/deal, which are not doc types) and `DOC_SOURCES` derives from
`Object.keys(...)`. The Source column, the filter dropdown and the label can no longer drift
apart.

**Verified live, both locales:**

| Row | English | Arabic |
|-----|---------|--------|
| `SO-41707511` | Sales Order Approval Request | طلب اعتماد أمر بيع |
| `QT-23780393` | Quotation Approval Request | طلب اعتماد عرض سعر |
| a draft invoice | Invoice Approval Request | طلب اعتماد فاتورة |

The Sources filter still lists all eight entries (Lead, Deal + the six doc types) after being
derived rather than hardcoded. The throwaway invoice raised for this check was rejected
afterwards; the pool is back to its pre-test contents.

#### Sales orders — rows 16, 17

| # | Result |
|---|--------|
| 16 | `SO-93322292` for **999 × test 3** (only 15 available). Approving from the pool failed with `P0001: Insufficient stock: need 999, only 15 available for product c6e252b4…`; the SO stayed **`sent`** and its approval row stayed in the pool. |
| 17 | Two cases. (a) The over-stock SO above: cancelled from `sent` → **`cancelled`**, and `test 3` was untouched (available 15, **reserved 0** — nothing leaked). (b) The stronger case: `SO-77835139` (2 × test 3) approved → available **15 → 13**, reserved **0 → 2**, then cancelled → **reserved released, available back to 15**, physical total unchanged at 18. A delivered-but-not-yet-invoiced SO still offers Cancel, which is exactly the row's scenario. |

#### Leads & deals — rows 5, 8, 10

| # | Result |
|---|--------|
| 5 | Created throwaway lead **`LD-15003348`** (QA Throwaway Lead Co) and converted it. Active Leads **21 → 20**, Converted **7 → 8**; the lead is gone from Active, present in Converted, and its detail page is locked: *"This lead is converted and locked (read-only)."* |
| 8 | Scheduled a **Call** on deal `OPP-94350557` due 15/08/2026 3:00 PM → it appears on the **Activities** page with source *Deal*, the deal's customer, and the due date, offering Mark Done / Reschedule / Cancel. |
| 10 | The same conversion runs server-side through `crm_convert_lead`; the generated deal code is **`OPP-94350557`** — `OPP-` prefix confirmed on the RPC path, not just the client path. |

#### i18n — rows 40, 51

Switched to العربية; `documentElement` flips to `dir="rtl" lang="ar"`.

| # | Result |
|---|--------|
| 40 | Sales Documents renders fully Arabic in RTL — tabs (عروض الأسعار / أوامر البيع / الفواتير / الإشعارات الدائنة / الأرشيف), every status chip (ملغى, غير مدفوع, مُرحّل), the `+ جديد` menu (all four entries), and the **New Credit Note modal end to end** including the link-invoice checkbox. A scan of the rendered text for `something.someKey` patterns returned **no raw i18n keys**. |
| 51 | `/accounting` fully Arabic: all four tabs, the payments table, and the **Record Payment modal** including the newest strings — تطبيق على الفواتير, تخصيص تلقائي (الأقدم أولاً), المخصص / غير مطبّق. **One gap found and fixed — see BUG #15.** |

#### Build gate — rows 41, 52

`npx vitest run` → **392/392 passed** (13 files). `npm run lint` → **0 errors**.
`npm run build` → **built in 15.91s**, PWA precache generated. (The row's "277 tests" is historical.)

#### BUG #15 — mobile header stayed English on Accounting and Purchasing

With the app in Arabic, the mobile header over `/accounting` read **"Accounting"** while the
sidebar entry beside it read **الحسابات**. Same for `/purchasing`.

`App.jsx`'s `mobileTitle` map — previously de-hardcoded during the §E i18n fix — never gained
entries for these two newer modules, so both fell through to the English title-cased-slug
fallback. The `nav.accounting` / `nav.purchasing` keys already existed in both locale files and
were simply not referenced.

**Fix:** added `'/accounting'` and `'/purchasing'` to the map. **Verified:** the header now
reads **الحسابات**.

### Funnel checklist — final state

**All 52 rows run. All 52 pass.**

Row 46 was the one wrinkle: it passed against the code while its *written* expectation was stale
— the row wanted "blocked", but the deliberate post-`20260754` behaviour is "reverse every
application, then void". `MASTER_UPGRADE_PLAN.md` row 46 was reworded on 2026-08-07 and carries a
note explaining why the code must not be changed back. Nothing outstanding.

Five defects were found and fixed in this pass — **#12** (migration `20260771`, applied by the
user and verified), **#13**, **#14**, **#15**, **#16** — every one confirmed live in the browser
after the fix, and #16 in both locales.

---

## Purchase Module (Sprint 9R) — manual QA click-through (2026-08-07)

Sprint 9R shipped 2026-07-05 marked ✅ BUILT with the manual click-through listed as **not yet
run**. This is that run. The module was already populated (13 vendors, 4 POs, 1 VI) but the
**receive path had never been exercised** — the one VI sat at *Approved* with code `Pending`,
meaning `VI-YYYY-NNNNN` had never been issued and no stock had ever entered through purchasing.

Everything below runs against a throwaway vendor, **QA Throwaway Vendor**, and a throwaway
product, **QA Serialized Widget** (`QA-PO-SER`). No real vendor, product or stock count was
touched.

### The 11-step script — result

| Step | Result |
|---|--------|
| Create vendor | `QA Throwaway Vendor` created from Purchasing → Vendors (13 → 14). The vendor list has a working **Edit** action, so the old plan note *"editing a vendor row is not yet wired"* is out of date. |
| Create PO | **`PO-95980824`**, 5 × QA Serialized Widget @ 100 = 500, status **Draft**. |
| Send for approval | → **Sent**; the header switches to *"Awaiting approval in Activities"* and **Download PDF** appears. |
| Approve from the pool | Pool row reads **"Purchase Order Approval Request · PO-95980824"** (BUG #16's fix holding on the purchasing side). Approving → PO **Confirmed**. |
| PO PDF | ✅ **Contents verified** — see the PDF section below. |
| Convert to VI | **Create Vendor Invoice** → VI created **Draft / Unpaid**, code **`Pending`**, `qty_ordered 5 / qty_received 0`, linked *From Purchase Order: PO-95980824*. Code correctly withheld until receipt. |
| Submit for approval + approve | Pool row reads **"Vendor Invoice Approval Request"**; approving → VI **Approved**, and **Confirm & Receive** appears. |
| Receive — partial | 2 of 5 (`QA-SER-001/002`) into Main Warehouse → **`VI-2026-00008`** assigned (first receipt only), status **Partially Received**, 2/5. Inventory: 2 available / 2 physical / 2 in Main. The linked PO auto-synced to **Partially Completed**. |
| Receive — full | Remaining 3 (`QA-SER-003/004/005`) → status **Fully Received**, 5/5, **code unchanged at `VI-2026-00008`** (idempotent, not re-issued), Confirm & Receive correctly disappears. PO auto-synced to **Completed**. Inventory 5/5, all Main. |
| Audit trail | Stock Movements shows **5 `Receive` rows, `doc_type = Vendor Invoice`**, one per serial, correctly split across the two receipts (12:03 for 001–002, 12:10 for 003–005). Every unit traces back to its vendor invoice. |
| Duplicate-serial guard | Re-submitting `QA-SER-001` alongside two new serials → rejected atomically with `P0001: Serial number QA-SER-001 is already in use`, surfaced to the user as a toast. Nothing partially landed. |
| Vendor payment | **`VP-2026-00001`** for 200 against the 500 VI → **Partially Paid**, amount paid 200, remaining 300. First live exercise of the AP half of the **BUG #11 `p_allocations`** fix — it works. |
| AP Aging | `QA Throwaway Vendor` **300.00 in Current**; total **4,050.00** = 3,750 (ASRock) + 300. Arithmetic checks. |
| Void the vendor payment | Voided with a reason → allocation reversed and the VI restored to **Unpaid / 500**. Mirrors the AR reverse-and-void behaviour exactly. |

### PO PDF — contents verified (2026-08-07)

Earlier this run I could only report *"the button fires without an exception"*, because a browser
download cannot be opened from the test harness. That was weak evidence, so it was re-done
properly.

**It is not a binary PDF.** `downloadPOPDF` builds an HTML document through the shared
`documentPdf` engine and hands it to `openPrint()`, which does
`window.open('', '_blank') → document.write(html) → win.print()`. The user's browser produces the
PDF from the print dialog. That makes the output fully inspectable: stubbing `window.open` with a
capture object collects the exact HTML that would be printed (5,304 chars), which can then be
parsed and asserted on.

Captured output for `PO-95980824`, checked field by field against the source document:

| Element | Rendered | Correct |
|---|---|---|
| Document title | `Purchase Order PO-95980824` | ✅ |
| Company identity | QDS Egypt · 20 Ahmed Heshmat, Zamalek, Cairo, Egypt · +20227374455 | ✅ from `sales_doc_layout` |
| Party label | **`Vendor:`** — not "Bill To:" | ✅ the `billToLabel` param added in 9R works |
| Vendor block | QA Throwaway Vendor / QA Contact | ✅ |
| Doc code | `# PO-95980824` | ✅ |
| Meta rows | Issue Date 8/6/2026 · Expected Delivery N/A · Currency EGP · Payment Terms N/A · Delivery Terms N/A | ✅ (N/A values were genuinely left blank on the PO) |
| Line item | QA Serialized Widget · 5 · EGP 100.00 · — · — · EGP 500.00 | ✅ matches the PO exactly |
| Totals | Order Total **EGP 500.00**, grand total row EGP 500.00 | ✅ |
| Signature block | Issued By **Bika Qds** · Approved By · Vendor Acknowledgement | ✅ PO-specific rows present |
| Footer | Thanks for your business · Generated 8/8/2026 | ✅ |

`win.print()` was confirmed called. Nothing is missing, mislabelled or mis-totalled.

**Minor observation — ✅ FIXED 2026-08-09 (BUG #24).** The PO form's Currency field is free text
with placeholder **`USD`**, but leaving it blank renders **EGP** — the fallback chain is
`purchaseOrder.currency || layout.currency || 'EGP'`. For an Egyptian company invoicing in EGP the
placeholder actively suggested the wrong default. Fixed by pointing the placeholder at
`PDF_LAYOUT_DEFAULT.currency`, the same constant `getPdfLayout()` falls back to, rather than
swapping one hardcoded literal for another. Verified: the field now shows `EGP`.

### BUG #17 — purchase receipts could be sent to protected system warehouses

The **Confirm & Receive** destination dropdown listed **all 10 warehouses, including all 8
protected system locations** — `Credit Note Holding`, `Replacement Holding`, `RMA - Received`,
`RMA - Under Repair`, `RMA - Repaired`, `RMA - Can't Repair`, `RMA - Stock`, `Scrap`. Nothing
stopped a user receiving brand-new purchased stock directly into Scrap, or creating RMA-located
units with a `NULL rma_ticket_id`.

This is the **same defect class** fixed on the sales/inventory side during the R1 run, where
`destinationWarehouses()` was extracted precisely because the filter had been written inline
four times and got it wrong every time. `PurchaseDocumentDetail.jsx` was a **fifth** site that
never got the helper — it mapped `warehouses` raw.

**Fix:** `ReceiveVendorInvoiceModal` now maps `destinationWarehouses(warehouses)`.
**Verified:** the dropdown drops from 10 options to the 2 legitimate ones (`Branch – Cairo`,
`Main Warehouse`), and the full receive flow still completes.

### BUG #18 — void dialog called every document an "invoice"

`salesDocuments.voidRequired` read *"A reason is required to void this **invoice**."* — but
`VoidModal` is shared by invoices, credit notes, customer payments **and** vendor payments, so
voiding a payment claimed to be voiding an invoice. **Fix:** reworded to *"…to void this
**document**."* in both locales (`يجب إدخال سبب لإلغاء هذا المستند.`).

### BUG #19 — Vendor Payments search box asked for a customer

The Vendor Payments tab reused `accounting.searchPlaceholder` — *"Search by code, customer,
reference…"* — on a table with no customers in it. **Fix:** new
`accounting.searchPlaceholderVendor` (*"Search by code, vendor, reference…"* /
*"بحث بالرمز أو المورد أو المرجع…"*), used only by that tab. **Verified** live.

### GAP — the entire bulk-tracking half of the system is unreachable

`stock_tracking_mode` is **read in 8 components** (`ReceiveVendorInvoiceModal`,
`ReceiveStockModal`, `BulkStockActionModal`, `StockBreakdownModal`, `BranchesDrawer`,
`OverviewTab`, and `inventory.ts` in two places) but **written by no UI anywhere**. The Add/Edit
Product form has no tracking-mode field, so every product takes the DB default `serialized`.

Confirmed empirically: filtering Inventory → Overview by **Bulk** returns **0 of 405 products**.

Consequence: the dual-mode `receive_vendor_invoice` RPC's bulk branch, the bulk paths in the
three inventory modals, and the bulk views in the breakdown/branches drawers are all dead code
in practice — they cannot be reached through the application. Sprint 8's headline "dual-model
(serialized + bulk-quantity) design" is effectively single-model in the running app.

**FIXED 2026-08-07 — see BUG #20 below.**

### BUG #20 — bulk tracking was unreachable; now exposed, and made safe to change

**The fix.** The product form (Add *and* Edit — one shared modal) gains a **Stock Tracking**
selector, `Serialized` / `Bulk`, defaulting to `serialized` so no existing product changes
behaviour. It reuses the existing `inventory.tracking_*` labels rather than adding new nouns, so
the words match the TRACKING column on Inventory → Overview exactly. The field is **hidden for
`product_type = 'service'`** — a service never touches inventory, so the choice is meaningless
there, and the save payload omits the key entirely for services (which also means flipping a
product to Service can never trip the new trigger).

**Why it needed more than a `<select>`.** The two models store stock in *different tables* —
serialized in `inventory_units`, bulk in `warehouse_stock` — and every reader picks its table
from the product's current mode. Changing the mode migrates nothing: it points every query at
the other, empty table. The stock vanishes from every screen and every availability check while
the rows still sit in the database, and the next sale would oversell against a phantom zero.

So the mode is **frozen while the product holds stock**, enforced in two places:

- **UI** — `db.products.hasStock(productId)` checks both tables (live `inventory_units` statuses
  `company_stock`/`active_rma`, plus `warehouse_stock.quantity > 0`) when the edit form opens.
  If stock exists the selector renders disabled with *"Locked — this product already holds
  stock. Move or remove it first; switching modes would hide the existing stock."*
- **Database** — `20260772_lock_stock_tracking_mode_with_stock.sql` adds
  `assert_tracking_mode_change_is_safe()` on `BEFORE UPDATE OF stock_tracking_mode`, raising
  `P0001` with the actual counts. Same discipline as `assert_not_system_warehouse` (20260770):
  the UI is not allowed to be the only guard. **Applied by the user 2026-08-07 and verified
  against a deliberate UI bypass** — see the trigger table below.

Emptying a product unfreezes it again — the rule is "has stock now", not "ever had stock".

**Verified live, end to end:**

| Check | Result |
|---|--------|
| Selector on Add | Present, defaults **Serialized**, editable. |
| Create a bulk product | **`QA-BULK-01` / QA Bulk Widget** saved with `stock_tracking_mode = 'bulk'` — Inventory → Overview shows it with a **Bulk** tracking badge. The first bulk-tracked product this system has ever had. |
| The bulk branch actually runs | **Receive Stock** on that product renders a **Quantity** field instead of the serial textarea, and receiving 25 into Main Warehouse gives **25 available / 25 physical / 25 Main**. The previously dead `warehouse_stock` path works. |
| Lock engages with stock | Editing QA Bulk Widget (25 in stock) → selector **disabled**, locked message shown. |
| Lock is not a blanket disable | `test1` (7 units) → locked, correctly; a genuinely empty product (`1TBHDD710 Pro BlACK`, 0 stock) → **enabled** with the normal hint. |

Bulk filter on Inventory → Overview now returns **1 product** where it previously returned 0
of 405.

**Trigger verified after the user applied `20260772`** — the UI lock was deliberately bypassed
(stripping `disabled` off the select and dispatching a real change event, i.e. exactly what a
scripted client or a stale lock state would do):

| Case | Expected | Actual |
|---|---|---|
| Unrelated edit on a **stocked** product (warranty 12 → 24 on QA Bulk Widget) | Saves — the trigger must not over-fire | **HTTP 200**, "Product updated successfully". Note the payload *did* carry `stock_tracking_mode: 'bulk'` unchanged; the `IS NOT DISTINCT FROM` short-circuit let it through, which is precisely why that check is there — the form always sends the field for non-service products. |
| **Bypass** the lock and change the mode on the stocked product | Refused | **HTTP 400 / `P0001`** — *"Cannot change stock tracking mode for "QA Bulk Widget": 0 serialized unit(s) and 25 bulk in stock. Move or remove the stock first — switching modes would hide it."* Counts are accurate, and the message surfaces to the user as a toast rather than failing silently. Re-checked afterwards: the product is **still Bulk with 25 in stock** — the refused write changed nothing. |
| Change the mode on an **empty** product (`1TBHDD710 Pro BlACK`, 0 stock) | Succeeds | Switched serialized → **Bulk**, confirmed on Inventory → Overview. **Reverted to Serialized afterwards** (it is a real ADATA catalog product, not a throwaway) — the revert also succeeded, confirming the rule is "has stock *now*", not "ever had stock". |

Only the throwaway `QA Bulk Widget` remains bulk-tracked; the real catalog is untouched.

### Purchase Module — verdict

The core procurement chain **works end to end**: vendor → PO → approval → VI → approval →
partial receipt → full receipt → inventory + audit trail → AP payment → aging → void. Code
assignment timing, receipt idempotency, PO auto-sync, the duplicate-serial guard and the AP
ledger all behave as designed.

Four defects found and fixed (**#17** functional, **#18**/**#19** copy, **#20** the bulk-tracking
gap, with its database guard applied and verified against a deliberate bypass). The PO PDF's
contents were re-verified properly and are correct.

**Nothing in the Purchase Module is left unverified.** One minor observation is logged but not
fixed: the PO Currency placeholder says `USD` while the effective default is `EGP`.

### Gate after all changes

**392/392 tests (13 files), 0 lint errors, production build clean.**

Nothing is committed — the user is handling that.
