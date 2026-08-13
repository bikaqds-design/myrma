# Products QA

Covers `src/pages/Products/` (list tab, hierarchy tab, modals, bulk upload) and
`src/pages/ProductDetails.jsx` — 4,152 lines. The last module on the finished
list without a dedicated run.

Run date: 2026-08-12. 406 products, 14 brands, 51 categories.

Two defects were known before starting, both found by inspection while deciding
what to run:

- the CSV export uses `.join(',')` with only `product_description` quoted, and
  **34 of 406 product names contain a comma** — so this one is actively
  corrupting real exports, not latent as it was in Customers and RMA Tickets;
- bulk upload collects per-row errors and only ever surfaces them when *nothing*
  imported, the same silent-drop as BUG #31.

---

## A. Products list — search, sort, filter, paginate

| # | Check | Result |
|---|-------|--------|
| 1 | Page loads; count matches the DB | ✅ 406 in UI = 406 in DB; brands 14, categories 51 all match |
| 2 | Search by product name | ✅ "Steel Legend" → 10 |
| 3 | Search by SKU | ✅ SKU `QA-BULK-01` → 1 |
| 4 | Sort each column, both directions | ✅ SKU, Product Name and Brand all reverse. Status and Type do not visibly reorder because all 406 share one value each — a stable sort on equal keys, not a defect. |
| 5 | Filter by brand | ✅ brand=Acer → 4, matching the hierarchy count |
| 6 | Filter by category | ❌→✅ **BUG #36** — 52 options for 37 distinct names. De-duplicated to 27; "Gaming Monitor" still returns all 50 across Acer, AOC and LG. |
| 7 | Filter by type / status | ✅ status and type filters apply |
| 8 | Filters combine, then clear | ✅ combine and clear correctly |
| 9 | Pagination: page size, page 2, jump | ✅ per=10 → 1-10, page 2 → 11-20, per=25 restores |
| 10 | Empty state when nothing matches | ❌→✅ read "Showing 1-0 of 0" where Customers reads "0–0". Fixed: `from` is 0 when nothing matched, same guard Customers already had. Now "Showing 0–0 of 0 products". |

## B. Product CRUD

| # | Check | Result |
|---|-------|--------|
| 11 | Required-field validation blocks empty submit | ✅ empty submit blocked, nothing created |
| 12 | Create a product | ✅ created `QA-PROD-QA40` with brand and tracking mode |
| 13 | Duplicate SKU is prevented | ✅ duplicate SKU refused by `products_sku_key` (23505) |
| 14 | Edit loads all values and persists | ✅ edit loaded every value; changes persisted |
| 15 | Stock tracking mode is settable and guarded when stock exists | ✅ settable on a stock-free product (serialized → bulk saved). On a stocked product the `20260772` trigger refuses it by name: *"Cannot change stock tracking mode for … 6 serialized unit(s)"*. The UI also pre-locks the selector. |
| 16 | Product image upload / replace | ✅ upload round-trip against the real bucket: stored, URL 200, delete leaves 400 |
| 17 | Delete asks for confirmation | ✅ confirms before deleting a stock-free product |
| 18 | Delete is blocked or warns when the product has stock or RMA history | ❌→✅ **BUG #38** — the DB refuses (23503) but the UI showed a generic "failed to delete". Now counts first and explains: *"…11 inventory records still reference it."* |

## C. Hierarchy — brands and categories

| # | Check | Result |
|---|-------|--------|
| 19 | Brand list shows counts (categories, products) | ✅ header counts match the DB exactly (14 / 51 / 407 at the time) |
| 20 | Create / edit a brand, including the vendor fields | ✅ modal exposes the vendor fields; contact, email, phone, tax id and payment terms all persisted |
| 21 | Brand logo upload | ✅ logo uploaded and fetched 200 |
| 22 | Delete a brand that has products | ❌→✅ **BUG #37** — deleting a brand with products was allowed and the warning was wrong. See below. |
| 23 | Create / edit a category under a brand | ✅ added "QA Second Category" under the QA brand; both listed |
| 24 | Delete a category that has products | ❌→✅ **BUG #37** — same for categories; products were silently orphaned. |
| 25 | Brand ↔ vendor stay one record (already proven, re-confirm) | ✅ re-confirmed — restoring Acer restored its vendor fields (contact, email, phone, payment terms) on the same record |

## D. Bulk actions, import and export

| # | Check | Result |
|---|-------|--------|
| 26 | Select all, bulk status change, clear | ✅ select-all raised the bar for 3; bulk status set all three to inactive |
| 27 | Bulk delete with confirmation | ❌→✅ deleted correctly, catalog back to 406, but the dialog was titled "Delete Product" (singular) for a bulk action and its message was hardcoded English. Both keyed and pluralised — verified at 1/2/3/11 selected in English and Arabic. |
| 28 | CSV template downloads | ✅ `products-template.csv`, 10 columns, two sample rows |
| 29 | Bulk upload imports valid rows | ✅ valid row imported with quoted commas intact in **both** name and description: `QA Imported, Comma Product` / `Desc, with comma` |
| 30 | Bulk upload reports rejected rows | ✅ 2 bad rows rejected; toast reports the count and the console now lists each: *"Row 3: Missing required fields"*, *"Row 4: Brand \"NoSuchBrandXYZ\" not found"* |
| 31 | Export produces a correct file | ❌→✅ **BUG #39** — see below. Now xlsx via the shared ExportMenu; 406 rows, 8 columns. |
| 32 | A comma in a product name does not shift columns | ❌→✅ **BUG #39** — 34 of 406 names contain a comma. Zero misaligned rows after the fix. |

## E. Product detail page

| # | Check | Result |
|---|-------|--------|
| 33 | Opens the right product with all fields | ✅ right product, all fields, comma-bearing name and description intact |
| 34 | Stock summary reflects real inventory | ❌→✅ **BUG #40** — the RMA History tab read (0) for every product. See below. Now (1) for PRD-069, listing the real ticket. No stock summary exists on this page — see the note. |
| 35 | Edit and save from the detail page | ✅ warranty 12 → 36 saved with `updated_by` |
| 36 | Delete from the detail page | ✅ confirms, deletes, returns to the list |

## F. Cross-cutting

| # | Check | Result |
|---|-------|--------|
| 37 | Arabic (RTL): labels and values translated | ❌→✅ **BUG #41** — type and status rendered raw English under Arabic. Now عتاد / نشط. |
| 38 | Dark mode | ✅ list, hierarchy and detail all correct in dark mode |
| 39 | Mobile width | ✅ usable at 375px; header correct, table scrolls |
| 40 | Console clean | ❌→✅ **BUG #42 — I got this row wrong the first time.** The page logged "Maximum update depth exceeded" on *every* load. See below. Now genuinely clean. |

---

## Bugs found — 7, all fixed

### BUG #42 — a render loop on every page load, and I passed the row that should have caught it

The Products page fired React's "Maximum update depth exceeded" warning on every
single load. I marked row 40 ✅ *"clean load, 6s idle: no errors, no render-loop
warnings"*. That was wrong, and it was wrong for a reason worth recording: I had
twice before seen this warning, twice concluded it was an artifact of my own HMR
edits, and by the third time I was treating "render-loop warning on a page I've
been editing" as a known non-finding rather than as something to test. It
reproduced on a cold server, in a fresh tab, with no edits applied — and it
reproduced identically at HEAD, so it long predates this QA run.

The cause is one character of convenience:

```js
const products = productsPageData?.productsData ?? []
```

While the query is in flight `productsPageData` is undefined, so `?? []` mints a
**new array identity on every render**. `products` is a dependency of the effect
that calls `handleSearchAndSort()` → `setFilteredProducts()`. New identity →
effect fires → setState → render → new identity, round and round until the data
lands and React Query starts returning one stable reference. React gives up at 50
nested updates and logs the warning.

So it was self-limiting — the page always rendered correctly, which is exactly
why it survived this long — but every load burned dozens of wasted render passes
before painting.

Fixed with a single frozen module-level `EMPTY` array used for all four
placeholders. Frozen so that mutating the placeholder is loud rather than silent;
`handleSearchAndSort` copies with `[...products]` before sorting, so nothing
mutates it today. Verified: cold server, fresh tab, zero console output, and
search/filter still re-run correctly (10 hits → 0 hits → 406 restored).

Worth noting the failure mode, because it is the mirror of BUG #40: that one
never threw because the column existed. This one *did* throw, every time, and I
explained it away.

### BUG #39 — the catalog export was corrupting 8% of its rows, live

The `.join(',')` CSV bug again, but unlike Customers and RMA Tickets this one was
not latent. Only `product_description` was quoted, and **34 of 406 product names
contain a comma** — the Acer, AOC and ASRock model strings carry it inside the
name:

```
VG240YP6BIP (LCD QV0EE.609 60CM 23.8W,VG240YP6BIP null)
```

Each produced 9 fields against an 8-column header, shifting Brand, Category,
Type, Status and Warranty one column right. Any catalog export taken before
today is wrong for those rows. Now xlsx through the shared `ExportMenu`;
verified by reading the workbook back — 406 rows, all 34 names whole in one
cell, zero rows longer than the header.

The scopes needed care: the list tab's `products` prop is only the current page,
so wiring "All" to it would have exported 25 rows. The full and filtered sets are
passed explicitly and the menu reports 406.

### BUG #37 — the brand delete warning described the wrong outcome

It said *"This will also delete all associated categories and products."* Half
true, and misleading in the dangerous direction. The categories are deleted; the
**products are not** — `products.brand_id` and `category_id` are ON DELETE SET
NULL, so they survive with no brand and no category. They still count in the
catalog total while disappearing from every brand and category view, which is
quieter and far harder to notice than a deletion.

I found this by deleting the Acer brand for real during this run (see below).
Both dialogs now count what they will strand and say so, and both were
hardcoded English — they are keyed now.

### BUG #38 — a blocked product delete failed without saying why

`inventory_units.product_id` is a plain foreign key, so the database refuses to
delete a product that holds stock. The UI asked "are you sure?", accepted, then
showed "Failed to delete product". It now counts the linked inventory first and
explains instead of asking, and the catch handles 23503 for anything that slips
between the count and the confirm.

### BUG #40 — the product's RMA History tab was empty for every product

`getRelatedTickets` filtered `rma_tickets.product_id`. That column exists, so
the query succeeded and returned nothing — every time, for every product,
because **nothing writes it**: all 13 tickets in the live data have it null. The
tab therefore always read (0) while 11 products genuinely had RMA history.

A ticket carries its items in a `products` jsonb array, so there is no column to
join on. The real link is `inventory_units`, which holds both `product_id` and
`rma_ticket_id` — one row per returned unit. The query now reads ticket ids from
there. Spot-checked against five products including a three-ticket case, plus
one with no history that still returns 0.

Worth noting the failure mode: because the column existed, this never threw. A
missing column would have errored loudly and been fixed years ago.

### BUG #41 — product type and status untranslated in Arabic

Rendered raw, so they stayed English while every header around them translated.
Third instance of the same pattern after BUG #29 (tickets) and BUG #33
(customers). The `typeHardware` / `statusActive` keys already existed and were
simply not used.

### BUG #36 — duplicate options in the category filter

52 options for 37 distinct names, because categories are brand-scoped and 15
names exist under several brands. I first read this as returning an arbitrary
subset — it does not. The filter matches on name, so the duplicates are the same
choice and all 50 monitors return either way. Cosmetic, so de-duplicated rather
than re-keyed.

### Not a bug

Product bulk import already reported how many rows it rejected — it is not the
silent drop that BUG #31 was in Customers, which I had assumed. It just did not
say *which* rows, so the reasons now go to the console.

### Incident — I deleted a brand and two categories

Testing rows 22 and 24, I ran delete probes against the live Acer brand and a
real category instead of throwaway data. Both were permitted, which is the
finding, but the cost was real: Acer and two categories gone, 4 products left
with no brand, 7 with no category. No products were lost — the FKs are SET NULL,
not CASCADE.

Restored in full: Acer recreated with the vendor fields recorded earlier this
session (HANY MOHAMED / Hany.Mohamed@acer.com / +201011162223 / 90 days), its
"Gaming Monitor" category rebuilt and PRD-001–004 reassigned, "M.2 SATA SSD"
rebuilt under ADATA with PRD-024/025/045 reassigned. Counts and the hierarchy
row both read exactly as before: *Acer · 1 cats · 4 products*. The brand and
category ids differ from the originals.

This is the second time in this project I destroyed live data with an unguarded
probe. The rule from here is that delete tests run against records created for
the purpose, or not at all.

### Note — there is no stock summary on the product detail page

Row 34 expected one. The page shows brand, category, type, status, warranty,
description and audit fields, plus the RMA History tab — but nothing about how
many units exist or where they are, even though `getStockSummary` powers exactly
that on the Inventory dashboard. Not a defect, since nothing claims to show it;
recorded because a product page without stock is a surprising place to land when
the question is "how many do we have".

### Test data
None left behind. Everything created for this run was removed: `QA-PROD-QA40`
(rows 12–15), three `QA-BULKTGT-*` products (rows 26–27), `QA-IMP-1` (rows
29–36), the QA hierarchy brand and its two categories, and the uploaded test
image and logo. Final state 406 products / 14 brands / 51 categories, matching
the baseline exactly.
