-- supabase/tests/fx_revaluation.sql — A-08c (20260918), rolled back.
-- July 2026 (ended, open on staging): a USD invoice, an unapplied USD payment,
-- a USD and a SAR supplier bill are revalued at the July month-end rates; the
-- entry posts to the unrealised accounts on 31 July and reverses on 1 August.
-- #  node scripts/run-sql-test.mjs supabase/tests/fx_revaluation.sql A08C_TEST_DONE

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
-- a draft supplier bill with no order, approved in July at the given rate
CREATE FUNCTION pg_temp.bill(p_mgr text, p_vendor uuid, p_prod uuid, p_cur text, p_rate numeric, p_amount numeric, p_no text)
RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v public.vendor_invoices;
BEGIN
  PERFORM pg_temp.as_user(p_mgr);
  v := public.create_vendor_invoice(p_vendor, jsonb_build_array(jsonb_build_object('product_id', p_prod, 'product_name', 'A08C item',
         'qty_ordered', 1, 'unit_cost', p_amount, 'tax_pct', 0)),
         jsonb_build_object('currency', p_cur, 'exchange_rate', p_rate, 'supplier_invoice_no', p_no, 'supplier_invoice_date', '2026-07-15',
                            'non_po_reason', 'revaluation test bill'), p_mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.vendor_invoices SET status = 'pending_approval', price_variance_reason = 'revaluation test bill' WHERE id = v.id;
  UPDATE public.vendor_invoices SET status = 'approved', approved_at = '2026-07-15 10:00+03' WHERE id = v.id;
  RETURN v.id;
END $f$;

DO $do$
DECLARE
  mgr text := 'a08c-mgr@test.local';
  acc text := 'a08c-acc@test.local';
  rep text := 'a08c-rep@test.local';
  v_cust uuid; v_vendor uuid; v_prod uuid := gen_random_uuid();
  v_inv public.crm_invoices; v_inv2 public.crm_invoices; v_pay uuid; v_usd uuid; v_sar uuid;
  v_run uuid; v_row record; v_n bigint; v_sum numeric;
  r text;
  res text[] := '{}';
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (mgr, 'manager', 'active'), (acc, 'accountant', 'active'), (rep, 'sales_rep', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type, currency) VALUES ('A08C Co', 'A08C-C1', 'B2B', 'USD') RETURNING id INTO v_cust;
  INSERT INTO public.brands (brand_name) VALUES ('A08C Supplier') RETURNING id INTO v_vendor;
  INSERT INTO public.products (id, sku, product_name, product_type, stock_tracking_mode) VALUES (v_prod, 'A08C-SVC', 'A08C service', 'service', 'serialized');
  -- July rates: USD 50 at the start, 52 at the month end; SAR only from August
  INSERT INTO public.exchange_rates (currency, rate_date, rate) VALUES ('USD', '2026-07-01', 50), ('USD', '2026-07-31', 52), ('SAR', '2026-08-15', 13.5)
  ON CONFLICT (currency, rate_date) DO UPDATE SET rate = EXCLUDED.rate;

  -- a USD invoice for 100 at 50, posted in July
  PERFORM pg_temp.as_user(mgr);
  v_inv := public.create_crm_invoice(v_cust, jsonb_build_array(jsonb_build_object('product_id', v_prod, 'product_name', 'A08C service',
             'qty', 1, 'unit_price', 100, 'tax_pct', 0)), '2026-08-30', NULL, NULL, NULL, NULL, mgr);
  PERFORM public.set_document_currency('invoice', v_inv.id, 'USD', 50);
  PERFORM public.post_invoice(v_inv.id, mgr);
  -- 30 USD received on 20 July at 51, not applied
  v_pay := public.record_payment(v_cust, 30, 'bank_transfer', 'A08C', '2026-07-20', NULL, mgr, '[]'::jsonb, 'USD', 51);
  -- a second invoice, posted today (September): not July's
  v_inv2 := public.create_crm_invoice(v_cust, jsonb_build_array(jsonb_build_object('product_id', v_prod, 'product_name', 'A08C service',
              'qty', 1, 'unit_price', 7, 'tax_pct', 0)), '2026-10-30', NULL, NULL, NULL, NULL, mgr);
  PERFORM public.post_invoice(v_inv2.id, mgr);
  PERFORM pg_temp.as_owner();
  UPDATE public.crm_invoices SET posted_at = '2026-07-10 10:00+03' WHERE id = v_inv.id;

  -- supplier bills: 40 USD at 50, 10 SAR at 13, approved in July
  v_usd := pg_temp.bill(mgr, v_vendor, v_prod, 'USD', 50, 40, 'A08C-USD-1');
  v_sar := pg_temp.bill(mgr, v_vendor, v_prod, 'SAR', 13, 10, 'A08C-SAR-1');

  -- 1. preview
  PERFORM pg_temp.as_user(acc);
  SELECT * INTO v_row FROM public.rma_fx_revaluation_preview('2026-07-01') p WHERE p.doc_id = v_inv.id;
  res := res || pg_temp.check('the July invoice: 100 at 50 carried 5000, at 52 revalued 5200, a gain of 200',
    v_row.open_amount = 100 AND v_row.carried_base = 5000 AND v_row.revalued_base = 5200 AND v_row.effect = 200 AND v_row.party_name = 'A08C Co',
    v_row.open_amount || '/' || v_row.effect);
  SELECT * INTO v_row FROM public.rma_fx_revaluation_preview('2026-07-01') p WHERE p.doc_id = v_pay;
  res := res || pg_temp.check('the unapplied payment: −30 at 51, a loss of 30', v_row.open_amount = -30 AND v_row.effect = -30, v_row.effect::text);
  SELECT * INTO v_row FROM public.rma_fx_revaluation_preview('2026-07-01') p WHERE p.doc_id = v_usd;
  res := res || pg_temp.check('the USD bill: 40 at 50 → 52, a loss of 80 (a payable that grew)', v_row.effect = -80 AND v_row.side = 'payable', v_row.effect::text);
  SELECT * INTO v_row FROM public.rma_fx_revaluation_preview('2026-07-01') p WHERE p.doc_id = v_sar;
  res := res || pg_temp.check('the SAR bill has no July rate yet', v_row.rate IS NULL AND v_row.effect IS NULL, COALESCE(v_row.rate::text, 'null'));
  SELECT count(*) INTO v_n FROM public.rma_fx_revaluation_preview('2026-07-01') p WHERE p.doc_id = v_inv2.id;
  res := res || pg_temp.check('an invoice posted in September is not July''s', v_n = 0, v_n::text);
  SELECT item_count INTO v_n FROM public.rma_period_close_checklist('2026-07-01') WHERE item = 'fx_not_revalued';
  res := res || pg_temp.check('the July checklist warns: foreign balances not revalued', v_n >= 4, COALESCE(v_n::text, 'null'));
  PERFORM pg_temp.as_owner();

  -- 2. refusals before the run
  r := pg_temp.try(acc, $$SELECT public.run_fx_revaluation('2026-07-01')$$);
  res := res || pg_temp.check('a currency with no month-end rate is refused by name', r LIKE 'err:P0001%SAR%', r);
  r := pg_temp.try(acc, $$SELECT public.run_fx_revaluation('2026-09-01')$$);
  res := res || pg_temp.check('a month that has not ended is refused', r LIKE 'err:P0001%has ended%' OR r LIKE 'err:P0001%once it has ended%', r);
  r := pg_temp.try(mgr, $$SELECT public.run_fx_revaluation('2026-07-01')$$);
  res := res || pg_temp.check('a manager cannot run it', r LIKE 'err:42501%', r);
  r := pg_temp.try(rep, $$SELECT * FROM public.rma_fx_revaluation_preview('2026-07-01')$$);
  res := res || pg_temp.check('a sales rep cannot preview it', r LIKE 'err:42501%', r);

  -- 3. the run
  INSERT INTO public.exchange_rates (currency, rate_date, rate) VALUES ('SAR', '2026-07-31', 14)
  ON CONFLICT (currency, rate_date) DO UPDATE SET rate = EXCLUDED.rate;
  PERFORM pg_temp.as_user(acc);
  v_run := public.run_fx_revaluation('2026-07-01');
  PERFORM pg_temp.as_owner();

  SELECT * INTO v_row FROM public.fx_revaluations WHERE id = v_run;
  SELECT sum(effect) FILTER (WHERE effect > 0), -sum(effect) FILTER (WHERE effect < 0) INTO v_sum, v_n
    FROM public.fx_revaluation_lines WHERE revaluation_id = v_run;
  res := res || pg_temp.check('the run records its lines and totals (gain = Σ gains, loss = Σ losses)',
    v_row.total_gain = v_sum AND v_row.total_loss = v_n AND v_row.revalued_on = '2026-07-31' AND v_row.item_count >= 4,
    v_row.total_gain || '/' || v_row.total_loss);
  SELECT effect INTO v_sum FROM public.fx_revaluation_lines WHERE revaluation_id = v_run AND doc_id = v_sar;
  res := res || pg_temp.check('the SAR bill: 10 at 13 → 14, a loss of 10', v_sum = -10, v_sum::text);

  SELECT * INTO v_row FROM public.journal_entries WHERE id = (SELECT entry_id FROM public.fx_revaluations WHERE id = v_run);
  res := res || pg_temp.check('the entry is dated 31 July, FXR-2026-07', v_row.entry_date = '2026-07-31' AND v_row.source_code = 'FXR-2026-07', v_row.entry_date::text);
  SELECT sum(l.debit) - sum(l.credit) INTO v_sum FROM public.journal_lines l
    JOIN public.gl_accounts a ON a.id = l.account_id
   WHERE l.entry_id = v_row.id AND a.code = '4915';
  res := res || pg_temp.check('gains are credited to 4915 (unrealised), not 4910',
    -v_sum = (SELECT total_gain FROM public.fx_revaluations WHERE id = v_run), v_sum::text);
  SELECT sum(l.debit) - sum(l.credit) INTO v_sum FROM public.journal_lines l
    JOIN public.gl_accounts a ON a.id = l.account_id
   WHERE l.entry_id = v_row.id AND a.code = '6525';
  res := res || pg_temp.check('losses are debited to 6525 (unrealised)', v_sum = (SELECT total_loss FROM public.fx_revaluations WHERE id = v_run), v_sum::text);
  SELECT sum(l.debit) - sum(l.credit) INTO v_sum FROM public.journal_lines l
   WHERE l.entry_id = v_row.id AND l.account_id = (SELECT account_id FROM public.posting_rules WHERE role = 'accounts_receivable');
  res := res || pg_temp.check('receivables move by the receivable effects',
    v_sum = (SELECT sum(effect) FROM public.fx_revaluation_lines WHERE revaluation_id = v_run AND side = 'receivable'), v_sum::text);
  SELECT sum(l.debit) - sum(l.credit) INTO v_sum FROM public.journal_lines l
   WHERE l.entry_id = v_row.id AND l.account_id = (SELECT account_id FROM public.posting_rules WHERE role = 'accounts_payable');
  res := res || pg_temp.check('payables move by the payable effects (a loss credits payables)',
    v_sum = (SELECT sum(effect) FROM public.fx_revaluation_lines WHERE revaluation_id = v_run AND side = 'payable'), v_sum::text);

  SELECT * INTO v_row FROM public.journal_entries WHERE id = (SELECT reversal_entry_id FROM public.fx_revaluations WHERE id = v_run);
  res := res || pg_temp.check('it is reversed on 1 August',
    v_row.entry_date = '2026-08-01' AND v_row.reverses_entry_id = (SELECT entry_id FROM public.fx_revaluations WHERE id = v_run), v_row.entry_date::text);
  SELECT sum(l.debit - l.credit) INTO v_sum FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id
   WHERE e.source_type = 'fx_revaluation' AND e.source_id = v_run
     AND l.account_id = (SELECT account_id FROM public.posting_rules WHERE role = 'accounts_receivable');
  res := res || pg_temp.check('revaluation and reversal net to nothing on receivables (the ledger checks stay clean)', v_sum = 0, v_sum::text);

  -- 4. after the run
  PERFORM pg_temp.as_user(acc);
  SELECT item_count INTO v_n FROM public.rma_period_close_checklist('2026-07-01') WHERE item = 'fx_not_revalued';
  res := res || pg_temp.check('the July checklist no longer warns', v_n = 0, COALESCE(v_n::text, 'null'));
  PERFORM pg_temp.as_owner();
  r := pg_temp.try(acc, $$SELECT public.run_fx_revaluation('2026-07-01')$$);
  res := res || pg_temp.check('a month is revalued once', r LIKE 'err:P0001%already been revalued%', r);
  r := pg_temp.try(acc, $$INSERT INTO public.fx_revaluations (period_start, revalued_on) VALUES ('2026-06-01', '2026-06-30')$$);
  res := res || pg_temp.check('no client writes the record', r LIKE 'err:42501%', r);
  r := pg_temp.try(acc, format($$SELECT count(*) FROM public.fx_revaluation_lines WHERE revaluation_id = %L$$, v_run));
  res := res || pg_temp.check('an accountant reads the lines', r = 'ok', r);
  res := res || pg_temp.check('anon can execute none of it',
    to_regprocedure('public.run_fx_revaluation(date)') IS NOT NULL
    AND NOT has_function_privilege('anon', 'public.run_fx_revaluation(date)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rma_fx_revaluation_preview(date)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._rma_fx_open_items(date)', 'EXECUTE'));

  RAISE EXCEPTION 'A08C_TEST_DONE %', E'\n' || array_to_string(res, E'\n');
END
$do$;
