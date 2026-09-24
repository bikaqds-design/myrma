-- ############################################################################
-- #  DELIVERIES — P-01a (20260894)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/deliveries.sql P01_TEST_DONE
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

CREATE TEMP TABLE ids (tag text PRIMARY KEY, id uuid);
GRANT ALL ON ids TO authenticated;

DO $do$
DECLARE
  v_mgr   text := 'p01-mgr@test.local';
  v_rep   text := 'p01-rep@test.local';
  v_rep2  text := 'p01-rep2@test.local';
  v_so3   public.sales_orders;
  v_so4   public.sales_orders;
  v_cust  uuid;
  v_wh    uuid := gen_random_uuid();
  v_ser   uuid := gen_random_uuid();
  v_bulk  uuid := gen_random_uuid();
  v_svc   uuid := gen_random_uuid();
  v_ws    uuid := gen_random_uuid();
  v_so    public.sales_orders;
  v_so2   public.sales_orders;
  v_d     public.deliveries;
  v_d2    public.deliveries;
  v_l_ser uuid;
  v_l_blk uuid;
  v_l_svc uuid;
  v_out   text;
  v_n     numeric;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_mgr, 'manager', 'active'), (v_rep, 'sales_rep', 'active'), (v_rep2, 'sales_rep', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('P01 Co', 'P01-C1', 'B2B') RETURNING id INTO v_cust;
  INSERT INTO public.warehouses (id, name, code, warehouse_type) VALUES (v_wh, 'P01 WH', 'P01-WH', 'main');
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode) VALUES
    (v_ser,  'P01-SER',  'P01 router', 'hardware', 'serialized'),
    (v_bulk, 'P01-BULK', 'P01 cable',  'hardware', 'bulk'),
    (v_svc,  'P01-SVC',  'P01 install', 'service', 'serialized');
  -- three units at 100, 110, NULL cost; a bin of 20 costing 2 000 (average 100)
  INSERT INTO public.inventory_units (product_id, product_name, serial_number, status, reservation_status, warehouse_id, unit_cost_base)
  VALUES (v_ser, 'P01 router', 'P01-SN1', 'company_stock', 'available', v_wh, 100),
         (v_ser, 'P01 router', 'P01-SN2', 'company_stock', 'available', v_wh, 110),
         (v_ser, 'P01 router', 'P01-SN3', 'company_stock', 'available', v_wh, NULL);
  INSERT INTO public.warehouse_stock (id, product_id, warehouse_id, quantity, reserved_quantity, total_cost_base, uncosted_quantity)
  VALUES (v_ws, v_bulk, v_wh, 20, 0, 2000, 0);

  -- an approved order: 3 routers, 10 cables, 1 installation
  PERFORM pg_temp.as_user(v_rep);
  v_so := public.create_sales_order(v_cust, jsonb_build_array(
    jsonb_build_object('product_id', v_ser,  'qty', 3,  'unit_price', 500),
    jsonb_build_object('product_id', v_bulk, 'qty', 10, 'unit_price', 20),
    jsonb_build_object('product_id', v_svc,  'qty', 1,  'unit_price', 300)), NULL, NULL, NULL, NULL, v_rep, v_rep);
  PERFORM pg_temp.as_owner();
  UPDATE public.sales_orders SET status = 'sent' WHERE id = v_so.id;
  v_out := pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('fixture: the order is approved and its stock reserved', v_out = 'ok'
    AND (SELECT reserved_quantity FROM public.warehouse_stock WHERE id = v_ws) = 10
    AND (SELECT count(*) FROM public.inventory_units WHERE reserved_by_doc_id = v_so.id) = 3, '-> ' || v_out);
  SELECT id INTO v_l_ser FROM public.sales_order_lines WHERE sales_order_id = v_so.id AND product_id = v_ser;
  SELECT id INTO v_l_blk FROM public.sales_order_lines WHERE sales_order_id = v_so.id AND product_id = v_bulk;
  SELECT id INTO v_l_svc FROM public.sales_order_lines WHERE sales_order_id = v_so.id AND product_id = v_svc;

  -- ══ 1. preparing a delivery ══════════════════════════════════════════════
  RAISE NOTICE '--- 1. create_delivery ---';
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_delivery(%L, %L::jsonb, NULL, %L)$q$, v_so.id,
    jsonb_build_array(jsonb_build_object('sales_order_line_id', v_l_ser, 'qty', 1)), v_rep));
  RAISE NOTICE '%', pg_temp.check('a sales rep cannot prepare a delivery', v_out LIKE 'err:P0001%manager%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_delivery(%L, %L::jsonb, NULL, %L)$q$, v_so.id,
    jsonb_build_array(jsonb_build_object('sales_order_line_id', v_l_svc, 'qty', 1)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a service line is not delivered from stock', v_out LIKE 'err:P0001%service%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_delivery(%L, %L::jsonb, NULL, %L)$q$, v_so.id,
    jsonb_build_array(jsonb_build_object('sales_order_line_id', v_l_ser, 'qty', 4)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('more than was ordered is refused', v_out LIKE 'err:P0001%only 3 left%', '-> ' || v_out);

  PERFORM pg_temp.as_user(v_mgr);
  v_d := public.create_delivery(v_so.id, jsonb_build_array(
    jsonb_build_object('sales_order_line_id', v_l_ser, 'qty', 2),
    jsonb_build_object('sales_order_line_id', v_l_blk, 'qty', 6)), 'first truck', v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a manager prepares a partial delivery (draft, no code yet, nothing moved)',
    v_d.status = 'draft' AND v_d.delivery_code IS NULL
    AND (SELECT quantity FROM public.warehouse_stock WHERE id = v_ws) = 20);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_delivery(%L, %L::jsonb, NULL, %L)$q$, v_so.id,
    jsonb_build_array(jsonb_build_object('sales_order_line_id', v_l_ser, 'qty', 2)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a second draft cannot claim units the first draft holds (3 ordered, 2 on a draft)', v_out LIKE 'err:P0001%only 1 left%', '-> ' || v_out);

  -- ══ 2. confirming it: the goods leave ═════════════════════════════════════
  RAISE NOTICE '--- 2. confirm_delivery ---';
  v_out := pg_temp.call(v_rep, format('SELECT public.confirm_delivery(%L, %L)', v_d.id, v_rep));
  RAISE NOTICE '%', pg_temp.check('a sales rep cannot confirm a delivery (owner decision: managers only)', v_out LIKE 'err:P0001%manager%', '-> ' || v_out);
  PERFORM pg_temp.as_user(v_mgr);
  v_d := public.confirm_delivery(v_d.id, v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('confirmed with a DN- code', v_d.status = 'confirmed' AND v_d.delivery_code LIKE 'DN-%', '-> ' || COALESCE(v_d.delivery_code, 'null'));
  RAISE NOTICE '%', pg_temp.check('2 of the 3 reserved routers are delivered, 1 stays reserved',
    (SELECT count(*) FROM public.inventory_units WHERE product_id = v_ser AND reservation_status = 'delivered') = 2
    AND (SELECT count(*) FROM public.inventory_units WHERE reserved_by_doc_id = v_so.id AND reservation_status = 'reserved') = 1);
  RAISE NOTICE '%', pg_temp.check('6 of the 10 reserved cables left the bin (20 -> 14 on hand, 10 -> 4 reserved)',
    (SELECT quantity = 14 AND reserved_quantity = 4 FROM public.warehouse_stock WHERE id = v_ws));
  RAISE NOTICE '%', pg_temp.check('each move is on the ledger under the order',
    (SELECT count(*) FROM public.stock_moves WHERE doc_type = 'sales_order' AND doc_id = v_so.id AND move_type = 'deliver') = 3);
  SELECT cogs_base INTO v_n FROM public.delivery_lines WHERE delivery_id = v_d.id AND product_id = v_bulk;
  RAISE NOTICE '%', pg_temp.check('the cables are costed at the bin''s average (6 x 100 = 600)', v_n = 600, '-> ' || v_n);
  RAISE NOTICE '%', pg_temp.check('the routers are costed at their own units'' cost, the units recorded',
    (SELECT count(*) FROM public.delivery_line_units u JOIN public.delivery_lines l ON l.id = u.delivery_line_id WHERE l.delivery_id = v_d.id) = 2
    AND (SELECT cogs_base + 0 FROM public.delivery_lines WHERE delivery_id = v_d.id AND product_id = v_ser)
      = (SELECT COALESCE(sum(u.unit_cost_base), 0) FROM public.delivery_line_units u JOIN public.delivery_lines l ON l.id = u.delivery_line_id WHERE l.delivery_id = v_d.id));
  RAISE NOTICE '%', pg_temp.check('a partly delivered order stays confirmed', (SELECT status FROM public.sales_orders WHERE id = v_so.id) = 'confirmed');
  v_out := pg_temp.call(v_mgr, format('SELECT public.confirm_delivery(%L, %L)', v_d.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a delivery cannot be confirmed twice', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('SELECT public.cancel_delivery(%L, %L)', v_d.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a confirmed delivery cannot be cancelled', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- ══ 3. the back-order ships; the order is delivered ══════════════════════
  RAISE NOTICE '--- 3. the rest ---';
  PERFORM pg_temp.as_user(v_mgr);
  v_d2 := public.create_delivery(v_so.id, jsonb_build_array(
    jsonb_build_object('sales_order_line_id', v_l_ser, 'qty', 1),
    jsonb_build_object('sales_order_line_id', v_l_blk, 'qty', 4)), NULL, v_mgr);
  v_d2 := public.confirm_delivery(v_d2.id, v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('the second delivery gets the next DN- number', v_d2.delivery_code > v_d.delivery_code, '-> ' || v_d2.delivery_code);
  -- which delivery took the uncosted unit depends on reservation order
  RAISE NOTICE '%', pg_temp.check('the unit with no known cost is counted as unknown, not as zero; the rest are costed',
    (SELECT sum(cogs_unknown_qty) FROM public.delivery_lines WHERE delivery_id IN (v_d.id, v_d2.id) AND product_id = v_ser) = 1
    AND (SELECT sum(cogs_base) FROM public.delivery_lines WHERE delivery_id IN (v_d.id, v_d2.id) AND product_id = v_ser) = 210);
  RAISE NOTICE '%', pg_temp.check('with every stock line shipped the order is delivered (the service line does not wait)',
    (SELECT status = 'delivered' AND delivered_at IS NOT NULL FROM public.sales_orders WHERE id = v_so.id));
  RAISE NOTICE '%', pg_temp.check('nothing is left reserved for it',
    (SELECT reserved_quantity FROM public.warehouse_stock WHERE id = v_ws) = 0
    AND NOT EXISTS (SELECT 1 FROM public.inventory_units WHERE reserved_by_doc_id = v_so.id));

  -- ══ 4. cancel, and the two paths never mix ════════════════════════════════
  RAISE NOTICE '--- 4. cancel and exclusion ---';
  v_out := pg_temp.call(v_mgr, format('SELECT public.convert_so_to_invoice(%L, %L)', v_so.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('an order that ships by deliveries cannot be invoiced whole (it would ship twice)', v_out LIKE 'err:P0001%deliveries%', '-> ' || v_out);

  INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity, total_cost_base, uncosted_quantity)
  SELECT v_bulk, v_wh, 0, 0, 0, 0 WHERE false;   -- (bin already exists; reuse it)
  UPDATE public.warehouse_stock SET quantity = quantity + 5 WHERE id = v_ws;
  PERFORM pg_temp.as_user(v_rep);
  v_so2 := public.create_sales_order(v_cust, jsonb_build_array(jsonb_build_object('product_id', v_bulk, 'qty', 2, 'unit_price', 20)), NULL, NULL, NULL, NULL, v_rep, v_rep);
  PERFORM pg_temp.as_owner();
  UPDATE public.sales_orders SET status = 'sent' WHERE id = v_so2.id;
  PERFORM pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so2.id, v_mgr));
  PERFORM pg_temp.as_user(v_mgr);
  v_d := public.create_delivery(v_so2.id, jsonb_build_array(jsonb_build_object('sales_order_line_id',
           (SELECT id FROM public.sales_order_lines WHERE sales_order_id = v_so2.id), 'qty', 1)), NULL, v_mgr);
  v_d := public.cancel_delivery(v_d.id, v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a draft delivery can be cancelled; its quantity is free again', v_d.status = 'cancelled'
    AND public.rma_so_line_delivered_qty((SELECT id FROM public.sales_order_lines WHERE sales_order_id = v_so2.id), true) = 0);
  v_out := pg_temp.call(v_mgr, format('SELECT public.convert_so_to_invoice(%L, %L)', v_so2.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('with only a cancelled delivery, the order can still be invoiced the old way', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_delivery(%L, %L::jsonb, NULL, %L)$q$, v_so2.id,
    jsonb_build_array(jsonb_build_object('sales_order_line_id', (SELECT id FROM public.sales_order_lines WHERE sales_order_id = v_so2.id), 'qty', 1)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('and once invoiced whole, it cannot get deliveries', v_out LIKE 'err:P0001%invoiced as a whole%', '-> ' || v_out);

  -- ══ 4b. an order with shipped goods (review of 809aa09) ═════════════════════
  RAISE NOTICE '--- 4b. cancelling an order, integrity report ---';
  v_out := pg_temp.call(v_mgr, format('SELECT public.cancel_sales_order(%L, %L)', v_so.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('an order whose goods have been delivered cannot be cancelled', v_out LIKE 'err:P0001%delivered%', '-> ' || v_out);

  PERFORM pg_temp.as_user(v_rep);
  v_so3 := public.create_sales_order(v_cust, jsonb_build_array(jsonb_build_object('product_id', v_bulk, 'qty', 3, 'unit_price', 20)), NULL, NULL, NULL, NULL, v_rep, v_rep);
  v_so4 := public.create_sales_order(v_cust, jsonb_build_array(jsonb_build_object('product_id', v_bulk, 'qty', 1, 'unit_price', 20)), NULL, NULL, NULL, NULL, v_rep, v_rep);
  PERFORM pg_temp.as_owner();
  UPDATE public.sales_orders SET status = 'sent' WHERE id IN (v_so3.id, v_so4.id);
  PERFORM pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so3.id, v_mgr));
  PERFORM pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so4.id, v_mgr));
  PERFORM pg_temp.as_user(v_mgr);
  v_d := public.create_delivery(v_so3.id, jsonb_build_array(jsonb_build_object('sales_order_line_id',
           (SELECT id FROM public.sales_order_lines WHERE sales_order_id = v_so3.id), 'qty', 1)), NULL, v_mgr);
  v_d := public.confirm_delivery(v_d.id, v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a partly delivered order is not reported as holding less than it sold',
    NOT EXISTS (SELECT 1 FROM public.rma_reservation_integrity() r WHERE r.entity_id = v_so3.id),
    '-> ' || COALESCE((SELECT string_agg(r.detail, '; ') FROM public.rma_reservation_integrity() r WHERE r.entity_id = v_so3.id), ''));
  PERFORM pg_temp.as_user(v_mgr);
  v_d2 := public.create_delivery(v_so4.id, jsonb_build_array(jsonb_build_object('sales_order_line_id',
           (SELECT id FROM public.sales_order_lines WHERE sales_order_id = v_so4.id), 'qty', 1)), NULL, v_mgr);
  PERFORM pg_temp.as_owner();
  v_out := pg_temp.call(v_mgr, format('SELECT public.cancel_sales_order(%L, %L)', v_so4.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('an order with only a draft delivery can be cancelled, and the draft goes with it',
    v_out = 'ok' AND (SELECT status FROM public.deliveries WHERE id = v_d2.id) = 'cancelled', '-> ' || v_out);

  PERFORM pg_temp.as_user(v_rep);
  v_so4 := public.create_sales_order(v_cust, jsonb_build_array(jsonb_build_object('product_id', v_bulk, 'qty', 1, 'unit_price', 20)), NULL, NULL, NULL, NULL, v_rep, v_rep);
  PERFORM pg_temp.as_owner();
  UPDATE public.sales_orders SET assigned_rep = NULL WHERE id = v_so4.id;
  v_out := pg_temp.call(v_rep2, format('SELECT public.cancel_sales_order(%L, %L)', v_so4.id, v_rep2));
  RAISE NOTICE '%', pg_temp.check('a sales rep cannot cancel another rep''s unassigned order', v_out LIKE 'err:P0001%Not authorized%', '-> ' || v_out);

  -- ══ 5. access ═════════════════════════════════════════════════════════════
  v_out := pg_temp.call(v_mgr, format($q$INSERT INTO public.deliveries (sales_order_id, customer_id, created_by) VALUES (%L, %L, 'x')$q$, v_so.id, v_cust));
  RAISE NOTICE '%', pg_temp.check('no client writes a delivery directly', v_out LIKE 'err:42501%', '-> ' || v_out);
  PERFORM pg_temp.as_user(v_rep);
  SELECT count(*) INTO v_n FROM public.delivery_line_units;
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a sales rep does not see unit costs of deliveries', v_n = 0, '-> ' || v_n);

  RAISE EXCEPTION 'P01_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
