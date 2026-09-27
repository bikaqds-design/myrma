-- supabase/tests/supplier_bill_match.sql — P-04 (20260900), rolled back.
-- A supplier bill is matched against its purchase order (and the goods
-- received) before approval: over-billing is refused, a price above the order
-- or a product not on it needs a reason.
-- #  node scripts/run-sql-test.mjs supabase/tests/supplier_bill_match.sql P04_TEST_DONE

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT CASE WHEN p_ok THEN 'PASS  ' || p_label ELSE 'FAIL  ' || p_label || ' ' || COALESCE(p_detail, '') END
$f$;
CREATE FUNCTION pg_temp.call(p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  EXECUTE p_sql;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN 'err:' || SQLSTATE || ' ' || SQLERRM;
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
-- submit the way the screen does: a direct status change, with any reason
CREATE FUNCTION pg_temp.submit(p_vi uuid, p_reason text DEFAULT NULL) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.call('p04-mgr@test.local', format(
    $q$UPDATE public.vendor_invoices SET status = 'pending_approval', price_variance_reason = %L WHERE id = %L$q$, p_reason, p_vi))
$f$;
CREATE FUNCTION pg_temp.set_lines(p_vi uuid, p_lines jsonb) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.call('p04-mgr@test.local', format(
    $q$SELECT public.update_vendor_invoice(%L, %L::jsonb, NULL, 'p04-mgr@test.local')$q$, p_vi, p_lines))
$f$;
CREATE FUNCTION pg_temp.back_to_draft(p_vi uuid) RETURNS void LANGUAGE sql AS $f$
  UPDATE public.vendor_invoices SET status = 'draft' WHERE id = p_vi
$f$;

DO $do$
DECLARE
  v_mgr    text := 'p04-mgr@test.local';
  v_vendor uuid;
  v_wh     uuid := gen_random_uuid();
  p1 uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  p3 uuid := gen_random_uuid();
  v_po     public.purchase_orders;
  v_po2    public.purchase_orders;
  v_vi     public.vendor_invoices;
  v_vi2    public.vendor_invoices;
  v_out    text;
  v_m      text;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_mgr, 'manager', 'active'), ('p04-rep@test.local', 'sales_rep', 'active');
  INSERT INTO public.brands (brand_name) VALUES ('P04 Supplier') RETURNING id INTO v_vendor;
  INSERT INTO public.warehouses (id, name, code, warehouse_type) VALUES (v_wh, 'P04 WH', 'P04-WH', 'main');
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode) VALUES
    (p1, 'P04-A', 'P04 cable', 'hardware', 'bulk'),
    (p2, 'P04-B', 'P04 switch', 'hardware', 'bulk'),
    (p3, 'P04-C', 'P04 extra', 'hardware', 'bulk');
  DELETE FROM public.rma_config WHERE config_key = 'purchase_price_tolerance_pct';

  -- an order in USD: 10 cables at 5, 4 switches at 100 less 10% (net 90)
  PERFORM pg_temp.as_user(v_mgr);
  v_po := public.create_purchase_order(v_vendor, jsonb_build_array(
    jsonb_build_object('product_id', p1, 'qty_ordered', 10, 'unit_cost', 5),
    jsonb_build_object('product_id', p2, 'qty_ordered', 4, 'unit_cost', 100, 'discount_pct', 10)),
    '{"currency":"USD","exchange_rate":2}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.purchase_orders SET status = 'sent' WHERE id = v_po.id;
  UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po.id;

  -- ══ 1. the match of a bill converted from the whole order ═════════════════
  RAISE NOTICE '--- 1. match ---';
  PERFORM pg_temp.as_user(v_mgr);
  v_vi := public.convert_po_to_vendor_invoice(v_po.id, v_mgr);
  PERFORM public.update_vendor_invoice(v_vi.id, NULL, jsonb_build_object('supplier_invoice_no', 'P04-SUP-1', 'supplier_invoice_date', '2026-09-27'), v_mgr);
  SELECT string_agg(concat_ws(':', product_name, ordered_qty, billed_qty, order_unit_net, billed_unit_net, COALESCE(issue, 'ok')), ',' ORDER BY line_no)
    INTO v_m FROM public.rma_vendor_invoice_match(v_vi.id);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('an unchanged bill matches its order line by line (discount taken off)',
    v_m = 'P04 cable:10:10:5.0000:5.0000:ok,P04 switch:4:4:90.0000:90.0000:ok', '-> ' || COALESCE(v_m, 'NULL'));
  v_out := pg_temp.call('p04-rep@test.local', format('SELECT * FROM public.rma_vendor_invoice_match(%L)', v_vi.id));
  RAISE NOTICE '%', pg_temp.check('a sales rep cannot see purchase prices', v_out LIKE 'err:P0001%Not authorized%', '-> ' || v_out);

  -- ══ 2. over-billing ═══════════════════════════════════════════════════════
  RAISE NOTICE '--- 2. quantities ---';
  v_out := pg_temp.set_lines(v_vi.id, jsonb_build_array(
    jsonb_build_object('product_id', p1, 'qty_ordered', 12, 'qty_received', 0, 'unit_cost', 5),
    jsonb_build_object('product_id', p2, 'qty_ordered', 4, 'qty_received', 0, 'unit_cost', 100, 'discount_pct', 10)));
  v_out := pg_temp.submit(v_vi.id, 'a reason that is long enough');
  RAISE NOTICE '%', pg_temp.check('billing more than was ordered is refused, reason or not',
    v_out LIKE 'err:P0001%more than was ordered or received: P04 cable (billed 12, ordered 10)%', '-> ' || v_out);

  -- ══ 3. prices ═════════════════════════════════════════════════════════════
  RAISE NOTICE '--- 3. prices ---';
  v_out := pg_temp.set_lines(v_vi.id, jsonb_build_array(
    jsonb_build_object('product_id', p1, 'qty_ordered', 10, 'qty_received', 0, 'unit_cost', 5.2),
    jsonb_build_object('product_id', p2, 'qty_ordered', 4, 'qty_received', 0, 'unit_cost', 100, 'discount_pct', 10)));
  v_out := pg_temp.submit(v_vi.id);
  RAISE NOTICE '%', pg_temp.check('a price above the order (+4%) needs a reason',
    v_out LIKE 'err:P0001%does not match its purchase order: P04 cable at 5.2000 against 5.0000 on the order (+4.00%)%', '-> ' || v_out);
  v_out := pg_temp.submit(v_vi.id, 'too short');
  RAISE NOTICE '%', pg_temp.check('... of at least 10 characters', v_out LIKE 'err:P0001%does not match%', '-> ' || v_out);
  v_out := pg_temp.submit(v_vi.id, '  Copper surcharge agreed by phone  ');
  RAISE NOTICE '%', pg_temp.check('with a reason it is submitted, and the reason is kept for the approver',
    v_out = 'ok' AND (SELECT status = 'pending_approval' AND price_variance_reason = 'Copper surcharge agreed by phone' FROM public.vendor_invoices WHERE id = v_vi.id),
    '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.vendor_invoices SET price_variance_reason = 'rewritten after the request' WHERE id = %L$q$, v_vi.id));
  RAISE NOTICE '%', pg_temp.check('the reason cannot be rewritten once the bill waits for approval', v_out LIKE 'err:P0001%given when the bill is submitted%', '-> ' || v_out);

  PERFORM pg_temp.back_to_draft(v_vi.id);
  INSERT INTO public.rma_config (config_key, config_value) VALUES ('purchase_price_tolerance_pct', to_jsonb('5'::text));
  UPDATE public.vendor_invoices SET price_variance_reason = NULL WHERE id = v_vi.id;
  v_out := pg_temp.submit(v_vi.id);
  RAISE NOTICE '%', pg_temp.check('within the tenant''s tolerance (5%) no reason is needed', v_out = 'ok', '-> ' || v_out);

  PERFORM pg_temp.back_to_draft(v_vi.id);
  v_out := pg_temp.set_lines(v_vi.id, jsonb_build_array(
    jsonb_build_object('product_id', p1, 'qty_ordered', 10, 'qty_received', 0, 'unit_cost', 5),
    jsonb_build_object('product_id', p2, 'qty_ordered', 4, 'qty_received', 0, 'unit_cost', 100, 'discount_pct', 10),
    jsonb_build_object('product_id', p3, 'qty_ordered', 1, 'qty_received', 0, 'unit_cost', 20)));
  v_out := pg_temp.submit(v_vi.id);
  RAISE NOTICE '%', pg_temp.check('a product not on the order needs a reason', v_out LIKE 'err:P0001%P04 extra is not on the order%', '-> ' || v_out);
  UPDATE public.rma_config SET config_value = to_jsonb('five'::text) WHERE config_key = 'purchase_price_tolerance_pct';
  PERFORM pg_temp.as_user(v_mgr);
  RAISE NOTICE '%', pg_temp.check('a tolerance that is not a number counts as none', public.rma_purchase_price_tolerance_pct() = 0);
  PERFORM pg_temp.as_owner();

  -- ══ 4. a bill from goods receipts ═════════════════════════════════════════
  RAISE NOTICE '--- 4. receipts ---';
  PERFORM pg_temp.as_user(v_mgr);
  v_po2 := public.create_purchase_order(v_vendor, jsonb_build_array(
    jsonb_build_object('product_id', p1, 'qty_ordered', 8, 'unit_cost', 5)), '{"currency":"USD","exchange_rate":2}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.purchase_orders SET status = 'sent' WHERE id = v_po2.id;
  UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po2.id;
  PERFORM pg_temp.as_user(v_mgr);
  PERFORM public.confirm_goods_receipt((public.create_goods_receipt(v_po2.id, jsonb_build_array(jsonb_build_object(
    'purchase_order_line_id', (SELECT id FROM public.purchase_order_lines WHERE purchase_order_id = v_po2.id), 'qty', '6', 'warehouse_id', v_wh)), NULL, v_mgr)).id, v_mgr);
  v_vi2 := public.create_vendor_invoice_from_receipts(v_po2.id, NULL, v_mgr);
  PERFORM public.update_vendor_invoice(v_vi2.id, jsonb_build_array(
    jsonb_build_object('product_id', p1, 'qty_ordered', 6, 'qty_received', 6, 'unit_cost', 6)),
    jsonb_build_object('supplier_invoice_no', 'P04-SUP-2', 'supplier_invoice_date', '2026-09-27'), v_mgr);
  SELECT string_agg(concat_ws(':', ordered_qty, received_qty, billed_qty, price_diff_pct, COALESCE(issue, 'ok')), ',') INTO v_m
    FROM public.rma_vendor_invoice_match(v_vi2.id);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a bill from receipts reports what arrived and the price against the order line',
    v_m = '8:6:6:20.00:price_above', '-> ' || COALESCE(v_m, 'NULL'));
  v_out := pg_temp.submit(v_vi2.id);
  RAISE NOTICE '%', pg_temp.check('... and needs a reason for the higher price', v_out LIKE 'err:P0001%does not match its purchase order%', '-> ' || v_out);

  RAISE EXCEPTION 'P04_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
