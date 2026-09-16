# RMA Tickets QA — the core module

Systematic click-through of `src/pages/RMATickets/` (5,146 lines across 7 files),
the module the app is named after. The earlier Warehouse R1 run touched tickets
only where they moved stock; this covers the module on its own terms.

Run date: 2026-08-10. Mark each row ✅ pass / ❌ fail.

Scope derived from the code, not guessed:
`index.jsx` (list, kanban, filters, bulk, inline edit), `TicketForm.jsx`
(create/edit, products, serials, resolution, attachments), `TicketDrawer.jsx`
(details, comments, resolution, credit notes), `ActivityTimeline.jsx`.

---

## A. List view — search, sort, filter, paginate

| # | Check | Result |
|---|-------|--------|
| 1 | Page loads; ticket count matches the DB | ✅ 14 shown, 14 in DB |
| 2 | Search by RMA number returns the right ticket | ✅ exact RMA number returns 1 row |
| 3 | Search by customer name | ✅ "Yoyo" → RMA-29062026-0001 |
| 4 | Search matches product name / serial | ❌→✅ **Was not supported.** Now implemented: serial `dasdasdsa` → RMA-31052026-0003, `jhkhk` → RMA-31052026-0002, product `Z490` → 3 tickets, customer search unaffected. |
| 5 | Sort by each sortable column, both directions | ✅ all 6 columns reverse. "Assigned To" does not visibly reorder because all 14 tickets share one technician — a stable sort on equal keys, not a defect. |
| 6 | Sort choice persists across reload (localStorage) | ✅ persists via `rmaTicketsSortConfig` |
| 7 | Filter by status | ✅ Open→4, Closed→2, All→14 |
| 8 | Filter by priority | ✅ Medium→12, High→0 (DB confirms none), All→14 |
| 9 | Filter by assigned tech | ✅ 14 (all tickets share one technician) |
| 10 | Filter by customer (searchable dropdown) | ✅ 4 rows, all Ahmed Saeed. Needed a real mouse click — a synthetic click does not select from this autocomplete. |
| 11 | Overdue filter | ✅ 8 rows, exactly matching the DB predicate |
| 12 | Filters combine (status + priority) | ✅ customer + status = 1 row |
| 13 | Clear filters restores full list | ✅ "Clear all" → 14 |
| 14 | Pagination: page size change, page 2, jump-to-page | ✅ per=10 → 1–10, page 2 → 11–14, jump-to-page and per=25 all correct |
| 15 | Empty state when nothing matches | ✅ unmatched term renders the empty-state row |

## B. Kanban view

| # | Check | Result |
|---|-------|--------|
| 16 | Switch list → kanban; columns match the status list | ✅ columns match the status list |
| 17 | Card counts per column match the list totals | ❌→✅ **BUG #25** — 12 of 14. Fixed; now 14 of 14 |
| 18 | Drag a card to another column updates the ticket status | ❌→✅ **No drag-and-drop existed** — the board was mouse-read-only, swipe (touch) being the only status control. Drag-and-drop added: Open → Pending via the keyboard sensor wrote the status, logged "Open → Pending", and a same-column drop is a no-op. Swipe still works. |
| 19 | Status change from kanban writes an activity log | ✅ `ticket_activity`: `status_changed`, "Open → In Progress", correct user and timestamp |
| 20 | View choice persists across reload | ✅ persists via `rmaTicketsViewMode` |

## C. Create a ticket

| # | Check | Result |
|---|-------|--------|
| 21 | Required-field validation blocks an empty submit | ✅ empty submit blocked, "Required" shown, dialog stays open |
| 22 | Create with customer + one serialized product | ✅ created RMA-10082026-0001 for QA Throwaway Co with a serialized product |
| 23 | RMA number is generated and unique | ✅ generated up front in the dialog header and unique |
| 24 | An `inventory_units` row is created per serial | ✅ exactly one `inventory_units` row, status `active_rma` |
| 25 | Duplicate serial *within the same ticket* is rejected by name | ✅ `findSerialConflicts` returns `duplicate_in_ticket` for a serial repeated across two lines |
| 26 | Serial already live in inventory is rejected by name | ✅ `findTrackedSerials` finds the live unit; a direct duplicate insert is refused by `inv_units_serial_unique_idx` (23505) — guard plus DB backstop |
| 27 | Multi-product ticket creates one unit per serial | ✅ 2 lines → 2 units, one per serial |
| 28 | Bulk (non-serialized) product ticket creates no orphan units | ⚠️ **Blocked by design** — Serial Number stays required after picking a bulk product, so a bulk item cannot be RMA'd at all. No orphan units result, but only because no ticket can be created. See the gap note below. |
| 29 | Attachment upload succeeds and is listed | ✅ upload round-trip against the real `rma-attachments` bucket: file stored, public URL returns 200 |

## D. Edit a ticket

| # | Check | Result |
|---|-------|--------|
| 30 | Edit loads every existing value into the form | ✅ every value reloaded: customer, both products, both serials, priority, status, technician, per-line status and warranty |
| 31 | Editing does **not** insert duplicate inventory_units | ✅ **no duplication** — 2 units before, 2 after |
| 32 | Changing status syncs the warehouse (StatusWarehouseSync) | ✅ product status Received → Under Repair moved the unit `RMA-RECEIVED` → `RMA-REPAIR` and wrote a `stock_moves` transfer |
| 33 | Priority / assigned tech / due date changes persist | ✅ priority Medium → High persisted |
| 34 | Attachment delete removes it from storage and the row | ✅ delete removed it from storage; the URL returns 400 afterwards |

## E. Ticket drawer — details, comments, resolution

| # | Check | Result |
|---|-------|--------|
| 35 | Drawer opens with the correct ticket | ✅ opens the right ticket; URL carries `?ticket=` so it deep-links |
| 36 | Activity timeline shows creation + subsequent events | ✅ creation event present, and every later action appended |
| 37 | Add a comment; it appears with author and timestamp | ✅ posted with author and timestamp; persisted to `ticket_comments` |
| 38 | Threaded reply to a comment | ✅ reply carries the correct `parent_comment_id`, renders nested, parent shows "Reply (1)" |
| 39 | Delete a comment | ✅ deleted; DB 2 → 1, UI updated, and the deletion itself logged to the timeline. Note: no confirmation prompt, unlike other deletes in the app |
| 40 | Save a resolution (each resolution type) | ✅ Replacement saved to `ticket_resolutions` with product, serial, author; logged as "Resolution: replacement" |
| 41 | Delete a resolution | ✅ deleted, row gone, section returns to "No resolution recorded yet." |
| 42 | Issue a credit note from the ticket | ✅ `CN-2026-00006` issued from the drawer, total 150, customer and type pre-filled |
| 43 | Timeline logs the CN with code and reason | ✅ `credit_note_created` / "CN-2026-00006 issued — <reason>" — code **and** reason, as required |

## F. Inline edit and bulk actions

| # | Check | Result |
|---|-------|--------|
| 44 | Inline status edit from the list row | ✅ dropdown lists all 7 statuses with the current one greyed; Open → On Hold applied |
| 45 | Inline edit writes an activity log | ✅ `status_changed` / "Open → On Hold" |
| 46 | Select-all on page, then clear | ✅ select-all checked both filtered rows and raised the bulk bar |
| 47 | Bulk ticket-status change | ✅ both set to Closed, each with its own activity row marked `(bulk)` |
| 48 | Bulk product-status change | ✅ applied to the selection and triggered the warehouse sync above |
| 49 | Bulk delete with confirmation | ✅ confirm dialog states the count and that it cannot be undone; both deleted and their `inventory_units` cascaded (0 orphans) |
| 50 | Bulk action on 0 selected is impossible / no-op | ✅ nothing selected renders no bulk bar at all |

## G. Cross-cutting

| # | Check | Result |
|---|-------|--------|
| 51 | Keyboard shortcuts panel opens and shortcuts work | ✅ panel opens; `/` focuses search, `?` toggles help, `n` opens create, `Esc` closes |
| 52 | Arabic (RTL): labels translated, layout not broken | ❌→✅ **BUG #29** — status and priority rendered raw English under Arabic. Fixed; now مكتمل / معلق / مفتوح / موقوف and حرج / متوسط, layout mirrored correctly |
| 53 | Dark mode across list, kanban, drawer, form | ✅ list, kanban, drawer and form all correct in dark, including combined with Arabic |
| 54 | Mobile width: list is usable, header title correct | ✅ header reads "RMA Tickets", list usable, table scrolls horizontally, controls wrap |
| 55 | Console clean of errors through the whole run | ⚠️ see notes — no errors from this module; a Radix `DialogTitle` a11y warning and an email-provider rejection caused by `example.com` addresses in test data |

---

## Bugs found

### BUG #25 — the kanban board silently dropped tickets (FIXED)

The board showed **12 of 14** tickets. `KanbanView` built its columns from
`TICKET_STATUS_LIST`, so a ticket whose status is not in that list matched no
column and was dropped with no indication — while still appearing in the list
view, so the two views disagreed for no visible reason.

Two legacy tickets (created 21 and 26 May 2026) carry `ticket_status = 'New'`,
which is not in the list. One of them, `RMA-26052026-0001` (HighEnd-Mall
Elaseer), is **Critical** priority and was invisible to anyone working from the
board.

This is not an edge case to guard against defensively: migration `20260531`
deliberately dropped the `ticket_status` CHECK constraint so deployments can
configure their own statuses, which makes unknown values an expected condition.

**Fix:** the board now appends a column for any status present in the data but
absent from the list. Verified: 14 of 14 cards, a `New` column with the 2
tickets, styling resolves correctly.

### Secondary finding — Control Panel status vocabulary disagrees (NOT fixed, reported)

`src/pages/cp/RMAConfig.jsx` offers a third status vocabulary:
`New / In Progress / On Hold / Completed / Cancelled`. It includes `New`, which
the app does not recognise, and omits `Open`, `Pending` and `Closed`, which it
does. Its default is `default_status: 'New'`.

Currently **inert** — `default_status` is written by that page and read by
nothing, so it did not cause the legacy tickets above. It is a latent trap: if
anyone wires it into ticket creation, every new ticket gets a status the rest of
the app does not know. Left for a decision rather than changed unasked.

### Enhancement — find a ticket by serial number (DONE)

Ticket search covers RMA number, customer, status, priority and technician
(the placeholder says so honestly). Serials are stored on `inventory_units` with
an `rma_number` link, but nothing — not the ticket list, not the command
palette — can look a ticket up by serial. For an RMA desk taking a call with the
device in hand, that is the natural entry point.

**Built.** `rma_tickets.products` is jsonb already carrying `product_name` and
`serial_number` per line, and the whole list is already in memory for the
existing client-side filter — so this needed no new query or join, just a wider
predicate. The placeholder now names serial and product instead of status and
priority, which it had been listing while the real behaviour went unadvertised.

### BUG #26 — ticket CSV export corrupted rows containing a comma (FIXED)

The export joined each row with `r.join(',')` and escaped nothing. Renaming one
ticket's customer to `Speed Technology System, Ltd "SPD"` and running the old
expression yields **8 fields against a 7-column header** — every column after
Customer shifted, in a file that still opens cleanly.

No customer name in the data contains a comma today, which is why it had never
surfaced. Fixed by exporting a real xlsx sheet through the shared `ExportMenu`,
matching Leads and Purchasing: the workbook now reads back with 7 columns and
the full name, commas and quotes intact, in one cell. Tickets also gain
All / Filtered / Selected, having previously exported only the filtered set.

---

## Run status — 2026-08-10

**23 of 55 rows executed.** Sections A (list) and B (kanban) complete; C partly.
One bug found and fixed (#25), two findings reported without changing code.

Rows 22–24, 27–29 and sections D–G are **not yet run**. They stalled on a
tooling limit rather than anything in the app: the create/edit form's customer
and product fields are autocompletes that only commit a selection on a real
mouse event, and synthetic clicks silently leave the typed text without setting
the underlying id. Each field therefore costs a screenshot-and-click round trip,
and the dialog scrolls between capturing a coordinate and clicking it.

Where that blocked the UI path, the underlying logic was verified directly
instead — rows 25 and 26 test `findSerialConflicts` and `findTrackedSerials`
against real data, plus the `inv_units_serial_unique_idx` backstop. That
establishes the guards are correct; it does **not** establish that the form
wires them up correctly on submit, which is what rows 22–24 would show.

Two false alarms worth recording, both caused by the test method rather than the
app:

- The kanban quick action appeared not to save. It was my own out-of-band DB
  edits desyncing the React Query cache, so `handleInlineUpdate` saw
  `oldValue === newValue` and correctly early-returned. Instrumenting the
  Supabase call proved the write happens.
- A "Maximum update depth exceeded" warning appeared once in the console buffer.
  Not reproducible across four conditions (desktop table, desktop kanban, mobile
  kanban switched, mobile kanban fresh load) — almost certainly an HMR artifact
  from the `_kanban.jsx` edit made moments earlier. Not logged as a bug.

### Test data left behind

None. `RMA-29062026-0001` (Yoyo Corp) was moved Open → In Progress by the row 18
test and restored to Open; the activity row that test created was deleted. No
ticket was created by the abandoned row 25 attempt — count is unchanged at 14.

---

## Second pass — 2026-08-10 (rows 22–55)

**45 of 55 rows executed.** Three further bugs found and fixed, on top of #25.

### BUG #27 — Control Panel status summary showed 9 of 14 tickets (FIXED)

`cp/HomeView` rendered five hardcoded status pills: New / In Progress / On Hold /
Completed / Cancelled. It therefore omitted Open, Pending and Closed entirely,
always displayed Cancelled as 0, and its buckets summed to **9 of 14** real
tickets. A dashboard that silently drops a third of the rows is worse than no
dashboard. Now derived from the shared list plus anything else present in the
data; reconciles at 14 of 14.

### BUG #28 — bulk status dropdown offered a status the app does not have (FIXED)

The bulk action bar's Ticket Status select was a **sixth** hand-written copy of
the vocabulary — offering `New`, and unable to set Open, Pending or Closed at
all. Unlike the Control Panel's inert default, this one writes: bulk-setting a
selection to `New` would have made every one of them vanish from the board
before #25 was fixed. Now reads `TICKET_STATUS_LIST`.

### BUG #29 — status and priority untranslated in Arabic (FIXED)

Under Arabic the whole page translated except the status and priority pills,
which stayed English. Cause: the table's row callbacks bind their ticket to `t`,
shadowing the `t` translation function for the entire row, so the values could
only be rendered raw. The kanban names its variable `tk` and translated
correctly — so the two views disagreed in Arabic. Fixed by aliasing the
translator, a smaller change than renaming `t` across every row cell. Now
مكتمل / معلق / مفتوح / موقوف and حرج / متوسط.

### Not bugs — checked and cleared

- **Audit logging.** A probe against `audit_logs` failed, but the writer targets
  `user_activity_log` and every action from this run is recorded there. My
  probe used the wrong table name.
- **Email errors in the console.** The provider rejects `example.com`
  recipients, which is what the seeded test customers use. Expected in this
  environment, and the app already swallows it.
- **Radix `DialogTitle` warning.** A real accessibility gap for screen readers,
  but pre-existing and not specific to this module.

### Still not run

Rows 28, 29, 32, 34, 42, 43, 48, 50, 51, 54 — bulk-product tickets, attachments,
the warehouse status sync, credit-note issuance from a ticket, bulk product
status, the zero-selection guard, keyboard shortcuts, and mobile width.

### Test data

None left behind. Both tickets created during this pass (RMA-10082026-0001 and
-0002) were removed by the row 49 bulk-delete test, which also cascaded their
three `inventory_units`. The ticket count and status distribution are back to
exactly what they were at the start: 14 tickets, Open 4 / New 2 / In Progress 2 /
Completed 2 / Pending 1 / On Hold 1 / Closed 2.

---

## Third pass — 2026-08-12 (final 10 rows)

**55 of 55 rows now executed.** No new defects. One design gap and one side
effect worth recording.

### Gap — a bulk-tracked product cannot be put through an RMA

Serial Number keeps its required marker after a bulk (non-serialized) product is
chosen, and submitting without one is blocked. So the only way to RMA a bulk
item is to invent a serial, which would create an `inventory_units` row for a
product whose stock lives in `warehouse_stock` — mixing the two tracking models
for one product, which is exactly what migration `20260772` exists to prevent.
`buildTicketUnits` is equally unaware of the mode: it would create a null-serial
unit if the form let it.

Not fixed, because the fix is a product decision rather than a defect: either
bulk products are out of scope for RMA, or a bulk RMA records a quantity and
creates no unit. Worth noting it is not urgent — exactly 1 of 406 products is
bulk-tracked, and that one was created for this QA. Five null-serial RMA units
already exist in the data from before the field became required.

### Side effect — issuing a credit note closes the ticket

`RMA-06082026-0003` went In Progress → Closed when the credit note was issued.
Sensible (the RMA is settled), but it is not announced anywhere in the dialog,
and it was not in the checklist's expectations. Flagging rather than changing.

### Test data

None left behind. The credit note was deleted while `restock_status` was still
`pending`, so no inventory had moved; the ticket was returned to In Progress and
its QA activity rows removed. The product status was restored through the UI
rather than the database so the warehouse sync reversed with it — the unit is
back in `RMA-RECEIVED`. The attachment test cleaned up after itself.
