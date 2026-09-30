-- supabase/tests/opening_balances.sql — B-03a (20260921), rolled back.
-- A company starting on 1 January 2024 brings its books as they stood on
-- 31 December 2023: a trial balance (bank 1 000, receivables 300, inventory
-- 150 / payables 200, capital 1 250), the open invoices behind the 300 (100
-- EGP and 4 USD at 50), the open bill behind the 200, and the stock behind the
-- 150 (10 units at 10 in a bin, 2 serialized units at 25). Opening balance
-- equity must net to nothing.
-- #  node scripts/run-sql-test.mjs supabase/tests/opening_balances.sql B03A_TEST_DONE

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
-- the balance, debit minus credit, that a batch's own entries left on one role's account
CREATE FUNCTION pg_temp.net(p_role text, p_sources uuid[]) RETURNS numeric LANGUAGE sql AS $f$
  SELECT COALESCE(sum(l.debit - l.credit), 0)
    FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id
   WHERE e.source_id = ANY (p_sources)
     AND l.account_id = (SELECT account_id FROM public.posting_rules WHERE role = p_role)
$f$;

DO $do$
DECLARE
  acc  text := 'b03-acc@test.local';
  mgr  text := 'b03-mgr@test.local';
  adm  text := 'b03-adm@test.local';
  v_cust uuid; v_vend uuid; v_wh uuid; v_bulk uuid := gen_random_uuid(); v_ser uuid := gen_random_uuid();
  b uuid; b2 uuid; v_j jsonb; v_s jsonb;
  v_inv1 uuid; v_inv2 uuid; v_bill uuid; v_ws uuid; v_units uuid[]; v_pay uuid;
  v_src uuid[]; v_n bigint; v_x numeric; v_row record;
  r text;
  res text[] := '{}';
BEGIN
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES (acc, 'accountant', 'active'), (mgr, 'manager', 'active'), (adm, 'admin', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('B03 Buyer', 'B03-C1', 'B2B') RETURNING id INTO v_cust;
  INSERT INTO public.brands (brand_name) VALUES ('B03 Supplier') RETURNING id INTO v_vend;
  INSERT INTO public.warehouses (name, code, warehouse_type, is_active) VALUES ('B03 Main', 'B03-WH', 'main', true) RETURNING id INTO v_wh;
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode)
  VALUES (v_bulk, 'B03-BULK', 'B03 cable', 'hardware', 'bulk'), (v_ser, 'B03-SER', 'B03 router', 'hardware', 'serialized');
  INSERT INTO public.exchange_rates (currency, rate_date, rate) VALUES ('USD', '2023-12-01', 50)
  ON CONFLICT (currency, rate_date) DO NOTHING;

  -- 1. who may start
  r := pg_temp.try(mgr, $$SELECT public.create_opening_balance_batch('2023-12-31', NULL)$$);
  res := res || pg_temp.check('a manager cannot start opening balances', r LIKE 'err:42501%', r);
  PERFORM pg_temp.as_user(acc);
  b := public.create_opening_balance_batch('2023-12-31', 'B03 test');
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('an accountant starts a draft batch', (SELECT status FROM public.opening_balance_batches WHERE id = b) = 'draft');
  r := pg_temp.try(acc, $$SELECT public.create_opening_balance_batch('2023-12-31', NULL)$$);
  res := res || pg_temp.check('only one batch at a time', r LIKE 'err:P0001%', r);

  -- 2. trial balance: a bad section stores nothing and names each bad row
  PERFORM pg_temp.as_user(acc);
  v_j := public.set_opening_balance_rows(b, 'accounts', jsonb_build_array(
    jsonb_build_object('account_code', '1110', 'debit', '1000'),
    jsonb_build_object('account_code', 'NOPE', 'debit', '5'),
    jsonb_build_object('account_code', '3000', 'credit', '5'),
    jsonb_build_object('account_code', '3900', 'credit', '5'),
    jsonb_build_object('account_code', '3100', 'debit', '5', 'credit', '5')));
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('a bad trial balance stores nothing', (v_j->>'stored')::int = 0
    AND NOT EXISTS (SELECT 1 FROM public.opening_balance_accounts WHERE batch_id = b), v_j::text);
  res := res || pg_temp.check('each bad row is named: unknown, header, opening equity itself, both sides',
    jsonb_array_length(v_j->'errors') = 4
    AND (SELECT array_agg((e->>'row')::int ORDER BY (e->>'row')::int) FROM jsonb_array_elements(v_j->'errors') e) = ARRAY[2,3,4,5], v_j::text);

  PERFORM pg_temp.as_user(acc);
  v_j := public.set_opening_balance_rows(b, 'accounts', jsonb_build_array(
    jsonb_build_object('account_code', '1110', 'debit', '1000'),
    jsonb_build_object('account_code', '1200', 'debit', '300'),
    jsonb_build_object('account_code', '1300', 'debit', '150'),
    jsonb_build_object('account_code', '2100', 'credit', '200'),
    jsonb_build_object('account_code', '3100', 'credit', '1250.00')));
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('a good trial balance is stored', (v_j->>'stored')::int = 5, v_j::text);

  -- 3. open invoices and bills
  PERFORM pg_temp.as_user(acc);
  v_j := public.set_opening_balance_rows(b, 'receivables', jsonb_build_array(
    jsonb_build_object('party', 'B03-C1', 'doc_no', 'OLD-1', 'doc_date', '2023-11-15', 'due_date', '2023-12-15', 'amount', '100'),
    jsonb_build_object('party', 'nobody', 'doc_no', 'OLD-2', 'doc_date', '2023-11-15', 'amount', '1'),
    jsonb_build_object('party', 'B03-C1', 'doc_no', 'OLD-3', 'doc_date', '2024-01-05', 'amount', '1'),
    jsonb_build_object('party', 'B03-C1', 'doc_no', 'OLD-1', 'doc_date', '2023-11-15', 'amount', '1')));
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('open invoices: unknown customer, dated after the opening date and a repeated number are refused',
    (v_j->>'stored')::int = 0 AND jsonb_array_length(v_j->'errors') = 3, v_j::text);

  PERFORM pg_temp.as_user(acc);
  v_j := public.set_opening_balance_rows(b, 'receivables', jsonb_build_array(
    jsonb_build_object('party', 'b03 buyer', 'doc_no', 'OLD-1', 'doc_date', '2023-11-15', 'due_date', '2023-12-15', 'amount', '100'),
    jsonb_build_object('party', 'B03-C1', 'doc_no', 'OLD-2', 'doc_date', '2023-12-20', 'due_date', '2024-01-20', 'currency', 'usd', 'amount', '4')));
  v_s := public.set_opening_balance_rows(b, 'payables', jsonb_build_array(
    jsonb_build_object('party', 'B03 Supplier', 'doc_no', 'S-77', 'doc_date', '2023-12-10', 'due_date', '2024-01-10', 'amount', '200')));
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('open invoices stored (customer by name too; the USD one takes the rate on file)',
    (v_j->>'stored')::int = 2
    AND (SELECT exchange_rate FROM public.opening_balance_documents WHERE batch_id = b AND doc_no = 'OLD-2') = 50, v_j::text);
  res := res || pg_temp.check('the open bill is stored', (v_s->>'stored')::int = 1, v_s::text);

  -- 4. stock
  PERFORM pg_temp.as_user(acc);
  v_j := public.set_opening_balance_rows(b, 'stock', jsonb_build_array(
    jsonb_build_object('sku', 'B03-SER', 'warehouse', 'B03-WH', 'qty', '2', 'unit_cost', '25', 'serials', jsonb_build_array('B03-SN1')),
    jsonb_build_object('sku', 'B03-BULK', 'warehouse', 'B03-WH', 'qty', '10', 'unit_cost', '10', 'serials', jsonb_build_array('X')),
    jsonb_build_object('sku', 'B03-BULK', 'warehouse', 'RMA-RECEIVED', 'qty', '1'),
    jsonb_build_object('sku', 'B03-BULK', 'warehouse', 'B03-WH', 'qty', '1.5')));
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('stock: wrong serial count, serials on a bulk item, a system location and a fraction are refused',
    (v_j->>'stored')::int = 0 AND jsonb_array_length(v_j->'errors') = 4, v_j::text);

  PERFORM pg_temp.as_user(acc);
  v_j := public.set_opening_balance_rows(b, 'stock', jsonb_build_array(
    jsonb_build_object('sku', 'B03-SER', 'warehouse', 'b03 main', 'qty', '2', 'unit_cost', '25', 'serials', jsonb_build_array('B03-SN1', 'B03-SN2')),
    jsonb_build_object('sku', 'b03-bulk', 'warehouse', 'B03-WH', 'qty', '10', 'unit_cost', '10')));
  v_s := public.rma_opening_balance_summary(b);
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('stock stored (warehouse by name, SKU in any case)', (v_j->>'stored')::int = 2, v_j::text);
  res := res || pg_temp.check('the summary ties each control account to its detail and the equity nets to nothing',
    (v_s->>'tb_balanced')::boolean
    AND (v_s#>>'{receivables,total_base}')::numeric = 300 AND (v_s#>>'{receivables,trial_balance}')::numeric = 300
    AND (v_s#>>'{payables,total_base}')::numeric = 200 AND (v_s#>>'{payables,trial_balance}')::numeric = 200
    AND (v_s#>>'{stock,known_cost}')::numeric = 150 AND (v_s#>>'{stock,trial_balance}')::numeric = 150
    AND (v_s->>'equity_difference')::numeric = 0, v_s::text);

  -- 5. post
  r := pg_temp.try(mgr, format('SELECT public.post_opening_balances(%L)', b));
  res := res || pg_temp.check('a manager cannot post them', r LIKE 'err:42501%', r);
  PERFORM pg_temp.as_user(acc);
  PERFORM public.post_opening_balances(b);
  PERFORM pg_temp.as_owner();
  SELECT crm_invoice_id INTO v_inv1 FROM public.opening_balance_documents WHERE batch_id = b AND doc_no = 'OLD-1';
  SELECT crm_invoice_id INTO v_inv2 FROM public.opening_balance_documents WHERE batch_id = b AND doc_no = 'OLD-2';
  SELECT vendor_invoice_id INTO v_bill FROM public.opening_balance_documents WHERE batch_id = b AND doc_no = 'S-77';
  res := res || pg_temp.check('open invoices become posted opening invoices numbered OB-, dated on their own date',
    (SELECT count(*) FROM public.crm_invoices WHERE id IN (v_inv1, v_inv2) AND doc_status = 'posted' AND is_opening
        AND inv_code LIKE 'OB-OLD-%' AND payment_status = 'unpaid') = 2
    AND (SELECT posted_at::date FROM public.crm_invoices WHERE id = v_inv1) = '2023-11-15'
    AND (SELECT total FROM public.crm_invoices WHERE id = v_inv2) = 4 AND (SELECT currency FROM public.crm_invoices WHERE id = v_inv2) = 'USD');
  res := res || pg_temp.check('the open bill becomes an approved opening bill with the supplier''s number',
    (SELECT status = 'approved' AND is_opening AND supplier_invoice_no = 'S-77' AND total_base = 200 FROM public.vendor_invoices WHERE id = v_bill));
  SELECT unit_ids, warehouse_stock_id INTO v_units, v_ws FROM public.opening_balance_stock WHERE batch_id = b AND product_id = v_ser;
  SELECT warehouse_stock_id INTO v_ws FROM public.opening_balance_stock WHERE batch_id = b AND product_id = v_bulk;
  res := res || pg_temp.check('stock arrives at its cost: 2 routers at 25, 10 cables costing 100',
    (SELECT count(*) FROM public.inventory_units WHERE id = ANY (v_units) AND status = 'company_stock'
        AND reservation_status = 'available' AND warehouse_id = v_wh AND unit_cost_base = 25) = 2
    AND (SELECT quantity = 10 AND total_cost_base = 100 AND uncosted_quantity = 0 FROM public.warehouse_stock WHERE id = v_ws)
    AND (SELECT count(*) FROM public.stock_moves WHERE doc_type = 'opening_balance' AND doc_id = b) = 3);

  v_src := ARRAY[b, v_inv1, v_inv2, v_bill];
  res := res || pg_temp.check('the ledger: receivables 300, payables 200, inventory 150, bank 1 000, opening equity 0',
    pg_temp.net('accounts_receivable', v_src) = 300 AND pg_temp.net('accounts_payable', v_src) = -200
    AND pg_temp.net('inventory', v_src) = 150 AND pg_temp.net('bank', v_src) = 1000
    AND pg_temp.net('opening_balance_equity', v_src) = 0,
    pg_temp.net('accounts_receivable', v_src) || '/' || pg_temp.net('opening_balance_equity', v_src));
  res := res || pg_temp.check('every entry is dated on the opening date, the invoice''s names its customer',
    (SELECT bool_and(entry_date = '2023-12-31') FROM public.journal_entries WHERE source_id = ANY (v_src))
    AND EXISTS (SELECT 1 FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id
                 WHERE e.source_id = v_inv2 AND l.customer_id = v_cust AND l.debit = 200));

  -- 6. they behave like any open invoice, and stay out of revenue
  res := res || pg_temp.check('the customer statement shows both, on their own dates, 300 in base',
    (SELECT sum(amount_base) FROM public.v_customer_ledger WHERE customer_id = v_cust) = 300
    AND (SELECT entry_date::date FROM public.v_customer_ledger WHERE id = v_inv2) = '2023-12-20');
  SELECT count(*) INTO v_n FROM public._rma_subledger_rows('receivables') x WHERE x.doc_id IN (v_inv1, v_inv2) AND x.difference <> 0;
  res := res || pg_temp.check('the ledger checks match each opening invoice', v_n = 0, v_n::text);
  res := res || pg_temp.check('opening invoices are not revenue: margin and the report list leave them out',
    NOT EXISTS (SELECT 1 FROM public.v_invoice_margin WHERE id IN (v_inv1, v_inv2))
    AND NOT EXISTS (SELECT 1 FROM public.v_report_invoices WHERE id IN (v_inv1, v_inv2)));
  r := pg_temp.try(adm, format('SELECT public.void_invoice(%L, %L, NULL)', v_inv1, 'entered wrongly'));
  res := res || pg_temp.check('an opening invoice is not voided on its own', r LIKE 'err:%opening%', r);
  r := pg_temp.try(adm, format('UPDATE public.vendor_invoices SET status = %L WHERE id = %L', 'cancelled', v_bill));
  res := res || pg_temp.check('nor an opening bill cancelled', r LIKE 'err:%opening%', r);

  -- 7. reversing: refused once something used them, allowed once it is undone
  PERFORM pg_temp.as_user(adm);
  v_pay := public.record_payment(v_cust, 10, 'bank_transfer', 'B03', '2023-12-31', NULL, adm,
             jsonb_build_array(jsonb_build_object('invoice_id', v_inv1, 'amount', 10)), 'EGP', NULL);
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('a payment applies to an opening invoice', (SELECT amount_paid FROM public.crm_invoices WHERE id = v_inv1) = 10);
  r := pg_temp.try(acc, format('SELECT public.reverse_opening_balances(%L, %L)', b, 'entered the wrong month'));
  res := res || pg_temp.check('reversing is refused once an opening invoice has been paid', r LIKE 'err:P0001%paid%', r);
  r := pg_temp.try(acc, format('SELECT public.reverse_opening_balances(%L, %L)', b, 'short'));
  res := res || pg_temp.check('a reason of 10 characters is needed', r LIKE 'err:%10 characters%', r);
  PERFORM pg_temp.as_user(adm);
  PERFORM public.void_payment(v_pay, 'test undo', adm);
  PERFORM pg_temp.as_owner();

  PERFORM pg_temp.as_user(acc);
  PERFORM public.reverse_opening_balances(b, 'entered the wrong month');
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('reversed: the invoices and the bill are cancelled, the batch is reversed',
    (SELECT count(*) FROM public.crm_invoices WHERE id IN (v_inv1, v_inv2) AND doc_status = 'cancelled') = 2
    AND (SELECT status FROM public.vendor_invoices WHERE id = v_bill) = 'cancelled'
    AND (SELECT status FROM public.opening_balance_batches WHERE id = b) = 'reversed');
  res := res || pg_temp.check('reversed: the stock is gone again',
    (SELECT count(*) FROM public.inventory_units WHERE id = ANY (v_units) AND status = 'closed') = 2
    AND (SELECT quantity = 0 AND total_cost_base = 0 FROM public.warehouse_stock WHERE id = v_ws));
  res := res || pg_temp.check('reversed: every account nets to nothing',
    pg_temp.net('accounts_receivable', v_src) = 0 AND pg_temp.net('accounts_payable', v_src) = 0
    AND pg_temp.net('inventory', v_src) = 0 AND pg_temp.net('bank', v_src) = 0);
  PERFORM pg_temp.as_user(acc);
  b2 := public.create_opening_balance_batch('2023-12-31', NULL);
  v_j := public.set_opening_balance_rows(b2, 'stock', jsonb_build_array(
    jsonb_build_object('sku', 'B03-SER', 'warehouse', 'B03-WH', 'qty', '1', 'unit_cost', '25', 'serials', jsonb_build_array('B03-SN1'))));
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('a new batch can start, and a reversed serial can be entered again', b2 IS NOT NULL AND (v_j->>'stored')::int = 1, v_j::text);

  -- 8. access
  r := pg_temp.try(mgr, format('SELECT count(*) FROM public.opening_balance_documents WHERE batch_id = %L', b));
  res := res || pg_temp.check('a manager reads the batch', r = 'ok', r);
  r := pg_temp.try(acc, format('DELETE FROM public.opening_balance_accounts WHERE batch_id = %L', b2));
  res := res || pg_temp.check('the rows are written only through the functions', r LIKE 'err:42501%', r);
  r := pg_temp.try(acc, $$SELECT public._opening_balance_resolve_party('receivable', 'x')$$);
  res := res || pg_temp.check('the internal helper is not client-callable', r LIKE 'err:42501%', r);
  res := res || pg_temp.check('anon can execute none of it',
    NOT has_function_privilege('anon', 'public.post_opening_balances(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.set_opening_balance_rows(uuid, text, jsonb)', 'EXECUTE'));

  RAISE EXCEPTION 'B03A_TEST_DONE %', E'\n' || array_to_string(res, E'\n');
END
$do$;
