-- ############################################################################
-- #  VENDOR INVOICE LINES BACKFILL PROBE — 20260889 sections 9-10, on messy data
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/vendor_invoice_lines_backfill.sql VIBF_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- #
-- #  Seeds invoices whose line_items break the rules the new table enforces,
-- #  runs the migration's own backfill text (copied between the BEGIN/END
-- #  markers — src/test/vendorInvoiceLines.test.js fails if the copy drifts),
-- #  and checks no line loses data it could keep, and that only DRAFTS are
-- #  re-synced.
-- ############################################################################

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$ SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail) $f$;
CREATE TEMP TABLE bf_ids (tag text, id uuid);
DO $$
DECLARE v_v uuid := gen_random_uuid(); v_p uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.brands (id, brand_name) VALUES (v_v, 'VIBF vendor');
  INSERT INTO public.products (id, sku, product_name, product_type) VALUES (v_p, 'VIBF-P1', 'VIBF product', 'hardware');
  -- as the owner: the revoke is for clients
  INSERT INTO public.vendor_invoices (id, vendor_id, status, currency, created_by, total, notes, line_items) VALUES
   (gen_random_uuid(), v_v, 'draft', 'EGP', 'x@y', 0, 'VI-BF-GOOD',
      jsonb_build_array(jsonb_build_object('product_id', v_p, 'product_name', 'Good', 'qty_ordered', 3, 'qty_received', 0, 'unit_cost', 20, 'tax_pct', 14))),
   (gen_random_uuid(), v_v, 'draft', 'EGP', 'x@y', 0, 'VI-BF-MESSY',
      '[{"product_id":"not-a-uuid","product_name":"","qty_ordered":"2.5","unit_cost":"1,000"},{"product_name":"Neg","qty_ordered":0,"unit_cost":-4,"discount_pct":-10}]'),
   (gen_random_uuid(), v_v, 'draft', 'EGP', 'x@y', 0, 'VI-BF-OBJ', '{"not":"a list"}'),
   (gen_random_uuid(), v_v, 'partially_received', 'EGP', 'x@y', 7, 'VI-BF-RECV',
      jsonb_build_array(jsonb_build_object('product_id', v_p, 'product_name', 'Over', 'qty_ordered', 2, 'qty_received', 5, 'unit_cost', 2)));
  INSERT INTO bf_ids SELECT notes, id FROM public.vendor_invoices WHERE vendor_id = v_v;
END $$;
-- BEGIN copy of 20260889 sections 9-10
CREATE OR REPLACE FUNCTION pg_temp.vi_bf_num(p text, p_default numeric) RETURNS numeric LANGUAGE plpgsql AS $f$
BEGIN
  IF btrim(COALESCE(p, '')) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN btrim(p)::numeric; END IF;
  RETURN p_default;
END $f$;

DO $$
DECLARE
  v_v        record;
  v_t        record;
  v_no       integer;
  v_pid      uuid;
  v_qty      numeric;
  v_rec      numeric;
  v_cost     numeric;
  v_dpct     numeric;
  v_tpct     numeric;
  v_q        integer;
  v_unread   boolean;
  v_changed  integer := 0;
  v_lines    integer := 0;
  v_drift    integer;
BEGIN
  FOR v_v IN
    SELECT i.id, i.line_items FROM public.vendor_invoices i
     WHERE NOT EXISTS (SELECT 1 FROM public.vendor_invoice_lines vl WHERE vl.vendor_invoice_id = i.id)
       AND jsonb_typeof(i.line_items) = 'array'
  LOOP
    v_no := 0;
    FOR v_t IN SELECT e.l FROM jsonb_array_elements(v_v.line_items) AS e(l)
    LOOP
      IF jsonb_typeof(v_t.l) IS DISTINCT FROM 'object' THEN
        v_t.l := '{}'::jsonb;
      END IF;

      v_pid := NULL;
      IF btrim(COALESCE(v_t.l->>'product_id', '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT p.id INTO v_pid FROM public.products p WHERE p.id = btrim(v_t.l->>'product_id')::uuid;
      END IF;

      v_qty  := pg_temp.vi_bf_num(v_t.l->>'qty_ordered', 1);
      v_rec  := pg_temp.vi_bf_num(v_t.l->>'qty_received', 0);
      v_cost := pg_temp.vi_bf_num(v_t.l->>'unit_cost', 0);
      v_dpct := pg_temp.vi_bf_num(v_t.l->>'discount_pct', 0);
      v_tpct := pg_temp.vi_bf_num(v_t.l->>'tax_pct', 0);
      v_q    := GREATEST(1, LEAST(999999999, round(v_qty)))::integer;

      v_unread := EXISTS (SELECT 1 FROM unnest(ARRAY['qty_ordered', 'qty_received', 'unit_cost', 'discount_pct', 'tax_pct']) k
                           WHERE v_t.l->>k IS NOT NULL AND btrim(v_t.l->>k) !~ '^-?[0-9]+(\.[0-9]+)?$');

      IF v_unread OR v_qty <> round(v_qty) OR v_qty < 1 OR v_rec <> round(v_rec) OR v_rec < 0 OR round(v_rec) > v_q
         OR v_cost < 0 OR v_dpct NOT BETWEEN 0 AND 100 OR v_tpct NOT BETWEEN 0 AND 100 OR v_pid IS NULL THEN
        v_changed := v_changed + 1;
        RAISE WARNING 'vendor_invoice_lines backfill: invoice % line % had values outside the new rules (qty %, received %, cost %, discount %, tax %, product %); stored inside them',
          v_v.id, v_no + 1, v_t.l->>'qty_ordered', v_t.l->>'qty_received', v_t.l->>'unit_cost', v_t.l->>'discount_pct', v_t.l->>'tax_pct', COALESCE(v_t.l->>'product_id', '-');
      END IF;

      INSERT INTO public.vendor_invoice_lines
        (vendor_invoice_id, line_no, product_id, product_name, description, qty_ordered, qty_received, unit_cost, discount_pct, tax_pct)
      VALUES (
        v_v.id, v_no, v_pid,
        COALESCE(NULLIF(btrim(COALESCE(v_t.l->>'product_name', '')), ''), '(unnamed line)'),
        NULLIF(btrim(COALESCE(v_t.l->>'description', '')), ''),
        v_q,
        LEAST(v_q, GREATEST(0, round(v_rec)))::integer,
        GREATEST(0, LEAST(9999999999, v_cost)),
        LEAST(100, GREATEST(0, v_dpct)),
        LEAST(100, GREATEST(0, v_tpct))
      );
      v_lines := v_lines + 1;
      v_no := v_no + 1;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_drift
    FROM public.vendor_invoices i
    JOIN LATERAL (
      SELECT round(COALESCE(sum(l.qty_ordered * l.unit_cost * (1 - l.discount_pct / 100) * (1 + l.tax_pct / 100)), 0), 2) AS t
        FROM public.vendor_invoice_lines l WHERE l.vendor_invoice_id = i.id) s ON true
   WHERE abs(s.t - i.total) > 0.01;

  RAISE NOTICE 'vendor_invoice_lines backfill: % lines written, % brought inside the new rules, % invoices whose lines no longer add up to their stored total',
    v_lines, v_changed, v_drift;
END $$;

-- ── 10. draft invoices agree with their rows ─────────────────────────────────
-- A draft has not been submitted, approved or received against. Everything
-- past draft keeps the figures it was submitted, approved or received on.
DO $$
DECLARE v_n integer;
BEGIN
  WITH r AS (
    SELECT l.vendor_invoice_id AS id,
           jsonb_agg(jsonb_build_object(
             'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
             'qty_ordered', l.qty_ordered, 'qty_received', l.qty_received,
             'unit_cost', l.unit_cost, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
             ORDER BY l.line_no) AS items,
           sum(l.qty_ordered * l.unit_cost) AS sub,
           sum(l.qty_ordered * l.unit_cost * l.discount_pct / 100) AS dis,
           sum((l.qty_ordered * l.unit_cost - l.qty_ordered * l.unit_cost * l.discount_pct / 100) * l.tax_pct / 100) AS tax
      FROM public.vendor_invoice_lines l GROUP BY l.vendor_invoice_id)
  UPDATE public.vendor_invoices i SET
    line_items = r.items, subtotal = round(r.sub, 2), discount_amount = round(r.dis, 2),
    tax_amount = round(r.tax, 2), total = round(r.sub - r.dis + r.tax, 2)
  FROM r
  WHERE i.id = r.id AND i.status = 'draft'
    AND (i.line_items IS DISTINCT FROM r.items OR i.total IS DISTINCT FROM round(r.sub - r.dis + r.tax, 2));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'draft vendor invoices synced from their rows: %', v_n;
END $$;

-- END copy of 20260889 sections 9-10

DO $$
DECLARE n int; r record;
BEGIN
  SELECT l.* INTO r FROM public.vendor_invoice_lines l JOIN bf_ids b ON b.id = l.vendor_invoice_id WHERE b.tag = 'VI-BF-GOOD';
  RAISE NOTICE '%', pg_temp.check('a clean invoice keeps its values and product link', r.qty_ordered = 3 AND r.qty_received = 0 AND r.unit_cost = 20 AND r.tax_pct = 14 AND r.product_id IS NOT NULL);
  SELECT count(*) INTO n FROM public.vendor_invoice_lines l JOIN bf_ids b ON b.id = l.vendor_invoice_id WHERE b.tag = 'VI-BF-MESSY';
  RAISE NOTICE '%', pg_temp.check('a messy invoice keeps both lines', n = 2, '-> ' || n);
  RAISE NOTICE '%', pg_temp.check('unreadable values fall back (no product, placeholder name, cost 0), a fractional qty is rounded',
    EXISTS (SELECT 1 FROM public.vendor_invoice_lines l JOIN bf_ids b ON b.id = l.vendor_invoice_id
             WHERE b.tag = 'VI-BF-MESSY' AND l.line_no = 0 AND l.product_id IS NULL AND l.product_name LIKE '(%' AND l.unit_cost = 0 AND l.qty_ordered = 3));
  SELECT count(*) INTO n FROM public.vendor_invoice_lines l JOIN bf_ids b ON b.id = l.vendor_invoice_id WHERE b.tag = 'VI-BF-OBJ';
  RAISE NOTICE '%', pg_temp.check('a non-list blob produces no rows and no error', n = 0, '-> ' || n);
  RAISE NOTICE '%', pg_temp.check('more received than ordered is clamped to what was ordered',
    EXISTS (SELECT 1 FROM public.vendor_invoice_lines l JOIN bf_ids b ON b.id = l.vendor_invoice_id WHERE b.tag = 'VI-BF-RECV' AND l.qty_received = 2 AND l.qty_ordered = 2));
  RAISE NOTICE '%', pg_temp.check('a DRAFT''s mirror and total are rebuilt from its rows',
    (SELECT (v.line_items->1->>'qty_ordered')::int = 1 AND (v.line_items->1->>'qty_received')::int = 0
            AND v.total = (SELECT sum(qty_ordered * unit_cost * (1 - discount_pct/100) * (1 + tax_pct/100)) FROM public.vendor_invoice_lines WHERE vendor_invoice_id = v.id)
       FROM public.vendor_invoices v JOIN bf_ids b ON b.id = v.id WHERE b.tag = 'VI-BF-MESSY'));
  RAISE NOTICE '%', pg_temp.check('an invoice past draft keeps its figures',
    (SELECT v.total = 7 AND (v.line_items->0->>'qty_received')::int = 5 FROM public.vendor_invoices v JOIN bf_ids b ON b.id = v.id WHERE b.tag = 'VI-BF-RECV'));
  RAISE EXCEPTION 'VIBF_TEST_DONE';
END $$;