# Reports — CRM rebuild

Audit 2026-08-17. `src/pages/Reports.jsx`, 1,272 lines, four tabs.

---

## The finding: the Financial tab reports on an empty table

`Reports` loads `db.invoices.list()`. That reads the **`invoices`** table, which
holds **0 rows**. Every invoice this business has ever raised lives in
**`crm_invoices`**, which holds 27.

The tab therefore renders, in production, right now:

```
$0.00  Total Invoiced
$0.00  Total Paid
$0.00  Pending / Overdue
$0.00  Quotes Value
       No invoices in the selected date range
```

This is not a layout problem or a stale default — it is a report telling the
owner the company has invoiced nothing. Same shape as the Dashboard finding
(`getRelatedTickets` reading a column nothing writes, the CRM widgets hidden by a
stale list): the query succeeds, returns nothing, and nothing errors, so it looks
like an empty business rather than a broken wire.

`invoices` is the pre-CRM table. The Sprint 6/7 funnel work introduced
`crm_invoices`, `quotations`, `sales_orders`, `credit_notes` and `payments`, and
Reports was never repointed.

### The shapes differ, so this is a rewire and not a rename

| Reports expects (`invoices`) | CRM provides (`crm_invoices`) |
|---|---|
| `total_amount` / `amount` | `total` |
| `status`: paid / pending / overdue | `doc_status`: draft / posted / cancelled **plus** `payment_status`: unpaid / partial / paid / reversed |
| `type === 'quote'` | a separate `quotations` table |
| — | `amount_paid`, so partial payment is representable |

"Quotes Value" filters `invoices` for `type === 'quote'`. No such column exists
on either table; quotations are their own table with 38 rows. That KPI could
never have shown anything.

---

## What the four tabs cover, against what the business has

| Data | Rows |
|---|---|
| Customers | 888 |
| Activities | 176 |
| Deals | 57 |
| Quotations | 38 |
| Sales orders | 31 |
| Invoices (`crm_invoices`) | 27 |
| Credit notes | 5 |
| Payments | 3 |
| RMA tickets | 13 |
| Time entries | **1** |

| Tab | Subject | State |
|---|---|---|
| Tickets | 13 RMA tickets | Works |
| Customers | Customers **that have RMA tickets** | Works, but "Active Customers: 3" out of 888 is a misleading label — it means "customers with a ticket in range" |
| Technicians | Assignment + time logged | Works, on 1 time entry across the whole database |
| Financial | Invoicing | **Broken — reads an empty table** |

Nothing reports on deals, leads, quotations, sales orders, activities or the
sales pipeline. Three of the four tabs describe 13 tickets; the fourth describes
nothing at all.

---

## Plan

**Step 1 — repoint Financial at the CRM tables.** A bug fix, worth doing on its
own and first, exactly as the Dashboard's default-merge fix was. Same four KPI
tiles, real numbers:

- Total Invoiced — sum of `total` on posted invoices
- Total Paid — sum of `amount_paid`, so partials count correctly
- Outstanding — posted invoices where `amount_paid < total`, which is what
  "Pending / Overdue" was reaching for
- Quotes Value — from `quotations`, the table that actually holds them

The table below the tiles moves to `inv_code`, customer, `doc_status`,
`payment_status`, `total`, `amount_paid`, `due_date`. Cancelled invoices are
excluded from the money totals but stay listed, since "we voided 3" is
information.

**Step 2 — a Sales tab. SHIPPED 2026-08-17.** Quotations → sales orders → invoices → payments as a
funnel with conversion rates, plus won/lost. This is the reporting the CRM
direction actually implies and none of it exists today.

**Step 3 — a Pipeline tab. SHIPPED 2026-08-17.** Deals by stage and by rep, win rate, average age,
and leads by source and status. 57 deals and 34 leads with no reporting.

**Step 4 — demote the RMA tabs. SHIPPED 2026-08-17.** Tickets and Technicians stay, but behind the
CRM tabs rather than in front of them, mirroring what the Dashboard now does.
Technicians is worth keeping despite the thin data — it fills up as time entries
get logged, and an empty report is not the same as a wrong one.

**Also fix, cheaply:** relabel "Active Customers" to say what it counts.

---

## Decisions I am taking unless told otherwise

Following the Dashboard precedent, where the sign-off questions went unanswered
and blocking would have stalled the work. Each is cheap to reverse:

- **Cancelled invoices excluded from totals, still listed.** Including them
  would overstate revenue; hiding them would lose the fact they exist.
- **"Outstanding" replaces "Pending / Overdue".** The CRM has no `overdue`
  status; overdue is `due_date < today` on an unpaid invoice, which is a
  different question and belongs in its own column rather than smuggled into a
  KPI label.
- **Step 1 ships alone.** The Financial tab is actively wrong in production, and
  it should not wait behind two new tabs.

---

## Shipped 2026-08-17

**Step 1 — Financial repointed.** Reads `crm_invoices` and `quotations` instead
of the empty `invoices` table. Verified against the database: over the default
30-day range the page and a direct query agree to the cent, and the same holds
for "This year".

**Step 2 — Sales tab.** Quotation → order → invoice funnel, win rate, collected
cash, and a per-rep table with CSV/Excel export.

### The funnel is a cohort, and getting that wrong was nearly shipped

The first version counted documents *raised in the period* at each stage. It
looked plausible and was not: it reported **"Invoices 140% of previous"**, which
is the tell — the stages were never the same documents, so the percentages were
not conversion at all.

It now starts from the quotations raised in the period and follows
`quotation_id` to their orders and `so_id` to their invoices. Crucially the
descendants are taken from the *unfiltered* sets: a quote raised in the last
week of a range whose order lands the following week still converted, and
date-filtering the children would score it as a loss.

That distinction is not theoretical here. For May, **all 11 orders and all 7
invoices descended from May's quotations were raised outside May**. The
date-filtered version would have reported 13 → 0 → 0 — "nothing converted" —
when 11 of 13 quotes did.

Orders and invoices with no originating quotation are real and are counted
separately beneath the funnel rather than folded in.

### Two other things caught in review

The headline win rate used won/(won+lost) while the per-rep column used
won/raised, so the page showed "100%" above a column of "50%"s. Both use the
decided-only denominator now; quotes still out for answer dilute neither.

The standalone counts were computed as (period total − cohort), which mixes a
filtered set with an unfiltered one and goes negative as soon as a cohort
document falls outside the range. They are counted directly.

**Step 3 — Pipeline tab.** Open deals by stage per pipeline, deal win rate,
average age and cycle time, lead conversion by source, lost reasons, and a
per-rep table.

Stages are read from each pipeline's own `stages` array rather than a fixed
list, because the two pipelines genuinely differ — B2C runs new_inquiry →
contacted → quote_sent, B2B adds needs_assessment and negotiation. Merging them
would invent a funnel nobody runs.

Everything is scoped to deals and leads *created* in the period, the same rule
the Sales tab uses, so the date picker means one thing across the page. That
makes the stage breakdown a cohort rather than a live snapshot; the Pipeline
page itself remains the place to see the board as it stands.

### It immediately found a data problem

The tab counts deals whose stage does not exist in their own pipeline rather
than dropping them, and on the full-year range it reports **24 of 42 open deals**
in that state. All 24 are on the **B2C Retail Pipeline** carrying **B2B-only
stages**:

| Stage | Deals | Exists in B2C? |
|---|---|---|
| `new_lead` | 13 | no — B2C starts at `new_inquiry` |
| `negotiation` | 6 | no |
| `needs_assessment` | 5 | no |

51 of 57 deals sit on B2C, so this is 47% of that pipeline. Any view keyed on a
pipeline's own stages has nowhere to put them. Much of this looks like seeded
test data (`nour.ali@test.com`, "Test Lead 17"), so it may be a fixture problem
rather than something users created — but it is worth confirming against the
live board, and worth a migration to remap the stages if real deals are affected.

The report itself is safe either way: those deals are counted and called out
beneath the funnel rather than silently omitted.

**Step 4 — RMA tabs demoted.** Order is now Pipeline · Sales · Financial │
Tickets · Customers · Technicians, with a divider marking the split, and the
page opens on Pipeline instead of Tickets.

Two things that needed care rather than a reorder:

Non-admins only ever get the Tickets tab, so the default is
`isAdminOrManager ? 'pipeline' : 'tickets'` — defaulting everyone to Pipeline
would have handed them a page with no visible tab and no content.

The tab id comes from the URL, so it can name a tab the viewer cannot see: a
manager sharing a `?tab=financial` link with a technician. Every CRM tab is
admin-gated, so an unrecognised or unauthorised id rendered a bare page with no
content and no explanation. It falls back to the first tab the viewer does have.
That was true before this change too — `?tab=financial` has always been
shareable — so it is a pre-existing hole closed in passing, not one introduced
here.

**"Active Customers" relabelled** to "Customers with Tickets". It counts
customers with an RMA ticket in the selected range — 3 of 888 — and the old
label read as though the company had three customers.

## Still to do

- **Investigate the 24 mis-staged deals**, and remap if they are real.
- The Tickets and Technicians tabs still describe 13 tickets and 1 time entry.
  They are honest, just thin; nothing to fix until the data grows.

