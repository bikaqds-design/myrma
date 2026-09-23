-- ############################################################################
-- #  PURCHASE ORDER LINES — W2 / L-01, fifth document type (20260888)
-- #
-- #  HOW TO RUN:
-- #  node scripts/run-sql-test.mjs supabase/tests/purchase_order_lines.sql BL15_TEST_DONE
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
  v_mgr    text := 'bl15-mgr@test.local';
  v_rep    text := 'bl15-rep@test.local';
  v_tech   text := 'bl15-tech@test.local';
  v_acct   text := 'bl15-acct@test.local';
  v_v1     uuid := gen_random_uuid();
  v_p1     uuid := gen_random_uuid();
  v_p2     uuid := gen_random_uuid();
  v_po     public.purchase_orders;
  v_out    text;
  v_n      integer;
  v_lines  jsonb;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES (v_mgr, 'manager', 'active'), (v_rep, 'sales_rep', 'active'), (v_tech, 'technician', 'active'), (v_acct, 'accountant', 'active');
  INSERT INTO public.brands (id, brand_name) VALUES (v_v1, 'BL15 Vendor');
  INSERT INTO public.products (id, sku, product_name, product_type)
  VALUES (v_p1, 'BL15-P1', 'BL15 router', 'hardware'), (v_p2, 'BL15-P2', 'BL15 switch', 'hardware');
  v_lines := jsonb_build_array(
    jsonb_build_object('product_id', v_p1, 'product_name', 'BL15 router', 'qty_ordered', 10, 'unit_cost', 100, 'discount_pct', 10, 'tax_pct', 14),
    jsonb_build_object('product_id', v_p2, 'qty_ordered', 5, 'unit_cost', 200));

  -- ══ 1. create_purchase_order ═══════════════════════════════════════════════
  RAISE NOTICE '--- 1. create_purchase_order ---';
  PERFORM pg_temp.as_user(v_mgr);
  v_po := public.create_purchase_order(v_v1, v_lines, '{"currency":"EGP","notes":"first","payment_terms":"Net 30"}'::jsonb, 'someone-else@test.local');
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a manager creates a draft PO with a PO- code, attributed to the login (not the parameter)',
    v_po.status = 'draft' AND v_po.po_code LIKE 'PO-%' AND v_po.created_by = v_mgr AND v_po.revision_no = 1, format('-> %s %s %s', v_po.status, v_po.po_code, v_po.created_by));
  -- 10 x 100 = 1000 less 10% = 900, +14% = 126; 5 x 200 = 1000 -> 2000 / 100 / 126 / 2026
  RAISE NOTICE '%', pg_temp.check('totals are computed in the database from the lines (2000 / 100 / 126 / 2026)',
    v_po.subtotal = 2000 AND v_po.discount_amount = 100 AND v_po.tax_amount = 126 AND v_po.total = 2026,
    format('-> %s / %s / %s / %s', v_po.subtotal, v_po.discount_amount, v_po.tax_amount, v_po.total));
  SELECT count(*) INTO v_n FROM public.purchase_order_lines WHERE purchase_order_id = v_po.id;
  RAISE NOTICE '%', pg_temp.check('its lines are rows, and the mirror matches them (a missing name takes the catalogue name)',
    v_n = 2 AND v_po.line_items->1->>'product_name' = 'BL15 switch' AND (v_po.line_items->0->>'qty_ordered')::int = 10, '-> ' || v_n);

  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_purchase_order(%L, %L::jsonb, '{"currency":"EGP"}'::jsonb, %L)$q$, v_v1, v_lines, v_rep));
  RAISE NOTICE '%', pg_temp.check('a sales rep cannot create one (manager_write_purchase_orders)', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_purchase_order(%L, '[{"product_name":"free text","qty_ordered":1,"unit_cost":5}]'::jsonb, '{"currency":"EGP"}'::jsonb, %L)$q$, v_v1, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a line that is not a catalogue product is refused', v_out LIKE 'err:P0001%catalogue product%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_purchase_order(%L, %L::jsonb, '{"currency":"EGP"}'::jsonb, %L)$q$, v_v1,
    jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty_ordered', 2.5, 'unit_cost', 1)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a fractional quantity is refused', v_out LIKE 'err:P0001%whole number%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_purchase_order(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_v1, v_lines, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a currency is required', v_out LIKE 'err:P0001%currency%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_purchase_order(%L, %L::jsonb, '{"currency":"USD"}'::jsonb, %L)$q$, v_v1, v_lines, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a foreign currency without its rate is refused (rma_guard_document_rate)', v_out LIKE 'err:P0001%rate%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_purchase_order(%L, %L::jsonb, '{"currency":"EGP","total":1}'::jsonb, %L)$q$, v_v1, v_lines, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a field outside the list (total) is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_purchase_order(%L, %L::jsonb, '{"currency":"EGP","issue_date":"31/02/2026"}'::jsonb, %L)$q$, v_v1, v_lines, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a malformed date is refused readably', v_out LIKE 'err:P0001%valid date%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_purchase_order(%L, %L::jsonb, '{"currency":"EGP","expected_delivery_date":"infinity"}'::jsonb, %L)$q$, v_v1, v_lines, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a date word (infinity) is refused, not stored (review)', v_out LIKE 'err:P0001%valid date%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_purchase_order(%L, %L::jsonb, '{"currency":"EGP"}'::jsonb, %L)$q$, v_v1,
    jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty_ordered', 2, 'unit_cost', 9000000000)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('an order too large to store is refused readably, not with a numeric overflow (review)', v_out LIKE 'err:P0001%too large%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_purchase_order(%L, %L::jsonb, '{"currency":"EGP"}'::jsonb, %L)$q$, gen_random_uuid(), v_lines, v_mgr));
  RAISE NOTICE '%', pg_temp.check('an unknown vendor is refused', v_out LIKE 'err:P0001%vendor%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$INSERT INTO public.purchase_orders (po_code, vendor_id, line_items, currency, created_by) VALUES ('PO-DIRECT', %L, '[]', 'EGP', %L)$q$, v_v1, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a direct INSERT is refused', v_out LIKE 'err:42501%', '-> ' || v_out);

  -- ══ 2. The figures are always the lines ════════════════════════════════════
  RAISE NOTICE '--- 2. Money = lines ---';
  v_out := pg_temp.call(v_mgr, format('UPDATE public.purchase_orders SET total = 1 WHERE id = %L', v_po.id));
  RAISE NOTICE '%', pg_temp.check('a draft''s total cannot be written directly', v_out LIKE 'err:P0001%'
    AND (SELECT total FROM public.purchase_orders WHERE id = v_po.id) = 2026, '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.purchase_orders SET line_items = '[]' WHERE id = %L$q$, v_po.id));
  RAISE NOTICE '%', pg_temp.check('nor its lines', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.purchase_orders SET archived = true, archived_at = now(), archived_by = %L WHERE id = %L$q$, v_mgr, v_po.id));
  RAISE NOTICE '%', pg_temp.check('archiving still works directly', v_out = 'ok', '-> ' || v_out);
  PERFORM pg_temp.call(v_mgr, format('UPDATE public.purchase_orders SET archived = false, archived_at = NULL, archived_by = NULL WHERE id = %L', v_po.id));

  -- ══ 3. update_purchase_order ═══════════════════════════════════════════════
  RAISE NOTICE '--- 3. update_purchase_order ---';
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.update_purchase_order(%L, %L::jsonb, '{"delivery_terms":"FOB"}'::jsonb, %L)$q$, v_po.id,
    jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty_ordered', 4, 'unit_cost', 50)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a draft is edited: lines and a field, other fields kept', v_out = 'ok'
    AND (SELECT total = 200 AND delivery_terms = 'FOB' AND notes = 'first' AND payment_terms = 'Net 30' FROM public.purchase_orders WHERE id = v_po.id)
    AND (SELECT count(*) FROM public.purchase_order_lines WHERE purchase_order_id = v_po.id) = 1, '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.update_purchase_order(%L, NULL, '{"notes":null}'::jsonb, %L)$q$, v_po.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a key sent as null blanks that field; no lines keeps the lines', v_out = 'ok'
    AND (SELECT notes IS NULL AND total = 200 FROM public.purchase_orders WHERE id = v_po.id), '-> ' || v_out);
  v_out := pg_temp.call(v_tech, format($q$SELECT public.update_purchase_order(%L, NULL, '{"notes":"x"}'::jsonb, %L)$q$, v_po.id, v_tech));
  RAISE NOTICE '%', pg_temp.check('a technician cannot edit it', v_out LIKE 'err:P0001%', '-> ' || v_out);

  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.purchase_orders SET status = 'sent' WHERE id = %L$q$, v_po.id));
  RAISE NOTICE '%', pg_temp.check('sending it for approval is still a direct status change (markSent)', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.update_purchase_order(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_po.id,
    jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty_ordered', 400, 'unit_cost', 50)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a PO awaiting confirmation cannot be edited (the approver sees what was sent)', v_out LIKE 'err:P0001%'
    AND (SELECT total FROM public.purchase_orders WHERE id = v_po.id) = 200, '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.purchase_orders SET status = 'draft' WHERE id = %L$q$, v_po.id));
  RAISE NOTICE '%', pg_temp.check('...sent back to draft (rejectToDraft) it can be', v_out = 'ok' AND
    pg_temp.call(v_mgr, format($q$SELECT public.update_purchase_order(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_po.id,
      jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty_ordered', 10, 'unit_cost', 100, 'tax_pct', 14),
                        jsonb_build_object('product_id', v_p2, 'qty_ordered', 5, 'unit_cost', 200)), v_mgr)) = 'ok', '-> ' || v_out);

  -- ══ 4. amend_purchase_order writes the rows ════════════════════════════════
  RAISE NOTICE '--- 4. amend ---';
  UPDATE public.purchase_orders SET status = 'sent' WHERE id = v_po.id;        -- as the owner: confirmation is tested elsewhere
  UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po.id;
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.amend_purchase_order(%L, %L::jsonb, 'Supplier short on routers', 'forged@test.local')$q$, v_po.id,
    jsonb_build_object('line_items', jsonb_build_array(
      jsonb_build_object('product_id', v_p1, 'qty_ordered', 6, 'unit_cost', 100, 'tax_pct', 14),
      jsonb_build_object('product_id', v_p2, 'qty_ordered', 5, 'unit_cost', 200)))));
  RAISE NOTICE '%', pg_temp.check('fewer units at the same prices: amended, still confirmed, rows and mirror agree', v_out = 'ok'
    AND (SELECT status = 'confirmed' AND revision_no = 2 AND total = 1684 AND (line_items->0->>'qty_ordered')::int = 6 FROM public.purchase_orders WHERE id = v_po.id)
    AND (SELECT qty_ordered FROM public.purchase_order_lines WHERE purchase_order_id = v_po.id AND line_no = 0) = 6, '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('the revision is recorded under the login, not the parameter',
    (SELECT created_by FROM public.purchase_order_revisions WHERE po_id = v_po.id AND rev_no = 1) = v_mgr);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.amend_purchase_order(%L, %L::jsonb, 'Supplier changed the tax on switches', %L)$q$, v_po.id,
    jsonb_build_object('line_items', jsonb_build_array(
      jsonb_build_object('product_id', v_p1, 'qty_ordered', 6, 'unit_cost', 100, 'tax_pct', 14),
      jsonb_build_object('product_id', v_p2, 'qty_ordered', 4, 'unit_cost', 200, 'tax_pct', 5))), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a tax the old order did not carry sends it back to pending_confirmation, even at a lower total', v_out = 'ok'
    AND (SELECT status FROM public.purchase_orders WHERE id = v_po.id) = 'pending_confirmation', '-> ' || v_out);

  -- ══ 5. Read access follows the order ═══════════════════════════════════════
  RAISE NOTICE '--- 5. Read access ---';
  PERFORM pg_temp.as_user(v_acct);
  SELECT count(*)::integer INTO v_n FROM public.purchase_order_lines WHERE purchase_order_id = v_po.id;
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('an accountant sees a purchase order''s lines', v_n = 2, '-> ' || v_n);
  PERFORM pg_temp.as_user(v_tech);
  SELECT count(*)::integer INTO v_n FROM public.purchase_order_lines WHERE purchase_order_id = v_po.id;
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a technician sees none', v_n = 0, '-> ' || v_n);

  -- ══ 6. Access ═══════════════════════════════════════════════════════════════
  RAISE NOTICE '--- 6. Access ---';
  v_out := pg_temp.call(v_mgr, format($q$INSERT INTO public.purchase_order_lines (purchase_order_id, line_no, product_name, qty_ordered, unit_cost) VALUES (%L, 9, 'x', 1, 1)$q$, v_po.id));
  RAISE NOTICE '%', pg_temp.check('a client cannot write purchase_order_lines', v_out LIKE 'err:%', '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('anon cannot call the RPCs; no client can call the internals',
    NOT has_function_privilege('anon', 'public.create_purchase_order(uuid, jsonb, jsonb, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.update_purchase_order(uuid, jsonb, jsonb, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._purchase_order_write_lines(uuid, jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._purchase_order_check_fields(jsonb, text[])', 'EXECUTE'));

  RAISE EXCEPTION 'BL15_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
