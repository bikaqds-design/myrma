-- ############################################################################
-- #  CREDIT NOTE LINES BACKFILL PROBE — 20260887 sections 7-8, on messy data
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/credit_note_lines_backfill.sql CNBF_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- #
-- #  Seeds credit notes whose line_items break the rules the new table
-- #  enforces, runs the migration's own backfill text (copied between the
-- #  BEGIN/END markers — src/test/creditNoteLines.test.js fails if the copy
-- #  drifts), and checks no line loses data it could keep, and that only DRAFTS
-- #  are re-synced (a note awaiting approval is fingerprinted; an issued one is
-- #  money already credited).
-- ############################################################################

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$ SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail) $f$;
CREATE TEMP TABLE bf_ids (tag text, id uuid);
DO $$
DECLARE v_c uuid; v_p uuid := gen_random_uuid(); v_w uuid;
BEGIN
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('CNBF cust', 'CNBF-C1', 'B2B') RETURNING id INTO v_c;
  INSERT INTO public.products (id, sku, product_name, product_type) VALUES (v_p, 'CNBF-P1', 'CNBF product', 'hardware');
  INSERT INTO public.warehouses (name, code, warehouse_type) VALUES ('CNBF WH', 'CNBF-WH', 'main') RETURNING id INTO v_w;
  -- as the owner: the revoke is for clients
  INSERT INTO public.credit_notes (id, type, customer_id, status, reason, created_by, total, line_items) VALUES
   (gen_random_uuid(), 'rma_return', v_c, 'draft', 'GOOD', 'x@y', 0,
      jsonb_build_array(jsonb_build_object('product_id', v_p, 'product_name', 'Good', 'qty', 2, 'unit_price', 20, 'restock', true, 'warehouse_id', v_w))),
   (gen_random_uuid(), 'rebate', v_c, 'draft', 'MESSY', 'x@y', 0,
      '[{"product_id":"not-a-uuid","product_name":"","qty":"2.5","unit_price":"1,000","restock":"yes"},{"product_name":"Neg","qty":0,"unit_price":-4}]'),
   (gen_random_uuid(), 'rebate', v_c, 'draft', 'OBJ', 'x@y', 0, '{"not":"a list"}'),
   (gen_random_uuid(), 'rebate', v_c, 'pending_approval', 'PENDING', 'x@y', 9,
      '[{"product_name":"Waiting","qty":"2.5","unit_price":2}]');
  INSERT INTO public.credit_notes (id, type, customer_id, status, reason, created_by, cn_code, total, line_items) VALUES
   (gen_random_uuid(), 'rebate', v_c, 'issued', 'ISSUED', 'x@y', 'CN-BF-1', 7,
      '[{"product_name":"Kept","qty":"2.5","unit_price":2}]');
  INSERT INTO bf_ids SELECT reason, id FROM public.credit_notes WHERE customer_id = v_c;
END $$;

-- BEGIN copy of 20260887 sections 7-8
CREATE OR REPLACE FUNCTION pg_temp.cn_bf_num(p text, p_default numeric) RETURNS numeric LANGUAGE plpgsql AS $f$
BEGIN
  IF btrim(COALESCE(p, '')) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN btrim(p)::numeric; END IF;
  RETURN p_default;
END $f$;

DO $$
DECLARE
  v_c        record;
  v_t        record;
  v_no       integer;
  v_pid      uuid;
  v_wid      uuid;
  v_qty      numeric;
  v_price    numeric;
  v_dpct     numeric;
  v_tpct     numeric;
  v_restock  boolean;
  v_unread   boolean;
  v_changed  integer := 0;
  v_lines    integer := 0;
  v_drift    integer;
BEGIN
  FOR v_c IN
    SELECT c.id, c.line_items FROM public.credit_notes c
     WHERE NOT EXISTS (SELECT 1 FROM public.credit_note_lines cl WHERE cl.credit_note_id = c.id)
       AND jsonb_typeof(c.line_items) = 'array'
  LOOP
    v_no := 0;
    FOR v_t IN SELECT e.l FROM jsonb_array_elements(v_c.line_items) AS e(l)
    LOOP
      IF jsonb_typeof(v_t.l) IS DISTINCT FROM 'object' THEN
        v_t.l := '{}'::jsonb;
      END IF;

      v_pid := NULL;
      IF btrim(COALESCE(v_t.l->>'product_id', '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT p.id INTO v_pid FROM public.products p WHERE p.id = btrim(v_t.l->>'product_id')::uuid;
      END IF;
      v_wid := NULL;
      IF btrim(COALESCE(v_t.l->>'warehouse_id', '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT w.id INTO v_wid FROM public.warehouses w WHERE w.id = btrim(v_t.l->>'warehouse_id')::uuid;
      END IF;
      v_restock := CASE WHEN jsonb_typeof(v_t.l->'restock') = 'boolean' THEN (v_t.l->>'restock')::boolean ELSE false END;

      v_qty   := pg_temp.cn_bf_num(v_t.l->>'qty', 1);
      v_price := pg_temp.cn_bf_num(v_t.l->>'unit_price', 0);
      v_dpct  := pg_temp.cn_bf_num(v_t.l->>'discount_pct', 0);
      v_tpct  := pg_temp.cn_bf_num(v_t.l->>'tax_pct', 0);

      v_unread := EXISTS (SELECT 1 FROM unnest(ARRAY['qty', 'unit_price', 'discount_pct', 'tax_pct']) k
                           WHERE v_t.l->>k IS NOT NULL AND btrim(v_t.l->>k) !~ '^-?[0-9]+(\.[0-9]+)?$');

      -- A product id that is present but does not resolve is a change too (a
      -- credit note may have no product, so only a present one counts).
      IF v_unread OR v_qty <> round(v_qty) OR v_qty < 1 OR v_price < 0 OR v_dpct NOT BETWEEN 0 AND 100 OR v_tpct NOT BETWEEN 0 AND 100
         OR (btrim(COALESCE(v_t.l->>'product_id', '')) <> '' AND v_pid IS NULL) THEN
        v_changed := v_changed + 1;
        RAISE WARNING 'credit_note_lines backfill: credit note % line % had values outside the new rules (qty %, price %, discount %, tax %, product %); stored inside them',
          v_c.id, v_no + 1, v_t.l->>'qty', v_t.l->>'unit_price', v_t.l->>'discount_pct', v_t.l->>'tax_pct', COALESCE(v_t.l->>'product_id', '-');
      END IF;

      INSERT INTO public.credit_note_lines
        (credit_note_id, line_no, product_id, product_name, description, qty, unit_price, discount_pct, tax_pct, restock, warehouse_id)
      VALUES (
        v_c.id, v_no, v_pid,
        COALESCE(NULLIF(btrim(COALESCE(v_t.l->>'product_name', '')), ''), '(unnamed line)'),
        NULLIF(btrim(COALESCE(v_t.l->>'description', '')), ''),
        GREATEST(1, LEAST(999999999, round(v_qty)))::integer,
        GREATEST(0, LEAST(9999999999, v_price)),
        LEAST(100, GREATEST(0, v_dpct)),
        LEAST(100, GREATEST(0, v_tpct)),
        v_restock, v_wid
      );
      v_lines := v_lines + 1;
      v_no := v_no + 1;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_drift
    FROM public.credit_notes c
    JOIN LATERAL (
      SELECT round(COALESCE(sum(l.qty * l.unit_price * (1 - l.discount_pct / 100) * (1 + l.tax_pct / 100)), 0), 2) AS t
        FROM public.credit_note_lines l WHERE l.credit_note_id = c.id) s ON true
   WHERE abs(s.t - c.total) > 0.01;

  RAISE NOTICE 'credit_note_lines backfill: % lines written, % brought inside the new rules, % credit notes whose lines no longer add up to their stored total',
    v_lines, v_changed, v_drift;
END $$;

-- ── 8. draft credit notes agree with their rows ──────────────────────────────
-- Every DRAFT's mirror and totals are rebuilt from its rows (this reformats
-- the stored JSON even where nothing was wrong: the count is "drafts synced").
-- A note awaiting approval is fingerprinted and is NOT touched — rewriting it
-- would make it unissuable; issued, applied and voided notes keep their
-- figures.
DO $$
DECLARE v_n integer;
BEGIN
  WITH r AS (
    SELECT l.credit_note_id AS id,
           jsonb_agg(jsonb_build_object(
             'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
             'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct,
             'restock', l.restock, 'warehouse_id', l.warehouse_id)
             ORDER BY l.line_no) AS items,
           sum(l.qty * l.unit_price) AS sub,
           sum(l.qty * l.unit_price * l.discount_pct / 100) AS dis,
           sum((l.qty * l.unit_price - l.qty * l.unit_price * l.discount_pct / 100) * l.tax_pct / 100) AS tax
      FROM public.credit_note_lines l GROUP BY l.credit_note_id)
  UPDATE public.credit_notes c SET
    line_items = r.items, subtotal = round(r.sub, 2), discount_amount = round(r.dis, 2),
    tax_amount = round(r.tax, 2), total = round(r.sub - r.dis + r.tax, 2)
  FROM r
  WHERE c.id = r.id AND c.status = 'draft'
    AND (c.line_items IS DISTINCT FROM r.items OR c.total IS DISTINCT FROM round(r.sub - r.dis + r.tax, 2));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'draft credit notes synced from their rows: %', v_n;
END $$;

-- END copy of 20260887 sections 7-8

DO $$
DECLARE n int; r record;
BEGIN
  SELECT l.* INTO r FROM public.credit_note_lines l JOIN bf_ids b ON b.id = l.credit_note_id WHERE b.tag = 'GOOD';
  RAISE NOTICE '%', pg_temp.check('a clean note keeps its values, product, restock flag and warehouse',
    r.qty = 2 AND r.unit_price = 20 AND r.product_id IS NOT NULL AND r.restock AND r.warehouse_id IS NOT NULL);
  SELECT count(*) INTO n FROM public.credit_note_lines l JOIN bf_ids b ON b.id = l.credit_note_id WHERE b.tag = 'MESSY';
  RAISE NOTICE '%', pg_temp.check('a messy note keeps both lines', n = 2, '-> ' || n);
  RAISE NOTICE '%', pg_temp.check('unreadable values fall back (no product, placeholder name, price 0, restock off), a fractional qty is rounded',
    EXISTS (SELECT 1 FROM public.credit_note_lines l JOIN bf_ids b ON b.id = l.credit_note_id
             WHERE b.tag = 'MESSY' AND l.line_no = 0 AND l.product_id IS NULL AND l.product_name LIKE '(%' AND l.unit_price = 0 AND l.qty = 3 AND NOT l.restock));
  SELECT count(*) INTO n FROM public.credit_note_lines l JOIN bf_ids b ON b.id = l.credit_note_id WHERE b.tag = 'OBJ';
  RAISE NOTICE '%', pg_temp.check('a non-list blob produces no rows and no error', n = 0, '-> ' || n);
  RAISE NOTICE '%', pg_temp.check('a DRAFT is re-synced from its rows',
    (SELECT (c.line_items->1->>'qty')::int = 1 AND c.total = (SELECT sum(qty * unit_price * (1 - discount_pct/100) * (1 + tax_pct/100)) FROM public.credit_note_lines WHERE credit_note_id = c.id)
       FROM public.credit_notes c JOIN bf_ids b ON b.id = c.id WHERE b.tag = 'MESSY'));
  RAISE NOTICE '%', pg_temp.check('a note AWAITING APPROVAL is not touched (its fingerprint must still match)',
    (SELECT c.total = 9 AND c.line_items->0->>'qty' = '2.5' FROM public.credit_notes c JOIN bf_ids b ON b.id = c.id WHERE b.tag = 'PENDING'));
  RAISE NOTICE '%', pg_temp.check('an ISSUED note keeps its figures',
    (SELECT c.total = 7 AND c.line_items->0->>'qty' = '2.5' FROM public.credit_notes c JOIN bf_ids b ON b.id = c.id WHERE b.tag = 'ISSUED'));
  RAISE EXCEPTION 'CNBF_TEST_DONE';
END $$;
