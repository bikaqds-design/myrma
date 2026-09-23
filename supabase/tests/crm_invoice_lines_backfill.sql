-- ############################################################################
-- #  SALES INVOICE LINES BACKFILL PROBE — 20260885 sections 7-8, on messy data
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/crm_invoice_lines_backfill.sql INVBF_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- #
-- #  Seeds invoices whose line_items break the rules the new table enforces, runs
-- #  the migration's own backfill text (copied between the BEGIN/END markers —
-- #  src/test/crmInvoiceLines.test.js fails if the copy drifts), and checks no
-- #  line loses data it could keep and no POSTED invoice's figures move.
-- ############################################################################

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$ SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail) $f$;
CREATE TEMP TABLE bf_ids (tag text, id uuid);
DO $$
DECLARE v_c uuid; v_p uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('INVBF cust', 'INVBF-C1', 'B2B') RETURNING id INTO v_c;
  INSERT INTO public.products (id, sku, product_name, product_type) VALUES (v_p, 'INVBF-P1', 'INVBF product', 'hardware');
  -- as the owner: the revoke is for clients
  INSERT INTO public.crm_invoices (id, customer_id, created_by, doc_status, payment_status, line_items) VALUES
   (gen_random_uuid(), v_c, 'x@y', 'draft', 'unpaid', jsonb_build_array(jsonb_build_object('product_id', v_p, 'product_name', 'Good', 'qty', 3, 'unit_price', 20, 'tax_pct', 14))),
   (gen_random_uuid(), v_c, 'x@y', 'draft', 'unpaid', '[{"product_id":"not-a-uuid","product_name":"","qty":"2.5","unit_price":"1,000"},{"product_name":"Neg","qty":0,"unit_price":-4}]'),
   (gen_random_uuid(), v_c, 'x@y', 'draft', 'unpaid', jsonb_build_array(jsonb_build_object('product_id', gen_random_uuid(), 'product_name', 'Deleted product', 'qty', 4, 'unit_price', 9))),
   (gen_random_uuid(), v_c, 'x@y', 'draft', 'unpaid', '{"not":"a list"}');
  INSERT INTO public.crm_invoices (id, customer_id, created_by, doc_status, payment_status, inv_code, total, line_items) VALUES
   (gen_random_uuid(), v_c, 'x@y', 'posted', 'unpaid', 'INV-BF-POSTED', 7, jsonb_build_array(jsonb_build_object('product_id', v_p, 'product_name', 'Kept', 'qty', '2.5', 'unit_price', 2)));
  INSERT INTO bf_ids SELECT tag, id FROM (
    SELECT id, CASE WHEN inv_code = 'INV-BF-POSTED' THEN 'POSTED'
                    WHEN line_items::text LIKE '%Good%' THEN 'GOOD'
                    WHEN line_items::text LIKE '%not-a-uuid%' THEN 'MESSY'
                    WHEN line_items::text LIKE '%Deleted product%' THEN 'GHOST'
                    WHEN jsonb_typeof(line_items) = 'object' THEN 'OBJ' END AS tag
      FROM public.crm_invoices WHERE customer_id = v_c) t;
END $$;

-- BEGIN copy of 20260885 sections 7-8
CREATE OR REPLACE FUNCTION pg_temp.inv_bf_num(p text, p_default numeric) RETURNS numeric LANGUAGE plpgsql AS $f$
BEGIN
  IF btrim(COALESCE(p, '')) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN btrim(p)::numeric; END IF;
  RETURN p_default;
END $f$;

DO $$
DECLARE
  v_i        record;
  v_t        record;
  v_no       integer;
  v_pid      uuid;
  v_qty      numeric;
  v_price    numeric;
  v_dpct     numeric;
  v_tpct     numeric;
  v_unread   boolean;
  v_changed  integer := 0;
  v_lines    integer := 0;
  v_drift    integer;
BEGIN
  FOR v_i IN
    SELECT i.id, i.line_items FROM public.crm_invoices i
     WHERE NOT EXISTS (SELECT 1 FROM public.crm_invoice_lines il WHERE il.crm_invoice_id = i.id)
       AND jsonb_typeof(i.line_items) = 'array'
  LOOP
    v_no := 0;
    FOR v_t IN SELECT e.l FROM jsonb_array_elements(v_i.line_items) AS e(l)
    LOOP
      IF jsonb_typeof(v_t.l) IS DISTINCT FROM 'object' THEN
        v_t.l := '{}'::jsonb;
      END IF;

      v_pid := NULL;
      IF btrim(COALESCE(v_t.l->>'product_id', '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT p.id INTO v_pid FROM public.products p WHERE p.id = btrim(v_t.l->>'product_id')::uuid;
      END IF;

      v_qty   := pg_temp.inv_bf_num(v_t.l->>'qty', 1);
      v_price := pg_temp.inv_bf_num(v_t.l->>'unit_price', 0);
      v_dpct  := pg_temp.inv_bf_num(v_t.l->>'discount_pct', 0);
      v_tpct  := pg_temp.inv_bf_num(v_t.l->>'tax_pct', 0);

      v_unread := EXISTS (SELECT 1 FROM unnest(ARRAY['qty', 'unit_price', 'discount_pct', 'tax_pct']) k
                           WHERE v_t.l->>k IS NOT NULL AND btrim(v_t.l->>k) !~ '^-?[0-9]+(\.[0-9]+)?$');

      IF v_unread OR v_qty <> round(v_qty) OR v_qty < 1 OR v_price < 0 OR v_dpct NOT BETWEEN 0 AND 100 OR v_tpct NOT BETWEEN 0 AND 100
         OR v_pid IS NULL THEN
        v_changed := v_changed + 1;
        RAISE WARNING 'crm_invoice_lines backfill: invoice % line % had values outside the new rules (qty %, price %, discount %, tax %, product %); stored inside them',
          v_i.id, v_no + 1, v_t.l->>'qty', v_t.l->>'unit_price', v_t.l->>'discount_pct', v_t.l->>'tax_pct', COALESCE(v_t.l->>'product_id', '-');
      END IF;

      INSERT INTO public.crm_invoice_lines
        (crm_invoice_id, line_no, product_id, product_name, description, qty, unit_price, discount_pct, tax_pct)
      VALUES (
        v_i.id, v_no, v_pid,
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
    FROM public.crm_invoices i
    JOIN LATERAL (
      SELECT round(COALESCE(sum(l.qty * l.unit_price * (1 - l.discount_pct / 100) * (1 + l.tax_pct / 100)), 0), 2) AS t
        FROM public.crm_invoice_lines l WHERE l.crm_invoice_id = i.id) s ON true
   WHERE abs(s.t - i.total) > 0.01;

  RAISE NOTICE 'crm_invoice_lines backfill: % lines written, % brought inside the new rules, % invoices whose lines no longer add up to their stored total',
    v_lines, v_changed, v_drift;
END $$;

-- ── 8. draft invoices agree with their rows ──────────────────────────────────
-- A draft is not an issued figure, and post_invoice will deliver stock and
-- book cost of goods from its line_items. Where the backfill corrected a
-- historical line, a DRAFT's mirror and totals are rebuilt from the rows.
-- Posted, paid and void invoices keep their figures as issued.
DO $$
DECLARE v_n integer;
BEGIN
  WITH r AS (
    SELECT l.crm_invoice_id AS id,
           jsonb_agg(jsonb_build_object(
             'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
             'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
             ORDER BY l.line_no) AS items,
           sum(l.qty * l.unit_price) AS sub,
           sum(l.qty * l.unit_price * l.discount_pct / 100) AS dis,
           sum((l.qty * l.unit_price - l.qty * l.unit_price * l.discount_pct / 100) * l.tax_pct / 100) AS tax
      FROM public.crm_invoice_lines l GROUP BY l.crm_invoice_id)
  UPDATE public.crm_invoices i SET
    line_items = r.items, subtotal = round(r.sub, 2), discount_amount = round(r.dis, 2),
    tax_amount = round(r.tax, 2), total = round(r.sub - r.dis + r.tax, 2)
  FROM r
  WHERE i.id = r.id AND i.doc_status = 'draft'
    AND (i.line_items IS DISTINCT FROM r.items OR i.total IS DISTINCT FROM round(r.sub - r.dis + r.tax, 2));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'draft invoices rebuilt from their rows: %', v_n;
END $$;

-- END copy of 20260885 sections 7-8

DO $$
DECLARE n int; r record;
BEGIN
  SELECT l.* INTO r FROM public.crm_invoice_lines l JOIN bf_ids b ON b.id = l.crm_invoice_id WHERE b.tag = 'GOOD';
  RAISE NOTICE '%', pg_temp.check('a clean invoice keeps its values and product link', r.qty = 3 AND r.unit_price = 20 AND r.tax_pct = 14 AND r.product_id IS NOT NULL);
  SELECT count(*) INTO n FROM public.crm_invoice_lines l JOIN bf_ids b ON b.id = l.crm_invoice_id WHERE b.tag = 'MESSY';
  RAISE NOTICE '%', pg_temp.check('a messy invoice keeps both lines', n = 2, '-> ' || n);
  RAISE NOTICE '%', pg_temp.check('unreadable values fall back (price "1,000" -> 0 with a warning), a fractional qty is rounded',
    EXISTS (SELECT 1 FROM public.crm_invoice_lines l JOIN bf_ids b ON b.id = l.crm_invoice_id
             WHERE b.tag = 'MESSY' AND l.line_no = 0 AND l.product_id IS NULL AND l.unit_price = 0 AND l.qty = 3));
  RAISE NOTICE '%', pg_temp.check('a line whose product was deleted keeps its name, qty and price',
    EXISTS (SELECT 1 FROM public.crm_invoice_lines l JOIN bf_ids b ON b.id = l.crm_invoice_id
             WHERE b.tag = 'GHOST' AND l.product_name = 'Deleted product' AND l.qty = 4 AND l.unit_price = 9 AND l.product_id IS NULL));
  SELECT count(*) INTO n FROM public.crm_invoice_lines l JOIN bf_ids b ON b.id = l.crm_invoice_id WHERE b.tag = 'OBJ';
  RAISE NOTICE '%', pg_temp.check('a non-list blob produces no rows and no error', n = 0, '-> ' || n);
  RAISE NOTICE '%', pg_temp.check('a DRAFT invoice''s mirror and total are rebuilt from its corrected rows',
    (SELECT (i.line_items->1->>'qty')::int = 1 AND i.total = (SELECT sum(qty * unit_price * (1 - discount_pct/100) * (1 + tax_pct/100)) FROM public.crm_invoice_lines WHERE crm_invoice_id = i.id)
       FROM public.crm_invoices i JOIN bf_ids b ON b.id = i.id WHERE b.tag = 'MESSY'));
  RAISE NOTICE '%', pg_temp.check('a POSTED invoice keeps its issued figures',
    (SELECT i.total = 7 AND i.line_items->0->>'qty' = '2.5' FROM public.crm_invoices i JOIN bf_ids b ON b.id = i.id WHERE b.tag = 'POSTED'));
  RAISE EXCEPTION 'INVBF_TEST_DONE';
END $$;
