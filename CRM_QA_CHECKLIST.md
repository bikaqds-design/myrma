# CRM QA — Sprint 2.5 (Lead Experience) + Sprint 3 (Pipeline Kanban)

Manual click-through run **2026-08-08**, against the local dev server (`:5173`) on the **live**
Supabase project `ohkynosgscfygtjxbpxq`, signed in as `bika.qds@gmail.com` (super_admin).

These were the last two sprints still marked *"BUILT, QA pending"* in
[`MASTER_UPGRADE_PLAN.md`](MASTER_UPGRADE_PLAN.md) after the Warehouse R1, sales-funnel and
Purchase Module runs closed out. Neither had a numbered gate checklist, so the rows below were
derived from each sprint's own build checklist and refinement rounds.

All mutating tests ran against a throwaway lead, **QA Sprint25 Co** (`LD-57459253`), and deals
already created as throwaways during the funnel run. No real lead or deal was altered except
where explicitly noted.

> **Heading contradiction, resolved.** Sprint 2.5's heading said *"BUILT, QA pending"* while its
> own body ended *"Sprint 2.5 is fully closed. All phases built and verified"* and its Round 2
> recorded *"Manual click-through confirmed 2026-06-22."* Rather than trust either, everything
> below was re-verified from scratch — which is how the bulk-status hole turned up.

---

## Sprint 2.5 — Professional Lead Experience

| # | Check | Result |
|---|-------|--------|
| 1 | Lead list → click code → `/leads/:id` detail page | ✅ Loads. `LD-` code, company-name-first header (`QA Sprint25 Co` bold, contact demoted), contact card, status stepper. |
| 2 | Status stepper on the detail page | ✅ Clicking `Nurturing` moved the lead and logged it. |
| 3 | Inline status pill in the list | ✅ Portal-rendered dropdown, all six statuses, current one greyed out. Changed New → Qualified. |
| 4 | Status change auto-logs | ✅ `Status changed from New to Qualified`, then `from Qualified to Nurturing` — correct from/to on both paths. |
| 5 | Automatic field tracking | ✅ Pre-existing entries on another lead show `Updated Company Name: …`, `Updated Full Name: …`. |
| 6 | Schedule Activity composer | ✅ Type list is Call / Meeting / WhatsApp / Email / Task — correctly **excludes** `log`, matching `ACTIVITY_TYPE_SCHEDULABLE`. Datetime, description, assignee, attach. |
| 7 | Planned zone + overdue flag | ✅ Activity dated in the past renders red with an explicit **Overdue** label and inline **✓ Mark Done · ✏ Edit · ✕ Cancel**. |
| 8 | Mark Done → History | ✅ Moves out of Planned into History as `✓ Done`, gaining **Reply** and **Reopen**. |
| 9 | Reopen → Planned | ✅ Returns to the Planned zone with overdue styling intact. |
| 10 | Reschedule (Edit) | ✅ Inline date picker; moving it to 15/09/2026 updated the due date **and cleared the Overdue flag**. |
| 11 | Comment posting | ✅ Posts with avatar initial, author, timestamp. |
| 12 | Threaded replies | ✅ Reply nests under its parent in both the history feed and the comment panel. |
| 13 | Comment ↔ Lead Log sync | ✅ A comment posted in the panel appears in the Lead Log immediately — the documented shared TanStack key. |
| 14 | Lead Notes tab | ✅ Saved, then survived a **full page reload**. |
| 15 | Converted lead is read-only | ✅ List: row checkbox `disabled`, status/source render as plain text. Detail: *"This lead is converted and locked (read-only)"*, **no** status stepper, **no** Convert button. |
| 16 | Disqualify → reopen | ✅ Both directions log correctly (`Nurturing → Disqualified`, then `Disqualified → New`). There is no separate Reopen control — you pick another status on the stepper, which is the same logged path. |
| 17 | **Bulk status change logs** | ❌ **FAILED — BUG #21.** Fixed and re-verified. |

### BUG #21 — bulk status changes were invisible to the audit trail

Sprint 2.5 Phase B states *"Every status change auto-logs a `type:'log'` activity."* The list's
**bulk Change Status** action did not.

`handleBulkStatusChange` called `db.leads.bulkUpdate(ids, { status })`, which issued a single
`UPDATE … IN (…)` and wrote nothing to `activities`. The single-lead paths were fine — both the
inline pill and the detail stepper go through `leads.updateStatus()`, which reads the old status
and logs `status_changed|from|to`.

**How it surfaced.** Lead `LD-79632812` was sitting at status **New** while the newest entry in
its own history read *"Status changed from Qualified to Disqualified"* — a record contradicting
the row it described. Reproduced deliberately: bulk-changing the QA lead New → Contacted moved
the badge but added no history entry at all.

Why it matters beyond tidiness: the lead history is the only place a status decision is
attributable. A bulk change is exactly the case where you most want to know who reclassified
twenty leads and when, and it was the one path that recorded nothing.

**Fix** — `src/api/db/leads.ts`. `bulkUpdate` now takes `actorEmail`, selects `status` alongside
the `converted_at` it already fetched for its guard, and after the update logs one
`status_changed|from|to` per lead whose status actually changed. Leads already on the target
status are skipped, matching `updateStatus()`'s no-op behaviour. Logging is `Promise.allSettled`
and non-fatal — a failed log never rolls back a persisted change. Both call sites pass the actor.

**Verified:** bulk-changing Contacted → Qualified now writes
`Status changed from Contacted to Qualified` with the correct actor and timestamp.

### BUG #22 — the Disqualify dialog's button said "Delete"

Confirming a disqualification showed a dialog reading *"Disqualify … This lead will be marked as
not actionable"* — above a red button labelled **Delete**.

Nothing is deleted; the lead stays and becomes read-only. `ConfirmDialog` defaults
`confirmLabel = 'Delete'` and the disqualify caller never overrode it. A user could reasonably
have cancelled a routine action out of fear, or clicked it believing the record would be removed.

**Fix** — the disqualify dialog now passes `confirmLabel: t('leads.disqualify')` (present in both
locales), and `LeadDetails.jsx` forwards `confirmLabel` through to `ConfirmDialog`, leaving the
component's `'Delete'` default intact for genuine deletions. **Verified:** the button now reads
**Disqualify**.

---

## Sprint 3 — Pipeline Kanban

| # | Check | Result |
|---|-------|--------|
| 18 | Board renders by stage | ✅ 7 droppable columns (`new_lead`, `contacted`, `needs_assessment`, `quote_sent`, `negotiation`, `won`, `lost`), each with deal count and summed value in the header. |
| 19 | Deal card anatomy | ✅ Title, `OPP-` code, customer, value, date, coloured rep-initial avatar. Won cards tinted green; empty Lost column shows a red dashed placeholder. |
| 20 | Drag between stages | ✅ Driven through hello-pangea's keyboard sensor (same `onDragEnd` as mouse). `new_lead` 4→3, `contacted` 1→2. |
| 21 | Drag **persists** | ✅ Survived a full reload — not just optimistic UI. |
| 22 | Drop on Won → probability 100 | ✅ Deal detail shows **100%** after the drop, enforcing the Odoo rule in `markWon()`. |
| 23 | Drop on Lost → reason required | ✅ **Mark Lost** modal opens, card does **not** move yet, submit is `disabled` while the reason is empty, enables once filled, then the card lands in `lost`. |
| 24 | Won/Lost cards are not draggable | ✅ 7 cards but only 5 drag handles — terminal columns are `isDragDisabled`. Correct: you leave a closed deal via **Reopen Deal**, not by dragging. |
| 25 | Reopen Deal | ✅ Modal asks which stage to return to and correctly offers **only open stages** (Won/Lost excluded). Read-only banner clears afterwards. |
| 26 | Closed deals are read-only | ✅ A Won deal shows *"This deal is closed (read-only)"* and hides the inline-edit affordances. |
| 27 | Deal stage changes auto-log | ✅ History shows `Deal marked as Won` and `Stage changed from New Deals to Contacted`. |
| 28 | List view | ✅ Sortable columns, `OPP-` codes, StagePin dropdown per row, Won rendered green, footer total. |
| 29 | Graph view | ✅ Bar chart (Count by Stage), measure/group-by selectors, chart-type toggle, KPI tiles — 7 deals · 27,573.9 EGP · Won 2 (29%) · 16,500 EGP, all reconciling with the changes made during this run. |
| 30 | Pivot view | ✅ Row/column dimension + measure selectors; totals add up (2+1+1+2+1 = 7). |
| 31 | Activity view | ✅ Deals × activity-type matrix renders, no errors. |
| 32 | Bulk actions (list) | ✅ Checkbox selection, `1 selected` bar, Change Stage (open stages only), Delete, Clear. |
| 33 | Export dropdown | ✅ **Export All (7 deals)** and **Export Selected (1 deal)**; *Export Filtered* correctly absent with no filter active. |
| 34 | Inline editing — affordances | ✅ All six documented fields carry `title="Click to edit"`: Title, Customer, Value, Expected Close Date, Probability, Assigned Rep. |
| 35 | Inline editing — title | ✅ Click → input → Enter → **persisted across reload**. |
| 36 | Inline editing — value | ✅ Numeric input; 4,200 EGP saved and the list-view footer total moved 27,573.9 → 31,773.9 EGP to match. |
| 37 | Deal tabs | ✅ Deal Log · Schedule Activity · Quotation · Deal Notes. |
| 38 | Deal Comment Panel ↔ Deal Log sync | ✅ One posted comment renders in both, confirming the shared query key. |
| 39 | Search + filters | ✅ Persistent search bar and Filters panel present on every view. |
| 40 | Touch/mobile drag | ⬜ **Not tested** — needs a real touch device. Still open, as the sprint's own build checklist already states. |

**No functional defects found in Sprint 3.** Everything the sprint claims to have built, it built.

---

## Documentation drift found (no code impact)

- **Deal codes are `OPP-`, not `QT-`.** Sprint 3 Round 4 records the rename `DL-` → `QT-`
  (`20260710_crm_deal_code_rename.sql`). A later rename to `OPP-` clearly happened but was never
  written down. Live data and the UI both use `OPP-`.
- **The third deal tab is "Quotation", not "Product Lines"** as Round 3 describes.

## Minor observations, deliberately not changed

- **Comment count badge counts threads, not messages** — shows `1` for a parent plus its reply.
  Defensible either way; flagged rather than "fixed" on a guess.
- **Probability stays 100% after reopening a Won deal.** Odoo behaves the same way, and the plan
  does not specify a reset, so this is left alone.

---

---

## CRM Leads/Pipeline round (2026-08-04/05) — run 2026-08-09

The round listed in the Track A summary that closes 8 findings from the 2026-07-05 manual test.
It was left pending after the Sprint 2.5/3 pass because that run only touched two of its items.
All eight are now covered.

| # | Item | Result |
|---|------|--------|
| 41 | Leads Kanban scoped to the All tab | ✅ The Kanban toggle renders **only** on All — on Active/Converted/Disqualified there is a List button and nothing else. The board shows **34 cards across 7 status columns**, matching the "All Leads 34" count exactly. |
| 42 | Inline full-name edit — the `null` bug | ✅ Fixed. The editor opens pre-filled with the real value (not the string `null`), and saving re-renders immediately with no refresh needed and no disappearing field. |
| 43 | Deal edit modal restored | ✅ `handleOpenEdit` has a caller again (`DealDetail.jsx:829`) and **Edit Deal** renders on open deals. It is hidden on closed ones, which is why it was absent when this deal was Won — `canEditDeal`, not a missing entry point. |
| 44 | Customer / contact / pipeline editable + `movePipeline()` | ✅ Modal carries Title, Customer (type-ahead, "Customer selected" confirmation), **Pipeline**, Value, Close Date, Probability slider, Rep and Notes. Switching **B2B → B2C** dynamically revealed a **Stage** select defaulting to B2C's first stage; saving moved the deal off the B2B board and onto B2C at `new_inquiry`. ⚠️ No separate **Contact** field appeared — the customer used has no contacts on file, so the field is presumably conditional. **Not proven either way.** |
| 45 | A deal holds many quotations, each independent | ✅ `QT-28966054` and `QT-54535244` coexist on one deal and carry **independent statuses** — at one point one was Draft while the other was Approved, and later one Converted while the other stayed Approved. |
| 46 | Deal value: forecast while open / actual once closed | ✅ **Both halves proven.** Open: value showed **4,250 EGP** labelled *"(Calculated from product lines)"* = 2,750 (accepted) + 1,500 (converted), overriding a manually-typed 4,200. On **Mark Won** it changed to **1,500 EGP** — the accepted-but-never-converted 2,750 correctly dropped out, leaving only what became a Sales Order. Exactly `dealValueFor()`'s contract. |
| 47 | Quotations lock at `accepted` | ✅ Approved quotation offers Download PDF / Archive / Convert to Sales Order and **no Edit**; the Draft alongside it still has Edit. |
| 48 | Cancel replaced by Archive | ✅ **Archive** on every quotation card in every state; no Cancel anywhere. |

### Two rules confirmed that are not in the round's list

Both look like bugs until you read the code, so they are recorded here to save the next person the
detour:

- **`canMarkDealWon()`** — a deal carrying quotations cannot be won until at least one is
  **converted to a Sales Order**, otherwise its actual value would be 0 and the win would not be
  backed by a real order. Mark Won sat disabled with two approved quotations and enabled the moment
  one was converted. Deals with no quotations at all are unaffected, which is why winning worked
  earlier in the run before any quotation existed.
- **Free-form line guard** — `handleConvertToSO` refuses a quotation containing lines with no
  `product_id`. A quotation whose product was typed as free text would not convert (no network call
  at all); re-pointing the same line at the catalog product `test 3` converted immediately to
  **`SO-24913679`**. Correct per the Sprint 6 rule that quotations may be free-form but SO/Invoice
  lines must resolve to a catalog product.

### BUG #23 — "+ + Add Line" rendered a doubled plus

The quotation editor's add-line control read **`+ + Add Line`**. `salesDocs.addLine` already
contains a `+` (unlike `pipeline.addLine` and `salesDocuments.addLine`, which do not), and
`DealDetail.jsx:791` prefixed another.

**Fix:** dropped the literal `+` from the JSX, leaving the string's own, so the convention now
matches the other two namespaces. Single call site, no other consumer. **Verified:** renders
`+ Add Line`.

---

## Gate

`npx vitest run` → **392/392 (13 files)** · `npm run lint` → **0 errors** ·
`npm run build` → **clean**.

## Outcome

Sprints 2.5 and 3 move from *BUILT, QA pending* to **VERIFIED**, and the CRM Leads/Pipeline round
is now covered too. Three defects found and fixed across the two runs (**#21** bulk status changes
not logged, **#22** Disqualify button labelled Delete, **#23** doubled plus), all re-verified live.

Two items remain genuinely open, neither a regression:

- **Row 40 — touch/mobile drag.** Needs a real device; already acknowledged in the sprint's own
  build checklist.
- **Row 44 — the Contact field.** Never appeared, because the test customer has no contacts. Worth
  one minute on a customer that does before calling it done.
