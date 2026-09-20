# myCRM — SaaS ERP Upgrade Plan

**Written:** 2026-09-20 · **Owner:** Ahmed (bika.qds@gmail.com) · **Status:** draft for approval

This plan turns myCRM from a single-company RMA/CRM app into a multi-country SaaS ERP.
It builds on the existing codebase (`D:\myrma-app`, Supabase + React/Vite) — nothing is rewritten from zero.

Inputs:

- `C:\Users\bika_\Desktop\myRMA_vs_QuickBooks_Enterprise_24_Gap_Analysis.md` (backlog IDs BL-01…BL-25, risks R-01…R-21, tests T-01…T-20)
- Decisions taken on 2026-09-17 (Section 1)
- A read-only survey of this repository on 2026-09-20 (Section 2)

---

## 1. Product decisions (settled)

| Topic | Decision |
|---|---|
| Product | Global SaaS for small retail shops → medium/large distributors. QDS Egypt is pilot tenant #1 |
| Book of record | Built-in general ledger, **plus** optional sync to the customer's accounting tool. QuickBooks Desktop sync is out of v1; CSV/IIF export covers the QDS pilot |
| Tenancy | One Supabase project per paying tenant; tenant chooses the hosting region. Trials run in a shared demo project |
| Billing | Self-signup with subscriptions. Paymob for Egypt; other countries decided later |
| Markets | Egypt and GCC (UAE, Saudi) first. English + Arabic (RTL) |
| Tax / e-invoicing | Built-in connectors: ETA (Egypt), ZATCA (Saudi), UAE |
| Costing | Weighted average for all items (serials stay for warranty/RMA traceability), standard cost as an option |
| Controls | Approval and segregation-of-duties rules configurable per tenant, strict by default |
| Data | Current production data is disposable test data; the schema may change freely |
| Delivery | GitHub `bikaqds-design/myrma`, one branch + PR per item, CI green before merge |

---

## 2. What the repository already gives us

Verified by reading the repo on 2026-09-20 — this is why the plan is an upgrade, not a rebuild.

| Asset | State |
|---|---|
| Schema baseline | **`supabase/migrations/00000000_baseline_schema.sql` exists** and was proven on 2026-09-01 by building a brand-new Supabase project from it (62 tables, 89 functions, 199 policies), plus `00000001_baseline_reference_data.sql`. Project-per-tenant provisioning is therefore already possible |
| Migrations | 206 files, ledger drift checked daily by `.github/workflows/migration-drift.yml` |
| Server-side money/stock logic | `SECURITY DEFINER` RPCs with row locks; append-only `stock_moves`; application tables for payments and credit notes with negative-row reversals |
| Audit remediation | `AUDIT_REPORT.md`: 87 findings, 85 fixed, 1 partly fixed, 1 open (both WhatsApp, on hold) |
| CI | Unit tests, lint (zero warnings), typecheck, build, plus an integration tier (RLS / RPC refusal / schema drift) |
| i18n | `react-i18next`, `en.json` + `ar.json`, RTL handled including portals; a rule that new strings must use `t()` |
| Multi-currency | `currencies` table, currency + exchange rate on purchasing documents, landed cost, vendor-payment rates |
| Modules live | CRM (leads, deals, pipelines, activities), Sales documents, Accounting v1 (AR), Purchasing, Inventory + warehouses, RMA/service, knowledge base, notifications, PWA, backup/restore |
| Engineering rules | `CONSTITUTION.md`, `CLAUDE.md`, `DESIGN.md`, design backlog |

### Findings that change the plan

1. **CI's `db-tests` job is disabled (`if: false`)** and its comments still claim no baseline exists. That is now out of date — the baseline landed on 2026-09-01. The job can be revived without Docker by running the SQL assertion files against a hosted staging project.
2. **The integration tier runs against production.** Acceptable for a single company with disposable data; unacceptable once tenants are paying. It needs a dedicated staging project.
3. **No Docker and no local `pg_dump` on this machine.** All database work therefore goes through hosted projects (Supabase MCP / dashboard) and the `GENERATE_baseline_schema.sql` generator. Installing the native PostgreSQL client tools (no Docker) would make dumps and psql-based test runs much easier — recommended, not required.
4. **Accounting is AR-only** ("lightweight AR layer, not a full ERP" — `CLAUDE.md`). No general ledger, tax codes, periods or bank reconciliation, as the gap analysis found.
5. **No tenant, subscription or provisioning concept anywhere** in the schema or code. That is the single largest new workstream.
6. **Sales documents are single-currency** while purchasing is multi-currency. The currency foundation exists; it must be extended to the sales side.
7. **Document lines are JSON blobs**, so the database cannot enforce line-level rules. This blocks deliveries, goods receipts, matching, line-level tax and ledger traceability.

---

## 3. Architecture for the SaaS

### 3.1 Two planes

**Control plane** — one Supabase project owned by us:
signup, tenant registry, plan and subscription state, Paymob webhooks, provisioning jobs, migration rollout status per tenant, support access with an audit trail, and aggregated health metrics. It never holds tenant business data.

**Tenant plane** — one Supabase project per paying tenant, in the tenant's chosen region, created from `00000000_baseline_schema.sql` + `00000001_baseline_reference_data.sql` + a country pack. Because each tenant is physically separate, **the current single-company schema stays valid** — no `organization_id` column is needed anywhere. That is the main saving from this tenancy choice.

**Demo plane** — one shared, pre-seeded project for trials, reset on a schedule; no real customer data.

### 3.2 Country packs
A country pack is data, not code: chart of accounts template, tax codes and rates, document number formats, fiscal-year defaults, date/number formats, language defaults, e-invoicing profile, and the legal fields a printed invoice must carry (tax registration number, commercial registration, QR requirements). Packs for `EG`, `AE`, `SA` ship in v1.

### 3.3 Release pipeline
`main` → staging project (full migration replay from baseline + assertion suites) → canary tenant (QDS) → all tenants, with per-tenant status recorded in the control plane and an automatic stop on the first failure.

---

## 4. Workstreams

Each item is one branch + PR. "Tests" lists what must be green before merge.

### W0 — Platform foundation (blocks everything else)

| ID | Item | Tests |
|---|---|---|
| F-01 | Staging Supabase project, built from the baseline; move the integration tier off production | Full migration replay from empty; integration tier green against staging |
| F-02 | Re-enable `db-tests` in CI against staging; port `supabase/tests/*.sql` into the run; adopt pgTAP format | Every existing assertion file runs in CI and fails loudly on regression |
| F-03 | Provisioning script: create project → apply baseline → apply country pack → seed first admin → smoke test | A new tenant project is created and verified end-to-end without manual steps |
| F-04 | Migration rollout runner across tenant projects with per-tenant status, retry and stop-on-failure | Dry-run on staging + QDS; drift check green afterwards |
| F-05 | Environment/branding split so one codebase serves all tenants (no hardcoded QDS strings, logos or config) | Build passes with a blank tenant; UI guard report shows no new hardcoded text |

### W1 — Integrity fixes (from the gap analysis; small, high value)

| ID | Item | Gap IDs | Tests |
|---|---|---|---|
| I-01 | Protect posted history: draft-only delete, remove admin bypass except a restore flag, lock approved vendor invoices and confirmed POs, fix the financial report to posted documents and `posted_at` | BL-01 | T-15, T-17 |
| I-02 | Server-side `audit_log` table + generic trigger on financial and stock tables; document timeline in the UI | BL-02 | T-15 audit row present; client writes refused |
| I-03 | Close direct writes to `inventory_units`; status CHECK constraint; RPCs for every legitimate RMA status change | BL-03 | T-14 |
| I-04 | Sales-order lifecycle: reject only from `sent`, release bulk reservations on cancel, `confirmed` instead of `delivered` on approval, sequential QT/SO/PO codes, reservation integrity check | BL-04 | T-11, T-12, T-21 |
| I-05 | Quote conversion preconditions + credit-note caps, reason codes and approval threshold | BL-05 | T-01b, T-01c, T-04b |
| I-06 | Supplier invoice number with duplicate blocking; PO amendment control with revisions | BL-10 | T-06a, T-16 |
| I-07 | Costing clean-up: cost per vendor-invoice line (not `LIMIT 1`), never default to 0, uncosted worklist, opening-cost import | BL-09 | T-18; uncosted units = 0 |

### W2 — Document lines as real tables (foundation for everything after)

| ID | Item | Tests |
|---|---|---|
| L-01 | `*_lines` tables for quotations, sales orders, invoices, credit notes, POs, vendor invoices, with foreign keys and per-line quantities | Line-level constraints enforced in the database; existing screens still work |
| L-02 | Migrate JSON lines to rows; RPCs and views rewritten; JSON path removed | Full migration replay; UI regression pass |

### W3 — Physical events

| ID | Item | Gap IDs | Tests |
|---|---|---|---|
| P-01 | Delivery (shipment) document; stock leaves and COGS is captured at delivery confirmation, not invoice posting | BL-06 | T-02a |
| P-02 | Invoice from delivery lines; partial invoicing and backorders | BL-07 | T-02b, T-13 |
| P-03 | Goods receipt against PO lines; over-receipt control; PO line received/billed quantities | BL-11 (part 1) | T-05a, T-05b |
| P-04 | Two/three-way matching with tolerances and an exception queue; vendor-payment approval and prepayment flag | BL-11 (part 2) | T-05c |
| P-05 | Return receipts with disposition, and customer refunds with approval | BL-08 | T-04a, T-04c |

### W4 — Accounting core

| ID | Item | Gap IDs | Tests |
|---|---|---|---|
| A-01 | `gl_accounts`, `posting_rules`, `journal_entries`, `journal_lines`; balanced and immutable; posting from existing RPCs | BL-12 | T-10; debits = credits on every entry |
| A-02 | Country chart-of-accounts templates (EG/AE/SA) + import from CSV | — | A new tenant starts with a working chart |
| A-03 | Accounting periods, posting dates, close checklist, dual-approval reopen | BL-13 | T-09a, T-09b |
| A-04 | Tax codes, per-line tax snapshots, VAT return report | BL-15 | Posted tax unchanged when a rate later changes |
| A-05 | Multi-currency sales documents + FX gain/loss on settlement | S-20, P-14 | Foreign-currency invoice reconciles in base currency |
| A-06 | Customer deposits (prepayments) and credit limit / credit hold | BL-16, BL-17 | T-03a |
| A-07 | Bank accounts, statement import, reconciliation | BL-23 | Statement balance ties to ledger |
| A-08 | Financial reports: trial balance, P&L, balance sheet, subledger reconciliation, with drill-down to source | A-12 | Reports tie to journals |

### W5 — Compliance / e-invoicing

| ID | Item | Tests |
|---|---|---|
| C-01 | E-invoicing framework: document mapping, signing, submission queue, status, retries, archive | Submission survives outage and retries safely |
| C-02 | Egypt ETA connector (invoices + e-receipts) | Sandbox submission accepted and status stored |
| C-03 | Saudi ZATCA Phase 2 connector (clearance, QR, bilingual invoice) | Sandbox clearance accepted |
| C-04 | UAE profile and bilingual invoice layouts | Layout review passes |

### W6 — Permissions and segregation of duties

| ID | Item | Gap IDs | Tests |
|---|---|---|---|
| S-01 | Server-side permission catalog (~40 actions) with `rma_has_permission()` used inside RPCs | BL-14 | A user with post but not void cannot void |
| S-02 | Maker ≠ checker helpers, per-tenant strictness settings, SoD conflict report | BL-14 | Creator cannot approve own vendor invoice |

### W7 — Inventory depth

| ID | Item | Gap IDs |
|---|---|---|
| N-01 | Cycle counts with snapshot, blind count, variance approval, reason codes | BL-18 |
| N-02 | Warehouse-specific allocation and available-to-promise | BL-19 |
| N-03 | Stock-move enrichment (warehouse, cost, reason, document line) and in-transit transfers | BL-24 |
| N-04 | Vendor credits and returns to vendor | BL-20 |
| N-05 | Replenishment suggestions, vendor items and price history | BL-21, P-02 |
| N-06 | Item master extension: barcode, MPN, UOM, price lists, default tax code | BL-25 |

### W8 — Commercial (SaaS business layer)

| ID | Item |
|---|---|
| B-01 | Marketing/signup site, plans and pricing, demo sandbox |
| B-02 | Paymob subscription billing behind a provider-agnostic interface; invoices for our own subscriptions |
| B-03 | Onboarding wizard: company profile, country pack, users, opening balances, data import |
| B-04 | Tenant admin console: usage, plan, backups, support access with consent and audit |
| B-05 | Documentation and in-app help, English and Arabic |

### W9 — Retail (after v1)
POS with barcode, cash sessions, offline tolerance, and e-receipt submission.

---

## 5. Phases

Solo developer with AI assistance, quality prioritised over speed. Durations are working weeks and assume a normal working week.

| Phase | Content | Weeks | Exit condition |
|---|---|---|---|
| **0. Foundation** | W0 (F-01…F-05) | 4–6 | A tenant project can be created and migrated automatically; CI tests run against staging, not production |
| **1. Integrity** | W1 (I-01…I-07) | 4–6 | All gap-analysis fraud/integrity tests pass; inventory fully costed |
| **2. Lines** | W2 | 3–4 | Every document line is a real row with database-enforced rules |
| **3. Physical events** | W3 | 6–8 | Deliveries and goods receipts drive stock; partial shipments and matching work |
| **4. Accounting** | W4 (A-01…A-05) + W6 | 8–10 | Trial balance balances; VAT report ties; periods close; multi-currency sales |
| **5. Compliance** | W5 | 4–6 | ETA and ZATCA sandbox submissions accepted |
| **6. Commercial** | W8 + A-06…A-08 | 6–8 | Self-signup → paid → provisioned tenant, end to end |
| **7. Depth** | W7, then W9 | ongoing | Counts, ATP, vendor credits, replenishment; POS after |

**Milestones**
- End of phase 3 (~month 5): QDS pilot starts, running in parallel with QuickBooks.
- End of phase 5 (~month 8): compliance-ready for Egypt and Saudi.
- End of phase 6 (~month 10): first external paying customer.

The gap analysis proposed 90 days for the same scope. That assumed one company, no multi-tenancy, no e-invoicing and no billing. With those added, 9–11 months is the honest figure for one developer.

---

## 6. Definition of done (every PR)

1. Unit tests, lint with zero warnings, typecheck and build all green.
2. Database assertions (pgTAP) for any new RPC, trigger, constraint or policy — including the failure cases (who is refused, what is blocked).
3. The failing test is written **before** the fix, so the fix is proven.
4. Migration applied to staging first, replayed from the baseline on an empty project, and drift check green.
5. RLS and role-guard probes re-run when policies, grants or guard triggers change (`supabase/tests/authenticated_role_probes.sql`).
6. Supabase security and performance advisors reviewed at each release.
7. All user-visible strings via `t()`, with Arabic added in the same PR.
8. `CLAUDE.md` / `AUDIT_REPORT.md` updated when behaviour or status changes.
9. No writes to a production tenant from tests.

---

## 7. Cost model for project-per-tenant

Each paying tenant is a separate Supabase project with its own monthly cost, plus storage, egress and backups. Before pricing is published:

- measure the real monthly cost of one small tenant on the smallest paid tier;
- set the lowest plan above that cost with a margin, or route the smallest customers to a shared project later if the numbers don't work;
- automate pausing and deletion for cancelled tenants;
- budget rollout time: every migration runs N times, so the rollout runner (F-04) is what keeps this affordable in hours as well as money.

---

## 8. Open decisions

| # | Question | Needed by |
|---|---|---|
| 1 | Payment providers outside Egypt (Tap / HyperPay / Stripe via a UAE entity) | Phase 6 |
| 2 | Are ETA and ZATCA connectors built directly, or through a certified provider? Direct is a differentiator; a provider is faster | Phase 5 |
| 3 | Data retention and backup policy per tenant, and what happens on cancellation | Phase 6 |
| 4 | Does QDS's pilot need its ledger to match QuickBooks for 1, 2 or 3 months before cut-over? | Phase 4 |
| 5 | Is there a shared-project fallback for the cheapest plan, or is project-per-tenant absolute? | Before pricing |

---

## 9. Immediate next steps

1. Create the staging Supabase project and point the integration tier at it (F-01).
2. Re-enable and extend the database test job (F-02).
3. Write the provisioning script and prove it by creating a throwaway tenant (F-03).
4. Start the integrity fixes in parallel, beginning with I-01 and I-02, each as its own PR with a failing test first.
