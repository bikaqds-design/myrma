-- ############################################################################
-- #  SALES INVOICE LINES — W2 / L-01, third document type (20260885)
-- #
-- #  HOW TO RUN:
-- #  node scripts/run-sql-test.mjs supabase/tests/crm_invoice_lines.sql BL13_TEST_DONE
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
  v_rep    text := 'bl13-rep@test.local';
  v_rep2   text := 'bl13-rep2@test.local';
  v_mgr    text := 'bl13-mgr@test.local';
  v_tech   text := 'bl13-tech@test.local';
  v_acct   text := 'bl13-acct@test.local';
  v_cust   uuid;
  v_p1     uuid := gen_random_uuid();
  v_p2     uuid := gen_random_uuid();
  v_inv    public.crm_invoices;
  v_inv2   uuid;
  v_so     public.sales_orders;
  v_so2    public.sales_orders;
  v_out    text;
  v_n      integer;
  v_lines  jsonb;
  v_rows   jsonb;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES (v_rep, 'sales_rep', 'active'), (v_rep2, 'sales_rep', 'active'), (v_mgr, 'manager', 'active'),
         (v_tech, 'technician', 'active'), (v_acct, 'accountant', 'active');
  -- service products: approving and posting move no stock
  INSERT INTO public.products (id, sku, product_name, product_type)
  VALUES (v_p1, 'BL13-P1', 'BL13 service 1', 'service'), (v_p2, 'BL13-P2', 'BL13 service 2', 'service');
  INSERT INTO public.customers (company_name, customer_code, customer_type)
  VALUES ('BL13 Customer', 'BL13-C1', 'B2B') RETURNING id INTO v_cust;
  v_lines := jsonb_build_array(
    jsonb_build_object('product_id', v_p1, 'product_name', 'BL13 service 1', 'qty', 2, 'unit_price', 100, 'discount_pct', 10, 'tax_pct', 14),
    jsonb_build_object('product_id', v_p2, 'product_name', 'BL13 service 2', 'qty', 1, 'unit_price', 50));

  -- ══ 1. create_crm_invoice (a manual invoice) ═════════════════════════════
  RAISE NOTICE '--- 1. create_crm_invoice ---';
  PERFORM pg_temp.as_user(v_rep);
  v_inv := public.create_crm_invoice(v_cust, v_lines, NULL, 'Net 30', 'PO-13', NULL, v_rep, v_rep);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a sales rep creates a draft invoice with no code and no order', v_inv.doc_status = 'draft' AND v_inv.inv_code IS NULL AND v_inv.so_id IS NULL AND v_inv.created_by = v_rep);
  SELECT count(*) INTO v_n FROM public.crm_invoice_lines WHERE crm_invoice_id = v_inv.id;
  RAISE NOTICE '%', pg_temp.check('its lines are rows', v_n = 2, '-> ' || v_n);
  RAISE NOTICE '%', pg_temp.check('totals computed in the database (250 / 20 / 25.20 / 255.20)',
    v_inv.subtotal = 250 AND v_inv.discount_amount = 20 AND v_inv.tax_amount = 25.20 AND v_inv.total = 255.20,
    format('-> %s / %s / %s / %s', v_inv.subtotal, v_inv.discount_amount, v_inv.tax_amount, v_inv.total));
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_crm_invoice(%L, '[{"product_name":"free","qty":1,"unit_price":5}]'::jsonb, NULL, NULL, NULL, NULL, NULL, %L)$q$, v_cust, v_rep));
  RAISE NOTICE '%', pg_temp.check('a line that is not a catalogue product is refused', v_out LIKE 'err:P0001%catalogue product%', '-> ' || v_out);
  v_out := pg_temp.call(v_tech, format($q$SELECT public.create_crm_invoice(%L, %L::jsonb, NULL, NULL, NULL, NULL, NULL, %L)$q$, v_cust, v_lines, v_tech));
  RAISE NOTICE '%', pg_temp.check('a technician cannot create one', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$INSERT INTO public.crm_invoices (customer_id, created_by, line_items, doc_status, payment_status) VALUES (%L, %L, '[]', 'draft', 'unpaid')$q$, v_cust, v_rep));
  RAISE NOTICE '%', pg_temp.check('a direct INSERT is refused', v_out LIKE 'err:%', '-> ' || v_out);

  -- ══ 2. update_crm_invoice ═════════════════════════════════════════════════
  RAISE NOTICE '--- 2. update_crm_invoice ---';
  v_out := pg_temp.call(v_rep2, format($q$SELECT public.update_crm_invoice(%L, NULL, '{"notes":"x"}'::jsonb, %L)$q$, v_inv.id, v_rep2));
  RAISE NOTICE '%', pg_temp.check('another rep cannot edit it', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_crm_invoice(%L, '[{"product_id":"%s","qty":4,"unit_price":10}]'::jsonb, '{"notes":"four"}'::jsonb, %L)$q$, v_inv.id, v_p1, v_rep));
  RAISE NOTICE '%', pg_temp.check('the owner replaces the lines of a manual draft (the name comes from the catalogue)', v_out = 'ok'
    AND (SELECT total = 40 AND notes = 'four' AND reference_po = 'PO-13' FROM public.crm_invoices WHERE id = v_inv.id)
    AND (SELECT product_name FROM public.crm_invoice_lines WHERE crm_invoice_id = v_inv.id) = 'BL13 service 1', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$UPDATE public.crm_invoices SET line_items = '[{"product_name":"x","qty":1,"unit_price":999}]'::jsonb, total = 999 WHERE id = %L$q$, v_inv.id));
  RAISE NOTICE '%', pg_temp.check('a DRAFT''s lines and total cannot be written directly (the settled lock stops only non-drafts)', v_out LIKE 'err:P0001%'
    AND (SELECT total FROM public.crm_invoices WHERE id = v_inv.id) = 40, '-> ' || v_out);

  -- ══ 3. convert_so_to_invoice ═══════════════════════════════════════════════
  RAISE NOTICE '--- 3. From an order ---';
  PERFORM pg_temp.as_user(v_rep);
  v_so := public.create_sales_order(v_cust, v_lines, NULL, 'Net 45', 'PO-SO', NULL, v_rep, v_rep);
  PERFORM pg_temp.as_owner();
  v_out := pg_temp.call(v_rep, format($q$SELECT public.convert_so_to_invoice(%L, %L)$q$, v_so.id, v_rep));
  RAISE NOTICE '%', pg_temp.check('a draft order cannot be invoiced', v_out LIKE 'err:P0001%Approve%', '-> ' || v_out);
  PERFORM pg_temp.call(v_rep, format($q$UPDATE public.sales_orders SET status = 'sent' WHERE id = %L$q$, v_so.id));
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.approve_sales_order(%L, %L)$q$, v_so.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('the order is approved', v_out = 'ok' AND (SELECT status FROM public.sales_orders WHERE id = v_so.id) = 'confirmed', '-> ' || v_out);
  v_out := pg_temp.call(v_rep2, format($q$SELECT public.convert_so_to_invoice(%L, %L)$q$, v_so.id, v_rep2));
  RAISE NOTICE '%', pg_temp.check('a rep who does not own the order cannot invoice it', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.convert_so_to_invoice(%L, %L)$q$, v_so.id, v_rep));
  RAISE NOTICE '%', pg_temp.check('its owner invoices it', v_out = 'ok', '-> ' || v_out);
  SELECT * INTO v_inv FROM public.crm_invoices WHERE so_id = v_so.id;
  RAISE NOTICE '%', pg_temp.check('the invoice has the order''s lines as rows, total and header', v_inv.total = v_so.total AND v_inv.payment_terms = 'Net 45'
    AND (SELECT array_agg(product_id ORDER BY line_no) FROM public.crm_invoice_lines WHERE crm_invoice_id = v_inv.id)
      = (SELECT array_agg(product_id ORDER BY line_no) FROM public.sales_order_lines WHERE sales_order_id = v_so.id),
    format('-> %s vs %s', v_inv.total, v_so.total));
  v_out := pg_temp.call(v_rep, format($q$SELECT public.convert_so_to_invoice(%L, %L)$q$, v_so.id, v_rep));
  RAISE NOTICE '%', pg_temp.check('a second conversion is refused (the order row is locked while it checks)', v_out LIKE 'err:P0001%already been converted%', '-> ' || v_out);
  -- cannot reopen a cancelled invoice as a draft and convert its order again (would double-invoice it)
  PERFORM pg_temp.as_user(v_rep);
  v_so2 := public.create_sales_order(v_cust, v_lines, NULL, NULL, NULL, NULL, v_rep, v_rep);
  PERFORM pg_temp.as_owner();
  PERFORM pg_temp.call(v_rep, format($q$UPDATE public.sales_orders SET status = 'sent' WHERE id = %L$q$, v_so2.id));
  PERFORM pg_temp.call(v_mgr, format($q$SELECT public.approve_sales_order(%L, %L)$q$, v_so2.id, v_mgr));
  PERFORM pg_temp.call(v_rep, format($q$SELECT public.convert_so_to_invoice(%L, %L)$q$, v_so2.id, v_rep));
  PERFORM pg_temp.call(v_rep, format($q$UPDATE public.crm_invoices SET doc_status = 'cancelled', void_reason = 'test' WHERE so_id = %L AND doc_status = 'draft'$q$, v_so2.id));
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.crm_invoices SET doc_status = 'draft' WHERE so_id = %L$q$, v_so2.id));
  RAISE NOTICE '%', pg_temp.check('a cancelled invoice cannot be reopened to draft by a client (so an order can''t be double-invoiced this way)', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- an order's invoice keeps what was ordered
  SELECT jsonb_agg(jsonb_build_object('product_id', l.product_id, 'product_name', l.product_name, 'qty', l.qty,
                                      'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct) ORDER BY l.line_no)
    INTO v_rows FROM public.crm_invoice_lines l WHERE l.crm_invoice_id = v_inv.id;
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_crm_invoice(%L, %L::jsonb, '{"due_date":"2026-12-31"}'::jsonb, %L)$q$, v_inv.id, v_rows, v_rep));
  RAISE NOTICE '%', pg_temp.check('its header changes when the lines come back unchanged', v_out = 'ok'
    AND (SELECT due_date = '2026-12-31'::date FROM public.crm_invoices WHERE id = v_inv.id), '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.update_crm_invoice(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_inv.id, jsonb_set(v_rows, '{0,unit_price}', '1'::jsonb), v_mgr));
  RAISE NOTICE '%', pg_temp.check('...but not its prices, even by a manager', v_out LIKE 'err:P0001%made from a sales order%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_crm_invoice(%L, %L::jsonb, '{}'::jsonb, %L)$q$, v_inv.id, jsonb_set(v_rows, '{0,product_name}', '"Something else entirely"'::jsonb), v_rep));
  RAISE NOTICE '%', pg_temp.check('...nor the printed product name, even with the same product/qty/price (it would misrepresent what was billed)', v_out LIKE 'err:P0001%made from a sales order%', '-> ' || v_out);

  -- ══ 4. Posting still works; a posted invoice is locked ═════════════════════
  RAISE NOTICE '--- 4. Posting ---';
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.post_invoice(%L, %L)$q$, v_inv.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('post_invoice works on the mirrored lines', v_out = 'ok'
    AND (SELECT doc_status = 'posted' AND inv_code IS NOT NULL FROM public.crm_invoices WHERE id = v_inv.id), '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.update_crm_invoice(%L, NULL, '{"notes":"after posting"}'::jsonb, %L)$q$, v_inv.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a posted invoice cannot be edited through the RPC', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- cancelling a draft stays a plain update
  PERFORM pg_temp.as_user(v_rep);
  v_inv2 := (public.create_crm_invoice(v_cust, v_lines, NULL, NULL, NULL, NULL, v_rep, v_rep)).id;
  PERFORM pg_temp.as_owner();
  v_out := pg_temp.call(v_rep, format($q$UPDATE public.crm_invoices SET doc_status = 'cancelled', void_reason = 'raised by mistake' WHERE id = %L AND doc_status = 'draft'$q$, v_inv2));
  RAISE NOTICE '%', pg_temp.check('crmInvoices.cancelDraft still works (status and reason only)', v_out = 'ok'
    AND (SELECT doc_status FROM public.crm_invoices WHERE id = v_inv2) = 'cancelled', '-> ' || v_out);

  -- ══ 5. Read access follows the invoice ═════════════════════════════════════
  RAISE NOTICE '--- 5. Read access ---';
  PERFORM pg_temp.as_user(v_acct);
  SELECT count(*)::integer INTO v_n FROM public.crm_invoice_lines WHERE crm_invoice_id = v_inv.id;
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('an accountant sees an invoice''s lines', v_n = 2, '-> ' || v_n);
  PERFORM pg_temp.as_user(v_tech);
  SELECT count(*)::integer INTO v_n FROM public.crm_invoice_lines WHERE crm_invoice_id = v_inv.id;
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a technician sees none', v_n = 0, '-> ' || v_n);

  -- ══ 6. Access ═══════════════════════════════════════════════════════════════
  RAISE NOTICE '--- 6. Access ---';
  v_out := pg_temp.call(v_rep, format($q$INSERT INTO public.crm_invoice_lines (crm_invoice_id, line_no, product_name, qty, unit_price) VALUES (%L, 9, 'x', 1, 1)$q$, v_inv2));
  RAISE NOTICE '%', pg_temp.check('a client cannot write crm_invoice_lines', v_out LIKE 'err:%', '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('anon cannot call the RPCs; no client can call the writer',
    NOT has_function_privilege('anon', 'public.create_crm_invoice(uuid, jsonb, date, text, text, text, text, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.update_crm_invoice(uuid, jsonb, jsonb, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.convert_so_to_invoice(uuid, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._crm_invoice_write_lines(uuid, jsonb)', 'EXECUTE'));

  RAISE EXCEPTION 'BL13_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
