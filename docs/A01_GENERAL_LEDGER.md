# A-01 — General ledger

Plan item W4 / A-01 (gap BL-12, test T-10): a built-in general ledger, the
book of record. Every document step that moves money or stock posts a
balanced journal entry in the same transaction; nothing is left unposted.

## Model (A-01a, `20260905_general_ledger.sql`)

- **`gl_accounts`** — the chart. `code` (unique), `name` / `name_ar`,
  `account_type` (asset, liability, equity, income, expense), `parent_id`
  (a header), `is_postable` (headers are not), `is_active`. An account that
  has been posted to keeps its code and type and stays postable; it can be
  renamed or made inactive (unless a posting rule uses it), never deleted.
- **`posting_rules`** — which account each kind of posting uses: a fixed
  list of roles (`accounts_receivable`, `accounts_payable`, `inventory`,
  `goods_received_not_invoiced`, `sales_revenue`, `sales_tax_payable`,
  `purchase_tax_receivable`, `cost_of_goods_sold`, `purchase_price_variance`,
  `inventory_adjustment`, `cash`, `customer_deposits`, `retained_earnings`,
  `opening_balance_equity`, `rounding`). The posting code names roles, never
  account codes, so a tenant can remap them. **Strict by default:** a posting
  whose role has no account fails, and the document step with it.
- **`journal_entries` / `journal_lines`** — base currency, numbered
  `JE-YYYY-NNNNN` (gapless). Each entry names its source (`source_type`,
  `source_id`, `source_code`) and the `event` that posted it; one entry per
  (source, event), so posting twice returns the first. Lines are one positive
  debit or credit, may name the customer or vendor (for subledger
  reconciliation). **Balanced** (the engine checks; a deferred constraint
  trigger checks again at commit for any writer), **at least two lines**,
  **immutable** (no update, delete or truncate, even by the owner; a restore
  writes rows back as they were) — a mistake is corrected by a reversing
  entry (`reverses_entry_id`, at most one per entry).
- **`_gl_post` / `_gl_reverse`** — the engine, internal (service role only).
  Amounts rounded to cents; zero lines dropped; an all-zero posting writes
  nothing.
- **`rma_trial_balance(from, to)`** — debit, credit and normal-side balance
  per account (managers and accountants).

Access: the chart and rules are readable by staff and written by
administrators (audited); journals are readable by managers and accountants
(`rma_can_handle_cash`) and written by nobody but the engine.

The default chart (25 accounts, 6 headers, English and Arabic) is seeded by
the migration with ids derived from each code (`md5('gl_account:' || code)`),
so every tenant's seeded account has the same id and a backup restores onto a
new tenant's chart without a clash. Country templates (EG/AE/SA) are A-02 (below).

## Posting map (A-01b)

Posted from the step that makes a document final, in its transaction, dated
the day of that step (tenant time zone). Reversal = the same entry with sides
swapped, as its own event.

| Step | Entry |
|---|---|
| Delivery confirmed | Dr cost of goods sold / Cr inventory — the delivery's recorded cost |
| Invoice posted | Dr receivables (total) / Cr sales revenue (net) / Cr VAT payable (tax); a whole-order (legacy) invoice also posts its cost of goods |
| Invoice voided | reversal |
| Credit note issued | Dr sales revenue, Dr VAT payable / Cr receivables; voided: reversal |
| Customer return confirmed | Dr inventory / Cr cost of goods sold — the return's cost |
| Payment recorded | Dr cash / Cr receivables; voided: reversal (applications do not post — receivables are per customer) |
| Refund approved | Dr receivables / Cr cash |
| Goods receipt confirmed | Dr inventory / Cr goods received not invoiced |
| Supplier invoice approved (from receipts) | Dr goods received not invoiced (what the receipts booked), Dr/Cr inventory (revaluation of stock on hand), Dr/Cr purchase price variance (goods already gone + rounding), Dr VAT receivable / Cr payables, Cr accrued freight and duties |
| Supplier invoice approved (older path) | Dr goods received not invoiced, Dr VAT receivable / Cr payables, Cr accrued freight and duties; each receipt on it: Dr inventory / Cr goods received not invoiced at the landed cost; cancelled from approved: reversed |
| Vendor payment recorded | Dr payables / Cr cash; voided: reversal |
| Stock adjustment | waits for cost on the stock ledger (N-03) |

## Defaults to confirm (owner)

1. **Documents before the ledger are not back-posted.** Current data is
   disposable test data; a tenant's opening balances come in through the
   onboarding import (B-03). The ledger starts empty.
2. **Stock at unknown cost:** a delivery of units with no known cost posts the
   known part and leaves the unknown part on the uncosted worklist, rather than
   refusing the delivery.
3. **One cash account** until bank accounts exist (A-07): every payment,
   refund and vendor payment posts to the `cash` role.

## Pieces

- **A-01a (database):** tables, guards, engine, trial balance, default chart,
  Backup & Restore. **Done** (`20260905`, staging).
- **A-01b (database), sales side:** invoices, credit notes, payments, refunds,
  deliveries and returns post (`20260906`, staging), each from a trigger on
  the step, so every path to it posts. **Done.**
- **A-01b (database), purchase side:** goods receipts, supplier invoices
  (from receipts: clears what the receipts booked and posts the re-costing;
  otherwise: clears as the goods are received on the invoice), vendor payments
  (`20260907`, staging). Freight and duties are credited to a new role,
  `accrued_landed_costs` (2160), because no payable records who is owed them.
  **Done.**
- **A-01c (screens):** Accounting › Journal (entries with their lines, date
  and text filters, invoice / credit note / supplier invoice entries link to
  the document) and Accounting › Trial balance (managers and accountants);
  Control Panel › Chart of Accounts (administrators: add, rename, activate /
  deactivate accounts; point each posting rule at an account). **Done**
  (client only).
- **A-02 (database + screen): country charts and import.** `20260908`,
  staging. **Done.** See below.

## A-02 — Country charts of accounts (owner decision: a full chart per country)

> **DRAFT — to be reviewed by an accountant in each country before a tenant
> relies on it.** The charts are modelled on common local practice with an
> IFRS-style structure. They are not taken from any official or regulatory
> list. Changing a template later is a new migration that upserts
> `gl_chart_templates`.

| | Egypt (EG) | United Arab Emirates (AE) | Saudi Arabia (SA) |
|---|---|---|---|
| Accounts | 95 | 92 | 95 |
| Own accounts | withholding tax deducted by customers, advance income tax; withholding, salary, stamp and corporate income tax payable; social insurance payable and the employer's share; employees' profit share payable; **legal reserve** | corporate tax payable and expense; pension contributions payable and the employer's share; end-of-service gratuity provision and expense; visa and labour fees; statutory reserve | withholding tax, GOSI, **zakat** and income tax payable; GOSI employer contributions; end-of-service provision and expense; Iqama, visa and work-permit fees; zakat and income tax expense; statutory reserve |

All three share one structure (1 assets, 2 liabilities, 3 equity, 4 revenue,
5 cost of sales, 6 operating expenses, 7 taxes on income). The posting roles
sit on the same codes in every chart: bank 1130, receivables 1210, inventory
1310, VAT input 1410, payables 2110, goods received not invoiced 2120, accrued
freight and duties 2130, customer deposits 2150, VAT output 2210, retained
earnings 3300, opening balance equity 3900, sales 4100, cost of goods sold
5100, purchase price variance 5200, inventory adjustments 5300, rounding 6990.

- **Apply** (Control Panel › Chart of Accounts › *Start from a country
  template*, administrators): `rma_apply_chart_template(country)`. It works
  **only before anything has been posted**. The chart becomes exactly the
  template: accounts with a code in the template are renamed, retyped and
  re-parented to it; missing ones are created (id from the code); the posting
  rules point where the template says; every other account is removed. The
  choice is kept in `rma_config.chart_template`.
- **Import** (*Import accounts*, administrators, at any time):
  `rma_import_chart_accounts(rows)` takes a CSV with a header row: `code`,
  `name`, `name_ar`, `type`, `parent_code`, `header`. A new code creates an
  account. An existing code is **only renamed**, because type, parent and
  header status are protected once an account has postings. Each row succeeds
  or fails on its own, with the database's reason shown. At most 2000 rows.
  This is how QDS loads its own chart.
- `gl_chart_templates` is reference data from the migration, the same on every
  project. It is not backed up (`INTENTIONALLY_NOT_BACKED_UP`); the chart a
  template produced is backed up as `gl_accounts`.
- Pinned by `src/test/countryChartTemplates.test.js`, which reads the seed from
  the migration and checks, per country:
  - every posting role on exactly one postable account;
  - unique codes;
  - Arabic names;
  - parents that are headers of the same type;
  - types by first digit.

  It also covers the render tests in `src/test/LedgerScreens.test.jsx`.
  `supabase/tests/country_chart_templates.sql` (20 checks) is the rolled-back
  reference script: 20/20 on staging both before and after the apply.
