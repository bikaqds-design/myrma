# Currency and costing

The ask was "add currencies". The goal underneath it is **knowing what things
cost, so gross profit is real** — per invoice, per sales rep, per product, per
customer. Currency is how cost gets into the system, not the point of it.

## Where this starts from

Not "no currency engine" — three partial ones that disagree:

| place | says |
|---|---|
| Dashboard, Reports, Control Panel home | `$` hardcoded |
| Every PDF (`documentPdf.js`, `PDFLayout.jsx`) | `EGP` |
| RMA resolution form | `USD` |

`purchase_orders.currency` and `ticket_resolutions.currency` columns exist.
The PO one is a **free-text input** — it prints on the PDF and does nothing
numerically. Nothing converts anything.

Two further defects found on the way in:

- **Missing decimal scale.** Sales money is `numeric(12,2)`. Purchasing money is
  bare `numeric` — `purchase_orders.total`, `subtotal`, `discount_amount`,
  `tax_amount` and the same four on `vendor_invoices`. Bare `numeric` is
  arbitrary precision, so a computed total can carry fractions of a piastre that
  nothing ever rounds away.
- **No cost reaches inventory.** Purchase lines carry `unit_cost`, sales lines
  carry `unit_price`, and nothing carries cost onto stock or onto a sale. There
  is no COGS anywhere, so margin cannot be computed at all today.

One thing already in place and worth keeping: `inventory_units.vendor_invoice_id`
means a serialised unit already knows which vendor invoice it arrived on. The
provenance chain exists; only the number is missing.

## Decisions

| decision | choice |
|---|---|
| Base currency | Configurable, defaults to EGP, **locked once transactions exist** |
| Sales side | Always base currency. Quotations, sales orders, invoices, credit notes and customer payments never carry FX |
| Local purchasing | Base currency, no rate |
| Overseas purchasing | Vendor's currency on the document, with a conversion rate |
| Rate source | Typed on the PO or vendor invoice by whoever raises it |
| Serialised costing | Exact — each unit carries the cost it actually arrived at |
| Bulk costing | Weighted average per product and warehouse |
| Landed charges | Freight, customs and clearance apportioned **by line value** into unit cost |
| Stock predating costing | Reported as "cost unknown" and excluded from margin, counted separately |
| Margin surfaces | On the invoice · sales performance report by rep · by product and by customer |

### Two things settled without asking

**COGS is frozen onto the invoice when it is posted.** Not recomputed on read.
Same reasoning as the exchange rate: if cost is looked up live, last quarter's
margin silently changes every time a new shipment lands at a different price.
A posted invoice must keep saying what it said.

**The base currency locks.** "Configurable" was the choice, and it is right for
setup — but changing it after transactions exist would invalidate every stored
base amount at once, with no way to tell which rows were converted at which
rate. Configurable until the first document exists, fixed after.

### Where this deviates from the common advice

The usual guidance is "store money as integer minor units". That advice exists
because most languages and several databases have no exact decimal type, so
people reach for floats and accumulate error.

**Postgres `numeric` is already exact.** It is not a float. Migrating twenty-odd
money columns across a live accounting system to integers would be a large,
risky change for no correctness gain. Keeping `numeric`; fixing the six
purchasing columns that are missing their scale.

## Precision

| kind | type | why |
|---|---|---|
| Document totals | `numeric(12,2)` | matches the existing sales chain |
| Unit cost | `numeric(14,4)` | apportioned landed cost divides, so 2dp would round away real differences before they reach the total |
| Exchange rate | `numeric(18,8)` | a rate near 50 EGP/USD needs the fractional digits to round-trip a large invoice |

Rounding happens once, at the document total. Never mid-calculation.

## Shape

### Currency

- `currencies` — ISO 4217 subset: `code char(3)` PK, name, symbol, `decimals`,
  `is_active`. A table rather than a config list so documents can key off it.
- `rma_config.default_currency` — the base. Guarded against change once any
  transaction exists.

### Purchasing

- `purchase_orders` / `vendor_invoices` gain `currency`, `exchange_rate`, and
  base-currency totals. The existing free-text `currency` becomes a real
  reference.
- `vendor_invoice_charges` — freight, customs, clearance and the like, each with
  an amount in document currency and its base equivalent. Apportioned by line
  value at receipt.

### Costing

- `inventory_units.unit_cost_base` — set at receipt: (line unit cost × rate) plus
  that line's share of landed charges. Exact per unit.
- `warehouse_stock.avg_cost_base` — running weighted average per product and
  warehouse, recalculated on each receipt.
- Both nullable. Null means "arrived before costing existed" and is what drives
  the "cost unknown" reporting rather than a silent zero.

### Sale

- `crm_invoices.cogs_base` and `cogs_complete` — captured at posting.
  `cogs_complete = false` when any line drew on uncosted stock, so a partial
  figure can never be mistaken for a whole one.
- Invoice line items snapshot the unit cost used, so a line's margin is
  reconstructable years later.

## Order of work

1. **Currency foundation** — `currencies` table, base-currency config with the
   lock, one shared formatter replacing the three that disagree, and the
   `numeric` scale fix. Nothing behavioural; the dollar-sign-on-EGP bug goes.
2. **Purchasing in foreign currency** — currency and rate on PO and vendor
   invoice, base totals, charge lines.
3. **Cost into stock** — `receive_vendor_invoice` computes landed unit cost and
   writes it to units and to the weighted average.
4. **COGS at posting** — `post_invoice` snapshots cost and completeness.
5. **Margin reporting** — invoice display, sales performance by rep, by product
   and by customer.

Each stage stands on its own: stopping after 1 leaves the system consistent,
after 3 leaves stock correctly costed with no reporting yet.

## Stage 2b — vendor payments and base-currency reporting (applied in code; migration pending)

`supabase/migrations/20260793_vendor_payment_currency.sql`

Stage 2 stopped at the two document tables and left two holes that only open
once a foreign invoice exists:

| Hole | Consequence |
| --- | --- |
| `vendor_payments` had no currency | `amount_paid + applied >= total` compares payment to invoice directly, so E£1,000 marked a $1,000 invoice **paid in full** |
| `v_purchase_documents` / `v_vendor_ledger` exposed only `total` / `amount` | every spend total, pivot cell, vendor balance and sort added mixed currencies and labelled the result EGP |

**The settlement rule adopted:** a vendor payment is made in the currency of the
invoices it settles and may only be applied to invoices in that currency. Both
RPCs refuse a mismatch; the payment modal filters the open-invoice list to the
payment's currency so the impossible allocation cannot be entered at all.

**FX difference is recorded, not hidden.** The payment carries its own rate —
currency is bought on the day it is paid — so `amount_base` on a payment
normally differs from the share of `total_base` it settles. Booking that
difference to a gain/loss account is an accounting decision not yet made; the
two figures are stored honestly rather than forced to agree.

Screens: `docTotalBase()` / `isForeignDoc()` in `src/pages/Purchasing/_shared.js`
are the only way totals are added. A currency code is shown beside an amount
only when it is not the base one — labelling every figure on an all-EGP screen
trains people to stop reading the label. Foreign PO and vendor-invoice PDFs now
print the rate and the base-currency total.

Verify with `supabase/manual/20260828_verify_vendor_payment_currency.sql`.

## Stage 3 — landed cost into stock (applied in code; migration pending)

`supabase/migrations/20260794_landed_cost.sql`

The system had never recorded a cost of any kind, so no margin was computable.
Cost is now captured where it is known: at receipt of a vendor invoice.

    unit_cost_base = ( unit_cost x (1 - discount%)
                     + this line's share of freight/customs, by line value )
                     x the invoice exchange rate

| Decision | Choice | Why |
| --- | --- | --- |
| Serialised stock | `inventory_units.unit_cost_base` per unit | one physical thing, one actual cost; no averaging, no drift |
| Bulk stock | `warehouse_stock.total_cost_base` + generated `avg_cost_base` | the average is derived, so it cannot be written into disagreement |
| Charge apportionment | by line value, across **all** lines | a half receipt must not carry the whole freight bill |
| Purchase tax | **excluded** by default (`rma_config.purchase_tax_in_cost`) | recoverable VAT in unit cost overstates cost on every line |
| Keeping cost correct as stock moves | one `BEFORE UPDATE` trigger | six RPCs move quantity; a total maintained by hand in six places is the bug shape this project keeps hitting |

`rma_hold_unit_cost()` holds the unit cost constant whenever quantity moves and
no cost was stated, so every path is right by default. Only receipt and transfer
override it — a transfer must carry the source's value, or goods worth 500 each
get silently revalued to whatever the destination averages.

**Cost unknown is not cost zero.** Stock already in the warehouses gets 0,
because nobody recorded what it cost. Stage 5 must report `avg_cost_base = 0` on
a row with stock as unknown, never as a 100% margin.

UI: `src/pages/Purchasing/_LandedCharges.jsx` on the vendor invoice, locked once
any goods are received — after that the cost is on the units and editing the
charge would leave invoice and stock disagreeing.

Verify with `supabase/manual/20260830_verify_landed_cost.sql`.
**Before receiving anything**, run `supabase/manual/20260831_find_currency_mismatched_invoices.sql`.

## Stage 3b — an unknown cost stops behaving like zero (migration pending)

`supabase/migrations/20260795_uncosted_stock.sql`

Found by running stage 3 against live data (`20260835`): receiving 4 units at a
real landed cost of E£5,335 into a bin already holding 6 legacy units produced
an average of **E£2,134 — 60% low**. `total_cost_base / quantity` cannot tell a
missing cost from a cost of nothing, and the margin it produces reads as profit.

    avg_cost_base = total_cost_base / (quantity - uncosted_quantity)

| Rule | Why |
| --- | --- |
| `uncosted_quantity` counts units with no known cost | the average then means "what a costed unit here cost", which is true |
| Fully uncosted bin ⇒ `avg_cost_base` is **NULL** | zero is a number and every arithmetic downstream would silently answer from it; NULL propagates |
| Depleting preserves the unknown *share* | with a weighted average nothing records which physical units left, so draining one side first asserts what the data cannot support |
| `receive_stock` adds units as uncosted | a manual receipt has no document and no price; inheriting the bin average is a claim |
| A transfer carries unknown units in proportion | otherwise the source becomes all-unknown and the destination gains false confidence |
| `rma_set_opening_cost()` refuses zero | valuing stock at zero to clear the flag turns an honest unknown into a confident wrong number |

`rma_set_opening_cost(product, warehouse, unit_cost)` sets the value and clears
the count in one statement, so the two cannot disagree.

Verify with `supabase/manual/20260837_verify_uncosted_stock.sql`;
measure the exposure with `supabase/manual/20260836_uncosted_stock_report.sql`.

## Stage 4 — COGS at posting, and the bulk delivery gap (migration pending)

`supabase/migrations/20260797_cogs_at_posting.sql`

Two things in one migration, because `post_invoice` had to be rewritten either
way and the cost must be read before the stock moves.

**1. Bulk stock was never delivered.** `funnel_reserve_line` reserves it on
sales-order approval; nothing ever delivered it. `deliver_warehouse_stock` and
`release_warehouse_stock` have existed since 20260741 with **no caller anywhere**
— the only references were their definitions, a `REVOKE` whose comment wrongly
calls them "primitives, called by the guarded RPCs above them", and a test that
calls them directly. So a bulk sale billed the customer and left the quantity in
the warehouse, with `reserved_quantity` climbing on every sale until no further
bulk sale of that product could be reserved. Same defect 20260775 fixed for
serialised lines, still open on the bulk path. `void_invoice` had the mirror
gap: it restored serialised units and not bulk.

**2. Cost of the sale is captured at posting.**

| Column | Meaning |
| --- | --- |
| `cogs_base` | cost of the goods shipped, base currency, written at posting and **never recomputed** |
| `cogs_unknown_qty` | units shipped with no known cost |
| `cogs_complete` | generated: `cogs_base IS NOT NULL AND cogs_unknown_qty = 0` |

Stored rather than derived: the cost of what was sold is a fact about the day it
shipped. Re-deriving it from a moving average would report a different profit
for the same sale every time stock is revalued.

`rma_invoice_cogs()` reads serialised units at their own cost and bulk at the
bin average, counting NULL-cost units as unknown rather than multiplying by
nothing. It computes bulk reservations the same way `deliver_warehouse_stock`
does, so the quantity costed is the quantity shipped. Voiding clears the cost,
so a cancelled sale leaves no margin behind.

Verify with `supabase/manual/20260840_verify_cogs.sql`.

## Stage 5 — profit and loss (migration pending)

`supabase/migrations/20260798_margin_reporting.sql` + Reports → Profitability

The question the whole engine was built for: what each sale made, in total and
per rep.

**The rule everything here obeys: an invoice with unknown cost is never counted
as profit.** This is why stages 1-3b went to such trouble to keep *unknown*
distinct from *zero*. A E£100,000 sale with no recorded cost reports E£100,000
of margin if you let it through — indistinguishable from a brilliant deal, and
enough to carry a rep's whole quarter.

So every aggregate reports two revenues:

| | |
| --- | --- |
| `revenue_base` | everything sold |
| `costed_revenue_base` | only invoices whose cost is complete |

and margin is measured against the **second**. `margin_pct` therefore means "of
the sales we can actually cost, this much was margin" — true, rather than a
number diluted by sales nobody can cost. `invoices_cost_unknown` rides on every
row so the gap is never invisible.

Both views carry `security_invoker = true`: cost and margin are the most
commercially sensitive figures in the system, and a rep must not read another
rep's numbers through a view that forgot.

`summariseMargin()` in `src/api/db/margin.ts` applies the same rule client-side;
the screen shows a dash and "cost unknown" rather than a figure, and states how
much revenue is excluded.

Verify with `supabase/manual/20260841_verify_margin.sql`.

### Not yet possible: margin per product

`cogs_base` is captured per invoice, not per line, so margin cannot be broken
down by product or by product category. Doing it needs line-level cost written
into `line_items` at posting — another `post_invoice` change. Out of scope here;
what was asked for was invoice, total, and per rep.

## Currency settings screen (code only, no migration)

`src/pages/cp/CurrencySettings.jsx` → Control Panel → **Currency & Costing**

The engine shipped with every knob reachable only by pasting SQL — a fine way to
apply a migration and a poor way to run a business. Three things live here, and
they are deliberately not equally editable:

| | |
| --- | --- |
| **Base currency** | read-only once any transaction document exists, with the count shown. Every rate is a ratio to it and every amount was recorded against it, so changing it converts nothing — it reinterprets everything. `rma_guard_base_currency` refuses it; offering a control the server rejects would be worse than showing the value with the reason. |
| **Currencies** | genuinely editable — activate, deactivate, add. The base currency cannot be deactivated. |
| **`purchase_tax_in_cost`** | the toggle that was previously SQL-only. |

### Tested

| | |
| --- | --- |
| `src/test/CurrencySettings.test.jsx` | 12 tests: base locked vs changeable, no toggle on base, deactivate writes `is_active` and never deletes the row, 3-char code enforced, code upper-cased, decimals sent as a number, tax toggle writes the config key with the acting user |
| `supabase/manual/20260842_dryrun_currency_settings.sql` | rollback dry-run against real RLS and the real trigger — **ALL CHECKS PASSED** |

The dry run confirmed on live data that the database itself refuses to change
the base currency (109 documents), so the read-only field on screen reflects a
real rule rather than being the only thing enforcing it; and that flipping
`purchase_tax_in_cost` moves a landed unit cost from E£100.0000 to E£114.0000 on
a 14% line — the flag reaches the costing function, it is not just stored.

That last check took three versions. The first asserted a taxed invoice existed
and reported PASS without computing anything; the second computed correctly but
SKIPPED, because no invoice in this database carries tax. Both looked green. It
now builds its own fixture inside the rolled-back transaction and asserts two
exact figures rather than "the second is higher", which would wave through a
flag applied to the wrong part of the line.

