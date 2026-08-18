# Permissions & roles — CRM rebuild

Audit 2026-08-18. `src/lib/permissions.ts` (340 lines), route guards in
`src/App.jsx`, nav filtering in the same file.

---

## Finding 1: five nav items share one permission

`deals.view` gates **Pipeline, Activities, Sales, Accounting and Purchasing**.
One switch, five modules:

| Route | Nav requires | Route guard |
|---|---|---|
| `/pipeline` | `deals.view` | none |
| `/activities` | `deals.view` | `deals.view` |
| `/sales` | `deals.view` | `deals.view` |
| `/accounting` | `deals.view` | `deals.view` |
| `/purchasing` | `deals.view` | `deals.view` |

It runs deeper than visibility. Creating a purchase order checks
`deals.create`:

```js
// src/pages/Purchasing/index.jsx
const canCreate = canDo(currentUserRole, currentUserPermissions, 'deals', 'create')
```

So purchasing — vendors, purchase orders, vendor invoices, vendor payments, a
function with no relationship to the sales pipeline — is controlled entirely by
a CRM deals toggle. There is no way to give a bookkeeper the Accounting page
without also giving them the deal pipeline, and no way to take a sales rep off
purchasing without removing their deals.

## Finding 2: three modules have no permission at all

The matrix has 16 modules: activities, calendar, contacts, customers,
dashboard, deals, inventory, invoices, leads, parts, pipelines, products,
reports, rma_tickets, time_tracking, user_management.

**sales, accounting and purchasing are not among them.** They are three of the
app's fifteen routes and they carry the money — quotations, sales orders,
invoices, credit notes, payments, POs, vendor invoices, vendor payments. There
is nothing to switch on or off even if you wanted to, which is why they had to
borrow `deals`.

Meanwhile `invoices` is still in the matrix. It refers to the pre-CRM
`invoices` table that holds 0 rows — the same dead table the Reports Financial
tab was reading before it was repointed. Its only remaining mention anywhere in
the codebase is one assertion in `src/test/permissions.test.js`.

## Finding 3: hiding a nav link is not a guard

Only five routes have a route-level check: `/activities`, `/sales`,
`/accounting`, `/purchasing` (all on `deals.view`) and `/control-panel` (on
role). The rest render unconditionally:

```jsx
<Route path="/products" element={<Products ... />} />          // no guard
<Route path="/purchasing" element={ canDo(...) ? <Purchasing/> : ... } />
```

Dashboard, products, customers, leads, pipeline, rma-tickets, inventory,
calendar and reports are protected only by the nav filter. The link is hidden;
the URL still works. Pages do run their own `canDo` checks for actions, so this
is not a free-for-all — but "can this role open this page" is currently
answered by whether they can find the link.

## Finding 4: `pipelines` has one key, and it is `view`

```ts
pipelines: { view: true },
```

The Control Panel now ships a Pipelines & Stages editor that renames stages,
reorders boards and re-stages deals in bulk. It is admin-only by route, so
nothing is exposed today, but the permission model has no vocabulary for it.

---

## Proposed module set

**Add three:**

| Module | Actions | Covers |
|---|---|---|
| `sales` | view, create, edit, delete, post, cancel, export | quotations, sales orders, invoices, credit notes |
| `accounting` | view, record_payment, reverse_payment, export | customer & vendor ledgers, payments |
| `purchasing` | view, create, edit, approve, receive, cancel, manage_vendors, export | POs, vendor invoices, vendors |

The verbs are the ones the documents already have. `post` and `cancel` exist on
invoices; `approve` and `receive` exist on POs. This is naming what the app
does, not inventing a scheme.

**Extend one:** `pipelines` gains `manage`, and the Control Panel feature moves
from a pure role check to that permission.

**Retire one:** `invoices`, superseded by `sales`. `resolvePermissions()`
already preserves unknown stored sections, so an existing row keeping a stale
`invoices` key is harmless.

**Guard every route**, so a hidden link and a blocked page are the same
decision rather than two.

## Decisions I am taking unless told otherwise

- **`sales_rep` gets `sales` but not `accounting` or `purchasing`.** A rep
  raising a quotation and converting it to an order is the job; recording
  payments against the ledger is not.
- **`manager` gets all three**, matching its current breadth.
- **`technician` and `viewer` get none of the three.** Neither has `deals`
  today, so neither can currently reach Sales, Accounting or Purchasing — this
  keeps that true rather than changing it by accident.
- **Retiring `invoices` does not migrate stored rows.** Nothing reads it, and
  rewriting every `user_roles.permissions` row to drop a key that has no effect
  is more risk than leaving it.

---

## Shipped 2026-08-18

**The matrix.** `sales`, `accounting` and `purchasing` are real modules with
the verbs the documents already use. `pipelines` gained `manage`. The dead
`invoices` module is gone.

| | manager | sales_rep | technician | viewer |
|---|---|---|---|---|
| `sales` | view create edit **post cancel** export | view create edit export | — | — |
| `accounting` | view record_payment reverse_payment export | — | — | — |
| `purchasing` | view create edit receive cancel manage_vendors export | — | — | — |
| `purchasing.approve` | **false** | false | false | false |
| `pipelines.manage` | false | false | false | false |

Two permissions no role default grants: `purchasing.approve` and
`pipelines.manage`. Both land with admin/super_admin, who bypass `canDo`. That
is the separation of duties — a manager raises and receives a purchase order
but does not approve their own spend.

**Route guards.** One `RouteGuard` derives the requirement from a prefix map
rather than nine hand-edited routes, so a route and its nav entry cannot
disagree about who may see a page — and a route added later is covered by
default rather than by remembering. Prefix matching covers the detail routes;
longest match wins.

**Approval by document type.** `canApprove` was one hardcoded role list,
`['manager','admin','super_admin']`, covering quotations, invoices *and*
purchase orders alike. Sales documents now route to `sales.post`, purchase
documents to `purchasing.approve`.

**Accounting had no checks at all.** Anyone who could reach the page could
record and reverse payments, and reaching it needed only `deals.view`. It now
receives the role and gates all four actions. It was not even being passed the
current user's role.

### Verified with the app's own preview-as-user

| Role | Nav | Direct URL |
|---|---|---|
| `sales_rep` | Sales present, **Accounting and Purchasing gone** | `/accounting`, `/purchasing`, `/reports`, `/inventory`, `/rma-tickets` all redirect; `/sales`, `/pipeline`, `/products` open |
| `manager` | all three present | — |
| `technician` | none of the three | all three redirect; `/rma-tickets`, `/inventory` open |

Action level: a rep sees "+ New" in Sales but **zero approve buttons across 8
approval requests**. A manager gets approve on quotation and sales-order
requests and **not** on a purchase order — tested against a throwaway PO
approval created for the purpose, which super_admin could then approve, and
which was deleted afterwards (activities back to 171).

434 unit tests, up from 408, including one that asserts a stored row still
carrying the retired `invoices` key resolves rather than throwing.

## Still open

- **RLS is the real boundary.** Everything above is client-side: it decides
  what renders, not what the database will serve. The server-side policies were
  not part of this change and should be checked against the new matrix before
  anyone relies on it for confidentiality rather than tidiness.
- Roles remain six. Anyone needing a narrower cut — a bookkeeper with only
  `accounting.view` — gets it as a per-user override, which
  `user_roles.permissions` already supports and `resolvePermissions()` merges
  over the defaults.

