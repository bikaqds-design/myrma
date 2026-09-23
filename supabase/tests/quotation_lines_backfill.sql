-- ############################################################################
-- #  QUOTATION LINES BACKFILL PROBE — 20260883 section 6, on messy data
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/quotation_lines_backfill.sql BF_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- #
-- #  Seeds quotations whose line_items break every rule the new table enforces,
-- #  runs the migration's own backfill text (copied between the BEGIN/END
-- #  markers below — src/test/quotationLines.test.js fails if the copy drifts
-- #  from the migration), and checks no line loses data it could keep. The first
-- #  version of this backfill stored EVERY line as a blank; this is what caught it.
-- ############################################################################

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$ SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail) $f$;
CREATE TEMP TABLE bf_ids (tag text, id uuid);
DO $$
DECLARE v_c uuid; v_p uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('BF cust', 'BF-C1', 'B2B') RETURNING id INTO v_c;
  INSERT INTO public.products (id, sku, product_name, product_type) VALUES (v_p, 'BF-P1', 'BF product', 'hardware');
  -- as the owner: the revoke is for clients
  INSERT INTO public.quotations (id, qt_code, customer_id, created_by, line_items) VALUES
   (gen_random_uuid(), 'QT-BF-GOOD',  v_c, 'x@y', jsonb_build_array(jsonb_build_object('product_id', v_p, 'product_name', 'Good', 'qty', 2, 'unit_price', 10, 'discount_pct', 5))),
   (gen_random_uuid(), 'QT-BF-MESSY', v_c, 'x@y', '[{"product_id":"not-a-uuid","product_name":"  ","qty":"","unit_price":""},{"product_name":"Neg","qty":-3,"unit_price":-1,"tax_pct":250}]'),
   (gen_random_uuid(), 'QT-BF-GHOST', v_c, 'x@y', jsonb_build_array(jsonb_build_object('product_id', gen_random_uuid(), 'product_name', 'Deleted product', 'qty', 1, 'unit_price', 1))),
   (gen_random_uuid(), 'QT-BF-OBJ',   v_c, 'x@y', '{"not":"a list"}'),
   (gen_random_uuid(), 'QT-BF-EMPTY', v_c, 'x@y', '[]');
  INSERT INTO bf_ids SELECT qt_code, id FROM public.quotations WHERE qt_code LIKE 'QT-BF-%';
END $$;

-- BEGIN copy of 20260883 section 6
CREATE OR REPLACE FUNCTION pg_temp.qt_bf_num(p text, p_default numeric) RETURNS numeric LANGUAGE plpgsql AS $f$
BEGIN
  IF btrim(COALESCE(p, '')) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN btrim(p)::numeric; END IF;
  RETURN p_default;
END $f$;

DO $$
DECLARE
  v_q        record;
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
  FOR v_q IN
    SELECT q.id, q.line_items FROM public.quotations q
     WHERE NOT EXISTS (SELECT 1 FROM public.quotation_lines ql WHERE ql.quotation_id = q.id)
       AND jsonb_typeof(q.line_items) = 'array'   -- a non-array blob would abort the whole migration
  LOOP
    v_no := 0;
    FOR v_t IN SELECT e.l FROM jsonb_array_elements(v_q.line_items) AS e(l)
    LOOP
      IF jsonb_typeof(v_t.l) IS DISTINCT FROM 'object' THEN
        v_t.l := '{}'::jsonb;
      END IF;

      v_pid := NULL;
      IF btrim(COALESCE(v_t.l->>'product_id', '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT p.id INTO v_pid FROM public.products p WHERE p.id = btrim(v_t.l->>'product_id')::uuid;
      END IF;

      v_qty   := pg_temp.qt_bf_num(v_t.l->>'qty', 1);
      v_price := pg_temp.qt_bf_num(v_t.l->>'unit_price', 0);
      v_dpct  := pg_temp.qt_bf_num(v_t.l->>'discount_pct', 0);
      v_tpct  := pg_temp.qt_bf_num(v_t.l->>'tax_pct', 0);

      IF v_qty <> round(v_qty) OR v_qty < 1 OR v_price < 0 OR v_dpct NOT BETWEEN 0 AND 100 OR v_tpct NOT BETWEEN 0 AND 100
         OR (btrim(COALESCE(v_t.l->>'product_id', '')) <> '' AND v_pid IS NULL) THEN
        v_changed := v_changed + 1;
        RAISE WARNING 'quotation_lines backfill: quotation % line % had values outside the new rules (qty %, price %, discount %, tax %, product %); stored inside them',
          v_q.id, v_no + 1, v_t.l->>'qty', v_t.l->>'unit_price', v_t.l->>'discount_pct', v_t.l->>'tax_pct', COALESCE(v_t.l->>'product_id', '-');
      END IF;

      INSERT INTO public.quotation_lines
        (quotation_id, line_no, product_id, product_name, description, qty, unit_price, discount_pct, tax_pct)
      VALUES (
        v_q.id, v_no, v_pid,
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
    FROM public.quotations q
    JOIN LATERAL (
      SELECT round(COALESCE(sum(l.qty * l.unit_price * (1 - l.discount_pct / 100) * (1 + l.tax_pct / 100)), 0), 2) AS t
        FROM public.quotation_lines l WHERE l.quotation_id = q.id) s ON true
   WHERE abs(s.t - q.total) > 0.01;

  RAISE NOTICE 'quotation_lines backfill: % lines written, % brought inside the new rules, % quotations whose lines no longer add up to their stored total',
    v_lines, v_changed, v_drift;
END $$;

-- END copy of 20260883 section 6

DO $$
DECLARE n int; r record;
BEGIN
  SELECT count(*) INTO n FROM public.quotation_lines l JOIN bf_ids b ON b.id = l.quotation_id WHERE b.tag = 'QT-BF-GOOD';
  RAISE NOTICE '%', pg_temp.check('a clean quotation gets its one line', n = 1, '-> ' || n);
  SELECT l.* INTO r FROM public.quotation_lines l JOIN bf_ids b ON b.id = l.quotation_id WHERE b.tag = 'QT-BF-GOOD';
  RAISE NOTICE '%', pg_temp.check('...with its values and product FK intact', r.qty = 2 AND r.unit_price = 10 AND r.discount_pct = 5 AND r.product_id IS NOT NULL);
  SELECT count(*) INTO n FROM public.quotation_lines l JOIN bf_ids b ON b.id = l.quotation_id WHERE b.tag = 'QT-BF-MESSY';
  RAISE NOTICE '%', pg_temp.check('a messy quotation keeps every line (2), none lost', n = 2, '-> ' || n);
  RAISE NOTICE '%', pg_temp.check('a garbage product id becomes NULL, a blank name a visible placeholder',
    EXISTS (SELECT 1 FROM public.quotation_lines l JOIN bf_ids b ON b.id = l.quotation_id
             WHERE b.tag = 'QT-BF-MESSY' AND l.line_no = 0 AND l.product_id IS NULL AND l.product_name LIKE '(%'));
  RAISE NOTICE '%', pg_temp.check('negative and out-of-range numbers are clamped into the constraints',
    EXISTS (SELECT 1 FROM public.quotation_lines l JOIN bf_ids b ON b.id = l.quotation_id
             WHERE b.tag = 'QT-BF-MESSY' AND l.line_no = 1 AND l.qty = 1 AND l.unit_price = 0 AND l.tax_pct = 100));
  SELECT count(*) INTO n FROM public.quotation_lines l JOIN bf_ids b ON b.id = l.quotation_id WHERE b.tag = 'QT-BF-GHOST';
  RAISE NOTICE '%', pg_temp.check('a line whose product was deleted is kept instead of aborting the migration', n = 1, '-> ' || n);
  RAISE NOTICE '%', pg_temp.check('...and keeps its name, quantity and price, losing only the product link', EXISTS (SELECT 1 FROM public.quotation_lines l JOIN bf_ids b ON b.id = l.quotation_id WHERE b.tag = 'QT-BF-GHOST' AND l.product_name = 'Deleted product' AND l.qty = 1 AND l.unit_price = 1 AND l.product_id IS NULL));
  SELECT count(*) INTO n FROM public.quotation_lines l JOIN bf_ids b ON b.id = l.quotation_id WHERE b.tag IN ('QT-BF-OBJ', 'QT-BF-EMPTY');
  RAISE NOTICE '%', pg_temp.check('a non-list blob and an empty list produce no rows and no error', n = 0, '-> ' || n);
  RAISE EXCEPTION 'BF_TEST_DONE';
END $$;
