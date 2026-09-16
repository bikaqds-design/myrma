# QA Session Report — 2026-08-05

Read-only pass over `WAREHOUSE_R1_TEST_CHECKLIST.md`.
Environment: local dev server (`:5173`) against the **live** Supabase project
`ohkynosgscfygtjxbpxq`, signed in as super_admin.

**Nothing in this session wrote to the database.**

---

## Result

| | Count |
|---|---|
| Checkpoints passed | **17** |
| Checkpoints failed | **1** |
| Partly checked | 1 (§8) |
| Still pending | **~50** (all mutating) |

Automated gates, re-run the same day: **305/305 vitest**, `lint:ci` 0 errors, `build` ✓.

---

## Passed

**Part 1 — Warehouse R1 (5)**
- §1 system warehouses cannot be renamed/deleted (padlock replaces edit/archive)
- §1 rows grouped Sellable / System, all 8 system locations present with SYSTEM badge
- §6 Overview columns exactly Product / Tracking / Available / Reserved / Physical Total / Main / Branches / RMA; the 5 old RMA-stage tabs are gone
- §7 non-catalog products show the "Not in catalog" badge, RMA counts only, no checkbox
- §9 `/inventory?tab=received` falls back to Overview, no blank page

**Part 3 — CRM Leads/Pipeline (12)**
- §A all five rows: four tabs with counts (31 / 20 / 6 / 5), Active excludes converted **and**
  disqualified, Kanban button scoped to All Leads only, `?status=converted&view=kanban` falls
  back to list view, Kanban choice remembered across tab switches
- §B Edit Deal on open deals, absent on won (Reopen Deal instead), Contact field hidden for a
  customer with no contacts
- §C multiple quotations render as independent cards, tab badge shows QT code for one and the
  count for several, converted quotations lock with a View SO link and no Download PDF
- §D Mark Won greyed with an explanatory tooltip when nothing has converted

---

## Failed

**§1 — "Edit a system warehouse's manager/notes" ❌**

Migration `20260764` (line 13) intends manager/notes/description to stay editable on system
rows; the trigger only blocks name/code/`is_system`/delete. But `WarehousesTab.jsx:519`
replaces the entire action cell with a padlock when `is_system`, so the edit modal is
unreachable. The UI is stricter than the DB.

*Suggested fix:* keep the lock affordance, but have it open an edit modal limited to the
metadata fields.

---

## Notable observations

- **Forecast-vs-actual deal value works on production data.** Won deal OPP-16218686 shows
  16,500 = its two converted quotations (500 + 16,000); its 700 draft is correctly excluded.
- **The RMA column is correct, not broken.** It first looked wrong (`test2` showing RMA 0 while
  All Units reported 4) — the 4 units belong to a separate *non-catalog* `test2` row. That
  same coincidence is what proved §7.
- Two cosmetic snags, neither a checklist row: stale "Received" breadcrumb on the `?tab=received`
  fallback, and non-catalog Overview rows are not clickable.

---

## Pending

**§8 — half done.** Physical Total and the RMA Distribution section both render, but the section
could not be seen populated: every `active_rma` unit in this DB belongs to a non-catalog product
name, and those rows do not open the modal. Source reads real system locations via
`getStockSummary()`, so the mechanism is right. Needs an RMA ticket on a **catalog** product.

**~50 mutating checkpoints.** §2–§5 (auto-move on create/edit/bulk, promote to sellable), §6
scrap handling, §9 regression, §B save paths, §C approval/archive/convert, §D value transitions,
plus all of Part 2. Every one writes to production, and the §0 backup row is still ⬜.

Blocked on someone other than the agent:
- **§0** take the Supabase manual backup before any mutating run
- **§5** log in as viewer/technician — requires a second, lower-privilege account
- **§E** Arabic pass, if the language toggle sits behind account settings

**Why the local-DB route was not used:** Docker is not installed, so `npx supabase start` and the
SQL hardening suites (`psql`) could not run. Installing Docker Desktop would restore the safe
path and let the remaining ~50 run against throwaway data.
