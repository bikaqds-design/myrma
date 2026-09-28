-- supabase/tests/maker_checker.sql — S-02 (20260915), rolled back.
-- With separation of duties on, the person who created a quotation, sales
-- order, invoice, purchase order or supplier invoice cannot approve it;
-- another manager can, an administrator is exempt, and with it off nothing
-- changes.
-- #  node scripts/run-sql-test.mjs supabase/tests/maker_checker.sql S02_TEST_DONE

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT CASE WHEN p_ok THEN 'PASS  ' || p_label ELSE 'FAIL  ' || p_label || ' ' || COALESCE(p_detail, '') END
$f$;
-- run p_sql signed in as p_email through PostgREST's role (the client path)
CREATE FUNCTION pg_temp.client(p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  EXECUTE p_sql;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN 'err:' || SQLSTATE || ' ' || SQLERRM;
END $f$;
-- run p_sql with p_email's token but the owner's role: what a SECURITY DEFINER
-- approval function (approve_sales_order, post_invoice) does under a login
CREATE FUNCTION pg_temp.definer(p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims',
    CASE WHEN p_email IS NULL THEN '' ELSE json_build_object('email', p_email, 'role', 'authenticated')::text END, true);
  EXECUTE p_sql;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN 'err:' || SQLSTATE || ' ' || SQLERRM;
END $f$;
CREATE FUNCTION pg_temp.sod(p_on boolean) RETURNS void LANGUAGE sql AS $f$
  DELETE FROM public.rma_config WHERE config_key = 'separation_of_duties';
  INSERT INTO public.rma_config (config_key, config_value) VALUES ('separation_of_duties', to_jsonb(p_on));
$f$;
-- documents created through the real RPCs, so created_by is the login
CREATE FUNCTION pg_temp.quote(p_email text, p_cust uuid, p_prod uuid) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v public.quotations;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  v := public.create_quotation(p_cust, NULL, jsonb_build_array(jsonb_build_object('product_id', p_prod, 'product_name', 'S02 service', 'qty', 1, 'unit_price', 100)),
                               CURRENT_DATE + 30, NULL, NULL, NULL, NULL, p_email);
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.quotations SET status = 'sent' WHERE id = v.id;
  RETURN v.id;
END $f$;
CREATE FUNCTION pg_temp.sorder(p_email text, p_cust uuid, p_prod uuid) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v public.sales_orders;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  v := public.create_sales_order(p_cust, jsonb_build_array(jsonb_build_object('product_id', p_prod, 'product_name', 'S02 service', 'qty', 1, 'unit_price', 100)),
                                 NULL, NULL, NULL, NULL, NULL, p_email);
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.sales_orders SET status = 'sent' WHERE id = v.id;
  RETURN v.id;
END $f$;
CREATE FUNCTION pg_temp.invoice(p_email text, p_cust uuid, p_prod uuid) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v public.crm_invoices;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  v := public.create_crm_invoice(p_cust, jsonb_build_array(jsonb_build_object('product_id', p_prod, 'product_name', 'S02 service', 'qty', 1, 'unit_price', 100)),
                                 CURRENT_DATE + 30, NULL, NULL, NULL, NULL, p_email);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v.id;
END $f$;
CREATE FUNCTION pg_temp.porder(p_email text, p_vendor uuid, p_prod uuid) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v public.purchase_orders;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  v := public.create_purchase_order(p_vendor, jsonb_build_array(jsonb_build_object('product_id', p_prod, 'product_name', 'S02 service', 'qty_ordered', 1, 'unit_cost', 50)),
                                    '{"currency":"EGP"}'::jsonb, p_email);
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.purchase_orders SET status = 'sent' WHERE id = v.id;
  RETURN v.id;
END $f$;
CREATE FUNCTION pg_temp.bill(p_email text, p_vendor uuid, p_prod uuid, p_no text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v public.vendor_invoices;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  v := public.create_vendor_invoice(p_vendor, jsonb_build_array(jsonb_build_object('product_id', p_prod, 'product_name', 'S02 service', 'qty_ordered', 1, 'unit_cost', 50)),
         jsonb_build_object('currency', 'EGP', 'supplier_invoice_no', p_no, 'supplier_invoice_date', CURRENT_DATE,
                            'non_po_reason', 'maker-checker test bill'), p_email);
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.vendor_invoices SET status = 'pending_approval' WHERE id = v.id;
  RETURN v.id;
END $f$;

DO $do$
DECLARE
  m1 text := 's02-mgr1@test.local';
  m2 text := 's02-mgr2@test.local';
  ad text := 's02-admin@test.local';
  v_cust uuid; v_vendor uuid; v_prod uuid := gen_random_uuid();
  q uuid; so uuid; inv uuid; po uuid; vi uuid;
  r text;
  res text[] := '{}';
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (m1, 'manager', 'active'), (m2, 'manager', 'active'), (ad, 'admin', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('S02 Co', 'S02-C1', 'B2B') RETURNING id INTO v_cust;
  INSERT INTO public.brands (brand_name) VALUES ('S02 Supplier') RETURNING id INTO v_vendor;
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode) VALUES (v_prod, 'S02-SVC', 'S02 service', 'service', 'serialized');

  -- 1. off (the default): the creator may approve their own quotation
  PERFORM pg_temp.sod(false);
  q := pg_temp.quote(m1, v_cust, v_prod);
  r := pg_temp.client(m1, format($$UPDATE public.quotations SET status = 'accepted' WHERE id = %L$$, q));
  res := res || pg_temp.check('off: the creator accepts their own quotation', r = 'ok', r);

  PERFORM pg_temp.sod(true);

  -- 2. quotations, through the client path
  q := pg_temp.quote(m1, v_cust, v_prod);
  r := pg_temp.client(m1, format($$UPDATE public.quotations SET status = 'accepted' WHERE id = %L$$, q));
  res := res || pg_temp.check('on: the creator cannot accept their quotation', r LIKE 'err:P0001 You created this quotation%', r);
  r := pg_temp.client(m2, format($$UPDATE public.quotations SET status = 'accepted' WHERE id = %L$$, q));
  res := res || pg_temp.check('on: another manager accepts it', r = 'ok', r);
  q := pg_temp.quote(ad, v_cust, v_prod);
  r := pg_temp.client(ad, format($$UPDATE public.quotations SET status = 'accepted' WHERE id = %L$$, q));
  res := res || pg_temp.check('on: an administrator accepts their own (exempt)', r = 'ok', r);

  -- 3. sales order confirmed (approve_sales_order's step, under a login)
  so := pg_temp.sorder(m1, v_cust, v_prod);
  r := pg_temp.definer(m1, format($$UPDATE public.sales_orders SET status = 'confirmed', confirmed_at = now() WHERE id = %L$$, so));
  res := res || pg_temp.check('on: the creator cannot confirm their sales order', r LIKE 'err:P0001 You created this sales order%', r);
  r := pg_temp.definer(m2, format($$UPDATE public.sales_orders SET status = 'confirmed', confirmed_at = now() WHERE id = %L$$, so));
  res := res || pg_temp.check('on: another manager confirms it', r = 'ok', r);

  -- 4. invoice posted (post_invoice's step)
  inv := pg_temp.invoice(m1, v_cust, v_prod);
  r := pg_temp.definer(m1, format($$UPDATE public.crm_invoices SET doc_status = 'posted', posted_at = now() WHERE id = %L$$, inv));
  res := res || pg_temp.check('on: the creator cannot post their invoice', r LIKE 'err:P0001 You created this invoice%', r);
  r := pg_temp.definer(m2, format($$UPDATE public.crm_invoices SET doc_status = 'posted', posted_at = now() WHERE id = %L$$, inv));
  res := res || pg_temp.check('on: another manager posts it', r = 'ok', r);

  -- 5. purchase order confirmed
  po := pg_temp.porder(m1, v_vendor, v_prod);
  r := pg_temp.definer(m1, format($$UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = %L$$, po));
  res := res || pg_temp.check('on: the creator cannot confirm their purchase order', r LIKE 'err:P0001 You created this purchase order%', r);
  r := pg_temp.definer(m2, format($$UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = %L$$, po));
  res := res || pg_temp.check('on: another manager confirms it', r = 'ok', r);

  -- 6. supplier invoice approved
  vi := pg_temp.bill(m1, v_vendor, v_prod, 'S02-BILL-1');
  r := pg_temp.definer(m1, format($$UPDATE public.vendor_invoices SET status = 'approved', approved_at = now() WHERE id = %L$$, vi));
  res := res || pg_temp.check('on: the creator cannot approve their supplier invoice', r LIKE 'err:P0001 You created this supplier invoice%', r);
  r := pg_temp.definer(ad, format($$UPDATE public.vendor_invoices SET status = 'approved', approved_at = now() WHERE id = %L$$, vi));
  res := res || pg_temp.check('on: an administrator approves it', r = 'ok', r);

  -- 7. no login (the database itself) is not a maker
  so := pg_temp.sorder(m1, v_cust, v_prod);
  r := pg_temp.definer(NULL, format($$UPDATE public.sales_orders SET status = 'confirmed', confirmed_at = now() WHERE id = %L$$, so));
  res := res || pg_temp.check('on: with no login the rule stands aside', r = 'ok', r);

  -- 8. an unrelated status change by the creator is not an approval
  q := pg_temp.quote(m1, v_cust, v_prod);
  r := pg_temp.client(m1, format($$UPDATE public.quotations SET status = 'cancelled' WHERE id = %L$$, q));
  res := res || pg_temp.check('on: the creator may still cancel their own quotation', r = 'ok', r);

  -- 9. the setting cannot be read by anon, and the guard is not callable
  res := res || pg_temp.check('anon cannot call rma_separation_of_duties',
    to_regprocedure('public.rma_separation_of_duties()') IS NOT NULL
    AND NOT has_function_privilege('anon', 'public.rma_separation_of_duties()', 'EXECUTE'));
  res := res || pg_temp.check('the guard is not client-callable',
    to_regprocedure('public.rma_guard_maker_checker()') IS NOT NULL
    AND NOT has_function_privilege('authenticated', 'public.rma_guard_maker_checker()', 'EXECUTE'));

  RAISE EXCEPTION 'S02_TEST_DONE %', E'\n' || array_to_string(res, E'\n');
END
$do$;
