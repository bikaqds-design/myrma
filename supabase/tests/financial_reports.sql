-- supabase/tests/financial_reports.sql — A-08a (20260916), rolled back.
-- Profit and loss, balance sheet and account drill-down tie to the journal.
-- Entries are dated 2023–2024, where staging has none, so every figure is known.
-- #  node scripts/run-sql-test.mjs supabase/tests/financial_reports.sql A08A_TEST_DONE

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
CREATE FUNCTION pg_temp.acct(p_code text) RETURNS uuid LANGUAGE sql AS $f$
  SELECT id FROM public.gl_accounts WHERE code = p_code
$f$;
CREATE FUNCTION pg_temp.post(p_date date, p_event text, p_lines jsonb) RETURNS void LANGUAGE sql AS $f$
  SELECT public._gl_post('a08a_test', gen_random_uuid(), p_event, p_date, 'A08A', 'financial reports test', p_lines)
$f$;

DO $do$
DECLARE
  mgr text := 'a08a-mgr@test.local';
  acc text := 'a08a-acc@test.local';
  rep text := 'a08a-rep@test.local';
  v_net numeric; v_n int; v_row record;
  v_assets numeric; v_le numeric; v_prior numeric; v_current numeric;
  r text;
  res text[] := '{}';
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (mgr, 'manager', 'active'), (acc, 'accountant', 'active'), (rep, 'sales_rep', 'active');
  DELETE FROM public.rma_config WHERE config_key = 'fiscal_year_start_month';
  INSERT INTO public.rma_config (config_key, config_value) VALUES ('fiscal_year_start_month', '1'::jsonb);

  -- 2023: capital 1000 in cash; a sale 500 + 75 tax on credit
  PERFORM pg_temp.post('2023-06-10', 'capital', jsonb_build_array(
    jsonb_build_object('role', 'cash', 'debit', 1000), jsonb_build_object('role', 'opening_balance_equity', 'credit', 1000)));
  PERFORM pg_temp.post('2023-11-05', 'sale', jsonb_build_array(
    jsonb_build_object('role', 'accounts_receivable', 'debit', 575), jsonb_build_object('role', 'sales_revenue', 'credit', 500),
    jsonb_build_object('role', 'sales_tax_payable', 'credit', 75)));
  -- 2024: a sale 200 + 30 tax, its cost 120, paid into the bank
  PERFORM pg_temp.post('2024-02-01', 'sale', jsonb_build_array(
    jsonb_build_object('role', 'accounts_receivable', 'debit', 230), jsonb_build_object('role', 'sales_revenue', 'credit', 200),
    jsonb_build_object('role', 'sales_tax_payable', 'credit', 30)));
  PERFORM pg_temp.post('2024-03-01', 'cogs', jsonb_build_array(
    jsonb_build_object('role', 'cost_of_goods_sold', 'debit', 120), jsonb_build_object('role', 'inventory', 'credit', 120)));
  PERFORM pg_temp.post('2024-03-15', 'paid', jsonb_build_array(
    jsonb_build_object('role', 'bank', 'debit', 230), jsonb_build_object('role', 'accounts_receivable', 'credit', 230)));

  PERFORM pg_temp.as_user(mgr);

  -- 1. profit and loss
  SELECT sum(CASE WHEN account_type = 'income' THEN amount ELSE -amount END), count(*) INTO v_net, v_n
    FROM public.rma_profit_and_loss('2024-01-01', '2024-12-31');
  res := res || pg_temp.check('P&L 2024: net profit 200 − 120 = 80 over two accounts', v_net = 80 AND v_n = 2, v_net || '/' || v_n);
  SELECT * INTO v_row FROM public.rma_profit_and_loss('2024-01-01', '2024-12-31') WHERE code = '4100';
  res := res || pg_temp.check('P&L: revenue 200 under its header 4000', v_row.amount = 200 AND v_row.parent_code = '4000', v_row.amount || '/' || v_row.parent_code);
  SELECT * INTO v_row FROM public.rma_profit_and_loss('2024-01-01', '2024-12-31') WHERE code = '5100';
  res := res || pg_temp.check('P&L: cost of goods sold 120 on the expense side', v_row.amount = 120 AND v_row.account_type = 'expense', v_row.amount::text);
  SELECT sum(amount) INTO v_net FROM public.rma_profit_and_loss('2023-01-01', '2023-12-31');
  res := res || pg_temp.check('P&L 2023: revenue 500 only', v_net = 500, v_net::text);

  -- 2. balance sheet (financial year from January)
  SELECT sum(amount) FILTER (WHERE section = 'asset'), sum(amount) FILTER (WHERE section IN ('liability', 'equity')),
         sum(amount) FILTER (WHERE kind = 'prior_years_earnings'), sum(amount) FILTER (WHERE kind = 'current_year_earnings')
    INTO v_assets, v_le, v_prior, v_current
    FROM public.rma_balance_sheet('2024-12-31');
  res := res || pg_temp.check('BS 2024-12-31: assets 1000 + 575 − 120 + 230 = 1685', v_assets = 1685, v_assets::text);
  res := res || pg_temp.check('BS: assets = liabilities + equity', v_assets = v_le, v_assets || ' vs ' || v_le);
  res := res || pg_temp.check('BS: 2023 profit is prior years, 2024 profit this year', v_prior = 500 AND v_current = 80, v_prior || '/' || v_current);
  SELECT amount INTO v_net FROM public.rma_balance_sheet('2024-12-31') WHERE code = '2200';
  res := res || pg_temp.check('BS: VAT payable 105 on the credit side', v_net = 105, v_net::text);
  SELECT sum(amount) FILTER (WHERE kind = 'current_year_earnings') INTO v_current FROM public.rma_balance_sheet('2023-12-31');
  res := res || pg_temp.check('BS 2023-12-31: this year is 2023 (500)', v_current = 500, v_current::text);

  PERFORM pg_temp.as_owner();
  UPDATE public.rma_config SET config_value = '7'::jsonb WHERE config_key = 'fiscal_year_start_month';
  PERFORM pg_temp.as_user(mgr);
  SELECT sum(amount) FILTER (WHERE kind = 'prior_years_earnings'), sum(amount) FILTER (WHERE kind = 'current_year_earnings'),
         sum(amount) FILTER (WHERE section = 'asset'), sum(amount) FILTER (WHERE section IN ('liability', 'equity'))
    INTO v_prior, v_current, v_assets, v_le
    FROM public.rma_balance_sheet('2024-12-31');
  res := res || pg_temp.check('BS with a July year: all 580 is before 2024-07-01, still balanced',
    v_prior = 580 AND v_current = 0 AND v_assets = v_le, v_prior || '/' || v_current);
  PERFORM pg_temp.as_owner();
  UPDATE public.rma_config SET config_value = '1'::jsonb WHERE config_key = 'fiscal_year_start_month';
  PERFORM pg_temp.as_user(mgr);

  -- 3. drill-down
  SELECT count(*), min(opening_balance), max(total_count) INTO v_n, v_net, v_assets
    FROM public.rma_account_activity(pg_temp.acct('1200'), '2024-01-01', '2024-12-31');
  res := res || pg_temp.check('AR 2024: opens at 575, two lines', v_n = 2 AND v_net = 575 AND v_assets = 2, v_n || '/' || v_net);
  SELECT * INTO v_row FROM public.rma_account_activity(pg_temp.acct('1200'), '2024-01-01', '2024-12-31') ORDER BY entry_date LIMIT 1;
  res := res || pg_temp.check('AR: the sale runs the balance to 805 and names its source',
    v_row.running_balance = 805 AND v_row.debit = 230 AND v_row.source_type = 'a08a_test' AND v_row.source_code = 'A08A', v_row.running_balance::text);
  SELECT * INTO v_row FROM public.rma_account_activity(pg_temp.acct('1200'), '2024-01-01', '2024-12-31', 1, 1);
  res := res || pg_temp.check('AR page 2 of 1-line pages: the payment, back to 575, total 2',
    v_row.credit = 230 AND v_row.running_balance = 575 AND v_row.total_count = 2, v_row.running_balance::text);
  SELECT * INTO v_row FROM public.rma_account_activity(pg_temp.acct('2200'), '2024-01-01', '2024-12-31');
  res := res || pg_temp.check('VAT (a liability) runs on the credit side: 75 → 105',
    v_row.opening_balance = 75 AND v_row.running_balance = 105, v_row.opening_balance || '/' || v_row.running_balance);
  SELECT count(*) INTO v_n FROM public.rma_account_activity(pg_temp.acct('1200'), NULL, '2024-12-31');
  res := res || pg_temp.check('with no start date every line counts', v_n = 3, v_n::text);

  PERFORM pg_temp.as_owner();

  -- 4. refusals and access
  r := pg_temp.try(mgr, $$SELECT * FROM public.rma_profit_and_loss('2024-12-31', '2024-01-01')$$);
  res := res || pg_temp.check('a period that ends before it starts is refused', r LIKE 'err:P0001%', r);
  r := pg_temp.try(mgr, $$SELECT * FROM public.rma_account_activity(gen_random_uuid(), NULL, '2024-12-31')$$);
  res := res || pg_temp.check('an unknown account is refused', r LIKE 'err:P0001%', r);
  r := pg_temp.try(acc, $$SELECT * FROM public.rma_balance_sheet('2024-12-31')$$);
  res := res || pg_temp.check('an accountant reads the balance sheet', r = 'ok', r);
  r := pg_temp.try(rep, $$SELECT * FROM public.rma_profit_and_loss('2024-01-01', '2024-12-31')$$);
  res := res || pg_temp.check('a sales rep cannot read the P&L', r LIKE 'err:42501%', r);
  r := pg_temp.try(rep, $$SELECT * FROM public.rma_balance_sheet('2024-12-31')$$);
  res := res || pg_temp.check('a sales rep cannot read the balance sheet', r LIKE 'err:42501%', r);
  r := pg_temp.try(rep, format($$SELECT * FROM public.rma_account_activity(%L, NULL, '2024-12-31')$$, pg_temp.acct('1200')));
  res := res || pg_temp.check('a sales rep cannot drill into an account', r LIKE 'err:42501%', r);
  res := res || pg_temp.check('anon can execute none of them',
    to_regprocedure('public.rma_balance_sheet(date)') IS NOT NULL
    AND NOT has_function_privilege('anon', 'public.rma_profit_and_loss(date, date)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rma_balance_sheet(date)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rma_account_activity(uuid, date, date, int, int)', 'EXECUTE'));

  RAISE EXCEPTION 'A08A_TEST_DONE %', E'\n' || array_to_string(res, E'\n');
END
$do$;
