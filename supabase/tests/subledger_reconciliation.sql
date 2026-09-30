-- supabase/tests/subledger_reconciliation.sql — A-08b (20260917), rolled back.
-- The ledger's receivables, payables and inventory against the statements and
-- the stock. Staging already holds documents, so the checks look at what this
-- script adds: a posted invoice and its payment match; a tampered ledger entry
-- and an entry for no document are both caught, each on its own document.
-- #  node scripts/run-sql-test.mjs supabase/tests/subledger_reconciliation.sql A08B_TEST_DONE

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
-- the summary row of one area, read as the manager
CREATE FUNCTION pg_temp.summary(p_area text) RETURNS record LANGUAGE plpgsql AS $f$
DECLARE r record;
BEGIN
  PERFORM pg_temp.as_user('a08b-mgr@test.local');
  SELECT * INTO r FROM public.rma_subledger_reconciliation() s WHERE s.area = p_area;
  PERFORM pg_temp.as_owner();
  RETURN r;
END $f$;

DO $do$
DECLARE
  mgr text := 'a08b-mgr@test.local';
  acc text := 'a08b-acc@test.local';
  rep text := 'a08b-rep@test.local';
  v_cust uuid; v_prod uuid := gen_random_uuid();
  v_inv public.crm_invoices; v_pay uuid; v_orphan uuid := gen_random_uuid();
  s0 record; s1 record; s2 record; p record; i record;
  v_row record; v_n bigint; v_sum numeric; v_led numeric;
  r text;
  res text[] := '{}';
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (mgr, 'manager', 'active'), (acc, 'accountant', 'active'), (rep, 'sales_rep', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('A08B Co', 'A08B-C1', 'B2B') RETURNING id INTO v_cust;
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode) VALUES (v_prod, 'A08B-SVC', 'A08B service', 'service', 'serialized');

  s0 := pg_temp.summary('receivables');

  -- a manual invoice for 100 (0% tax), posted, then 40 paid against it
  PERFORM pg_temp.as_user(mgr);
  v_inv := public.create_crm_invoice(v_cust, jsonb_build_array(jsonb_build_object('product_id', v_prod, 'product_name', 'A08B service',
             'qty', 1, 'unit_price', 100, 'tax_pct', 0)), CURRENT_DATE + 30, NULL, NULL, NULL, NULL, mgr);
  PERFORM public.post_invoice(v_inv.id, mgr);
  v_pay := public.record_payment(v_cust, 40, 'bank_transfer', 'A08B', public.rma_today(), NULL, mgr,
             jsonb_build_array(jsonb_build_object('invoice_id', v_inv.id, 'amount', 40)), 'EGP', NULL);
  PERFORM pg_temp.as_owner();

  s1 := pg_temp.summary('receivables');
  res := res || pg_temp.check('the invoice and payment move ledger and statements by the same 60',
    s1.ledger_balance - s0.ledger_balance = 60 AND s1.subledger_balance - s0.subledger_balance = 60,
    (s1.ledger_balance - s0.ledger_balance) || '/' || (s1.subledger_balance - s0.subledger_balance));
  res := res || pg_temp.check('matched documents add no difference', s1.difference = s0.difference AND s1.documents_differing = s0.documents_differing,
    s1.difference || ' vs ' || s0.difference);
  SELECT count(*) INTO v_n FROM public._rma_subledger_rows('receivables') x WHERE x.doc_id IN (v_inv.id, v_pay) AND x.difference <> 0;
  res := res || pg_temp.check('neither the invoice nor the payment is listed as differing', v_n = 0, v_n::text);
  SELECT * INTO v_row FROM public._rma_subledger_rows('receivables') x WHERE x.doc_id = v_inv.id;
  res := res || pg_temp.check('the invoice row names its customer, code and both amounts',
    v_row.party_name = 'A08B Co' AND v_row.doc_type = 'invoice' AND v_row.subledger_amount = 100 AND v_row.ledger_amount = 100 AND v_row.in_ledger,
    v_row.party_name || '/' || v_row.doc_type || '/' || v_row.ledger_amount);

  -- the ledger is changed behind the invoice's back, and gets an entry for no document
  PERFORM public._gl_post('crm_invoice', v_inv.id, 'a08b_tamper', public.rma_today(), v_inv.inv_code, 'tamper', jsonb_build_array(
    jsonb_build_object('role', 'accounts_receivable', 'debit', 10), jsonb_build_object('role', 'sales_revenue', 'credit', 10)));
  PERFORM public._gl_post('a08b_test', v_orphan, 'orphan', public.rma_today(), 'A08B-X', 'no document', jsonb_build_array(
    jsonb_build_object('role', 'accounts_receivable', 'debit', 5), jsonb_build_object('role', 'sales_revenue', 'credit', 5)));

  s2 := pg_temp.summary('receivables');
  res := res || pg_temp.check('the summary difference moves by −15 over two more documents',
    s2.difference - s1.difference = -15 AND s2.documents_differing - s1.documents_differing = 2,
    (s2.difference - s1.difference) || '/' || (s2.documents_differing - s1.documents_differing));

  PERFORM pg_temp.as_user(mgr);
  SELECT * INTO v_row FROM public.rma_subledger_differences('receivables', 500, 0) d WHERE d.doc_id = v_inv.id;
  res := res || pg_temp.check('the tampered invoice is listed: statement 100, ledger 110, in the ledger',
    v_row.subledger_amount = 100 AND v_row.ledger_amount = 110 AND v_row.difference = -10 AND v_row.in_ledger AND NOT v_row.before_ledger,
    v_row.ledger_amount || '/' || v_row.difference);
  SELECT * INTO v_row FROM public.rma_subledger_differences('receivables', 500, 0) d WHERE d.doc_id = v_orphan;
  res := res || pg_temp.check('an entry for no document is listed from the ledger side',
    v_row.doc_type = 'a08b_test' AND v_row.subledger_amount = 0 AND v_row.ledger_amount = 5 AND v_row.doc_code = 'A08B-X',
    COALESCE(v_row.doc_type, 'null'));
  SELECT count(*), max(total_count) INTO v_n, v_sum FROM public.rma_subledger_differences('receivables', 1, 0);
  res := res || pg_temp.check('one row per page, the total counts every differing document',
    v_n = 1 AND v_sum = s2.documents_differing, v_n || '/' || v_sum || ' vs ' || s2.documents_differing);
  PERFORM pg_temp.as_owner();

  -- the summary is the sum of its documents, and the account's own balance
  SELECT sum(x.difference) INTO v_sum FROM public._rma_subledger_rows('receivables') x;
  res := res || pg_temp.check('receivables: the difference is the sum of the documents''', v_sum = s2.difference, v_sum || ' vs ' || s2.difference);
  SELECT sum(l.debit - l.credit) INTO v_led FROM public.journal_lines l
   WHERE l.account_id IN (SELECT account_id FROM public.posting_rules WHERE role IN ('accounts_receivable', 'customer_deposits'));
  -- since 20260919 receivables are counted together with customer deposits
  res := res || pg_temp.check('receivables: the ledger balance is receivables + customer deposits', v_led = s2.ledger_balance, v_led || ' vs ' || s2.ledger_balance);

  p := pg_temp.summary('payables');
  SELECT sum(x.difference), sum(x.subledger_amount) INTO v_sum, v_led FROM public._rma_subledger_rows('payables') x;
  res := res || pg_temp.check('payables: difference and statements are the sums of the documents',
    COALESCE(v_sum, 0) = p.difference AND COALESCE(v_led, 0) = p.subledger_balance, v_sum || '/' || p.difference);
  SELECT sum(v.amount_base) INTO v_led FROM public.v_vendor_ledger v;
  res := res || pg_temp.check('payables: the statements add up to every supplier statement', COALESCE(v_led, 0) = p.subledger_balance);

  i := pg_temp.summary('inventory');
  SELECT COALESCE((SELECT sum(unit_cost_base) FROM public.inventory_units WHERE status = 'company_stock' AND reservation_status IN ('available', 'reserved')), 0)
       + COALESCE((SELECT sum(total_cost_base) FROM public.warehouse_stock), 0) INTO v_sum;
  res := res || pg_temp.check('inventory: the stock is valued at its known cost', i.subledger_balance = v_sum AND i.documents_differing IS NULL,
    i.subledger_balance || ' vs ' || v_sum);
  res := res || pg_temp.check('inventory: the control account is the inventory rule''s', i.account_code = (SELECT a.code FROM public.posting_rules r JOIN public.gl_accounts a ON a.id = r.account_id WHERE r.role = 'inventory'));

  -- access
  r := pg_temp.try(acc, $$SELECT * FROM public.rma_subledger_reconciliation()$$);
  res := res || pg_temp.check('an accountant reads the checks', r = 'ok', r);
  r := pg_temp.try(rep, $$SELECT * FROM public.rma_subledger_reconciliation()$$);
  res := res || pg_temp.check('a sales rep cannot', r LIKE 'err:42501%', r);
  r := pg_temp.try(rep, $$SELECT * FROM public.rma_subledger_differences('receivables')$$);
  res := res || pg_temp.check('nor list the documents', r LIKE 'err:42501%', r);
  r := pg_temp.try(mgr, $$SELECT * FROM public.rma_subledger_differences('inventory')$$);
  res := res || pg_temp.check('inventory has no document list', r LIKE 'err:P0001%', r);
  r := pg_temp.try(mgr, $$SELECT * FROM public._rma_subledger_rows('receivables')$$);
  res := res || pg_temp.check('the internal function is not client-callable', r LIKE 'err:42501%', r);
  res := res || pg_temp.check('anon can execute neither report',
    to_regprocedure('public.rma_subledger_reconciliation()') IS NOT NULL
    AND NOT has_function_privilege('anon', 'public.rma_subledger_reconciliation()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rma_subledger_differences(text, int, int)', 'EXECUTE'));

  RAISE EXCEPTION 'A08B_TEST_DONE %', E'\n' || array_to_string(res, E'\n');
END
$do$;
