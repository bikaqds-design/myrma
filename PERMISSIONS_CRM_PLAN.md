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

---

## The rollback file was run by accident (2026-08-18)

`20260817_b2c_stage_remap_rollback.sql` was executed, which undid every data fix
from the day before: 24 deals back on undefined stages, 12 probabilities back to
wrong, the QA throwaway lead/deal pair and the orphaned activity re-inserted.
Totals went back to 57 / 34 / 176.

That is on the handover, not the operator. The rollback lived in the same folder
as a diagnostic and both paths were given out together, one line apart, with
nothing in the file itself objecting.

**Re-applied and re-verified:** 0 deals on undefined stages, 0 dangling
activities, B2C at 13 / 12 / 12 / 11 / 3, totals back to 56 / 33 / 171. The only
probability differing from its stage default is `OPP-73068304` at 33 — the
deliberate hand-typed one.

**Prevented properly.** The file is renamed
`20260817_b2c_stage_remap_ROLLBACK_DO_NOT_RUN.sql` and now opens with a guard
that aborts unless the operator opts in explicitly:

```sql
SET myrma.confirm_rollback = 'yes';
```

A warning comment would not have helped — the previous version had one. The
guard makes the accident impossible rather than discouraged.

## The RLS diagnostic came back partial

Only the third query returned, because the Supabase SQL editor shows the last
statement's result set and the file held three. Split into
`20260818_rls_check_1_enabled.sql` and `20260818_rls_check_2_policies.sql`, to be
run separately.

What the third query did establish: **all four helper functions are correct and
current.** `rma_is_staff()` includes both `sales_rep` and `accountant`, so
migration 20260777 landed and the pre-20260618 form is not in play;
`rma_current_user_email()` reads the JWT email; `rma_is_manager_or_above()` is
the expected three roles. So the leak is not in the helpers.

That leaves two candidates, which parts 1 and 2 separate: RLS switched off on
some tables (policies present but inert — fits the symptom exactly), or live
policies that differ from the repo.

---

## The leak found: views were bypassing RLS (2026-08-18)

Diagnostic parts 1 and 2 came back, and between them they rule out everything I
suspected:

- **RLS is enabled** on all nine CRM tables. Not the "policies present but
  inert" case.
- **Every SELECT policy is correct.** deals/leads/activities scope to
  `assigned_rep = rma_current_user_email()`; the four sales-document tables
  scope to `assigned_rep` or `created_by`. They match the repo exactly.
- **The helper functions are current**, including `sales_rep` and `accountant`
  in `rma_is_staff()`.

So the policies were never the problem. **The pages do not read those tables.**

| View | Page | Underlying tables |
|---|---|---|
| `v_sales_documents` | Sales | quotations, sales_orders, crm_invoices, credit_notes |
| `v_purchase_documents` | Purchasing | purchase_orders, vendor_invoices |
| `v_customer_ledger` | Accounting, Customer detail | crm_invoices, credit_notes, payments |
| `v_vendor_ledger` | Accounting, Vendor detail | vendor_invoices, vendor_payments |

In PostgreSQL a view executes with the privileges of its **owner** unless it is
defined with `security_invoker = true`. The owner is the table owner, which
bypasses RLS. **None of the four views set the flag**, so the base-table
policies were never consulted for anything read through a view, and every row
went to every authenticated user.

That is the whole symptom, and it explains why it presented on exactly the pages
it did — Sales, Purchasing and the ledgers are the four view-backed pages in the
app. It also means the app-side `ownershipScope()` filtering added earlier was
doing real work rather than being belt-and-braces: it was the only thing
narrowing those lists.

### Fix: `20260778_views_respect_rls.sql`

Sets `security_invoker = on` on all four views, behind a guard that refuses to
run on PostgreSQL below 15 rather than appearing to succeed.

**It also grants the accountant four read policies**, and that is not
incidental. `payments` and `vendor_payments` read as
`manager_or_above OR (is_staff AND created_by = me)`. An accountant is staff but
not manager, so the moment the ledger views started obeying RLS they would have
shown only the payments that accountant personally recorded — an incomplete cash
position, which is the one thing the role exists to prevent. Those policies were
written before anything read them through an invoker-rights view, so this is
fallout from the fix, not a pre-existing hole. Same reasoning extends the grant
to `vendor_invoices` and `purchase_orders`.

### What to check after applying

Each role in turn, because this migration can only ever *narrow* what is
returned: manager and admin still see everything; accountant still sees all four
sales-document types and both ledgers in full; sales_rep sees only their own. An
empty list for a role that should see data means a missing read policy on the
underlying table — not a reason to revert, since reverting restores the leak.

### 20260778 applied 2026-08-18

No regression for a role that should see everything: as super_admin the views
return exactly what the base tables hold — `v_sales_documents` 101 against 101,
`v_purchase_documents` 9 against 9 — and both ledgers are populated (21 and 4).

**That is not proof the fix works**, and it is worth being clear about why. An
admin session passes `manager_or_above()` on every policy, so it sees all rows
whether the views respect RLS or not. The check above only rules out the fix
having *broken* something.

Proving it closed the leak needs a restricted session, which this session cannot
produce — signing in as another user means handling their credentials.
`supabase/manual/20260818_verify_view_rls.sql` does it in SQL instead: it reads
back the `security_invoker` flag, then simulates each role with
`set_config('request.jwt.claims', …)` — which is what `auth.jwt()` reads, and
therefore what `rma_user_role()` resolves from — and counts rows through all
four views as that role. A throwaway accountant row is inserted for the test.
Everything runs inside a transaction that is rolled back, so nothing persists.

The number that matters is the sales_rep row. If it is small, the leak is
closed. **If it matches the manager count, the views are still bypassing RLS.**

### Result: the view leak is closed, and it exposed two more

Role simulation through the views after 20260778:

| role | sales_docs | purchase_docs | cust_ledger | vend_ledger |
|---|---|---|---|---|
| manager | 101 | 9 | 21 | 4 |
| accountant | 101 | 9 | 21 | 4 |
| **sales_rep** | **5** | 9 | **1** | 4 |
| **technician** | **3** | 9 | 0 | 4 |

**The reported bug is fixed.** A sales rep went from 101 sales documents to 5 —
exactly the 2 quotations, 2 orders and 1 invoice they own — and the customer
ledger from 21 to 1. Accountant and manager still see everything, so 20260778's
accountant grants did their job.

The two columns that did not move are the same class of hole, and the
simulation is the only reason they are visible at all:

- **`purchase_orders` and `vendor_invoices` carry no ownership condition.**
  `USING (public.rma_is_staff())` is every internal role, so a sales rep and a
  technician can read every purchase order and vendor invoice. Adding
  `accountant` to `rma_is_staff()` in 20260777 widened it further.
  `v_vendor_ledger` reads `vendor_invoices`, which is why the vendor ledger is
  fully visible too.
- **The sales-document tables scope ownership to `rma_is_staff()`**, not to
  sales reps, so a technician sees the 3 documents they created. The app gives
  technicians and viewers no Sales page at all.

Neither is visible in the UI — Purchasing is hidden from both roles — but the
API serves it, which is the same "the interface hides it, the database doesn't"
gap the whole exercise started from.

`20260779_tighten_purchasing_and_sales_reads.sql` aligns both with the matrix:
purchasing to manager+ and accountant only, sales-document ownership to
sales_rep only. Re-running the verification afterwards should show sales_rep at
5 / 0 / 1 / 0 and technician at 0 / 0 / 0 / 0.

---

## Closed 2026-08-18 — verified against the live database

20260779 applied. Re-running the role simulation:

| role | sales_docs | purchase_docs | cust_ledger | vend_ledger |
|---|---|---|---|---|
| manager | 101 | 9 | 21 | 4 |
| accountant | 101 | 9 | 21 | 4 |
| **sales_rep** | **5** | **0** | **1** | **0** |
| **technician** | **0** | **0** | **0** | **0** |

Every cell matches what was predicted before applying. A sales rep sees the five
documents they own and nothing else; a technician sees none of it; manager and
accountant are untouched.

The simulation ran from a session that itself bypasses RLS, and that does not
weaken the result: `SET LOCAL ROLE authenticated` inside the loop is what makes
the policies apply, and the proof is the numbers. Had RLS not applied, all four
rows would read 101 / 9 / 21 / 4. Two of them do not.

### What the problem actually was

Not the policies. RLS was enabled on all nine tables and every SELECT policy
scoped correctly the entire time. Three separate faults, each invisible from the
interface:

1. **Four views ran with owner rights.** `v_sales_documents`,
   `v_purchase_documents`, `v_customer_ledger` and `v_vendor_ledger` had no
   `security_invoker`, so RLS on the base tables was never consulted for
   anything read through them — and those four views back every money page in
   the app. This was the reported bug.
2. **`purchase_orders` and `vendor_invoices` had no ownership condition at
   all** — `USING (rma_is_staff())`, which is every internal role.
3. **The sales-document tables scoped ownership to `rma_is_staff()`** rather
   than to sales reps, so a technician saw documents they had created.

Faults 2 and 3 were only visible once fault 1 was fixed and each role was
simulated. Neither would ever have surfaced through the UI, because the pages
that expose them are hidden from the affected roles — which is exactly the
distinction this whole exercise turned on: a hidden page is not a closed door.

### What the app-side work was, and was not

`ownershipScope()`, the `view_all` action and the route guards are not the
protection and were never presented as such. What they did do is make the
interface tell the truth, and they are what made the database faults findable:
the counts stopped matching, which is what prompted looking underneath.

The protection is `20260778` and `20260779`.

---

## Pending bug found in review: the accountant could not move money

Asked whether anything was still outstanding in this area, and there was —
introduced by me in 20260777.

Every RPC on the cash path gates on `rma_is_manager_or_above()`, and an
accountant is not manager or above:

| RPC | gate |
|---|---|
| `record_payment` | `manager_or_above` |
| `void_payment` | `manager_or_above` |
| `record_vendor_payment` | `manager_or_above` |
| `void_vendor_payment` | `manager_or_above` |
| `apply_payment_to_invoice` | `manager_or_above` |
| `reverse_payment_application` | `manager_or_above` |
| `apply_credit_note_to_invoice` | `manager_or_above` |
| `issue_credit_note` | `manager_or_above` |

So the role could read the entire ledger — 101 documents, both sides, verified —
and would have been refused by the database the moment it tried to record or
reverse anything. Every core action of the role.

**How it got past verification.** I checked that the controls rendered enabled
for an accountant and reported `recordEnabled: true`, `voidButtons: 2,
allEnabled: true`. That confirms the app's permission gate, which was correct.
It says nothing about whether the action succeeds, and I treated it as though it
did. A button that renders enabled and then raises is worse than one that is
hidden.

`20260780_accountant_can_move_cash.sql` adds `rma_can_handle_cash()` —
manager_or_above **or** accountant — and re-gates seven of the eight.

**`issue_credit_note` is deliberately left at manager only.** Issuing a credit
note creates a sales document and reduces revenue: that is origination, and the
whole point of the role is that whoever settles money does not also raise the
paperwork behind it. Applying an already-issued credit note to an invoice is
settlement, so that one is included. `post_invoice` stays manager-only for the
same reason.

The migration rewrites the live definitions via `pg_get_functiondef` rather than
restating each body, so it cannot drift from what is deployed, touches only the
gate line, and raises if the expected gate is missing rather than silently
leaving the old rule in place.

Verification is two steps, and the second is the one that matters: confirm the
gates read correctly, then actually record a small payment as an accountant and
void it, because reading the gate is what I did last time.

---

## Three more found reviewing this section (2026-08-18)

Asked whether anything was still pending here. There was, and all three are the
same shape as the RLS holes: the interface and the database disagreeing about
who may do what.

**1. A sales rep could not edit their own quotation.** Every UPDATE policy on
the four sales-document tables required `manager_or_above`, and
`quotations.update()` / `markSent()` are direct table updates rather than RPCs.
A rep has `sales.edit: true` and owns the document; the database refused the
save. They could raise a quotation and then not correct a typo in it.

**2. A technician or viewer could create sales documents.** Every INSERT policy
was `WITH CHECK (rma_is_staff())` — every internal role. Neither has a Sales
page, so it was invisible and reachable only through the API. Same shape as the
read holes in 20260779.

**3. The document detail page ignored permissions entirely.** It took
`currentUserRole` and never used it — the prop had been renamed
`_currentUserRole` to silence the linter — and every action was gated on
document status alone. So anyone who could open a document was offered Edit,
Send for Approval, Convert, Cancel, Void, Issue Credit Note, Record Payment and
Archive. For an accountant that is eight buttons the database will refuse.

`20260781_sales_write_matches_matrix.sql` fixes 1 and 2 straight from the
matrix: INSERT to manager+ and sales_rep; UPDATE to manager+ for anything and
sales_rep for what they own, with the ownership test in both `USING` and
`WITH CHECK` so a rep cannot reassign a document away from themselves.
`crm_invoices` and `credit_notes` keep manager-only UPDATE — a rep may raise an
invoice but not alter one afterwards, or the manager-gated post and void would
mean nothing.

For 3, all thirteen actions now carry the verb they actually perform:
`sales.edit` for edit/send/convert-to-SO/reopen/archive, `sales.cancel` for
cancel and void, `sales.post` for convert-to-invoice and issue-credit-note, and
`accounting.record_payment` for taking a payment — because settling cash is the
accountant's job, not a rep's, and it follows the accounting module rather than
sales.

### A fourth, found while wiring that up

Three detail routes were still gated on the borrowed `deals.view`:
`/sales/:type/:id`, `/purchasing/:type/:id` and `/purchasing/vendor/:id`. The
list routes were repointed to their own modules; these were missed. Effect: an
accountant could see the Sales list and was **bounced to the dashboard on
clicking any row**, because they have no `deals` module at all.

### Verified in the browser

Previewing an accountant on a live draft quotation: the document opens rather
than redirecting, and Edit, Send for Approval, Cancel and Archive are all
disabled. The same document as a manager: all four enabled. Two earlier attempts
at this proved nothing and are worth recording — the first document was
`converted` and the second `archived`, both of which hide the actions by
pre-existing status rules, so the permission gate was never exercised. Only a
live draft tests it.

Gate: lint clean, 457 tests, build ✓.

### 20260781 applied and verified

| step | result |
|---|---|
| rep updates **own** quotation | `1 row(s) updated` |
| rep updates **another rep's** | `0 row(s) updated` |
| technician INSERT | `refused: new row violates row-level security policy` |
| accountant | `update matched 0 row(s), reads 38 quotation(s)` |

All four as predicted. The technician message names row-level security rather
than a constraint, so it is a genuine refusal and not an incidental error.

### The Purchasing detail page had the same gap

`PurchaseDocumentDetail` took `currentUserRole`, passed it to the activity
chatter, and gated no action on it — six buttons controlled by document status
alone, exactly as `SalesDocumentDetail` had been. Now gated: send-for-approval,
convert-to-vendor-invoice, cancel (both document types), archive and receive,
each on the matching `purchasing` verb.

Verified on a live PO: as an accountant, Archive is disabled and Download PDF
stays enabled, since that role has `purchasing.export`. As a manager on the same
document, Archive is enabled. The gate discriminates rather than blanket-hiding.

### Left alone, deliberately: ActivityChatter

Every detail page renders `<ActivityChatter ... canEdit ... />` — a bare prop,
so always true. That leaves Log Note, Schedule Activity, Attach, Reply and
Reopen enabled for anyone who can open the record, including an accountant, who
has no `activities` module at all.

Not touched here. It is pre-existing, spans every detail page in the app, and
commenting on a record you can already read is a different question from
changing that record. It wants its own pass rather than being folded into this
one.

---

## User Management review (2026-08-18)

### The cross-tier warning was blind to every money module

`RLS_CEILING` — the table behind "these permissions exceed what the database
enforces" — listed only `viewer` and `technician`, and knew nothing of `sales`,
`accounting` or `purchasing`, nor of the `sales_rep` and `accountant` roles.

Since the rebuilt editor renders all 18 modules for every user, an admin can
grant anyone anything. Demonstrated rather than reasoned about: granted a
**viewer** `accounting.record_payment`, it saved cleanly, all 18 sections
persisted, and **no warning appeared**. `record_payment()` raises for anyone
below manager, so that grant produces a button that appears and then fails.

Rebuilt as `SERVER_ALLOWS`, keyed by `module.action` and listing the roles the
database actually permits, transcribed from the RLS policies and RPC gates of
20260778–20260781. Adding a role now means adding it to one set rather than
editing every per-role block — which is precisely how the old shape went stale.

The older per-role RMA-side entries are kept verbatim as `LEGACY_CEILING`.
They are accurate and were deliberately not re-derived: transcribing a dozen
more policies to make the shape uniform would risk being confidently wrong about
rules nobody has complained about. Two mechanisms is a smell, and the comment
says so and says when to unify them.

Re-tested live: the same grant now raises *"Cross-tier permissions detected"*
naming `accounting.record_payment`.

### Also confirmed working

The rebuilt editor persists correctly — 18 sections, 101 actions, and a toggled
`accounting.record_payment` landed in `user_roles.permissions`.

### One latent issue, not a bug today

`_utils.js` derives the blank template for custom roles from
`ROLE_DEFAULT_PERMISSIONS[MANAGER]`, while `permissionCatalog.permissionSchema()`
unions across all roles. Two definitions of the same thing. Checked rather than
assumed: manager is still a complete superset — 18 sections, no missing actions
— so they agree today. It only bites if a future role gains a module manager
lacks, which is exactly the drift that produced the other bugs in this section.

473 tests, up from 457.

---

## Custom roles: applied and verified (2026-08-18)

20260782 applied. No regression on the built-in path, which was the risk worth
checking first — the migration rewrote `rma_user_role()`, and every policy in
the database depends on it. All four helpers return correctly and every count is
unchanged: quotations 38, deals 56, customers 888, invoices 27, POs 5,
v_sales_documents 101.

Guards, each exercised rather than read:

| | |
|---|---|
| create with a base role | works |
| `base_role = 'super_admin'` | rejected — it would make the permission map meaningless |
| `role_name = 'manager'` | rejected — names must be disjoint from the built-ins |
| assign a custom role to a user | accepted |
| assign `'not_a_role'` | refused: *Unknown role … not a built-in and not defined in custom_roles* |
| delete a role someone holds | refused: *1 user(s) still hold it. Reassign them first* |

End to end, previewing a `zz_bookkeeper` on base `viewer` whose map grants
`accounting` view + record but not reverse: nav shows Dashboard, **Accounting**,
Customer Tracker; `/accounting` opens; **Record Payment enabled, Void disabled**.
The per-action distinction in a custom map is honoured exactly.

### Two bugs in my own change, found by testing it

**Preview ignored custom roles.** I wired the custom-role lookup into session
load and not into `startPreview`, so previewing a custom role resolved to null
permissions and showed a two-item nav. That reads as "this role has no access"
when the truth is the preview never looked its permissions up.

**The editor was worse.** It seeded from `ROLE_DEFAULT_PERMISSIONS[user.role]`,
undefined for a custom role, falling through to an all-false template. So it
displayed the wrong state, suppressed the cross-tier warning, and **would have
written an all-false override the moment anyone pressed Save** — stripping a
user's access while they still held the role.

Three call sites needed the same lookup and two had already been written
separately, so it is now one function, `roleDefaults(role, customRoles)`.

### The cross-tier warning had to learn about base roles

A custom role is not in `SERVER_ALLOWS`, so the ceiling now resolves it to its
`base_role` first. Demonstrated in both directions with identical permission
maps:

- `zz_bookkeeper`, base **viewer** → warns, naming `accounting.record_payment`
- `zz_cashier`, base **accountant** → no warning

Which is the point. An admin building a bookkeeper on `viewer` is told the
database will refuse it, and the fix is to base it on `accountant`.

478 tests. Fixtures removed — user_roles back to 16, custom_roles back to 0.

---

## Self-lockout closed (2026-08-18)

Controls was offered on your own row and served Suspend, Lock, Deactivate, Set
Expiration and Delete. The role dropdown was already hidden for self, which made
the gap look closed when it was not. Applied to yourself, any of those five ends
your access; applied to the last active super admin, they end everyone's —
`rma_user_role()` resolves to NULL, every policy closes, and the role cannot be
granted back from inside the app.

Guarded at both layers, because a UI check is not a boundary:

- **App** — refuses destructive self-actions and refuses to remove or demote the
  last active super admin.
- **Database** — `20260783` adds a trigger refusing the same, covering direct
  API calls, bulk updates, and any future screen that forgets the rule.

Deliberately narrow: the trigger fires only when a change would take the count
of *active* super admins to zero.

### Verified

App layer, in the browser: Controls → Deactivate on my own row is refused with
*"You cannot suspend, lock, deactivate, expire or delete your own account"*, and
the account is still active afterwards.

Database layer, in SQL: demoting one super admin while another remains
**succeeded** — the guard is narrow — and removing the last one raised

```
ERROR: 23514: Refusing to remove the last active Super Admin (bika.qds@gmail.com)
```

`23514` is check_violation, which is the code the trigger raises. The failed
transaction rolled back cleanly: both super admins still active, 16 users.

**The last-admin path cannot be reached from the UI at all** — it needs a
session that is not the last admin, and the only signed-in admin cannot demote
themselves because the self-guard fires first. That is the whole argument for
the trigger: the state it prevents is one the interface can never test.

### Two verification scripts failed on their own scaffolding first

Worth recording, because the pattern repeated. The first used a temp table, a
`DO` block and exception handling, and died with *relation "_lastadmin" does not
exist* — most likely something raising outside the handlers, aborting the
transaction, after which the closing `SELECT` ran in a fresh one where the temp
table was gone. The rewrite dropped all three: the outcome is now each
statement's own result or its own error.

The replacement then hit an error I had already met and fixed once this session
— the Supabase editor returns only the last statement's result set, so a
two-query file silently drops the first answer. Splitting the RLS diagnostic for
exactly that reason was two hours earlier in the same session.

## Custom roles: correcting the record

`ENABLE_CUSTOM_ROLES` existed as a flag set to `false`, with a comment naming
three conditions: *"not assignable in the role dropdown, not loaded by
getUserRole, not enforced by canDo"*.

So the earlier claim here that custom roles "can be created, listed and deleted,
and never used" was wrong in its detail. The tab was hidden; they could not be
created through the UI either. Those were created through the API directly. The
substance — that custom roles were unusable — held, and someone had already
diagnosed it precisely.

All three conditions are now satisfied, and the flag is on.

## Custom roles could not be corrected once created

Found by exercising the Custom Roles tab through the UI rather than the API —
which had not been done: the tab was enabled and its modal gained a base-role
picker, and every test role until now was created through `db.userRoles`
directly.

Two gaps, and they compounded:

- **The card never showed the base role.** The single property that decides
  what the database will serve a holder was invisible in the list.
- **There was no edit action at all** — create and delete only. Combined with
  the trigger refusing to delete a role somebody still holds, a role created
  with the wrong base was *stuck*: unfixable and unremovable until every holder
  was reassigned. My own delete guard made that worse.

Both fixed. The card carries a "based on <role>" badge, and Edit reopens the
modal pre-filled. `role_name` is locked while editing, for the same reason a
pipeline stage id is: it is the value stored on every holder, so renaming it
would strand them all.

Verified through the UI end to end: created `zz_ui_bookkeeper` on base
`accountant` with `record_payment`, saw it saved with 18 sections; reopened it,
changed the base to `manager` and added `reverse_payment`; confirmed both landed
and the table still held **one** role rather than a duplicate.

Two mistakes of mine on the way, both from replacing the first match rather than
the right one: `onEditRole` was attached to `UsersTab`, which ignores it, so the
Edit button threw instead of opening anything; and a blanket replace turned
`onClose={() => setShowCreateRoleModal(false)}` into two statements in an arrow
body, which does not parse. Lint caught the second immediately; the first only
showed up on clicking the button.

