-- ############################################################################
-- #  QUOTATION LINES — W2 / L-01+L-02, first document type (20260883)
-- #
-- #  HOW TO RUN:
-- #  node scripts/run-sql-test.mjs supabase/tests/quotation_lines.sql BL11_TEST_DONE
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

DO $do$
DECLARE
  v_rep    text := 'bl11-rep@test.local';
  v_rep2   text := 'bl11-rep2@test.local';
  v_mgr    text := 'bl11-mgr@test.local';
  v_tech   text := 'bl11-tech@test.local';
  v_cust   uuid;
  v_p1     uuid := gen_random_uuid();
  v_qt     public.quotations;
  v_qt2    uuid;
  v_out    text;
  v_row    record;
  v_n      integer;
  v_lines  jsonb;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES (v_rep, 'sales_rep', 'active'), (v_rep2, 'sales_rep', 'active'),
         (v_mgr, 'manager', 'active'), (v_tech, 'technician', 'active');
  INSERT INTO public.products (id, sku, product_name, product_type)
  VALUES (v_p1, 'BL11-P1', 'BL11 product 1', 'hardware');
  INSERT INTO public.customers (id, company_name, customer_code, customer_type)
  VALUES (gen_random_uuid(), 'BL11 Customer', 'BL11-C1', 'B2B') RETURNING id INTO v_cust;

  -- ══ 1. create_quotation ═══════════════════════════════════════════════════
  RAISE NOTICE '--- 1. create_quotation ---';
  v_lines := jsonb_build_array(
    jsonb_build_object('product_id', v_p1, 'product_name', 'BL11 product 1', 'qty', 2, 'unit_price', 100, 'discount_pct', 10, 'tax_pct', 14),
    jsonb_build_object('product_name', 'Custom install service', 'qty', 1, 'unit_price', 50)
  );
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_rep, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_qt := public.create_quotation(v_cust, NULL, v_lines, NULL, 'Net 30', 'PO-778', NULL, v_rep, v_rep);
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE '%', pg_temp.check('a sales rep can create one for themselves', v_qt.id IS NOT NULL, '-> ' || v_qt.status);
  RAISE NOTICE '%', pg_temp.check('created_by is the login, not the (identical here) param', v_qt.created_by = v_rep);

  SELECT count(*) INTO v_n FROM public.quotation_lines WHERE quotation_id = v_qt.id;
  RAISE NOTICE '%', pg_temp.check('two lines were written to the relational table', v_n = 2, '-> ' || v_n);
  RAISE NOTICE '%', pg_temp.check('the second (product-less) line has a NULL product_id, not a fake one',
    (SELECT product_id IS NULL FROM public.quotation_lines WHERE quotation_id = v_qt.id AND line_no = 1));
  RAISE NOTICE '%', pg_temp.check('the first line is FK-linked to the real product',
    (SELECT product_id = v_p1 FROM public.quotation_lines WHERE quotation_id = v_qt.id AND line_no = 0));

  -- 2*100 - 10% = 180, tax 14% of 180 = 25.20 -> line1 subtotal 200 disc 20 tax 25.20
  -- line2: 50, no disc/tax -> subtotal 50
  -- totals: subtotal 250, discount 20, tax 25.20, total 255.20
  RAISE NOTICE '%', pg_temp.check('totals are computed server-side with the documented formula',
    v_qt.subtotal = 250 AND v_qt.discount_amount = 20 AND v_qt.tax_amount = 25.20 AND v_qt.total = 255.20,
    format('-> sub=%s disc=%s tax=%s total=%s', v_qt.subtotal, v_qt.discount_amount, v_qt.tax_amount, v_qt.total));

  RAISE NOTICE '%', pg_temp.check('line_items is a mirror of the rows, same shape as before',
    jsonb_array_length(v_qt.line_items) = 2
    AND (v_qt.line_items->0->>'product_name') = 'BL11 product 1'
    AND (v_qt.line_items->0->>'qty')::int = 2, '-> ' || v_qt.line_items::text);

  -- ══ 2. Validation ═══════════════════════════════════════════════════════
  RAISE NOTICE '--- 2. Validation ---';
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_quotation(%L, NULL, '[]'::jsonb, NULL, NULL, NULL, NULL, NULL, %L)$q$, v_cust, v_rep));
  RAISE NOTICE '%', pg_temp.check('an empty line list is refused', v_out LIKE 'err:P0001%' AND v_out LIKE '%At least one line%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_quotation(NULL, NULL, %L::jsonb, NULL, NULL, NULL, NULL, NULL, %L)$q$, v_lines, v_rep));
  RAISE NOTICE '%', pg_temp.check('no customer is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_quotation(%L, NULL, %L::jsonb, NULL, NULL, NULL, NULL, NULL, %L)$q$,
    v_cust, jsonb_build_array(jsonb_build_object('product_name', 'x', 'qty', 0, 'unit_price', 1)), v_rep));
  RAISE NOTICE '%', pg_temp.check('qty 0 is refused (must be at least 1)', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_quotation(%L, NULL, %L::jsonb, NULL, NULL, NULL, NULL, NULL, %L)$q$,
    v_cust, jsonb_build_array(jsonb_build_object('product_name', 'x', 'qty', 1, 'unit_price', -5)), v_rep));
  RAISE NOTICE '%', pg_temp.check('a negative price is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_quotation(%L, NULL, %L::jsonb, NULL, NULL, NULL, NULL, NULL, %L)$q$,
    v_cust, jsonb_build_array(jsonb_build_object('product_name', 'x', 'qty', 1, 'unit_price', 1, 'discount_pct', 150)), v_rep));
  RAISE NOTICE '%', pg_temp.check('a discount over 100 is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_quotation(%L, NULL, %L::jsonb, NULL, NULL, NULL, NULL, NULL, %L)$q$,
    v_cust, jsonb_build_array(jsonb_build_object('product_name', '', 'qty', 1, 'unit_price', 1)), v_rep));
  RAISE NOTICE '%', pg_temp.check('a blank product name is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_tech, format($q$SELECT public.create_quotation(%L, NULL, %L::jsonb, NULL, NULL, NULL, NULL, NULL, %L)$q$, v_cust, v_lines, v_tech));
  RAISE NOTICE '%', pg_temp.check('any staff member can create one, as the old INSERT policy allowed', v_out = 'ok', '-> ' || v_out);

  -- ══ 3. update_quotation ═══════════════════════════════════════════════════
  RAISE NOTICE '--- 3. update_quotation ---';
  v_out := pg_temp.call(v_rep2, format($q$SELECT public.update_quotation(%L, %L::jsonb, '{"payment_terms":"Net 60"}'::jsonb, %L)$q$, v_qt.id, v_lines, v_rep2));
  RAISE NOTICE '%', pg_temp.check('a different sales rep, not the owner, is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);

  v_lines := jsonb_build_array(jsonb_build_object('product_id', v_p1, 'product_name', 'BL11 product 1', 'qty', 5, 'unit_price', 100));
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_quotation(%L, %L::jsonb, '{"payment_terms":"Net 60"}'::jsonb, %L)$q$, v_qt.id, v_lines, v_rep));
  RAISE NOTICE '%', pg_temp.check('the owner can replace the lines', v_out = 'ok', '-> ' || v_out);
  SELECT count(*) INTO v_n FROM public.quotation_lines WHERE quotation_id = v_qt.id;
  RAISE NOTICE '%', pg_temp.check('the old 2 lines are gone, replaced by the new 1', v_n = 1, '-> ' || v_n);
  SELECT total, payment_terms INTO v_row FROM public.quotations WHERE id = v_qt.id;
  RAISE NOTICE '%', pg_temp.check('totals and the header field are both updated, atomically', v_row.total = 500 AND v_row.payment_terms = 'Net 60', '-> ' || v_row.total || ' ' || v_row.payment_terms);

  v_out := pg_temp.call(v_mgr, format($q$SELECT public.update_quotation(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_qt.id, v_lines, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a manager can edit any quotation', v_out = 'ok', '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('fields the caller did not send are kept (the Deal screen sends no reference_po / assigned_rep)',
    (SELECT reference_po = 'PO-778' AND assigned_rep = v_rep AND payment_terms = 'Net 60' FROM public.quotations WHERE id = v_qt.id));
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_quotation(%L, %L::jsonb, '{"reference_po": null}'::jsonb, %L)$q$, v_qt.id, v_lines, v_rep));
  RAISE NOTICE '%', pg_temp.check('a field sent as null is blanked', (SELECT reference_po IS NULL FROM public.quotations WHERE id = v_qt.id), '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_quotation(%L, %L::jsonb, '{"total": 1}'::jsonb, %L)$q$, v_qt.id, v_lines, v_rep));
  RAISE NOTICE '%', pg_temp.check('a field outside the allowed set is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);

  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_quotation(gen_random_uuid(), %L::jsonb, '{}'::jsonb, %L)$q$, v_lines, v_rep));
  RAISE NOTICE '%', pg_temp.check('a quotation that does not exist is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- ══ 3b. Review findings ═════════════════════════════════════════════════
  RAISE NOTICE '--- 3b. Review findings ---';
  -- a quotation with no assigned rep: "assigned_rep = me" is NULL
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_qt2 := (public.create_quotation(v_cust, NULL, v_lines, NULL, NULL, NULL, NULL, NULL, v_mgr)).id;
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
  v_out := pg_temp.call(v_rep2, format($q$SELECT public.update_quotation(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_qt2, v_lines, v_rep2));
  RAISE NOTICE '%', pg_temp.check('with no assigned rep, another rep still cannot edit it (NULL does not let them through)', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- a login with no email claim cannot borrow the owner's by passing it
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.update_quotation(v_qt.id, v_lines, '{}'::jsonb, v_rep);
    v_out := 'ok';
  EXCEPTION WHEN OTHERS THEN v_out := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE '%', pg_temp.check('the owner''s email passed as a parameter is not trusted', v_out LIKE 'err:%', '-> ' || v_out);

  -- a price the Deal screen sends as "" means 0, as it always did
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_quotation(%L, '[{"product_name":"x","qty":"2","unit_price":"","discount_pct":null}]'::jsonb, '{}'::jsonb, %L)$q$, v_qt.id, v_rep));
  RAISE NOTICE '%', pg_temp.check('an empty price is 0, and a string quantity is accepted', v_out = 'ok' AND (SELECT total FROM public.quotations WHERE id = v_qt.id) = 0, '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_quotation(%L, '[{"product_name":"x","qty":"","unit_price":"5"}]'::jsonb, '{}'::jsonb, %L)$q$, v_qt.id, v_rep));
  RAISE NOTICE '%', pg_temp.check('an empty quantity is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_quotation(%L, '[{"product_name":"x","qty":1,"unit_price":"NaN"}]'::jsonb, '{}'::jsonb, %L)$q$, v_qt.id, v_rep));
  RAISE NOTICE '%', pg_temp.check('NaN as a price is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_quotation(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_qt.id,
    jsonb_build_array(jsonb_build_object('product_id', gen_random_uuid(), 'product_name', 'ghost', 'qty', 1, 'unit_price', 1)), v_rep));
  RAISE NOTICE '%', pg_temp.check('a product that does not exist is refused with a readable message', v_out LIKE 'err:P0001%does not exist%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_quotation(%L, '[{"product_name":"x","qty":1,"unit_price":7}]'::jsonb, '{}'::jsonb, %L)$q$, v_qt.id, v_rep));  -- restore a sane line set (total 7, not the 1 the check below plants)
  RAISE NOTICE '%', pg_temp.check('the internal line writer is not callable by a client',
    NOT has_function_privilege('authenticated', 'public._quotation_write_lines(uuid, jsonb)', 'EXECUTE'));

  -- ══ 4. A quotation past draft/sent is locked ══════════════════════════════
  RAISE NOTICE '--- 4. Locked once settled ---';
  UPDATE public.quotations SET status = 'accepted' WHERE id = v_qt.id;
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_quotation(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_qt.id, v_lines, v_rep));
  RAISE NOTICE '%', pg_temp.check('an accepted quotation cannot have its lines changed', v_out LIKE 'err:P0001%', '-> ' || v_out);
  UPDATE public.quotations SET status = 'draft' WHERE id = v_qt.id;  -- reset for later checks

  -- ══ 5. The client surface is locked down ═══════════════════════════════
  RAISE NOTICE '--- 5. Client surface ---';
  v_out := pg_temp.call(v_rep, format($q$INSERT INTO public.quotations (qt_code, customer_id, created_by, line_items) VALUES ('QT-DIRECT', %L, %L, '[]')$q$, v_cust, v_rep));
  RAISE NOTICE '%', pg_temp.check('a direct INSERT into quotations is refused (create_quotation is the only door)', v_out LIKE 'err:%', '-> ' || v_out);

  v_out := pg_temp.call(v_rep, format($q$UPDATE public.quotations SET line_items = '[{"product_name":"hacked","qty":1,"unit_price":999999}]'::jsonb WHERE id = %L$q$, v_qt.id));
  RAISE NOTICE '%', pg_temp.check('a direct UPDATE cannot plant a line_items value', v_out = 'ok'
    AND (SELECT line_items FROM public.quotations WHERE id = v_qt.id) = (SELECT line_items FROM public.quotations WHERE id = v_qt.id), '-> command ok, but pinned');
  RAISE NOTICE '%', pg_temp.check('...it is silently pinned back to what the RPC wrote, not the attacker''s value',
    NOT EXISTS (SELECT 1 FROM public.quotations WHERE id = v_qt.id AND line_items @> '[{"product_name":"hacked"}]'::jsonb));
  v_out := pg_temp.call(v_rep, format($q$UPDATE public.quotations SET total = 1 WHERE id = %L$q$, v_qt.id));
  RAISE NOTICE '%', pg_temp.check('total cannot be set directly either', (SELECT total FROM public.quotations WHERE id = v_qt.id) <> 1);
  v_out := pg_temp.call(v_rep, format($q$UPDATE public.quotations SET created_by = 'someone.else@test.local' WHERE id = %L$q$, v_qt.id));
  RAISE NOTICE '%', pg_temp.check('created_by cannot be reassigned directly', (SELECT created_by FROM public.quotations WHERE id = v_qt.id) = v_rep);

  -- a plain status-only update still works (unaffected by the guard)
  v_out := pg_temp.call(v_rep, format($q$UPDATE public.quotations SET status = 'sent' WHERE id = %L$q$, v_qt.id));
  RAISE NOTICE '%', pg_temp.check('an ordinary status transition is unaffected by the guard', v_out = 'ok' AND (SELECT status FROM public.quotations WHERE id = v_qt.id) = 'sent');
  UPDATE public.quotations SET status = 'draft' WHERE id = v_qt.id;

  -- client cannot write quotation_lines directly at all
  v_out := pg_temp.call(v_rep, format($q$INSERT INTO public.quotation_lines (quotation_id, line_no, product_name, qty, unit_price) VALUES (%L, 9, 'x', 1, 1)$q$, v_qt.id));
  RAISE NOTICE '%', pg_temp.check('a client cannot INSERT into quotation_lines directly', v_out LIKE 'err:%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$DELETE FROM public.quotation_lines WHERE quotation_id = %L$q$, v_qt.id));
  RAISE NOTICE '%', pg_temp.check('nor DELETE from it', v_out LIKE 'err:%', '-> ' || v_out);

  -- ══ 6. Read access ═══════════════════════════════════════════════════════
  RAISE NOTICE '--- 6. Read access ---';
  v_out := pg_temp.call(v_rep2, format($q$SELECT count(*) FROM public.quotation_lines WHERE quotation_id = %L$q$, v_qt.id));
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_rep2, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*)::integer INTO v_n FROM public.quotation_lines WHERE quotation_id = v_qt.id;
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE '%', pg_temp.check('a different rep, not the owner or assignee, sees none of this quotation''s lines', v_n = 0, '-> ' || v_n);

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*)::integer INTO v_n FROM public.quotation_lines WHERE quotation_id = v_qt.id;
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE '%', pg_temp.check('a manager sees every quotation''s lines', v_n = 1, '-> ' || v_n);

  -- ══ 7. FK behaviour ═══════════════════════════════════════════════════════
  RAISE NOTICE '--- 7. FK ---';
  v_qt2 := (SELECT id FROM public.quotations WHERE id <> v_qt.id ORDER BY created_at DESC LIMIT 1);
  IF v_qt2 IS NULL THEN v_qt2 := v_qt.id; END IF;
  RAISE NOTICE '%', pg_temp.check('deleting a quotation cascades its lines',
    (SELECT count(*) FROM public.quotation_lines WHERE quotation_id = v_qt.id) > 0);
  DELETE FROM public.quotations WHERE id = v_qt.id;
  RAISE NOTICE '%', pg_temp.check('...confirmed: the lines are gone too', (SELECT count(*) FROM public.quotation_lines WHERE quotation_id = v_qt.id) = 0);

  -- ══ 8. Access to the functions ═══════════════════════════════════════════
  RAISE NOTICE '--- 8. Access ---';
  RAISE NOTICE '%', pg_temp.check('anon cannot call either RPC or read quotation_lines',
    NOT has_function_privilege('anon', 'public.create_quotation(uuid, uuid, jsonb, date, text, text, text, text, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.update_quotation(uuid, jsonb, jsonb, text)', 'EXECUTE')
    AND NOT has_table_privilege('anon', 'public.quotation_lines', 'SELECT'));

  RAISE EXCEPTION 'BL11_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
