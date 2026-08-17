# Control Panel — CRM rebuild

Audit 2026-08-17. `src/pages/ControlPanel.jsx` (142 lines, a router),
`src/pages/cp/_registry.jsx` (20 features in 6 groups), `src/pages/cp/HomeView.jsx`.

---

## Finding 1: there is no way to configure the CRM

Twenty admin features. Every one of them is RMA or system-level:

| Group | Features |
|---|---|
| Ticket Management | RMA Configuration, Custom Fields, PDF Layout |
| Users & Communication | User Management, Announcements, Knowledge Base, Send Alert |
| Appearance & Notifications | Appearance, Email & Notifications |
| Automation & Integration | SLA Policies, Automation Rules, Webhooks, Email & API |
| WhatsApp & Messaging | Settings, Templates, Logs, Test Center |
| Data & System | Audit Log, Data Cleanup, Backup & Restore |

Nothing configures deals, leads, pipelines, stages, quotations or sales orders.
The business runs 57 deals, 34 leads, 38 quotations, 31 sales orders and 27
invoices, and an admin cannot change a single thing about how any of it works.

The sharpest case is pipelines. `db.pipelines.update()` exists, validates its
input, and is admin-gated at the RLS layer:

```ts
// admin-only at the RLS layer — write attempts from non-admin roles fail server-side
async update(id, pipeline) {
  if (pipeline.stages) validateStages(pipeline.stages)
  ...
}
```

**It has zero call sites.** Six pages call `pipelines.list()`; nothing calls
`update()`. The only way to rename a stage, reorder a board, or change a
probability today is to write SQL against production.

This is the fourth page in a row with the same shape — the Dashboard's hidden
CRM widgets, the Reports Financial tab, the Calendar's `listAllPlanned()`, and
now this. The capability is built and nothing reaches for it.

## Finding 2: the missing editor has already cost real data

The **B2C Retail Pipeline** defines five stages: `new_inquiry` → `contacted` →
`quote_sent` → `won` → `lost`. Its 51 deals actually sit here:

| Stage | Deals | Defined on this pipeline? |
|---|---|---|
| `won` | 11 | yes |
| `contacted` | 7 | yes |
| `quote_sent` | 6 | yes |
| `lost` | 3 | yes |
| `new_lead` | 13 | **no** — B2B only |
| `negotiation` | 6 | **no** — B2B only |
| `needs_assessment` | 5 | **no** — B2B only |
| `new_inquiry` | **0** | yes — the pipeline's own entry stage, unused |

**24 of 51 deals sit in stages their pipeline does not define**, and the entry
stage the pipeline does define holds nothing. The Reports Pipeline tab surfaced
this. The Control Panel is where an admin would go to fix it, and there is
nothing there to fix it with.

I still cannot say whether this is seeded fixture data or real mis-filing —
that needs a decision from the business. But the repair tool is missing either
way, and an admin currently has no way to even *see* the problem.

## Finding 3: the Control Panel home is a second Dashboard, and an RMA one

The landing view shows four stat tiles — Total Tickets, Overdue, Customers,
System Users — and a row breaking 13 tickets down by status. Three of the four
tiles and the entire status row describe RMA tickets.

That duplicates the Dashboard, and now contradicts it: the Dashboard leads with
CRM since the rebuild, while the admin console still opens on ticket counts. An
admin console's home should describe **what the admin governs** — accounts,
roles, and whether the configuration is sound — not re-report operational
numbers that have a better home one page away.

---

## Plan

**Step 1 — a Pipelines & Stages editor**, in a new CRM group, wired to the
`update()` that already exists. Rename stages, reorder them, set default
probability, add a stage, remove an empty one, and activate/deactivate a
pipeline.

**Step 2 — make it show finding 2.** Each stage row carries its live deal count,
and any stage value held by deals but *not* defined on the pipeline is listed
separately as a repair task, with a "move these deals to…" action built on the
existing `db.deals.bulkMoveStage()`, which already validates the target stage
and resets terminal won/lost fields. This turns an invisible data problem into
something an admin sees on opening the page.

**Step 3 — rebuild the home stats** around what an admin governs: users,
customers, open deals and pipeline value, open tickets. The ticket-status
breakdown row is replaced by a configuration-health row that reports active
pipelines, stages defined, and deals sitting in undefined stages.

## Decisions I am taking unless told otherwise

- **A stage `id` is immutable once it exists.** Deals store the stage id, so
  editing it is precisely the bug we already have. The display `name` is
  editable; new stages get an id derived from their name and checked for
  uniqueness.
- **A stage holding deals cannot be deleted.** The count is shown next to the
  delete control and the control is disabled with the reason given, rather than
  the deletion succeeding and orphaning the deals.
- **Won and lost stages cannot be removed or unmarked.** `validateStages()`
  already requires exactly one of each and would reject the write; the UI
  should not offer an action the API will refuse.
- **Lead sources, activity types and deal statuses stay in code.** They are TS
  constants that other code switches on, so making them admin-editable needs a
  migration and a data-integrity story of its own. Out of scope here; worth
  raising separately.
