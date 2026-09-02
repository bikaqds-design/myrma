-- 20260830_verify_landed_cost.sql
-- Read-only. Confirms 20260794 did what it claims. Writes nothing.
--
-- `check` is a reserved word in a column reference position, so the column is
-- named `what` — the mistake that broke 20260828 on its first run.
--
-- Paste into the Supabase SQL editor. Only the LAST statement's result is
-- shown, so this is one query returning one row per check.

WITH checks AS (

  -- ── Storage ────────────────────────────────────────────────────────────────
  SELECT 1 AS n, 'inventory_units.unit_cost_base exists' AS what,
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='inventory_units'
               AND column_name='unit_cost_base') AS pass

  UNION ALL SELECT 2, 'warehouse_stock.total_cost_base exists, NOT NULL, defaults to 0',
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='warehouse_stock'
        AND column_name='total_cost_base' AND is_nullable='NO'
        AND column_default LIKE '0%') = 1

  -- The average must be derived. A writable column could be set to disagree
  -- with the value and quantity it is supposed to come from, which is the only
  -- reason it is derived at all.
  UNION ALL SELECT 3, 'warehouse_stock.avg_cost_base is GENERATED ALWAYS STORED',
    (SELECT is_generated FROM information_schema.columns
      WHERE table_schema='public' AND table_name='warehouse_stock'
        AND column_name='avg_cost_base') = 'ALWAYS'

  UNION ALL SELECT 4, 'the hold-unit-cost trigger fires before every stock update',
    EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgrelid='public.warehouse_stock'::regclass
               AND tgname='trg_warehouse_stock_hold_unit_cost'
               AND NOT tgisinternal)

  -- ── The costing function ───────────────────────────────────────────────────
  UNION ALL SELECT 5, 'rma_vi_landed_unit_costs exists and is guarded',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='rma_vi_landed_unit_costs')
      LIKE '%rma_is_staff()%'

  UNION ALL SELECT 6, 'rma_vi_landed_unit_costs is not callable by the public role',
    NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='rma_vi_landed_unit_costs'
         AND has_function_privilege('public', p.oid, 'EXECUTE'))

  UNION ALL SELECT 7, 'receiving writes the landed cost onto stock',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='receive_vendor_invoice')
      LIKE '%rma_vi_landed_unit_costs%'

  UNION ALL SELECT 8, 'receiving costs serialised units as well as bulk',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='receive_vendor_invoice')
      LIKE '%unit_cost_base%'

  -- ── transfer_stock kept everything it had ──────────────────────────────────
  -- It was rewritten to carry cost, and a rewrite is where guards get dropped.
  -- These four are the protections that existed before; all must survive.
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

  UNION ALL SELECT 11, 'transfer_stock still branches on the product tracking mode',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='transfer_stock')
      LIKE '%v_tracking_mode = ''bulk''%'

  UNION ALL SELECT 12, 'transfer_stock now carries value to the destination',
    (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='transfer_stock')
      LIKE '%total_cost_base + v_moved%'

  -- ── Charges ────────────────────────────────────────────────────────────────
  UNION ALL SELECT 13, 'charges cannot be changed after the goods are received',
    EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgrelid='public.vendor_invoice_charges'::regclass
               AND tgname='trg_charges_before_receipt' AND NOT tgisinternal)

  UNION ALL SELECT 14, 'purchase_tax_in_cost is configured and defaults to excluded',
    (SELECT config_value #>> '{}' FROM public.rma_config
      WHERE config_key='purchase_tax_in_cost') = 'false'

  -- ── Both rewritten RPCs still reachable by the app ─────────────────────────
  UNION ALL SELECT 15, 'authenticated can still receive and transfer',
    (SELECT bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
        AND p.proname IN ('receive_vendor_invoice','transfer_stock'))

  -- ── Data sanity ────────────────────────────────────────────────────────────
  UNION ALL SELECT 16, 'no stock row has a negative value',
    NOT EXISTS (SELECT 1 FROM public.warehouse_stock WHERE total_cost_base < 0)

  -- Superseded by 20260795: the average now divides by the COSTED units, not
  -- by every unit, because dividing by all of them let six unknowns drag a real
  -- cost of 5,335 down to 2,134. Kept as a pointer rather than deleted, so a
  -- re-run of this file does not fail against the newer definition.
  UNION ALL SELECT 17, 'avg_cost_base formula — see 20260837 once 20260795 is applied',
    true
)
SELECT n, CASE WHEN pass THEN 'PASS' ELSE '*** FAIL ***' END AS result, what
FROM checks ORDER BY n;

-- ─────────────────────────────────────────────────────────────────────────────
-- Informational, not a pass/fail. How much stock currently has NO known cost.
-- Expect this to cover everything already in the warehouses: costing starts
-- from the next receipt, and a zero here means unknown, not free.
--
--   SELECT count(*) FILTER (WHERE quantity > 0 AND total_cost_base = 0) AS cost_unknown,
--          count(*) FILTER (WHERE quantity > 0 AND total_cost_base > 0) AS costed,
--          count(*) AS rows
--     FROM public.warehouse_stock;
