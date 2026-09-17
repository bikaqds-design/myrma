-- Units delivered to a customer are no longer counted as stock on hand.
-- (Found in the Warehouse R1 regression re-run, 2026-09-17; owner asked for the fix.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- Delivering a serialized unit on a sales order sets reservation_status to
-- 'delivered' and leaves status = 'company_stock' and warehouse_id where they
-- were. That is deliberate and stays: restore_units (credit notes, invoice
-- void) finds a unit by reservation_status = 'delivered', and
-- link_serial_to_rma_ticket takes a sold unit onto a customer's RMA only while
-- it is company_stock.
--
-- But four readers treated "company_stock in a warehouse" as "on the shelf":
--
--   v_product_stock_summary   main_qty, branches and physical_total counted
--                             delivered units (Available did not). On
--                             2026-09-17, 21 units: test2 showed Main 21 where
--                             20 had been delivered to customers.
--   v_warehouse_unit_counts   the Warehouses tab's Units column (MAIN 397,
--                             of which 21 delivered).
--   archive_warehouse         a delivered unit counted as live stock, so a
--                             warehouse whose stock had all been sold could
--                             never be archived.
--   StockBreakdownModal.jsx   Total and the warehouse distribution (client).
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- Stock on hand = company_stock units whose reservation_status is not
-- 'delivered' (plus RMA units at system locations, as before). The Delivered
-- figure stays in v_product_stock_summary for the Overview export. Nothing
-- about a unit's own state changes, and bulk stock is untouched:
-- deliver_warehouse_stock already takes delivered quantity out of
-- warehouse_stock.quantity.

-- ═══ v_product_stock_summary ═════════════════════════════════════════════════
-- Definition as in 20260854; main_qty, branches and physical_total now skip
-- delivered units.

CREATE OR REPLACE VIEW public.v_product_stock_summary
WITH (security_invoker = true) AS
WITH wh AS (
  SELECT id, name, code, warehouse_type, is_system,
         (warehouse_type IS NULL OR warehouse_type IN ('', 'main')) AS is_main,
         (warehouse_type = 'branch') AS is_branch
    FROM public.warehouses
),
u AS (
  SELECT iu.product_id,
         coalesce(nullif(iu.product_name, ''), 'Unknown Product') AS group_name,
         iu.status, iu.reservation_status,
         w.id AS w_id, w.name AS w_name, w.code AS w_code,
         coalesce(w.is_main, true) AS w_main,          -- no known warehouse counts as main
         coalesce(w.is_branch, false) AS w_branch,
         coalesce(w.is_system, false) AS w_system
    FROM public.inventory_units iu
    LEFT JOIN wh w ON w.id = iu.warehouse_id
   WHERE iu.status IN ('company_stock', 'active_rma')
),
serial_counts AS (
  SELECT product_id,
         count(*) FILTER (WHERE status = 'company_stock' AND reservation_status = 'available')::int AS available,
         count(*) FILTER (WHERE status = 'company_stock' AND reservation_status = 'reserved')::int AS reserved,
         count(*) FILTER (WHERE status = 'company_stock' AND reservation_status = 'delivered')::int AS delivered,
         count(*) FILTER (WHERE status = 'company_stock' AND reservation_status IS DISTINCT FROM 'delivered' AND w_main)::int AS main_qty,
         (count(*) FILTER (WHERE status = 'company_stock' AND reservation_status IS DISTINCT FROM 'delivered' AND w_code IS DISTINCT FROM 'SCRAP')
          + count(*) FILTER (WHERE status = 'active_rma' AND w_system AND w_code IS DISTINCT FROM 'SCRAP'))::int AS physical_total
    FROM u
   WHERE product_id IS NOT NULL
   GROUP BY product_id
),
serial_branches AS (
  SELECT product_id,
         jsonb_agg(jsonb_build_object('warehouse_id', w_id, 'name', coalesce(w_name, ''), 'code', w_code, 'qty', qty)
                   ORDER BY w_name, w_id) AS branches,
         sum(qty)::int AS branch_total
    FROM (SELECT product_id, w_id, w_name, w_code, count(*)::int AS qty
            FROM u
           WHERE product_id IS NOT NULL AND status = 'company_stock' AND reservation_status IS DISTINCT FROM 'delivered' AND w_branch
           GROUP BY product_id, w_id, w_name, w_code) x
   GROUP BY product_id
),
serial_rma AS (
  SELECT product_id,
         jsonb_agg(jsonb_build_object('warehouse_id', w_id, 'code', coalesce(w_code, ''), 'name', coalesce(w_name, ''), 'count', n)
                   ORDER BY w_code, w_id) AS rma,
         sum(n)::int AS rma_total
    FROM (SELECT product_id, w_id, w_name, w_code, count(*)::int AS n
            FROM u
           WHERE product_id IS NOT NULL AND status = 'active_rma' AND w_system
           GROUP BY product_id, w_id, w_name, w_code) x
   GROUP BY product_id
),
ws AS (
  SELECT s.product_id, s.quantity, s.reserved_quantity,
         w.id AS w_id, w.name AS w_name, w.code AS w_code,
         coalesce(w.is_main, true) AS w_main,
         coalesce(w.is_branch, false) AS w_branch
    FROM public.warehouse_stock s
    LEFT JOIN wh w ON w.id = s.warehouse_id
),
bulk_counts AS (
  SELECT product_id,
         sum(quantity)::int AS qty,
         sum(reserved_quantity)::int AS reserved,
         coalesce(sum(quantity) FILTER (WHERE w_main), 0)::int AS main_qty,
         coalesce(sum(quantity) FILTER (WHERE w_code IS DISTINCT FROM 'SCRAP'), 0)::int AS physical_total
    FROM ws
   GROUP BY product_id
),
bulk_branches AS (
  SELECT product_id,
         jsonb_agg(jsonb_build_object('warehouse_id', w_id, 'name', coalesce(w_name, ''), 'code', w_code, 'qty', qty)
                   ORDER BY w_name, w_id) AS branches,
         sum(qty)::int AS branch_total
    FROM (SELECT product_id, w_id, w_name, w_code, sum(quantity)::int AS qty
            FROM ws
           WHERE w_branch
           GROUP BY product_id, w_id, w_name, w_code) x
   GROUP BY product_id
),
unmatched AS (
  SELECT group_name,
         coalesce(jsonb_agg(jsonb_build_object('warehouse_id', w_id, 'code', coalesce(w_code, ''), 'name', coalesce(w_name, ''), 'count', n)
                            ORDER BY w_code, w_id) FILTER (WHERE w_id IS NOT NULL), '[]'::jsonb) AS rma,
         coalesce(sum(n) FILTER (WHERE w_id IS NOT NULL), 0)::int AS rma_total,
         coalesce(sum(n) FILTER (WHERE w_id IS NOT NULL AND w_code IS DISTINCT FROM 'SCRAP'), 0)::int AS physical_total
    FROM (SELECT group_name,
                 CASE WHEN w_system THEN w_id END AS w_id,
                 CASE WHEN w_system THEN w_name END AS w_name,
                 CASE WHEN w_system THEN w_code END AS w_code,
                 count(*)::int AS n
            FROM u
           WHERE product_id IS NULL AND status = 'active_rma'
           GROUP BY 1, 2, 3, 4) x
   GROUP BY group_name
)
SELECT
  p.id::text AS product_id,
  p.product_name,
  CASE WHEN p.stock_tracking_mode = 'bulk' THEN 'bulk' ELSE 'serialized' END AS stock_tracking_mode,
  CASE WHEN p.stock_tracking_mode = 'bulk' THEN coalesce(bc.qty - bc.reserved, 0) ELSE coalesce(sc.available, 0) END AS available,
  CASE WHEN p.stock_tracking_mode = 'bulk' THEN coalesce(bc.reserved, 0) ELSE coalesce(sc.reserved, 0) END AS reserved,
  CASE WHEN p.stock_tracking_mode = 'bulk' THEN 0 ELSE coalesce(sc.delivered, 0) END AS delivered,
  CASE WHEN p.stock_tracking_mode = 'bulk' THEN coalesce(bc.physical_total, 0) ELSE coalesce(sc.physical_total, 0) END AS physical_total,
  CASE WHEN p.stock_tracking_mode = 'bulk' THEN coalesce(bc.main_qty, 0) ELSE coalesce(sc.main_qty, 0) END AS main_qty,
  CASE WHEN p.stock_tracking_mode = 'bulk' THEN coalesce(bb.branches, '[]'::jsonb) ELSE coalesce(sb.branches, '[]'::jsonb) END AS branches,
  CASE WHEN p.stock_tracking_mode = 'bulk' THEN coalesce(bb.branch_total, 0) ELSE coalesce(sb.branch_total, 0) END AS branch_total,
  CASE WHEN p.stock_tracking_mode = 'bulk' THEN '[]'::jsonb ELSE coalesce(sr.rma, '[]'::jsonb) END AS rma,
  CASE WHEN p.stock_tracking_mode = 'bulk' THEN 0 ELSE coalesce(sr.rma_total, 0) END AS rma_total,
  true AS in_catalog
FROM public.products p
LEFT JOIN serial_counts sc ON sc.product_id = p.id
LEFT JOIN serial_branches sb ON sb.product_id = p.id
LEFT JOIN serial_rma sr ON sr.product_id = p.id
LEFT JOIN bulk_counts bc ON bc.product_id = p.id
LEFT JOIN bulk_branches bb ON bb.product_id = p.id
WHERE p.product_type IS DISTINCT FROM 'service'
UNION ALL
SELECT
  'unmatched:' || m.group_name,
  m.group_name,
  'serialized',
  0, 0, 0,
  m.physical_total,
  0,
  '[]'::jsonb,
  0,
  m.rma,
  m.rma_total,
  false
FROM unmatched m;

COMMENT ON VIEW public.v_product_stock_summary IS
  'Inventory Overview, one row per product. Main, branches and physical total count stock on hand: delivered units are excluded. (BUG-066; 20260874.)';

-- ═══ v_warehouse_unit_counts ═════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.v_warehouse_unit_counts
WITH (security_invoker = true) AS
SELECT warehouse_id, count(*)::int AS unit_count
  FROM public.inventory_units
 WHERE warehouse_id IS NOT NULL
   AND NOT (status = 'company_stock' AND reservation_status IS NOT DISTINCT FROM 'delivered')
 GROUP BY warehouse_id;

COMMENT ON VIEW public.v_warehouse_unit_counts IS
  'Inventory units per warehouse for the Warehouses tab, excluding units delivered to a customer. (BUG-066; 20260874.)';

-- ═══ archive_warehouse ═══════════════════════════════════════════════════════
-- Body as in 20260764, except that a delivered unit is not live stock.

CREATE OR REPLACE FUNCTION public.archive_warehouse(
  p_warehouse_id uuid,
  p_actor_email  text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit_count  integer;
  v_stock_count integer;
  v_is_system   boolean;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to archive a warehouse' USING ERRCODE = 'P0001';
  END IF;

  SELECT is_system INTO v_is_system FROM public.warehouses WHERE id = p_warehouse_id;

  IF v_is_system THEN
    RAISE EXCEPTION 'System warehouses cannot be archived' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*) INTO v_unit_count
  FROM public.inventory_units
  WHERE warehouse_id = p_warehouse_id AND status <> 'closed'
    AND NOT (status = 'company_stock' AND reservation_status IS NOT DISTINCT FROM 'delivered');

  SELECT COUNT(*) INTO v_stock_count
  FROM public.warehouse_stock
  WHERE warehouse_id = p_warehouse_id AND quantity > 0;

  IF v_unit_count > 0 OR v_stock_count > 0 THEN
    RAISE EXCEPTION 'Cannot archive warehouse: % live serialized unit(s) and % bulk-stock product(s) still present',
      v_unit_count, v_stock_count
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.warehouses SET is_active = false WHERE id = p_warehouse_id;
END;
$$;

-- ═══ Grants (unchanged from 20260854, restated because CREATE OR REPLACE keeps them) ═

DO $grants$
DECLARE
  v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['v_product_stock_summary', 'v_warehouse_unit_counts'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', v);
  END LOOP;
END
$grants$;

-- ═══ Guards: the migration refuses to finish if a delivered unit is still counted ═

DO $guard$
DECLARE
  v_bad text;
BEGIN
  -- Serialized: what sits in main + branch warehouses can never exceed the
  -- units that are available or reserved. Delivered units counted there would
  -- break it (test2 on 2026-09-17: 21 + 27 > 27 + 1).
  SELECT string_agg(product_name, ', ') INTO v_bad
    FROM public.v_product_stock_summary
   WHERE in_catalog AND stock_tracking_mode = 'serialized'
     AND main_qty + branch_total > available + reserved;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to finish: main + branches exceed stock on hand for %', v_bad;
  END IF;

  IF (SELECT coalesce(sum(unit_count), 0) FROM public.v_warehouse_unit_counts)
     <> (SELECT count(*) FROM public.inventory_units
          WHERE warehouse_id IS NOT NULL
            AND NOT (status = 'company_stock' AND reservation_status IS NOT DISTINCT FROM 'delivered')) THEN
    RAISE EXCEPTION 'Refusing to finish: warehouse unit counts do not add up';
  END IF;

  IF pg_get_functiondef('public.archive_warehouse(uuid, text)'::regprocedure) !~ 'delivered' THEN
    RAISE EXCEPTION 'Refusing to finish: archive_warehouse still counts delivered units';
  END IF;
END
$guard$;
