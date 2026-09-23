-- ############################################################################
-- #  QUOTE-CONVERSION AND CREDIT-NOTE CONTROLS — BL-05 / I-05 (20260880)
-- #
-- #  Before:
-- #   * convert_quotation_to_so turned a DRAFT or SENT quote into an order
-- #     (the UI only offers it from 'accepted', the database did not care) and
-- #     never looked at validity_until, so an expired quote converted too.
-- #   * issue_credit_note had no cap: 1,200 credited against a 1,000 invoice,
-- #     or 500 then 600 against the same invoice, both succeeded.
-- #   * a credit note's reason was one free-text field, so "credits by reason"
-- #     could not be reported, and nothing required a second person for a big
-- #     or invoice-less credit.
-- #
-- #  HOW TO RUN:
-- #  node scripts/run-sql-test.mjs supabase/tests/quote_conversion_credit_note_controls.sql BL05_TEST_DONE
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
    out := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;
  IF p_email IS NOT NULL THEN
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', '', true);
  END IF;
  RETURN out;
END $f$;

CREATE FUNCTION pg_temp.cn_status(p uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT status FROM public.credit_notes WHERE id = p $f$;

DO $do$
DECLARE
  v_m1    text := 'bl05-mgr1@test.local';
  v_m2    text := 'bl05-mgr2@test.local';
  v_rep   text := 'bl05-rep@test.local';
  v_adm   text := 'bl05-admin@test.local';
  v_tech  text := 'bl05-tech@test.local';
  v_cust  uuid;
  v_prod  uuid := gen_random_uuid();
  v_inv   uuid := gen_random_uuid();
  v_inv2  uuid := gen_random_uuid();
  v_qt    uuid;
  v_cn    uuid;
  v_cn2   uuid;
  v_out   text;
  v_n     integer;
  v_row   record;
  v_a     text;

  -- a draft quotation with one product line
  new_qt  text := $q$
    INSERT INTO public.quotations (id, qt_code, customer_id, status, line_items, subtotal, total, validity_until, created_by)
    VALUES (%L, 'QT-T-' || substr(%L, 1, 8), %L, %L,
            jsonb_build_array(jsonb_build_object('product_id', %L, 'qty', 2, 'unit_price', 50)), 100, 100, %s, %L)
  $q$;
BEGIN
  -- Sections 2-4 prove the CAPS. A threshold already configured on this project would make an
  -- over-cap note fail on the approval rule instead (both are P0001), so start with none.
  DELETE FROM public.rma_config WHERE config_key = 'credit_note_approval_threshold';

  INSERT INTO public.user_roles (user_email, role, status)
  VALUES (v_m1, 'manager', 'active'), (v_m2, 'manager', 'active'), (v_rep, 'sales_rep', 'active'),
         (v_adm, 'admin', 'active'), (v_tech, 'technician', 'active');

  INSERT INTO public.customers (company_name, customer_code, customer_type, email)
  VALUES ('BL05 Co', 'BL05-CUST', 'B2B', 'bl05@example.invalid') RETURNING id INTO v_cust;
  INSERT INTO public.products (id, sku, product_name, product_type)
  VALUES (v_prod, 'BL05-P', 'BL05 product', 'hardware');

  -- ══ 1. Quote conversion ═══════════════════════════════════════════════════
  RAISE NOTICE '--- 1. Only an accepted, valid quote becomes an order ---';
  FOREACH v_a IN ARRAY ARRAY['draft', 'sent', 'declined', 'cancelled', 'expired'] LOOP
    v_qt := gen_random_uuid();
    EXECUTE format(new_qt, v_qt, v_qt::text, v_cust, v_a, v_prod, 'NULL', v_m1);
    v_out := pg_temp.call(v_m1, format('SELECT public.convert_quotation_to_so(%L, %L)', v_qt, v_m1));
    RAISE NOTICE '%', pg_temp.check(format('a %s quote cannot be converted', v_a),
      v_out LIKE 'err:P0001%' AND (SELECT status FROM public.quotations WHERE id = v_qt) = v_a, '-> ' || v_out);
  END LOOP;

  v_qt := gen_random_uuid();
  EXECUTE format(new_qt, v_qt, v_qt::text, v_cust, 'accepted', v_prod, 'NULL', v_m1);
  v_out := pg_temp.call(v_m1, format('SELECT public.convert_quotation_to_so(%L, %L)', v_qt, v_m1));
  RAISE NOTICE '%', pg_temp.check('an accepted quote with no expiry converts', v_out = 'ok'
    AND (SELECT status FROM public.quotations WHERE id = v_qt) = 'converted', '-> ' || v_out);

  v_out := pg_temp.call(v_m1, format('SELECT public.convert_quotation_to_so(%L, %L)', v_qt, v_m1));
  RAISE NOTICE '%', pg_temp.check('converting it a second time is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);

  v_qt := gen_random_uuid();
  EXECUTE format(new_qt, v_qt, v_qt::text, v_cust, 'accepted', v_prod, 'public.rma_today()', v_rep);
  v_out := pg_temp.call(v_rep, format('SELECT public.convert_quotation_to_so(%L, %L)', v_qt, v_rep));
  RAISE NOTICE '%', pg_temp.check('a quote valid until today still converts (the last day counts)', v_out = 'ok', '-> ' || v_out);

  -- expired
  v_qt := gen_random_uuid();
  EXECUTE format(new_qt, v_qt, v_qt::text, v_cust, 'accepted', v_prod, 'public.rma_today() - 1', v_rep);
  v_out := pg_temp.call(v_rep, format('SELECT public.convert_quotation_to_so(%L, %L)', v_qt, v_rep));
  RAISE NOTICE '%', pg_temp.check('an accepted but EXPIRED quote is refused', v_out LIKE 'err:P0001%'
    AND (SELECT status FROM public.quotations WHERE id = v_qt) = 'accepted', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format('SELECT public.convert_quotation_to_so(%L, %L, %L)', v_qt, v_rep, 'customer asked me to'));
  RAISE NOTICE '%', pg_temp.check('a sales rep cannot override expiry, even with a reason', v_out LIKE 'err:P0001%'
    AND (SELECT status FROM public.quotations WHERE id = v_qt) = 'accepted', '-> ' || v_out);
  v_out := pg_temp.call(v_m1, format('SELECT public.convert_quotation_to_so(%L, %L)', v_qt, v_m1));
  RAISE NOTICE '%', pg_temp.check('a manager without a reason is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_m1, format('SELECT public.convert_quotation_to_so(%L, %L, %L)', v_qt, v_m1, '  '));
  RAISE NOTICE '%', pg_temp.check('a blank reason does not count', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_m1, format('SELECT public.convert_quotation_to_so(%L, %L, %L)', v_qt, v_m1, 'ok'));
  RAISE NOTICE '%', pg_temp.check('a one-word reason does not count either', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_m1, format('SELECT public.convert_quotation_to_so(%L, %L, %L)', v_qt, v_m1,
    'Customer confirmed the price in writing on the day it lapsed'));
  RAISE NOTICE '%', pg_temp.check('a manager with a real reason converts it', v_out = 'ok', '-> ' || v_out);
  SELECT override_reason INTO v_a FROM public.sales_orders WHERE quotation_id = v_qt;
  RAISE NOTICE '%', pg_temp.check('the reason is kept on the sales order', v_a LIKE 'Customer confirmed%', '-> ' || coalesce(v_a, '<null>'));

  -- an override reason on a quote that is NOT expired is not recorded
  v_qt := gen_random_uuid();
  EXECUTE format(new_qt, v_qt, v_qt::text, v_cust, 'accepted', v_prod, 'public.rma_today() + 5', v_m1);
  v_out := pg_temp.call(v_m1, format('SELECT public.convert_quotation_to_so(%L, %L, %L)', v_qt, v_m1, 'not needed but supplied'));
  SELECT override_reason INTO v_a FROM public.sales_orders WHERE quotation_id = v_qt;
  RAISE NOTICE '%', pg_temp.check('a reason given for a valid quote is not written down as an override', v_out = 'ok' AND v_a IS NULL, '-> ' || v_out);

  -- ══ 2. Credit notes against an invoice ════════════════════════════════════
  RAISE NOTICE '--- 2. A credit note cannot credit more than was invoiced ---';
  INSERT INTO public.crm_invoices (id, inv_code, customer_id, doc_status, line_items, subtotal, total, created_by)
  VALUES (v_inv, 'INV-T-0001', v_cust, 'posted',
          jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 10, 'unit_price', 100)), 1000, 1000, v_m1);

  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn, 'correction', v_inv, v_cust, 'draft', '[]'::jsonb, 1200, 1200, 'too much', 'billing_error', v_rep);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('1,200 against a 1,000 invoice is refused', v_out LIKE 'err:P0001%' AND pg_temp.cn_status(v_cn) = 'draft', '-> ' || v_out);

  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn, 'correction', v_inv, v_cust, 'draft', '[]'::jsonb, 500, 500, 'first', 'billing_error', v_rep);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('a first credit note of 500 issues', v_out = 'ok' AND pg_temp.cn_status(v_cn) IN ('issued', 'applied'), '-> ' || v_out);

  v_cn2 := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn2, 'correction', v_inv, v_cust, 'draft', '[]'::jsonb, 600, 600, 'second', 'billing_error', v_rep);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn2, v_m1));
  RAISE NOTICE '%', pg_temp.check('a second of 600 after 500 is refused (only 500 is left)', v_out LIKE 'err:P0001%' AND pg_temp.cn_status(v_cn2) = 'draft', '-> ' || v_out);
  UPDATE public.credit_notes SET total = 500, subtotal = 500 WHERE id = v_cn2;
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn2, v_m1));
  RAISE NOTICE '%', pg_temp.check('exactly the 500 that is left is allowed', v_out = 'ok', '-> ' || v_out);

  -- a voided credit note gives the room back
  PERFORM pg_temp.call(v_m1, format('SELECT public.void_credit_note(%L, %L, %L)', v_cn, 'entered in error', v_m1));
  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn, 'correction', v_inv, v_cust, 'draft', '[]'::jsonb, 500, 500, 'again', 'billing_error', v_rep);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('a voided credit note no longer counts against the invoice', v_out = 'ok', '-> ' || v_out);

  -- drafts that were never issued do not count
  INSERT INTO public.crm_invoices (id, inv_code, customer_id, doc_status, line_items, subtotal, total, created_by)
  VALUES (v_inv2, 'INV-T-0002', v_cust, 'posted',
          jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 10, 'unit_price', 100)), 1000, 1000, v_m1);
  INSERT INTO public.credit_notes (type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES ('correction', v_inv2, v_cust, 'draft', '[]'::jsonb, 900, 900, 'draft only', 'billing_error', v_rep);
  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn, 'correction', v_inv2, v_cust, 'draft', '[]'::jsonb, 900, 900, 'real', 'billing_error', v_rep);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('an unissued draft credit note does not use up the invoice', v_out = 'ok', '-> ' || v_out);

  -- per-product quantity cap (returns)
  RAISE NOTICE '--- 3. A return cannot exceed the quantity that was sold ---';
  v_inv2 := gen_random_uuid();
  INSERT INTO public.crm_invoices (id, inv_code, customer_id, doc_status, line_items, subtotal, total, created_by)
  VALUES (v_inv2, 'INV-T-0003', v_cust, 'posted',
          jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 10, 'unit_price', 100)), 1000, 1000, v_m1);
  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn, 'rma_return', v_inv2, v_cust, 'draft',
          jsonb_build_array(jsonb_build_object('product_id', v_prod, 'product_name', 'p', 'qty', 11, 'unit_price', 1, 'restock', false)), 11, 11, 'too many', 'return', v_rep);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('returning 11 of 10 sold is refused even though the money is small', v_out LIKE 'err:P0001%', '-> ' || v_out);
  UPDATE public.credit_notes SET line_items = jsonb_build_array(jsonb_build_object('product_id', v_prod, 'product_name', 'p', 'qty', 4, 'unit_price', 1, 'restock', false)) WHERE id = v_cn;
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('returning 4 of 10 is fine', v_out = 'ok', '-> ' || v_out);
  v_cn2 := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn2, 'rma_return', v_inv2, v_cust, 'draft',
          jsonb_build_array(jsonb_build_object('product_id', v_prod, 'product_name', 'p', 'qty', 7, 'unit_price', 1, 'restock', false)), 7, 7, 'more', 'return', v_rep);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn2, v_m1));
  RAISE NOTICE '%', pg_temp.check('then 7 more (11 in all) is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);
  UPDATE public.credit_notes SET line_items = jsonb_build_array(jsonb_build_object('product_id', v_prod, 'product_name', 'p', 'qty', 6, 'unit_price', 1, 'restock', false)), total = 6, subtotal = 6 WHERE id = v_cn2;
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn2, v_m1));
  RAISE NOTICE '%', pg_temp.check('the remaining 6 is allowed', v_out = 'ok', '-> ' || v_out);

  -- invoice preconditions
  v_inv2 := gen_random_uuid();
  INSERT INTO public.crm_invoices (id, inv_code, customer_id, doc_status, line_items, subtotal, total, created_by)
  VALUES (v_inv2, 'INV-T-0004', v_cust, 'draft', '[]'::jsonb, 1000, 1000, v_m1);
  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn, 'correction', v_inv2, v_cust, 'draft', '[]'::jsonb, 10, 10, 'x', 'billing_error', v_rep);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('a credit note against an invoice that is not posted is refused', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- ══ 4. Reason codes ═══════════════════════════════════════════════════════
  RAISE NOTICE '--- 4. Reason codes ---';
  v_out := pg_temp.call(NULL, format($q$INSERT INTO public.credit_notes (type, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
    VALUES ('discount', %L, 'draft', '[]', 1, 1, 'x', 'made_up_code', 'a')$q$, v_cust));
  RAISE NOTICE '%', pg_temp.check('an invented reason code is refused by the table', v_out LIKE 'err:23514%', '-> ' || v_out);
  FOREACH v_a IN ARRAY ARRAY['price_adjustment', 'return', 'damaged', 'goodwill', 'billing_error', 'rebate'] LOOP
    v_out := pg_temp.call(NULL, format($q$INSERT INTO public.credit_notes (type, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
      VALUES ('discount', %L, 'draft', '[]', 1, 1, 'x', %L, 'a')$q$, v_cust, v_a));
    RAISE NOTICE '%', pg_temp.check(format('reason code "%s" is accepted', v_a), v_out = 'ok', '-> ' || v_out);
  END LOOP;
  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, created_by)
  VALUES (v_cn, 'correction', v_inv, v_cust, 'draft', '[]'::jsonb, 1, 1, 'no code', v_rep);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('a credit note with no reason code cannot be issued', v_out LIKE 'err:P0001%' AND pg_temp.cn_status(v_cn) = 'draft', '-> ' || v_out);

  -- ══ 5. Approval ═══════════════════════════════════════════════════════════
  RAISE NOTICE '--- 5. Approval by a second person ---';
  -- an invoice-less rebate/discount always needs approval, whatever the amount
  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn, 'rebate', v_cust, 'draft', '[]'::jsonb, 5, 5, 'volume rebate', 'rebate', v_m1);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('a 5.00 rebate with no invoice cannot be issued straight away', v_out LIKE 'err:P0001%approval%' AND pg_temp.cn_status(v_cn) = 'draft', '-> ' || v_out);
  v_out := pg_temp.call(v_m1, format('SELECT public.submit_credit_note_for_approval(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('it is submitted for approval', v_out = 'ok' AND pg_temp.cn_status(v_cn) = 'pending_approval', '-> ' || v_out);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('its creator cannot approve it', v_out LIKE 'err:P0001%' AND pg_temp.cn_status(v_cn) = 'pending_approval', '-> ' || v_out);
  v_out := pg_temp.call(v_rep, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_rep));
  RAISE NOTICE '%', pg_temp.check('a sales rep cannot approve it', v_out LIKE 'err:P0001%' AND pg_temp.cn_status(v_cn) = 'pending_approval', '-> ' || v_out);
  v_out := pg_temp.call(v_m2, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m2));
  SELECT * INTO v_row FROM public.credit_notes WHERE id = v_cn;
  RAISE NOTICE '%', pg_temp.check('a second manager approves and issues it', v_out = 'ok' AND v_row.status IN ('issued', 'applied') AND v_row.cn_code IS NOT NULL, '-> ' || v_out);
  RAISE NOTICE '%', pg_temp.check('who approved it, and when, is recorded', v_row.approved_by = v_m2 AND v_row.approved_at IS NOT NULL, '-> ' || coalesce(v_row.approved_by, '<null>'));

  -- a pending credit note is locked from editing
  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn, 'discount', v_cust, 'draft', '[]'::jsonb, 5, 5, 'x', 'goodwill', v_m1);
  PERFORM pg_temp.call(v_m1, format('SELECT public.submit_credit_note_for_approval(%L, %L)', v_cn, v_m1));
  v_out := pg_temp.call(v_m1, format('UPDATE public.credit_notes SET total = 1 WHERE id = %L', v_cn));
  RAISE NOTICE '%', pg_temp.check('a credit note waiting for approval cannot be edited', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_m1, format('UPDATE public.credit_notes SET status = ''issued'' WHERE id = %L', v_cn));
  RAISE NOTICE '%', pg_temp.check('nor can anyone set its status directly', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.call(v_m2, format('SELECT public.return_credit_note_to_draft(%L, %L)', v_cn, v_m2));
  RAISE NOTICE '%', pg_temp.check('an approver can send it back to draft', v_out = 'ok' AND pg_temp.cn_status(v_cn) = 'draft', '-> ' || v_out);

  -- a configurable threshold applies to invoiced credit notes too
  INSERT INTO public.rma_config (config_key, config_value) VALUES ('credit_note_approval_threshold', '500'::jsonb)
  ON CONFLICT (config_key) DO UPDATE SET config_value = '500'::jsonb;
  v_inv2 := gen_random_uuid();
  INSERT INTO public.crm_invoices (id, inv_code, customer_id, doc_status, line_items, subtotal, total, created_by)
  VALUES (v_inv2, 'INV-T-0005', v_cust, 'posted', '[]'::jsonb, 5000, 5000, v_m1);
  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn, 'correction', v_inv2, v_cust, 'draft', '[]'::jsonb, 400, 400, 'small', 'billing_error', v_rep);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('with a threshold of 500, a credit of 400 issues without approval', v_out = 'ok', '-> ' || v_out);
  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn, 'correction', v_inv2, v_cust, 'draft', '[]'::jsonb, 501, 501, 'big', 'billing_error', v_rep);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('...but 501 needs approval', v_out LIKE 'err:P0001%approval%' AND pg_temp.cn_status(v_cn) = 'draft', '-> ' || v_out);
  v_cn2 := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn2, 'correction', v_inv2, v_cust, 'draft', '[]'::jsonb, 500, 500, 'exactly', 'billing_error', v_rep);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn2, v_m1));
  RAISE NOTICE '%', pg_temp.check('...and exactly 500 does not ("above" the threshold)', v_out = 'ok', '-> ' || v_out);

  -- with no threshold configured, an invoiced credit note needs no approval
  DELETE FROM public.rma_config WHERE config_key = 'credit_note_approval_threshold';
  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn, 'correction', v_inv2, v_cust, 'draft', '[]'::jsonb, 900, 900, 'no threshold', 'billing_error', v_rep);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('with no threshold set, a capped invoiced credit note issues as before', v_out = 'ok', '-> ' || v_out);

  -- ══ 6. Grants ═════════════════════════════════════════════════════════════
  RAISE NOTICE '--- 6. Who can call what ---';
  RAISE NOTICE '%', pg_temp.check('anon cannot call the new approval functions',
    NOT has_function_privilege('anon', 'public.submit_credit_note_for_approval(uuid, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.return_credit_note_to_draft(uuid, text)', 'EXECUTE'));
  RAISE NOTICE '%', pg_temp.check('anon cannot call convert_quotation_to_so',
    NOT has_function_privilege('anon', 'public.convert_quotation_to_so(uuid, text, text)', 'EXECUTE'));
  RAISE NOTICE '%', pg_temp.check('only one convert_quotation_to_so exists (no stale 2-argument overload)',
    (SELECT count(*) FROM pg_proc WHERE proname = 'convert_quotation_to_so' AND pronamespace = 'public'::regnamespace) = 1);
  v_out := pg_temp.call(v_rep, format('SELECT public.submit_credit_note_for_approval(%L, %L)', gen_random_uuid(), v_rep));
  RAISE NOTICE '%', pg_temp.check('a sales rep cannot submit for approval', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- ══ 7. A credit note cannot be created already issued, or in someone else's name ══
  RAISE NOTICE '--- 7. Creating a credit note ---';
  -- Every control above lives in issue_credit_note. A signed-in user could INSERT a row that is
  -- already 'issued' (with a balance of their choosing), skipping all of it. Since 20260887 no
  -- client can INSERT a credit note at all — create_credit_note is the only way in — so these
  -- checks go through that path; each keeps the property it was written for.
  v_out := pg_temp.call(v_rep, format($q$INSERT INTO public.credit_notes (type, customer_id, status, line_items, subtotal, total, remaining_balance, reason, reason_code, created_by, cn_code)
    VALUES ('discount', %L, 'issued', '[]', 900, 900, 900, 'self-issued', 'goodwill', %L, 'CN-FAKE-1')$q$, v_cust, v_rep));
  RAISE NOTICE '%', pg_temp.check('a rep cannot insert a credit note that is already issued', v_out LIKE 'err:%'
    AND NOT EXISTS (SELECT 1 FROM public.credit_notes WHERE cn_code = 'CN-FAKE-1'), '-> ' || v_out);
  v_out := pg_temp.call(v_m1, format($q$INSERT INTO public.credit_notes (type, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
    VALUES ('discount', %L, 'pending_approval', '[]', 9, 9, 'skip the queue', 'goodwill', %L)$q$, v_cust, v_m1));
  RAISE NOTICE '%', pg_temp.check('nor one that is already waiting for approval', v_out LIKE 'err:%'
    AND NOT EXISTS (SELECT 1 FROM public.credit_notes WHERE reason = 'skip the queue'), '-> ' || v_out);

  -- created_by names the maker; the approval rule is "not the same person". It must come from the login.
  v_out := pg_temp.call(v_m1, format($q$SELECT public.create_credit_note('discount', %L, 'forged maker', 'goodwill',
    '[{"product_name":"Goodwill","qty":1,"unit_price":5}]'::jsonb, NULL, NULL, NULL, 'somebody.else@test.local')$q$, v_cust));
  SELECT created_by INTO v_a FROM public.credit_notes WHERE reason = 'forged maker';
  RAISE NOTICE '%', pg_temp.check('created_by is taken from the login, not from what the browser sent', v_out = 'ok' AND v_a = v_m1, '-> ' || coalesce(v_a, '<none>'));
  -- so a manager cannot dodge "not the creator" by writing another name
  SELECT id INTO v_cn FROM public.credit_notes WHERE reason = 'forged maker';
  PERFORM pg_temp.call(v_m1, format('SELECT public.submit_credit_note_for_approval(%L, %L)', v_cn, v_m1));
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('...so the forger still cannot approve their own note', v_out LIKE 'err:P0001%' AND pg_temp.cn_status(v_cn) = 'pending_approval', '-> ' || v_out);

  -- fields only the RPCs may set cannot be sent at all: create_credit_note has no parameter for them
  v_out := pg_temp.call(v_m1, format($q$SELECT public.create_credit_note('discount', %L, 'sneaky fields', 'goodwill',
    '[{"product_name":"Goodwill","qty":1,"unit_price":7}]'::jsonb, NULL, NULL, NULL, %L)$q$, v_cust, v_m1));
  SELECT * INTO v_row FROM public.credit_notes WHERE reason = 'sneaky fields';
  RAISE NOTICE '%', pg_temp.check('approved_by, issued_at, cn_code, balances start empty on a new note',
    v_out = 'ok' AND v_row.approved_by IS NULL AND v_row.approved_at IS NULL AND v_row.issued_at IS NULL AND v_row.cn_code IS NULL
    AND v_row.remaining_balance = 0 AND v_row.applied_amount = 0 AND v_row.total = 7, '-> ' || v_out);

  -- ...and they cannot be rewritten afterwards either; a draft's reason changes through update_credit_note
  SELECT id INTO v_cn FROM public.credit_notes WHERE reason = 'sneaky fields';
  v_out := pg_temp.call(v_m1, format($q$UPDATE public.credit_notes SET created_by = 'other@test.local', approved_by = 'boss@test.local',
    approved_at = now(), cn_code = 'CN-FAKE-3', remaining_balance = 5000, applied_amount = 1, issued_at = now(), reason = 'edited reason' WHERE id = %L$q$, v_cn));
  SELECT * INTO v_row FROM public.credit_notes WHERE id = v_cn;
  RAISE NOTICE '%', pg_temp.check('a direct UPDATE of the RPC-owned fields is refused, and nothing moves', v_out LIKE 'err:P0001%'
    AND v_row.reason = 'sneaky fields' AND v_row.created_by = v_m1 AND v_row.approved_by IS NULL
    AND v_row.cn_code IS NULL AND v_row.remaining_balance = 0 AND v_row.applied_amount = 0 AND v_row.issued_at IS NULL, '-> ' || v_out);
  v_out := pg_temp.call(v_m1, format($q$SELECT public.update_credit_note(%L, NULL, '{"reason":"edited reason"}'::jsonb, %L)$q$, v_cn, v_m1));
  SELECT * INTO v_row FROM public.credit_notes WHERE id = v_cn;
  RAISE NOTICE '%', pg_temp.check('a draft can still be edited (its reason) through update_credit_note', v_out = 'ok'
    AND v_row.reason = 'edited reason' AND v_row.created_by = v_m1 AND v_row.cn_code IS NULL, '-> ' || v_out);

  -- the owner (RPCs, backup restore) is not affected
  v_out := pg_temp.call(NULL, format($q$INSERT INTO public.credit_notes (type, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by, cn_code)
    VALUES ('discount', %L, 'issued', '[]', 1, 1, 'restored', 'goodwill', 'restore@test.local', 'CN-RESTORED-1')$q$, v_cust));
  RAISE NOTICE '%', pg_temp.check('an RPC (which is what Backup & Restore is) can still insert an issued note', v_out = 'ok', '-> ' || v_out);

  -- ══ 8. Found by the independent review ═════════════════════════════════════
  RAISE NOTICE '--- 8. Review findings ---';

  -- H1: an administrator was not stopped from writing a credit note's STATUS directly
  -- (the transition guard has an admin bypass), which skips every check in issue_credit_note.
  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn, 'correction', v_inv, v_cust, 'draft', '[]'::jsonb, 250000, 250000, 'admin edit', 'billing_error', v_rep);
  v_out := pg_temp.call(v_adm, format('UPDATE public.credit_notes SET status = ''issued'' WHERE id = %L', v_cn));
  RAISE NOTICE '%', pg_temp.check('an administrator cannot set a credit note to issued directly', pg_temp.cn_status(v_cn) = 'draft', '-> ' || v_out || ' / ' || pg_temp.cn_status(v_cn));
  v_out := pg_temp.call(v_adm, format('UPDATE public.credit_notes SET status = ''pending_approval'' WHERE id = %L', v_cn));
  RAISE NOTICE '%', pg_temp.check('...nor to pending_approval (which would skip the submit checks)', pg_temp.cn_status(v_cn) = 'draft', '-> ' || v_out);

  -- L10: trying to rewrite an issued note's number used to be refused loudly; keep it loud
  v_inv2 := gen_random_uuid();
  INSERT INTO public.crm_invoices (id, inv_code, customer_id, doc_status, line_items, subtotal, total, created_by)
  VALUES (v_inv2, 'INV-T-0089', v_cust, 'posted', '[]'::jsonb, 100, 100, v_m1);
  v_cn2 := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn2, 'correction', v_inv2, v_cust, 'draft', '[]'::jsonb, 1, 1, 'to be issued', 'billing_error', v_rep);
  PERFORM pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn2, v_m1));
  v_out := pg_temp.call(v_m1, format('UPDATE public.credit_notes SET cn_code = ''CN-2026-99999'' WHERE id = %L', v_cn2));
  RAISE NOTICE '%', pg_temp.check('rewriting the number of an issued note is refused, not silently ignored', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- M4: a credit-note line whose quantity is not a plain number must not slip past the unit cap
  v_inv2 := gen_random_uuid();
  INSERT INTO public.crm_invoices (id, inv_code, customer_id, doc_status, line_items, subtotal, total, created_by)
  VALUES (v_inv2, 'INV-T-0090', v_cust, 'posted',
          jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 10, 'unit_price', 100)), 1000, 1000, v_m1);
  FOREACH v_a IN ARRAY ARRAY['1e3', '-5', ' 10', '+10', 'abc'] LOOP
    v_cn := gen_random_uuid();
    INSERT INTO public.credit_notes (id, type, source_invoice_id, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
    VALUES (v_cn, 'rma_return', v_inv2, v_cust, 'draft',
            jsonb_build_array(jsonb_build_object('product_id', v_prod, 'product_name', 'p', 'qty', v_a, 'unit_price', 0.001, 'restock', false)), 1, 1, 'odd qty', 'return', v_rep);
    v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
    RAISE NOTICE '%', pg_temp.check(format('a credit-note line with quantity "%s" is refused', v_a), v_out LIKE 'err:P0001%' AND pg_temp.cn_status(v_cn) = 'draft', '-> ' || v_out);
  END LOOP;

  -- M5: ticket_id decides which ticket issue_credit_note closes, so a client must not be able to redirect it
  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by, ticket_id)
  VALUES (v_cn, 'rma_return', v_cust, 'draft', '[]'::jsonb, 1, 1, 'ticket pin', 'return', v_rep, NULL);
  v_out := pg_temp.call(v_rep, format('UPDATE public.credit_notes SET ticket_id = %L WHERE id = %L', gen_random_uuid(), v_cn));
  RAISE NOTICE '%', pg_temp.check('a rep cannot point their draft at another ticket', (SELECT ticket_id FROM public.credit_notes WHERE id = v_cn) IS NULL, '-> ' || v_out);

  -- M3: an invoice-less "correction" was as free as a rebate but escaped the approval rule
  v_out := pg_temp.call(v_m1, format($q$SELECT public.rma_credit_note_needs_approval('correction', false, 5)$q$));
  RAISE NOTICE '%', pg_temp.check('an invoice-less correction is asked about like a rebate', v_out = 'ok');
  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn, 'correction', v_cust, 'draft', '[]'::jsonb, 5, 5, 'no invoice', 'billing_error', v_rep);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('an invoice-less correction cannot be issued straight away', v_out LIKE 'err:P0001%approval%' AND pg_temp.cn_status(v_cn) = 'draft', '-> ' || v_out);
  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn, 'rma_return', v_cust, 'draft', '[]'::jsonb, 5, 5, 'ticket return', 'return', v_rep);
  v_out := pg_temp.call(v_m1, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m1));
  RAISE NOTICE '%', pg_temp.check('an invoice-less RMA return (from a ticket) still issues directly', v_out = 'ok', '-> ' || v_out);

  -- M9: what the approver approves is what gets issued. An administrator can edit a pending note
  -- (the settled lock has an admin bypass), so the note is fingerprinted when submitted.
  v_cn := gen_random_uuid();
  INSERT INTO public.credit_notes (id, type, customer_id, status, line_items, subtotal, total, reason, reason_code, created_by)
  VALUES (v_cn, 'rebate', v_cust, 'draft', '[]'::jsonb, 5, 5, 'approve me', 'rebate', v_m1);
  PERFORM pg_temp.call(v_m1, format('SELECT public.submit_credit_note_for_approval(%L, %L)', v_cn, v_m1));
  UPDATE public.credit_notes SET total = 5000, subtotal = 5000 WHERE id = v_cn;   -- edited while waiting
  v_out := pg_temp.call(v_m2, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m2));
  RAISE NOTICE '%', pg_temp.check('a note changed after it was submitted cannot be issued as approved', v_out LIKE 'err:P0001%changed%' AND pg_temp.cn_status(v_cn) = 'pending_approval', '-> ' || v_out);
  UPDATE public.credit_notes SET total = 5, subtotal = 5 WHERE id = v_cn;         -- put back
  v_out := pg_temp.call(v_m2, format('SELECT public.issue_credit_note(%L, %L)', v_cn, v_m2));
  RAISE NOTICE '%', pg_temp.check('...but the unchanged note issues fine', v_out = 'ok', '-> ' || v_out);

  -- L15: the approval rule reveals a finance setting; only managers may ask
  v_out := pg_temp.call(v_tech, $q$SELECT public.rma_credit_note_needs_approval('discount', true, 1)$q$);
  RAISE NOTICE '%', pg_temp.check('a technician cannot probe the approval threshold', v_out LIKE 'err:%', '-> ' || v_out);
  v_out := pg_temp.call(v_m1, $q$SELECT public.rma_credit_note_needs_approval('discount', true, 1)$q$);
  RAISE NOTICE '%', pg_temp.check('a manager can', v_out = 'ok', '-> ' || v_out);

  RAISE EXCEPTION 'BL05_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
