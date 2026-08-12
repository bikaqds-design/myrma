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
| 10 | Empty state when nothing matches | ⚠️ works, but reads "Showing 1-0 of 0" where Customers reads "0–0". Cosmetic. |

## B. Product CRUD

| # | Check | Result |
|---|-------|--------|
| 11 | Required-field validation blocks empty submit | ✅ empty submit blocked, nothing created |
| 12 | Create a product | ✅ created `QA-PROD-QA40` with brand and tracking mode |
| 13 | Duplicate SKU is prevented | ✅ duplicate SKU refused by `products_sku_key` (23505) |
| 14 | Edit loads all values and persists | ✅ edit loaded every value; changes persisted |
| 15 | Stock tracking mode is settable and guarded when stock exists | ✅ settable on a stock-free product (serialized → bulk saved). On a stocked product the `20260772` trigger refuses it by name: *"Cannot change stock tracking mode for … 6 serialized unit(s)"*. The UI also pre-locks the selector. |
| 16 | Product image upload / replace | ⬜ |
| 17 | Delete asks for confirmation | ✅ confirms before deleting a stock-free product |
| 18 | Delete is blocked or warns when the product has stock or RMA history | ❌→✅ **BUG #38** — the DB refuses (23503) but the UI showed a generic "failed to delete". Now counts first and explains: *"…11 inventory records still reference it."* |

## C. Hierarchy — brands and categories

| # | Check | Result |
|---|-------|--------|
| 19 | Brand list shows counts (categories, products) | ✅ header counts match the DB exactly (14 / 51 / 407 at the time) |
| 20 | Create / edit a brand, including the vendor fields | ⬜ |
| 21 | Brand logo upload | ⬜ |
| 22 | Delete a brand that has products | ❌→✅ **BUG #37** — deleting a brand with products was allowed and the warning was wrong. See below. |
| 23 | Create / edit a category under a brand | ⬜ |
| 24 | Delete a category that has products | ❌→✅ **BUG #37** — same for categories; products were silently orphaned. |
| 25 | Brand ↔ vendor stay one record (already proven, re-confirm) | ✅ re-confirmed — restoring Acer restored its vendor fields (contact, email, phone, payment terms) on the same record |

## D. Bulk actions, import and export

| # | Check | Result |
|---|-------|--------|
| 26 | Select all, bulk status change, clear | ⬜ |
| 27 | Bulk delete with confirmation | ⬜ |
| 28 | CSV template downloads | ⬜ |
| 29 | Bulk upload imports valid rows | ⬜ |
| 30 | Bulk upload reports rejected rows | ⬜ |
| 31 | Export produces a correct file | ❌→✅ **BUG #39** — see below. Now xlsx via the shared ExportMenu; 406 rows, 8 columns. |
| 32 | A comma in a product name does not shift columns | ❌→✅ **BUG #39** — 34 of 406 names contain a comma. Zero misaligned rows after the fix. |

## E. Product detail page

| # | Check | Result |
|---|-------|--------|
| 33 | Opens the right product with all fields | ⬜ |
| 34 | Stock summary reflects real inventory | ⬜ |
| 35 | Edit and save from the detail page | ⬜ |
| 36 | Delete from the detail page | ⬜ |

## F. Cross-cutting

| # | Check | Result |
|---|-------|--------|
| 37 | Arabic (RTL): labels and values translated | ⬜ |
| 38 | Dark mode | ⬜ |
| 39 | Mobile width | ⬜ |
| 40 | Console clean | ⬜ |

---

## Bugs found — 4, all fixed

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

### Test data
None left behind. `QA-PROD-QA40` was created for rows 12–15 and deleted; the
catalog is back to 406 / 14 / 51.
