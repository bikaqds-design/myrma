-- ############################################################################
-- #  A RETURN'S CREDIT NOTE — P-05b (20260903)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/return_credit_notes.sql P05B_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI. The final
-- #  error message also carries every PASS/FAIL line, for runners that do not
-- #  show notices.
-- ############################################################################

SELECT set_config('p05b.log', '', false);
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE l text := format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, CASE WHEN p_ok THEN '' ELSE p_detail END);
BEGIN
  PERFORM set_config('p05b.log', COALESCE(current_setting('p05b.log', true), '') || E'\n' || l, false);
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
  v_mgr    text := 'p05b-mgr@test.local';
  v_rep    text := 'p05b-rep@test.local';
  v_cust   uuid;
  v_wh     uuid := gen_random_uuid();
  v_ser    uuid := gen_random_uuid();
  v_bulk   uuid := gen_random_uuid();
  v_ws     uuid := gen_random_uuid();
  v_so     public.sales_orders;
  v_d      public.deliveries;
  v_r      public.customer_returns;
  v_r2     public.customer_returns;
  v_cn     public.credit_notes;
  v_dl_ser uuid;
  v_dl_blk uuid;
  v_inv    uuid;
  v_u1     uuid;
  v_out    text;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_mgr, 'manager', 'active'), (v_rep, 'sales_rep', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('P05b Co', 'P05B-C1', 'B2B') RETURNING id INTO v_cust;
  INSERT INTO public.warehouses (id, name, code, warehouse_type) VALUES (v_wh, 'P05b WH', 'P05B-WH', 'main');
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode) VALUES
    (v_ser,  'P05B-SER', 'P05b router', 'hardware', 'serialized'),
    (v_bulk, 'P05B-BLK', 'P05b cable',  'hardware', 'bulk');
  INSERT INTO public.inventory_units (product_id, product_name, serial_number, status, reservation_status, warehouse_id, unit_cost_base)
  VALUES (v_ser, 'P05b router', 'P05B-SN1', 'company_stock', 'available', v_wh, 100),
         (v_ser, 'P05b router', 'P05B-SN2', 'company_stock', 'available', v_wh, 100);
  INSERT INTO public.warehouse_stock (id, product_id, warehouse_id, quantity, reserved_quantity, total_cost_base, uncosted_quantity)
  VALUES (v_ws, v_bulk, v_wh, 20, 0, 1000, 0);

  -- 2 routers at 500, 10 cables at 20 less 10%; all delivered, invoiced, posted
  PERFORM pg_temp.as_user(v_rep);
  v_so := public.create_sales_order(v_cust, jsonb_build_array(
    jsonb_build_object('product_id', v_ser,  'qty', 2,  'unit_price', 500),
    jsonb_build_object('product_id', v_bulk, 'qty', 10, 'unit_price', 20, 'discount_pct', 10)), NULL, NULL, NULL, NULL, v_rep, v_rep);
  PERFORM pg_temp.as_owner();
  UPDATE public.sales_orders SET status = 'sent' WHERE id = v_so.id;
  v_out := pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so.id, v_mgr));
  PERFORM pg_temp.as_user(v_mgr);
  v_d := public.create_delivery(v_so.id, (
    SELECT jsonb_agg(jsonb_build_object('sales_order_line_id', id, 'qty', qty)) FROM public.sales_order_lines WHERE sales_order_id = v_so.id), NULL, v_mgr);
  v_d := public.confirm_delivery(v_d.id, v_mgr);
  v_inv := public.create_invoice_from_delivery(v_d.id, v_mgr);
  PERFORM public.post_invoice(v_inv, v_mgr);
  PERFORM pg_temp.as_owner();
  SELECT id INTO v_dl_ser FROM public.delivery_lines WHERE delivery_id = v_d.id AND product_id = v_ser;
  SELECT id INTO v_dl_blk FROM public.delivery_lines WHERE delivery_id = v_d.id AND product_id = v_bulk;
  SELECT unit_id INTO v_u1 FROM public.delivery_line_units WHERE delivery_line_id = v_dl_ser ORDER BY unit_id LIMIT 1;

  -- one router and 4 cables come back
  PERFORM pg_temp.as_user(v_mgr);
  v_r := public.create_customer_return(v_d.id, jsonb_build_array(
    jsonb_build_object('delivery_line_id', v_dl_ser, 'unit_ids', jsonb_build_array(v_u1), 'warehouse_id', v_wh),
    jsonb_build_object('delivery_line_id', v_dl_blk, 'qty', 4, 'warehouse_id', v_wh)), '{"reason":"Wrong model"}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('fixture: invoice posted (1180), a draft return',
    v_out = 'ok' AND (SELECT doc_status = 'posted' AND total = 1180 FROM public.crm_invoices WHERE id = v_inv) AND v_r.status = 'draft',
    '-> ' || v_out || ' / ' || (SELECT doc_status || ' ' || total FROM public.crm_invoices WHERE id = v_inv));

  -- ══ 1. goods first ════════════════════════════════════════════════════════
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_credit_note('rma_return', %L, 'Came back', 'return', %L::jsonb, %L, NULL, NULL, %L)$q$,
    v_cust, jsonb_build_array(jsonb_build_object('product_id', v_ser, 'qty', 1, 'unit_price', 500))::text, v_inv, v_mgr));
  PERFORM pg_temp.check('a return credit note on a delivery invoice cannot be typed in by hand', v_out LIKE 'err:P0001%come back by a return%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_credit_note('correction', %L, 'Priced wrongly', 'price_adjustment', %L::jsonb, %L, NULL, NULL, %L)$q$,
    v_cust, jsonb_build_array(jsonb_build_object('product_name', 'Price correction', 'qty', 1, 'unit_price', 10))::text, v_inv, v_mgr));
  PERFORM pg_temp.check('a price correction on the same invoice is unchanged', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('SELECT public.create_credit_note_from_return(%L, %L)', v_r.id, v_mgr));
  PERFORM pg_temp.check('a draft return is not credited', v_out LIKE 'err:P0001%Only a confirmed return%', '-> ' || v_out);
  PERFORM pg_temp.as_user(v_mgr);
  v_r := public.confirm_customer_return(v_r.id, v_mgr);
  PERFORM pg_temp.as_owner();
  v_out := pg_temp.call(v_rep, format('SELECT public.create_credit_note_from_return(%L, %L)', v_r.id, v_rep));
  PERFORM pg_temp.check('a sales rep cannot credit a return (managers and above)', v_out LIKE 'err:42501%permission to take customer returns%', '-> ' || v_out);

  -- ══ 2. the note is what came back ═════════════════════════════════════════
  PERFORM pg_temp.as_user(v_mgr);
  v_cn := public.create_credit_note_from_return(v_r.id, v_mgr);
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('a draft rma_return note against the delivery''s invoice, reason code return, linked to the return',
    v_cn.status = 'draft' AND v_cn.type = 'rma_return' AND v_cn.source_invoice_id = v_inv AND v_cn.reason_code = 'return'
    AND v_cn.customer_return_id = v_r.id AND v_cn.reason LIKE 'Wrong model (RTN-%');
  PERFORM pg_temp.check('its lines are the returned quantities at the invoiced price (500 + 4 x 18 = 572)',
    v_cn.total = 572
    AND (SELECT string_agg(product_id::text || ':' || qty, ',' ORDER BY line_no) FROM public.credit_note_lines WHERE credit_note_id = v_cn.id)
        = v_ser::text || ':1,' || v_bulk::text || ':4',
    '-> ' || v_cn.total);
  PERFORM pg_temp.check('the goods are already back: restocked, no line asks for a restock',
    v_cn.restock_status = 'restocked' AND NOT EXISTS (SELECT 1 FROM public.credit_note_lines WHERE credit_note_id = v_cn.id AND restock));
  v_out := pg_temp.call(v_mgr, format('SELECT public.create_credit_note_from_return(%L, %L)', v_r.id, v_mgr));
  PERFORM pg_temp.check('one live credit note per return', v_out LIKE 'err:P0001%already has a credit note%', '-> ' || v_out);

  -- ══ 3. its lines stay the return's ════════════════════════════════════════
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.update_credit_note(%L, %L::jsonb, NULL, %L)$q$, v_cn.id,
    jsonb_build_array(jsonb_build_object('product_id', v_ser, 'qty', 2, 'unit_price', 500))::text, v_mgr));
  PERFORM pg_temp.check('its lines cannot be changed', v_out LIKE 'err:P0001%lines are what came back%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.update_credit_note(%L, NULL, '{"reason":"Wrong model, customer changed mind"}'::jsonb, %L)$q$, v_cn.id, v_mgr));
  PERFORM pg_temp.check('its reason can', v_out = 'ok' AND (SELECT total = 572 FROM public.credit_notes WHERE id = v_cn.id), '-> ' || v_out);

  -- ══ 4. issuing it credits the invoice ═════════════════════════════════════
  v_out := pg_temp.call(v_mgr, format('SELECT public.issue_credit_note(%L, %L)', v_cn.id, v_mgr));
  PERFORM pg_temp.check('issued through the usual step, with a CN- number',
    v_out = 'ok' AND (SELECT status IN ('issued', 'applied') AND cn_code LIKE 'CN-%' FROM public.credit_notes WHERE id = v_cn.id), '-> ' || v_out);
  PERFORM pg_temp.check('the invoice is credited 572',
    (SELECT COALESCE(sum(amount_applied), 0) FROM public.credit_note_applications WHERE credit_note_id = v_cn.id AND invoice_id = v_inv) = 572,
    '-> ' || (SELECT COALESCE(sum(amount_applied), 0) FROM public.credit_note_applications WHERE credit_note_id = v_cn.id));

  -- ══ 5. a voided note frees the return ═════════════════════════════════════
  v_out := pg_temp.call(v_mgr, format('SELECT public.void_credit_note(%L, %L, %L)', v_cn.id, 'Issued to the wrong contact', v_mgr));
  v_out := v_out || '|' || pg_temp.call(v_mgr, format('SELECT public.create_credit_note_from_return(%L, %L)', v_r.id, v_mgr));
  PERFORM pg_temp.check('after a void the return can be credited again', v_out = 'ok|ok', '-> ' || v_out);

  -- ══ 6. a second return of the rest: its own note, capped by what was sold ═
  PERFORM pg_temp.as_user(v_mgr);
  v_r2 := public.create_customer_return(v_d.id, jsonb_build_array(
    jsonb_build_object('delivery_line_id', v_dl_blk, 'qty', 6, 'warehouse_id', v_wh)), NULL, v_mgr);
  v_r2 := public.confirm_customer_return(v_r2.id, v_mgr);
  v_cn := public.create_credit_note_from_return(v_r2.id, v_mgr);
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.check('a second return gets its own note (6 x 18 = 108)', v_cn.total = 108 AND v_cn.customer_return_id = v_r2.id, '-> ' || v_cn.total);

  PERFORM pg_temp.check('anon cannot credit a return',
    NOT has_function_privilege('anon', 'public.create_credit_note_from_return(uuid, text)', 'EXECUTE'));
  PERFORM pg_temp.check('a client cannot link a note to a return by hand',
    pg_temp.call(v_mgr, format('UPDATE public.credit_notes SET customer_return_id = NULL WHERE id = %L', v_cn.id)) LIKE 'err:%');

  RAISE EXCEPTION 'P05B_TEST_DONE %', current_setting('p05b.log', true);
END $do$;
