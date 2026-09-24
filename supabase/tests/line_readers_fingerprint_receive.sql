-- ############################################################################
-- #  LINE READERS — W2 / L-02 step 3 (20260891)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/line_readers_fingerprint_receive.sql L02C_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- ############################################################################

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail)
$f$;

CREATE FUNCTION pg_temp.call(p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE out text;
BEGIN
  IF p_email IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
  BEGIN
    EXECUTE p_sql;
    out := 'ok';
  EXCEPTION WHEN OTHERS THEN
    out := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 160);
  END;
  IF p_email IS NOT NULL THEN
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', '', true);
  END IF;
  RETURN out;
END $f$;

CREATE FUNCTION pg_temp.as_user(p_email text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $f$;
CREATE FUNCTION pg_temp.as_owner() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
END $f$;

-- the fingerprint as it was taken before 20260891: over the copy
CREATE FUNCTION pg_temp.copy_hash(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT md5(concat_ws('|', c.type, c.customer_id::text, COALESCE(c.source_invoice_id::text, ''),
                       c.total::text, c.subtotal::text, c.line_items::text))
    FROM public.credit_notes c WHERE c.id = p_id
$f$;

DO $do$
DECLARE
  v_mgr   text := 'l02c-mgr@test.local';
  v_mgr2  text := 'l02c-mgr2@test.local';
  v_cust  uuid;
  v_wh    uuid := gen_random_uuid();
  v_bulk  uuid := gen_random_uuid();
  v_v1    uuid := gen_random_uuid();
  v_cn    public.credit_notes;
  v_vi    public.vendor_invoices;
  v_lines jsonb := '[{"product_name":"Goodwill","qty":1,"unit_price":100}]';
  v_out   text;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_mgr, 'manager', 'active'), (v_mgr2, 'manager', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('L02C Co', 'L02C-C1', 'B2B') RETURNING id INTO v_cust;
  INSERT INTO public.warehouses (id, name, code, warehouse_type) VALUES (v_wh, 'L02C WH', 'L02C-WH', 'main');
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode) VALUES (v_bulk, 'L02C-BULK', 'L02C bulk', 'hardware', 'bulk');
  INSERT INTO public.brands (id, brand_name) VALUES (v_v1, 'L02C Vendor');

  -- ══ 1. the approval fingerprint covers the rows ═══════════════════════════
  RAISE NOTICE '--- 1. fingerprint ---';
  PERFORM pg_temp.as_user(v_mgr);
  v_cn := public.create_credit_note('rebate', v_cust, 'Goodwill after a late delivery', 'goodwill', v_lines, NULL, NULL, NULL, v_mgr);
  PERFORM pg_temp.as_owner();
  v_out := pg_temp.call(v_mgr, format('SELECT public.submit_credit_note_for_approval(%L, %L)', v_cn.id, v_mgr));
  -- as the owner: the rows change behind the pending note, its copy does not
  UPDATE public.credit_note_lines SET unit_price = 5000 WHERE credit_note_id = v_cn.id;
  v_out := pg_temp.call(v_mgr2, format('SELECT public.issue_credit_note(%L, %L)', v_cn.id, v_mgr2));
  RAISE NOTICE '%', pg_temp.check('a pending note whose rows changed is not issued (the copy alone looked unchanged)',
    v_out LIKE 'err:P0001%changed after it was submitted%' AND (SELECT status FROM public.credit_notes WHERE id = v_cn.id) = 'pending_approval', '-> ' || v_out);
  UPDATE public.credit_note_lines SET unit_price = 100 WHERE credit_note_id = v_cn.id;
  v_out := pg_temp.call(v_mgr2, format('SELECT public.issue_credit_note(%L, %L)', v_cn.id, v_mgr2));
  RAISE NOTICE '%', pg_temp.check('an unchanged note is issued by a second manager', v_out = 'ok'
    AND (SELECT status FROM public.credit_notes WHERE id = v_cn.id) IN ('issued', 'applied'), '-> ' || v_out);

  -- ══ 2. a note submitted before the change ═════════════════════════════════
  RAISE NOTICE '--- 2. notes submitted before 20260891 ---';
  PERFORM pg_temp.as_user(v_mgr);
  v_cn := public.create_credit_note('rebate', v_cust, 'Goodwill after a late delivery', 'goodwill', v_lines, NULL, NULL, NULL, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.credit_notes SET status = 'pending_approval', submitted_hash = pg_temp.copy_hash(v_cn.id) WHERE id = v_cn.id;
  v_out := pg_temp.call(v_mgr2, format('SELECT public.issue_credit_note(%L, %L)', v_cn.id, v_mgr2));
  RAISE NOTICE '%', pg_temp.check('a note fingerprinted over its copy is still issued while the copy equals its rows', v_out = 'ok', '-> ' || v_out);

  PERFORM pg_temp.as_user(v_mgr);
  v_cn := public.create_credit_note('rebate', v_cust, 'Goodwill after a late delivery', 'goodwill', v_lines, NULL, NULL, NULL, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.credit_note_lines SET unit_price = 5000 WHERE credit_note_id = v_cn.id;
  UPDATE public.credit_notes SET status = 'pending_approval', submitted_hash = pg_temp.copy_hash(v_cn.id) WHERE id = v_cn.id;
  v_out := pg_temp.call(v_mgr2, format('SELECT public.issue_credit_note(%L, %L)', v_cn.id, v_mgr2));
  RAISE NOTICE '%', pg_temp.check('...but not once its copy and rows disagree', v_out LIKE 'err:P0001%changed after it was submitted%', '-> ' || v_out);

  -- ══ 3. receiving follows the rows ═════════════════════════════════════════
  RAISE NOTICE '--- 3. receive ---';
  PERFORM pg_temp.as_user(v_mgr);
  v_vi := public.create_vendor_invoice(v_v1, jsonb_build_array(jsonb_build_object('product_id', v_bulk, 'qty_ordered', 3, 'unit_cost', 10)),
            '{"currency":"EGP","supplier_invoice_no":"L02C-1","non_po_reason":"Stock top-up, no PO"}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.vendor_invoices SET status = 'pending_approval' WHERE id = v_vi.id;
  UPDATE public.vendor_invoices SET status = 'approved', line_items = jsonb_set(line_items, '{0,qty_ordered}', '1') WHERE id = v_vi.id;
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.receive_vendor_invoice(%L, %L::jsonb, %L)$q$, v_vi.id,
    jsonb_build_array(jsonb_build_object('product_id', v_bulk, 'warehouse_id', v_wh, 'qty', 3, 'line_index', 0)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('receiving the 3 units on the row is allowed (the copy said only 1 was ordered)', v_out = 'ok'
    AND (SELECT status FROM public.vendor_invoices WHERE id = v_vi.id) = 'received', '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('the copy is rebuilt from the rows it was received against',
    (SELECT (line_items->0->>'qty_ordered')::int = 3 AND (line_items->0->>'qty_received')::int = 3 FROM public.vendor_invoices WHERE id = v_vi.id)
    AND (SELECT qty_received FROM public.vendor_invoice_lines WHERE vendor_invoice_id = v_vi.id) = 3);

  RAISE EXCEPTION 'L02C_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
