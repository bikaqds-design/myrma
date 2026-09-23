-- ############################################################################
-- #  LINE READERS — W2 / L-02 step 1 (20260890)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/line_readers_money_stock.sql L02A_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- #
-- #  For each reader that decides money or stock, the document's line_items
-- #  copy is made to disagree with its rows (as the owner — what a restore or a
-- #  definer bug could do), and the reader must follow the ROWS.
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

DO $do$
DECLARE
  v_mgr   text := 'l02a-mgr@test.local';
  v_mgr2  text := 'l02a-mgr2@test.local';
  v_cust  uuid;
  v_wh    uuid := gen_random_uuid();
  v_bulk  uuid := gen_random_uuid();
  v_ws    uuid := gen_random_uuid();
  v_v1    uuid := gen_random_uuid();
  v_so    public.sales_orders;
  v_so2   uuid := gen_random_uuid();
  v_inv   uuid;
  v_cn    public.credit_notes;
  v_vi    public.vendor_invoices;
  v_out   text;
  v_n     numeric;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_mgr, 'manager', 'active'), (v_mgr2, 'manager', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('L02A Co', 'L02A-C1', 'B2B') RETURNING id INTO v_cust;
  INSERT INTO public.warehouses (id, name, code, warehouse_type) VALUES (v_wh, 'L02A WH', 'L02A-WH', 'main');
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode) VALUES (v_bulk, 'L02A-BULK', 'L02A bulk', 'hardware', 'bulk');
  INSERT INTO public.warehouse_stock (id, product_id, warehouse_id, quantity, reserved_quantity) VALUES (v_ws, v_bulk, v_wh, 20, 0);
  INSERT INTO public.brands (id, brand_name) VALUES (v_v1, 'L02A Vendor');

  -- ══ 1. approve_sales_order reserves what the rows say ═════════════════════
  RAISE NOTICE '--- 1. approve_sales_order ---';
  PERFORM pg_temp.as_user(v_mgr);
  v_so := public.create_sales_order(v_cust, jsonb_build_array(jsonb_build_object('product_id', v_bulk, 'qty', 2, 'unit_price', 10)),
                                    NULL, NULL, NULL, NULL, NULL, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.sales_orders SET status = 'sent', line_items = jsonb_set(line_items, '{0,qty}', '9') WHERE id = v_so.id;
  v_out := pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so.id, v_mgr));
  SELECT reserved_quantity INTO v_n FROM public.warehouse_stock WHERE id = v_ws;
  RAISE NOTICE '%', pg_temp.check('approving reserves the 2 units on the row, not the 9 in the copy', v_out = 'ok' AND v_n = 2, '-> ' || v_out || ' / reserved ' || v_n);

  -- ══ 2. post_invoice ships what the invoice's rows say ═════════════════════
  RAISE NOTICE '--- 2. post_invoice ---';
  v_out := pg_temp.call(v_mgr, format('SELECT public.convert_so_to_invoice(%L, %L)', v_so.id, v_mgr));
  SELECT id INTO v_inv FROM public.crm_invoices WHERE so_id = v_so.id;
  UPDATE public.crm_invoices SET line_items = jsonb_set(line_items, '{0,qty}', '9') WHERE id = v_inv;
  v_out := pg_temp.call(v_mgr, format('SELECT public.post_invoice(%L, %L)', v_inv, v_mgr));
  SELECT quantity INTO v_n FROM public.warehouse_stock WHERE id = v_ws;
  RAISE NOTICE '%', pg_temp.check('posting ships the 2 units on the row (20 -> 18), not the 9 in the copy', v_out = 'ok' AND v_n = 18, '-> ' || v_out || ' / on hand ' || v_n);

  -- ══ 3. the credit-note caps count what the rows say ═══════════════════════
  RAISE NOTICE '--- 3. credit-note caps ---';
  -- the invoice's copy claims 9 sold; its row says 2
  PERFORM pg_temp.as_user(v_mgr);
  v_cn := public.create_credit_note('correction', v_cust, 'Billing correction', 'billing_error',
            jsonb_build_array(jsonb_build_object('product_id', v_bulk, 'product_name', 'L02A bulk', 'qty', 5, 'unit_price', 1)),
            v_inv, NULL, NULL, v_mgr);
  PERFORM pg_temp.as_owner();
  v_out := pg_temp.call(v_mgr, format('SELECT public.submit_credit_note_for_approval(%L, %L)', v_cn.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('crediting 5 units of a line that sold 2 is refused (the copy said 9)', v_out LIKE 'err:P0001%', '-> ' || v_out);
  -- the note's own copy claims 1 unit; its row says 5
  UPDATE public.credit_notes SET line_items = jsonb_set(line_items, '{0,qty}', '1') WHERE id = v_cn.id;
  UPDATE public.crm_invoices SET line_items = jsonb_set(line_items, '{0,qty}', '2') WHERE id = v_inv;
  v_out := pg_temp.call(v_mgr, format('SELECT public.submit_credit_note_for_approval(%L, %L)', v_cn.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('...and the note is judged by its own rows (5), not its copy (1)', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- ══ 4. landed cost comes from the supplier invoice's rows ═════════════════
  RAISE NOTICE '--- 4. landed cost ---';
  PERFORM pg_temp.as_user(v_mgr);
  v_vi := public.create_vendor_invoice(v_v1, jsonb_build_array(jsonb_build_object('product_id', v_bulk, 'qty_ordered', 3, 'unit_cost', 10)),
            '{"currency":"EGP","supplier_invoice_no":"L02A-1","non_po_reason":"Stock top-up, no PO"}'::jsonb, v_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.vendor_invoices SET line_items = jsonb_set(line_items, '{0,unit_cost}', '999') WHERE id = v_vi.id;
  PERFORM pg_temp.as_user(v_mgr);
  SELECT c.unit_cost_base INTO v_n FROM public.rma_vi_landed_unit_costs(v_vi.id) c WHERE c.line_index = 0;
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a received unit is costed at the row''s 10, not the copy''s 999', v_n = 10, '-> ' || COALESCE(v_n::text, 'null'));

  -- ══ 5. a document with no rows still works from its copy ══════════════════
  RAISE NOTICE '--- 5. fallback ---';
  INSERT INTO public.sales_orders (id, so_code, customer_id, created_by, status, line_items)
  VALUES (v_so2, 'SO-L02A-OLD', v_cust, v_mgr, 'sent', jsonb_build_array(jsonb_build_object('product_id', v_bulk, 'product_name', 'old', 'qty', 1, 'unit_price', 1)));
  v_out := pg_temp.call(v_mgr2, format('SELECT public.approve_sales_order(%L, %L)', v_so2, v_mgr2));
  SELECT reserved_quantity INTO v_n FROM public.warehouse_stock WHERE id = v_ws;
  RAISE NOTICE '%', pg_temp.check('an order written outside the RPCs (no rows) is approved from its copy', v_out = 'ok' AND v_n = 1, '-> ' || v_out || ' / reserved ' || v_n);

  -- ══ 6. access ═══════════════════════════════════════════════════════════════
  RAISE NOTICE '%', pg_temp.check('the helpers are internal',
    NOT has_function_privilege('authenticated', 'public.rma_sales_order_lines_json(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rma_crm_invoice_lines_json(uuid)', 'EXECUTE'));

  RAISE EXCEPTION 'L02A_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
