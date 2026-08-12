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
| 1 | Page loads; count matches the DB | ⬜ |
| 2 | Search by product name | ⬜ |
| 3 | Search by SKU | ⬜ |
| 4 | Sort each column, both directions | ⬜ |
| 5 | Filter by brand | ⬜ |
| 6 | Filter by category | ⬜ |
| 7 | Filter by type / status | ⬜ |
| 8 | Filters combine, then clear | ⬜ |
| 9 | Pagination: page size, page 2, jump | ⬜ |
| 10 | Empty state when nothing matches | ⬜ |

## B. Product CRUD

| # | Check | Result |
|---|-------|--------|
| 11 | Required-field validation blocks empty submit | ⬜ |
| 12 | Create a product | ⬜ |
| 13 | Duplicate SKU is prevented | ⬜ |
| 14 | Edit loads all values and persists | ⬜ |
| 15 | Stock tracking mode is settable and guarded when stock exists | ⬜ |
| 16 | Product image upload / replace | ⬜ |
| 17 | Delete asks for confirmation | ⬜ |
| 18 | Delete is blocked or warns when the product has stock or RMA history | ⬜ |

## C. Hierarchy — brands and categories

| # | Check | Result |
|---|-------|--------|
| 19 | Brand list shows counts (categories, products) | ⬜ |
| 20 | Create / edit a brand, including the vendor fields | ⬜ |
| 21 | Brand logo upload | ⬜ |
| 22 | Delete a brand that has products | ⬜ |
| 23 | Create / edit a category under a brand | ⬜ |
| 24 | Delete a category that has products | ⬜ |
| 25 | Brand ↔ vendor stay one record (already proven, re-confirm) | ⬜ |

## D. Bulk actions, import and export

| # | Check | Result |
|---|-------|--------|
| 26 | Select all, bulk status change, clear | ⬜ |
| 27 | Bulk delete with confirmation | ⬜ |
| 28 | CSV template downloads | ⬜ |
| 29 | Bulk upload imports valid rows | ⬜ |
| 30 | Bulk upload reports rejected rows | ⬜ |
| 31 | Export produces a correct file | ⬜ |
| 32 | A comma in a product name does not shift columns | ⬜ |

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

## Bugs found

_(none yet)_
