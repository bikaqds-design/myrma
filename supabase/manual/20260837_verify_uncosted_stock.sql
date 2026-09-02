-- 20260837_verify_uncosted_stock.sql
-- Read-only. Confirms 20260795. Writes nothing.

WITH checks AS (

  SELECT 1 AS n, 'warehouse_stock.uncosted_quantity exists and is NOT NULL' AS what,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='warehouse_stock'
        AND column_name='uncosted_quantity' AND is_nullable='NO') = 1 AS pass

  UNION ALL SELECT 2, 'it can never exceed the quantity on hand',
    EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid='public.warehouse_stock'::regclass
               AND conname='chk_uncosted_within_quantity')

  UNION ALL SELECT 3, 'avg_cost_base is still generated after being rebuilt',
    (SELECT is_generated FROM information_schema.columns
      WHERE table_schema='public' AND table_name='warehouse_stock'
        AND column_name='avg_cost_base') = 'ALWAYS'

  -- The change that matters. Dividing by quantity was what let six unknown
  -- units drag a real cost of 5,335 down to 2,134.
  UNION ALL SELECT 4, 'the average divides by the COSTED units, not all of them',
    (SELECT generation_expression FROM information_schema.columns
      WHERE table_schema='public' AND table_name='warehouse_stock'
        AND column_name='avg_cost_base') LIKE '%uncosted_quantity%'

  -- NULL, not 0. A zero is a number and every arithmetic downstream would
  -- silently produce an answer from it.
  UNION ALL SELECT 5, 'stock with no costed units reports NULL, never zero',
    NOT EXISTS (SELECT 1 FROM public.warehouse_stock
                 WHERE quantity > 0 AND uncosted_quantity = quantity
                   AND avg_cost_base IS NOT NULL)

  UNION ALL SELECT 6, 'the trigger now watches the count as well as the value',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='rma_hold_unit_cost')
      LIKE '%NEW.uncosted_quantity IS NOT DISTINCT FROM OLD.uncosted_quantity%'

  UNION ALL SELECT 7, 'a manual receipt adds units as uncosted',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='receive_stock')
      LIKE '%uncosted_quantity = uncosted_quantity + p_qty%'

  UNION ALL SELECT 8, 'a transfer carries the unknown units with the goods',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='transfer_stock')
      LIKE '%v_unk_moved%'

  -- transfer_stock was rewritten a second time. Same guards, same check.
  UNION ALL SELECT 9, 'transfer_stock still refuses a system warehouse at both ends',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='transfer_stock')
      LIKE '%assert_not_system_warehouse(p_from_warehouse_id%'
    AND (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='transfer_stock')
      LIKE '%assert_not_system_warehouse(p_to_warehouse_id%'

  UNION ALL SELECT 10, 'transfer_stock still refuses to move a reserved unit',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='transfer_stock')
      LIKE '%reservation_status != ''available''%'

  UNION ALL SELECT 11, 'rma_set_opening_cost exists, is guarded and refuses zero',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='rma_set_opening_cost')
      LIKE '%rma_is_manager_or_above()%'
    AND (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='rma_set_opening_cost')
      LIKE '%p_unit_cost <= 0%'

  UNION ALL SELECT 12, 'rma_set_opening_cost is not callable by the public role',
    NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='public' AND p.proname='rma_set_opening_cost'
                   AND has_function_privilege('public', p.oid, 'EXECUTE'))

  UNION ALL SELECT 13, 'authenticated can still receive and transfer',
    (SELECT bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
        AND p.proname IN ('receive_stock','transfer_stock','rma_set_opening_cost'))

  -- Data sanity: the backfill should have marked every valueless bin unknown.
  UNION ALL SELECT 14, 'no bin holds stock with no value and no unknown count',
    NOT EXISTS (SELECT 1 FROM public.warehouse_stock
                 WHERE quantity > 0 AND total_cost_base = 0 AND uncosted_quantity = 0)

  UNION ALL SELECT 15, 'the average agrees with value over costed units everywhere',
    NOT EXISTS (
      SELECT 1 FROM public.warehouse_stock
       WHERE avg_cost_base IS DISTINCT FROM
             CASE WHEN (quantity - uncosted_quantity) > 0
                  THEN round(total_cost_base / (quantity - uncosted_quantity), 4)
                  ELSE NULL END)
)
SELECT n, CASE WHEN pass THEN 'PASS' ELSE '*** FAIL ***' END AS result, what
FROM checks ORDER BY n;

-- ─────────────────────────────────────────────────────────────────────────────
-- The exposure, after applying. Run 20260836 for the per-product breakdown.
--
--   SELECT SUM(quantity) AS units, SUM(uncosted_quantity) AS cost_unknown,
--          round(100.0 * SUM(uncosted_quantity) / NULLIF(SUM(quantity),0), 1) AS pct_unknown
--     FROM public.warehouse_stock WHERE quantity > 0;
