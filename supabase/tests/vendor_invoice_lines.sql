-- ############################################################################
-- #  VENDOR INVOICE LINES — W2 / L-01, sixth document type (20260889)
-- #
-- #  HOW TO RUN:
-- #  node scripts/run-sql-test.mjs supabase/tests/vendor_invoice_lines.sql BL16_TEST_DONE
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
  v_mgr    text := 'bl16-mgr@test.local';
  v_rep    text := 'bl16-rep@test.local';
  v_tech   text := 'bl16-tech@test.local';
  v_acct   text := 'bl16-acct@test.local';
  v_v1     uuid := gen_random_uuid();
  v_p1     uuid := gen_random_uuid();
  v_p2     uuid := gen_random_uuid();
  v_wh     uuid;
  v_vi     public.vendor_invoices;
  v_po     public.purchase_orders;
  v_id     uuid;
  v_out    text;
  v_n      integer;
  v_lines  jsonb;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES (v_mgr, 'manager', 'active'), (v_rep, 'sales_rep', 'active'), (v_tech, 'technician', 'active'), (v_acct, 'accountant', 'active');
  INSERT INTO public.brands (id, brand_name) VALUES (v_v1, 'BL16 Vendor');
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode)
  VALUES (v_p1, 'BL16-P1', 'BL16 cable', 'hardware', 'bulk'), (v_p2, 'BL16-P2', 'BL16 plug', 'hardware', 'bulk');
  INSERT INTO public.warehouses (name, code, warehouse_type) VALUES ('BL16 WH', 'BL16-WH', 'main') RETURNING id INTO v_wh;
  v_lines := jsonb_build_array(
    jsonb_build_object('product_id', v_p1, 'qty_ordered', 10, 'unit_cost', 100, 'discount_pct', 10, 'tax_pct', 14),
    jsonb_build_object('product_id', v_p2, 'product_name', 'Plug (supplier name)', 'qty_ordered', 5, 'unit_cost', 200));

  -- ══ 1. create_vendor_invoice ═══════════════════════════════════════════════
  RAISE NOTICE '--- 1. create_vendor_invoice ---';
  PERFORM pg_temp.as_user(v_mgr);
  v_vi := public.create_vendor_invoice(v_v1, v_lines,
    '{"currency":"EGP","supplier_invoice_no":"  BL16-A1 ","supplier_invoice_date":"2026-09-01","notes":"first","non_po_reason":"  Stock top-up, no PO needed  "}'::jsonb, 'someone-else@test.local');
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a manager creates a draft, attributed to the login, supplier number trimmed, no VI code yet',
    v_vi.status = 'draft' AND v_vi.created_by = v_mgr AND v_vi.supplier_invoice_no = 'BL16-A1' AND v_vi.non_po_reason = 'Stock top-up, no PO needed' AND v_vi.vi_code IS NULL AND v_vi.purchase_order_id IS NULL,
    format('-> %s %s [%s]', v_vi.status, v_vi.created_by, v_vi.supplier_invoice_no));
  RAISE NOTICE '%', pg_temp.check('totals are computed in the database from the lines (2000 / 100 / 126 / 2026)',
    v_vi.subtotal = 2000 AND v_vi.discount_amount = 100 AND v_vi.tax_amount = 126 AND v_vi.total = 2026,
    format('-> %s / %s / %s / %s', v_vi.subtotal, v_vi.discount_amount, v_vi.tax_amount, v_vi.total));
  SELECT count(*) INTO v_n FROM public.vendor_invoice_lines WHERE vendor_invoice_id = v_vi.id AND qty_received = 0;
  RAISE NOTICE '%', pg_temp.check('its lines are rows with nothing received; the mirror matches (catalogue name fills a gap, a sent name is kept)',
    v_n = 2 AND v_vi.line_items->0->>'product_name' = 'BL16 cable' AND v_vi.line_items->1->>'product_name' = 'Plug (supplier name)'
    AND (v_vi.line_items->0->>'qty_received')::int = 0, '-> ' || v_n);

  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_vendor_invoice(%L, %L::jsonb, '{"currency":"EGP","supplier_invoice_no":"bl16-a1"}'::jsonb, %L)$q$, v_v1, v_lines, v_mgr));
  RAISE NOTICE '%', pg_temp.check('the same supplier number again is refused by name, not by a raw index error', v_out LIKE 'err:P0001%already been entered%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_vendor_invoice(%L, %L::jsonb, '{"currency":"EGP"}'::jsonb, %L)$q$, v_v1, v_lines, v_rep));
  RAISE NOTICE '%', pg_temp.check('a sales rep cannot create one (manager_write_vendor_invoices)', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_vendor_invoice(%L, '[{"product_name":"freight","qty_ordered":1,"unit_cost":5}]'::jsonb, '{"currency":"EGP"}'::jsonb, %L)$q$, v_v1, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a line that is not a catalogue product is refused', v_out LIKE 'err:P0001%catalogue product%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_vendor_invoice(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_v1, v_lines, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a currency is required', v_out LIKE 'err:P0001%currency%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_vendor_invoice(%L, %L::jsonb, '{"currency":"USD"}'::jsonb, %L)$q$, v_v1, v_lines, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a foreign currency without its rate is refused (rma_guard_document_rate)', v_out LIKE 'err:P0001%rate%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_vendor_invoice(%L, %L::jsonb, '{"currency":"EGP","due_date":"today"}'::jsonb, %L)$q$, v_v1, v_lines, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a date word is refused', v_out LIKE 'err:P0001%valid date%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_vendor_invoice(%L, %L::jsonb, '{"currency":"EGP","purchase_order_id":null}'::jsonb, %L)$q$, v_v1, v_lines, v_mgr));
  RAISE NOTICE '%', pg_temp.check('an invoice is tied to an order only by converting it (purchase_order_id is not a field)', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$INSERT INTO public.vendor_invoices (vendor_id, line_items, currency, created_by) VALUES (%L, '[]', 'EGP', %L)$q$, v_v1, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a direct INSERT is refused', v_out LIKE 'err:42501%', '-> ' || v_out);

  -- ══ 2. The figures are always the lines ════════════════════════════════════
  RAISE NOTICE '--- 2. Money = lines ---';
  v_out := pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET total = 1 WHERE id = %L', v_vi.id));
  RAISE NOTICE '%', pg_temp.check('a draft''s total cannot be written directly (the identity guard only locked it after submission)', v_out LIKE 'err:P0001%'
    AND (SELECT total FROM public.vendor_invoices WHERE id = v_vi.id) = 2026, '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.vendor_invoices SET line_items = '[]' WHERE id = %L$q$, v_vi.id));
  RAISE NOTICE '%', pg_temp.check('nor its lines', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.vendor_invoices SET archived = true, archived_at = now(), archived_by = %L WHERE id = %L$q$, v_mgr, v_vi.id));
  RAISE NOTICE '%', pg_temp.check('archiving still works directly', v_out = 'ok', '-> ' || v_out);
  PERFORM pg_temp.call(v_mgr, format('UPDATE public.vendor_invoices SET archived = false, archived_at = NULL, archived_by = NULL WHERE id = %L', v_vi.id));

  -- ══ 3. update_vendor_invoice ═══════════════════════════════════════════════
  RAISE NOTICE '--- 3. update_vendor_invoice ---';
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.update_vendor_invoice(%L, %L::jsonb, '{"due_date":"2026-10-31"}'::jsonb, %L)$q$, v_vi.id,
    jsonb_build_array(jsonb_build_object('product_id', v_p1, 'qty_ordered', 4, 'unit_cost', 50)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a draft is edited: lines and a field, other fields kept', v_out = 'ok'
    AND (SELECT total = 200 AND due_date = '2026-10-31' AND notes = 'first' AND supplier_invoice_no = 'BL16-A1' FROM public.vendor_invoices WHERE id = v_vi.id), '-> ' || v_out);
  v_out := pg_temp.call(v_tech, format($q$SELECT public.update_vendor_invoice(%L, NULL, '{"notes":"x"}'::jsonb, %L)$q$, v_vi.id, v_tech));
  RAISE NOTICE '%', pg_temp.check('a technician cannot edit it', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.vendor_invoices SET status = 'pending_approval', duplicate_override_reason = 'separate bill, checked' WHERE id = %L$q$, v_vi.id));
  RAISE NOTICE '%', pg_temp.check('submitting (status, with a duplicate reason) is still a direct change', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.update_vendor_invoice(%L, NULL, '{"notes":"after submit"}'::jsonb, %L)$q$, v_vi.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a submitted invoice cannot be edited', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- ══ 4. convert_po_to_vendor_invoice ════════════════════════════════════════
  RAISE NOTICE '--- 4. convert ---';
  PERFORM pg_temp.as_user(v_mgr);
  v_po := public.create_purchase_order(v_v1, v_lines, '{"currency":"USD","exchange_rate":48.5,"notes":"po notes"}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  v_out := pg_temp.call(v_mgr, format('SELECT public.convert_po_to_vendor_invoice(%L, %L)', v_po.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a draft purchase order cannot be invoiced', v_out LIKE 'err:P0001%confirmed%', '-> ' || v_out);
  UPDATE public.purchase_orders SET status = 'sent' WHERE id = v_po.id;
  UPDATE public.purchase_orders SET status = 'confirmed' WHERE id = v_po.id;
  v_out := pg_temp.call(v_tech, format('SELECT public.convert_po_to_vendor_invoice(%L, %L)', v_po.id, v_tech));
  RAISE NOTICE '%', pg_temp.check('a technician cannot convert one', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('SELECT public.convert_po_to_vendor_invoice(%L, %L)', v_po.id, v_mgr));
  SELECT id INTO v_id FROM public.vendor_invoices WHERE purchase_order_id = v_po.id;
  RAISE NOTICE '%', pg_temp.check('a confirmed PO converts, carrying its currency and rate (the browser sent none, so this always failed)', v_out = 'ok'
    AND (SELECT currency = 'USD' AND exchange_rate = 48.5 AND status = 'draft' AND total = 2026 AND notes = 'po notes' AND created_by = v_mgr
           FROM public.vendor_invoices WHERE id = v_id), '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('its rows come from the order''s rows',
    (SELECT count(*) FROM public.vendor_invoice_lines WHERE vendor_invoice_id = v_id AND qty_received = 0) = 2);
  v_out := pg_temp.call(v_mgr, format('SELECT public.convert_po_to_vendor_invoice(%L, %L)', v_po.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a second live invoice for the same order is refused', v_out LIKE 'err:P0001%already%', '-> ' || v_out);

  -- ══ 5. Receiving moves the rows with the mirror ════════════════════════════
  RAISE NOTICE '--- 5. receive ---';
  -- as the owner: approval is tested elsewhere (I-06)
  UPDATE public.vendor_invoices SET supplier_invoice_no = 'BL16-B1', status = 'pending_approval' WHERE id = v_id;
  UPDATE public.vendor_invoices SET status = 'approved' WHERE id = v_id;
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.receive_vendor_invoice(%L, %L::jsonb, %L)$q$, v_id,
    jsonb_build_array(jsonb_build_object('product_id', v_p1, 'warehouse_id', v_wh, 'qty', 4, 'line_index', 0)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('a partial receipt updates the row and the mirror together', v_out = 'ok'
    AND (SELECT qty_received FROM public.vendor_invoice_lines WHERE vendor_invoice_id = v_id AND line_no = 0) = 4
    AND (SELECT (line_items->0->>'qty_received')::int = 4 AND status = 'partially_received' FROM public.vendor_invoices WHERE id = v_id), '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.receive_vendor_invoice(%L, %L::jsonb, %L)$q$, v_id,
    jsonb_build_array(jsonb_build_object('product_id', v_p1, 'warehouse_id', v_wh, 'qty', 7, 'line_index', 0)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('receiving more than a line has left is refused', v_out LIKE 'err:P0001%left to receive%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.receive_vendor_invoice(%L, %L::jsonb, %L)$q$, v_id,
    jsonb_build_array(jsonb_build_object('product_id', v_p1, 'warehouse_id', v_wh, 'qty', 6, 'line_index', 0),
                      jsonb_build_object('product_id', v_p2, 'warehouse_id', v_wh, 'qty', 5)), v_mgr));
  RAISE NOTICE '%', pg_temp.check('the rest completes it: every row received in full, status received',
    v_out = 'ok' AND NOT EXISTS (SELECT 1 FROM public.vendor_invoice_lines WHERE vendor_invoice_id = v_id AND qty_received <> qty_ordered)
    AND (SELECT status FROM public.vendor_invoices WHERE id = v_id) = 'received', '-> ' || v_out);

  -- ══ 6. Read access follows the invoice ═════════════════════════════════════
  RAISE NOTICE '--- 6. Read access ---';
  PERFORM pg_temp.as_user(v_acct);
  SELECT count(*)::integer INTO v_n FROM public.vendor_invoice_lines WHERE vendor_invoice_id = v_id;
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('an accountant sees a vendor invoice''s lines', v_n = 2, '-> ' || v_n);
  PERFORM pg_temp.as_user(v_tech);
  SELECT count(*)::integer INTO v_n FROM public.vendor_invoice_lines WHERE vendor_invoice_id = v_id;
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a technician sees none', v_n = 0, '-> ' || v_n);

  -- ══ 7. Access ═══════════════════════════════════════════════════════════════
  RAISE NOTICE '--- 7. Access ---';
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.vendor_invoice_lines SET qty_received = 0 WHERE vendor_invoice_id = %L$q$, v_id));
  RAISE NOTICE '%', pg_temp.check('a client cannot write vendor_invoice_lines (received quantities included)', v_out LIKE 'err:%'
    AND (SELECT sum(qty_received) FROM public.vendor_invoice_lines WHERE vendor_invoice_id = v_id) = 15, '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('anon cannot call the RPCs; no client can call the internals',
    NOT has_function_privilege('anon', 'public.create_vendor_invoice(uuid, jsonb, jsonb, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.convert_po_to_vendor_invoice(uuid, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._vendor_invoice_write_lines(uuid, jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._vendor_invoice_assert_supplier_no(public.vendor_invoices)', 'EXECUTE'));

  -- ══ 8. Review findings (each failed before its fix) ═════════════════════════
  RAISE NOTICE '--- 8. Review findings ---';
  PERFORM pg_temp.as_user(v_mgr);
  v_vi := public.create_vendor_invoice(v_v1, v_lines, '{"currency":"EGP","supplier_invoice_no":"BL16-R1","non_po_reason":"Stock top-up, no PO needed"}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.vendor_invoices SET status = 'pending_approval' WHERE id = v_vi.id;
  UPDATE public.vendor_invoices SET status = 'approved' WHERE id = v_vi.id;
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.vendor_invoices SET status = 'received' WHERE id = %L$q$, v_vi.id));
  RAISE NOTICE '%', pg_temp.check('an invoice cannot be marked received without receiving anything', v_out LIKE 'err:P0001%'
    AND (SELECT status FROM public.vendor_invoices WHERE id = v_vi.id) = 'approved', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.vendor_invoices SET duplicate_override_reason = 'rewritten after approval' WHERE id = %L$q$, v_vi.id));
  RAISE NOTICE '%', pg_temp.check('the duplicate reason cannot be rewritten after approval', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.vendor_invoices SET approved_at = '2020-01-01' WHERE id = %L$q$, v_vi.id));
  RAISE NOTICE '%', pg_temp.check('nor can approved_at be backdated', v_out LIKE 'err:P0001%', '-> ' || v_out);
  PERFORM pg_temp.as_user(v_mgr);
  v_vi := public.create_vendor_invoice(v_v1, v_lines, jsonb_build_object('currency', 'EGP', 'supplier_invoice_no', chr(160) || chr(8203) || ' '), v_mgr);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a supplier number of only invisible spaces counts as no number', v_vi.supplier_invoice_no IS NULL, '-> [' || COALESCE(v_vi.supplier_invoice_no, 'null') || ']');

  RAISE EXCEPTION 'BL16_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
