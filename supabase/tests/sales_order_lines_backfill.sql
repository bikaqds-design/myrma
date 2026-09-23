-- ############################################################################
-- #  SALES ORDER LINES BACKFILL PROBE — 20260884 section 7, on messy data
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/sales_order_lines_backfill.sql SOBF_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- #
-- #  Seeds orders whose line_items break the rules the new table enforces, runs
-- #  the migration's own backfill text (copied between the BEGIN/END markers —
-- #  src/test/salesOrderLines.test.js fails if the copy drifts), and checks no
-- #  line loses data it could keep.
-- ############################################################################

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$ SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail) $f$;
CREATE TEMP TABLE bf_ids (tag text, id uuid);
DO $$
DECLARE v_c uuid; v_p uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('SOBF cust', 'SOBF-C1', 'B2B') RETURNING id INTO v_c;
  INSERT INTO public.products (id, sku, product_name, product_type) VALUES (v_p, 'SOBF-P1', 'SOBF product', 'hardware');
  -- as the owner: the revoke is for clients
  INSERT INTO public.sales_orders (id, so_code, customer_id, created_by, line_items) VALUES
   (gen_random_uuid(), 'SO-BF-GOOD',  v_c, 'x@y', jsonb_build_array(jsonb_build_object('product_id', v_p, 'product_name', 'Good', 'qty', 3, 'unit_price', 20, 'tax_pct', 14))),
   (gen_random_uuid(), 'SO-BF-MESSY', v_c, 'x@y', '[{"product_id":"not-a-uuid","product_name":"","qty":"2.5","unit_price":"abc"},{"product_name":"Neg","qty":0,"unit_price":-4,"discount_pct":-10}]'),
   (gen_random_uuid(), 'SO-BF-GHOST', v_c, 'x@y', jsonb_build_array(jsonb_build_object('product_id', gen_random_uuid(), 'product_name', 'Deleted product', 'qty', 4, 'unit_price', 9))),
   (gen_random_uuid(), 'SO-BF-OBJ',   v_c, 'x@y', '{"not":"a list"}');
  INSERT INTO bf_ids SELECT so_code, id FROM public.sales_orders WHERE so_code LIKE 'SO-BF-%';
END $$;

-- BEGIN copy of 20260884 section 7
CREATE OR REPLACE FUNCTION pg_temp.so_bf_num(p text, p_default numeric) RETURNS numeric LANGUAGE plpgsql AS $f$
BEGIN
  IF btrim(COALESCE(p, '')) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN btrim(p)::numeric; END IF;
  RETURN p_default;
END $f$;

DO $$
DECLARE
  v_o        record;
  v_t        record;
  v_no       integer;
  v_pid      uuid;
  v_qty      numeric;
  v_price    numeric;
  v_dpct     numeric;
  v_tpct     numeric;
  v_changed  integer := 0;
  v_lines    integer := 0;
  v_drift    integer;
BEGIN
  FOR v_o IN
    SELECT o.id, o.line_items FROM public.sales_orders o
     WHERE NOT EXISTS (SELECT 1 FROM public.sales_order_lines ol WHERE ol.sales_order_id = o.id)
       AND jsonb_typeof(o.line_items) = 'array'
  LOOP
    v_no := 0;
    FOR v_t IN SELECT e.l FROM jsonb_array_elements(v_o.line_items) AS e(l)
    LOOP
      IF jsonb_typeof(v_t.l) IS DISTINCT FROM 'object' THEN
        v_t.l := '{}'::jsonb;
      END IF;

      v_pid := NULL;
      IF btrim(COALESCE(v_t.l->>'product_id', '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT p.id INTO v_pid FROM public.products p WHERE p.id = btrim(v_t.l->>'product_id')::uuid;
      END IF;

      v_qty   := pg_temp.so_bf_num(v_t.l->>'qty', 1);
      v_price := pg_temp.so_bf_num(v_t.l->>'unit_price', 0);
      v_dpct  := pg_temp.so_bf_num(v_t.l->>'discount_pct', 0);
      v_tpct  := pg_temp.so_bf_num(v_t.l->>'tax_pct', 0);

      IF v_qty <> round(v_qty) OR v_qty < 1 OR v_price < 0 OR v_dpct NOT BETWEEN 0 AND 100 OR v_tpct NOT BETWEEN 0 AND 100
         OR v_pid IS NULL THEN
        v_changed := v_changed + 1;
        RAISE WARNING 'sales_order_lines backfill: order % line % had values outside the new rules (qty %, price %, discount %, tax %, product %); stored inside them',
          v_o.id, v_no + 1, v_t.l->>'qty', v_t.l->>'unit_price', v_t.l->>'discount_pct', v_t.l->>'tax_pct', COALESCE(v_t.l->>'product_id', '-');
      END IF;

      INSERT INTO public.sales_order_lines
        (sales_order_id, line_no, product_id, product_name, description, qty, unit_price, discount_pct, tax_pct)
      VALUES (
        v_o.id, v_no, v_pid,
        COALESCE(NULLIF(btrim(COALESCE(v_t.l->>'product_name', '')), ''), '(unnamed line)'),
        NULLIF(btrim(COALESCE(v_t.l->>'description', '')), ''),
        GREATEST(1, LEAST(999999999, round(v_qty)))::integer,
        GREATEST(0, LEAST(9999999999, v_price)),
        LEAST(100, GREATEST(0, v_dpct)),
        LEAST(100, GREATEST(0, v_tpct))
      );
      v_lines := v_lines + 1;
      v_no := v_no + 1;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_drift
    FROM public.sales_orders o
    JOIN LATERAL (
      SELECT round(COALESCE(sum(l.qty * l.unit_price * (1 - l.discount_pct / 100) * (1 + l.tax_pct / 100)), 0), 2) AS t
        FROM public.sales_order_lines l WHERE l.sales_order_id = o.id) s ON true
   WHERE abs(s.t - o.total) > 0.01;

  RAISE NOTICE 'sales_order_lines backfill: % lines written, % brought inside the new rules, % orders whose lines no longer add up to their stored total',
    v_lines, v_changed, v_drift;
END $$;

-- END copy of 20260884 section 7

DO $$
DECLARE n int; r record;
BEGIN
  SELECT l.* INTO r FROM public.sales_order_lines l JOIN bf_ids b ON b.id = l.sales_order_id WHERE b.tag = 'SO-BF-GOOD';
  RAISE NOTICE '%', pg_temp.check('a clean order keeps its values and product link', r.qty = 3 AND r.unit_price = 20 AND r.tax_pct = 14 AND r.product_id IS NOT NULL);
  SELECT count(*) INTO n FROM public.sales_order_lines l JOIN bf_ids b ON b.id = l.sales_order_id WHERE b.tag = 'SO-BF-MESSY';
  RAISE NOTICE '%', pg_temp.check('a messy order keeps both lines', n = 2, '-> ' || n);
  RAISE NOTICE '%', pg_temp.check('unreadable values fall back (no product, placeholder name, price 0), a fractional qty is rounded',
    EXISTS (SELECT 1 FROM public.sales_order_lines l JOIN bf_ids b ON b.id = l.sales_order_id
             WHERE b.tag = 'SO-BF-MESSY' AND l.line_no = 0 AND l.product_id IS NULL AND l.product_name LIKE '(%' AND l.unit_price = 0 AND l.qty = 3));
  RAISE NOTICE '%', pg_temp.check('out-of-range values are clamped into the constraints',
    EXISTS (SELECT 1 FROM public.sales_order_lines l JOIN bf_ids b ON b.id = l.sales_order_id
             WHERE b.tag = 'SO-BF-MESSY' AND l.line_no = 1 AND l.qty = 1 AND l.unit_price = 0 AND l.discount_pct = 0));
  RAISE NOTICE '%', pg_temp.check('a line whose product was deleted keeps its name, qty and price',
    EXISTS (SELECT 1 FROM public.sales_order_lines l JOIN bf_ids b ON b.id = l.sales_order_id
             WHERE b.tag = 'SO-BF-GHOST' AND l.product_name = 'Deleted product' AND l.qty = 4 AND l.unit_price = 9 AND l.product_id IS NULL));
  SELECT count(*) INTO n FROM public.sales_order_lines l JOIN bf_ids b ON b.id = l.sales_order_id WHERE b.tag = 'SO-BF-OBJ';
  RAISE NOTICE '%', pg_temp.check('a non-list blob produces no rows and no error', n = 0, '-> ' || n);
  RAISE EXCEPTION 'SOBF_TEST_DONE';
END $$;
