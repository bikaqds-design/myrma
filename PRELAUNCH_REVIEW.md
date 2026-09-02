# Pre-launch readiness review

Started 2026-08-18. Audited against the **live database**, not this repo —
because the two are known to disagree.

## Why not read the SQL files

Two things established that the migration history is not a complete description
of the database:

- `custom_roles` exists in production with no `CREATE TABLE` in any migration.
- `ticket_resolutions` has no policy in any migration, yet returns rows to an
  authenticated user and none to an anonymous one — so a policy exists live that
  is not in this repo.

That is also how I nearly got the RLS diagnosis wrong twice earlier: reading the
first definition of something rather than the last, or reading a file that was
never applied. Everything below was measured by asking the database.

---

## Finding 1 — two tables accepted anonymous writes

Probed all 49 app tables with the anon key and no session. **47 refused with
42501.** Two did not:

| Table | Anonymous access found |
|---|---|
| `kb_articles` | **INSERT, UPDATE and DELETE all succeeded** |
| `notification_logs` | INSERT reached a constraint rather than a refusal; DELETE returned 204 against 192 rows |

`kb_articles` is the serious one. `/kb` renders `KnowledgeBasePublic` **before
any auth check**, listing every article with `is_published = true`. An anonymous
visitor could therefore publish arbitrary content onto a public page on the
company's domain, or edit and delete the real articles.

Demonstrated rather than inferred: a `POST` with `{title, slug, body}` created a
row, a `PATCH` on it returned 204, and a `DELETE` returned 204. The probe row was
removed and the table is back to 0 rows.

**Nothing was exposed in the event** — `kb_articles` holds no rows today. The
hole would have opened the moment somebody wrote the first help article.

`notification_logs` is less exposed but not harmless: the notification audit
trail, 192 rows, deletable by anyone with the public anon key.

Fixed in `20260784`: published-only public read on `kb_articles` with admin-only
writes, and staff-read / manager-update on `notification_logs` with no insert or
delete policy at all. The notification worker and webhook write through the
service role, which bypasses RLS, so delivery is unaffected.

## Finding 2 — the first fix missed two policies, and the probe that found them was reasoning unsoundly

Re-running the probe after `20260784` still flagged `notification_logs`. Two
things were wrong, and they masked each other.

**The policies.** `20260602` created these with *quoted* identifiers:

| policy | grant |
|---|---|
| `"service_insert_notif_logs"` | `FOR INSERT WITH CHECK (true)` |
| `"service_update_notif_logs"` | `FOR UPDATE USING (true)` |
| `"service_update_notif_queue"` | `FOR UPDATE USING (true)` (on `notification_queue`) |

`20260784` dropped four *other* names on that table — `notif_logs_staff_read`,
`notif_logs_manager_update`, `notification_logs_all`, `allow_all` — and never
touched these. None carries a `TO` clause, so all three apply to `anon`.

The insert one was live and exploitable. Posting
`{"event_type":"…","recipient":"…"}` with nothing but the public anon key
created a row; that row is what the `DELETE` at the end of `20260785` removes.
The two UPDATE policies are latent rather than reachable — Postgres also applies
SELECT policies to an `UPDATE … WHERE`, and `anon` has no SELECT policy on
either table, so the `WHERE` matches nothing. Removed anyway: a policy that is
only safe by accident of a second policy is not safe.

All three rested on the premise that the edge functions need a policy in order
to insert. They do not — the service role bypasses RLS entirely, so these never
granted the worker anything it did not already have. They only ever widened the
door.

Fixed in `20260785`. Verify with `supabase/manual/20260819_verify_anon_lockdown.sql`.

**The probe.** Its write inference was not sound, and this is the more
transferable lesson. It posted `{}` and treated any code other than `42501` as
"RLS let us through". But Postgres checks NOT NULL during tuple formation and
the RLS `WITH CHECK` afterwards, so a table that *would* refuse still answers
`23502` when a required column is missing. The two are indistinguishable from a
single empty post.

It reported `notification_logs` on that basis and was right — by luck, not
because the inference held. The 48 tables it cleared answer a clean `42501`
because `anon` lacks the table grant, which fires before constraints; a table
with a grant and a restrictive policy would have been reported identically to a
genuinely open one.

### Made repeatable

`scripts/probe-anon-access.mjs` runs the same sweep and exits non-zero if
anything is readable, writable, or *inconclusive*. It now returns three verdicts
rather than two:

| verdict | code | meaning |
|---|---|---|
| REFUSED | `42501` / `401` | decisive — the database said no |
| WRITABLE | `2xx` | decisive — a row was created |
| INCONCLUSIVE | anything else | a constraint answered before RLS did |

Default mode never creates a row and stops at INCONCLUSIVE. `--deep` resolves
those by filling the NOT NULL columns the error names, one round trip per
column, until the answer is decisive — and prints ready-to-paste `DELETE`
statements for any sentinel row it managed to write.

A detector that cannot distinguish "refused" from "I could not tell" will
eventually report one as the other. This one now says so out loud.

## Verified after 20260785

Both fixes are applied and confirmed against the live database.

```
node scripts/probe-anon-access.mjs            49 refused, exit 0
node scripts/probe-anon-access.mjs --deep     49 refused, exit 0, nothing created
```

`supabase/manual/20260819_verify_anon_lockdown.sql` returns all zeros:

| check | value |
|---|---|
| open anon policies on notification tables | 0 |
| notification_logs probe rows remaining | 0 |
| kb_articles total rows | 0 |
| kb_articles published | 0 |
| any policy on notification_logs allowing INSERT | 0 |

`kb_articles total rows = 0` also settles the one question the anonymous probe
could not: `/kb` returning no published articles to a signed-out visitor is
correct-and-empty, not a broken `kb_public_read`. No regression from 20260784.

## Confirmed sound

- **No table leaks data anonymously.** 25 answer an anonymous read with zero
  rows — RLS filtering correctly — and 24 refuse at the grant level.
- **RLS coverage**: of 53 tables the app touches, 4 are views (which inherit via
  `security_invoker` since 20260778) and every remaining table has policies,
  either named directly or applied through a `DO`-loop array. An earlier count
  of "16 tables with no policy" was a broken grep that could not see the loops.

---

## Finding 3 — Suspend, Lock, Deactivate and Set Expiration did nothing

Part two started with the first-user path and found that the whole
account-control column of User Management was inert.

**Suspension was cosmetic at both layers.** `rma_user_role()` read
`user_roles.role` without looking at `status`, and every other RLS helper —
`rma_is_admin`, `rma_is_manager_or_above`, `rma_is_staff`,
`rma_can_handle_cash` — is defined in terms of it. The application never read
`status` either. A suspended or locked account kept complete access until
somebody deleted its auth user. For an offboarded employee that is the entire
point of the feature.

Worse, the self-lockout protection built earlier in this project rests on the
premise that it works. `index.jsx:332` says so in a comment — *"a suspended
admin cannot sign in to undo this"* — and `20260783` counts *active* super
admins for the same reason. The guard was real; the thing it guarded against
was never enforced.

**Two of the four actions could never have worked at all.**

| action | what happened |
|---|---|
| Deactivate | wrote status `'deactivated'`, which `chk_user_status (active, suspended, locked)` rejects — the write always failed |
| Set Expiration | called `db.userRoles.setUserExpiration`, a method that did not exist, against a column that did not exist — always threw |

`StatusBadge` renders five states — active, suspended, locked, deactivated,
pending — so the UI was built for a domain the column never allowed.

**And an unprovisioned account got a working-looking app.** `finishLogin()` read
`roleData?.role || 'technician'`. A self-signup nobody had provisioned, or a
user whose row had been deleted, became a technician on the client while
`rma_user_role()` returned NULL and the database refused every query — a full
shell in which nothing loaded and no error explained why. Signup made that
state reachable by anyone: `handleSignup` set `'technician'` outright.

### Fixed

`20260786_enforce_user_status.sql` normalises NULL status, widens the domain to
the five states the UI renders, adds `access_expires_at`, and gates
`rma_user_role()` on a new shared helper `rma_access_is_current(status,
expires)`. Because every role helper routes through `rma_user_role()`, that one
change makes suspension real across every policy in the system without touching
a single policy.

The last-super-admin trigger is rewritten in terms of the same helper. It
counted `status = 'active'` alone, so an expiry set on the last super admin
would have walked straight past it. The shared helper exists precisely so the
two cannot drift — shipping two copies of a rule and watching them diverge is a
mistake this project has already made once, with the permission ceiling.

The migration ends with a guard that raises if applying it would leave no
active, unexpired admin, which rolls back everything above it. It is safe to
run without knowing the current status values.

Application half: `accessDenialReason()` in `src/lib/permissions.ts` mirrors the
SQL helper; `src/components/AccessDenied.jsx` tells the user which of the six
reasons applies, including the administrator's stated reason, which beats
"contact your administrator"; and `setUserExpiration` now exists. The client
code is forward-compatible with `access_expires_at` absent, so it can ship
before the migration is applied.

Verified by `supabase/manual/20260820_verify_user_status.sql`, which drives the
real `rma_user_role()` through all six states end-to-end and removes its probe
row even if something raises, and by 26 new unit tests — 504 total, up from 478.

### Verified after 20260786

Applied, and all twelve checks returned PASS:

| check | detail |
|---|---|
| `access_expires_at` column exists | true |
| status domain includes all five UI states | `active, suspended, locked, deactivated, pending` |
| `rma_user_role` calls `rma_access_is_current` | true |
| last-super-admin trigger calls `rma_access_is_current` | true |
| active account resolves to its role | `manager` |
| suspended / locked / deactivated / pending resolve to NULL | NULL ×4 |
| expired account resolves to NULL | NULL |
| unexpired account resolves to its role | `manager` |
| probe row removed | yes |

One caveat on that run: the thirteenth line, custom roles resolving to a
`base_role`, reported `no-custom-roles`. There are none in the database, so
that check was vacuous — the custom-role path was covered by `20260782`'s own
verification, not by this one.

---


## Finding 4 — the repository cannot build this database

Twenty of the forty-nine tables the app uses are created by no migration in
this repo. The migrations only `ALTER` them:

```
announcements  categories  custom_field_definitions  custom_roles
customer_notes  customers  inventory_units  manufacturer_batches
notifications  products  rma_config  rma_tickets  subcategories
ticket_activity  ticket_comments  user_activity_log  user_preferences
user_roles  warehouses  webhooks
```

That list includes `customers`, `products`, `rma_tickets` and `user_roles` —
the core of the system. There is no DDL for them anywhere: not in
`supabase/migrations/`, not in `supabase/manual/`, not in `scripts/manual/`,
and there is no schema dump checked in. They exist only in the live Supabase
project, presumably created through the dashboard or carried over from the
Base44 migration before this repo started tracking SQL.

Three consequences:

- **The README's setup sequence cannot work on a clean project.** "Apply
  migrations in order" fails at the first `ALTER TABLE public.user_roles`.
- **There is no way to stand up a second environment.** Which is also why the
  integration write tests noted earlier in this project have stayed blocked on
  "needs a second Supabase project" — it is not merely unbudgeted, it is not
  currently possible from the repo.
- **Recovery depends entirely on the platform.** If the Supabase project were
  lost, the schema would go with it. Supabase's own backups cover this in
  practice, so this is a real gap rather than an emergency.

Not a launch blocker on its own: the live database exists and works, and
nothing about going live requires provisioning a new one. It is a
disaster-recovery and environment-parity gap.

### Why it was not fixed in this pass

Producing a baseline needs the live schema, and none of the three routes are
available from here: `supabase db dump` runs `pg_dump` inside a container and
Docker is not installed, and neither `pg_dump` nor `psql` is on PATH. The CLI
is linked and authenticates fine — "Initialising login role" succeeds — so only
the container step is missing.

The remaining route is a DDL-generating query run in the SQL editor, whose
output becomes `00000000_baseline_schema.sql`. That is a decision about scope
rather than a mechanical fix, so it is raised rather than assumed.

---


## Finding 5 — Backup & Restore could not restore anything

Picked as the next area because Finding 4 made it load-bearing: with no schema
in the repo, the in-app backup was the only recovery path there was. It did not
work.

**Three of the four export buttons threw on click.** The screen calls
`backupAPI.exportProducts()`, `exportCustomers()` and `exportTickets()`. None of
them existed — `src/api/backup.js` defined exactly two methods, `exportAll` and
`importAll`, which `git show HEAD:src/api/backup.js` confirms. Each click raised
`is not a function`, the handler caught it, and the user saw "Failed to export
products", which reads as a server problem rather than a missing method.

**Restore was dead in the same way, and worse.** The upload handler called
`importProducts`, `importCustomers` and `importTickets` — also nonexistent — so
every restore failed for every table and reported "Failed to restore any data".
`importAll`, the one method that did exist, was never called from anywhere.

**The one working button backed up 9 tables out of 53.** Not covered at all:

```
activities  announcements  brands  categories  contacts
credit_note_applications  credit_notes  crm_invoices
custom_field_definitions  custom_roles  customer_notes  deals
inventory_units  invoices  kb_articles  leads  manufacturer_batches
notification_logs  notification_queue  notification_settings
notification_preferences  notifications  parts  payment_applications
payments  pipelines  purchase_orders  quotations  rma_config
sales_orders  stock_moves  subcategories  ticket_parts
ticket_resolutions  time_entries  user_activity_log  user_preferences
vendor_invoices  vendor_payment_applications  vendor_payments
warehouse_stock  warehouses  webhooks  whatsapp_templates
```

Every deal, lead, contact, quotation, sales order, invoice, payment, credit
note, purchase order, vendor invoice, vendor payment, inventory unit,
warehouse, stock move, part, time entry, activity, custom role and pipeline.
The button says **"Export Complete Backup"**, the toast says **"Complete backup
exported successfully"**, and the on-screen tip says **"Complete backup
includes all system data"**. Someone following the app's own advice —
"Download regular backups (weekly recommended)" — and restoring after a data
loss would have lost the entire CRM, accounting, purchasing and inventory
modules, having been told the backup was complete.

**And it truncated silently.** Each table was read with one unbounded select.
PostgREST caps rows per response, so any table past the cap was cut short with
no error. Today's largest tables are under it, so the backup is short only as
the business grows — the kind of defect that appears long after the code that
caused it.

### The probe list was incomplete too

Found on the way in: `branding_settings`, `email_settings`, `email_templates`
and `notification_preferences` were never in `scripts/probe-anon-access.mjs`.
The list had been built from the 49 tables in `src/api/db/` and missed the four
reached through `src/api/*.js`. It now covers 53, and all 53 refuse anonymous
reads and writes — including `email_settings`, which holds `api_key`,
`smtp_password` and `webhook_secret`.

Anonymous is not the whole question there. None of those three has a policy in
any migration, and this project has already found policies live that the repo
does not describe. `supabase/manual/20260821_check_secret_tables.sql` answers
whether an ordinary signed-in user can read the SMTP password; it is read-only
and still outstanding.

### Fixed

`src/api/backup.js` is rebuilt around `BACKUP_TABLES`, a single ordered
manifest that both directions read, so a table cannot be exported but not
restored, or added to the app and silently left out of backups. It is in
foreign-key order — parents before children, `activities` last because its
`related_id` is polymorphic and no constraint can order it.

- All 53 tables, 49 of them restorable.
- Four are export-only and each says why: `notification_queue` (restoring it
  would re-send every notification pending when the backup was taken),
  `email_settings` (its secrets are excluded from the export, so restoring
  would overwrite live credentials with placeholders), `notification_logs` (a
  delivery log describes what happened; rewriting it misrepresents history).
- Reads are paginated, writes chunked.
- The three missing export methods now exist.
- Restore calls `importAll` and reports tables and rows; a partial failure
  reports what did land, rather than leaving the user to guess and restore
  again on top of half-written data.
- The copy no longer claims more than it does, and a fourth tip states that
  restoring overwrites by ID and never deletes.

`src/test/backupCoverage.test.js` is the test that was missing. It derives the
app's table list from source — every `.from('…')` outside the backup module —
and fails if the manifest does not cover it. Deliberately not a second
hardcoded list, which would be a second thing to forget. 28 assertions, also
covering foreign-key ordering and the export-only exclusions.

Not exercised in the browser: the session expired mid-review and signing in
would mean handling credentials. The manifest, ordering and coverage are
verified by tests, which is the stronger check for this logic; an end-to-end
export-and-restore against real data has still not been run.

---


## Finding 6 — a blanket policy made the entire role model decorative

The schema dump from Finding 4 was generated to fix a disaster-recovery gap.
What it actually found is the most serious defect in this review, and one no
amount of reading the repo could have surfaced: the policies are in the
database and in none of the migrations.

```sql
CREATE POLICY "Allow authenticated access" ON public.customers
  FOR ALL TO PUBLIC USING (auth.role() = 'authenticated');
```

The same policy exists on `products`, `rma_tickets`, `ticket_comments` and
`user_permissions`.

Three properties combine badly:

- **`FOR ALL` with only `USING`.** Postgres reuses the `USING` expression as
  the `WITH CHECK`, so one policy covers SELECT, INSERT, UPDATE *and DELETE*.
- **Permissive policies are OR'd.** Every `staff_read`, `manager_insert`,
  `admin_delete` and `staff_update` policy on those tables was decorative — a
  session only had to satisfy the broadest one.
- **`auth.role()` never reads `user_roles`.** It returns `'authenticated'` for
  any valid session, whatever that account's role or status.

So, before `20260787`:

| who | could do |
|---|---|
| a viewer | delete every customer, product and RMA ticket |
| a technician | rewrite any ticket, not only their assigned ones |
| **a suspended account** | everything above, unchanged |

That last row is the one that matters. `20260786` made suspension real by
gating `rma_user_role()` — but these policies never call it, so suspension was
still doing nothing on the five tables holding the customer list, the product
catalogue and every RMA ticket. The fix from earlier the same day was sound and
simply not reached.

### The same flaw, quieter

Nine more tables carry hand-rolled admin checks:

```sql
EXISTS (SELECT 1 FROM user_roles
         WHERE user_email = auth.email()
           AND role IN ('admin','super_admin'))
```

Identical to `rma_is_admin()` except that it skips the status and expiry test
`rma_access_is_current()` performs. A suspended administrator kept admin rights
on branding, brands, categories, subcategories, product images, email settings,
email templates, custom roles and user roles.

And several tables granted every signed-in user unconditional read —
`user_roles` among them, exposing every colleague's email, role and permission
map to anyone who could sign in.

Two dormant `TO anon` policies were also found on `rma_tickets` (read *all*
tickets) and `ticket_comments`. They are unreachable only because neither table
grants anything to anon; the public tracker uses the `public-track` edge
function on the service role. A policy that is safe solely because a grant
happens to be missing is one `GRANT` away from exposing every ticket.

### Why the anonymous probe never saw any of this

It could not. `scripts/probe-anon-access.mjs` tests what an anonymous caller
can reach, and every one of these requires a valid session. The role-by-role
probing that has been on the "still to cover" list since part one is exactly
what would have caught it — this is the strongest argument yet for doing it.

### Fixed

`20260787_drop_legacy_permissive_policies.sql` removes all of them. Dropping a
policy that currently permits something is a behaviour change, so where the
broad policy was the only thing allowing a legitimate action, a narrow one
replaces it: sales reps may still create customers, staff may still raise
tickets, and comment authors may still edit their own. `product_images` and
`email_queue` gain the `rma_is_admin()` policies they never had. The migration
refuses to apply if it would leave any core table with no SELECT policy.

Verify with `supabase/manual/20260822_verify_no_blanket_policies.sql`, which
should return zero rows.

**Test after applying**: creating an RMA ticket, editing a comment, and
creating a customer as a sales rep. These are the three paths whose permission
now comes from a new narrow policy rather than the old blanket one.

### Verified after 20260787

`supabase/manual/20260823_probe_roles.sql` takes nine real session identities
and attempts real reads and writes as each. Applied and measured:

| identity | read customers | INSERT | DELETE | INSERT ticket | `rma_user_role()` |
|---|---|---|---|---|---|
| viewer | 897 rows | denied | 0 rows | denied | viewer |
| technician | 897 rows | denied | 0 rows | ALLOWED | technician |
| sales_rep | 897 rows | ALLOWED | 0 rows | ALLOWED | sales_rep |
| accountant | 898 rows | denied | 0 rows | ALLOWED | accountant |
| manager | 898 rows | ALLOWED | 0 rows | ALLOWED | manager |
| admin | 899 rows | ALLOWED | ALLOWED | ALLOWED | admin |
| **suspended** | **0 rows** | denied | 0 rows | denied | **NULL** |
| **expired** | **0 rows** | denied | 0 rows | denied | **NULL** |
| **norow** | **0 rows** | denied | 0 rows | denied | **NULL** |

Probe rows remaining: 0.

The viewer row is the one that matters: before this, that same identity could
delete every customer in the table. The suspended and expired rows close the
loop on Finding 3 — suspension now removes access at the database layer, on the
tables where it previously did not.

The `sales_rep` INSERT and `technician` ticket INSERT confirm the narrow
replacement policies work, so the three flows flagged for hand-testing above
are covered.

Two observations from the same run:

- **Suspended and expired accounts still read one row of `user_roles`** —
  their own, via `user_read_own`. That is deliberate and necessary: the
  AccessDenied screen shows the administrator's stated suspension reason, which
  requires reading that row. Blocking it would degrade the message to the
  generic "not set up yet".
- **All six staff roles read all 24 rows of `user_roles`**, via the
  `staff_read_user_roles` policy added in 20260787 to keep the notification
  handlers working. That table carries a `password_hash` column and every
  user's `permissions` map — more than a viewer should see. Open; see below.

---


## Finding 7 — the RPCs routed around Finding 6 entirely

`20260787` stopped a viewer deleting a customer. It did not stop them calling
`delete_customer_cascade`, which deletes the customer, its notes and its
activities, and checked nothing except whether an RMA ticket was attached.

Every function involved is `SECURITY DEFINER` in the `public` schema. PostgREST
exposes each at `/rest/v1/rpc/<name>`, and `SECURITY DEFINER` means it executes
as the owner — so RLS does not apply to anything it does. Locking down the
tables achieves nothing if a function reachable from the browser will do the
same work without asking who is calling.

Measured by `supabase/manual/20260824_probe_rpc_authorization.sql`, running as
a viewer:

| function | response as a viewer |
|---|---|
| `delete_customer_cascade` | ran |
| `delete_customers_cascade` | ran |
| `_reverse_payment_application` | "Payment application not found" |
| `_reverse_credit_note_application` | "Credit note application not found" |
| `_reverse_vendor_payment_application` | "Vendor payment application not found" |
| `reserve_units` | "Insufficient stock: need 1, only 0 available" |
| `release_units` | ran |
| `adjust_part_quantity` | ran |
| `cancel_sales_order` | "Sales order not found" |
| `convert_quotation_to_so` | "Quotation not found" |
| `mark_notifications_read` | ran, against another user's email |
| **`post_invoice` (control)** | **"Not authorized to post invoices"** |

The control row is what makes the rest evidence rather than noise: a function
that *does* check refused the same session, so the probe was genuinely running
as a viewer and genuinely reaching the others.

The three `_reverse_*` rows are the sharpest. Their public wrappers —
`reverse_payment_application` and siblings — open with
`rma_can_handle_cash()` or `rma_is_manager_or_above()` and demand a reason.
The internals they delegate to are separate endpoints with neither, so the
check was one URL away from being skipped on a financial reversal.

### A probe bug, and why the verdicts still hold

Five rows reported `malformed array literal: "delete_customer_cascade"` rather
than a function message. That is the probe's own defect: `text[] || <untyped
literal>` made Postgres resolve `||` as array-to-array and try to parse the
string as an array. It only fires on the *success* branch, so reaching it means
the call returned — the UNGUARDED verdict is correct, but arrived at by
accident rather than by the reasoning intended. Fixed by casting the literal;
re-running gives clean text for those five.

That is the third time in this review a detector has produced a right answer
for a wrong reason. The control call is the habit worth keeping from it.

### Fixed

`20260788_authorize_security_definer_rpcs.sql`, in two parts:

- **Seven gain the check they should have had.** These are the ones the
  application actually calls, found by grepping `.rpc('` in `src/`. Each takes
  the rule its table already uses: `delete_customer_cascade` becomes admin-only
  to match `customers.admin_delete`; `adjust_part_quantity` becomes staff
  except viewer, matching `parts.staff_update`; `cancel_sales_order` allows a
  manager or the rep who owns the order, matching
  `sales_update_sales_orders`; and `mark_notifications_read` now takes the
  caller's identity from the JWT instead of trusting the email passed in.
- **The rest stop being endpoints.** Sixteen internal helpers — the three
  `_reverse_*`, the stock reserve/release/deliver/restore primitives,
  `nextval_for_type`, the cron entry point — have `EXECUTE` revoked from
  `PUBLIC`, `anon` and `authenticated`. A function only ever called by another
  function has no reason to be reachable from a browser.

  Revoking from `PUBLIC` as well as the two named roles matters: a function
  whose `proacl` is NULL carries an implicit `EXECUTE` to `PUBLIC`, so
  revoking from `anon` and `authenticated` alone would have changed nothing.

  This does not break the call chains. `SECURITY DEFINER` means an inner call
  runs with the definer's privileges, so `cancel_sales_order` still calls
  `release_units`, `post_invoice` still calls `nextval_for_type`, and
  `approve_sales_order` still reaches `reserve_units` through
  `funnel_reserve_line`.

The migration ends by checking that every function the application calls is
still executable by `authenticated`, and refuses to apply if any is not —
turning "did I revoke too much" into an error at apply time rather than a
broken deploy.

### Verified after 20260788

Re-run as a viewer. Ten of the twelve are closed, by one of two routes:

| route | functions |
|---|---|
| refuses with an authorization message | `delete_customer_cascade`, `delete_customers_cascade`, `adjust_part_quantity`, `convert_quotation_to_so` |
| endpoint no longer exists — `permission denied for function` | the three `_reverse_*`, `reserve_units`, `release_units` |

The control stayed guarded, so the probe was still reaching them as a viewer.

The re-run also exposed a defect in the fix itself, which is the point of
re-running. **`cancel_sales_order` answered "Sales order not found"** rather
than refusing. 20260788 had placed its owner check after the row fetch, because
the check needs `assigned_rep` — so the function told any signed-in caller
whether a sales order id exists before deciding whether they were allowed to
ask, and the check could never fire for an id that did not resolve. Fixed in
`20260789` with a coarse gate first (manager or sales rep), then the fetch,
then the owner test. The other six already checked before reading.

And a probe defect: `mark_notifications_read` reported "marked another user's
notifications" from a hardcoded success string written before the fix. The new
implementation takes the caller from the JWT and ignores `p_email`, so a viewer
marking their own notifications read is correct behaviour — but the probe was
asserting an outcome rather than measuring one. It now creates a real
notification targeted at the probe user, calls the function with a stranger's
address, and inspects `read_by` afterwards: the stranger appearing there is the
only thing that constitutes a failure.

The probe also treats `permission denied for function` as a pass in its own
right. Reporting a revoked endpoint as UNGUARDED, as the first re-run did, is
the same class of mistake as Finding 2 — a detector whose verdict does not
match what it measured.

---


## Finding 7 closed

Re-run of `20260824_probe_rpc_authorization.sql` after `20260789`, as a viewer:

| outcome | functions |
|---|---|
| refuses with an authorization message | `delete_customer_cascade`, `delete_customers_cascade`, `adjust_part_quantity`, `cancel_sales_order`, `convert_quotation_to_so` |
| endpoint revoked — `permission denied for function` | the three `_reverse_*`, `reserve_units`, `release_units` |
| measured, not asserted | `mark_notifications_read` — "p_email ignored; marked the caller's own, which is correct" |
| control | `post_invoice` still guarded, so the probe was still reaching them |

Cleanup CLEAN, 0 probe rows remaining.

---

## Finding 8 — CRM notifications to sales reps have never been deliverable

Found while closing the `user_roles` exposure. `resolveRepPhone()` in
`src/lib/events/crmEventHandlers.ts` ran:

```js
supabase.from('user_roles').select('phone').eq('email', repEmail)
```

`user_roles` has neither column. The email column is `user_email`, and **no
`phone` column exists anywhere in the schema** — confirmed against the live
dump. A comment above the function stated that reps set this in AccountSettings
→ profile; there is no such field.

So the query always failed, `data` was always undefined, and the caller does:

```js
const phone = await resolveRepPhone(supabase, repEmail)
if (!phone) return
```

Every `crm.followup_due`, `crm.lead_assigned`, `crm.deal_won` and
`crm.deal_overdue` notification has returned at that line since the feature was
written. The Control Panel shows the events as enabled, templates exist and can
be marked active, and nothing anywhere reports a failure. It is the same shape
as Findings 3 and 5: a feature that presents as working and does nothing.

Ticket notifications to *customers* are unaffected — those take the phone from
the customer record, which does have one.

### Not fixed, deliberately

Where a staff phone number should live is a product decision, not a security
one. Either a `phone` column on `user_roles` with a field in AccountSettings,
or `user_preferences.prefs`. Both need a `SECURITY DEFINER` lookup, because
under `20260790` a rep may not read another rep's row.

What has changed is that the failure is no longer silent: the doomed query is
gone — it cost a round trip per event to produce a guaranteed null — and the
first time the path is reached it reports through `captureException` that rep
notifications are not deliverable. A gap that announces itself is a different
thing from one that does not.

While removing it, `captureException` turned out not to be imported in that
file at all, so the new call would have thrown a `ReferenceError` on the first
CRM event. Lint did not catch it: `no-undef` is off for TypeScript files, and
the build does not check globals. Worth remembering — a green gate does not
mean a name resolves.

---

## Finding 6 follow-up — user_roles narrowed

The role probe showed all six staff roles reading all 24 `user_roles` rows,
through the `staff_read_user_roles` policy `20260787` added. That row carries
`password_hash`, the user's `permissions` map, administrator `notes` and
`suspended_reason` — none of which belongs to a viewer.

The policy existed for two stated reasons. One was real: eleven pages call
`listAllRoles()` to fill assignee dropdowns, and restricting the table without
replacing that would empty every one of them for non-admins. The other was the
phone lookup in Finding 8, which never worked.

`20260790` adds `rma_staff_directory()` — `SECURITY DEFINER`, staff-only,
returning `user_email`, `role` and `status` and nothing else — and drops the
wide policy, leaving `user_read_own` (own row, or an administrator). The eight
staff pages now call `db.userRoles.directory()`; User Management and the two
Control Panel screens keep `listAllRoles()` and are already admin-gated.

The migration refuses to apply if `user_roles` would be left with no SELECT
policy, because `finishLogin()` treats an unreadable row as no access — that
would deny every sign-in rather than fail visibly.

It also carries a query worth running afterwards:

```sql
SELECT count(*) FROM public.user_roles WHERE password_hash IS NOT NULL;
```

Zero means the column is dead weight and can be dropped. Non-zero means it is a
credential store nobody is maintaining.

---


## Finding 6 follow-up verified

`20260790` applied and re-measured with `20260823_probe_roles.sql`:

| identity | `user_roles` rows visible |
|---|---|
| viewer, technician, sales_rep, accountant, manager | 1 — their own |
| admin | 24 |
| suspended, expired | 1 — their own, which the AccessDenied screen needs |
| norow | 0 |

Everything else unchanged from the previous run. `password_hash` and the
permission maps are now administrator surface only.

---

## Finding 9 — swallowed errors, and which ones actually mislead

Three of the findings above share one cause. Suspension reported success and
did nothing. Backup reported "Complete backup exported successfully" and
covered nine tables of fifty-three. CRM notifications reported nothing at all
and never sent. In each case the failure existed and was discarded.

So the whole codebase was swept for discarded failures:

| pattern | count | files |
|---|---|---|
| `.catch(() => {})` | 160 | 32 |
| `catch {}` | 18 | 12 |
| catch that only writes to the console | 11 | 9 |

**Most of these are correct.** Roughly 155 of the 160 are attached to
`db.auditLog.log`, `db.userActivity.create` or `db.activities.logSystem` —
audit writes that trail a user action. If writing the audit row fails, the
action itself should still succeed; swallowing there is a deliberate and right
choice. Likewise `safeStorage`, whose entire purpose is to make localStorage
failures non-fatal, and the webhook dispatch, which is fire-and-forget by
design.

The ones that matter are where a **user-visible action** fails quietly. Four:

**`Leads/index.jsx` — lead conversion put the deal in the wrong stage.**

```js
db.deals.moveStage(result.deal.id, convertForm.stage_id).catch(() => {})
```

Not awaited, error discarded, and missing the `actorEmail` third argument that
every other `moveStage` call passes. A failure left the new deal in the
pipeline's *first* stage rather than the one just chosen in that form, under a
"Lead converted" toast, with no actor recorded. Now awaited, with the actor,
and a failure reports partial success — the conversion did happen, and saying
otherwise would send the user hunting for a deal that exists. The same handler
also invalidated only `['leads']`, leaving the Pipeline board and Customers
list stale even on success; it now invalidates `['deals']` and `['customers']`
too.

**`Purchasing/_modals.jsx` (×2) — an empty product picker meant "broken", not
"empty".** `db.products.list().then(setProducts).catch(() => {})` left
`products` as `[]`, which renders identically to a vendor with no products.
Now reports.

**`AccountSettings.jsx` — notification preferences stopped following the user.**
localStorage is the fast path and keeps the setting on that device, so nothing
is lost locally, but the account-level write failing meant the preference
silently stopped syncing to another browser. Warned once rather than per
toggle: this fires on every switch and a toast each time would be noise.

**`AppearanceContext.jsx` — appearance settings "didn't stick".** The local
update is optimistic so the interface responds at once; the empty `catch {}`
meant a failed write simply reverted at the next sign-in with nothing said. The
user's reasonable conclusion is that the feature is broken, not that saving
failed. Now reports and returns whether it persisted.

### Coverage

All 189 sites were classified; four were changed. This is triage against one
question — *does a person believe something happened that did not?* — not a
policy that every error must surface. `notifications.markRead` and the
quotation PDF's approval lookup were judged and left: the first self-corrects
on the next read, the second degrades a document rather than losing data.

Two things worth carrying forward from doing it:

- `captureException` was **not imported** in `crmEventHandlers.ts` or
  `Purchasing/_modals.jsx`. Both would have thrown a `ReferenceError` the first
  time the new reporting ran. Lint stayed green: `no-undef` is off for
  TypeScript files and the Vite build does not resolve globals. A green gate
  does not mean a name resolves.
- Reporting a *partial* success is its own category, and it came up three
  times now — restore that wrote some tables before failing, a conversion whose
  second step failed, an appearance change applied locally but not saved.
  "Failed" is as wrong as "succeeded" in all three.

---


## Backup and restore — the drill

Finding 5 rebuilt the module from 9 tables to 53 and locked the manifest to the
app's real table list. What it did not do was run anything. This is that, as
far as it can be taken without a signed-in session.

### The foreign-key order is now checked against reality

A restore writes tables in `BACKUP_TABLES` order, in one pass, with immediate
constraints. If any child is written before its parent the restore dies partway
— and nobody finds out until the day they need it.

That order was reasoned out by hand and spot-checked against twenty
parent/child pairs. Twenty is not all of them.
`supabase/manual/20260825_verify_restore_order.sql` checks **every foreign key
the database actually has**, in three categories:

- a child ordered before its parent — the restore would fail here
- a parent no table in the manifest restores — the child rows have nothing to
  point at
- self-referencing keys, where table order cannot help: within one table a row
  inserted before its own parent row fails, and row order inside a chunk is not
  guaranteed. Informational, but worth knowing rather than discovering.

The SQL embeds the manifest order, because SQL cannot import a JS array — which
is the snapshot pattern that caused several findings in this review. So
`src/test/restoreOrder.test.js` locks the two together: change `BACKUP_TABLES`
without regenerating the SQL and the test fails, rather than the SQL quietly
validating an order the code no longer uses.

### The logic is exercised end to end against a stand-in client

`src/test/backupRoundTrip.test.js` runs the real `exportAll` and `importAll`
against a fake PostgREST client that records how it was called. Fifteen cases,
covering precisely the things that were broken before:

| behaviour | why it is here |
|---|---|
| pages a 2,500-row table in three requests | the old code issued one unbounded select and lost everything past the row cap |
| stops when a page comes back short | otherwise it loops forever |
| a missing table is skipped, not fatal | a backup should not fail because one optional feature was never provisioned |
| no `api_key` or `smtp_password` in the output | H-6, second line of defence behind the column-limited select |
| writes in manifest order | the property a restore into an empty database depends on |
| chunks 1,200 rows as 500/500/200 | the old code sent one request per table |
| restores a v1.0 file via the legacy key map | old backups must still import |
| export-only tables are not written, and say why | restoring the queue would re-send every pending notification |
| a mid-restore failure preserves what landed | "failed" alone invites a second restore onto half-written data |
| full round trip: 1,103 rows out, 1,103 rows back | |

**These tests were mutation-checked.** Setting `CHUNK` to 99999 fails the
chunking case; setting `PAGE` to 100000 fails the pagination case. A test that
cannot fail is not evidence, and this review has produced three detectors that
passed for the wrong reason already.

### The order check found two real violations

Run against the live foreign keys, it reported exactly what the twenty
hand-written spot checks could not see:

| child | parent | why |
|---|---|---|
| `inventory_units` | `vendor_invoices` | `vendor_invoice_id` records the invoice a unit arrived on. Purchasing sat *after* inventory — a grouping that reads sensibly and breaks a restore. |
| `leads` | `deals` | `converted_deal_id` points at the deal a lead became. "Lead, then deal" is the natural reading and the wrong order. |

Both would have failed a restore into an empty database partway through, and
neither is the kind of thing that shows up until the day it matters. Fixed by
moving the purchasing block ahead of inventory and swapping deals and leads.
Both pairs are now pinned in `backupCoverage.test.js` as well, so a future
reshuffle fails in CI rather than waiting for someone to re-run the SQL.

The five SELF-REFERENCE rows — `activities`, `ticket_comments` and the three
`*_applications` tables — are expected and informational. Each is nullable, so
the risk only materialises if a parent row happens to sort after its child
inside the same chunk.

This is the argument for the whole exercise in miniature: the order was
reasoned about carefully, spot-checked, and still wrong in two places. Asking
the database was the only thing that found it.

### What is still not done

An actual export-and-restore through the browser, against the live project.
That needs a signed-in session, and the one in this environment expired. The
manifest, the ordering, the pagination, the chunking and the failure reporting
are all verified; what is unverified is the file download, the file upload, and
the RLS behaviour of a restore performed by a real administrator — a restore
writes through the caller's session, so every policy applies to it.

### The drill found two more tables missing from the backup

Thinking through what a restore actually does turned up a flaw in how coverage
was being measured. `backupCoverage.test.js` derived the expected table list
from every `.from(...)` call in the app — which is not the set of tables that
exist. It is the set the app reads *directly*, and it missed four reached only
through RPCs and triggers:

| table | verdict |
|---|---|
| `document_sequences` | **added** — holds `last_value` for every document code series. Restoring without it restarts numbering at 1, and the next invoice collides with one just restored on its unique `inv_code`. Export-only: the table refuses all client access by design, so an administrator has to reinstate it in SQL. |
| `product_images` | **added** — real data, the URL and storage path of every product photo |
| `email_queue` | excluded — a transient outbound spool; restoring it re-sends mail |
| `user_permissions` | excluded — a dead Base44 table holding no live state |

The two exclusions are now named in `INTENTIONALLY_NOT_BACKED_UP` with reasons,
and a test asserts every live table is either in the manifest or in that list.
Coverage is measured against the schema now, not against call sites.

`stock_moves` was also reclassified as export-only. It was in the manifest as
restorable, but `no_direct_client_insert` refuses every client write by design
— so a restore would have reported a failure on that table every single time.

That last point generalises, and it is the thing to watch when the real drill
finally runs: **`importAll` upserts through the caller's session, so every RLS
policy applies to the restore itself.** A table the database refuses to let a
client write cannot be restored from the browser, however complete the export
is. `stock_moves` and `document_sequences` are the two that fall in that
bracket, and both are now export-only for exactly that reason — captured in the
file, reinstated by an administrator in SQL.

Whether any others behave that way under a real administrator session is
unknown until someone runs it. The restore now reports partial success with the
table names, so if more turn up they will be named rather than silently
skipped.

---


## Still to cover

Findings 1 and 2 covered the anonymous security surface, Finding 3 the
first-user path, Finding 5 backup and restore, and Finding 6 the authenticated
one — all applied and measured against the live database. What is left:

**Outstanding, needs someone to run SQL:**

- **Save the schema baseline** — everything it depends on (20260787 through
  20260790) is now applied, so regenerating and committing it is unblocked.
- **`SELECT count(*) FROM user_roles WHERE password_hash IS NOT NULL`** — one
  line, decides whether that legacy column is dead weight or an unmaintained
  credential store.
- **Save the schema baseline** (Finding 4) — but only *after* `20260787` and
  `20260788`. The
  dump taken before it enshrines the very policies Finding 6 removes;
  committing that version would preserve the hole in the one file a fresh
  install is built from. Regenerate, then save as
  `supabase/migrations/00000000_baseline_schema.sql`.

`20260821_check_secret_tables.sql` has been run. All six tables have RLS on
with policies; `email_settings` is admin-only, so the SMTP password and API key
are not readable by ordinary staff. Two of its findings fed into Finding 6.

**Not yet looked at:**

- **`user_roles` is readable in full by every staff role**, including
  `password_hash` and each user's `permissions` map. The policy was widened in
  20260787 only so the notification handlers could resolve a rep's phone
  number. The right fix is probably a `SECURITY DEFINER` lookup for that one
  field and a narrower policy — but that is the same pattern being
  investigated by `20260824`, so it waits for that answer.
- **Empty states.** What the app looks like with 0 deals rather than 56. Every
  page was built and verified against a full fixture set.
- **The backup drill through the browser.** Everything testable without a
  session is done and green; what remains is one administrator clicking Export
  Complete Backup, then Restore, and reporting what the summary says. Run
  `20260825_verify_restore_order.sql` first — it is read-only and confirms the
  foreign-key order will hold.
- **The anon GRANTs.** The dump shows `GRANT ALL … TO anon` on roughly half the
  tables, including `deals`, `payments`, `quotations` and all four views. RLS
  refuses every one of them today — the probe proves it — so nothing is
  exposed. But it means RLS is the *only* thing standing there, with no grant
  layer behind it. Revoking all but `kb_articles` SELECT would be
  defence-in-depth; deliberately left as a separate change so it can be
  reverted on its own if something turns out to depend on it.

**Noted in passing, not pursued:**

- `BackupRestore.jsx` gates itself on `currentUserRole !== 'admin' &&
  currentUserRole !== 'super_admin'` rather than `canDo`. It is the same
  hardcoded-role-list pattern the permissions rebuild removed elsewhere. The
  gate is correct today; it will drift the moment the matrix changes.
