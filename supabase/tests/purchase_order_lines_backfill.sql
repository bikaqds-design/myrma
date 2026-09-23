-- ############################################################################
-- #  PURCHASE ORDER LINES BACKFILL PROBE — 20260888 sections 8-9, on messy data
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/purchase_order_lines_backfill.sql POBF_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- #
-- #  Seeds orders whose line_items break the rules the new table enforces,
-- #  runs the migration's own backfill text (copied between the BEGIN/END
-- #  markers — src/test/purchaseOrderLines.test.js fails if the copy drifts),
-- #  and checks no line loses data it could keep, and that only DRAFTS are
-- #  re-synced.
-- ############################################################################

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$ SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail) $f$;
CREATE TEMP TABLE bf_ids (tag text, id uuid);
DO $$
DECLARE v_v uuid := gen_random_uuid(); v_p uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.brands (id, brand_name) VALUES (v_v, 'POBF vendor');
  INSERT INTO public.products (id, sku, product_name, product_type) VALUES (v_p, 'POBF-P1', 'POBF product', 'hardware');
  -- as the owner: the revoke is for clients
  INSERT INTO public.purchase_orders (id, po_code, vendor_id, status, currency, created_by, total, line_items) VALUES
   (gen_random_uuid(), 'PO-BF-GOOD',  v_v, 'draft', 'EGP', 'x@y', 0,
      jsonb_build_array(jsonb_build_object('product_id', v_p, 'product_name', 'Good', 'qty_ordered', 3, 'unit_cost', 20, 'tax_pct', 14))),
   (gen_random_uuid(), 'PO-BF-MESSY', v_v, 'draft', 'EGP', 'x@y', 0,
      '[{"product_id":"not-a-uuid","product_name":"","qty_ordered":"2.5","unit_cost":"1,000"},{"product_name":"Neg","qty_ordered":0,"unit_cost":-4,"discount_pct":-10}]'),
   (gen_random_uuid(), 'PO-BF-GHOST', v_v, 'draft', 'EGP', 'x@y', 0,
      jsonb_build_array(jsonb_build_object('product_id', gen_random_uuid(), 'product_name', 'Deleted product', 'qty_ordered', 4, 'unit_cost', 9))),
   (gen_random_uuid(), 'PO-BF-OBJ',   v_v, 'draft', 'EGP', 'x@y', 0, '{"not":"a list"}'),
   (gen_random_uuid(), 'PO-BF-SENT',  v_v, 'sent',  'EGP', 'x@y', 7, '[{"product_id":null,"product_name":"Waiting","qty_ordered":"2.5","unit_cost":2}]');
  INSERT INTO bf_ids SELECT po_code, id FROM public.purchase_orders WHERE vendor_id = v_v;
END $$;

-- BEGIN copy of 20260888 sections 8-9
CREATE OR REPLACE FUNCTION pg_temp.po_bf_num(p text, p_default numeric) RETURNS numeric LANGUAGE plpgsql AS $f$
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
  v_cost     numeric;
  v_dpct     numeric;
  v_tpct     numeric;
  v_unread   boolean;
  v_changed  integer := 0;
  v_lines    integer := 0;
  v_drift    integer;
BEGIN
  FOR v_o IN
    SELECT o.id, o.line_items FROM public.purchase_orders o
     WHERE NOT EXISTS (SELECT 1 FROM public.purchase_order_lines pl WHERE pl.purchase_order_id = o.id)
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

      v_qty  := pg_temp.po_bf_num(v_t.l->>'qty_ordered', 1);
      v_cost := pg_temp.po_bf_num(v_t.l->>'unit_cost', 0);
      v_dpct := pg_temp.po_bf_num(v_t.l->>'discount_pct', 0);
      v_tpct := pg_temp.po_bf_num(v_t.l->>'tax_pct', 0);

      v_unread := EXISTS (SELECT 1 FROM unnest(ARRAY['qty_ordered', 'unit_cost', 'discount_pct', 'tax_pct']) k
                           WHERE v_t.l->>k IS NOT NULL AND btrim(v_t.l->>k) !~ '^-?[0-9]+(\.[0-9]+)?$');

      IF v_unread OR v_qty <> round(v_qty) OR v_qty < 1 OR v_cost < 0 OR v_dpct NOT BETWEEN 0 AND 100 OR v_tpct NOT BETWEEN 0 AND 100
         OR v_pid IS NULL THEN
        v_changed := v_changed + 1;
        RAISE WARNING 'purchase_order_lines backfill: order % line % had values outside the new rules (qty %, cost %, discount %, tax %, product %); stored inside them',
          v_o.id, v_no + 1, v_t.l->>'qty_ordered', v_t.l->>'unit_cost', v_t.l->>'discount_pct', v_t.l->>'tax_pct', COALESCE(v_t.l->>'product_id', '-');
      END IF;

      INSERT INTO public.purchase_order_lines
        (purchase_order_id, line_no, product_id, product_name, description, qty_ordered, unit_cost, discount_pct, tax_pct)
      VALUES (
        v_o.id, v_no, v_pid,
        COALESCE(NULLIF(btrim(COALESCE(v_t.l->>'product_name', '')), ''), '(unnamed line)'),
        NULLIF(btrim(COALESCE(v_t.l->>'description', '')), ''),
        GREATEST(1, LEAST(999999999, round(v_qty)))::integer,
        GREATEST(0, LEAST(9999999999, v_cost)),
        LEAST(100, GREATEST(0, v_dpct)),
        LEAST(100, GREATEST(0, v_tpct))
      );
      v_lines := v_lines + 1;
      v_no := v_no + 1;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_drift
    FROM public.purchase_orders o
    JOIN LATERAL (
      SELECT round(COALESCE(sum(l.qty_ordered * l.unit_cost * (1 - l.discount_pct / 100) * (1 + l.tax_pct / 100)), 0), 2) AS t
        FROM public.purchase_order_lines l WHERE l.purchase_order_id = o.id) s ON true
   WHERE abs(s.t - o.total) > 0.01;

  RAISE NOTICE 'purchase_order_lines backfill: % lines written, % brought inside the new rules, % orders whose lines no longer add up to their stored total',
    v_lines, v_changed, v_drift;
END $$;

-- ── 9. draft orders agree with their rows ────────────────────────────────────
-- A draft is not yet a figure anyone confirmed. Orders sent, pending,
-- confirmed or later keep the figures they were confirmed (or asked to be
-- confirmed) on; the next amendment rewrites them from the rows.
DO $$
DECLARE v_n integer;
BEGIN
  WITH r AS (
    SELECT l.purchase_order_id AS id,
           jsonb_agg(jsonb_build_object(
             'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
             'qty_ordered', l.qty_ordered, 'unit_cost', l.unit_cost, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
             ORDER BY l.line_no) AS items,
           sum(l.qty_ordered * l.unit_cost) AS sub,
           sum(l.qty_ordered * l.unit_cost * l.discount_pct / 100) AS dis,
           sum((l.qty_ordered * l.unit_cost - l.qty_ordered * l.unit_cost * l.discount_pct / 100) * l.tax_pct / 100) AS tax
      FROM public.purchase_order_lines l GROUP BY l.purchase_order_id)
  UPDATE public.purchase_orders o SET
    line_items = r.items, subtotal = round(r.sub, 2), discount_amount = round(r.dis, 2),
    tax_amount = round(r.tax, 2), total = round(r.sub - r.dis + r.tax, 2)
  FROM r
  WHERE o.id = r.id AND o.status = 'draft'
    AND (o.line_items IS DISTINCT FROM r.items OR o.total IS DISTINCT FROM round(r.sub - r.dis + r.tax, 2));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'draft purchase orders synced from their rows: %', v_n;
END $$;

-- END copy of 20260888 sections 8-9

DO $$
DECLARE n int; r record;
BEGIN
  SELECT l.* INTO r FROM public.purchase_order_lines l JOIN bf_ids b ON b.id = l.purchase_order_id WHERE b.tag = 'PO-BF-GOOD';
  RAISE NOTICE '%', pg_temp.check('a clean order keeps its values and product link', r.qty_ordered = 3 AND r.unit_cost = 20 AND r.tax_pct = 14 AND r.product_id IS NOT NULL);
  SELECT count(*) INTO n FROM public.purchase_order_lines l JOIN bf_ids b ON b.id = l.purchase_order_id WHERE b.tag = 'PO-BF-MESSY';
  RAISE NOTICE '%', pg_temp.check('a messy order keeps both lines', n = 2, '-> ' || n);
  RAISE NOTICE '%', pg_temp.check('unreadable values fall back (no product, placeholder name, cost 0), a fractional qty is rounded',
    EXISTS (SELECT 1 FROM public.purchase_order_lines l JOIN bf_ids b ON b.id = l.purchase_order_id
             WHERE b.tag = 'PO-BF-MESSY' AND l.line_no = 0 AND l.product_id IS NULL AND l.product_name LIKE '(%' AND l.unit_cost = 0 AND l.qty_ordered = 3));
  RAISE NOTICE '%', pg_temp.check('out-of-range values are clamped into the constraints',
    EXISTS (SELECT 1 FROM public.purchase_order_lines l JOIN bf_ids b ON b.id = l.purchase_order_id
             WHERE b.tag = 'PO-BF-MESSY' AND l.line_no = 1 AND l.qty_ordered = 1 AND l.unit_cost = 0 AND l.discount_pct = 0));
  RAISE NOTICE '%', pg_temp.check('a line whose product was deleted keeps its name, qty and cost',
    EXISTS (SELECT 1 FROM public.purchase_order_lines l JOIN bf_ids b ON b.id = l.purchase_order_id
             WHERE b.tag = 'PO-BF-GHOST' AND l.product_name = 'Deleted product' AND l.qty_ordered = 4 AND l.unit_cost = 9 AND l.product_id IS NULL));
  SELECT count(*) INTO n FROM public.purchase_order_lines l JOIN bf_ids b ON b.id = l.purchase_order_id WHERE b.tag = 'PO-BF-OBJ';
  RAISE NOTICE '%', pg_temp.check('a non-list blob produces no rows and no error', n = 0, '-> ' || n);
  RAISE NOTICE '%', pg_temp.check('a DRAFT''s mirror and total are rebuilt from its rows',
    (SELECT (o.line_items->1->>'qty_ordered')::int = 1 AND o.total = (SELECT sum(qty_ordered * unit_cost * (1 - discount_pct/100) * (1 + tax_pct/100)) FROM public.purchase_order_lines WHERE purchase_order_id = o.id)
       FROM public.purchase_orders o JOIN bf_ids b ON b.id = o.id WHERE b.tag = 'PO-BF-MESSY'));
  RAISE NOTICE '%', pg_temp.check('a SENT order keeps the figures it was sent with',
    (SELECT o.total = 7 AND o.line_items->0->>'qty_ordered' = '2.5' FROM public.purchase_orders o JOIN bf_ids b ON b.id = o.id WHERE b.tag = 'PO-BF-SENT'));
  RAISE EXCEPTION 'POBF_TEST_DONE';
END $$;
