# Pagination check

A full pass over every page that renders a list, asking one question: **can this
list grow past what a person can work through?** Decided from production row
counts, not from guesswork.

Audited 2026-09-03.

---

## First, a correction

**UX-GLOBAL-017 is retracted. The pagination arrows were already correct.**

I raised it after reading a small screenshot region and concluding the Arabic
arrows pointed the wrong way. Measured directly in the running app:

| button | glyph | x position |
|---|---|---|
| السابق (Previous) | **RIGHT-arrow** | 196 (further right) |
| التالي (Next) | **LEFT-arrow** | 10 (further left) |

In RTL, back is to the right and forward is to the left. Both are correct, and
they mirror because the arrow is carried inside the translated label
(`← Prev` / `Next →` against `→ السابق` / `التالي ←`) rather than being drawn by
logic. Nothing to fix.

That is the third finding this audit has had to retract after measuring the
rendered page instead of reading source or screenshots. The pattern is
consistent enough to be worth stating: **this codebase is usually more correct
than a static reading of it suggests.**

---

## What actually needed pagination

Two pages, both of which render everything they fetch:

| page | rows in production | before | after |
|---|---:|---|---|
| Control Panel → Audit Log | **500** (`listAll(500)`) | all 500 in the DOM | 25 per page |
| Knowledge Center → Coverage | **404** products | all 404 in the DOM | 25 per page |

Both now use the shared control, with the page reset when the filter, tab or
brand changes — otherwise filtering while on page 8 shows an empty list over
rows that plainly exist.

The Audit Log also had two "Showing" labels once paged: its own filter counter
read *"Showing 500 of 500 records"* directly above the pager's *"Showing 1–25 of
500"*, which reads as a contradiction. The filter counter now appears only while
a filter is actually narrowing the set, which is the only time it says anything.

---

## What did NOT need it, and why

Pagination on a short list is noise — a control that costs a click and hides
nothing. These were checked and deliberately left alone:

| page | rows | why not |
|---|---:|---|
| Control Panel → Currencies | 9 | fixed set |
| Control Panel → Custom Fields | 0 | config list, grows to tens at most |
| Control Panel → Announcements | 0 | config list |
| Control Panel → Pipeline Stages | 12 | config list |
| Control Panel → Integrations, Country Setup, Document Numbering | <20 | config lists |
| Knowledge Center → Search / Bulk upload | 2 documents | grows, but search narrows it |
| Reports (7 tables) | aggregates | bounded by their own grouping |
| Detail pages — Customer, Product, Vendor, Purchase, Sales Document | per-record | a single record's lines, not a corpus |
| Pipeline / Purchasing pivot views | aggregates | bounded by stage and vendor count |
| `cp/PDFLayout` | preview | printed-document layout, not a list |

If any config list does grow — custom fields is the likeliest — the control is
now one import away.

---

## The shared control moved

`Pagination` lived in `pages/Inventory/_shared.jsx` while being imported by
**sixteen files across nine modules**. A page outside Inventory that needed
paging had to reach into another module's private file, which is why the two
pages above had none.

It now lives in `src/components/Pagination.jsx` and is exported from the kit.
The old path re-exports it, so all sixteen existing callers are untouched.

It also had **no dark mode at all** — `text-gray-600`, `border-gray-300`,
`hover:bg-gray-50` with no dark variants, on every paged screen in the app. Added
once here rather than sixteen times.

---

## A bug the linter caught

The first version of the Coverage change put its three hooks *after* the page's
two early returns (loading, and not-provisioned). That breaks the Rules of Hooks:
the first render after loading finished would have called three hooks the
previous render had not.

**The build was perfectly happy with it.** `react-hooks/rules-of-hooks` caught
it. It is in the ESLint config for exactly this reason.
