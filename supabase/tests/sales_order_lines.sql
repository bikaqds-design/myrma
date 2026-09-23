-- ############################################################################
-- #  SALES ORDER LINES — W2 / L-01, second document type (20260884)
-- #
-- #  HOW TO RUN:
-- #  node scripts/run-sql-test.mjs supabase/tests/sales_order_lines.sql BL12_TEST_DONE
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
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', p_email, 'role', 'authenticated')::text, true);
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

-- Run a function returning one sales_orders row as the given user.
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

DO $do$
DECLARE
  v_rep    text := 'bl12-rep@test.local';
  v_rep2   text := 'bl12-rep2@test.local';
  v_mgr    text := 'bl12-mgr@test.local';
  v_tech   text := 'bl12-tech@test.local';
  v_acct   text := 'bl12-acct@test.local';
  v_cust   uuid;
  v_p1     uuid := gen_random_uuid();
  v_p2     uuid := gen_random_uuid();
  v_so     public.sales_orders;
  v_so2    uuid;
  v_qt     public.quotations;
  v_out    text;
  v_n      integer;
  v_lines  jsonb;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES (v_rep, 'sales_rep', 'active'), (v_rep2, 'sales_rep', 'active'), (v_mgr, 'manager', 'active'),
         (v_tech, 'technician', 'active'), (v_acct, 'accountant', 'active');
  -- service products: approving reserves nothing, so the lifecycle can run without stock
  INSERT INTO public.products (id, sku, product_name, product_type)
  VALUES (v_p1, 'BL12-P1', 'BL12 service 1', 'service'), (v_p2, 'BL12-P2', 'BL12 service 2', 'service');
  INSERT INTO public.customers (company_name, customer_code, customer_type)
  VALUES ('BL12 Customer', 'BL12-C1', 'B2B') RETURNING id INTO v_cust;
  v_lines := jsonb_build_array(
    jsonb_build_object('product_id', v_p1, 'product_name', 'BL12 service 1', 'qty', 2, 'unit_price', 100, 'discount_pct', 10, 'tax_pct', 14),
    jsonb_build_object('product_id', v_p2, 'product_name', 'BL12 service 2', 'qty', 1, 'unit_price', 50));

  -- ══ 1. create_sales_order ═════════════════════════════════════════════════
  RAISE NOTICE '--- 1. create_sales_order ---';
  PERFORM pg_temp.as_user(v_rep);
  v_so := public.create_sales_order(v_cust, v_lines, NULL, 'Net 30', 'PO-9', NULL, v_rep, v_rep);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a sales rep creates a draft order, attributed to the login', v_so.status = 'draft' AND v_so.created_by = v_rep);
  SELECT count(*) INTO v_n FROM public.sales_order_lines WHERE sales_order_id = v_so.id;
  RAISE NOTICE '%', pg_temp.check('its two lines are rows', v_n = 2, '-> ' || v_n);
  RAISE NOTICE '%', pg_temp.check('totals are computed in the database (250 / 20 / 25.20 / 255.20)',
    v_so.subtotal = 250 AND v_so.discount_amount = 20 AND v_so.tax_amount = 25.20 AND v_so.total = 255.20,
    format('-> %s / %s / %s / %s', v_so.subtotal, v_so.discount_amount, v_so.tax_amount, v_so.total));
  RAISE NOTICE '%', pg_temp.check('line_items mirrors the rows', jsonb_array_length(v_so.line_items) = 2 AND (v_so.line_items->0->>'product_id')::uuid = v_p1);
  RAISE NOTICE '%', pg_temp.check('it is not linked to any quotation', v_so.quotation_id IS NULL);

  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_sales_order(%L, '[{"product_name":"free text","qty":1,"unit_price":5}]'::jsonb, NULL, NULL, NULL, NULL, NULL, %L)$q$, v_cust, v_rep));
  RAISE NOTICE '%', pg_temp.check('a line that is not a catalogue product is refused', v_out LIKE 'err:P0001%catalogue product%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_sales_order(%L, %L::jsonb, NULL, NULL, NULL, NULL, NULL, %L)$q$, v_cust,
    jsonb_build_array(jsonb_build_object('product_id', gen_random_uuid(), 'product_name', 'ghost', 'qty', 1, 'unit_price', 1)), v_rep));
  RAISE NOTICE '%', pg_temp.check('a product that does not exist is refused', v_out LIKE 'err:P0001%does not exist%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_sales_order(%L, '[{"product_id":"not-a-uuid","product_name":"x","qty":1,"unit_price":1}]'::jsonb, NULL, NULL, NULL, NULL, NULL, %L)$q$, v_cust, v_rep));
  RAISE NOTICE '%', pg_temp.check('a malformed product reference is refused readably', v_out LIKE 'err:P0001%not valid%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_sales_order(%L, '[{"product_id":"%s","qty":1,"unit_price":5}]'::jsonb, NULL, NULL, NULL, NULL, NULL, %L)$q$, v_cust, v_p2, v_rep));
  RAISE NOTICE '%', pg_temp.check('a line with a product but no name takes the catalogue name', v_out = 'ok'
    AND EXISTS (SELECT 1 FROM public.sales_order_lines l JOIN public.sales_orders o ON o.id = l.sales_order_id
                 WHERE o.created_by = v_rep AND l.product_id = v_p2 AND l.product_name = 'BL12 service 2' AND l.unit_price = 5), '-> ' || v_out);
  v_out := pg_temp.call(v_tech, format($q$SELECT public.create_sales_order(%L, %L::jsonb, NULL, NULL, NULL, NULL, NULL, %L)$q$, v_cust, v_lines, v_tech));
  RAISE NOTICE '%', pg_temp.check('a technician cannot create one', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$INSERT INTO public.sales_orders (so_code, customer_id, created_by, line_items) VALUES ('SO-DIRECT', %L, %L, '[]')$q$, v_cust, v_rep));
  RAISE NOTICE '%', pg_temp.check('a direct INSERT is refused (so no order can be linked to a quotation past convert)', v_out LIKE 'err:%', '-> ' || v_out);

  -- ══ 2. update_sales_order ═════════════════════════════════════════════════
  RAISE NOTICE '--- 2. update_sales_order ---';
  v_out := pg_temp.call(v_rep2, format($q$SELECT public.update_sales_order(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_so.id, v_lines, v_rep2));
  RAISE NOTICE '%', pg_temp.check('another sales rep cannot edit it', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_sales_order(%L, '[{"product_id":"%s","product_name":"BL12 service 1","qty":5,"unit_price":10}]'::jsonb, '{"notes":"five"}'::jsonb, %L)$q$, v_so.id, v_p1, v_rep));
  RAISE NOTICE '%', pg_temp.check('the owner replaces the lines and sets a field together', v_out = 'ok'
    AND (SELECT total = 50 AND notes = 'five' AND reference_po = 'PO-9' FROM public.sales_orders WHERE id = v_so.id)
    AND (SELECT count(*) FROM public.sales_order_lines WHERE sales_order_id = v_so.id) = 1, '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_sales_order(%L, NULL, '{"payment_terms":"Net 60"}'::jsonb, %L)$q$, v_so.id, v_rep));
  RAISE NOTICE '%', pg_temp.check('fields only: the lines and total are kept', v_out = 'ok'
    AND (SELECT total = 50 AND payment_terms = 'Net 60' FROM public.sales_orders WHERE id = v_so.id), '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_sales_order(%L, NULL, '{"total": 1}'::jsonb, %L)$q$, v_so.id, v_rep));
  RAISE NOTICE '%', pg_temp.check('a field outside the list is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);

  PERFORM pg_temp.as_user(v_mgr);
  v_so2 := (public.create_sales_order(v_cust, v_lines, NULL, NULL, NULL, NULL, v_rep2, v_mgr)).id;
  PERFORM pg_temp.as_owner();
  v_out := pg_temp.call(v_rep2, format($q$SELECT public.update_sales_order(%L, NULL, '{"notes":"mine"}'::jsonb, %L)$q$, v_so2, v_rep2));
  RAISE NOTICE '%', pg_temp.check('the assigned rep can edit it', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_rep2, format($q$SELECT public.update_sales_order(%L, NULL, %L::jsonb, %L)$q$, v_so2, json_build_object('assigned_rep', v_rep)::jsonb, v_rep2));
  RAISE NOTICE '%', pg_temp.check('...but cannot hand it to someone else', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- ══ 3. Only a draft is editable; a confirmed order's lines are locked ═════
  RAISE NOTICE '--- 3. Locked past draft ---';
  v_out := pg_temp.call(v_rep, format($q$UPDATE public.sales_orders SET status = 'sent' WHERE id = %L$q$, v_so.id));
  RAISE NOTICE '%', pg_temp.check('sending for approval is still a plain status update', v_out = 'ok' AND (SELECT status FROM public.sales_orders WHERE id = v_so.id) = 'sent', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_sales_order(%L, NULL, '{"notes":"x"}'::jsonb, %L)$q$, v_so.id, v_rep));
  RAISE NOTICE '%', pg_temp.check('a sent order cannot be edited', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.approve_sales_order(%L, %L)$q$, v_so.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('approve_sales_order still works on the mirrored lines', v_out = 'ok' AND (SELECT status FROM public.sales_orders WHERE id = v_so.id) = 'confirmed', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.sales_orders SET line_items = '[{"product_name":"swapped","qty":99,"unit_price":1}]'::jsonb WHERE id = %L$q$, v_so.id));
  RAISE NOTICE '%', pg_temp.check('a confirmed order''s lines cannot be rewritten directly (the reservation belongs to them)', v_out LIKE 'err:P0001%'
    AND NOT EXISTS (SELECT 1 FROM public.sales_orders WHERE id = v_so.id AND line_items @> '[{"product_name":"swapped"}]'::jsonb), '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.sales_orders SET total = 1 WHERE id = %L$q$, v_so.id));
  RAISE NOTICE '%', pg_temp.check('nor its total', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.update_sales_order(%L, NULL, '{"notes":"x"}'::jsonb, %L)$q$, v_so.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('nor through the RPC, even by a manager', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- ══ 4. convert_quotation_to_so writes the rows ═════════════════════════════
  RAISE NOTICE '--- 4. From a quotation ---';
  PERFORM pg_temp.as_user(v_rep);
  v_qt := public.create_quotation(v_cust, NULL, v_lines, (current_date + 30), NULL, NULL, NULL, v_rep, v_rep);
  PERFORM pg_temp.as_owner();
  UPDATE public.quotations SET status = 'accepted' WHERE id = v_qt.id;   -- as the owner: the approval pool's job
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.convert_quotation_to_so(%L, %L, NULL)$q$, v_qt.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('an accepted quotation converts', v_out = 'ok', '-> ' || v_out);
  SELECT o.* INTO v_so FROM public.sales_orders o WHERE o.quotation_id = v_qt.id;
  SELECT count(*) INTO v_n FROM public.sales_order_lines WHERE sales_order_id = v_so.id;
  RAISE NOTICE '%', pg_temp.check('the order has its lines as rows', v_n = 2, '-> ' || v_n);
  RAISE NOTICE '%', pg_temp.check('...matching the quotation''s lines and total',
    v_so.total = v_qt.total
    AND (SELECT array_agg(product_id ORDER BY line_no) FROM public.sales_order_lines WHERE sales_order_id = v_so.id)
      = (SELECT array_agg(product_id ORDER BY line_no) FROM public.quotation_lines WHERE quotation_id = v_qt.id),
    format('-> %s vs %s', v_so.total, v_qt.total));

  -- ══ 5. Read access follows the order ═══════════════════════════════════════
  RAISE NOTICE '--- 5. Read access ---';
  PERFORM pg_temp.as_user(v_acct);
  SELECT count(*)::integer INTO v_n FROM public.sales_order_lines WHERE sales_order_id = v_so.id;
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('an accountant, who reads every order, sees its lines', v_n = 2, '-> ' || v_n);
  PERFORM pg_temp.as_user(v_tech);
  SELECT count(*)::integer INTO v_n FROM public.sales_order_lines WHERE sales_order_id = v_so.id;
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a technician sees none', v_n = 0, '-> ' || v_n);
  PERFORM pg_temp.as_user(v_rep2);
  SELECT count(*)::integer INTO v_n FROM public.sales_order_lines WHERE sales_order_id = v_so.id;
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a rep who does not own the order sees none', v_n = 0, '-> ' || v_n);

  -- ══ 6. Access to the functions and the table ═══════════════════════════════
  RAISE NOTICE '--- 6. Access ---';
  v_out := pg_temp.call(v_rep, format($q$INSERT INTO public.sales_order_lines (sales_order_id, line_no, product_name, qty, unit_price) VALUES (%L, 9, 'x', 1, 1)$q$, v_so2));
  RAISE NOTICE '%', pg_temp.check('a client cannot write sales_order_lines', v_out LIKE 'err:%', '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('anon cannot call the RPCs; no client can call the writer',
    NOT has_function_privilege('anon', 'public.create_sales_order(uuid, jsonb, date, text, text, text, text, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.update_sales_order(uuid, jsonb, jsonb, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._sales_order_write_lines(uuid, jsonb)', 'EXECUTE'));

  RAISE EXCEPTION 'BL12_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
