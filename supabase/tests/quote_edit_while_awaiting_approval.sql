-- ############################################################################
-- #  QUOTE EDIT WHILE AWAITING APPROVAL (20260893)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/quote_edit_while_awaiting_approval.sql QEA_TEST_DONE
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
CREATE FUNCTION pg_temp.qt_status(p_id uuid) RETURNS text LANGUAGE sql AS $f$ SELECT status FROM public.quotations WHERE id = p_id $f$;

DO $do$
DECLARE
  v_rep   text := 'qea-rep@test.local';
  v_mgr   text := 'qea-mgr@test.local';
  v_cust  uuid;
  v_p1    uuid := gen_random_uuid();
  v_qt    public.quotations;
  v_lines jsonb;
  v_out   text;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_rep, 'sales_rep', 'active'), (v_mgr, 'manager', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('QEA Co', 'QEA-C1', 'B2B') RETURNING id INTO v_cust;
  INSERT INTO public.products (id, sku, product_name, product_type) VALUES (v_p1, 'QEA-P1', 'QEA router', 'hardware');
  v_lines := jsonb_build_array(jsonb_build_object('product_id', v_p1, 'product_name', 'QEA router', 'qty', 2, 'unit_price', 100));

  PERFORM pg_temp.as_user(v_rep);
  v_qt := public.create_quotation(v_cust, NULL, v_lines, (current_date + 30), 'Net 30', NULL, NULL, v_rep, v_rep);
  PERFORM pg_temp.as_owner();
  v_out := pg_temp.call(v_rep, format($q$UPDATE public.quotations SET status = 'sent' WHERE id = %L$q$, v_qt.id));
  RAISE NOTICE '%', pg_temp.check('the rep sends the quote for approval (fixture)', v_out = 'ok' AND pg_temp.qt_status(v_qt.id) = 'sent', '-> ' || v_out);

  -- 1. saving without changing the offer keeps it sent
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_quotation(%L, %L::jsonb, '{"notes":"called the buyer"}'::jsonb, %L)$q$, v_qt.id, v_lines, v_rep));
  RAISE NOTICE '%', pg_temp.check('saving the same lines with a new note keeps it awaiting approval', v_out = 'ok' AND pg_temp.qt_status(v_qt.id) = 'sent', '-> ' || v_out || ' / ' || pg_temp.qt_status(v_qt.id));

  -- 2. changing the price sends it back to draft
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_quotation(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_qt.id,
    jsonb_set(v_lines, '{0,unit_price}', '60'), v_rep));
  RAISE NOTICE '%', pg_temp.check('changing a price while it awaits approval sends it back to draft', v_out = 'ok' AND pg_temp.qt_status(v_qt.id) = 'draft', '-> ' || v_out || ' / ' || pg_temp.qt_status(v_qt.id));
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.quotations SET status = 'accepted' WHERE id = %L$q$, v_qt.id));
  RAISE NOTICE '%', pg_temp.check('...so the old approval request can no longer accept it', v_out LIKE 'err:%' AND pg_temp.qt_status(v_qt.id) = 'draft', '-> ' || v_out);

  -- 3. the validity date and payment terms count too
  PERFORM pg_temp.call(v_rep, format($q$UPDATE public.quotations SET status = 'sent' WHERE id = %L$q$, v_qt.id));
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_quotation(%L, NULL, %L::jsonb, %L)$q$, v_qt.id,
    jsonb_build_object('validity_until', (current_date + 90)::text), v_rep));
  RAISE NOTICE '%', pg_temp.check('moving the validity date sends it back to draft', v_out = 'ok' AND pg_temp.qt_status(v_qt.id) = 'draft', '-> ' || v_out || ' / ' || pg_temp.qt_status(v_qt.id));
  PERFORM pg_temp.call(v_rep, format($q$UPDATE public.quotations SET status = 'sent' WHERE id = %L$q$, v_qt.id));
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_quotation(%L, NULL, '{"payment_terms":"Net 90"}'::jsonb, %L)$q$, v_qt.id, v_rep));
  RAISE NOTICE '%', pg_temp.check('changing the payment terms sends it back to draft', v_out = 'ok' AND pg_temp.qt_status(v_qt.id) = 'draft', '-> ' || v_out || ' / ' || pg_temp.qt_status(v_qt.id));

  -- 4. an unchanged sent quote is still approved normally
  PERFORM pg_temp.call(v_rep, format($q$UPDATE public.quotations SET status = 'sent' WHERE id = %L$q$, v_qt.id));
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.quotations SET status = 'accepted' WHERE id = %L$q$, v_qt.id));
  RAISE NOTICE '%', pg_temp.check('an unchanged sent quote is accepted by a manager (control)', v_out = 'ok' AND pg_temp.qt_status(v_qt.id) = 'accepted', '-> ' || v_out);

  RAISE EXCEPTION 'QEA_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
