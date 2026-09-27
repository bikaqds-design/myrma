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
new tenant's chart without a clash. Country templates (EG/AE/SA) are A-02.

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
| Supplier invoice approved (from receipts) | Dr goods received not invoiced (receipt value), Dr inventory / cost of goods sold (the re-costing's revaluation / variance), Dr VAT receivable / Cr payables |
| Supplier invoice received (legacy path) | Dr inventory, Dr VAT receivable / Cr payables |
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
- **A-01b (database), purchase side:** goods receipts, supplier bills,
  vendor payments and the re-costing.
- **A-01c (screens):** chart of accounts and posting rules (Control Panel),
  journal list with drill-down to the source, trial balance.
