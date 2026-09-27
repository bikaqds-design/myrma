-- ############################################################################
-- #  INVOICING WHAT WAS RECEIVED — P-03b (20260898)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/receipt_invoicing.sql P03B_TEST_DONE
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
-- (20260907) the lines of one (source, event) ledger entry as 'code:Dr|Cr amount'
CREATE FUNCTION pg_temp.entry(p_type text, p_id uuid, p_event text) RETURNS text LANGUAGE sql AS $f$
  SELECT string_agg(a.code || CASE WHEN l.debit > 0 THEN ':Dr ' || l.debit ELSE ':Cr ' || l.credit END, ' ' ORDER BY a.code, l.debit DESC)
    FROM public.journal_entries e JOIN public.journal_lines l ON l.entry_id = e.id JOIN public.gl_accounts a ON a.id = l.account_id
   WHERE e.source_type = p_type AND e.source_id = p_id AND e.event = p_event
$f$;
CREATE FUNCTION pg_temp.gr_line(p_line uuid, p_qty text, p_wh uuid, p_serials jsonb DEFAULT '[]') RETURNS jsonb
LANGUAGE sql AS $f$ SELECT jsonb_build_object('purchase_order_line_id', p_line, 'qty', p_qty, 'warehouse_id', p_wh, 'serials', p_serials) $f$;
-- a manager submits and approves a supplier invoice the way the screen does
-- (approving spend is an administrator's authority)
CREATE FUNCTION pg_temp.approve(p_mgr text, p_vi uuid, p_no text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM pg_temp.as_user(p_mgr);
  PERFORM public.update_vendor_invoice(p_vi, NULL, jsonb_build_object('supplier_invoice_no', p_no, 'supplier_invoice_date', '2026-09-25'), p_mgr);
  -- these bills price above the order on purpose; 20260900 wants a reason
  UPDATE public.vendor_invoices SET status = 'pending_approval', price_variance_reason = 'Supplier price rose after the order' WHERE id = p_vi;
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.as_user('p03b-admin@test.local');
  UPDATE public.vendor_invoices SET status = 'approved', approved_at = now() WHERE id = p_vi;
  PERFORM pg_temp.as_owner();
END $f$;

DO $do$
DECLARE
  v_mgr   text := 'p03b-mgr@test.local';
  v_rep   text := 'p03b-rep@test.local';
  v_vendor uuid;
  v_wh    uuid := gen_random_uuid();
  v_ser   uuid := gen_random_uuid();
  v_bulk  uuid := gen_random_uuid();
  v_free  uuid := gen_random_uuid();
  v_pool  uuid := gen_random_uuid();
  v_po5   public.purchase_orders;
  v_vi5   public.vendor_invoices;
  v_po    public.purchase_orders;
  v_po4   public.purchase_orders;
  v_l_ser uuid;
  v_l_blk uuid;
  v_gr1   public.goods_receipts;
  v_gr2   public.goods_receipts;
  v_gr4   public.goods_receipts;
  v_vi1   public.vendor_invoices;
  v_vi2   public.vendor_invoices;
  v_vi4   public.vendor_invoices;
  v_out   text;
  v_n     numeric;
  v_lines jsonb;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_mgr, 'manager', 'active'), (v_rep, 'sales_rep', 'active'), ('p03b-admin@test.local', 'admin', 'active');
  INSERT INTO public.brands (brand_name) VALUES ('P03b Supplier') RETURNING id INTO v_vendor;
  INSERT INTO public.warehouses (id, name, code, warehouse_type) VALUES (v_wh, 'P03b WH', 'P03B-WH', 'main');
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode) VALUES
    (v_ser,  'P03B-SER',  'P03b router', 'hardware', 'serialized'),
    (v_bulk, 'P03B-BULK', 'P03b cable',  'hardware', 'bulk'),
    (v_free, 'P03B-FREE', 'P03b bracket', 'hardware', 'bulk');

  -- an order in USD at 2.0: 3 routers at 100 (200 base), 10 cables at 5 (10 base)
  PERFORM pg_temp.as_user(v_mgr);
  v_po := public.create_purchase_order(v_vendor, jsonb_build_array(
    jsonb_build_object('product_id', v_ser,  'qty_ordered', 3,  'unit_cost', 100),
    jsonb_build_object('product_id', v_bulk, 'qty_ordered', 10, 'unit_cost', 5)),
    '{"currency":"USD","exchange_rate":2}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.purchase_orders SET status = 'sent' WHERE id = v_po.id;
  UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po.id;
  SELECT id INTO v_l_ser FROM public.purchase_order_lines WHERE purchase_order_id = v_po.id AND product_id = v_ser;
  SELECT id INTO v_l_blk FROM public.purchase_order_lines WHERE purchase_order_id = v_po.id AND product_id = v_bulk;

  -- two arrivals: 2 routers + 6 cables, then 1 router + 4 cables
  PERFORM pg_temp.as_user(v_mgr);
  v_gr1 := public.confirm_goods_receipt((public.create_goods_receipt(v_po.id, jsonb_build_array(
    pg_temp.gr_line(v_l_ser, '2', v_wh, '["P03B-SN1","P03B-SN2"]'), pg_temp.gr_line(v_l_blk, '6', v_wh)), NULL, v_mgr)).id, v_mgr);
  v_gr2 := public.confirm_goods_receipt((public.create_goods_receipt(v_po.id, jsonb_build_array(
    pg_temp.gr_line(v_l_ser, '1', v_wh, '["P03B-SN3"]'), pg_temp.gr_line(v_l_blk, '4', v_wh)), NULL, v_mgr)).id, v_mgr);
  PERFORM pg_temp.as_owner();
  -- router SN1 and 2 cables have since been sold and delivered
  UPDATE public.inventory_units SET reservation_status = 'delivered' WHERE serial_number = 'P03B-SN1';
  UPDATE public.warehouse_stock SET quantity = quantity - 2 WHERE product_id = v_bulk AND warehouse_id = v_wh;
  RAISE NOTICE '%', pg_temp.check('fixture: 3 routers at 200 in stock (1 sold), a bin of 8 cables worth 80',
    (SELECT count(*) FROM public.inventory_units WHERE serial_number LIKE 'P03B-SN%' AND unit_cost_base = 200) = 3
    AND (SELECT quantity = 8 AND total_cost_base = 80 FROM public.warehouse_stock WHERE product_id = v_bulk AND warehouse_id = v_wh));

  -- ══ 1. an invoice from receipts ═══════════════════════════════════════════
  RAISE NOTICE '--- 1. create_vendor_invoice_from_receipts ---';
  v_out := pg_temp.call(v_mgr, format('SELECT public.convert_po_to_vendor_invoice(%L, %L)', v_po.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a receipt-based order is not invoiced whole', v_out LIKE 'err:P0001%invoice it from its receipts%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format('SELECT public.create_vendor_invoice_from_receipts(%L, NULL, %L)', v_po.id, v_rep));
  RAISE NOTICE '%', pg_temp.check('a sales rep cannot raise one', v_out LIKE 'err:P0001%Not authorized%', '-> ' || v_out);

  PERFORM pg_temp.as_user(v_mgr);
  v_vi1 := public.create_vendor_invoice_from_receipts(v_po.id, ARRAY[v_gr1.id], v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('it bills what arrived on the first receipt, at the order''s price (2 x 100 + 6 x 5 = 230 USD)',
    v_vi1.status = 'draft' AND v_vi1.purchase_order_id = v_po.id AND v_vi1.currency = 'USD' AND v_vi1.total = 230
    AND (SELECT string_agg(product_name || ':' || qty_ordered, ',' ORDER BY line_no) FROM public.vendor_invoice_lines WHERE vendor_invoice_id = v_vi1.id) = 'P03b router:2,P03b cable:6',
    '-> ' || v_vi1.total);
  RAISE NOTICE '%', pg_temp.check('each invoice line is tied to the receipt line it bills',
    (SELECT count(*) FROM public.vendor_invoice_receipt_lines WHERE vendor_invoice_id = v_vi1.id) = 2);
  v_out := pg_temp.call(v_mgr, format('SELECT public.create_vendor_invoice_from_receipts(%L, %L::uuid[], %L)', v_po.id, ARRAY[v_gr1.id], v_mgr));
  RAISE NOTICE '%', pg_temp.check('a receipt is billed once', v_out LIKE 'err:P0001%Nothing received on this order is waiting%', '-> ' || v_out);
  PERFORM pg_temp.as_user(v_mgr);
  v_vi2 := public.create_vendor_invoice_from_receipts(v_po.id, NULL, v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a second invoice on the same order bills only what is left (the second receipt)',
    (SELECT string_agg(product_name || ':' || qty_ordered, ',' ORDER BY line_no) FROM public.vendor_invoice_lines WHERE vendor_invoice_id = v_vi2.id) = 'P03b router:1,P03b cable:4');

  -- ══ 2. the invoice bills what arrived ═════════════════════════════════════
  RAISE NOTICE '--- 2. three-way match ---';
  v_lines := jsonb_build_array(
    jsonb_build_object('product_id', v_ser,  'qty_ordered', 3, 'qty_received', 2, 'unit_cost', 100),
    jsonb_build_object('product_id', v_bulk, 'qty_ordered', 6, 'qty_received', 6, 'unit_cost', 5));
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.update_vendor_invoice(%L, %L::jsonb, NULL, %L)$q$, v_vi1.id, v_lines, v_mgr));
  RAISE NOTICE '%', pg_temp.check('its quantities cannot exceed what arrived', v_out LIKE 'err:P0001%those of the receipts%', '-> ' || v_out);
  -- the supplier billed 110 a router and 6 a cable
  v_lines := jsonb_build_array(
    jsonb_build_object('product_id', v_ser,  'qty_ordered', 2, 'qty_received', 2, 'unit_cost', 110),
    jsonb_build_object('product_id', v_bulk, 'qty_ordered', 6, 'qty_received', 6, 'unit_cost', 6));
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.update_vendor_invoice(%L, %L::jsonb, NULL, %L)$q$, v_vi1.id, v_lines, v_mgr));
  RAISE NOTICE '%', pg_temp.check('its prices can change to what the supplier billed', v_out = 'ok', '-> ' || v_out);

  -- ══ 3. approval re-costs what arrived ═════════════════════════════════════
  RAISE NOTICE '--- 3. re-costing on approval ---';
  PERFORM pg_temp.approve(v_mgr, v_vi1.id, 'SUP-INV-1');
  RAISE NOTICE '%', pg_temp.check('the invoice is approved', (SELECT status FROM public.vendor_invoices WHERE id = v_vi1.id) = 'approved');
  -- 20260899: never received itself, so it is numbered at approval
  RAISE NOTICE '%', pg_temp.check('an approved invoice from receipts has its VI- number (a draft has none)',
    (SELECT vi_code FROM public.vendor_invoices WHERE id = v_vi1.id) LIKE 'VI-%'
    AND (SELECT vi_code FROM public.vendor_invoices WHERE id = v_vi2.id) IS NULL,
    '-> ' || COALESCE((SELECT vi_code FROM public.vendor_invoices WHERE id = v_vi1.id), 'NULL'));
  RAISE NOTICE '%', pg_temp.check('the router still on hand takes the invoice cost (110 x 2.0 = 220)',
    (SELECT unit_cost_base FROM public.inventory_units WHERE serial_number = 'P03B-SN2') = 220);
  RAISE NOTICE '%', pg_temp.check('the router already sold keeps its cost; the 20 difference is a price variance',
    (SELECT unit_cost_base FROM public.inventory_units WHERE serial_number = 'P03B-SN1') = 200
    AND EXISTS (SELECT 1 FROM public.purchase_cost_adjustments WHERE vendor_invoice_id = v_vi1.id AND product_id = v_ser
                  AND kind = 'variance' AND qty = 1 AND old_unit_cost_base = 200 AND new_unit_cost_base = 220 AND amount_base = 20));
  RAISE NOTICE '%', pg_temp.check('the second receipt''s router is not touched by the first invoice',
    (SELECT unit_cost_base FROM public.inventory_units WHERE serial_number = 'P03B-SN3') = 200);
  RAISE NOTICE '%', pg_temp.check('the cable bin takes the difference for the 6 billed (80 + 6 x 2 = 92)',
    (SELECT total_cost_base FROM public.warehouse_stock WHERE product_id = v_bulk AND warehouse_id = v_wh) = 92,
    '-> ' || (SELECT total_cost_base FROM public.warehouse_stock WHERE product_id = v_bulk AND warehouse_id = v_wh));
  RAISE NOTICE '%', pg_temp.check('every change is recorded (router revalued 1, router variance 1, cables revalued 6)',
    (SELECT string_agg(kind || ':' || qty, ',' ORDER BY product_id = v_ser DESC, kind) FROM public.purchase_cost_adjustments WHERE vendor_invoice_id = v_vi1.id)
      = 'revalued:1,variance:1,revalued:6',
    '-> ' || (SELECT string_agg(kind || ':' || qty, ',' ORDER BY product_id = v_ser DESC, kind) FROM public.purchase_cost_adjustments WHERE vendor_invoice_id = v_vi1.id));
  RAISE NOTICE '%', pg_temp.check('the receipt lines now carry the invoiced cost',
    (SELECT string_agg(unit_cost_base::text, ',' ORDER BY line_no) FROM public.goods_receipt_lines WHERE goods_receipt_id = v_gr1.id) = '220.0000,12.0000');

  PERFORM pg_temp.approve(v_mgr, v_vi2.id, 'SUP-INV-2');
  RAISE NOTICE '%', pg_temp.check('an invoice at the order''s price changes nothing and records nothing',
    NOT EXISTS (SELECT 1 FROM public.purchase_cost_adjustments WHERE vendor_invoice_id = v_vi2.id)
    AND (SELECT unit_cost_base FROM public.inventory_units WHERE serial_number = 'P03B-SN3') = 200);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.receive_vendor_invoice(%L, %L::jsonb, %L)$q$, v_vi1.id,
    jsonb_build_array(jsonb_build_object('product_id', v_bulk, 'warehouse_id', v_wh, 'qty', 1)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('its goods are not received a second time on the invoice', v_out LIKE 'err:P0001%received by goods receipts%', '-> ' || v_out);

  -- ══ 4. goods booked at an unknown cost become known ═══════════════════════
  RAISE NOTICE '--- 4. unknown cost ---';
  PERFORM pg_temp.as_user(v_mgr);
  v_po4 := public.create_purchase_order(v_vendor, jsonb_build_array(
    jsonb_build_object('product_id', v_free, 'qty_ordered', 5, 'unit_cost', 0)), '{"currency":"USD","exchange_rate":2}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.purchase_orders SET status = 'sent' WHERE id = v_po4.id;
  UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po4.id;
  PERFORM pg_temp.as_user(v_mgr);
  v_gr4 := public.confirm_goods_receipt((public.create_goods_receipt(v_po4.id, jsonb_build_array(
    pg_temp.gr_line((SELECT id FROM public.purchase_order_lines WHERE purchase_order_id = v_po4.id), '5', v_wh)), NULL, v_mgr)).id, v_mgr);
  v_vi4 := public.create_vendor_invoice_from_receipts(v_po4.id, NULL, v_mgr);
  PERFORM public.update_vendor_invoice(v_vi4.id, jsonb_build_array(
    jsonb_build_object('product_id', v_free, 'qty_ordered', 5, 'qty_received', 5, 'unit_cost', 4)), NULL, v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('fixture: 5 brackets booked with unknown cost',
    (SELECT uncosted_quantity = 5 AND total_cost_base = 0 FROM public.warehouse_stock WHERE product_id = v_free AND warehouse_id = v_wh));
  PERFORM pg_temp.approve(v_mgr, v_vi4.id, 'SUP-INV-4');
  RAISE NOTICE '%', pg_temp.check('the invoice makes their cost known (5 x 4 x 2.0 = 40)',
    (SELECT uncosted_quantity = 0 AND total_cost_base = 40 FROM public.warehouse_stock WHERE product_id = v_free AND warehouse_id = v_wh)
    AND EXISTS (SELECT 1 FROM public.purchase_cost_adjustments WHERE vendor_invoice_id = v_vi4.id AND kind = 'revalued' AND qty = 5
                  AND old_unit_cost_base IS NULL AND new_unit_cost_base = 8 AND amount_base IS NULL),
    '-> ' || (SELECT uncosted_quantity || ' / ' || total_cost_base FROM public.warehouse_stock WHERE product_id = v_free AND warehouse_id = v_wh));

  -- ══ 4b. the ledger (20260907), through the real RPCs ══════════════════════
  RAISE NOTICE '--- 4b. general ledger ---';
  RAISE NOTICE '%', pg_temp.check('each receipt posts what it booked: Dr inventory / Cr goods not invoiced (460, 240)',
    pg_temp.entry('goods_receipt', v_gr1.id, 'confirmed') = '1300:Dr 460.00 2150:Cr 460.00'
    AND pg_temp.entry('goods_receipt', v_gr2.id, 'confirmed') = '1300:Dr 240.00 2150:Cr 240.00',
    '-> ' || COALESCE(pg_temp.entry('goods_receipt', v_gr1.id, 'confirmed'), 'nothing'));
  RAISE NOTICE '%', pg_temp.check('a receipt at unknown cost posts nothing',
    pg_temp.entry('goods_receipt', v_gr4.id, 'confirmed') IS NULL);
  -- 256 USD at 2.0 = 512 payable; clears 460 booked; revalues on hand (20 + 12); 20 variance
  RAISE NOTICE '%', pg_temp.check('the invoice above the order: Cr payables 512, Dr receipts 460, Dr inventory 32, Dr variance 20',
    pg_temp.entry('vendor_invoice', v_vi1.id, 'approved') = '1300:Dr 32.00 2100:Cr 512.00 2150:Dr 460.00 5200:Dr 20.00',
    '-> ' || COALESCE(pg_temp.entry('vendor_invoice', v_vi1.id, 'approved'), 'nothing'));
  RAISE NOTICE '%', pg_temp.check('the invoice at the order''s price clears exactly what it booked',
    pg_temp.entry('vendor_invoice', v_vi2.id, 'approved') = '2100:Cr 240.00 2150:Dr 240.00',
    '-> ' || COALESCE(pg_temp.entry('vendor_invoice', v_vi2.id, 'approved'), 'nothing'));
  RAISE NOTICE '%', pg_temp.check('goods booked at unknown cost go into inventory at the invoice''s (40)',
    pg_temp.entry('vendor_invoice', v_vi4.id, 'approved') = '1300:Dr 40.00 2100:Cr 40.00',
    '-> ' || COALESCE(pg_temp.entry('vendor_invoice', v_vi4.id, 'approved'), 'nothing'));
  RAISE NOTICE '%', pg_temp.check('goods received not invoiced is cleared for this vendor',
    (SELECT sum(l.debit - l.credit) FROM public.journal_lines l JOIN public.gl_accounts a ON a.id = l.account_id
      WHERE a.code = '2150' AND l.vendor_id = v_vendor) = 0);

  -- ══ 5. access ═════════════════════════════════════════════════════════════
  PERFORM pg_temp.as_user(v_rep);
  SELECT count(*) INTO v_n FROM public.purchase_cost_adjustments;
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a sales rep cannot read cost adjustments', v_n = 0, '-> ' || v_n);
  RAISE NOTICE '%', pg_temp.check('no client can run the re-costing itself',
    NOT has_function_privilege('authenticated', 'public.rma_recost_from_vendor_invoice(uuid)', 'EXECUTE'));
  v_out := pg_temp.call(v_mgr, format($q$INSERT INTO public.vendor_invoice_receipt_lines VALUES (%L, 9, %L)$q$, v_vi1.id,
    (SELECT id FROM public.goods_receipt_lines WHERE goods_receipt_id = v_gr2.id LIMIT 1)));
  RAISE NOTICE '%', pg_temp.check('no client links an invoice to a receipt directly', v_out LIKE 'err:42501%', '-> ' || v_out);

  -- ══ 6. review fixes ═══════════════════════════════════════════════════════
  RAISE NOTICE '--- 6. review fixes ---';
  -- two receipts of 5 into one bin at 10 base; 6 of the 10 are sold; one
  -- invoice bills both at 12 base. Only 4 are on hand: 4 revalued, 6 variance.
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode)
    VALUES (v_pool, 'P03B-POOL', 'P03b patch lead', 'hardware', 'bulk');
  PERFORM pg_temp.as_user(v_mgr);
  v_po5 := public.create_purchase_order(v_vendor, jsonb_build_array(
    jsonb_build_object('product_id', v_pool, 'qty_ordered', 10, 'unit_cost', 5)), '{"currency":"USD","exchange_rate":2}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.purchase_orders SET status = 'sent' WHERE id = v_po5.id;
  UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po5.id;
  PERFORM pg_temp.as_user(v_mgr);
  PERFORM public.confirm_goods_receipt((public.create_goods_receipt(v_po5.id, jsonb_build_array(
    pg_temp.gr_line((SELECT id FROM public.purchase_order_lines WHERE purchase_order_id = v_po5.id), '5', v_wh)), NULL, v_mgr)).id, v_mgr);
  PERFORM public.confirm_goods_receipt((public.create_goods_receipt(v_po5.id, jsonb_build_array(
    pg_temp.gr_line((SELECT id FROM public.purchase_order_lines WHERE purchase_order_id = v_po5.id), '5', v_wh)), NULL, v_mgr)).id, v_mgr);
  v_vi5 := public.create_vendor_invoice_from_receipts(v_po5.id, NULL, v_mgr);
  PERFORM public.update_vendor_invoice(v_vi5.id, jsonb_build_array(
    jsonb_build_object('product_id', v_pool, 'qty_ordered', 5, 'qty_received', 5, 'unit_cost', 6),
    jsonb_build_object('product_id', v_pool, 'qty_ordered', 5, 'qty_received', 5, 'unit_cost', 6)), NULL, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.warehouse_stock SET quantity = quantity - 6 WHERE product_id = v_pool AND warehouse_id = v_wh;
  RAISE NOTICE '%', pg_temp.check('fixture: a bin of 4 patch leads worth 40',
    (SELECT quantity = 4 AND total_cost_base = 40 FROM public.warehouse_stock WHERE product_id = v_pool AND warehouse_id = v_wh));
  -- a restore writes an approved invoice back as it was: it is not re-costed again
  PERFORM pg_temp.as_user(v_mgr);
  PERFORM public.update_vendor_invoice(v_vi5.id, NULL, jsonb_build_object('supplier_invoice_no', 'SUP-INV-5', 'supplier_invoice_date', '2026-09-25'), v_mgr);
  PERFORM pg_temp.as_owner();
  PERFORM set_config('rma.audit_suspended', 'on', true);
  UPDATE public.vendor_invoices SET status = 'pending_approval' WHERE id = v_vi5.id;
  UPDATE public.vendor_invoices SET status = 'approved', approved_at = now() WHERE id = v_vi5.id;
  PERFORM set_config('rma.audit_suspended', '', true);
  RAISE NOTICE '%', pg_temp.check('an approval written back by a restore is not re-costed',
    NOT EXISTS (SELECT 1 FROM public.purchase_cost_adjustments WHERE vendor_invoice_id = v_vi5.id)
    AND (SELECT total_cost_base FROM public.warehouse_stock WHERE product_id = v_pool AND warehouse_id = v_wh) = 40);
  RAISE NOTICE '%', pg_temp.check('... and posts nothing to the ledger (20260907)',
    pg_temp.entry('vendor_invoice', v_vi5.id, 'approved') IS NULL);
  -- the re-costing an approval runs
  -- (as the trigger does: the owner, with the approver's login)
  PERFORM set_config('request.jwt.claims', json_build_object('email', 'p03b-admin@test.local', 'role', 'authenticated')::text, true);
  PERFORM public.rma_recost_from_vendor_invoice(v_vi5.id);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('two receipt lines in one bin revalue its 4 units once (40 + 4 x 2 = 48)',
    (SELECT total_cost_base FROM public.warehouse_stock WHERE product_id = v_pool AND warehouse_id = v_wh) = 48,
    '-> ' || (SELECT total_cost_base FROM public.warehouse_stock WHERE product_id = v_pool AND warehouse_id = v_wh));
  RAISE NOTICE '%', pg_temp.check('the other 6 are a variance of 12, and nothing is counted twice',
    (SELECT sum(qty) FILTER (WHERE kind = 'revalued') = 4 AND sum(qty) FILTER (WHERE kind = 'variance') = 6
            AND sum(amount_base) FILTER (WHERE kind = 'variance') = 12 AND sum(amount_base) FILTER (WHERE kind = 'revalued') = 8
       FROM public.purchase_cost_adjustments WHERE vendor_invoice_id = v_vi5.id),
    '-> ' || (SELECT string_agg(kind || ':' || qty || '/' || amount_base, ',') FROM public.purchase_cost_adjustments WHERE vendor_invoice_id = v_vi5.id));

  v_out := pg_temp.call(v_mgr, format($q$INSERT INTO public.vendor_invoice_charges (vendor_invoice_id, charge_type, amount) VALUES (%L, 'freight', 50)$q$, v_vi1.id));
  RAISE NOTICE '%', pg_temp.check('freight cannot be added to an approved invoice from receipts (its cost is booked)',
    v_out LIKE 'err:P0001%cost of its goods is booked%', '-> ' || v_out);
  v_out := pg_temp.call('p03b-admin@test.local', format($q$UPDATE public.vendor_invoices SET status = 'cancelled' WHERE id = %L$q$, v_vi1.id));
  RAISE NOTICE '%', pg_temp.check('an approved invoice from receipts cannot be cancelled',
    v_out LIKE 'err:P0001%cannot be cancelled%', '-> ' || v_out);

  -- a restore writes charges back onto approved and received invoices
  PERFORM set_config('rma.audit_suspended', 'on', true);
  INSERT INTO public.vendor_invoice_charges (vendor_invoice_id, charge_type, amount) VALUES (v_vi1.id, 'freight', 50);
  PERFORM set_config('rma.audit_suspended', '', true);
  RAISE NOTICE '%', pg_temp.check('a restore can write charges back', EXISTS (SELECT 1 FROM public.vendor_invoice_charges WHERE vendor_invoice_id = v_vi1.id));

  RAISE EXCEPTION 'P03B_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
