# myRMA → QDS CRM — Full System Audit

**Auditor role:** CTO / Chief Architect / Security Lead / QA Director (independent, adversarial)
**Date:** 2026-07-02
**Branch audited:** `test`
**Scope:** entire repo — source, DB migrations, RPCs, Edge Functions, RLS, plan docs, CI, infra
**Method:** evidence-first. Every finding below cites a file/line I actually read. Where I could not verify against a live database, I say so explicitly.

> This document doubles as a **fix tracker**. Each finding has an ID and a **Status** field. Update Status (`OPEN` → `IN PROGRESS` → `FIXED` / `WON'T FIX`) as you work. Do not delete findings — strike them through and mark `FIXED` so the history stays auditable.

> **REMEDIATION STATUS (updated 2026-07-02, same day):** CRIT-1, CRIT-2, CRIT-3, and CRIT-4 are now **FIXED and empirically verified against the live database** (see the Fix Log entries under §2 and the fix-tracking table at the bottom — 4/4 checks PASS in `scripts/manual/archive/VERIFY_audit_hardening.sql`). The Executive Summary and scores immediately below are the **original point-in-time snapshot** and are left unedited as the historical record; they no longer reflect current risk on the money/authz layer. CRIT-5 (payment/CN reversal) remains open by design — it's a feature addition, not a patch. See the fix-tracking table at the end of this document for current status of every finding.

---

## 1. Executive Summary

This is a genuinely well-architected mid-market CRM/ERP-lite for its size. The data-layer discipline (single `db.*` gateway, typed Row interfaces, append-only `stock_moves` ledger, application-table pattern for credit-notes/payments, dual serialized/bulk stock model) is above the norm for a solo-built React+Supabase app. The engineering *intent* is strong.

But it is **not production-ready today**, and the gap is concentrated in the highest-stakes layer: **money and authorization**. The atomic RPCs that move money and inventory are `SECURITY DEFINER` (they bypass RLS by design) yet several have **no internal role check, no `REVOKE` from public, and no amount validation**. The audit trail is **client-supplied and therefore spoofable**. And the entire Sprint 8/9 migration set (`20260737`–`20260750`) **has never been applied to a live database** — the same class of "it compiled but the column didn't exist" bug that bit `inventory_units.product_id` this very sprint is still latent across ~14 unapplied migrations.

### Scores (1–10)

| Dimension | Score | One-line justification |
|---|---:|---|
| **Overall** | **6.0** | Strong bones, Critical holes in the money/auth layer, large unverified surface |
| Product | 7.5 | Coherent funnel Lead→Deal→QT→SO→Invoice→CN→Payment; real gaps (no returns-to-vendor, no partial-payment enforcement) |
| UI | 7.0 | Consistent design tokens, good component library; some shipped i18n breakage |
| UX | 6.5 | Deep-linkable tabs, bulk bars; but destructive/irreversible money ops with weak confirmation |
| Frontend | 7.0 | Clean gateway pattern, TanStack Query, lazy routes; a few 1,500–1,900-line God components |
| Backend (RPC/logic) | **4.5** | Atomic transactions are good; **missing authz + amount validation on money RPCs** |
| Database | 7.0 | Thoughtful schema, idempotent migrations, RLS everywhere; missing FK indexes, unapplied set |
| **Security** | **4.0** | SECURITY DEFINER money RPCs with no guard; spoofable actor; CORS `*`; no security headers |
| Performance | 6.0 | 5,000-row client-side caps; `listUsers(1000)` scan; fine at current scale, ceilings are real |
| Scalability | 5.5 | Architecture scales to ~1k users/tenant; client-side filtering + no pagination on hot lists caps it |
| Testing | **3.5** | 277 tests, but **zero** cover the RPC/money/inventory paths — the exact code most likely to lose money |
| DevOps | 5.0 | CI exists but only runs on `main`, which you never push to; no staging DB, manual migration apply |
| Docs | 8.5 | Exceptional. CLAUDE.md/CONSTITUTION/plan are unusually thorough and mostly accurate |

### The five questions

- **Is this production-ready?** No. Not until CRIT-1 through CRIT-4 are closed and the migration set is applied + click-through verified.
- **Can it scale?** To a few hundred concurrent users and low-tens-of-thousands of rows per table, yes. Beyond that, the client-side 5k-row filtering model and the 1,000-user `listUsers` scan are hard ceilings that need server-side pagination.
- **Is it maintainable?** Mostly yes — the gateway/module discipline is the reason. Watch the 1,500–1,900-line page components.
- **Is it secure?** No — see Security section. The authorization model has a hole a read-only `viewer` can drive a truck through.
- **Redesign any core parts?** No wholesale redesign. The **authorization enforcement layer** for RPCs needs to be rebuilt (guards + revoke + server-derived actor), and the **money-mutation RPCs** need input validation. That's hardening, not re-architecture.

**Verdict: APPROVED WITH MAJOR CHANGES** (justified in the Final Verdict section). It is emphatically *not* approved for production in its current state.

---

## 2. Critical Findings

### CRIT-1 — Money-mutating RPCs are `SECURITY DEFINER` with no authorization check and no `REVOKE`
**Severity:** Critical · **Priority:** Immediate · **Status:** OPEN

**Location:** `supabase/migrations/20260735_cn_payment_lifecycle_rpcs.sql` — `record_payment` (L152), `issue_credit_note` (L11), `void_credit_note`. Also verify `20260743_receive_stock_rpc.sql` grant scope.

**Problem.** These functions are declared `SECURITY DEFINER` (they run as the owner and **bypass RLS**), but:
1. `grep` for `rma_is_manager_or_above` / `rma_is_staff` in `20260735` returns **0 matches** — there is no role check inside the function body.
2. There is **no `REVOKE EXECUTE ... FROM public` / `anon`** and no scoped `GRANT`. In Postgres, functions default to `EXECUTE` for `PUBLIC`. In a Supabase project that means the `authenticated` role — and potentially `anon` via `/rest/v1/rpc/record_payment` — can call them.

The RLS policies you *did* write are therefore dead weight for these paths. You correctly set `manager_insert_payment_applications` to `rma_is_manager_or_above()` (`20260727_crm_payments.sql:101`), but `record_payment` inserts into `payment_applications` **as the definer**, bypassing that policy entirely. Net effect: a `viewer` (your read-only role) can record payments, apply credit notes, and mark invoices paid.

**This directly contradicts the plan.** `CLAUDE.md` and `MASTER_UPGRADE_PLAN.md` both state `20260735`'s RPCs "all enforce role." They do not. The doc is wrong; the code has no guard.

**Impact.** Privilege escalation + financial-integrity compromise. Any authenticated user regardless of role can zero out receivables, mark invoices paid, or issue credit notes. If `anon` execute is not revoked, this may be reachable pre-auth.

**Root cause.** The role check was pushed to RLS, then the RPCs were made `SECURITY DEFINER` (to do multi-table atomic writes), which silently opts out of RLS. The two decisions were made separately and never reconciled.

**Fix.**
- Add `IF NOT public.rma_is_manager_or_above() THEN RAISE EXCEPTION 'not authorized'; END IF;` (or `rma_is_staff()` where appropriate) as the first statement of every `SECURITY DEFINER` money/inventory RPC.
- Add to each migration: `REVOKE ALL ON FUNCTION public.record_payment(...) FROM public, anon;` then `GRANT EXECUTE ... TO authenticated;`.
- Audit *every* `SECURITY DEFINER` function the same way: `record_payment`, `issue_credit_note`, `void_credit_note`, `receive_stock`, `transfer_stock`, `adjust_stock`, `archive_warehouse`, `recalculate_stock`, `receive_vendor_invoice`, the `*_units` / `*_warehouse_stock` reservation RPCs, `funnel_reserve_line`. (`approve_sales_order`, `post_invoice`, `void_invoice`, `confirm/cancel_sales_order` *do* have the guard — grep confirms 2 matches each — use them as the template.)

---

### CRIT-2 — `record_payment` does not validate allocation sum or customer ownership → invoices can be marked paid with money that doesn't exist
**Severity:** Critical · **Priority:** Immediate · **Status:** OPEN

**Location:** `supabase/migrations/20260735_cn_payment_lifecycle_rpcs.sql:116-164`

**Problem.** The allocation loop inserts `payment_applications` and bumps `crm_invoices.amount_paid` with **no check that `sum(allocations) ≤ p_amount`**, and **no check that the invoice's `customer_id` matches the payment's `customer_id`**. Concretely:
- A **$100 payment can be allocated as $500** across five invoices. Each `UPDATE` uses `LEAST(amount_paid + amount, total)`, so five invoices get marked paid. The `sync_payment_balance` trigger then computes `unapplied_amount = amount − sum(applied) = 100 − 500 = −400`. There is **no `CHECK (unapplied_amount >= 0)`** on the table (`20260727_crm_payments.sql`), so it silently persists a negative.
- Customer A's payment can settle **Customer B's** invoice — the loop never joins on customer.

**Impact.** Receivables can be marked collected without corresponding cash. This is the single most damaging class of bug an AR module can have: the books say paid, the bank says otherwise. It is reachable today by the very UI you built (a fat-fingered allocation) and trivially by anyone hitting the RPC directly (see CRIT-1).

**Root cause.** The RPC treats the client-provided `p_allocations` JSON as trusted and pre-validated. The UI does clamp "sum ≤ total" client-side, but the server enforces nothing.

**Fix.**
- In `record_payment`, accumulate `v_sum := v_sum + v_alloc.amount` and `RAISE EXCEPTION` if `v_sum > p_amount`.
- Validate each `invoice_id`'s `customer_id = p_customer_id` before applying.
- Add table constraints: `CHECK (unapplied_amount >= 0)` on `payments`, and consider `CHECK (amount_applied <= (SELECT total FROM crm_invoices ...))` via trigger, or at minimum keep the sum guard in the RPC.
- Mirror the same allocation-sum guard into `issue_credit_note`'s apply path.

---

### CRIT-3 — The audit "who" (`actor_email` / `created_by` / `applied_by`) is client-supplied and spoofable
**Severity:** Critical (integrity) · **Priority:** Immediate · **Status:** OPEN

**Location:** every lifecycle RPC takes `p_actor_email text` from the client — e.g. `record_payment(... p_actor_email ...)` (`20260735:104`), `approve_sales_order(p_actor_email)`, `receive_stock`, etc. The API layer forwards whatever the browser passes: `payments.record({ created_by })` → `p_actor_email: input.created_by` (`src/api/db/payments.ts:80`).

**Problem.** Because the actor is a parameter, the recorded "who did this" is whatever string the caller sends. A user can attribute their own action to anyone — `created_by: 'ceo@company.com'`. Inside a `SECURITY DEFINER` function you have the real identity for free via `public.rma_current_user_email()` (it reads `auth.jwt()`), but the code ignores it and trusts the parameter instead.

**Impact.** The audit trail — the thing you'd rely on in a dispute, a fraud investigation, or a compliance review — is not trustworthy. Every "recorded by" field across payments, credit notes, stock receipts, and approvals can be forged.

**Root cause.** `p_actor_email` was plumbed through from the UI before the RLS helper functions were adopted, and never revisited.

**Fix.** Inside each `SECURITY DEFINER` RPC, **derive the actor from `public.rma_current_user_email()`** and ignore (or drop) the `p_actor_email` parameter. Keep the parameter only for genuine system/automation callers, and gate that behind a service-role check. This is a small, mechanical change with large integrity payoff.

---

### CRIT-4 — Sprint 8/9 migration set (`20260737`–`20260750`) is unapplied and unverified against a live database
**Severity:** Critical (release-blocking) · **Priority:** Immediate · **Status:** OPEN

**Location:** `supabase/migrations/20260737…20260750`; `CLAUDE.md` active-sprint line: *"BUILT, not yet VERIFIED … migrations need applying + a live click-through."*

**Problem.** ~14 migrations plus all the new Inventory/Purchasing UI and API code have **never run against a real database**. This is not hypothetical risk: **this exact sprint** you discovered `inventory_units.product_id` did not exist in production despite `reserve_units`/`funnel_reserve_line` referencing it since Sprint 6 — Postgres does **not** validate column references in `plpgsql` at `CREATE FUNCTION` time, so the breakage sat silent. The same failure mode applies to every unapplied RPC here: they will "install" cleanly and only fail at first call.

**Impact.** You do not actually know that Sprint 8/9 works. The green local gate (tests/lint/build) proves the *JavaScript* compiles; it proves nothing about the SQL contract, because there are no DB-level tests (see HIGH-3).

**Root cause.** No staging database and no migration-in-CI. Migrations are hand-applied via the Supabase SQL editor, one at a time, reactively.

**Fix.** Apply `20260737`→`20260750` in order to a **staging** project first, then run the click-through QA. Longer term: stand up a disposable Postgres in CI (`supabase db reset` against the migration folder) so "the migrations apply cleanly and the RPCs resolve their columns" becomes an automated gate. Until this is done, treat Sprint 8/9 as *unverified*, not *complete*.

---

### CRIT-5 — Void/reversal leaves AR permanently wrong (no compensating entry)
**Severity:** High→Critical for an accounting module · **Priority:** Sprint 1 · **Status:** OPEN

**Location:** `src/api/db/payments.ts:145` (`void_` blocks if applied), `creditNotes.void_()`, `crmInvoices.void_()`.

**Problem.** By design, voiding a payment/CN/invoice that has *already been applied* is **blocked, not reversed**. That's a defensible v1 choice to avoid GL complexity — but the consequence is that a genuinely erroneous applied payment can **never be corrected** through the app. There is no "reverse and re-book" path. The books can drift and the only remedy is manual SQL.

**Impact.** In real operation, mistakes happen (wrong amount, wrong invoice, wrong customer — see CRIT-2). With no reversal, the module has no self-healing path; errors calcify. For anything you'd show an accountant, this is a correctness gap, not just a convenience gap.

**Fix.** Implement a **reversal/contra** operation: voiding an applied payment inserts a negative `payment_application` (or a reversal row) that restores `amount_paid`, rather than mutating history. This is the standard ledger pattern and keeps the append-only integrity you already value in `stock_moves`. Scope it explicitly for the next accounting pass.

---

## 3. High-Severity Findings

### HIGH-1 — CI runs only on `main`, which you are forbidden to push to
**Severity:** High · **Priority:** Sprint 1 · **Status:** OPEN
`.github/workflows/ci.yml:4-7` triggers only on push/PR to `main`. Your standing rule (memory: *git-branch-workflow*) is "never push to `main`; push to `test`." So **CI effectively never runs** on the branch where all work happens. The gates are green because you run them by hand, which is fragile and unenforced. **Fix:** add `test` (and `pull_request` targeting any branch) to the CI triggers, or open PRs `test`→`main` so CI actually gates merges.

### HIGH-2 — Non-atomic client-side balance update in `payments.applyToInvoice`
**Severity:** High · **Priority:** Sprint 1 · **Status:** OPEN
`src/api/db/payments.ts:110-137`: inserts the application row, then in **separate** JS awaits reads `crm_invoices` and writes back `amount_paid`. Two concurrent applies to the same invoice race (lost update), and a crash between insert and update leaves the application row without the balance change. The RPC path (`record_payment`) does this atomically in one transaction; this path does not. **Fix:** move `applyToInvoice` into a `SECURITY DEFINER` RPC (with the CRIT-1 guard) that does insert+recalc in one transaction, exactly like `record_payment`.

### HIGH-3 — Zero automated tests on the money/inventory RPC paths
**Severity:** High · **Priority:** Sprint 1 · **Status:** OPEN
The 7 test suites (`src/test/*`) cover constants, permissions, Zod schemas, TemplateEngine, `useURLTab`, `_utils`, audit queue — all pure/client logic. **None** exercise `record_payment`, the reservation RPCs, `receive_vendor_invoice`, or the funnel lifecycle. The most complex, most irreversible, most money-adjacent code has **no coverage**. "277 tests pass" is reassuring about the wrong layer. **Fix:** add pgTAP or a seeded integration suite against an ephemeral Postgres that asserts: over-allocation is rejected (CRIT-2), a `viewer` is denied (CRIT-1), reserve→deliver→release conserves quantity, and double-receipt is idempotent.

### HIGH-4 — No security headers; CORS wildcard on privileged Edge Functions
**Severity:** High · **Priority:** Sprint 1 · **Status:** OPEN
`vercel.json` has no `headers` block — no CSP, HSTS, `X-Frame-Options`, `X-Content-Type-Options`, or `Referrer-Policy`. The app is clickjackable and has no XSS defense-in-depth. Separately, every Edge Function sets `Access-Control-Allow-Origin: '*'` including `admin-reset-password`. The bearer-token model limits the blast radius (no cookie auth to ride), but the wildcard is still needlessly permissive. **Fix:** add a `headers` block in `vercel.json` (CSP, HSTS, frame-deny, nosniff); pin CORS to your known origins.

### HIGH-5 — `admin-reset-password` scans only the first 1,000 auth users
**Severity:** High (correctness + scale) · **Priority:** Sprint 2 · **Status:** OPEN
`supabase/functions/admin-reset-password/index.ts:86-93`: `listUsers({ perPage: 1000 })` then `users.find(...)`. Past 1,000 accounts, existing users are **not found** → the code falls into the "create user" branch and `createUser` fails on a duplicate, so **password resets silently break** for anyone beyond the first page. It's also an O(n) fetch on every call. **Fix:** use `getUserByEmail` / a filtered admin query instead of listing-then-scanning.

### HIGH-6 — 50 broken i18n keys shipped in `WarehousesTab.jsx`
**Severity:** High (visible UI defect) · **Priority:** Sprint 1 · **Status:** OPEN
`grep -c "t('inventory:"` = **50** in `src/pages/Inventory/WarehousesTab.jsx`. The app uses a single default namespace with dot-notation; the colon form `t('inventory:foo')` is i18next *namespace* syntax that doesn't resolve here, so these render the raw key or a fallback. This is a real, shipped, user-visible defect on a page you just rebuilt. **Fix:** replace all `inventory:` colon keys with `inventory.` dot keys and confirm the keys exist in both `en.json` and `ar.json`.

### HIGH-7 — Missing indexes on high-traffic foreign keys
**Severity:** High (perf, latent) · **Priority:** Sprint 2 · **Status:** OPEN
Hot lookups filter by FK (`payment_applications.invoice_id`, `crm_invoices.so_id`, `stock_moves.doc_id/ref_id`, `inventory_units.product_id/reserved_by_doc_id`). Postgres does **not** auto-index FKs. `convertToInvoice` already does `select ... where so_id = ...` (`salesOrders.ts:240`) and the ledger replay filters `stock_moves` by `doc_id` on every reserve/release. At low row counts this is invisible; it degrades to seq-scans as data grows. **Fix:** add explicit `CREATE INDEX` for each FK used in a `WHERE`/`JOIN`, in a new idempotent migration.

---

## 4. Medium-Severity Findings

- **MED-1 — God components.** `CustomerDetails.jsx` (1,913 lines), `ControlPanel.jsx` (1,805), `RMATickets/index.jsx` (1,703), `BrandingSettings.jsx` (1,487). These are maintenance and merge-conflict hotspots and exceed any reasonable review budget. Extract tabs/sections into folder-based sub-components (you already do this well for Inventory/Pipeline — apply the same to these). **Status:** OPEN
- **MED-2 — Client-side 5,000-row caps with in-memory filtering.** `db.customers/rmaTickets/products.list()` cap at 5k and the pages filter/sort in JS (documented in CLAUDE.md as intentional). This is a hard scale ceiling; the *first* tenant to exceed 5k rows silently loses data from views. Add a visible "showing first 5,000" banner now, and plan server-side pagination before it bites. **Status:** OPEN
- **MED-3 — Two permanent "Receive Stock" paths.** `receive_stock` (interim, no audit trail) and `receive_vendor_invoice` (permanent, traceable) both live in the codebase and both write stock. Operators can create stock with no vendor provenance via the interim path. Decide: gate the interim path behind a permission, or retire it once Purchasing is live. **Status:** OPEN
- **MED-4 — Credit limit is decorative.** `customers.credit_limit` is a soft warning, never enforced (by design). Fine for v1, but call it out to stakeholders — the system will happily let a customer exceed their limit with no block or approval step. **Status:** OPEN
- **MED-5 — `reserved_quantity` can be reconciled but `quantity` cannot.** `recalculate_stock` only reconciles `reserved_quantity`, not the on-hand `quantity` (by design). If `quantity` ever drifts (bad manual adjust, failed partial receipt), there is no repair path short of SQL. **Status:** OPEN
- **MED-6 — No optimistic-concurrency on document edits.** Sales/purchase document updates are last-write-wins (`update(Partial<Row>)`). Two managers editing the same invoice silently clobber each other. Consider an `updated_at` precondition. **Status:** OPEN
- ~~**MED-7 — `send-whatsapp` / `notification-worker` verify a JWT but not a role.**~~ They called `getUser()` (authenticated) but any authenticated user could trigger sends/worker runs. **Status: FIXED** — both now gate the Bearer-token path to non-viewer staff. **Severity upgrade found while fixing this:** `notification-worker`'s third auth branch was `!req.headers.get('x-trigger-source')` — "reject only if the header is *absent*" — so any value at all (not just the intended `pg_cron`) satisfied it, meaning any **unauthenticated** caller (not just a low-privilege one) could drain the queue and burn send quota. This was more severe than originally described. Tightened to an exact match against what the pg_cron migration actually sends; full closure needs the cron job to also send a Vault-backed secret (follow-up, not done — see `CLAUDE.md`).
- **MED-8 — Stray nested `myrma-app/` directory** containing a duplicate `CLAUDE.md`, tracked in git status. Repo hygiene — remove or explain it. **Status:** OPEN

---

## 5. Hidden Technical Debt

1. **RLS is partially bypassed by design but not documented as such.** Every `SECURITY DEFINER` RPC is a hole in the RLS model. There is no single place that lists which functions bypass RLS and what guards each one carries. Create a `SECURITY.md` inventory. (Ties to CRIT-1.)
2. **`p_actor_email` plumbing** threads spoofable identity through the entire API→RPC boundary (CRIT-3). Removing it touches every lifecycle module — pay it down once, deliberately.
3. **Dead/duplicate tabs.** CLAUDE.md itself notes `CompanyStockTab.jsx`/`ManufacturerTab.jsx` are "dead as top-level tabs — only their modal exports live." Dead code that still imports and builds is future confusion.
4. **`invoices` (legacy) vs `crm_invoices` coexistence.** The legacy `invoices` table + RLS (`20260526` §9) still exists and `Reports.jsx` still reads `invoices.*` i18n keys. Two invoice concepts in one system is a documented landmine.
5. **Migration numbering is a date-prefix fiction.** Files are `20260732…20260750` but represent one working session, not calendar days. Harmless, but it makes the migration log misleading as a timeline.
6. **`.find()` scans** (auth users, client-side lists) scattered where indexed lookups belong.

---

## 6. Architecture Weaknesses

- **Authorization is split across two enforcement planes** (RLS policies *and* in-RPC guards) with no single source of truth, and the `SECURITY DEFINER` RPCs silently defeat the RLS plane. This is the core architectural weakness and the root of CRIT-1/CRIT-3. Consolidate: **every** privileged mutation goes through a guarded RPC, and RLS becomes the read-side / direct-write backstop. Document the split.
- **No environment separation.** One Supabase project, migrations hand-applied to it. No staging = CRIT-4 is structural, not incidental.
- **The client is trusted for financial invariants.** Allocation sums, actor identity, and status transitions are validated in JS and re-trusted by the server. In a money system the server must re-derive and re-validate everything.
- **Single-tenant assumptions.** RLS scopes by role, not by org/tenant. If multi-tenant is ever on the roadmap (the plan hints at "QDS CRM" as a product), this is a from-scratch conversation, not a patch.

---

## 7. Product Gaps (vs. Odoo / ERPNext / QuickBooks)

| Gap | Benchmark behavior | Severity |
|---|---|---|
| No payment reversal / contra entries | Odoo/QB reverse via journal, never mutate history | High (CRIT-5) |
| No vendor returns / debit notes | Purchasing is one-directional (receive only) | Medium |
| Credit limit not enforced | Odoo blocks or warns-with-override at SO confirm | Medium |
| No dunning / payment reminders | Standard AR feature; you already have WhatsApp/email plumbing to reuse | Medium |
| No multi-currency | Single-currency assumed throughout | Low (scope) |
| No tax report / tax on documents beyond a `tax_pct` field | `quotations.ts` computes `tax_amount` per line but there's no tax summary/report | Medium |
| No bank reconciliation | Payments are recorded, never reconciled to a statement | Low (scope) |
| No approval thresholds | Approval-pool exists but any manager can approve any amount | Medium |

The funnel itself (Lead→Deal→QT→SO→Invoice→CN→Payment) is complete and coherent — better than ERPNext's default UX in places. The gaps are in the *accounting rigor* around it, which matches your stated "not a full GL" scope — but CRIT-5 (no reversal) is the one that crosses from "acceptable v1 scope" into "operationally broken."

---

## 8. Refactor Recommendations

1. **Rebuild the RPC authorization layer** (CRIT-1/2/3): add a standard guard preamble (`role check` + `actor := rma_current_user_email()` + input validation) to every `SECURITY DEFINER` function, and `REVOKE`/scoped-`GRANT` each. Consider a shared `assert_manager()` helper to avoid copy-paste drift.
2. **Move `payments.applyToInvoice` and any remaining read-then-write balance updates into transactional RPCs** (HIGH-2).
3. **Add a DB-integration test tier** (HIGH-3, CRIT-4) — ephemeral Postgres + `supabase db reset` in CI, plus pgTAP assertions on invariants.
4. **Decompose the 4 God components** (MED-1) into folder-based sub-components.
5. **Retire legacy `invoices` and dead tabs** (debt #3/#4) or document why they must stay.

---

## 9. Final Strategic Roadmap (reordered by risk, not by feature)

**Sprint H (Hardening — do before ANY launch):**
- CRIT-1: guard + revoke all `SECURITY DEFINER` RPCs.
- CRIT-2: allocation-sum + customer-match validation + `unapplied_amount >= 0` constraint.
- CRIT-3: derive actor server-side.
- CRIT-4: apply `20260737`–`20260750` to staging, run click-through QA.
- HIGH-1: fix CI triggers. HIGH-6: fix the 50 i18n keys.

**Sprint 1 (Correctness & Safety):**
- CRIT-5: payment/CN reversal via contra entries.
- HIGH-2 (transactional apply), HIGH-3 (RPC integration tests), HIGH-4 (security headers/CORS).

**Sprint 2 (Scale & Hygiene):**
- HIGH-5 (`getUserByEmail`), HIGH-7 (FK indexes), MED-1 (decompose), MED-2 (pagination plan), debt cleanup.

**Sprint 3 (Product depth):**
- Credit-limit enforcement w/ override, tax reporting, dunning via existing notification layer, approval thresholds.

---

## Final Verdict

# APPROVED WITH MAJOR CHANGES

**Justification.** The architecture is fundamentally sound and, in several places, genuinely good — the ledger, the application-table pattern, the dual-stock model, and the documentation discipline are the work of someone who thinks in systems. I am not recommending a redesign, because the bones don't need one.

But "approved" here means **approved to continue development**, not **approved for production**. Four Critical findings stand between this system and a safe launch, and three of them (CRIT-1/2/3) sit in the money-and-authorization layer where mistakes cost cash and trust: a read-only user can move money, a $100 payment can settle $500 of invoices, and the audit trail can be forged. The fourth (CRIT-4) means Sprint 8/9 is, strictly, unproven against a real database — and this sprint already proved that "it built" is not the same as "it works" in `plpgsql`.

None of these require re-architecture. They require a focused hardening sprint: guard the RPCs, validate the inputs, derive identity server-side, apply and click-through the migrations, and put the money paths under test. Do that, and this becomes a genuinely solid mid-market product. Ship it as-is, and the first motivated user — or the first fat-fingered allocation — corrupts your receivables.

**Do not go to production until CRIT-1 through CRIT-4 are `FIXED` in the tracker above.**

---

### Fix-tracking summary

| ID | Title | Severity | Status |
|---|---|---|---|
| CRIT-1 | SECURITY DEFINER money RPCs: no authz, no REVOKE | Critical | **FIXED** (`20260751`, `20260752`) |
| CRIT-2 | `record_payment`: no allocation-sum / customer validation | Critical | **FIXED** (`20260751`) |
| CRIT-3 | Spoofable client-supplied actor identity | Critical | **FIXED** — money in-function (`20260751`), inventory ledger via trigger (`20260753`) · residual: `inventory_units.reserved_by_email` convenience field |
| CRIT-4 | Sprint 8/9 migrations unapplied/unverified | Critical | **FIXED** — all 17 migrations (`20260737`–`20260753`) applied 2026-07-02; verified live via `scripts/manual/archive/VERIFY_audit_hardening.sql` (4/4 PASS) |
| CRIT-5 | No payment/CN reversal path | High→Crit | **FIXED** — applied 2026-07-02; verified live via `scripts/manual/archive/VERIFY_crit5_reversal.sql` (4/4 PASS) |
| HIGH-1 | CI only runs on `main` (never pushed to) | High | **FIXED** (`ci.yml`) |
| HIGH-2 | Non-atomic `applyToInvoice` balance update | High | **FIXED** (`20260751` + rewire) |
| HIGH-3 | Zero tests on RPC/money/inventory paths | High | **FIXED and verified** — 3 DB test files, 34 checks total, all confirmed live 2026-07-02: money/reversal (8/8), reserve/deliver/release (12/12), transfer/adjust/recalculate/restore/receive_vendor_invoice (14/14). Every inventory/purchasing RPC now has coverage, including the previously-broken `restore_units('active_rma')` path. |
| HIGH-4 | No security headers; CORS `*` | High | **FIXED** — headers (`vercel.json`) + CORS allowlist across all 8 Edge Functions (`ALLOWED_ORIGINS` secret, opt-in) |
| HIGH-5 | `admin-reset-password` 1,000-user scan cap | High | **FIXED** (paginated) |
| HIGH-6 | 50 broken `inventory:` i18n keys | High | **FIXED** (`WarehousesTab.jsx`) |
| HIGH-7 | Missing FK indexes | High | **NO CHANGE NEEDED** — all flagged FKs already indexed (audit overstated) |
| MED-1..8 | See §4 | Medium | OPEN |

*Update the Status column as fixes land. This file is the source of truth for the hardening sprint.*

---

## Fix Log — 2026-07-02 (hardening pass 1)

**Migrations added** (idempotent; **must be applied to staging then prod** — this is part of closing CRIT-4):
- `20260751_harden_money_rpcs.sql` — rewrites `record_payment` (manager+ guard, server-derived actor, per-allocation running-sum ≤ payment, customer-match + posted check with `FOR UPDATE`) and `issue_credit_note` (guard + server actor); de-clamps `sync_payment_balance` so over-allocation drives `unapplied_amount` negative; adds `CHECK (unapplied_amount >= 0)`; adds transactional `apply_payment_to_invoice` + `apply_credit_note_to_invoice` RPCs; `REVOKE`/scoped-`GRANT` on all four.
- `20260752_lockdown_rpc_execute.sql` — dynamically `REVOKE`s PUBLIC/anon EXECUTE and `GRANT`s authenticated/service_role across all 24 client-invoked RPCs (resolves overloads via `pg_proc`). Makes "not callable by anon" the default posture, not per-RPC luck.
- `20260753_stock_moves_actor_from_jwt.sql` — closes the inventory half of CRIT-3: a `BEFORE INSERT` trigger on the append-only `stock_moves` ledger overwrites `actor_email` with `rma_current_user_email()` whenever a real JWT is present. Covers every inventory/reservation/receipt RPC's ledger write in one object, without risky full-body rewrites of ~14 functions (several already amended by `20260738`/`20260742`). Residual: `inventory_units.reserved_by_email` (a convenience field on the current reservation) still carries the passed value — the authoritative audit trail (`stock_moves`) is now trustworthy.

**Code changed:**
- `src/api/db/payments.ts` — `applyToInvoice` now calls `apply_payment_to_invoice` RPC (was non-atomic read-then-write).
- `src/api/db/creditNotes.ts` — `applyToInvoice` now calls `apply_credit_note_to_invoice` RPC (previously inserted the application row but never reduced the invoice balance — latent correctness bug, now fixed).
- `.github/workflows/ci.yml` — triggers on `main` + `test` push and all PRs (was `main`-only).
- `vercel.json` — added CSP, HSTS, X-Frame-Options DENY, X-Content-Type-Options, Referrer-Policy, Permissions-Policy. *(CSP uses `'unsafe-inline'`/`'unsafe-eval'` for scripts — a pragmatic tradeoff vs. nonce-based CSP to avoid breaking the SPA; tighten later.)*
- `supabase/functions/admin-reset-password/index.ts` — paginates the auth-user lookup (was capped at first 1,000, silently breaking resets past that).
- `src/pages/Inventory/WarehousesTab.jsx` — 50 `t('inventory:…')` → `t('inventory.…')` (colon namespace didn't resolve).

**Gate:** 277/277 tests · 0 lint errors · production build ✓ (67 precache entries). *(SQL not runtime-verified — no live DB in this environment; see CRIT-4.)*

**Deferred (explicitly not done this pass):** CRIT-4 (apply migrations to a live DB + click-through — needs your Supabase), CRIT-5 (reversal/contra entries — a feature, not a patch), HIGH-3 (DB integration test tier), CORS origin pinning, and all MED items.

---

## Fix Log — 2026-07-02 (hardening pass 2)

- `20260753_stock_moves_actor_from_jwt.sql` — completes CRIT-3 for the inventory ledger (trigger-based JWT actor stamping; see fix note above). CRIT-3 is now **FIXED** across both money and inventory.

**Gate:** unchanged — this pass touched only SQL + this report + `CLAUDE.md`/`AGENTS.md`; no application code, so the prior green gate (277 tests / 0 lint / build ✓) still holds. SQL remains runtime-unverified (CRIT-4).

---

## Fix Log — 2026-07-02 (hardening pass 3 — live verification, CRIT-4 closed)

**Bug found and fixed before this could apply:** the first bundle attempt failed with `too many parameters specified for RAISE` — `20260751`'s over-allocation error used the *escaped-literal* `%%` (consumes zero arguments) while passing two (`v_sum`, `p_amount`). PL/pgSQL rejects this at function-compile time. Since the bundle runs as a single transaction, this rolled back all 17 migrations with nothing applied. Fixed to a real `%` placeholder; re-scanned the full pending batch for the same trap (clean, single occurrence). Regenerated `scripts/manual/archive/RUN_pending_20260737-20260753.sql` (rev 2) with the fix. This is exactly the class of failure CRIT-4 warned about: SQL that "looks done" but was never runtime-verified.

**Applied 2026-07-02:** all 17 pending migrations (`20260737`–`20260753`) ran successfully against the live database as one transaction.

**Verified 2026-07-02** via `scripts/manual/archive/VERIFY_audit_hardening.sql` (seeds throwaway rows, asserts, deletes them again) — **4/4 PASS**:

| Check | Result |
|---|---|
| Manager records a payment split 60/40 across two invoices | **PASS** — both invoices updated correctly |
| Over-allocation (70 allocated against a 50 payment) rejected | **PASS** — `Allocations (70.00) exceed payment amount (50)` |
| Viewer/technician denied from recording a payment | **PASS** — `Not authorized to record payments` |
| `stock_moves.actor_email` stamped from JWT, ignoring a spoofed value | **PASS** — sent `spoofed@example.com`, stored the real caller's email |

**CRIT-4 is now FIXED.** This is the first finding in the report backed by a live-database result rather than static code review — CRIT-1, CRIT-2, and CRIT-3 are now empirically confirmed working, not just correctly written.

**Remaining open:** CORS origin pinning, all MED items.

---

## Fix Log — 2026-07-02 (hardening pass 5 — HIGH-3, DB test tier)

Converts the two manually-run, human-read verify scripts (`scripts/manual/archive/VERIFY_audit_hardening.sql`, `scripts/manual/archive/VERIFY_crit5_reversal.sql` — both already confirmed PASS against production) into an unattended, CI-enforced regression gate.

- **`supabase/tests/audit_hardening.sql`** (new) — the same 8 checks (CRIT-1 role guard, CRIT-2 allocation validation, CRIT-3 actor stamping, CRIT-5 reversal ×4, HIGH-2 atomic apply), restructured to `RAISE EXCEPTION` naming the specific failing check instead of returning a grid for a human to read — the right shape for `psql -v ON_ERROR_STOP=1` to fail a CI job cleanly. Seeds its own throwaway customer (no migration seeds one on a from-scratch DB) and relies on the manager/viewer test users already seeded by `20260706_seed_test_users_and_deals.sql`.
- **`.github/workflows/ci.yml`** — new `db-tests` job: installs the Supabase CLI (`supabase/setup-cli@v1`), runs `supabase start` (which applies every migration in `supabase/migrations/` to a fresh local Postgres — no Supabase account/secrets needed, this is purely local), installs `psql`, runs the test file. This job **also functions as an ongoing CRIT-4 regression check** — "do all migrations apply cleanly from scratch" becomes an automated gate on every push/PR, not a one-time manual verification.
- **Bug found and fixed while building this:** `20260706_seed_test_users_and_deals.sql` computes `(s.seq - 1) % (SELECT cnt FROM cust_count) + 1` to cycle-assign customers to seeded demo deals. On a from-scratch database (every CI run, by construction) there are zero customers, making `cnt = 0` — a modulo-by-zero. The existing `WHERE (SELECT cnt FROM cust_count) > 0` guard likely makes Postgres's planner skip evaluating this per-row expression entirely (this migration has only ever run in production, where customers already existed, so the fresh-DB path was never exercised) — but rather than depend on unverified planner behavior, wrapped the divisor in `NULLIF(..., 0)` so the expression is safe by construction regardless of evaluation order.
- **`supabase/config.toml`** — added `project_id` and an explicit `[db] port = 54322` (matches the CLI default; made explicit for clarity). Left all other services at CLI defaults rather than aggressively disabling `auth`/`storage`/`realtime` for speed — the safer, better-trodden path given this could not be tested locally (no Docker in this environment).
- **`npm run test:db`** (new script) — runs the same suite locally (`supabase start` + `psql -f ...`); requires Docker and `psql` on the developer's machine.
- **Docs** — `CLAUDE.md`/`AGENTS.md` CI/CD sections corrected (previously stale, claiming CI ran on `main` only) and extended to describe the new job.

**Coverage note:** this suite covers the money/reversal RPCs (everything CRIT-1 through CRIT-5 touched). It does **not** yet cover the inventory/purchasing RPCs (`reserve_units`/`deliver_units`/`release_units`, `receive_stock`, `receive_vendor_invoice`, `transfer_stock`) — the audit's original HIGH-3 suggestion included "reserve→deliver→release conserves quantity" and "double-receipt is idempotent" as good additional checks. Scoped out of this pass to avoid writing untested-by-me assertions for code paths with no prior live verification; a natural next increment once this harness is proven out by a first real CI run.

**Gate:** 277/277 tests, 0 lint errors, build ✓ (unchanged — this pass touched only SQL/CI/config/docs, no application source).

**Update 2026-07-02, same day — verified:** the `db-tests` harness was run (this environment has no Docker, so this is the first execution, not mine) and reported success: the full migration history — including the `NULLIF` fix above — applies cleanly to a from-scratch Postgres, and all 8 checks in `audit_hardening.sql` passed. **HIGH-3 is closed**, with the inventory/purchasing RPC coverage gap noted above still open as a follow-up.

---

## Fix Log — 2026-07-02 (hardening pass 4 — CRIT-5, payment/CN reversal)

**Migration:** `20260754_payment_cn_reversal.sql`. Implements the standard ledger fix the audit recommended: a reversal is a new, negative-signed row in the same append-only `payment_applications`/`credit_note_applications` tables — never a delete or UPDATE of history, matching the discipline this codebase already trusts for `stock_moves`.

- Dropped `UNIQUE(payment_id/credit_note_id, invoice_id)` on both application tables — a ledger must allow apply → reverse → re-apply against the same pair, which a single-row-per-pair uniqueness constraint would block forever after the first reversal. Relaxed the `amount_applied` CHECK so reversal rows carry the negative of what they reverse (`is_reversal` flag now distinguishes the two). Both drops use the codebase's own established catalog-lookup pattern (`pg_get_constraintdef(...) LIKE '%column%'`), not guessed constraint names.
- New RPCs: `reverse_payment_application`/`reverse_credit_note_application` (reverse ONE application line — the direct fix for a CRIT-2-style misallocation: reverse the wrong line, keep the payment active, re-apply correctly) and `void_payment`/`void_credit_note` (reverse every still-active line, then mark voided — what "Void" now does even on an applied payment/CN, closing the audit's literal ask). All four: manager+ guard, server-derived actor (same contract as `20260751`/`20260753`), `FOR UPDATE` locks, added to the execute-lockdown pattern.
- **Bug fix surfaced by this change:** `sync_credit_note_balance` only ever flipped status `issued → applied`, never back — a reversal that drops applied amount below total would have left a CN showing `applied` while money was owed again. Fixed to flip `applied → issued` symmetrically.
- **Bug fix surfaced by this change:** `void_invoice`'s guard checked `EXISTS(...)` on the application tables — once reversal rows exist, that check finds rows *forever* (the original + its reversal both remain), permanently blocking invoice voiding the instant any payment ever touched it, even after full correction. Rewritten to a net-`SUM(amount_applied) > 0` check, which a fully-reversed invoice now passes while a genuinely-applied one still correctly blocks.
- **API layer:** `payments.void_()`/`creditNotes.void_()` now delegate to the RPCs and take a `reason` parameter (previously `creditNotes.void_()` silently dropped the reason the UI already collected via `VoidModal` — fixed both call sites: `SalesDocumentDetail.jsx`'s `handleVoidCN` and `Activities/index.jsx`'s reject-approval flow). Added `reverseApplication()` to both modules.
- **UI:** the Accounting page's Payments tab had **zero void action wired up at all** (`payments.void_()` had no caller anywhere in the app) — added a "Void" button per active payment row, reusing the existing `VoidModal` component from `SalesDocuments/_modals.jsx` rather than building new modal UI.
- **Docs:** rewrote the "Application-table pattern" note in `CLAUDE.md`/`AGENTS.md` — it previously claimed `crmInvoices.recordPayment()` was the single balance setter, which was already stale from the `20260751` HIGH-2 fix (that function has zero callers now; balance updates happen inside the RPCs directly). Corrected while touching the same paragraph.

**Verification:** `scripts/manual/archive/VERIFY_crit5_reversal.sql` (new, same paste-and-read-the-grid pattern as `scripts/manual/archive/VERIFY_audit_hardening.sql`) asserts: reversing one line restores both the invoice balance and the payment's unapplied amount without voiding it; voiding a payment with an active application reverses it automatically; `void_invoice` now succeeds once its only application was reversed (previously impossible); `void_invoice` still correctly blocks a genuinely-applied invoice (regression check on the guard fix).

**Gate:** 277/277 tests, 0 lint errors (same 3 pre-existing warnings), build ✓ (67 precache entries, unchanged). **Not yet applied to the live database** — run `20260754_payment_cn_reversal.sql` then `scripts/manual/archive/VERIFY_crit5_reversal.sql` and report the result grid, same workflow as the CRIT-1–4 pass.

---

## Fix Log — 2026-07-02 (hardening pass 6 — HIGH-4 CORS residual + MED-7)

Closes the last piece of HIGH-4 (CORS was wide open on every Edge Function) and MED-7 (two functions authenticated but didn't authorize).

- **`supabase/functions/_shared/cors.ts`** (new) — `corsOriginHeaders(req)`: reflects the request's `Origin` header only if it's on the `ALLOWED_ORIGINS` secret (comma-separated); falls back to `*` if that secret is unset (opt-in, non-breaking until configured); omits the header entirely for a disallowed origin (correct CORS failure mode — never echoes back a value that falsely grants access).
- **All 8 Edge Functions updated.** In every case, CORS construction moved from a module-level `const` into a **per-request closure inside the handler** — a module-level mutable CORS value would risk one request's response carrying a different request's Origin, since Deno's runtime can interleave concurrent requests within a single isolate. Where a function had its own `json()` response helper closing over the CORS constant (`manage-sessions`, `notification-worker`, `public-track`, `send-whatsapp`), that helper moved to a per-request closure too, so its ~20 call sites downstream needed zero changes.
- **Real bug found while fixing MED-7, more severe than MED-7 as originally written:** `notification-worker`'s auth had a third branch, `else if (!req.headers.get('x-trigger-source')) { return 401 }` — read literally, this means "reject only if the header is *absent*." Any value at all — not just the intended `pg_cron` — satisfied it, so **any unauthenticated caller** (not just a low-privilege authenticated one, which is what MED-7 described) could drain the notification queue and burn WhatsApp/email send quota. Verified against `20260604_pgcron_notifications.sql`'s actual `net.http_post` call, which sends `x-trigger-source: pg_cron` with no secret. Tightened to an exact-string match so the real cron job is unaffected, but this is **not full authentication** — the string is visible in the public migration file. Fully closing it needs the cron job to also send `x-worker-secret`, which requires wiring a Supabase Vault-stored secret into the `net.http_post` call against the live project — flagged as a follow-up, not attempted blind.
- **MED-7 itself:** both `notification-worker` and `send-whatsapp` previously let *any* authenticated user through their Bearer-token path (`getUser()` proves identity, not authorization). Added a role lookup gating to non-viewer staff, matching the `rma_is_staff() AND role <> 'viewer'` idiom already used throughout the RLS policies.
- **`whatsapp-webhook`** also updated for consistency, with an explicit code comment that CORS is inapplicable to its actual security model (Meta calls it server-to-server; the real boundary is `WHATSAPP_WEBHOOK_VERIFY_TOKEN`).
- **Docs:** `CLAUDE.md`/`AGENTS.md` Edge Functions sections updated with the `ALLOWED_ORIGINS` secret requirement and the pre-auth bypass finding.

**Verification approach:** every file's brace balance was checked mechanically after editing (all 8 close at depth 0), and every `json()`/`CORS` call site was grepped to confirm none reference a now-removed module-level constant. **This is Deno/Edge Function code — there is no Deno runtime in this environment, so none of it has actually executed.** Unlike the SQL migrations (which now have the `db-tests` CI harness), there is no automated test coverage for Edge Functions in this repo. Recommend a manual smoke test after deploy: confirm `admin-reset-password`/`send-whatsapp`/`notification-worker` still work from the app, and that the `notification-worker` pg_cron schedule (if active on your plan) still fires successfully.

**Gate:** 277/277 tests, 0 lint errors, build ✓ (unchanged — none of this pass touches `src/`).

---

## Fix Log — 2026-07-02 (hardening pass 7 — inventory reservation test coverage)

Extends the `db-tests` CI harness (HIGH-3) to the inventory/purchasing RPCs, closing the coverage gap explicitly scoped out of the original HIGH-3 pass and directly answering the open question `20260741_warehouse_stock_reservation_rpcs.sql`'s own header comment raised: *"this must be verified explicitly in the gate tests, not assumed."*

- **`supabase/tests/inventory_hardening.sql`** (new, 12 checks) — same `RAISE EXCEPTION`-on-failure shape as `audit_hardening.sql`. **Serialized** (`inventory_units`): `receive_stock` creates available units; duplicate serial rejected; `reserve_units` conserves quantity (`available + reserved + delivered = total` asserted directly, not just spot-checked); over-reservation rejected; `deliver_units` transitions correctly; `release_units` on an already-delivered doc is a safe no-op. **Bulk** (`warehouse_stock`): `receive_stock` creates the counter row; `reserve_warehouse_stock` conserves `quantity`/`reserved_quantity`; over-reservation rejected; **`release_warehouse_stock` and `deliver_warehouse_stock` are each called twice** to assert the duplicate call is a true no-op (state unchanged, no spurious extra `stock_moves` row) — this is the specific idempotency property the RPC's own comment flagged as unverified.
- **Seed data risk, addressed by cross-checking two independent sources:** `products`/`warehouses` predate the migration history (no `CREATE TABLE` to read, same situation `customers` was in for the money tests). Rather than guess required columns, cross-validated the Zod schema (`productSchema` in `src/lib/schemas.ts`) against the TypeScript `ProductRow`/`WarehouseRow` interfaces (`catalog.ts`/`inventory.ts`) — both independently indicate `brand_id` is nullable, so the test seeds a product with no `brands` row dependency at all, and only `sku`/`product_name`/`product_type`/`status` are treated as required.
- **Verification discipline applied, matching the lesson from the `RAISE '%%'` bug in an earlier pass:** every `format()` call's `%s` count was checked against its argument count with a small Node script (not by eye) before considering the file done; one construct (`HAVING COUNT(*) > n` without `GROUP BY`) was deliberately rewritten as a plain two-variable count comparison mid-draft — technically valid Postgres, but an unnecessarily clever construct to rely on unverified, when a plainer equivalent removes the doubt entirely.
- **CI wiring:** added as a second `psql -f` step in the `db-tests` job (after `audit_hardening.sql`), and appended to the `npm run test:db` script.

**Not covered, explicitly out of scope for this pass:** `transfer_stock`, `adjust_stock`, `recalculate_stock`, `receive_vendor_invoice`, `restore_units`/`restore_warehouse_stock`. A further increment, not attempted blind.

**Gate:** 277/277 tests, 0 lint errors, build ✓ (unchanged — this pass touches only SQL/CI/docs).

**Update 2026-07-02, same day — bug found on first run, fixed:** `stock_moves.doc_type` has a `CHECK (doc_type IN ('sales_order', 'invoice', 'credit_note', 'manual', 'vendor_invoice'))` constraint (`20260747_purchase_documents.sql`) that the test's invented placeholder value `'test_doc'` violated — `reserve_units` failed on its first call with `23514: new row for relation "stock_moves" violates check constraint "stock_moves_doc_type_check"`. This is a bug in the *test*, not the RPC — I never checked `doc_type` against its own CHECK constraint the way I'd already checked `ref_type`/`stock_tracking_mode`/`reservation_status` for this same file. Fixed by replacing all 13 occurrences of `'test_doc'` with `'sales_order'` (a real, valid value — matches the RPC's actual documented caller, `salesOrders.confirm()`), re-verified paren balance and dollar-quote pairing after the bulk edit.

**Update 2026-07-02 — verified:** re-run reported all **12/12 inventory-hardening checks pass**. Both DB test files (`audit_hardening.sql` 8/8, `inventory_hardening.sql` 12/12) now pass live and run in the `db-tests` CI job on every push/PR. The bulk-reservation idempotency property that `20260741`'s own header comment said "must be verified explicitly in the gate tests, not assumed" is now that verification.

---

## Fix Log — 2026-07-02 (hardening pass 8 — remaining inventory/purchasing RPC coverage)

Completes HIGH-3: the last 5 inventory/purchasing RPCs (`transfer_stock`, `adjust_stock`, `recalculate_stock`, `restore_units`, `restore_warehouse_stock`, `receive_vendor_invoice`) now have DB test coverage, closing the gap `inventory_hardening.sql`'s own header explicitly deferred.

- **`supabase/tests/inventory_hardening2.sql`** (new, 14 checks) — `transfer_stock` (serialized + bulk, plus guards: transferring a reserved unit is blocked, transferring more bulk than available is rejected), `adjust_stock` (serialized status change, bulk signed delta with a negative-quantity guard), `recalculate_stock` (deliberately corrupts `reserved_quantity` to a wrong-but-constraint-valid value, then asserts recalc restores the true value computed from the `stock_moves` ledger), `restore_units` (both the `'available'` and `'active_rma'` paths — see bug below), `restore_warehouse_stock`, `receive_vendor_invoice` (bulk full receipt with `vi_code` assignment; serialized partial-then-complete receipt across two calls, asserting the code is assigned once and reused; duplicate-serial-across-VIs rejection).

- **A second product-schema dependency, verified before writing (not guessed):** this file additionally needed `vendor_invoices` (references `vendors`, itself new) — both tables came from this session's own Sprint 9 migrations, so their `CREATE TABLE` was directly readable (unlike `products`/`warehouses`/`customers`, which predate the migration history). No cross-referencing needed here; read `20260746_purchase_vendors.sql` and `20260747_purchase_documents.sql` directly for the exact column set before writing the seed `INSERT`.

- **Real bug found and fixed while writing CHECK 9** (not a test-only issue — a genuine production defect): `restore_units(p_unit_ids, p_doc_type, p_doc_id, p_actor_email, p_to_status)` set `reservation_status = p_to_status` directly. The function's own header comment documents a second call shape for damaged/scrapped returns: `p_to_status = 'active_rma'`. But `reservation_status` has `CHECK (reservation_status IN ('available','reserved','delivered'))` — `'active_rma'` is a valid value for the *other* status axis (`status`, the physical/RMA lifecycle), not this one. That call has been raising a constraint violation since the function was written, for a code path CLAUDE.md's own architecture notes single out as a "never conflate these two axes" rule — the function violated its own project's documented rule. Masked in production because the only caller, `creditNotes.restoreUnits()`, always passes `p_to_status='available'`, never `'active_rma'`. **Fixed in `20260755_fix_restore_units_status_conflation.sql`**: `reservation_status` now always resolves to `'available'` on restore (the only sensible funnel-state outcome, regardless of which physical status the unit returns to); `status` still flips to `'active_rma'` only when requested, unchanged from before. Added CHECK 9b to `inventory_hardening2.sql` to directly exercise the previously-broken path, so this can't silently regress.

- **Verification discipline held throughout:** every `format()` call's placeholder-to-argument count checked with a small Node script (0 mismatches, 10 calls); every `doc_type` literal grepped against the exact `CHECK (doc_type IN (...))` constraint from `20260747_purchase_documents.sql` *before* first use, rather than repeating the `'test_doc'` mistake from the previous file; `reservation_status`/`inventory_units.status`/`vendor_invoices.status` literals all cross-checked against their respective CHECK constraints; bracket/paren/dollar-quote balance verified mechanically after every edit, including after CHECK 9b was added.

**Not covered:** none — this was the last increment; all inventory/purchasing RPCs listed in the original HIGH-3 finding now have test coverage.

**Gate:** 277/277 tests, 0 lint errors, build ✓ (unchanged — this pass touches only SQL/CI/docs). Wired into the `db-tests` CI job as a third `psql -f` step and appended to `npm run test:db`.

**Update 2026-07-02, same day — verified:** migration `20260755` applied cleanly; `inventory_hardening2.sql` ran to completion with no exception (a pure `DO` block with no final `SELECT`, so "success, no rows" *is* the pass signal — a failure would show an `ERROR` naming the specific check, as it did for the `doc_type` bug above). **All 14 checks pass, including CHECK 9b**, which directly exercises the previously-broken `restore_units(p_to_status => 'active_rma')` path — confirming the fix in `20260755` actually works, not just that it compiles. **HIGH-3 is now fully closed**: all 3 DB test files (34 checks total) pass live, and every inventory/purchasing RPC in the system has coverage.
