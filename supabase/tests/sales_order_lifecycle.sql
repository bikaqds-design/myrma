-- ############################################################################
-- #  SALES-ORDER LIFECYCLE — BL-04 / I-04 (20260879)
-- #
-- #  Before:
-- #   * reject_sales_order had no status check: any manager could "decline" a
-- #     confirmed, delivered or cancelled order, leaving its stock reserved.
-- #   * cancel_sales_order released serialized units only, so a cancelled order
-- #     kept its BULK reservation forever (warehouse_stock.reserved_quantity
-- #     never came back down).
-- #   * approve_sales_order set status 'delivered' (and delivered_at) although
-- #     the units were only reserved: the order claimed a delivery that had not
-- #     happened. It also silently skipped a line whose qty was missing or 0.
-- #   * an invoice could be created from an order in ANY status, including a
-- #     draft or a declined one.
-- #   * QT / SO / PO codes were random 8-digit numbers under a UNIQUE
-- #     constraint, with no retry: a collision is a hard failure.
-- #   * nothing could tell you a reservation had leaked.
-- #  Also found on the way: rma_data_integrity_issues() was callable by any
-- #  signed-in user and returns invoice codes and amounts.
-- #
-- #  HOW TO RUN:
-- #  node scripts/run-sql-test.mjs supabase/tests/sales_order_lifecycle.sql BL04C_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- ############################################################################

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail)
$f$;

-- Run one statement as a signed-in user (or as the owner when p_email is NULL)
-- and report 'ok' or 'err:<SQLSTATE> <message>'. A failed statement is rolled
-- back on its own, so the fixture survives it.
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
    out := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 110);
  END;
  IF p_email IS NOT NULL THEN
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', '', true);
  END IF;
  RETURN out;
END $f$;

CREATE FUNCTION pg_temp.so_status(p_so uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT status FROM public.sales_orders WHERE id = p_so
$f$;

CREATE FUNCTION pg_temp.reserved_units(p_so uuid) RETURNS integer LANGUAGE sql AS $f$
  SELECT count(*)::integer FROM public.inventory_units
   WHERE reserved_by_doc_type = 'sales_order' AND reserved_by_doc_id = p_so AND reservation_status = 'reserved'
$f$;

-- A sales order as the owner, in the given status, holding the given lines.
CREATE FUNCTION pg_temp.new_so(p_customer uuid, p_status text, p_lines jsonb, p_by text) RETURNS uuid
LANGUAGE plpgsql AS $f$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.sales_orders (id, so_code, customer_id, status, line_items, subtotal, total, created_by)
  VALUES (v, 'SO-T-' || substr(v::text, 1, 8), p_customer, p_status, p_lines, 100, 100, p_by);
  RETURN v;
END $f$;

DO $do$
DECLARE
  v_mgr   text := 'bl04-mgr@test.local';
  v_admin text := 'bl04-admin@test.local';
  v_rep   text := 'bl04-rep@test.local';
  v_tech  text := 'bl04-tech@test.local';
  v_cust  uuid;
  v_wh    uuid := gen_random_uuid();
  v_ser   uuid := gen_random_uuid();   -- serialized product
  v_bulk  uuid := gen_random_uuid();   -- bulk product
  v_ws    uuid := gen_random_uuid();
  v_so    uuid;
  v_so2   uuid;
  v_out   text;
  v_row   record;
  v_a     text;
  v_b     text;
  v_year  text := EXTRACT(YEAR FROM now())::text;
  v_n     integer;
  v_ghost uuid := gen_random_uuid();
  v_viewer text := 'bl04-viewer@test.local';
BEGIN
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES (v_mgr, 'manager', 'active'), (v_admin, 'admin', 'active'),
         (v_rep, 'sales_rep', 'active'), (v_tech, 'technician', 'active'),
         (v_viewer, 'viewer', 'active');

  INSERT INTO public.customers (company_name, customer_code, customer_type, email)
  VALUES ('BL04 Co', 'BL04-CUST', 'B2B', 'bl04@example.invalid') RETURNING id INTO v_cust;

  INSERT INTO public.warehouses (id, name, warehouse_type) VALUES (v_wh, 'BL04 Main', 'main');
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode)
  VALUES (v_ser, 'BL04-SER', 'BL04 serialized', 'hardware', 'serialized'),
         (v_bulk, 'BL04-BULK', 'BL04 bulk', 'hardware', 'bulk');
  INSERT INTO public.inventory_units (product_id, product_name, serial_number, status, reservation_status, warehouse_id)
  SELECT v_ser, 'BL04 serialized', 'BL04-SN-' || g, 'company_stock', 'available', v_wh FROM generate_series(1, 6) g;
  INSERT INTO public.warehouse_stock (id, product_id, warehouse_id, quantity, reserved_quantity)
  VALUES (v_ws, v_bulk, v_wh, 20, 0);

  -- ══ 1. reject_sales_order only rejects an order that is awaiting approval ═══
  RAISE NOTICE '--- 1. Reject only from sent ---';
  v_so := pg_temp.new_so(v_cust, 'sent', jsonb_build_array(jsonb_build_object('product_id', v_ser, 'qty', 1)), v_mgr);
  v_out := pg_temp.call(v_mgr, format('SELECT public.reject_sales_order(%L, %L)', v_so, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a manager rejects a sent order', v_out = 'ok' AND pg_temp.so_status(v_so) = 'declined',
    '-> ' || v_out || ' / ' || pg_temp.so_status(v_so));

  -- the same order, now declined, cannot be "rejected" again
  v_out := pg_temp.call(v_mgr, format('SELECT public.reject_sales_order(%L, %L)', v_so, v_mgr));
  RAISE NOTICE '%', pg_temp.check('rejecting a declined order is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);

  FOREACH v_a IN ARRAY ARRAY['draft', 'confirmed', 'delivered', 'cancelled', 'accepted'] LOOP
    v_so2 := pg_temp.new_so(v_cust, v_a, '[]'::jsonb, v_mgr);
    v_out := pg_temp.call(v_mgr, format('SELECT public.reject_sales_order(%L, %L)', v_so2, v_mgr));
    RAISE NOTICE '%', pg_temp.check(format('a %s order cannot be rejected', v_a),
      v_out LIKE 'err:P0001%' AND pg_temp.so_status(v_so2) = v_a, '-> ' || v_out || ' / ' || pg_temp.so_status(v_so2));
  END LOOP;

  v_out := pg_temp.call(v_mgr, format('SELECT public.reject_sales_order(%L, %L)', gen_random_uuid(), v_mgr));
  RAISE NOTICE '%', pg_temp.check('rejecting an unknown order names the problem', v_out LIKE 'err:%not found%', '-> ' || v_out);

  v_so2 := pg_temp.new_so(v_cust, 'sent', '[]'::jsonb, v_mgr);
  v_out := pg_temp.call(v_rep, format('SELECT public.reject_sales_order(%L, %L)', v_so2, v_rep));
  RAISE NOTICE '%', pg_temp.check('a sales rep still cannot reject (control)', v_out LIKE 'err:P0001%' AND pg_temp.so_status(v_so2) = 'sent', '-> ' || v_out);

  -- ══ 2. approve_sales_order: confirmed, not delivered ═════════════════════════
  RAISE NOTICE '--- 2. Approval confirms and reserves; it does not claim a delivery ---';
  v_so := pg_temp.new_so(v_cust, 'sent', jsonb_build_array(jsonb_build_object('product_id', v_ser, 'qty', 2)), v_mgr);
  v_out := pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so, v_mgr));
  SELECT * INTO v_row FROM public.sales_orders WHERE id = v_so;
  RAISE NOTICE '%', pg_temp.check('an approved order is confirmed, not delivered', v_out = 'ok' AND v_row.status = 'confirmed', '-> ' || v_out || ' / ' || v_row.status);
  RAISE NOTICE '%', pg_temp.check('confirmed_at is set and delivered_at stays empty', v_row.confirmed_at IS NOT NULL AND v_row.delivered_at IS NULL);
  RAISE NOTICE '%', pg_temp.check('its two units are reserved', pg_temp.reserved_units(v_so) = 2, '-> ' || pg_temp.reserved_units(v_so));

  v_out := pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so, v_mgr));
  RAISE NOTICE '%', pg_temp.check('approving twice is refused and reserves nothing more', v_out LIKE 'err:P0001%' AND pg_temp.reserved_units(v_so) = 2, '-> ' || v_out);

  -- a line with no quantity used to be skipped without a word
  v_so2 := pg_temp.new_so(v_cust, 'sent', jsonb_build_array(jsonb_build_object('product_id', v_ser, 'qty', 0)), v_mgr);
  v_out := pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so2, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a line with quantity 0 is refused, not silently skipped',
    v_out LIKE 'err:P0001%' AND pg_temp.so_status(v_so2) = 'sent', '-> ' || v_out);
  v_so2 := pg_temp.new_so(v_cust, 'sent', jsonb_build_array(jsonb_build_object('product_id', v_ser)), v_mgr);
  v_out := pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so2, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a line with no quantity is refused',
    v_out LIKE 'err:P0001%' AND pg_temp.so_status(v_so2) = 'sent', '-> ' || v_out);

  FOREACH v_a IN ARRAY ARRAY['NaN', 'abc', 'Infinity', '1e999', '-2', '2.5', '9999999'] LOOP
    v_so2 := pg_temp.new_so(v_cust, 'sent', jsonb_build_array(jsonb_build_object('product_id', v_ser, 'qty', v_a)), v_mgr);
    v_out := pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so2, v_mgr));
    RAISE NOTICE '%', pg_temp.check(format('a quantity of "%s" is refused with the clear message', v_a),
      v_out LIKE 'err:P0001%valid quantity%' AND pg_temp.so_status(v_so2) = 'sent', '-> ' || v_out);
  END LOOP;
  v_so2 := pg_temp.new_so(v_cust, 'sent', jsonb_build_array(jsonb_build_object('product_id', v_ser, 'qty', '1')), v_mgr);
  v_out := pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so2, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a quantity written as text "1" is still accepted (control)', v_out = 'ok', '-> ' || v_out);

  -- not enough stock: nothing is reserved and the order stays awaiting approval
  v_so2 := pg_temp.new_so(v_cust, 'sent', jsonb_build_array(jsonb_build_object('product_id', v_ser, 'qty', 99)), v_mgr);
  v_out := pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so2, v_mgr));
  RAISE NOTICE '%', pg_temp.check('insufficient stock refuses the approval and reserves nothing',
    v_out LIKE 'err:P0001%' AND pg_temp.so_status(v_so2) = 'sent' AND pg_temp.reserved_units(v_so2) = 0, '-> ' || v_out);

  -- a confirmed order can no longer be rejected: its stock would stay reserved
  v_out := pg_temp.call(v_mgr, format('SELECT public.reject_sales_order(%L, %L)', v_so, v_mgr));
  RAISE NOTICE '%', pg_temp.check('the confirmed order cannot then be rejected; its units stay reserved',
    v_out LIKE 'err:P0001%' AND pg_temp.so_status(v_so) = 'confirmed' AND pg_temp.reserved_units(v_so) = 2, '-> ' || v_out);

  -- ══ 3. cancel releases serialized AND bulk reservations ══════════════════════
  RAISE NOTICE '--- 3. Cancel gives back everything it held ---';
  v_out := pg_temp.call(v_mgr, format('SELECT public.cancel_sales_order(%L, %L)', v_so, v_mgr));
  RAISE NOTICE '%', pg_temp.check('cancelling a confirmed order releases its serialized units',
    v_out = 'ok' AND pg_temp.so_status(v_so) = 'cancelled' AND pg_temp.reserved_units(v_so) = 0, '-> ' || v_out);

  v_so := pg_temp.new_so(v_cust, 'sent', jsonb_build_array(
    jsonb_build_object('product_id', v_bulk, 'qty', 5),
    jsonb_build_object('product_id', v_ser,  'qty', 1)), v_mgr);
  v_out := pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a mixed order (bulk + serialized) is approved', v_out = 'ok', '-> ' || v_out);
  SELECT reserved_quantity INTO v_n FROM public.warehouse_stock WHERE id = v_ws;
  RAISE NOTICE '%', pg_temp.check('the bulk quantity is reserved', v_n = 5, '-> ' || v_n);

  v_out := pg_temp.call(v_mgr, format('SELECT public.cancel_sales_order(%L, %L)', v_so, v_mgr));
  SELECT reserved_quantity INTO v_n FROM public.warehouse_stock WHERE id = v_ws;
  RAISE NOTICE '%', pg_temp.check('cancelling returns the BULK reservation (this used to leak)', v_out = 'ok' AND v_n = 0, '-> ' || v_out || ' / reserved ' || v_n);
  RAISE NOTICE '%', pg_temp.check('...and the serialized unit', pg_temp.reserved_units(v_so) = 0);
  SELECT count(*)::integer INTO v_n FROM public.stock_moves
   WHERE doc_type = 'sales_order' AND doc_id = v_so AND move_type = 'release' AND ref_type = 'warehouse_stock';
  RAISE NOTICE '%', pg_temp.check('the bulk release is on the ledger', v_n = 1, '-> ' || v_n);

  v_out := pg_temp.call(v_mgr, format('SELECT public.cancel_sales_order(%L, %L)', v_so, v_mgr));
  RAISE NOTICE '%', pg_temp.check('cancelling twice is refused and does not release twice',
    v_out LIKE 'err:%cancelled%', '-> ' || v_out);
  SELECT reserved_quantity INTO v_n FROM public.warehouse_stock WHERE id = v_ws;
  RAISE NOTICE '%', pg_temp.check('the bulk counter never goes negative', v_n = 0, '-> ' || v_n);

  -- ══ 4. An invoice needs a confirmed order ════════════════════════════════════
  -- Since 20260885 a client cannot INSERT an invoice at all: an order's invoice
  -- is made by convert_so_to_invoice (one transaction, the order locked) and a
  -- standalone one by create_crm_invoice. The rules below are the same ones,
  -- checked through the path that now exists. One is deliberately stricter: a
  -- rep can no longer invoice another rep's order by knowing its id, even a
  -- confirmed one.
  RAISE NOTICE '--- 4. Invoicing an order that was never approved ---';
  DECLARE
    v_svc   uuid := gen_random_uuid();
    v_ilns  jsonb;
  BEGIN
    INSERT INTO public.products (id, sku, product_name, product_type) VALUES (v_svc, 'BL04-SVC', 'BL04 service', 'service');
    v_ilns := jsonb_build_array(jsonb_build_object('product_id', v_svc, 'product_name', 'BL04 service', 'qty', 1, 'unit_price', 10));

    FOREACH v_a IN ARRAY ARRAY['draft', 'sent', 'declined', 'cancelled'] LOOP
      v_so2 := pg_temp.new_so(v_cust, v_a, v_ilns, v_mgr);
      v_out := pg_temp.call(v_mgr, format('SELECT public.convert_so_to_invoice(%L, %L)', v_so2, v_mgr));
      RAISE NOTICE '%', pg_temp.check(format('no invoice from a %s order', v_a), v_out LIKE 'err:P0001%', '-> ' || v_out);
    END LOOP;
    FOREACH v_a IN ARRAY ARRAY['confirmed', 'delivered'] LOOP
      v_so2 := pg_temp.new_so(v_cust, v_a, v_ilns, v_mgr);
      v_out := pg_temp.call(v_mgr, format('SELECT public.convert_so_to_invoice(%L, %L)', v_so2, v_mgr));
      RAISE NOTICE '%', pg_temp.check(format('an invoice from a %s order is allowed', v_a), v_out = 'ok', '-> ' || v_out);
    END LOOP;
    -- an invoice with no order behind it (a standalone invoice) is not this rule's business
    v_out := pg_temp.call(v_mgr, format('SELECT public.create_crm_invoice(%L, %L::jsonb, NULL, NULL, NULL, NULL, NULL, %L)', v_cust, v_ilns, v_mgr));
    RAISE NOTICE '%', pg_temp.check('a standalone invoice (no order) is unaffected', v_out = 'ok', '-> ' || v_out);
    v_out := pg_temp.call(v_mgr, format(
      'INSERT INTO public.crm_invoices (so_id, customer_id, doc_status, subtotal, total, created_by) VALUES (NULL, %L, ''draft'', 10, 10, %L)', v_cust, v_mgr));
    RAISE NOTICE '%', pg_temp.check('a direct INSERT of an invoice is refused to every client (20260885)', v_out LIKE 'err:42501%', '-> ' || v_out);

    v_so2 := pg_temp.new_so(v_cust, 'draft', v_ilns, v_mgr);          -- somebody else's draft
    v_out := pg_temp.call(v_rep, format('SELECT public.convert_so_to_invoice(%L, %L)', v_so2, v_rep));
    RAISE NOTICE '%', pg_temp.check('a rep cannot invoice ANOTHER rep''s unapproved order', v_out LIKE 'err:P0001%', '-> ' || v_out);
    v_so2 := pg_temp.new_so(v_cust, 'confirmed', v_ilns, v_mgr);      -- somebody else's approved order
    v_out := pg_temp.call(v_rep, format('SELECT public.convert_so_to_invoice(%L, %L)', v_so2, v_rep));
    RAISE NOTICE '%', pg_temp.check('...nor another rep''s APPROVED one (stricter since 20260885: they can''t even read it)', v_out LIKE 'err:P0001%', '-> ' || v_out);
    v_so2 := pg_temp.new_so(v_cust, 'sent', v_ilns, v_rep);           -- the rep's own, not yet approved
    v_out := pg_temp.call(v_rep, format('SELECT public.convert_so_to_invoice(%L, %L)', v_so2, v_rep));
    RAISE NOTICE '%', pg_temp.check('a rep cannot invoice their OWN unapproved order', v_out LIKE 'err:P0001%', '-> ' || v_out);
    v_so2 := pg_temp.new_so(v_cust, 'confirmed', v_ilns, v_rep);      -- the rep's own, approved
    v_out := pg_temp.call(v_rep, format('SELECT public.convert_so_to_invoice(%L, %L)', v_so2, v_rep));
    RAISE NOTICE '%', pg_temp.check('a rep can invoice their own approved order (control)', v_out = 'ok', '-> ' || v_out);
    -- Backup & Restore goes through rma_restore_apply, a SECURITY DEFINER RPC (the owner), so an
    -- administrator has no need of an exemption: signed in as one, the rule applies.
    v_so2 := pg_temp.new_so(v_cust, 'cancelled', v_ilns, v_mgr);
    v_out := pg_temp.call(v_admin, format('SELECT public.convert_so_to_invoice(%L, %L)', v_so2, v_admin));
    RAISE NOTICE '%', pg_temp.check('an administrator signed in is held to the same rule', v_out LIKE 'err:P0001%', '-> ' || v_out);
    v_out := pg_temp.call(NULL, format(
      'INSERT INTO public.crm_invoices (so_id, customer_id, doc_status, subtotal, total, created_by) VALUES (%L, %L, ''draft'', 10, 10, ''system'')',
      v_so2, v_cust));
    RAISE NOTICE '%', pg_temp.check('an RPC (the owner) is not blocked', v_out = 'ok', '-> ' || v_out);
  END;

  -- ══ 5. Sequential document codes ═════════════════════════════════════════════
  RAISE NOTICE '--- 5. QT / SO / PO codes ---';
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_a := public.generate_doc_code('QT'); v_b := public.generate_doc_code('QT');
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE '%', pg_temp.check('QT codes are QT-YYYY-NNNNN', v_a ~ ('^QT-' || v_year || '-[0-9]{5}$'), '-> ' || v_a);
  RAISE NOTICE '%', pg_temp.check('...and the next one is exactly one higher',
    v_a ~ '^QT-' AND right(v_b, 5)::integer = right(v_a, 5)::integer + 1, '-> ' || v_a || ' then ' || v_b);

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_a := public.generate_doc_code('SO'); v_b := public.generate_doc_code('PO');
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE '%', pg_temp.check('SO codes are SO-YYYY-NNNNN', v_a ~ ('^SO-' || v_year || '-[0-9]{5}$'), '-> ' || v_a);
  RAISE NOTICE '%', pg_temp.check('PO codes are PO-YYYY-NNNNN', v_b ~ ('^PO-' || v_year || '-[0-9]{5}$'), '-> ' || v_b);

  -- The three sequences are independent of each other and of invoices.
  SELECT last_value INTO v_n FROM public.document_sequences WHERE seq_type = 'invoice';
  v_a := public.nextval_for_type('invoice');
  RAISE NOTICE '%', pg_temp.check('invoice numbering is unchanged (INV-YYYY-NNNNN, +1)',
    v_a ~ ('^INV-' || v_year || '-[0-9]{5}$') AND right(v_a, 5)::integer = v_n + 1, '-> ' || v_a);

  -- Year rollover. A transaction that started just before midnight must not drag a counter that a
  -- later transaction already moved to the new year back to the old one (which would re-issue
  -- number 1 of the new year), and the code must carry the counter's own year.
  UPDATE public.document_sequences SET seq_year = v_year::integer + 1, last_value = 5 WHERE seq_type = 'invoice';
  v_a := public.nextval_for_type('invoice');
  SELECT seq_year, last_value INTO v_row FROM public.document_sequences WHERE seq_type = 'invoice';
  RAISE NOTICE '%', pg_temp.check('a counter already in the next year is not pulled back, and the code says so',
    v_a = 'INV-' || (v_year::integer + 1) || '-00006' AND v_row.seq_year = v_year::integer + 1, '-> ' || v_a);
  UPDATE public.document_sequences SET seq_year = v_year::integer - 1, last_value = 900 WHERE seq_type = 'invoice';
  v_a := public.nextval_for_type('invoice');
  RAISE NOTICE '%', pg_temp.check('a counter left over from last year restarts at 1', v_a = 'INV-' || v_year || '-00001', '-> ' || v_a);

  -- A project provisioned before these sequence rows existed must still work.
  DELETE FROM public.document_sequences WHERE seq_type IN ('quotation', 'sales_order', 'purchase_order');
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_a := public.generate_doc_code('QT');
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE '%', pg_temp.check('a missing sequence row is created on demand, starting at 1',
    v_a = 'QT-' || v_year || '-00001', '-> ' || v_a);

  -- Other prefixes keep the old behaviour rather than breaking.
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_a := public.generate_doc_code('XX');
  EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE '%', pg_temp.check('an unrecognised prefix still yields a code', v_a ~ '^XX-[0-9]{8}$', '-> ' || v_a);

  v_out := pg_temp.call(v_tech, 'SELECT public.generate_doc_code(''QT'')');
  RAISE NOTICE '%', pg_temp.check('a technician can still get a code (control)', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_viewer, 'SELECT public.generate_doc_code(''QT'')');
  RAISE NOTICE '%', pg_temp.check('a viewer can no longer burn numbers', v_out LIKE 'err:P0001%', '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('anon cannot execute generate_doc_code',
    NOT has_function_privilege('anon', 'public.generate_doc_code(text)', 'EXECUTE'));

  -- ══ 6. The reservation integrity report ══════════════════════════════════════
  RAISE NOTICE '--- 6. rma_reservation_integrity ---';
  -- a healthy approved order produces no finding
  v_so := pg_temp.new_so(v_cust, 'sent', jsonb_build_array(jsonb_build_object('product_id', v_ser, 'qty', 1)), v_mgr);
  PERFORM pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so, v_mgr));
  v_out := pg_temp.call(v_admin, 'SELECT count(*) FROM public.rma_reservation_integrity()');
  RAISE NOTICE '%', pg_temp.check('an administrator can run it', v_out = 'ok', '-> ' || v_out);
  SELECT count(*)::integer INTO v_n FROM public.rma_reservation_integrity() WHERE entity_id = v_so;
  RAISE NOTICE '%', pg_temp.check('a healthy approved order has no finding', v_n = 0, '-> ' || v_n);

  -- leak 1: units still reserved for an order that was cancelled behind the RPC's back
  v_so2 := pg_temp.new_so(v_cust, 'sent', jsonb_build_array(jsonb_build_object('product_id', v_ser, 'qty', 2)), v_mgr);
  PERFORM pg_temp.call(v_mgr, format('SELECT public.approve_sales_order(%L, %L)', v_so2, v_mgr));
  UPDATE public.sales_orders SET status = 'cancelled' WHERE id = v_so2;
  SELECT count(*)::integer INTO v_n FROM public.rma_reservation_integrity()
   WHERE check_name = 'unit_reserved_by_closed_document' AND entity_id = v_so2;
  RAISE NOTICE '%', pg_temp.check('units reserved for a cancelled order are reported', v_n = 1, '-> ' || v_n);

  -- leak 2: reserved for an order that does not exist at all
  UPDATE public.inventory_units SET reservation_status = 'reserved', reserved_by_doc_type = 'sales_order',
         reserved_by_doc_id = v_ghost WHERE serial_number = 'BL04-SN-6';
  SELECT count(*)::integer INTO v_n FROM public.rma_reservation_integrity()
   WHERE check_name = 'unit_reserved_by_closed_document' AND entity_id = v_ghost;
  RAISE NOTICE '%', pg_temp.check('units reserved for an order that does not exist are reported', v_n = 1, '-> ' || v_n);

  -- leak 3: the bulk counter disagrees with the ledger
  UPDATE public.warehouse_stock SET reserved_quantity = 7 WHERE id = v_ws;
  SELECT count(*)::integer INTO v_n FROM public.rma_reservation_integrity()
   WHERE check_name = 'bulk_reserved_mismatch' AND entity_id = v_ws;
  RAISE NOTICE '%', pg_temp.check('a bulk counter that disagrees with the ledger is reported', v_n = 1, '-> ' || v_n);

  -- Reserving more than is on hand is not reportable because it cannot happen.
  v_out := pg_temp.call(NULL, format('UPDATE public.warehouse_stock SET reserved_quantity = 999 WHERE id = %L', v_ws));
  RAISE NOTICE '%', pg_temp.check('reserving more than is on hand is refused by the table itself', v_out LIKE 'err:23514%', '-> ' || v_out);
  UPDATE public.warehouse_stock SET reserved_quantity = 0 WHERE id = v_ws;

  -- leak 4: an approved order whose reservation is short of what it sold
  v_so2 := pg_temp.new_so(v_cust, 'confirmed', jsonb_build_array(jsonb_build_object('product_id', v_ser, 'qty', 3)), v_mgr);
  SELECT count(*)::integer INTO v_n FROM public.rma_reservation_integrity()
   WHERE check_name = 'confirmed_order_under_reserved' AND entity_id = v_so2;
  RAISE NOTICE '%', pg_temp.check('a confirmed order holding less stock than it sold is reported', v_n = 1, '-> ' || v_n);
  -- ...unless it has been invoiced, at which point delivery moved the stock on
  INSERT INTO public.crm_invoices (so_id, customer_id, doc_status, subtotal, total, created_by)
  VALUES (v_so2, v_cust, 'posted', 10, 10, v_mgr);
  SELECT count(*)::integer INTO v_n FROM public.rma_reservation_integrity()
   WHERE check_name = 'confirmed_order_under_reserved' AND entity_id = v_so2;
  RAISE NOTICE '%', pg_temp.check('...but not once it has been invoiced', v_n = 0, '-> ' || v_n);

  -- ...and not when its invoice was voided: void_invoice cancels the invoice and releases the
  -- units but leaves the order confirmed, so "holds less than it sold" is the documented normal.
  v_so2 := pg_temp.new_so(v_cust, 'confirmed', jsonb_build_array(jsonb_build_object('product_id', v_ser, 'qty', 3)), v_mgr);
  INSERT INTO public.crm_invoices (so_id, customer_id, doc_status, subtotal, total, created_by)
  VALUES (v_so2, v_cust, 'cancelled', 10, 10, v_mgr);
  SELECT count(*)::integer INTO v_n FROM public.rma_reservation_integrity()
   WHERE check_name = 'confirmed_order_under_reserved' AND entity_id = v_so2;
  RAISE NOTICE '%', pg_temp.check('...and not for an order whose invoice was voided (documented normal state)', v_n = 0, '-> ' || v_n);

  -- A product with no product_type is NOT a service: funnel_reserve_line reserves it, so the
  -- report must count it (NULL <> 'service' is NULL, which silently dropped the line).
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode)
  VALUES (gen_random_uuid(), 'BL04-NULLTYPE', 'BL04 untyped', NULL, 'serialized');
  v_so2 := pg_temp.new_so(v_cust, 'confirmed', jsonb_build_array(jsonb_build_object(
    'product_id', (SELECT id FROM public.products WHERE sku = 'BL04-NULLTYPE'), 'qty', 2)), v_mgr);
  SELECT count(*)::integer INTO v_n FROM public.rma_reservation_integrity()
   WHERE check_name = 'confirmed_order_under_reserved' AND entity_id = v_so2;
  RAISE NOTICE '%', pg_temp.check('an order of untyped products is checked like any other', v_n = 1, '-> ' || v_n);

  v_out := pg_temp.call(v_mgr, 'SELECT count(*) FROM public.rma_reservation_integrity()');
  RAISE NOTICE '%', pg_temp.check('a manager cannot run it (admin only)', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_tech, 'SELECT count(*) FROM public.rma_reservation_integrity()');
  RAISE NOTICE '%', pg_temp.check('a technician cannot run it', v_out LIKE 'err:42501%', '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('anon cannot execute it',
    NOT has_function_privilege('anon', 'public.rma_reservation_integrity()', 'EXECUTE'));
  RAISE NOTICE '%', pg_temp.check('its search_path pins pg_temp last',
    EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'rma_reservation_integrity' AND proconfig::text LIKE '%search_path=public, pg_temp%'));

  -- ══ 7. The existing data-integrity report was open to every signed-in user ═══
  RAISE NOTICE '--- 7. rma_data_integrity_issues() ---';
  RAISE NOTICE '%', pg_temp.check('the raw findings function is closed to every client role',
    NOT has_function_privilege('authenticated', 'public.rma_data_integrity_issues_unguarded()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rma_data_integrity_issues_unguarded()', 'EXECUTE'));
  v_out := pg_temp.call(v_tech, 'SELECT count(*) FROM public.rma_data_integrity_issues_unguarded()');
  RAISE NOTICE '%', pg_temp.check('...so a technician cannot call it directly', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_tech, 'SELECT count(*) FROM public.rma_data_integrity_issues()');
  RAISE NOTICE '%', pg_temp.check('a technician cannot read the integrity findings', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, 'SELECT count(*) FROM public.rma_data_integrity_issues()');
  RAISE NOTICE '%', pg_temp.check('a sales rep cannot either', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_admin, 'SELECT count(*) FROM public.rma_data_integrity_issues()');
  RAISE NOTICE '%', pg_temp.check('an administrator can', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_admin, 'SELECT count(*) FROM public.rma_data_integrity_summary()');
  RAISE NOTICE '%', pg_temp.check('the summary the screen uses still works for an administrator', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_tech, 'SELECT count(*) FROM public.rma_data_integrity_summary()');
  RAISE NOTICE '%', pg_temp.check('...and still refuses everyone else', v_out LIKE 'err:42501%', '-> ' || v_out);

  RAISE EXCEPTION 'BL04C_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
