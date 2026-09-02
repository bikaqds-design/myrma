-- 20260836_uncosted_stock_report.sql
-- Read-only. What stock has no known cost, and the exact call that fixes each.
--
-- ═══ One query, on purpose ═══════════════════════════════════════════════════
--
-- The Supabase SQL editor shows only the LAST statement's result. An earlier
-- version of this file was three statements, so two thirds of it ran and was
-- never seen. Everything below is a single query with a `section` column.
--
-- ═══ Why ═════════════════════════════════════════════════════════════════════
--
-- Measured by the dry run in 20260835: receiving 4 units at a real landed cost
-- of E£5,335 into a bin already holding 6 uncosted units gave an average of
-- E£2,134 — 60% low. 20260795 stopped that dilution by dividing only by the
-- costed units. What it did not do is give the unknown stock a cost; that comes
-- from the purchase records, and this is the list of decisions to make.
--
-- Until a bin or unit is costed it reports NULL, which is honest, and means
-- nothing sold from it can book a cost of goods.
--
-- Nothing is changed here. This only measures.

WITH bulk AS (
  SELECT
    w.product_id, w.warehouse_id, p.product_name, wh.name AS warehouse,
    w.quantity, w.uncosted_quantity, w.avg_cost_base
  FROM public.warehouse_stock w
  JOIN public.products   p  ON p.id  = w.product_id
  JOIN public.warehouses wh ON wh.id = w.warehouse_id
),
-- Serialised units are counted per product and warehouse, because that is the
-- granularity an opening valuation is decided at — nobody prices 401 units one
-- at a time, and units of one product bought before costing existed have no
-- individually recoverable price anyway.
units AS (
  SELECT
    u.product_id, u.warehouse_id, p.product_name, wh.name AS warehouse,
    count(*)                                           AS quantity,
    count(*) FILTER (WHERE u.unit_cost_base IS NULL)    AS uncosted_quantity,
    round(avg(u.unit_cost_base), 4)                     AS avg_cost_base
  FROM public.inventory_units u
  JOIN public.products   p  ON p.id  = u.product_id
  LEFT JOIN public.warehouses wh ON wh.id = u.warehouse_id
  WHERE u.status = 'company_stock'
  GROUP BY u.product_id, u.warehouse_id, p.product_name, wh.name
),
all_stock AS (
  SELECT 'bulk'::text AS kind, * FROM bulk
  UNION ALL
  SELECT 'serialised', * FROM units
)
SELECT * FROM (

  -- ── 1. The headline ───────────────────────────────────────────────────────
  SELECT
    1                                      AS section,
    'TOTAL — ' || kind                     AS product,
    ''                                     AS warehouse,
    SUM(quantity)::text                    AS qty,
    SUM(uncosted_quantity)::text           AS cost_unknown,
    round(100.0 * SUM(uncosted_quantity) / NULLIF(SUM(quantity), 0), 1)::text || '%'
                                           AS pct_unknown,
    ''                                     AS fix
  FROM all_stock
  GROUP BY kind

  UNION ALL

  -- ── 2. Each product and warehouse that needs a cost ───────────────────────
  -- Copy the `fix` text, replace <cost> with what that product was bought for
  -- per unit in base currency, and run it. rma_set_opening_cost sets the value
  -- and clears the unknown count together, so the two cannot end up
  -- disagreeing — which is what a hand-written UPDATE would risk.
  SELECT
    2,
    left(product_name, 48) || ' [' || kind || ']',
    COALESCE(warehouse, '(no warehouse)'),
    quantity::text,
    uncosted_quantity::text,
    round(100.0 * uncosted_quantity / NULLIF(quantity, 0), 1)::text || '%',
    format('SELECT public.rma_set_opening_cost(%L, %L, <cost>);', product_id, warehouse_id)
  FROM all_stock
  WHERE uncosted_quantity > 0

) rows
ORDER BY section, cost_unknown::numeric DESC NULLS LAST, product;

-- ─── Notes on choosing the numbers ───────────────────────────────────────────
--
-- An opening valuation is an estimate, and one taken from the purchase records
-- is enormously better than no cost at all. But:
--
--   • Price each product separately. One blanket figure across different
--     products is a wrong cost that looks deliberate, and that is far harder to
--     find later than a NULL which announces itself.
--
--   • Leave a product uncosted rather than guessing wildly. rma_set_opening_cost
--     refuses zero for exactly this reason: a zero would clear the flag and
--     silently restore the problem 20260795 was written to remove.
--
--   • It never overwrites a cost that came from a vendor invoice. Only stock
--     with no cost at all is touched, so running it twice is safe and running
--     it after some real receipts is safe too.
--
-- Re-run this report afterwards; section 2 should shrink toward nothing.
