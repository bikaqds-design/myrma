# Customers QA

Covers `src/pages/Customers/` (list, modals, bulk upload) and
`src/pages/CustomerDetails.jsx` — 3,772 lines. Scope derived from the code.

Run date: 2026-08-12. 888 customers in the database.

---

## A. List — search, sort, filter, paginate

| # | Check | Result |
|---|-------|--------|
| 1 | Page loads; count matches the DB | ✅ 888 in UI = 888 in DB |
| 2 | Search by company name | ✅ company search returns the right row |
| 3 | Search by contact person / code / phone | ✅ code `CB-14776245` → 1 row |
| 4 | Sort each column, both directions | ✅ toggles asc/desc and persists. An early reading suggested it was broken — that was a stale element reference: `Th` is defined inside the component, so React remounts every header button on each render. |
| 5 | Filter by status | ✅ Active → 888, matching the DB exactly |
| 6 | Filter by type (B2B / B2C) | ✅ B2B → 883, B2C → 5, matching the DB |
| 7 | Filter by company | ✅ company text filter narrows correctly |
| 8 | Filters combine, then clear | ✅ company + type combine; "Clear all" restores 888 |
| 9 | Pagination: page size, page 2, jump | ✅ per=10 → 1–10, page 2 → 11–20, jump to 50 → 491–500, per=25 restores |
| 10 | Empty state when nothing matches | ✅ unmatched term shows "Showing 0–0 of 0" |

## B. Create / edit / delete

| # | Check | Result |
|---|-------|--------|
| 11 | Required-field validation blocks empty submit | ✅ empty submit blocked, "Required" shown, nothing created |
| 12 | Create a customer; code auto-generates | ✅ created with auto-generated code `CB-43002566` |
| 13 | Edit loads all values and persists changes | ✅ inline edit on the detail page loads every value; Tax ID change persisted with `updated_by` |
| 14 | Duplicate customer code is prevented | ✅ a duplicate code is refused by `customers_customer_code_key` (23505) |
| 15 | Delete asks for confirmation | ✅ confirms before deleting |
| 16 | Delete is blocked or warns when the customer has tickets | ❌→✅ **BUG #32** — the confirmation never mentioned the RMA tickets it destroyed. First fixed by counting and warning; then **migration `20260774` was applied**, so deletion is now refused outright and the UI says why instead of asking. |

## C. Bulk actions and upload

| # | Check | Result |
|---|-------|--------|
| 17 | Select all on page, then clear | ✅ select-all checked all 3 filtered rows and raised the bulk bar |
| 18 | Bulk status change | ✅ applies on select; all 3 set to Inactive |
| 19 | Bulk delete with confirmation | ✅ "Delete 3 customers? This cannot be undone." — deleted, count returned to 887 |
| 20 | CSV template downloads | ✅ `customers-template.csv` with 12 columns and two example rows |
| 21 | Bulk upload accepts a valid file | ✅ imported a valid B2B and a B2C row; `QA Upload Co, Ltd` and address `1 Test St, Cairo` both survived intact, so quoted commas parse correctly |
| 22 | Bulk upload reports per-row errors | ❌→✅ **BUG #31** — rejected rows were silently dropped. Fixed: the toast now reports skipped and rejected counts, and the console lists each row with its reason. |

## D. Export

| # | Check | Result |
|---|-------|--------|
| 23 | Export produces a correct file | ✅ exports a real xlsx via the shared ExportMenu |
| 24 | A comma in any field does not shift columns | ❌→✅ **BUG #30** — a comma in any field except address shifted every column after it. Fixed. |

## E. Customer detail page

| # | Check | Result |
|---|-------|--------|
| 25 | Opens the right customer with all fields | ✅ opens the right customer, 7 tabs, all fields correct |
| 26 | Linked RMA tickets listed | ✅ "No RMA tickets found" for a customer with none |
| 27 | Linked sales documents / balance | ✅ Billing shows outstanding balance 0.00 and an empty-history message |
| 28 | Add a contact | ✅ added; tab count went to (1) and it persisted to `contacts` |
| 29 | Edit / delete a contact | ✅ delete asks "Remove this contact? This cannot be undone." then removes it |
| 30 | Add a note | ✅ added with author and timestamp, persisted to `customer_notes` |
| 31 | Edit / delete a note | ✅ deleted immediately — note that unlike contacts, notes do **not** confirm first |
| 32 | Edit customer from the detail page | ✅ inline edit from the detail page saved and left the comma-bearing company name intact |

## F. Cross-cutting

| # | Check | Result |
|---|-------|--------|
| 33 | Arabic (RTL): labels and values translated | ❌→✅ **BUG #33** — the status badge and filter rendered raw English under Arabic. Fixed: now نشط / غير نشط / موقوف. |
| 34 | Dark mode | ✅ list, filters and detail page all correct in dark mode |
| 35 | Mobile width | ✅ usable at 375px; header title correct, table scrolls |
| 36 | Console clean | ✅ no errors from this module. A "Maximum update depth" warning appears only after a live edit and never on a clean reload — an HMR artifact, confirmed twice across two modules. |

---

## Bugs found — 4, all fixed

### BUG #30 — customer export corrupted rows containing a comma
`handleExportCSV` joined each row with `.join(',')`. Only `address` was quoted —
someone hit the comma problem on the one field where commas are unavoidable and
patched that field rather than the mechanism. Renaming one customer to
`Metra Computer Group, Egypt "MCG"` produced **12 fields against an 11-column
header**. 0 of 888 rows trigger it today, which is why it had gone unseen.
Fixed by exporting xlsx through the shared `ExportMenu`, matching Leads,
Purchasing and RMA Tickets. Verified by reading the workbook back: 11 columns,
name intact in one cell.

### BUG #31 — bulk import silently dropped rejected rows
Validation errors were collected into `errors` and then never shown. The success
toast reported `skippedCount` (duplicates) only, so a 500-row file with 40
missing company names reported "460 imported" with no hint the 40 existed.
Fixed: the toast reports both counts and the console lists each rejected row with
its reason. Verified — 3 rows, 1 valid: *"Imported 1 customers — 0 skipped as
duplicates, 2 rejected"* plus the two reasons.

### BUG #32 — delete confirmation never mentioned the RMA history it destroys
Covered in its own commit. The dialog now counts linked tickets and says so, and
names the company rather than the contact person.

### BUG #33 — customer status untranslated in Arabic
The badge and the filter dropdown rendered raw English while every header around
them translated. Same class as BUG #29 on tickets. Now نشط / غير نشط / موقوف.

### Correction — the bulk-import instructions were wrong
Both the customer and lead import modals told users *"Avoid commas inside the
address field — use a dash instead"*. The importer uses `parseCSVLine`, which
handles quoted commas correctly — proven by importing
`"QA Upload Co, Ltd"` with address `"1 Test St, Cairo"` intact. The instruction
was making users mangle their own data to avoid a problem that does not exist.
Both now say commas are fine inside quoted fields, which is what Excel and
Google Sheets produce anyway.

### Test data
None left behind. Every customer created during this run (1 single, 3 bulk
targets, 3 imported) was deleted. The count is 887 — the original 888 minus the
one customer lost to the delete probe, which is documented separately.

---

## After migration 20260774 (applied 2026-08-12)

The migration turned this from a warning into a block, so the UI had to change
with it. My own warning text — *"this also permanently deletes 4 RMA tickets"* —
became false the moment it was applied: those tickets are no longer deleted, the
delete is refused.

Verified end to end against the live guard:

| Path | Result |
|------|--------|
| Raw `DELETE` on a customer with tickets | Refused, `23503` foreign key violation |
| `delete_customer_cascade` | Refused, `P0001`, naming the customer and count |
| `delete_customers_cascade` on a mixed batch | Refused, and the ticket-free customer in that batch survived — all-or-nothing |
| Ticket-free single delete | Still works, and its `customer_notes` still cascade |
| Ticket-free bulk delete | Still works |
| UI, customer with tickets | No confirm dialog; an explanatory message naming the customer and count |
| UI, ticket-free customer | Normal confirm, deletes cleanly |

Three UI changes went with it: the destructive confirm is no longer offered when
it cannot succeed, the `catch` now surfaces the database's `P0001` message
instead of a flat "failed to delete", and the two now-false warning strings were
deleted from both locales rather than left to mislead.

One process note worth recording: the new strings resolved as raw keys until the
dev server was restarted. Vite caches the locale JSON and a hard reload does not
clear it — the same trap that cost time earlier in this project.
