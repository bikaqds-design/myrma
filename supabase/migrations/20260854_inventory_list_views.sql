-- 20260854_inventory_list_views.sql
--
-- Server-side lists for the Inventory screen. (Audit finding BUG-066, phase 5.)
--
-- The screen loaded every inventory unit, every stock move, every warehouse
-- stock row and the whole product catalogue on open, then counted, grouped,
-- searched and paged them in the browser. The Supabase Data API returns at most
-- 1 000 rows per request, so past that each tab showed part of the data as if
-- it were all of it — the dashboard's stock figures included.
--
-- PostgREST can filter, sort, page and count a view but cannot group or join by
-- hand, so the grouping and the labels the browser used to build live here.
-- Each view reproduces the arithmetic of the code it replaces; where that code
-- is quoted below, it is the rule the view follows.
--
-- Every view is security_invoker: it reads the underlying tables as the caller,
-- under their RLS, exactly as the browser's own queries did. SELECT only, to
-- authenticated only.

-- Brand-by-name and ticket-by-number lookups run per row below.
CREATE INDEX IF NOT EXISTS idx_products_product_name ON public.products (product_name);

-- ═══ v_inventory_units ═══════════════════════════════════════════════════════
-- One row per unit, with the columns the unit tables display and search:
--
--   group_name            the All Units grouping key: `product_name || 'Unknown Product'`
--   brand_name            the brand of the product with this exact name — the
--                         old brandMap was built by name from the newest-first
--                         catalogue, overwriting as it went, so the OLDEST
--                         product with a repeated name won
--   ticket_customer_name  from the ticket with this RMA number
--   ticket_status

CREATE OR REPLACE VIEW public.v_inventory_units
WITH (security_invoker = true) AS
SELECT
  u.*,
  coalesce(nullif(u.product_name, ''), 'Unknown Product') AS group_name,
  nb.brand_name,
  tk.customer_name AS ticket_customer_name,
  tk.ticket_status AS ticket_status
FROM public.inventory_units u
LEFT JOIN LATERAL (
  SELECT b.brand_name
    FROM public.products p
    LEFT JOIN public.brands b ON b.id = p.brand_id
   WHERE p.product_name = u.product_name
   ORDER BY p.created_date ASC, p.id ASC
   LIMIT 1
) nb ON true
LEFT JOIN LATERAL (
  SELECT t.customer_name, t.ticket_status
    FROM public.rma_tickets t
   WHERE t.rma_number = u.rma_number
   LIMIT 1
) tk ON true;

COMMENT ON VIEW public.v_inventory_units IS
  'Inventory units with brand, grouping key and ticket fields, for paged unit lists. (BUG-066.)';

-- ═══ v_inventory_product_groups ══════════════════════════════════════════════
-- The All Units tab: one row per product name, as groupByProduct() built it.
--   replacement  company stock resolved as a replacement
--   credit_note  every other company-stock unit ("else credit_note++")

CREATE OR REPLACE VIEW public.v_inventory_product_groups
WITH (security_invoker = true) AS
SELECT
  g.group_name AS product_name,
  coalesce(nb.brand_name, '') AS brand,
  g.total,
  g.active_rma,
  g.company_stock,
  g.sent_to_manufacturer,
  g.closed,
  g.replacement,
  g.credit_note
FROM (
  SELECT
    coalesce(nullif(product_name, ''), 'Unknown Product') AS group_name,
    count(*)::int AS total,
    count(*) FILTER (WHERE status = 'active_rma')::int AS active_rma,
    count(*) FILTER (WHERE status = 'company_stock')::int AS company_stock,
    count(*) FILTER (WHERE status = 'sent_to_manufacturer')::int AS sent_to_manufacturer,
    count(*) FILTER (WHERE status = 'closed')::int AS closed,
    count(*) FILTER (WHERE status = 'company_stock' AND resolution_type = 'replacement')::int AS replacement,
    count(*) FILTER (WHERE status = 'company_stock' AND resolution_type IS DISTINCT FROM 'replacement')::int AS credit_note
  FROM public.inventory_units
  GROUP BY 1
) g
LEFT JOIN LATERAL (
  SELECT b.brand_name
    FROM public.products p
    LEFT JOIN public.brands b ON b.id = p.brand_id
   WHERE p.product_name = g.group_name
   ORDER BY p.created_date ASC, p.id ASC
   LIMIT 1
) nb ON true;

COMMENT ON VIEW public.v_inventory_product_groups IS
  'Unit counts per product name for the Inventory All Units tab. (BUG-066.)';

-- ═══ v_product_stock_summary ═════════════════════════════════════════════════
-- The Overview dashboard, one row per product: what db.inventory.getStockSummary
-- and src/lib/stockSummary.ts computed from the loaded tables.
--
--   Catalogue products that are not services. (A product with no type is not a
--   service; the old `.neq('product_type', 'service')` also dropped those, and
--   they hold stock like any other.)
--
--   Serialized — over the product's company_stock and active_rma units:
--     available / reserved / delivered  company stock by reservation_status
--                                       ("availability is a property of company stock")
--     main_qty        company stock in a main warehouse, a warehouse with no
--                     type, or no (known) warehouse
--     branches        company stock per branch warehouse
--     rma             active_rma units per SYSTEM location; unplaced units and
--                     non-system locations are not a real RMA stage
--     physical_total  company stock not in SCRAP + RMA units not in SCRAP
--
--   Bulk — over the product's warehouse_stock rows:
--     available = quantity - reserved_quantity, reserved = reserved_quantity,
--     delivered 0, main_qty / branches / physical_total by the same warehouse
--     rules, rma empty.
--
--   Unmatched — active_rma units with no product_id, grouped by name, shown as
--   `unmatched:<name>` rows (in_catalog false) with RMA counts only.
--
-- branch_total and rma_total are the sums of the two arrays, for the filters.

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
         count(*) FILTER (WHERE status = 'company_stock' AND w_main)::int AS main_qty,
         (count(*) FILTER (WHERE status = 'company_stock' AND w_code IS DISTINCT FROM 'SCRAP')
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
           WHERE product_id IS NOT NULL AND status = 'company_stock' AND w_branch
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
  'Warehouse Dashboard stock figures per product (serialized, bulk and unmatched RMA rows). (BUG-066.)';

-- ═══ v_stock_moves_listing ═══════════════════════════════════════════════════
-- Stock Movements tab: each ledger row with the label the tab showed for what
-- moved, so the search can match it in the database.
--   unit             "<product> (<serial>)", or "<product>" with no serial
--   warehouse_stock  "<product> @ <warehouse>"
--   otherwise, or when the referenced row is gone: the ref_id itself

CREATE OR REPLACE VIEW public.v_stock_moves_listing
WITH (security_invoker = true) AS
SELECT
  m.*,
  CASE
    WHEN m.ref_type = 'unit' AND iu.id IS NOT NULL THEN
      CASE WHEN coalesce(iu.serial_number, '') <> ''
           THEN coalesce(iu.product_name, '') || ' (' || iu.serial_number || ')'
           ELSE coalesce(iu.product_name, '') END
    WHEN m.ref_type = 'warehouse_stock' AND s.id IS NOT NULL THEN
      coalesce(nullif(p.product_name, ''), s.product_id::text) || ' @ ' || coalesce(nullif(w.name, ''), s.warehouse_id::text)
    ELSE m.ref_id::text
  END AS ref_label
FROM public.stock_moves m
LEFT JOIN public.inventory_units iu ON m.ref_type = 'unit' AND iu.id = m.ref_id
LEFT JOIN public.warehouse_stock s ON m.ref_type = 'warehouse_stock' AND s.id = m.ref_id
LEFT JOIN public.products p ON p.id = s.product_id
LEFT JOIN public.warehouses w ON w.id = s.warehouse_id;

COMMENT ON VIEW public.v_stock_moves_listing IS
  'Stock moves with a searchable label for what moved, for the Stock Movements tab. (BUG-066.)';

-- ═══ v_bulk_stock_reservations ═══════════════════════════════════════════════
-- Stock Breakdown, bulk products: how much each document still holds reserved,
-- netted from the ledger (reserve adds, release and deliver subtract). The
-- ledger only grows, so this is summed here rather than read back whole.

CREATE OR REPLACE VIEW public.v_bulk_stock_reservations
WITH (security_invoker = true) AS
SELECT
  s.product_id,
  m.doc_type,
  m.doc_id,
  sum(CASE WHEN m.move_type = 'reserve' THEN m.qty
           WHEN m.move_type IN ('release', 'deliver') THEN -m.qty
           ELSE 0 END)::int AS qty
FROM public.stock_moves m
JOIN public.warehouse_stock s ON m.ref_type = 'warehouse_stock' AND s.id = m.ref_id
GROUP BY s.product_id, m.doc_type, m.doc_id
HAVING sum(CASE WHEN m.move_type = 'reserve' THEN m.qty
                WHEN m.move_type IN ('release', 'deliver') THEN -m.qty
                ELSE 0 END) > 0;

COMMENT ON VIEW public.v_bulk_stock_reservations IS
  'Net reserved quantity per bulk product and document, from stock_moves. (BUG-066.)';

-- ═══ v_warehouse_unit_counts ═════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.v_warehouse_unit_counts
WITH (security_invoker = true) AS
SELECT warehouse_id, count(*)::int AS unit_count
  FROM public.inventory_units
 WHERE warehouse_id IS NOT NULL
 GROUP BY warehouse_id;

COMMENT ON VIEW public.v_warehouse_unit_counts IS
  'Inventory units per warehouse, for the Warehouses tab. (BUG-066.)';

-- ═══ Grants ══════════════════════════════════════════════════════════════════

DO $grants$
DECLARE
  v text;
BEGIN
  FOREACH v IN ARRAY ARRAY[
    'v_inventory_units', 'v_inventory_product_groups', 'v_product_stock_summary',
    'v_stock_moves_listing', 'v_bulk_stock_reservations', 'v_warehouse_unit_counts'
  ] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', v);
  END LOOP;
END
$grants$;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════
-- Totals that must agree with the tables before the screen relies on them.

DO $guard$
DECLARE
  n bigint;
BEGIN
  IF (SELECT count(*) FROM public.v_inventory_units) <> (SELECT count(*) FROM public.inventory_units) THEN
    RAISE EXCEPTION 'Refusing to apply: v_inventory_units does not have one row per unit';
  END IF;
  IF (SELECT coalesce(sum(total), 0) FROM public.v_inventory_product_groups) <> (SELECT count(*) FROM public.inventory_units) THEN
    RAISE EXCEPTION 'Refusing to apply: product groups do not add up to the unit count';
  END IF;
  IF (SELECT count(*) FROM public.v_stock_moves_listing) <> (SELECT count(*) FROM public.stock_moves) THEN
    RAISE EXCEPTION 'Refusing to apply: v_stock_moves_listing does not have one row per move';
  END IF;
  IF (SELECT coalesce(sum(unit_count), 0) FROM public.v_warehouse_unit_counts)
     <> (SELECT count(*) FROM public.inventory_units WHERE warehouse_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Refusing to apply: warehouse unit counts do not add up';
  END IF;
  SELECT coalesce(sum(available + reserved + delivered), 0) INTO n
    FROM public.v_product_stock_summary s
    JOIN public.products p ON p.id::text = s.product_id
   WHERE s.stock_tracking_mode = 'serialized';
  IF n <> (SELECT count(*) FROM public.inventory_units iu JOIN public.products p ON p.id = iu.product_id
            WHERE iu.status = 'company_stock' AND p.stock_tracking_mode <> 'bulk'
              AND p.product_type IS DISTINCT FROM 'service'
              AND iu.reservation_status IN ('available', 'reserved', 'delivered')) THEN
    RAISE EXCEPTION 'Refusing to apply: serialized availability % does not match company stock', n;
  END IF;
END
$guard$;
