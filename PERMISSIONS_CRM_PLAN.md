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

---

## Ownership scoping — a rep sees only their own work (2026-08-18)

Reported: a sales rep can see other reps' work.

### What the repo says, and why that is not the answer

Every read policy in `supabase/migrations/` already scopes correctly. I raised
two false alarms getting there and both were the same mistake — reading the
first definition rather than the last:

- `deals_read` compares `assigned_rep = auth.uid()`, a text column against a
  uuid, in `20260622_crm_deals.sql`. **Superseded** by
  `20260628_crm_assigned_rep_use_email.sql`, which uses
  `rma_current_user_email()`.
- `rma_is_staff()` omits `sales_rep` in `20260526_enable_rls.sql`, which would
  give a rep no sales documents at all. **Superseded** by
  `20260618_crm_add_sales_rep_role.sql`, which adds the role.

So on paper deals, leads, activities, quotations, sales orders, invoices and
credit notes are all scoped. Since the symptom is real, **the live database
must differ from these files** — which is expected here, because migrations are
applied by hand and the CLI's remote history is empty.

The repo cannot answer this. `supabase/manual/20260818_rls_diagnostic.sql` is
read-only and asks the three questions that can: is RLS actually *enabled* per
table (a table with policies but RLS off ignores them entirely, which fits the
symptom exactly), what do the live SELECT policies say, and are the helper
functions the current versions.

### What shipped meanwhile: the app now knows what "mine" means

RLS is the boundary. But the app had no concept of ownership at all, so even
with correct policies it would build filters, tab badges and counts as if the
whole company's data were in scope. Four pages now filter to the signed-in
rep's own records — Sales, Pipeline, Leads and Activities — via a single
`ownershipScope()` helper, driven by a new `view_all` action on `deals`,
`leads`, `activities` and `sales` (true for manager, false for sales_rep),
mirroring the `view_all` / `view_assigned` split `rma_tickets` already had.

**This is not a security boundary and is not presented as one.** Anything it
hides is still reachable by a direct API call; only RLS stops that.

`ownershipScope()` fails closed. A restricted user whose email is unknown gets
a sentinel that cannot match any stored value, so the page shows nothing —
returning `null` there would have meant "no filter" at every call site and
handed them everything. The first version did exactly that, and the test I
wrote asserted the broken behaviour while its comment described the correct
one.

### It exposed a real defect in preview-as-user

Previewing a sales rep showed **the admin's own documents**, because preview
swapped role and permissions but not identity — `currentUserEmail` stayed the
real user. The banner even documented it: *"data still loads as you"*.

That made the feature useless for the one thing it is now most needed for. A
separate `effectiveUserEmail` now drives read-side ownership only; writes,
`created_by` and the audit log still record the real user, so a preview cannot
falsify history. No privilege is gained — RLS still runs as the real session.
Disclaimer corrected to *"writes still record as you"*.

### Verified as a sales rep

| | in the database | rep sees |
|---|---|---|
| Sales documents | 101 total, 5 owned | **5** (2 quotations, 2 orders, 1 invoice — all archived, so active tabs are empty) |
| Deals | 56 total, 3 owned | **1 on B2B, 2 on B2C** — the board shows one pipeline at a time |
| Leads | 33 total, 1 owned | 0 — the single owned lead is `status = converted` |
| Activities | 171 total, 4 owned | 0 — all four are completed approvals |

The last two look like under-counting and are not: each was checked against the
rows themselves rather than assumed.

439 tests, up from 434.

---

## User Management rebuild (2026-08-18)

### The editor was showing eleven modules while the runtime enforced eighteen

`PermissionMatrix` rendered a hardcoded list written when this was an RMA tool.
It still listed `invoices` — the table with zero rows, since retired — and
listed none of deals, leads, activities, contacts, pipelines, sales, accounting
or purchasing. Those permissions were stored and enforced the whole time. There
was simply no way to see or change eight of them.

Third instance of the same shape this month, after the dashboard widget list and
the Reports tabs: a snapshot standing in for a live set. So the fix is
structural rather than "add the missing eight". `src/lib/permissionCatalog.js`
derives the module and action list from `ROLE_DEFAULT_PERMISSIONS` at runtime
and holds only presentation — grouping, order, labels. A module added to
`permissions.ts` now appears in the editor by itself, and anything without a
declared group lands in an "Other" section rather than vanishing.

**Now: 18 modules, 101 actions, in four groups** — CRM, Sales & Finance,
Operations, System — with search, per-module select/clear, and a marker on the
actions that move money, delete data or widen access, so fifty checkboxes are
not all weighted the same.

A test asserts the rendered set equals the runtime set. That is the part that
stops this recurring.

### The accountant role

Built to the segregation-of-duties rule rather than to convenience: no one
person should authorise, execute and record a payment.

| | |
|---|---|
| **Records** | customer and vendor payments, and reverses them |
| **Reads** | all sales and purchase documents (`view_all`), customers + history, products, reports |
| **Cannot** | create, edit, post, cancel or delete a sales document |
| **Cannot** | raise, approve, receive or cancel a purchase, or manage vendors |
| **Has no** | deals, leads, activities, pipelines, contacts, tickets, inventory, user management |

A manager raises the invoice, an admin approves the spend, the accountant
settles and reconciles. The absent modules are absent rather than present and
switched off — least privilege means the surface is not there.

### Also fixed

`RLS_CEILING`, which warns when a grant exceeds what the database will allow,
still named the retired `invoices` module and knew nothing of the money modules.
Refreshed for both viewer and technician.

The role-list test asserted a hardcoded length of six and broke on the seventh
role. It now compares `ROLE_LIST` against `Object.values(ROLES)`, so it says
"you forgot to list it" instead of "the number changed", and cannot go stale.

457 tests, up from 439.

### Applied 2026-08-18 and verified end to end

`supabase/migrations/20260777_accountant_role.sql` is live. The migration widens that constraint, adds the role to
`rma_is_staff()` (omitting it would let an accountant sign in and see nothing,
the same trap `sales_rep` hit before 20260618), and grants read on the four
sales-document tables, since the staff policies scope non-managers to their own
rows and an accountant is assigned to none.

### Best practice this follows

Least privilege and roles defined by job function rather than by person; a small
role set with per-user overrides instead of role explosion; and separation of
duties on the money path. Sources consulted are listed in the session notes.

### Accountant, verified against the live database

The constraint was tested by actually inserting an accountant row rather than
reading the constraint definition back — and by a control that an invented role
is still rejected, so the check is enforcing rather than dropped.

Previewing as that user:

| | |
|---|---|
| Nav | Dashboard, Products, Customers, Sales, Accounting, Purchasing, Reports — nothing else |
| Blocked by URL | `/leads` `/pipeline` `/activities` `/rma-tickets` `/inventory` `/calendar`, all six |
| Sales | sees **all 30** documents — `view_all` working — with **no "+ New"** |
| Purchasing | sees all 9 documents and 14 vendors, **no "+ New"** |
| Accounting | **"+ Record Payment"** present, Void controls enabled |

Which is the separation of duties stated as behaviour: reads the whole money
path, originates none of it, holds the settlement controls. The throwaway user
was deleted afterwards — `user_roles` back to 16.

