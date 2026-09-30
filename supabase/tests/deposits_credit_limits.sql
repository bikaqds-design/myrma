-- supabase/tests/deposits_credit_limits.sql — A-06a (20260919), rolled back.
-- A customer with a limit of 1 000: an invoice over it is refused until a
-- manager approves it with a reason; a sales order is refused until a deposit
-- brings the balance down; a deposit posts to Customer deposits, moves to
-- receivables when applied, and is refunded from deposits.
-- #  node scripts/run-sql-test.mjs supabase/tests/deposits_credit_limits.sql A06A_TEST_DONE

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT CASE WHEN p_ok THEN 'PASS  ' || p_label ELSE 'FAIL  ' || p_label || ' ' || COALESCE(p_detail, '') END
$f$;
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
CREATE FUNCTION pg_temp.try(p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM pg_temp.as_user(p_email);
  EXECUTE p_sql;
  PERFORM pg_temp.as_owner();
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_temp.as_owner();
  RETURN 'err:' || SQLSTATE || ' ' || SQLERRM;
END $f$;
CREATE FUNCTION pg_temp.invoice(p_email text, p_cust uuid, p_prod uuid, p_amount numeric) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v public.crm_invoices;
BEGIN
  PERFORM pg_temp.as_user(p_email);
  v := public.create_crm_invoice(p_cust, jsonb_build_array(jsonb_build_object('product_id', p_prod, 'product_name', 'A06 service',
         'qty', 1, 'unit_price', p_amount, 'tax_pct', 0)), CURRENT_DATE + 30, NULL, NULL, NULL, NULL, p_email);
  PERFORM pg_temp.as_owner();
  RETURN v.id;
END $f$;
-- one account's movement on the entries of one source document
CREATE FUNCTION pg_temp.moved(p_source uuid, p_role text) RETURNS numeric LANGUAGE sql AS $f$
  SELECT COALESCE(sum(l.debit - l.credit), 0) FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id
   WHERE e.source_id = p_source AND l.account_id = (SELECT account_id FROM public.posting_rules WHERE role = p_role)
$f$;

DO $do$
DECLARE
  mgr  text := 'a06-mgr@test.local';
  mgr2 text := 'a06-mgr2@test.local';
  acc  text := 'a06-acc@test.local';
  rep  text := 'a06-rep@test.local';
  v_cust uuid; v_other uuid; v_free uuid; v_prod uuid := gen_random_uuid();
  inv1 uuid; inv2 uuid; inv3 uuid; big uuid;
  so public.sales_orders; so_other public.sales_orders;
  dep uuid; dep2 uuid; pay uuid; rf uuid; app uuid;
  v_row record; v_n numeric;
  r text;
  res text[] := '{}';
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES
    (mgr, 'manager', 'active'), (mgr2, 'manager', 'active'), (acc, 'accountant', 'active'), (rep, 'sales_rep', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type, credit_limit, currency) VALUES ('A06 Co', 'A06-C1', 'B2B', 1000, 'EGP') RETURNING id INTO v_cust;
  INSERT INTO public.customers (company_name, customer_code, customer_type, currency) VALUES ('A06 Other', 'A06-C2', 'B2B', 'EGP') RETURNING id INTO v_other;
  INSERT INTO public.customers (company_name, customer_code, customer_type, currency) VALUES ('A06 No limit', 'A06-C3', 'B2B', 'EGP') RETURNING id INTO v_free;
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode) VALUES (v_prod, 'A06-SVC', 'A06 service', 'service', 'serialized');

  -- 1. within the limit
  inv1 := pg_temp.invoice(mgr, v_cust, v_prod, 600);
  r := pg_temp.try(mgr, format($$SELECT public.post_invoice(%L, %L)$$, inv1, mgr));
  res := res || pg_temp.check('an invoice within the limit posts (600 of 1 000)', r = 'ok', r);
  PERFORM pg_temp.as_user(rep);
  SELECT * INTO v_row FROM public.rma_customer_credit_status(v_cust);
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('the credit status: 600 owed, 400 available (a sales rep can read it)',
    v_row.credit_limit = 1000 AND v_row.open_invoices = 600 AND v_row.exposure = 600 AND v_row.available = 400, v_row.exposure || '/' || v_row.available);

  -- 2. over the limit: refused until a manager approves it
  inv2 := pg_temp.invoice(mgr, v_cust, v_prod, 500);
  r := pg_temp.try(mgr, format($$SELECT public.post_invoice(%L, %L)$$, inv2, mgr));
  res := res || pg_temp.check('an invoice over the limit is refused, naming the customer and the figures',
    r LIKE 'err:P0001%A06 Co over its credit limit%600.00%500.00%1,000.00%', r);
  r := pg_temp.try(rep, format($$SELECT public.approve_credit_override('invoice', %L, 'regular customer, paying Friday')$$, inv2));
  res := res || pg_temp.check('a sales rep cannot approve going over', r LIKE 'err:42501%', r);
  r := pg_temp.try(mgr, format($$SELECT public.approve_credit_override('invoice', %L, 'ok')$$, inv2));
  res := res || pg_temp.check('the approval needs a reason of ten characters', r LIKE 'err:P0001%10 characters%', r);
  r := pg_temp.try(mgr2, format($$SELECT public.approve_credit_override('invoice', %L, 'regular customer, paying Friday')$$, inv2));
  r := pg_temp.try(mgr, format($$SELECT public.post_invoice(%L, %L)$$, inv2, mgr));
  res := res || pg_temp.check('with a manager''s approval it posts, and the approval stays on the invoice',
    r = 'ok' AND (SELECT credit_override_by FROM public.crm_invoices WHERE id = inv2) = mgr2
    AND (SELECT credit_override_reason FROM public.crm_invoices WHERE id = inv2) = 'regular customer, paying Friday', r);

  -- 3. an approval covers the amount approved, not a larger one
  inv3 := pg_temp.invoice(mgr, v_cust, v_prod, 50);
  r := pg_temp.try(mgr, format($$SELECT public.approve_credit_override('invoice', %L, 'small top-up, approved')$$, inv3));
  PERFORM pg_temp.as_user(mgr);
  PERFORM public.update_crm_invoice(inv3, jsonb_build_array(jsonb_build_object('product_id', v_prod, 'product_name', 'A06 service',
            'qty', 1, 'unit_price', 80, 'tax_pct', 0)), '{}'::jsonb, mgr);
  PERFORM pg_temp.as_owner();
  r := pg_temp.try(mgr, format($$SELECT public.post_invoice(%L, %L)$$, inv3, mgr));
  res := res || pg_temp.check('an invoice raised after its approval (50 → 80) is refused again', r LIKE 'err:P0001%credit limit%', r);

  -- 4. a sales order is checked at approval; a deposit brings the balance down
  PERFORM pg_temp.as_user(mgr);
  so := public.create_sales_order(v_cust, jsonb_build_array(jsonb_build_object('product_id', v_prod, 'product_name', 'A06 service',
          'qty', 1, 'unit_price', 300, 'tax_pct', 0)), NULL, NULL, NULL, NULL, NULL, mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.sales_orders SET status = 'sent' WHERE id = so.id;
  r := pg_temp.try(mgr2, format($$SELECT public.approve_sales_order(%L, %L)$$, so.id, mgr2));
  res := res || pg_temp.check('approving an order over the limit is refused (1 100 owed + 300)', r LIKE 'err:P0001%sales order takes A06 Co over%', r);

  PERFORM pg_temp.as_user(acc);
  dep := public.record_customer_deposit(v_cust, 500, 'bank_transfer', 'DEP-1', CURRENT_DATE, NULL, so.id, NULL, NULL, acc);
  PERFORM pg_temp.as_owner();
  SELECT * INTO v_row FROM public.payments WHERE id = dep;
  res := res || pg_temp.check('the deposit is recorded as a numbered payment, marked as a deposit on the order',
    v_row.is_deposit AND v_row.sales_order_id = so.id AND v_row.payment_code LIKE 'PAY-%' AND v_row.unapplied_amount = 500, v_row.payment_code);
  res := res || pg_temp.check('it posts to Customer deposits, not receivables',
    pg_temp.moved(dep, 'customer_deposits') = -500 AND pg_temp.moved(dep, 'accounts_receivable') = 0 AND pg_temp.moved(dep, 'bank') = 500,
    pg_temp.moved(dep, 'customer_deposits') || '/' || pg_temp.moved(dep, 'accounts_receivable'));
  r := pg_temp.try(mgr2, format($$SELECT public.approve_sales_order(%L, %L)$$, so.id, mgr2));
  res := res || pg_temp.check('with the deposit the order fits (1 100 − 500 + 300 = 900) and is approved', r = 'ok', r);
  PERFORM pg_temp.as_user(rep);
  SELECT * INTO v_row FROM public.rma_customer_credit_status(v_cust);
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('the status counts the open order and the deposit',
    v_row.open_orders = 300 AND v_row.unused_credits = 500 AND v_row.exposure = 900, v_row.open_orders || '/' || v_row.unused_credits || '/' || v_row.exposure);

  -- 5. applying the deposit moves it to receivables
  PERFORM pg_temp.as_user(acc);
  PERFORM public.apply_payment_to_invoice(dep, inv1, 200, acc);
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('applying 200 moves it from deposits to receivables',
    pg_temp.moved(dep, 'customer_deposits') = -300 AND pg_temp.moved(dep, 'accounts_receivable') = -200,
    pg_temp.moved(dep, 'customer_deposits') || '/' || pg_temp.moved(dep, 'accounts_receivable'));
  SELECT count(*) INTO v_n FROM public._rma_subledger_rows('receivables') x WHERE x.doc_id IN (dep, inv1) AND x.difference <> 0;
  res := res || pg_temp.check('the ledger checks match the deposit and the invoice (deposits counted with receivables)', v_n = 0, v_n::text);

  -- 6. a refund of a deposit comes out of deposits
  PERFORM pg_temp.as_user(mgr);
  rf := (public.record_customer_refund('payment', dep, 100, 'bank_transfer', 'RF-DEP', CURRENT_DATE, NULL, mgr)).id;
  PERFORM pg_temp.as_user(mgr2);
  PERFORM public.approve_customer_refund(rf, mgr2);
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('a refunded deposit is debited to deposits',
    pg_temp.moved(rf, 'customer_deposits') = 100 AND pg_temp.moved(rf, 'accounts_receivable') = 0,
    pg_temp.moved(rf, 'customer_deposits') || '/' || pg_temp.moved(rf, 'accounts_receivable'));

  -- 7. voiding a deposit with an application moves it all back
  PERFORM pg_temp.as_user(acc);
  dep2 := public.record_customer_deposit(v_cust, 50, 'cash', 'DEP-2', CURRENT_DATE, NULL, NULL, NULL, NULL, acc);
  PERFORM public.apply_payment_to_invoice(dep2, inv1, 20, acc);
  PERFORM public.void_payment(dep2, 'taken by mistake', acc);
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('a voided deposit leaves nothing in deposits or receivables',
    pg_temp.moved(dep2, 'customer_deposits') = 0 AND pg_temp.moved(dep2, 'accounts_receivable') = 0 AND pg_temp.moved(dep2, 'cash') = 0,
    pg_temp.moved(dep2, 'customer_deposits') || '/' || pg_temp.moved(dep2, 'accounts_receivable'));

  -- 8. an ordinary payment is unchanged
  PERFORM pg_temp.as_user(acc);
  pay := public.record_payment(v_cust, 10, 'bank_transfer', 'PAY-A06', CURRENT_DATE, NULL, acc, '[]'::jsonb, 'EGP', NULL);
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('an ordinary payment still posts to receivables and is not a deposit',
    pg_temp.moved(pay, 'accounts_receivable') = -10 AND NOT (SELECT is_deposit FROM public.payments WHERE id = pay), pg_temp.moved(pay, 'accounts_receivable')::text);

  -- 9. refusals, and no limit means no check
  PERFORM pg_temp.as_user(mgr);
  so_other := public.create_sales_order(v_other, jsonb_build_array(jsonb_build_object('product_id', v_prod, 'product_name', 'A06 service',
                'qty', 1, 'unit_price', 10, 'tax_pct', 0)), NULL, NULL, NULL, NULL, NULL, mgr);
  PERFORM pg_temp.as_owner();
  r := pg_temp.try(acc, format($$SELECT public.record_customer_deposit(%L, 10, 'cash', NULL, CURRENT_DATE, NULL, %L, NULL, NULL, %L)$$, v_cust, so_other.id, acc));
  res := res || pg_temp.check('a deposit on another customer''s order is refused', r LIKE 'err:P0001%not this customer%', r);
  r := pg_temp.try(acc, format($$SELECT public.record_customer_deposit(%L, 10, 'cash', NULL, CURRENT_DATE, NULL, %L, 'USD', 50, %L)$$, v_cust, so.id, acc));
  res := res || pg_temp.check('a deposit on an order is taken in the order''s currency', r LIKE 'err:P0001%its currency, EGP%', r);
  r := pg_temp.try(rep, format($$SELECT public.record_customer_deposit(%L, 10, 'cash', NULL, CURRENT_DATE, NULL, NULL, NULL, NULL, %L)$$, v_cust, rep));
  res := res || pg_temp.check('a sales rep cannot take a deposit (record_payment''s rules)', r LIKE 'err:42501%', r);
  big := pg_temp.invoice(mgr, v_free, v_prod, 999999);
  r := pg_temp.try(mgr, format($$SELECT public.post_invoice(%L, %L)$$, big, mgr));
  res := res || pg_temp.check('a customer with no limit is never refused', r = 'ok', r);
  res := res || pg_temp.check('anon can execute none of it; the exposure helper is internal',
    to_regprocedure('public.approve_credit_override(text, uuid, text)') IS NOT NULL
    AND NOT has_function_privilege('anon', 'public.rma_customer_credit_status(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.record_customer_deposit(uuid, numeric, text, text, date, text, uuid, text, numeric, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._rma_credit_exposure(uuid)', 'EXECUTE'));

  RAISE EXCEPTION 'A06A_TEST_DONE %', E'\n' || array_to_string(res, E'\n');
END
$do$;
