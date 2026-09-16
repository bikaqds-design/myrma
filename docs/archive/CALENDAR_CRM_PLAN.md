# Calendar — CRM rebuild

Audit 2026-08-17. `src/pages/TechCalendar.jsx`, 396 lines.

---

## What it is today

A weekly grid of **RMA tickets only**, grouped by technician. It loads exactly
one thing:

```js
queryFn: () => db.rmaTickets.list()
```

13 tickets, all with a due date and a technician. The page is titled *"Tech
Calendar — Weekly view of tickets by technician and due date"*.

## The problem: it is empty most weeks, and the CRM's dated work is missing

The current week (Aug 17–23) renders seven dashes and nothing else. That is not
a bug — those 13 tickets are spread across four months:

| Month | Tickets due |
|---|---|
| May 2026 | 1 |
| Jun 2026 | 8 |
| Jul 2026 | 1 |
| Aug 2026 | 3 |

Meanwhile the CRM has dated work that never appears here. Being precise, because
the headline number is misleading: there are **176 activities, but only 52 carry
a due date, and only 6 of those are still open.** The rest are `log` (115) and
completed items — audit trail, not schedule.

| Open dated activity | Count |
|---|---|
| `approval` awaiting action | 4 |
| `call` scheduled | 2 |
| **overdue right now** | **5** |

So this is not "the calendar is ignoring 176 things". It is ignoring **6 things
that someone is supposed to act on, 5 of which are already late** — and the
Dashboard already counts exactly these as *"Overdue Follow-Ups: 5"*. The one
page in the app whose entire job is "what is due and when" is the one place they
do not appear.

## The API for it already exists and nothing calls it from here

`db.activities.listAllPlanned()` returns precisely the right set — not
completed, not a `log`, has a due date, ordered by date. Only the Activities
page uses it. Same pattern as the Dashboard's hidden CRM widgets and the
Reports Financial tab: the capability is built, the page just does not reach for
it.

---

## Plan

1. **Load planned activities alongside tickets** via `listAllPlanned()`, and
   render both on the week grid, visually distinguished so a follow-up is not
   mistaken for a repair.
2. **Group rows by assignee, not technician.** Activities carry `assigned_rep`,
   tickets carry `assigned_technician`; the row is "a person's week" either way.
   The current filter is labelled and typed as technicians only.
3. **Retitle.** "Tech Calendar / Weekly view of tickets by technician" states the
   old scope in the heading.
4. **Keep the unscheduled-tickets panel**, unchanged. Deliberately *not* adding
   unscheduled activities: 124 activities have no due date and most are logs,
   so that list would be noise.

## Decisions I am taking unless told otherwise

- **Only open, non-log activities appear.** Showing all 52 dated ones would put
  46 completed items on the grid. `listAllPlanned()` already encodes this rule,
  so the calendar and the Activities page agree on what "planned" means.
- **Overdue items are marked, not moved.** An overdue approval stays on its due
  date rather than being pulled to today, so the week reads as a record of what
  was due when. The existing ticket cards already do this.
- **No new entity gets a calendar row.** Quotation validity dates, invoice due
  dates and SO delivery dates are all dated and all arguably schedulable. Adding
  them is a bigger question about what this page is for, and it is worth asking
  before the grid fills with things nobody planned to work on.

---

## Shipped 2026-08-17

All four planned items landed: planned activities load via `listAllPlanned()` and
render on the grid as left-ruled cards distinct from ticket cards, the assignee
list and filter span both `assigned_technician` and `assigned_rep`, the page is
retitled *"Calendar — Weekly view of tickets and planned follow-ups by due
date"*, and the unscheduled-tickets panel is untouched.

Verified against the database: the week of Aug 3–9 shows exactly the three open
approvals the query returns (two for nour.ali@test.com on Aug 5, one unassigned
on Aug 6), all correctly marked overdue. Filtering to nour.ali drops the
unassigned one and keeps two, as it should.

### The audit found a separate, pre-existing bug

`App.jsx` passed `userRole` / `userEmail` / `userPermissions`; the component
destructures `currentUserRole` / `currentUserEmail` / `currentUserPermissions`.
Every one of them arrived as `undefined`, with two consequences:

- `isAdminOrManager` was always false, so **the assignee filter never rendered
  for anyone** — that is why the page had no filter control at all.
- `effectiveTech` fell back to an undefined email, and the filter reads a falsy
  value as "no filter", so **every user saw every technician's tickets** rather
  than only their own. The code's intent, visible in
  `effectiveTech = isAdminOrManager ? selectedTech : currentUserEmail`, is that a
  non-admin sees their own work.

Fixed by passing the names the component actually declares. A scan of every
lazy-loaded page in `App.jsx` for the same class of mismatch found no others.

Worth noting the failure mode: nothing threw, nothing logged, and the page
looked fine. It reads as "this calendar has no filter" rather than as a defect,
which is why it survived.

## Still open

- **Should other dated records appear here?** Quotation validity, invoice due
  dates and SO delivery dates are all dated and arguably schedulable. That is a
  question about what this page is for, and the grid should not fill with things
  nobody planned to work on without a decision.
- The calendar is still sparse — 13 tickets and 6 open activities across several
  months — so most weeks are legitimately empty. That is the data, not the page.

