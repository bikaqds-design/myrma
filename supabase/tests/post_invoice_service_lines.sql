-- ############################################################################
-- #  POST_INVOICE AND SERVICE LINES (20260886)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/post_invoice_service_lines.sql PIS_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- #
-- #  Before 20260886 the first check failed: an order invoice with a service
-- #  line could never be posted.
-- ############################################################################

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail)
$f$;

CREATE FUNCTION pg_temp.call(p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE out text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    out := 'ok';
  EXCEPTION WHEN OTHERS THEN
    out := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 160);
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN out;
END $f$;

DO $do$
DECLARE
  v_mgr  text := 'pis-mgr@test.local';
  v_cust uuid;
  v_svc  uuid := gen_random_uuid();
  v_ser  uuid := gen_random_uuid();
  v_so1  uuid := gen_random_uuid();
  v_so2  uuid := gen_random_uuid();
  v_inv1 uuid := gen_random_uuid();
  v_inv2 uuid := gen_random_uuid();
  v_out  text;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_mgr, 'manager', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('PIS Customer', 'PIS-C1', 'B2B') RETURNING id INTO v_cust;
  -- a service keeps the default stock_tracking_mode ('serialized'), as real ones do
  INSERT INTO public.products (id, sku, product_name, product_type) VALUES (v_svc, 'PIS-SVC', 'Installation', 'service');
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode) VALUES (v_ser, 'PIS-SER', 'Router', 'hardware', 'serialized');

  -- as the owner: confirmed orders and their draft invoices, set up directly
  INSERT INTO public.sales_orders (id, so_code, customer_id, created_by, status, total, line_items) VALUES
    (v_so1, 'SO-PIS-1', v_cust, v_mgr, 'confirmed', 100, jsonb_build_array(jsonb_build_object('product_id', v_svc, 'product_name', 'Installation', 'qty', 2, 'unit_price', 50))),
    (v_so2, 'SO-PIS-2', v_cust, v_mgr, 'confirmed', 100, jsonb_build_array(jsonb_build_object('product_id', v_ser, 'product_name', 'Router', 'qty', 1, 'unit_price', 100)));
  INSERT INTO public.crm_invoices (id, so_id, customer_id, created_by, doc_status, payment_status, total, subtotal, line_items) VALUES
    (v_inv1, v_so1, v_cust, v_mgr, 'draft', 'unpaid', 100, 100, jsonb_build_array(jsonb_build_object('product_id', v_svc, 'product_name', 'Installation', 'qty', 2, 'unit_price', 50))),
    (v_inv2, v_so2, v_cust, v_mgr, 'draft', 'unpaid', 100, 100, jsonb_build_array(jsonb_build_object('product_id', v_ser, 'product_name', 'Router', 'qty', 1, 'unit_price', 100)));

  v_out := pg_temp.call(v_mgr, format($q$SELECT public.post_invoice(%L, %L)$q$, v_inv1, v_mgr));
  RAISE NOTICE '%', pg_temp.check('an order invoice with only a service line posts', v_out = 'ok'
    AND (SELECT doc_status = 'posted' AND inv_code IS NOT NULL FROM public.crm_invoices WHERE id = v_inv1), '-> ' || v_out);

  v_out := pg_temp.call(v_mgr, format($q$SELECT public.post_invoice(%L, %L)$q$, v_inv2, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a serialized line with nothing reserved is still refused (the precondition still holds)', v_out LIKE 'err:%serialized unit%', '-> ' || v_out);

  RAISE EXCEPTION 'PIS_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
