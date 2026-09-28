-- ############################################################################
-- #  CUSTOMER RETURNS — P-05a (20260902)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/customer_returns.sql P05A_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI. The final
-- #  error message also carries every PASS/FAIL line, for runners that do not
-- #  show notices.
-- ############################################################################

SELECT set_config('p05a.log', '', false);
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE l text := format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, CASE WHEN p_ok THEN '' ELSE p_detail END);
BEGIN
  PERFORM set_config('p05a.log', COALESCE(current_setting('p05a.log', true), '') || E'\n' || l, false);
  RETURN l;
END $f$;
CREATE FUNCTION pg_temp.call(p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE out text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    out := 'ok';
  EXCEPTION WHEN OTHERS THEN
    out := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 200);
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
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
  v_mgr    text := 'p05-mgr@test.local';
  v_rep    text := 'p05-rep@test.local';
  v_cust   uuid;
  v_wh     uuid := gen_random_uuid();
  v_wh2    uuid := gen_random_uuid();
  v_scrap  uuid;
  v_ser    uuid := gen_random_uuid();
  v_bulk   uuid := gen_random_uuid();
  v_unk    uuid := gen_random_uuid();
  v_ws     uuid := gen_random_uuid();
  v_wsu    uuid := gen_random_uuid();
  v_so     public.sales_orders;
  v_d      public.deliveries;
  v_r1     public.customer_returns;
  v_r      public.customer_returns;
  v_dl_ser uuid;
  v_dl_blk uuid;
  v_dl_unk uuid;
  v_inv    uuid;
  v_u1     uuid;
  v_u2     uuid;
  v_u3     uuid;
  v_out    text;
  v_id     uuid;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_mgr, 'manager', 'active'), (v_rep, 'sales_rep', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('P05 Co', 'P05-C1', 'B2B') RETURNING id INTO v_cust;
  INSERT INTO public.warehouses (id, name, code, warehouse_type) VALUES
    (v_wh, 'P05 WH', 'P05-WH', 'main'), (v_wh2, 'P05 Branch', 'P05-BR', 'branch');
  SELECT id INTO v_scrap FROM public.warehouses WHERE code = 'SCRAP' AND is_system;
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode) VALUES
    (v_ser,  'P05-SER', 'P05 router',  'hardware', 'serialized'),
    (v_bulk, 'P05-BLK', 'P05 cable',   'hardware', 'bulk'),
    (v_unk,  'P05-UNK', 'P05 adapter', 'hardware', 'bulk');
  INSERT INTO public.inventory_units (id, product_id, product_name, serial_number, status, reservation_status, warehouse_id, unit_cost_base)
  VALUES (gen_random_uuid(), v_ser, 'P05 router', 'P05-SN1', 'company_stock', 'available', v_wh, 100),
         (gen_random_uuid(), v_ser, 'P05 router', 'P05-SN2', 'company_stock', 'available', v_wh, 120),
         (gen_random_uuid(), v_ser, 'P05 router', 'P05-SN3', 'company_stock', 'available', v_wh, 100);
  -- cables at 50 each; adapters of unknown cost
  INSERT INTO public.warehouse_stock (id, product_id, warehouse_id, quantity, reserved_quantity, total_cost_base, uncosted_quantity)
  VALUES (v_ws, v_bulk, v_wh, 20, 0, 1000, 0), (v_wsu, v_unk, v_wh, 5, 0, 0, 5);

  -- an approved order: 2 routers, 10 cables, 3 adapters, all delivered
  PERFORM pg_temp.as_user(v_rep);
  v_so := public.create_sales_order(v_cust, jsonb_build_array(
    jsonb_build_object('product_id', v_ser,  'qty', 2,  'unit_price', 500),
    jsonb_build_object('product_id', v_bulk, 'qty', 10, 'unit_price', 20),
    jsonb_build_object('product_id', v_unk,  'qty', 3,  'unit_price', 30)), NULL, NULL, NULL, NULL, v_rep, v_rep);
  PERFORM pg_temp.as_owner();
  UPDATE public.sales_orders SET status = 'sent' WHERE id = v_so.id;
  v_out := pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so.id, v_mgr));
  PERFORM pg_temp.as_user(v_mgr);
  v_d := public.create_delivery(v_so.id, (
    SELECT jsonb_agg(jsonb_build_object('sales_order_line_id', id, 'qty', qty)) FROM public.sales_order_lines WHERE sales_order_id = v_so.id), NULL, v_mgr);
  v_d := public.confirm_delivery(v_d.id, v_mgr);
  v_inv := public.create_invoice_from_delivery(v_d.id, v_mgr);
  PERFORM pg_temp.as_owner();
  SELECT id INTO v_dl_ser FROM public.delivery_lines WHERE delivery_id = v_d.id AND product_id = v_ser;
  SELECT id INTO v_dl_blk FROM public.delivery_lines WHERE delivery_id = v_d.id AND product_id = v_bulk;
  SELECT id INTO v_dl_unk FROM public.delivery_lines WHERE delivery_id = v_d.id AND product_id = v_unk;
  SELECT unit_id INTO v_u1 FROM public.delivery_line_units WHERE delivery_line_id = v_dl_ser ORDER BY unit_cost_base, unit_id LIMIT 1;
  SELECT unit_id INTO v_u2 FROM public.delivery_line_units WHERE delivery_line_id = v_dl_ser AND unit_id <> v_u1;
  SELECT id INTO v_u3 FROM public.inventory_units WHERE product_id = v_ser AND id NOT IN (v_u1, v_u2);
  PERFORM pg_temp.check('fixture: order delivered in full, invoice drafted, one router still in stock',
    v_out = 'ok' AND v_d.status = 'confirmed' AND v_u1 IS NOT NULL AND v_u2 IS NOT NULL AND v_u3 IS NOT NULL, '-> ' || v_out);

  -- ══ 1. who and when ═══════════════════════════════════════════════════════
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_customer_return(%L, %L::jsonb, NULL, %L)$q$, v_d.id,
    jsonb_build_array(jsonb_build_object('delivery_line_id', v_dl_blk, 'qty', 1, 'warehouse_id', v_wh))::text, v_mgr));
  PERFORM pg_temp.check('goods first means the invoice first: no return before it is posted', v_out LIKE 'err:P0001%no posted invoice%', '-> ' || v_out);
  PERFORM pg_temp.as_user(v_mgr);
  PERFORM public.post_invoice(v_inv, v_mgr);
  PERFORM pg_temp.as_owner();
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_customer_return(%L, %L::jsonb, NULL, %L)$q$, v_d.id,
    jsonb_build_array(jsonb_build_object('delivery_line_id', v_dl_blk, 'qty', 1, 'warehouse_id', v_wh))::text, v_rep));
  PERFORM pg_temp.check('a sales rep cannot record a return (managers and above)', v_out LIKE 'err:42501%permission to take customer returns%', '-> ' || v_out);

  -- ══ 2. what may come back ═════════════════════════════════════════════════
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_customer_return(%L, %L::jsonb, NULL, %L)$q$, v_d.id,
    jsonb_build_array(jsonb_build_object('delivery_line_id', v_dl_blk, 'qty', 1, 'warehouse_id', v_scrap))::text, v_mgr));
  PERFORM pg_temp.check('back to stock only: a system location is refused', v_out LIKE 'err:P0001%sellable warehouse%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_customer_return(%L, %L::jsonb, NULL, %L)$q$, v_d.id,
    jsonb_build_array(jsonb_build_object('delivery_line_id', v_dl_ser, 'unit_ids', jsonb_build_array(v_u3), 'warehouse_id', v_wh))::text, v_mgr));
  PERFORM pg_temp.check('a unit that did not leave on this line is refused', v_out LIKE 'err:P0001%did not leave on this delivery line%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_customer_return(%L, %L::jsonb, NULL, %L)$q$, v_d.id,
    jsonb_build_array(jsonb_build_object('delivery_line_id', v_dl_blk, 'qty', '1e3', 'warehouse_id', v_wh))::text, v_mgr));
  PERFORM pg_temp.check('a quantity must be a whole number ("1e3")', v_out LIKE 'err:P0001%whole number%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_customer_return(%L, %L::jsonb, NULL, %L)$q$, v_d.id,
    jsonb_build_array(jsonb_build_object('delivery_line_id', v_dl_blk, 'qty', 11, 'warehouse_id', v_wh))::text, v_mgr));
  PERFORM pg_temp.check('never more than left on the delivery (11 of 10)', v_out LIKE 'err:P0001%10 left on this delivery%', '-> ' || v_out);

  -- ══ 3. a draft, and what it holds ═════════════════════════════════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_r1 := public.create_customer_return(v_d.id, jsonb_build_array(
    jsonb_build_object('delivery_line_id', v_dl_ser, 'unit_ids', jsonb_build_array(v_u1), 'warehouse_id', v_wh),
    jsonb_build_object('delivery_line_id', v_dl_blk, 'qty', 4, 'warehouse_id', v_wh),
    jsonb_build_object('delivery_line_id', v_dl_unk, 'qty', 1, 'warehouse_id', v_wh)),
    '{"reason":"Wrong colour"}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('a draft: no code, nothing back in stock yet',
    v_r1.status = 'draft' AND v_r1.return_code IS NULL AND v_r1.customer_id = v_cust
    AND (SELECT reservation_status = 'delivered' FROM public.inventory_units WHERE id = v_u1)
    AND (SELECT quantity FROM public.warehouse_stock WHERE id = v_ws) = 10);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_customer_return(%L, %L::jsonb, NULL, %L)$q$, v_d.id,
    jsonb_build_array(jsonb_build_object('delivery_line_id', v_dl_ser, 'unit_ids', jsonb_build_array(v_u1), 'warehouse_id', v_wh))::text, v_mgr));
  PERFORM pg_temp.check('a unit on a draft return cannot be claimed twice', v_out LIKE 'err:P0001%already come back (or is on another draft%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_customer_return(%L, %L::jsonb, NULL, %L)$q$, v_d.id,
    jsonb_build_array(jsonb_build_object('delivery_line_id', v_dl_blk, 'qty', 7, 'warehouse_id', v_wh))::text, v_mgr));
  PERFORM pg_temp.check('drafts hold their quantity (4 drafted + 7 > 10)', v_out LIKE 'err:P0001%already came back or are on a draft%', '-> ' || v_out);

  -- ══ 4. confirming brings the goods back at their cost ═════════════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_r1 := public.confirm_customer_return(v_r1.id, v_mgr);
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('confirmed with an RTN- code', v_r1.status = 'confirmed' AND v_r1.return_code LIKE 'RTN-%', '-> ' || COALESCE(v_r1.return_code, 'null'));
  PERFORM pg_temp.check('the router is available again, in the chosen warehouse, at its own cost',
    (SELECT status = 'company_stock' AND reservation_status = 'available' AND warehouse_id = v_wh AND unit_cost_base = 100
       FROM public.inventory_units WHERE id = v_u1));
  PERFORM pg_temp.check('the cables are back in the bin at the delivery''s cost (10 + 4, value 500 + 200)',
    (SELECT quantity = 14 AND total_cost_base = 700 AND uncosted_quantity = 0 FROM public.warehouse_stock WHERE id = v_ws),
    '-> ' || (SELECT quantity || '/' || total_cost_base FROM public.warehouse_stock WHERE id = v_ws));
  PERFORM pg_temp.check('an adapter of unknown cost comes back uncosted, never at 0',
    (SELECT quantity = 3 AND uncosted_quantity = 3 AND total_cost_base = 0 FROM public.warehouse_stock WHERE id = v_wsu),
    '-> ' || (SELECT quantity || '/' || uncosted_quantity || '/' || total_cost_base FROM public.warehouse_stock WHERE id = v_wsu));
  PERFORM pg_temp.check('each line records the cost it came back at',
    (SELECT string_agg(COALESCE(cost_base::text, '-') || ':' || cost_unknown_qty, ',' ORDER BY line_no)
       FROM public.customer_return_lines WHERE customer_return_id = v_r1.id) = '100.00:0,200.00:0,0.00:1',
    '-> ' || (SELECT string_agg(COALESCE(cost_base::text, '-') || ':' || cost_unknown_qty, ',' ORDER BY line_no)
       FROM public.customer_return_lines WHERE customer_return_id = v_r1.id));
  PERFORM pg_temp.check('every move is on the ledger under the return',
    (SELECT count(*) FROM public.stock_moves WHERE doc_type = 'customer_return' AND doc_id = v_r1.id AND move_type = 'restore') = 3);

  v_out := pg_temp.call(v_mgr, format('SELECT public.confirm_customer_return(%L, %L)', v_r1.id, v_mgr));
  PERFORM pg_temp.check('confirmed once', v_out LIKE 'err:P0001%already confirmed%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('SELECT public.cancel_customer_return(%L, %L)', v_r1.id, v_mgr));
  PERFORM pg_temp.check('a confirmed return cannot be cancelled', v_out LIKE 'err:P0001%cannot be cancelled%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_customer_return(%L, %L::jsonb, NULL, %L)$q$, v_d.id,
    jsonb_build_array(jsonb_build_object('delivery_line_id', v_dl_ser, 'unit_ids', jsonb_build_array(v_u1), 'warehouse_id', v_wh))::text, v_mgr));
  PERFORM pg_temp.check('a unit that came back cannot come back again', v_out LIKE 'err:P0001%already come back%', '-> ' || v_out);

  -- ══ 5. drafts, cancelling, a unit gone to repair ══════════════════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_r := public.create_customer_return(v_d.id, jsonb_build_array(
    jsonb_build_object('delivery_line_id', v_dl_blk, 'qty', 6, 'warehouse_id', v_wh2)), NULL, v_mgr);
  v_r := public.cancel_customer_return(v_r.id, v_mgr);
  v_r := public.create_customer_return(v_d.id, jsonb_build_array(
    jsonb_build_object('delivery_line_id', v_dl_blk, 'qty', 6, 'warehouse_id', v_wh2)), NULL, v_mgr);
  v_r := public.confirm_customer_return(v_r.id, v_mgr);
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('a cancelled draft frees its quantity; the rest comes back into a new branch bin',
    v_r.status = 'confirmed'
    AND (SELECT quantity = 6 AND total_cost_base = 300 FROM public.warehouse_stock WHERE product_id = v_bulk AND warehouse_id = v_wh2));

  PERFORM pg_temp.as_user(v_mgr);
  v_r := public.create_customer_return(v_d.id, jsonb_build_array(
    jsonb_build_object('delivery_line_id', v_dl_ser, 'unit_ids', jsonb_build_array(v_u2), 'warehouse_id', v_wh)), NULL, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.inventory_units SET status = 'active_rma' WHERE id = v_u2;   -- sent in for repair meanwhile
  v_out := pg_temp.call(v_mgr, format('SELECT public.confirm_customer_return(%L, %L)', v_r.id, v_mgr));
  PERFORM pg_temp.check('a unit now on an RMA ticket is not taken back as a return', v_out LIKE 'err:P0001%no longer with the customer%', '-> ' || v_out);

  -- ══ 6. a delivery with a return is credited, not voided or re-invoiced ════
  v_out := pg_temp.call(v_mgr, format('SELECT public.void_invoice(%L, %L, %L)', v_inv, 'test', v_mgr));
  PERFORM pg_temp.check('its invoice cannot be voided', v_out LIKE 'err:P0001%credit it with a credit note%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('SELECT public.create_invoice_from_delivery(%L, %L)', v_d.id, v_mgr));
  PERFORM pg_temp.check('the delivery cannot be invoiced again', v_out LIKE 'err:P0001%cannot be invoiced again%', '-> ' || v_out);

  -- ══ 7. only through the RPCs ══════════════════════════════════════════════
  v_out := pg_temp.call(v_mgr, format('INSERT INTO public.customer_returns (delivery_id, sales_order_id, customer_id, created_by) VALUES (%L, %L, %L, %L)',
    v_d.id, v_so.id, v_cust, v_mgr));
  PERFORM pg_temp.check('no direct writes', v_out LIKE 'err:42501%', '-> ' || v_out);
  PERFORM pg_temp.check('anon runs none of it',
    NOT has_function_privilege('anon', 'public.create_customer_return(uuid, jsonb, jsonb, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.confirm_customer_return(uuid, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._rma_warehouse_is_sellable(uuid)', 'EXECUTE'));
  PERFORM pg_temp.check('a sales rep reads the returns of an order they can read',
    pg_temp.call(v_rep, format('SELECT 1/(SELECT count(*)::int FROM public.customer_returns WHERE delivery_id = %L)', v_d.id)) = 'ok');

  RAISE EXCEPTION 'P05A_TEST_DONE %', current_setting('p05a.log', true);
END $do$;
