# Dashboard — CRM rebuild

Audit 2026-08-16, ahead of the rebuild. `src/pages/Dashboard.jsx`, 956 lines,
plus `DashboardCharts.jsx` lazy-loaded.

**Nothing has been changed yet.** This is the proposal to sign off before building.

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
