-- ############################################################################
-- #  INVOICE FROM A DELIVERY — P-02a (20260896)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/invoice_from_delivery.sql P02_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
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
  v_mgr   text := 'p02-mgr@test.local';
  v_rep   text := 'p02-rep@test.local';
  v_rep2  text := 'p02-rep2@test.local';
  v_cust  uuid;
  v_wh    uuid := gen_random_uuid();
  v_ser   uuid := gen_random_uuid();
  v_bulk  uuid := gen_random_uuid();
  v_svc   uuid := gen_random_uuid();
  v_ws    uuid := gen_random_uuid();
  v_so    public.sales_orders;
  v_da    public.deliveries;
  v_db    public.deliveries;
  v_l_ser uuid;
  v_l_blk uuid;
  v_inv   uuid;
  v_inv2  uuid;
  v_invb  uuid;
  v_code  text;
  v_out   text;
  v_n     numeric;
  v_m     numeric;
  v_flag  boolean;
  v_unit_a uuid;
  v_unit_b uuid;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES
    (v_mgr, 'manager', 'active'), (v_rep, 'sales_rep', 'active'), (v_rep2, 'sales_rep', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('P02 Co', 'P02-C1', 'B2B') RETURNING id INTO v_cust;
  INSERT INTO public.warehouses (id, name, code, warehouse_type) VALUES (v_wh, 'P02 WH', 'P02-WH', 'main');
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode) VALUES
    (v_ser,  'P02-SER',  'P02 router', 'hardware', 'serialized'),
    (v_bulk, 'P02-BULK', 'P02 cable',  'hardware', 'bulk'),
    (v_svc,  'P02-SVC',  'P02 install', 'service', 'serialized');
  INSERT INTO public.inventory_units (product_id, product_name, serial_number, status, reservation_status, warehouse_id, unit_cost_base)
  VALUES (v_ser, 'P02 router', 'P02-SN1', 'company_stock', 'available', v_wh, 100),
         (v_ser, 'P02 router', 'P02-SN2', 'company_stock', 'available', v_wh, 100),
         (v_ser, 'P02 router', 'P02-SN3', 'company_stock', 'available', v_wh, 100);
  INSERT INTO public.warehouse_stock (id, product_id, warehouse_id, quantity, reserved_quantity, total_cost_base, uncosted_quantity)
  VALUES (v_ws, v_bulk, v_wh, 20, 0, 2000, 0);

  -- an approved order: 3 routers at 500, 10 cables at 20 less 10%, 1 installation
  PERFORM pg_temp.as_user(v_rep);
  v_so := public.create_sales_order(v_cust, jsonb_build_array(
    jsonb_build_object('product_id', v_ser,  'qty', 3,  'unit_price', 500),
    jsonb_build_object('product_id', v_bulk, 'qty', 10, 'unit_price', 20, 'discount_pct', 10),
    jsonb_build_object('product_id', v_svc,  'qty', 1,  'unit_price', 300)), NULL, NULL, NULL, NULL, v_rep, v_rep);
  PERFORM pg_temp.as_owner();
  UPDATE public.sales_orders SET status = 'sent' WHERE id = v_so.id;
  v_out := pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so.id, v_mgr));
  SELECT id INTO v_l_ser FROM public.sales_order_lines WHERE sales_order_id = v_so.id AND product_id = v_ser;
  SELECT id INTO v_l_blk FROM public.sales_order_lines WHERE sales_order_id = v_so.id AND product_id = v_bulk;

  -- delivery A ships 1 router + 4 cables; delivery B (the rest) is a draft
  PERFORM pg_temp.as_user(v_mgr);
  v_da := public.create_delivery(v_so.id, jsonb_build_array(
    jsonb_build_object('sales_order_line_id', v_l_ser, 'qty', 1),
    jsonb_build_object('sales_order_line_id', v_l_blk, 'qty', 4)), NULL, v_mgr);
  v_da := public.confirm_delivery(v_da.id, v_mgr);
  v_db := public.create_delivery(v_so.id, jsonb_build_array(
    jsonb_build_object('sales_order_line_id', v_l_ser, 'qty', 2),
    jsonb_build_object('sales_order_line_id', v_l_blk, 'qty', 6)), NULL, v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('fixture: A confirmed, B a draft', v_out = 'ok' AND v_da.status = 'confirmed' AND v_db.status = 'draft', '-> ' || v_out);

  -- ══ 1. making the invoice ═════════════════════════════════════════════════
  RAISE NOTICE '--- 1. create_invoice_from_delivery ---';
  v_out := pg_temp.call(v_mgr, format('SELECT public.create_invoice_from_delivery(%L, %L)', v_db.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a draft delivery cannot be invoiced', v_out LIKE 'err:P0001%confirmed%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep2, format('SELECT public.create_invoice_from_delivery(%L, %L)', v_da.id, v_rep2));
  RAISE NOTICE '%', pg_temp.check('another rep cannot invoice this order''s delivery', v_out LIKE 'err:P0001%Not authorized%', '-> ' || v_out);
  PERFORM pg_temp.as_user(v_rep);
  v_inv := public.create_invoice_from_delivery(v_da.id, v_rep);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('the order''s rep invoices it: what shipped, at the order''s price and discount (500 + 4 x 18 = 572)',
    (SELECT total = 572 AND so_id = v_so.id AND delivery_id = v_da.id AND doc_status = 'draft' FROM public.crm_invoices WHERE id = v_inv),
    '-> ' || (SELECT total FROM public.crm_invoices WHERE id = v_inv));
  RAISE NOTICE '%', pg_temp.check('its lines are rows, quantities from the delivery; no service line',
    (SELECT string_agg(qty::text, ',' ORDER BY line_no) FROM public.crm_invoice_lines WHERE crm_invoice_id = v_inv) = '1,4');
  v_out := pg_temp.call(v_mgr, format('SELECT public.create_invoice_from_delivery(%L, %L)', v_da.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a delivery is invoiced once', v_out LIKE 'err:P0001%already been invoiced%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('SELECT public.convert_so_to_invoice(%L, %L)', v_so.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('the order still cannot be invoiced whole', v_out LIKE 'err:P0001%deliveries%', '-> ' || v_out);

  -- ══ 2. posting it moves no stock ══════════════════════════════════════════
  RAISE NOTICE '--- 2. post_invoice ---';
  PERFORM pg_temp.as_user(v_mgr);
  v_code := public.post_invoice(v_inv, v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('posted with an INV- code', v_code LIKE 'INV-%', '-> ' || v_code);
  RAISE NOTICE '%', pg_temp.check('the rest of the order stays reserved (2 routers, 6 cables) — nothing else shipped',
    (SELECT count(*) FROM public.inventory_units WHERE reserved_by_doc_id = v_so.id AND reservation_status = 'reserved') = 2
    AND (SELECT quantity = 16 AND reserved_quantity = 6 FROM public.warehouse_stock WHERE id = v_ws),
    '-> ' || (SELECT quantity || '/' || reserved_quantity FROM public.warehouse_stock WHERE id = v_ws));
  SELECT sum(cogs_base) INTO v_n FROM public.delivery_lines WHERE delivery_id = v_da.id;
  RAISE NOTICE '%', pg_temp.check('its cost of goods is the delivery''s (100 + 4 x 100 = 500)',
    (SELECT cogs_base FROM public.crm_invoices WHERE id = v_inv) = v_n AND v_n = 500,
    '-> ' || (SELECT cogs_base FROM public.crm_invoices WHERE id = v_inv) || ' vs ' || v_n);
  PERFORM pg_temp.as_user(v_mgr);
  SELECT c.cogs_base INTO v_m FROM public.rma_invoice_cogs(v_inv) c;
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('rma_invoice_cogs reports the same', v_m = 500, '-> ' || v_m);

  -- review of 7764467: once one delivery is invoiced, the rest of the order is
  -- still watched — a lost reservation on the back-order is reported
  BEGIN
    UPDATE public.inventory_units SET reservation_status = 'available', reserved_by_doc_type = NULL, reserved_by_doc_id = NULL
     WHERE id = (SELECT id FROM public.inventory_units WHERE reserved_by_doc_id = v_so.id AND reservation_status = 'reserved' LIMIT 1);
    v_flag := EXISTS (SELECT 1 FROM public.rma_reservation_integrity() r WHERE r.entity_id = v_so.id AND r.check_name = 'confirmed_order_under_reserved');
    RAISE EXCEPTION 'undo';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  RAISE NOTICE '%', pg_temp.check('with one delivery invoiced, a lost reservation on the back-order is still reported', v_flag);
  v_out := pg_temp.call(v_rep, format('SELECT * FROM public.rma_invoice_cogs(%L)', v_inv));
  RAISE NOTICE '%', pg_temp.check('a sales rep cannot read an invoice''s cost of goods', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- ══ 3. voiding it restocks nothing; the delivery can be invoiced again ════
  RAISE NOTICE '--- 3. void_invoice ---';
  PERFORM pg_temp.as_user(v_mgr);
  PERFORM public.void_invoice(v_inv, 'wrong billing address', v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('voiding the bill leaves the stock where it is (the goods left on the delivery)',
    (SELECT quantity = 16 AND reserved_quantity = 6 FROM public.warehouse_stock WHERE id = v_ws)
    AND (SELECT count(*) FROM public.inventory_units WHERE product_id = v_ser AND reservation_status = 'delivered') = 1
    AND (SELECT count(*) FROM public.inventory_units WHERE reserved_by_doc_id = v_so.id AND reservation_status = 'reserved') = 2,
    '-> ' || (SELECT quantity || '/' || reserved_quantity FROM public.warehouse_stock WHERE id = v_ws));
  PERFORM pg_temp.as_user(v_mgr);
  v_inv2 := public.create_invoice_from_delivery(v_da.id, v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('after a void the delivery can be invoiced again', v_inv2 IS NOT NULL AND v_inv2 <> v_inv);

  -- ══ 4. the back-order ships and is billed; totals add up ═════════════════
  RAISE NOTICE '--- 4. second delivery ---';
  PERFORM pg_temp.as_user(v_mgr);
  v_db := public.confirm_delivery(v_db.id, v_mgr);
  v_invb := public.create_invoice_from_delivery(v_db.id, v_mgr);
  PERFORM public.post_invoice(v_invb, v_mgr);
  PERFORM public.post_invoice(v_inv2, v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('two live invoices on one order, one per delivery',
    (SELECT count(*) FROM public.crm_invoices WHERE so_id = v_so.id AND doc_status = 'posted') = 2);
  RAISE NOTICE '%', pg_temp.check('together they bill exactly the order''s goods (1500 + 180 = 1680)',
    (SELECT sum(total) FROM public.crm_invoices WHERE so_id = v_so.id AND doc_status = 'posted') = 1680,
    '-> ' || (SELECT sum(total) FROM public.crm_invoices WHERE so_id = v_so.id AND doc_status = 'posted'));
  RAISE NOTICE '%', pg_temp.check('and their cost of goods is what the two deliveries recorded',
    (SELECT sum(cogs_base) FROM public.crm_invoices WHERE so_id = v_so.id AND doc_status = 'posted')
      = (SELECT sum(cogs_base) FROM public.delivery_lines WHERE delivery_id IN (v_da.id, v_db.id)));
  RAISE NOTICE '%', pg_temp.check('the order is delivered and holds nothing',
    (SELECT status FROM public.sales_orders WHERE id = v_so.id) = 'delivered'
    AND (SELECT reserved_quantity FROM public.warehouse_stock WHERE id = v_ws) = 0
    AND NOT EXISTS (SELECT 1 FROM public.inventory_units WHERE reserved_by_doc_id = v_so.id AND reservation_status = 'reserved'));

  -- review of 7764467: a return against one delivery's invoice restores only
  -- units that delivery shipped
  SELECT u.unit_id INTO v_unit_a FROM public.delivery_line_units u JOIN public.delivery_lines l ON l.id = u.delivery_line_id WHERE l.delivery_id = v_da.id LIMIT 1;
  SELECT u.unit_id INTO v_unit_b FROM public.delivery_line_units u JOIN public.delivery_lines l ON l.id = u.delivery_line_id WHERE l.delivery_id = v_db.id LIMIT 1;
  v_out := pg_temp.call(v_mgr, format('SELECT public.restore_units(ARRAY[%L]::uuid[], %L, %L, %L)', v_unit_b, 'invoice', v_inv2, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a unit shipped on delivery B cannot be restored against delivery A''s invoice', v_out LIKE 'err:P0001%not delivered by this document%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('SELECT public.restore_units(ARRAY[%L]::uuid[], %L, %L, %L)', v_unit_a, 'invoice', v_inv2, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a unit shipped on delivery A can', v_out = 'ok', '-> ' || v_out);

  -- ══ 5. access ═════════════════════════════════════════════════════════════
  RAISE NOTICE '%', pg_temp.check('anon cannot invoice a delivery',
    NOT has_function_privilege('anon', 'public.create_invoice_from_delivery(uuid, text)', 'EXECUTE'));

  RAISE EXCEPTION 'P02_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
