# Dashboard — CRM rebuild

Audit 2026-08-16, ahead of the rebuild. `src/pages/Dashboard.jsx`, 956 lines,
plus `DashboardCharts.jsx` lazy-loaded.

**Status: the default-merge fix and the layout reorder have shipped** (2026-08-16).
What remains is listed under "Still to do" at the bottom.

---

## The finding that changes the scope

The CRM dashboard **is already built**. `crm_kpi`, `pipeline_by_stage`,
`rep_leaderboard` and `overdue_followups` all exist in `WIDGET_CATALOG`, are
implemented, translated into both locales, and query real tables. They render
nothing because they are switched off by a stale default.

`AppearanceContext.jsx` carries a hardcoded `dashboardWidgets` array that lists
ten widget ids. It was written before the CRM widgets existed and was never
updated, so it silently omits all four of them, plus `monthly_trend` and
`technician_performance`. The Dashboard reads:

```js
safeStorage.get(storageKey, dashboardWidgets || WIDGET_CATALOG.map((w) => w.id))
```

With no saved preference — which is the state on this account right now — the
fallback is that ten-item list, never the full catalog. Six of sixteen widgets
are unreachable without the user finding the settings page and ticking them.

**This is the same trap as the permissions bug already fixed in
`permissions.ts`:** a stored or hardcoded snapshot standing in for a live set, so
anything added later is invisible. The fix there was to merge defaults under
stored values rather than substitute them. The same shape applies here.

### A second, related defect

`AccountSettings.jsx:184` reads the *same* storage key with a *different*
fallback:

```js
safeStorage.get(`dashboard_widgets_${currentUser?.email}`, WIDGET_CATALOG.map((w) => w.id))
```

All sixteen. So with no saved preference the settings page shows every widget
ticked while the dashboard renders ten. The two disagree about what is on, and
the settings page is the one telling the truth about the catalog.

---

## What the dashboard currently spends its space on

Live row counts, today:

| Data | Rows |
|---|---|
| Customers | 888 |
| Activities | 176 |
| Deals | 57 (42 open) |
| Quotations | 38 |
| Leads | 34 |
| Invoices | 27 |
| **RMA tickets** | **13** |

Twelve of the sixteen widgets are about those 13 tickets. Four are about
everything else, and all four are dark.

| Widget | Subject | Verdict |
|---|---|---|
| `stat_tickets` | Ticket KPIs | Demote — keep as one compact tile, not the hero |
| `stat_inventory` | Inventory snapshot | Keep, secondary |
| `sla_health` | Ticket SLA gauge | Demote |
| `resolution_rate` | Ticket close rate gauge | Demote |
| `recent_tickets` | Last 10 tickets | Keep, secondary |
| `overdue_tickets` | Tickets past due | Keep — genuinely actionable |
| `weekly_trend` | 7-day ticket line | Merge with monthly into one range-aware chart |
| `monthly_trend` | 30-day ticket bars | Merge as above |
| `status_distribution` | Ticket status donut | Cut — three tickets in three statuses is not a distribution |
| `priority_distribution` | Ticket priority donut | Cut — same |
| `technician_performance` | Top 5 technicians | Keep, but it is off by default today |
| `top_issues` | Common product issues | Keep, secondary |
| `crm_kpi` | Pipeline value, deals won, leads | **Promote to hero** |
| `pipeline_by_stage` | Open deals per stage | **Promote** |
| `rep_leaderboard` | Top reps this month | **Promote** |
| `overdue_followups` | Activities past due | **Promote — 176 activities and no visibility** |

Two donuts over three tickets is the clearest symptom: the layout was designed
for an RMA workload that this database does not have.

---

## Proposed layout

Top to bottom, desktop. Everything stays user-toggleable — this changes the
default order and what is on, not the ability to customise.

1. **Hero KPI row** — Open pipeline value · Deals won this month · New leads this
   month · Overdue follow-ups. All four already computed.
2. **Pipeline by stage** (wide) — 42 open deals across stages, the single most
   useful CRM view and already built.
3. **Needs attention** (half) — overdue follow-ups and overdue tickets in one
   column, because both are "someone must act today".
4. **Rep leaderboard** (half) — deals won this month.
5. **Trend** (wide) — one chart with the existing Today/7d/30d/All selector,
   switched from ticket count to deals created and won. Replaces the two
   separate ticket trend charts.
6. **Sales & AR strip** — quotations outstanding, invoices unpaid, AR total.
   **New**; the data exists in `crm_invoices` and the AR aging RPC that
   Accounting already uses.
7. **RMA block, collapsed by default** — ticket KPIs, overdue tickets, recent
   tickets, SLA, top issues, inventory snapshot. Still one click away, no longer
   the front page.

### What this needs built vs re-enabled

- **Re-enable, no new code:** items 1, 2, 4 and the follow-ups half of 3.
- **Modify:** the trend chart's data source; the RMA widgets into a collapsed
  section.
- **New:** the Sales & AR strip (item 6), and the widget-default merge fix.
- **Cut:** the two ticket donuts.

The default-merge fix is worth doing first and separately — it is small, it is a
real bug on its own, and it makes the existing CRM widgets visible immediately,
which is most of the perceived improvement before any rebuild lands.

---

## Open questions for sign-off

1. Is the **Sales & AR strip** wanted on the dashboard, or does that belong to
   Accounting?
2. Should the **RMA block** collapse by default, or stay expanded below the CRM
   content? Collapsing is the stronger statement about direction; expanding is
   safer if the team still works tickets daily.
3. **Rep leaderboard** ranks by deals won this month. Won *value* is usually the
   more honest measure — switch it, or show both?
4. Once Dashboard lands, the same treatment is owed to **Reports, Calendar and
   Control Panel**. Reports is the biggest of the three.

---

## Shipped 2026-08-16

**Default-merge fix.** Preferences now store what is *off*, so anything the
catalog gains is visible by default and the class of bug cannot recur. The
catalog moved to `src/lib/dashboardWidgets.js`; 16 unit tests cover the resolver.
The six hidden widgets — the whole CRM section among them — appear for the first
time.

**Layout reorder.** CRM now opens the page: the four KPI tiles, pipeline by
stage, rep leaderboard and overdue follow-ups. Everything RMA sits below a
collapsed **RMA & Service** disclosure, remembered per browser. The two ticket
donuts default off via a new `defaultOff` flag rather than being deleted —
someone with real ticket volume can switch them back on, and an explicit
preference outranks the default in both directions.

The page heading was still `dashboard.rmaOperations` ("RMA Operations"), which
contradicted the whole change. It reads `dashboard.title` now.

### Decisions taken without sign-off

Asked, not answered, so these were called rather than left blocking. Each is
cheap to reverse:

- **RMA collapsed by default.** The stronger statement about direction, and the
  disclosure makes it one click. Flip by changing the `dashboard_rma_open`
  default in `Dashboard.jsx`.
- **Donuts off, not deleted.** Deleting a widget people may be using is not a
  layout call to make for them.
- **Rep leaderboard left ranking by deals won.** It already shows won value
  beneath the count, so the honest measure is on screen either way. Changing the
  *sort* is a one-line change if wanted.
- **Sales & AR strip not built.** It is new content rather than layout, and it
  is the one item that needs a real answer — see below.

## Still to do

1. **Sales & AR strip** — quotations outstanding, invoices unpaid, AR total. The
   data exists (`crm_invoices`, plus the AR aging RPC Accounting already calls).
   Needs a decision on whether it belongs here or stays in Accounting.
2. **Trend chart** — still plots ticket creation. The plan called for merging the
   weekly and monthly charts into one range-aware chart showing deals created and
   won, driven by the existing Today/7d/30d/All selector.
3. **Reports, Calendar, Control Panel** — the same CRM treatment. Reports is the
   largest.

Pre-existing accessibility advisories on this page, unrelated to the rebuild and
not addressed: muted-token contrast at 3.48:1 and 3.75:1 against the dark
surfaces, and an invalid heading order (the sidebar brand `h1` above the page
`h1`).

