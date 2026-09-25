-- ############################################################################
-- #  GOODS RECEIPTS — P-03a (20260897)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/goods_receipts.sql P03_TEST_DONE
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
-- a PO line as the RPC expects it
CREATE FUNCTION pg_temp.gr_line(p_line uuid, p_qty text, p_wh uuid, p_serials jsonb DEFAULT '[]') RETURNS jsonb
LANGUAGE sql AS $f$ SELECT jsonb_build_object('purchase_order_line_id', p_line, 'qty', p_qty, 'warehouse_id', p_wh, 'serials', p_serials) $f$;

DO $do$
DECLARE
  v_mgr   text := 'p03-mgr@test.local';
  v_rep   text := 'p03-rep@test.local';
  v_vendor uuid;
  v_wh    uuid := gen_random_uuid();
  v_sys   uuid;
  v_ser   uuid := gen_random_uuid();
  v_bulk  uuid := gen_random_uuid();
  v_svc   uuid := gen_random_uuid();
  v_po    public.purchase_orders;
  v_po2   public.purchase_orders;
  v_po3   public.purchase_orders;
  v_l_ser uuid;
  v_l_blk uuid;
  v_l_svc uuid;
  v_gr    public.goods_receipts;
  v_gr2   public.goods_receipts;
  v_vi    uuid;
  v_out   text;
  v_n     numeric;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_mgr, 'manager', 'active'), (v_rep, 'sales_rep', 'active');
  INSERT INTO public.brands (brand_name) VALUES ('P03 Supplier') RETURNING id INTO v_vendor;
  INSERT INTO public.warehouses (id, name, code, warehouse_type) VALUES (v_wh, 'P03 WH', 'P03-WH', 'main');
  SELECT id INTO v_sys FROM public.warehouses WHERE is_system LIMIT 1;
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode) VALUES
    (v_ser,  'P03-SER',  'P03 router', 'hardware', 'serialized'),
    (v_bulk, 'P03-BULK', 'P03 cable',  'hardware', 'bulk'),
    (v_svc,  'P03-SVC',  'P03 install', 'service', 'serialized');

  -- a confirmed order in USD at 2.0: 3 routers at 100 less 10%, 10 cables at 5, 1 installation
  PERFORM pg_temp.as_user(v_mgr);
  v_po := public.create_purchase_order(v_vendor, jsonb_build_array(
    jsonb_build_object('product_id', v_ser,  'qty_ordered', 3,  'unit_cost', 100, 'discount_pct', 10),
    jsonb_build_object('product_id', v_bulk, 'qty_ordered', 10, 'unit_cost', 5),
    jsonb_build_object('product_id', v_svc,  'qty_ordered', 1,  'unit_cost', 50)),
    jsonb_build_object('currency', 'USD', 'exchange_rate', 2), v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.purchase_orders SET status = 'sent' WHERE id = v_po.id;
  UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po.id;
  SELECT id INTO v_l_ser FROM public.purchase_order_lines WHERE purchase_order_id = v_po.id AND product_id = v_ser;
  SELECT id INTO v_l_blk FROM public.purchase_order_lines WHERE purchase_order_id = v_po.id AND product_id = v_bulk;
  SELECT id INTO v_l_svc FROM public.purchase_order_lines WHERE purchase_order_id = v_po.id AND product_id = v_svc;

  -- ══ 1. preparing a receipt ════════════════════════════════════════════════
  RAISE NOTICE '--- 1. create_goods_receipt ---';
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_goods_receipt(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_po.id,
    jsonb_build_array(pg_temp.gr_line(v_l_blk, '1', v_wh)), v_rep));
  RAISE NOTICE '%', pg_temp.check('a sales rep cannot receive goods', v_out LIKE 'err:P0001%managers%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_goods_receipt(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_po.id,
    jsonb_build_array(pg_temp.gr_line(v_l_blk, '11', v_wh)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('more than was ordered is refused', v_out LIKE 'err:P0001%only 10 left%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_goods_receipt(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_po.id,
    jsonb_build_array(pg_temp.gr_line(v_l_blk, '1.5', v_wh)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a fractional quantity is refused', v_out LIKE 'err:P0001%whole number%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_goods_receipt(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_po.id,
    jsonb_build_array(pg_temp.gr_line(v_l_svc, '1', v_wh)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a service is not received into stock', v_out LIKE 'err:P0001%service%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_goods_receipt(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_po.id,
    jsonb_build_array(pg_temp.gr_line(v_l_blk, '1', v_sys)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('goods cannot be received into a system (RMA/scrap) location', v_out LIKE 'err:P0001%not a warehouse goods can be received into%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_goods_receipt(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_po.id,
    jsonb_build_array(pg_temp.gr_line(v_l_ser, '2', v_wh, '["P03-SN1"]')), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a serialized line needs one serial per unit', v_out LIKE 'err:P0001%need 2 serial numbers%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_goods_receipt(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_po.id,
    jsonb_build_array(pg_temp.gr_line(v_l_ser, '2', v_wh, '["P03-SN1","p03-sn1 "]')), v_mgr));
  RAISE NOTICE '%', pg_temp.check('the same serial twice is refused (case and spaces ignored)', v_out LIKE 'err:P0001%entered twice%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_goods_receipt(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_po.id,
    jsonb_build_array(pg_temp.gr_line(v_l_blk, '1', v_wh, '["X1"]')), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a bulk line takes no serials', v_out LIKE 'err:P0001%takes no serial%', '-> ' || v_out);

  PERFORM pg_temp.as_user(v_mgr);
  v_gr := public.create_goods_receipt(v_po.id, jsonb_build_array(
    pg_temp.gr_line(v_l_ser, '2', v_wh, '["P03-SN1","P03-SN2"]'),
    pg_temp.gr_line(v_l_blk, '4', v_wh)), '{"supplier_ref":"DN-778","notes":"first pallet"}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a manager prepares a receipt (draft, no code, nothing in stock yet)',
    v_gr.status = 'draft' AND v_gr.grn_code IS NULL AND v_gr.supplier_ref = 'DN-778'
    AND NOT EXISTS (SELECT 1 FROM public.inventory_units WHERE serial_number LIKE 'P03-SN%')
    AND NOT EXISTS (SELECT 1 FROM public.warehouse_stock WHERE product_id = v_bulk));
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_goods_receipt(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_po.id,
    jsonb_build_array(pg_temp.gr_line(v_l_ser, '2', v_wh, '["P03-SN8","P03-SN9"]')), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a second draft cannot claim what the first holds (3 ordered, 2 on a draft)', v_out LIKE 'err:P0001%only 1 left%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_goods_receipt(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_po.id,
    jsonb_build_array(pg_temp.gr_line(v_l_ser, '1', v_wh, '["p03-sn2"]')), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a serial already on another draft is refused', v_out LIKE 'err:P0001%already in use%', '-> ' || v_out);

  -- ══ 2. confirming: the goods arrive ═══════════════════════════════════════
  RAISE NOTICE '--- 2. confirm_goods_receipt ---';
  v_out := pg_temp.call(v_rep, format('SELECT public.confirm_goods_receipt(%L, %L)', v_gr.id, v_rep));
  RAISE NOTICE '%', pg_temp.check('a sales rep cannot confirm a receipt', v_out LIKE 'err:P0001%managers%', '-> ' || v_out);
  PERFORM pg_temp.as_user(v_mgr);
  v_gr := public.confirm_goods_receipt(v_gr.id, v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('confirmed with a GRN- code', v_gr.status = 'confirmed' AND v_gr.grn_code LIKE 'GRN-%', '-> ' || COALESCE(v_gr.grn_code, 'null'));
  RAISE NOTICE '%', pg_temp.check('2 routers are in stock, sellable, traced to the receipt, at the PO price in base (100 less 10% x 2.0 = 180)',
    (SELECT count(*) FROM public.inventory_units WHERE serial_number IN ('P03-SN1', 'P03-SN2')
       AND status = 'company_stock' AND reservation_status = 'available' AND warehouse_id = v_wh
       AND goods_receipt_id = v_gr.id AND unit_cost_base = 180) = 2);
  RAISE NOTICE '%', pg_temp.check('4 cables are in the bin at 5 x 2.0 = 10 each (total 40)',
    (SELECT quantity = 4 AND total_cost_base = 40 AND uncosted_quantity = 0 FROM public.warehouse_stock WHERE product_id = v_bulk AND warehouse_id = v_wh));
  RAISE NOTICE '%', pg_temp.check('every arrival is on the ledger under the receipt',
    (SELECT count(*) FROM public.stock_moves WHERE doc_type = 'goods_receipt' AND doc_id = v_gr.id AND move_type = 'receive') = 3);
  RAISE NOTICE '%', pg_temp.check('the receipt records its units, its bin and the cost it booked',
    (SELECT count(*) FROM public.goods_receipt_line_units u JOIN public.goods_receipt_lines l ON l.id = u.goods_receipt_line_id WHERE l.goods_receipt_id = v_gr.id) = 2
    AND (SELECT sum(b.qty) FROM public.goods_receipt_line_bins b JOIN public.goods_receipt_lines l ON l.id = b.goods_receipt_line_id WHERE l.goods_receipt_id = v_gr.id) = 4
    AND (SELECT unit_cost_base FROM public.goods_receipt_lines WHERE goods_receipt_id = v_gr.id AND product_id = v_ser) = 180);
  RAISE NOTICE '%', pg_temp.check('the order is partially completed', (SELECT status FROM public.purchase_orders WHERE id = v_po.id) = 'partially_completed');
  v_out := pg_temp.call(v_mgr, format('SELECT public.confirm_goods_receipt(%L, %L)', v_gr.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a receipt cannot be confirmed twice', v_out LIKE 'err:P0001%already confirmed%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('SELECT public.cancel_goods_receipt(%L, %L)', v_gr.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a confirmed receipt cannot be cancelled', v_out LIKE 'err:P0001%Only a draft%', '-> ' || v_out);

  -- ══ 3. the rest arrives; the order completes ═════════════════════════════
  RAISE NOTICE '--- 3. second receipt ---';
  PERFORM pg_temp.as_user(v_mgr);
  v_gr2 := public.create_goods_receipt(v_po.id, jsonb_build_array(
    pg_temp.gr_line(v_l_ser, '1', v_wh, '["P03-SN3"]'),
    pg_temp.gr_line(v_l_blk, '6', v_wh)), NULL, v_mgr);
  v_gr2 := public.confirm_goods_receipt(v_gr2.id, v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('the second receipt gets the next GRN- number', v_gr2.grn_code > v_gr.grn_code, '-> ' || v_gr2.grn_code);
  RAISE NOTICE '%', pg_temp.check('with every stock line in, the order is completed (the service line does not wait)',
    (SELECT status FROM public.purchase_orders WHERE id = v_po.id) = 'completed');
  RAISE NOTICE '%', pg_temp.check('the bin holds all 10 at a total of 100',
    (SELECT quantity = 10 AND total_cost_base = 100 FROM public.warehouse_stock WHERE product_id = v_bulk AND warehouse_id = v_wh));
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_goods_receipt(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_po.id,
    jsonb_build_array(pg_temp.gr_line(v_l_blk, '1', v_wh)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a completed order takes no more receipts', v_out LIKE 'err:P0001%confirmed purchase order%', '-> ' || v_out);

  -- ══ 4. the two paths never mix; no amending once receiving has started ══
  RAISE NOTICE '--- 4. exclusion ---';
  -- an order already received on its invoice gets no receipts
  PERFORM pg_temp.as_user(v_mgr);
  v_po3 := public.create_purchase_order(v_vendor, jsonb_build_array(
    jsonb_build_object('product_id', v_bulk, 'qty_ordered', 5, 'unit_cost', 5)), '{"currency":"USD","exchange_rate":2}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.purchase_orders SET status = 'sent' WHERE id = v_po3.id;
  UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po3.id;
  PERFORM pg_temp.as_user(v_mgr);
  v_vi := (public.convert_po_to_vendor_invoice(v_po3.id, v_mgr)).id;
  PERFORM pg_temp.as_owner();
  UPDATE public.vendor_invoices SET status = 'pending_approval' WHERE id = v_vi;
  UPDATE public.vendor_invoices SET status = 'approved' WHERE id = v_vi;
  PERFORM pg_temp.as_user(v_mgr);
  PERFORM public.receive_vendor_invoice(v_vi, jsonb_build_array(jsonb_build_object('product_id', v_bulk, 'warehouse_id', v_wh, 'qty', 2)), v_mgr);
  PERFORM pg_temp.as_owner();
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_goods_receipt(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_po3.id,
    jsonb_build_array(pg_temp.gr_line((SELECT id FROM public.purchase_order_lines WHERE purchase_order_id = v_po3.id), '1', v_wh)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('an order already received on its supplier invoice gets no receipts', v_out LIKE 'err:P0001%being received on its supplier invoice%', '-> ' || v_out);

  -- an order with a receipt (even a draft) is not received on its invoice, and not amended
  PERFORM pg_temp.as_user(v_mgr);
  v_po2 := public.create_purchase_order(v_vendor, jsonb_build_array(
    jsonb_build_object('product_id', v_bulk, 'qty_ordered', 5, 'unit_cost', 5)), '{"currency":"USD","exchange_rate":2}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.purchase_orders SET status = 'sent' WHERE id = v_po2.id;
  UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po2.id;
  PERFORM pg_temp.as_user(v_mgr);
  v_vi := (public.convert_po_to_vendor_invoice(v_po2.id, v_mgr)).id;
  PERFORM pg_temp.as_owner();
  UPDATE public.vendor_invoices SET status = 'pending_approval' WHERE id = v_vi;
  UPDATE public.vendor_invoices SET status = 'approved' WHERE id = v_vi;
  PERFORM pg_temp.as_user(v_mgr);
  v_gr2 := public.create_goods_receipt(v_po2.id, jsonb_build_array(
    pg_temp.gr_line((SELECT id FROM public.purchase_order_lines WHERE purchase_order_id = v_po2.id), '2', v_wh)), NULL, v_mgr);
  PERFORM pg_temp.as_owner();
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.receive_vendor_invoice(%L, %L::jsonb, %L)$q$, v_vi,
    jsonb_build_array(jsonb_build_object('product_id', v_bulk, 'warehouse_id', v_wh, 'qty', 1)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('an order received by receipts is not received again on its invoice', v_out LIKE 'err:P0001%received by goods receipts%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.amend_purchase_order(%L, %L::jsonb, %L, %L)$q$, v_po2.id,
    jsonb_build_object('payment_terms', 'Net 60'), 'Supplier asked for longer terms', v_mgr));
  RAISE NOTICE '%', pg_temp.check('an order with a receipt (even a draft) is not amended', v_out LIKE 'err:P0001%Goods have been received against it%', '-> ' || v_out);
  PERFORM pg_temp.as_user(v_mgr);
  v_gr2 := public.cancel_goods_receipt(v_gr2.id, v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a draft receipt can be cancelled; its quantity is free again', v_gr2.status = 'cancelled'
    AND public.rma_po_line_received_qty((SELECT id FROM public.purchase_order_lines WHERE purchase_order_id = v_po2.id), true) = 0);

  -- ══ 5. access ═════════════════════════════════════════════════════════════
  v_out := pg_temp.call(v_mgr, format($q$INSERT INTO public.goods_receipts (purchase_order_id, created_by) VALUES (%L, 'x')$q$, v_po.id));
  RAISE NOTICE '%', pg_temp.check('no client writes a receipt directly', v_out LIKE 'err:42501%', '-> ' || v_out);
  PERFORM pg_temp.as_user(v_rep);
  SELECT count(*) INTO v_n FROM public.goods_receipts;
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a sales rep sees no receipts (they cannot read purchase orders)', v_n = 0, '-> ' || v_n);
  RAISE NOTICE '%', pg_temp.check('anon cannot confirm a receipt',
    NOT has_function_privilege('anon', 'public.confirm_goods_receipt(uuid, text)', 'EXECUTE'));

  RAISE EXCEPTION 'P03_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
