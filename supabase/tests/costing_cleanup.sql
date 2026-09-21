-- ############################################################################
-- #  COSTING CLEAN-UP — BL-09 / I-07 (20260882)
-- #
-- #  HOW TO RUN:
-- #  node scripts/run-sql-test.mjs supabase/tests/costing_cleanup.sql BL09_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- ############################################################################

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail)
$f$;

-- Run p_sql as the given user (NULL = as the session owner) and say what happened.
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
  v_mgr   text := 'bl09-mgr@test.local';
  v_tech  text := 'bl09-tech@test.local';
  v_vend  uuid := gen_random_uuid();
  v_wh    uuid;
  v_ps    uuid := gen_random_uuid();   -- serialized product
  v_pb    uuid := gen_random_uuid();   -- bulk product
  v_pn    uuid := gen_random_uuid();   -- a product that is not on the invoice
  v_vi    uuid := gen_random_uuid();
  v_vi2   uuid := gen_random_uuid();
  v_out   text;
  v_cost  numeric;
  v_q     record;
  v_json  jsonb;
  v_n     integer;
  fmt     text := $q$SELECT public.receive_vendor_invoice(%L, %L::jsonb, %L)$q$;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES (v_mgr, 'manager', 'active'), (v_tech, 'technician', 'active');
  INSERT INTO public.brands (id, brand_name) VALUES (v_vend, 'BL09 Vendor');
  INSERT INTO public.warehouses (name, code, warehouse_type) VALUES ('BL09 Warehouse', 'BL09-WH', 'main') RETURNING id INTO v_wh;
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode)
  VALUES (v_ps, 'BL09-S', 'BL09 serialized', 'hardware', 'serialized'),
         (v_pb, 'BL09-B', 'BL09 bulk', 'hardware', 'bulk'),
         (v_pn, 'BL09-N', 'BL09 not on invoice', 'hardware', 'serialized');

  -- ══ 1. The same product on two lines is costed per line ═════════════════
  RAISE NOTICE '--- 1. Per-line cost ---';
  INSERT INTO public.vendor_invoices (id, vendor_id, status, currency, total, subtotal, created_by, line_items)
  VALUES (v_vi, v_vend, 'approved', 'EGP', 300, 300, v_mgr, jsonb_build_array(
    jsonb_build_object('product_id', v_ps, 'product_name', 'BL09 serialized', 'qty_ordered', 2, 'qty_received', 0, 'unit_cost', 10),
    jsonb_build_object('product_id', v_ps, 'product_name', 'BL09 serialized', 'qty_ordered', 1, 'qty_received', 0, 'unit_cost', 20),
    jsonb_build_object('product_id', v_pb, 'product_name', 'BL09 bulk',       'qty_ordered', 5, 'qty_received', 0, 'unit_cost', 0)));

  v_out := pg_temp.call(v_mgr, format(fmt, v_vi, jsonb_build_array(
    jsonb_build_object('product_id', v_ps, 'warehouse_id', v_wh, 'serials', jsonb_build_array('BL09-A1'))), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a product on two lines cannot be received without saying which line', v_out LIKE 'err:P0001%', '-> ' || v_out);

  v_out := pg_temp.call(v_mgr, format(fmt, v_vi, jsonb_build_array(
    jsonb_build_object('product_id', v_ps, 'warehouse_id', v_wh, 'line_index', 0, 'serials', jsonb_build_array('BL09-A1', 'BL09-A2')),
    jsonb_build_object('product_id', v_ps, 'warehouse_id', v_wh, 'line_index', 1, 'serials', jsonb_build_array('BL09-B1'))), v_mgr));
  RAISE NOTICE '%', pg_temp.check('with line_index both lines are received', v_out = 'ok', '-> ' || v_out);
  SELECT unit_cost_base INTO v_cost FROM public.inventory_units WHERE serial_number = 'BL09-A1';
  RAISE NOTICE '%', pg_temp.check('line 1 units cost that line''s price (10)', v_cost = 10, '-> ' || coalesce(v_cost::text, '<null>'));
  SELECT unit_cost_base INTO v_cost FROM public.inventory_units WHERE serial_number = 'BL09-B1';
  RAISE NOTICE '%', pg_temp.check('line 2 units cost that line''s price (20), not the first line''s', v_cost = 20, '-> ' || coalesce(v_cost::text, '<null>'));
  RAISE NOTICE '%', pg_temp.check('quantities fold onto their own line',
    (SELECT (line_items->0->>'qty_received')::int = 2 AND (line_items->1->>'qty_received')::int = 1 AND (line_items->2->>'qty_received')::int = 0
       FROM public.vendor_invoices WHERE id = v_vi));

  -- ══ 2. What can be received ═════════════════════════════════════════════
  RAISE NOTICE '--- 2. Bounds ---';
  v_out := pg_temp.call(v_mgr, format(fmt, v_vi, jsonb_build_array(
    jsonb_build_object('product_id', v_pn, 'warehouse_id', v_wh, 'serials', jsonb_build_array('BL09-X1'))), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a product that is not on the invoice is refused', v_out LIKE 'err:P0001%' AND v_out LIKE '%not on this vendor invoice%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format(fmt, v_vi, jsonb_build_array(
    jsonb_build_object('product_id', v_ps, 'warehouse_id', v_wh, 'line_index', 1, 'serials', jsonb_build_array('BL09-B2'))), v_mgr));
  RAISE NOTICE '%', pg_temp.check('more than the line has left is refused', v_out LIKE 'err:P0001%' AND v_out LIKE '%left to receive%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format(fmt, v_vi, jsonb_build_array(
    jsonb_build_object('product_id', v_pb, 'warehouse_id', v_wh, 'line_index', 2, 'qty', 3),
    jsonb_build_object('product_id', v_pb, 'warehouse_id', v_wh, 'line_index', 2, 'qty', 3)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('two entries in one call cannot together exceed the line', v_out LIKE 'err:P0001%' AND v_out LIKE '%left to receive%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format(fmt, v_vi, jsonb_build_array(
    jsonb_build_object('product_id', v_pb, 'warehouse_id', v_wh, 'line_index', 0, 'qty', 1)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a line_index that names a different product is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- an invoice with one line, received in two parts, still completes as before
  DECLARE v_vi3 uuid := gen_random_uuid();
  BEGIN
    INSERT INTO public.vendor_invoices (id, vendor_id, status, currency, total, subtotal, created_by, line_items)
    VALUES (v_vi3, v_vend, 'approved', 'EGP', 30, 30, v_mgr, jsonb_build_array(
      jsonb_build_object('product_id', v_ps, 'product_name', 'BL09 serialized', 'qty_ordered', 3, 'qty_received', 0, 'unit_cost', 10)));
    PERFORM pg_temp.call(v_mgr, format(fmt, v_vi3, jsonb_build_array(
      jsonb_build_object('product_id', v_ps, 'warehouse_id', v_wh, 'serials', jsonb_build_array('BL09-P1', 'BL09-P2'))), v_mgr));
    RAISE NOTICE '%', pg_temp.check('a partial receipt leaves the invoice partially_received', (SELECT status FROM public.vendor_invoices WHERE id = v_vi3) = 'partially_received');
    PERFORM pg_temp.call(v_mgr, format(fmt, v_vi3, jsonb_build_array(
      jsonb_build_object('product_id', v_ps, 'warehouse_id', v_wh, 'serials', jsonb_build_array('BL09-P3'))), v_mgr));
    RAISE NOTICE '%', pg_temp.check('the rest completes it, quantity 3 on the line',
      (SELECT status = 'received' AND (line_items->0->>'qty_received')::int = 3 FROM public.vendor_invoices WHERE id = v_vi3));
  END;

  -- ══ 3. A line with no price is unknown, never zero ══════════════════════
  RAISE NOTICE '--- 3. Unknown cost ---';
  -- a bin that already has a known cost
  INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity, total_cost_base, uncosted_quantity)
  VALUES (v_pb, v_wh, 4, 0, 400, 0);
  v_out := pg_temp.call(v_mgr, format(fmt, v_vi, jsonb_build_array(
    jsonb_build_object('product_id', v_pb, 'warehouse_id', v_wh, 'qty', 5)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('receiving an unpriced bulk line succeeds', v_out = 'ok', '-> ' || v_out);
  SELECT * INTO v_q FROM public.warehouse_stock WHERE product_id = v_pb AND warehouse_id = v_wh;
  RAISE NOTICE '%', pg_temp.check('the 5 units are counted as uncosted', v_q.quantity = 9 AND v_q.uncosted_quantity = 5, '-> qty ' || v_q.quantity || ' uncosted ' || v_q.uncosted_quantity);
  RAISE NOTICE '%', pg_temp.check('the average of the costed units is not diluted (100)', v_q.avg_cost_base = 100, '-> ' || coalesce(v_q.avg_cost_base::text, '<null>'));

  INSERT INTO public.vendor_invoices (id, vendor_id, status, currency, total, subtotal, created_by, line_items)
  VALUES (v_vi2, v_vend, 'approved', 'EGP', 0, 0, v_mgr, jsonb_build_array(
    jsonb_build_object('product_id', v_ps, 'product_name', 'BL09 serialized', 'qty_ordered', 1, 'qty_received', 0)));
  v_out := pg_temp.call(v_mgr, format(fmt, v_vi2, jsonb_build_array(
    jsonb_build_object('product_id', v_ps, 'warehouse_id', v_wh, 'serials', jsonb_build_array('BL09-U1'))), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a line with no unit_cost at all is received', v_out = 'ok', '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('its unit has NO cost (NULL), not zero', (SELECT unit_cost_base IS NULL FROM public.inventory_units WHERE serial_number = 'BL09-U1'));

  -- ══ 4. The worklist ═════════════════════════════════════════════════════
  RAISE NOTICE '--- 4. Uncosted worklist ---';
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM public.rma_uncosted_stock() WHERE product_id IN (v_ps, v_pb);
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE '%', pg_temp.check('a manager sees the serialized and the bulk product on it', v_n = 2, '-> ' || v_n);
  v_out := pg_temp.call(v_tech, 'SELECT * FROM public.rma_uncosted_stock()');
  RAISE NOTICE '%', pg_temp.check('a technician is refused', v_out LIKE 'err:%', '-> ' || v_out);
  -- a delivered unit is not stock on hand, so it is not on the worklist
  INSERT INTO public.inventory_units (product_id, product_name, serial_number, status, reservation_status, warehouse_id, created_date)
  VALUES (v_ps, 'BL09 serialized', 'BL09-D1', 'company_stock', 'delivered', v_wh, now());
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT uncosted_units INTO v_n FROM public.rma_uncosted_stock() WHERE product_id = v_ps;
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE '%', pg_temp.check('a delivered unit is not on the list (only BL09-U1 is)', v_n = 1, '-> ' || v_n);

  -- ══ 5. Importing opening costs ══════════════════════════════════════════
  RAISE NOTICE '--- 5. Opening-cost import ---';
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT public.rma_import_opening_costs(jsonb_build_array(
    jsonb_build_object('sku', 'BL09-B', 'warehouse', 'BL09-WH', 'unit_cost', 80),
    jsonb_build_object('sku', 'NO-SUCH-SKU', 'warehouse', 'BL09-WH', 'unit_cost', 5),
    jsonb_build_object('sku', 'BL09-S', 'warehouse', 'No such warehouse', 'unit_cost', 5),
    jsonb_build_object('sku', 'BL09-S', 'warehouse', 'bl09 warehouse', 'unit_cost', 0),
    jsonb_build_object('sku', 'bl09-s', 'warehouse', 'BL09-WH', 'unit_cost', 30))) INTO v_json;
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE '%', pg_temp.check('the good rows are applied and the bad ones reported',
    (v_json->0->>'ok')::boolean AND NOT (v_json->1->>'ok')::boolean AND NOT (v_json->2->>'ok')::boolean
    AND NOT (v_json->3->>'ok')::boolean AND (v_json->4->>'ok')::boolean, '-> ' || v_json::text);
  SELECT * INTO v_q FROM public.warehouse_stock WHERE product_id = v_pb AND warehouse_id = v_wh;
  RAISE NOTICE '%', pg_temp.check('the bulk bin is fully costed', v_q.uncosted_quantity = 0 AND v_q.total_cost_base = 400 + 5 * 80, '-> uncosted ' || v_q.uncosted_quantity || ' total ' || v_q.total_cost_base);
  RAISE NOTICE '%', pg_temp.check('the uncosted serial unit took the opening cost, a costed one kept its own',
    (SELECT unit_cost_base FROM public.inventory_units WHERE serial_number = 'BL09-U1') = 30
    AND (SELECT unit_cost_base FROM public.inventory_units WHERE serial_number = 'BL09-A1') = 10);
  v_out := pg_temp.call(v_tech, $q$SELECT public.rma_import_opening_costs('[]'::jsonb)$q$);
  RAISE NOTICE '%', pg_temp.check('a technician cannot import costs', v_out LIKE 'err:%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, $q$SELECT public.rma_import_opening_costs('{"a":1}'::jsonb)$q$);
  RAISE NOTICE '%', pg_temp.check('a non-list is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- ══ 6. Access ═══════════════════════════════════════════════════════════
  RAISE NOTICE '--- 6. Access ---';
  RAISE NOTICE '%', pg_temp.check('anon cannot run any of them',
    NOT has_function_privilege('anon', 'public.rma_uncosted_stock()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rma_import_opening_costs(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rma_vi_landed_unit_costs(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.receive_vendor_invoice(uuid, jsonb, text)', 'EXECUTE'));

  RAISE EXCEPTION 'BL09_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
