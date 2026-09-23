-- ############################################################################
-- #  CREDIT NOTE LINES — W2 / L-01, fourth document type (20260887)
-- #
-- #  HOW TO RUN:
-- #  node scripts/run-sql-test.mjs supabase/tests/credit_note_lines.sql BL14_TEST_DONE
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
  v_rep    text := 'bl14-rep@test.local';
  v_rep2   text := 'bl14-rep2@test.local';
  v_mgr    text := 'bl14-mgr@test.local';
  v_mgr2   text := 'bl14-mgr2@test.local';
  v_tech   text := 'bl14-tech@test.local';
  v_acct   text := 'bl14-acct@test.local';
  v_cust   uuid;
  v_cust2  uuid;
  v_p1     uuid := gen_random_uuid();
  v_wh     uuid;
  v_inv    uuid := gen_random_uuid();
  v_inv2   uuid := gen_random_uuid();
  v_cn     public.credit_notes;
  v_cn2    public.credit_notes;
  v_out    text;
  v_n      integer;
  v_lines  jsonb;
  v_tk     uuid;
  v_tk2    uuid;
  v_inv3   uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES (v_rep, 'sales_rep', 'active'), (v_rep2, 'sales_rep', 'active'), (v_mgr, 'manager', 'active'),
         (v_mgr2, 'manager', 'active'), (v_tech, 'technician', 'active'), (v_acct, 'accountant', 'active');
  INSERT INTO public.products (id, sku, product_name, product_type) VALUES (v_p1, 'BL14-P1', 'BL14 router', 'hardware');
  INSERT INTO public.warehouses (name, code, warehouse_type) VALUES ('BL14 WH', 'BL14-WH', 'main') RETURNING id INTO v_wh;
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('BL14 Customer', 'BL14-C1', 'B2B') RETURNING id INTO v_cust;
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('BL14 Other', 'BL14-C2', 'B2B') RETURNING id INTO v_cust2;
  -- posted invoices, set up as the owner: one for this customer, one for another
  -- v_inv is assigned to v_rep (a rep links only an invoice they can read);
  -- v_inv3 is the same customer's, raised by a manager for nobody in particular
  INSERT INTO public.crm_invoices (id, inv_code, customer_id, created_by, assigned_rep, doc_status, payment_status, subtotal, total, line_items)
  VALUES (v_inv, 'INV-BL14-1', v_cust, v_mgr, v_rep, 'posted', 'unpaid', 1000, 1000,
          jsonb_build_array(jsonb_build_object('product_id', v_p1, 'product_name', 'BL14 router', 'qty', 10, 'unit_price', 100))),
         (v_inv2, 'INV-BL14-2', v_cust2, v_mgr, NULL, 'posted', 'unpaid', 1000, 1000, '[]'),
         (v_inv3, 'INV-BL14-3', v_cust,  v_mgr, NULL, 'posted', 'unpaid', 1000, 1000, '[]');
  INSERT INTO public.rma_tickets (rma_number, customer_id, customer_name, priority) VALUES ('RMA-BL14-1', v_cust,  'BL14 Customer', 'Medium') RETURNING id INTO v_tk;
  INSERT INTO public.rma_tickets (rma_number, customer_id, customer_name, priority) VALUES ('RMA-BL14-2', v_cust2, 'BL14 Other',    'Medium') RETURNING id INTO v_tk2;

  v_lines := jsonb_build_array(
    jsonb_build_object('product_id', v_p1, 'product_name', 'BL14 router', 'qty', 2, 'unit_price', 100, 'discount_pct', 10, 'tax_pct', 14,
                       'restock', true, 'warehouse_id', v_wh));

  -- ══ 1. create_credit_note ═════════════════════════════════════════════════
  RAISE NOTICE '--- 1. create_credit_note ---';
  PERFORM pg_temp.as_user(v_rep);
  v_cn := public.create_credit_note('rma_return', v_cust, 'Returned faulty', 'return', v_lines, v_inv, NULL, v_rep, v_rep);
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a sales rep creates a draft credit note, attributed to the login', v_cn.status = 'draft' AND v_cn.created_by = v_rep AND v_cn.cn_code IS NULL);
  RAISE NOTICE '%', pg_temp.check('the invoice number is copied from the invoice, not taken from the caller', v_cn.source_invoice_number = 'INV-BL14-1');
  RAISE NOTICE '%', pg_temp.check('an RMA return starts pending restock', v_cn.restock_status = 'pending');
  -- 2 x 100 = 200, less 10% = 180, plus 14% tax = 25.20 -> 205.20
  RAISE NOTICE '%', pg_temp.check('its money is worked out in the database from the lines (200 / 20 / 25.20 / 205.20)',
    v_cn.subtotal = 200 AND v_cn.discount_amount = 20 AND v_cn.tax_amount = 25.20 AND v_cn.total = 205.20,
    format('-> %s / %s / %s / %s', v_cn.subtotal, v_cn.discount_amount, v_cn.tax_amount, v_cn.total));
  RAISE NOTICE '%', pg_temp.check('the line keeps its restock flag and warehouse, in the row and the mirror',
    (SELECT restock AND warehouse_id = v_wh FROM public.credit_note_lines WHERE credit_note_id = v_cn.id)
    AND (v_cn.line_items->0->>'restock')::boolean AND (v_cn.line_items->0->>'warehouse_id')::uuid = v_wh);

  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_credit_note('rebate', %L, 'Goodwill', 'goodwill', '[{"product_name":"Goodwill gesture","qty":1,"unit_price":50}]'::jsonb, NULL, NULL, NULL, %L)$q$, v_cust, v_rep));
  RAISE NOTICE '%', pg_temp.check('a free-text line (no product) is allowed on a credit note', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_credit_note('rebate', %L, 'x', 'goodwill', %L::jsonb, NULL, NULL, NULL, %L)$q$, v_cust,
    jsonb_build_array(jsonb_build_object('product_id', gen_random_uuid(), 'product_name', 'ghost', 'qty', 1, 'unit_price', 1)), v_rep));
  RAISE NOTICE '%', pg_temp.check('a product that does not exist is refused', v_out LIKE 'err:P0001%does not exist%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_credit_note('correction', %L, 'x', 'billing_error', %L::jsonb, NULL, NULL, NULL, %L)$q$, v_cust,
    jsonb_build_array(jsonb_build_object('product_name', 'x', 'qty', 1, 'unit_price', 1, 'warehouse_id', gen_random_uuid())), v_rep));
  RAISE NOTICE '%', pg_temp.check('a warehouse that does not exist is refused', v_out LIKE 'err:P0001%warehouse does not exist%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_credit_note('correction', %L, 'x', 'billing_error', '[{"product_name":"x","qty":1,"unit_price":1,"restock":"false"}]'::jsonb, NULL, NULL, NULL, %L)$q$, v_cust, v_rep));
  RAISE NOTICE '%', pg_temp.check('restock must be a real true/false (a string "false" is not guessed at)', v_out LIKE 'err:P0001%restock%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_credit_note('rebate', %L, 'x', 'goodwill', '[{"product_name":"x","qty":1,"unit_price":1}]'::jsonb, %L, NULL, NULL, %L)$q$, v_cust, v_inv2, v_rep));
  RAISE NOTICE '%', pg_temp.check('another customer''s invoice is refused', v_out LIKE 'err:P0001%another customer%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_credit_note('rebate', %L, '   ', 'goodwill', '[{"product_name":"x","qty":1,"unit_price":1}]'::jsonb, NULL, NULL, NULL, %L)$q$, v_cust, v_rep));
  RAISE NOTICE '%', pg_temp.check('a blank reason is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_tech, format($q$SELECT public.create_credit_note('rebate', %L, 'x', 'goodwill', '[{"product_name":"x","qty":1,"unit_price":1}]'::jsonb, NULL, NULL, NULL, %L)$q$, v_cust, v_tech));
  RAISE NOTICE '%', pg_temp.check('a technician cannot create one (20260781)', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$INSERT INTO public.credit_notes (type, customer_id, status, line_items, reason, created_by) VALUES ('rebate', %L, 'draft', '[]', 'x', %L)$q$, v_cust, v_rep));
  RAISE NOTICE '%', pg_temp.check('a direct INSERT is refused', v_out LIKE 'err:42501%', '-> ' || v_out);

  -- ══ 2. The credited money is always the lines ═══════════════════════════════
  RAISE NOTICE '--- 2. Money = lines ---';
  v_out := pg_temp.call(v_rep, format($q$UPDATE public.credit_notes SET total = 5000, remaining_balance = 5000 WHERE id = %L$q$, v_cn.id));
  RAISE NOTICE '%', pg_temp.check('a draft''s total cannot be written directly (issue_credit_note credits exactly this figure)', v_out LIKE 'err:P0001%'
    AND (SELECT total FROM public.credit_notes WHERE id = v_cn.id) = 205.20, '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$UPDATE public.credit_notes SET line_items = '[{"product_name":"x","qty":1,"unit_price":1}]'::jsonb WHERE id = %L$q$, v_cn.id));
  RAISE NOTICE '%', pg_temp.check('nor its lines', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- ══ 3. update_credit_note ═════════════════════════════════════════════════
  RAISE NOTICE '--- 3. update_credit_note ---';
  v_out := pg_temp.call(v_rep2, format($q$SELECT public.update_credit_note(%L, NULL, '{"reason":"hijack"}'::jsonb, %L)$q$, v_cn.id, v_rep2));
  RAISE NOTICE '%', pg_temp.check('another sales rep cannot edit it', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_credit_note(%L, %L::jsonb, '{"reason":"Returned faulty, 1 unit"}'::jsonb, %L)$q$, v_cn.id,
    jsonb_set(v_lines, '{0,qty}', '1'::jsonb), v_rep));
  RAISE NOTICE '%', pg_temp.check('the owner changes the lines; the total follows them (102.60)', v_out = 'ok'
    AND (SELECT total = 102.60 AND reason = 'Returned faulty, 1 unit' FROM public.credit_notes WHERE id = v_cn.id), '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_credit_note(%L, NULL, '{"total":1}'::jsonb, %L)$q$, v_cn.id, v_rep));
  RAISE NOTICE '%', pg_temp.check('a field outside the list is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- ══ 4. Submit and issue still work on the mirror; the credit is the lines ══
  RAISE NOTICE '--- 4. Issuing ---';
  v_out := pg_temp.call(v_mgr, format('SELECT public.submit_credit_note_for_approval(%L, %L)', v_cn.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('it can be submitted for approval', v_out = 'ok' OR v_out LIKE 'err:P0001%not need%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.update_credit_note(%L, NULL, '{"reason":"changed while waiting"}'::jsonb, %L)$q$, v_cn.id, v_rep));
  RAISE NOTICE '%', pg_temp.check('a note awaiting approval cannot be edited (its fingerprint stays true)',
    v_out LIKE 'err:P0001%' OR (SELECT status FROM public.credit_notes WHERE id = v_cn.id) = 'draft', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr2, format('SELECT public.issue_credit_note(%L, %L)', v_cn.id, v_mgr2));
  RAISE NOTICE '%', pg_temp.check('a second manager issues it', v_out = 'ok' AND (SELECT status FROM public.credit_notes WHERE id = v_cn.id) IN ('issued', 'applied'), '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('the invoice is credited exactly what the lines add up to',
    (SELECT amount_paid = 102.60 FROM public.crm_invoices WHERE id = v_inv),
    '-> ' || (SELECT amount_paid FROM public.crm_invoices WHERE id = v_inv));
  v_out := pg_temp.call(v_mgr, format($q$UPDATE public.credit_notes SET restock_status = 'restocked' WHERE id = %L$q$, v_cn.id));
  RAISE NOTICE '%', pg_temp.check('an issued note can still be marked restocked (creditNotes.restoreUnits)', v_out = 'ok'
    AND (SELECT restock_status FROM public.credit_notes WHERE id = v_cn.id) = 'restocked', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.update_credit_note(%L, NULL, '{"reason":"after issue"}'::jsonb, %L)$q$, v_cn.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('an issued note cannot be edited', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- ══ 5. Read access follows the note ═══════════════════════════════════════
  RAISE NOTICE '--- 5. Read access ---';
  PERFORM pg_temp.as_user(v_acct);
  SELECT count(*)::integer INTO v_n FROM public.credit_note_lines WHERE credit_note_id = v_cn.id;
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('an accountant sees a credit note''s lines', v_n = 1, '-> ' || v_n);
  PERFORM pg_temp.as_user(v_tech);
  SELECT count(*)::integer INTO v_n FROM public.credit_note_lines WHERE credit_note_id = v_cn.id;
  PERFORM pg_temp.as_owner();
  RAISE NOTICE '%', pg_temp.check('a technician sees none', v_n = 0, '-> ' || v_n);

  -- ══ 6. Access ═══════════════════════════════════════════════════════════════
  RAISE NOTICE '--- 6. Access ---';
  v_out := pg_temp.call(v_rep, format($q$INSERT INTO public.credit_note_lines (credit_note_id, line_no, product_name, qty, unit_price) VALUES (%L, 9, 'x', 1, 1)$q$, v_cn.id));
  RAISE NOTICE '%', pg_temp.check('a client cannot write credit_note_lines', v_out LIKE 'err:%', '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('anon cannot call the RPCs; no client can call the writer',
    NOT has_function_privilege('anon', 'public.create_credit_note(text, uuid, text, text, jsonb, uuid, uuid, text, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.update_credit_note(uuid, jsonb, jsonb, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._credit_note_write_lines(uuid, jsonb)', 'EXECUTE'));

  -- ══ 7. Review findings (each failed before its fix) ═════════════════════════
  RAISE NOTICE '--- 7. Review findings ---';
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_credit_note('rma_return', %L, 'x', 'return', '[{"product_name":"x","qty":1,"unit_price":1}]'::jsonb, NULL, %L, NULL, %L)$q$, v_cust, v_tk2, v_rep));
  RAISE NOTICE '%', pg_temp.check('another customer''s RMA ticket is refused (issuing would close it)', v_out LIKE 'err:P0001%ticket%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format($q$SELECT public.create_credit_note('rma_return', %L, 'x', 'return', '[{"product_name":"x","qty":1,"unit_price":1}]'::jsonb, NULL, %L, NULL, %L)$q$, v_cust, v_tk, v_rep));
  RAISE NOTICE '%', pg_temp.check('the customer''s own ticket is accepted', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_credit_note('rma_return', %L, 'x', 'return', '[{"product_name":"x","qty":1,"unit_price":99999}]'::jsonb, NULL, NULL, NULL, %L)$q$, v_cust, v_mgr));
  RAISE NOTICE '%', pg_temp.check('an RMA return with neither ticket nor invoice is refused (it would skip both approval and caps)', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_rep2, format($q$SELECT public.create_credit_note('rebate', %L, 'x', 'goodwill', '[{"product_name":"x","qty":1,"unit_price":1}]'::jsonb, %L, NULL, NULL, %L)$q$, v_cust, v_inv3, v_rep2));
  RAISE NOTICE '%', pg_temp.check('a sales rep cannot link an invoice they cannot read', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.create_credit_note('rebate', %L, 'x', 'goodwill', '[{"product_name":"x","qty":1,"unit_price":1}]'::jsonb, %L, NULL, NULL, %L)$q$, v_cust, v_inv3, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a manager can', v_out = 'ok', '-> ' || v_out);
  PERFORM pg_temp.as_user(v_mgr);
  v_cn2 := public.create_credit_note('rebate', v_cust, 'drift', 'goodwill', '[{"product_name":"x","qty":2,"unit_price":10}]'::jsonb, NULL, NULL, NULL, v_mgr);
  PERFORM pg_temp.as_owner();
  -- as the owner (like a backfilled note returned to draft): the mirror disagrees with the rows
  UPDATE public.credit_notes SET line_items = '[{"product_name":"x","qty":"2.5","unit_price":10}]', total = 25 WHERE id = v_cn2.id;
  v_out := pg_temp.call(v_mgr, format($q$SELECT public.update_credit_note(%L, NULL, '{"reason":"header only"}'::jsonb, %L)$q$, v_cn2.id, v_mgr));
  RAISE NOTICE '%', pg_temp.check('a header-only edit rebuilds the mirror and total from the rows', v_out = 'ok'
    AND (SELECT total = 20 AND (line_items->0->>'qty')::int = 2 FROM public.credit_notes WHERE id = v_cn2.id), '-> ' || v_out);

  RAISE EXCEPTION 'BL14_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
