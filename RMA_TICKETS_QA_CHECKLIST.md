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
| 4 | Search matches product name / serial | ⚪ **Not supported** — search covers RMA number, customer, status, priority, technician. Placeholder says so honestly. See enhancement note below. |
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
| 18 | Drag a card to another column updates the ticket status | ✅ swipe reveals "Mark as In Progress"; the quick action writes the status. (No drag-and-drop exists — the board is touch swipe + tap-to-open by design, so desktop is read-only.) |
| 19 | Status change from kanban writes an activity log | ✅ `ticket_activity`: `status_changed`, "Open → In Progress", correct user and timestamp |
| 20 | View choice persists across reload | ✅ persists via `rmaTicketsViewMode` |

## C. Create a ticket

| # | Check | Result |
|---|-------|--------|
| 21 | Required-field validation blocks an empty submit | ✅ empty submit blocked, "Required" shown, dialog stays open |
| 22 | Create with customer + one serialized product | ⬜ |
| 23 | RMA number is generated and unique | ⬜ |
| 24 | An `inventory_units` row is created per serial | ⬜ |
| 25 | Duplicate serial *within the same ticket* is rejected by name | ✅ `findSerialConflicts` returns `duplicate_in_ticket` for a serial repeated across two lines |
| 26 | Serial already live in inventory is rejected by name | ✅ `findTrackedSerials` finds the live unit; a direct duplicate insert is refused by `inv_units_serial_unique_idx` (23505) — guard plus DB backstop |
| 27 | Multi-product ticket creates one unit per serial | ⬜ |
| 28 | Bulk (non-serialized) product ticket creates no orphan units | ⬜ |
| 29 | Attachment upload succeeds and is listed | ⬜ |

## D. Edit a ticket

| # | Check | Result |
|---|-------|--------|
| 30 | Edit loads every existing value into the form | ⬜ |
| 31 | Editing does **not** insert duplicate inventory_units | ⬜ |
| 32 | Changing status syncs the warehouse (StatusWarehouseSync) | ⬜ |
| 33 | Priority / assigned tech / due date changes persist | ⬜ |
| 34 | Attachment delete removes it from storage and the row | ⬜ |

## E. Ticket drawer — details, comments, resolution

| # | Check | Result |
|---|-------|--------|
| 35 | Drawer opens with the correct ticket | ⬜ |
| 36 | Activity timeline shows creation + subsequent events | ⬜ |
| 37 | Add a comment; it appears with author and timestamp | ⬜ |
| 38 | Threaded reply to a comment | ⬜ |
| 39 | Delete a comment | ⬜ |
| 40 | Save a resolution (each resolution type) | ⬜ |
| 41 | Delete a resolution | ⬜ |
| 42 | Issue a credit note from the ticket | ⬜ |
| 43 | Timeline logs the CN with code and reason | ⬜ |

## F. Inline edit and bulk actions

| # | Check | Result |
|---|-------|--------|
| 44 | Inline status edit from the list row | ⬜ |
| 45 | Inline edit writes an activity log | ⬜ |
| 46 | Select-all on page, then clear | ⬜ |
| 47 | Bulk ticket-status change | ⬜ |
| 48 | Bulk product-status change | ⬜ |
| 49 | Bulk delete with confirmation | ⬜ |
| 50 | Bulk action on 0 selected is impossible / no-op | ⬜ |

## G. Cross-cutting

| # | Check | Result |
|---|-------|--------|
| 51 | Keyboard shortcuts panel opens and shortcuts work | ⬜ |
| 52 | Arabic (RTL): labels translated, layout not broken | ⬜ |
| 53 | Dark mode across list, kanban, drawer, form | ⬜ |
| 54 | Mobile width: list is usable, header title correct | ⬜ |
| 55 | Console clean of errors through the whole run | ⬜ |

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

### Enhancement candidate — no way to find a ticket by serial number

Ticket search covers RMA number, customer, status, priority and technician
(the placeholder says so honestly). Serials are stored on `inventory_units` with
an `rma_number` link, but nothing — not the ticket list, not the command
palette — can look a ticket up by serial. For an RMA desk taking a call with the
device in hand, that is the natural entry point. Missing feature, not a defect.

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
