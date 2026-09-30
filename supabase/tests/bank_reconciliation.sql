-- supabase/tests/bank_reconciliation.sql — A-07a (20260920), rolled back.
-- March 2023 on the bank account (staging has no postings then): a receipt of
-- 1 000, a supplier payment of 400 and a receipt of 250 not yet on the
-- statement; the statement shows the first two and 15 of bank charges.
-- #  node scripts/run-sql-test.mjs supabase/tests/bank_reconciliation.sql A07A_TEST_DONE

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
CREATE FUNCTION pg_temp.acct(p_code text) RETURNS uuid LANGUAGE sql AS $f$ SELECT id FROM public.gl_accounts WHERE code = p_code $f$;
CREATE FUNCTION pg_temp.bank_line(p_entry uuid) RETURNS uuid LANGUAGE sql AS $f$
  SELECT id FROM public.journal_lines WHERE entry_id = p_entry
     AND account_id = (SELECT account_id FROM public.posting_rules WHERE role = 'bank')
$f$;

DO $do$
DECLARE
  acc  text := 'a07-acc@test.local';
  mgr  text := 'a07-mgr@test.local';
  v_bank uuid := (SELECT account_id FROM public.posting_rules WHERE role = 'bank');
  e1 uuid; e2 uuid; e3 uuid;
  st uuid; st2 uuid; l1 uuid; l2 uuid; l3 uuid; booked uuid;
  v_row record; v_n bigint;
  r text;
  res text[] := '{}';
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES (acc, 'accountant', 'active'), (mgr, 'manager', 'active');

  e1 := public._gl_post('a07_test', gen_random_uuid(), 'in', '2023-03-02', 'A07-1', 'receipt', jsonb_build_array(
          jsonb_build_object('role', 'bank', 'debit', 1000), jsonb_build_object('role', 'accounts_receivable', 'credit', 1000)));
  e2 := public._gl_post('a07_test', gen_random_uuid(), 'out', '2023-03-05', 'A07-2', 'supplier paid', jsonb_build_array(
          jsonb_build_object('role', 'accounts_payable', 'debit', 400), jsonb_build_object('role', 'bank', 'credit', 400)));
  e3 := public._gl_post('a07_test', gen_random_uuid(), 'in', '2023-03-20', 'A07-3', 'receipt not yet on the statement', jsonb_build_array(
          jsonb_build_object('role', 'bank', 'debit', 250), jsonb_build_object('role', 'accounts_receivable', 'credit', 250)));

  -- 0. bank accounts
  res := res || pg_temp.check('the cash and bank role accounts are bank accounts',
    (SELECT bool_and(a.is_bank) FROM public.gl_accounts a WHERE a.id IN (SELECT account_id FROM public.posting_rules WHERE role IN ('cash', 'bank'))));

  -- 1. who and what
  r := pg_temp.try(mgr, format($$SELECT public.create_bank_statement(%L, '2023-03-31', 'MAR', 0, 585, '[]'::jsonb)$$, v_bank));
  res := res || pg_temp.check('a manager cannot reconcile the bank', r LIKE 'err:42501%', r);
  r := pg_temp.try(acc, format($$SELECT public.create_bank_statement(%L, '2023-03-31', 'MAR', 0, 585, '[]'::jsonb)$$, pg_temp.acct('1200')));
  res := res || pg_temp.check('receivables is not a bank account', r LIKE 'err:P0001%bank or cash account%', r);
  r := pg_temp.try(acc, format($$SELECT public.create_bank_statement(%L, '2023-03-31', 'MAR', 0, 585, '[{"txn_date":"03/03/2023","amount":"5"}]'::jsonb)$$, v_bank));
  res := res || pg_temp.check('a line with a date not in YYYY-MM-DD is refused', r LIKE 'err:P0001%needs a date%', r);

  PERFORM pg_temp.as_user(acc);
  st := public.create_bank_statement(v_bank, '2023-03-31', 'MARCH-2023', 0, 585, jsonb_build_array(
          jsonb_build_object('txn_date', '2023-03-03', 'amount', '1000', 'description', 'Transfer from customer'),
          jsonb_build_object('txn_date', '2023-03-06', 'amount', '-400', 'description', 'Supplier payment'),
          jsonb_build_object('txn_date', '2023-03-31', 'amount', '-15.00', 'description', 'Bank charges', 'reference', 'CHG')));
  PERFORM pg_temp.as_owner();
  SELECT id INTO l1 FROM public.bank_statement_lines WHERE statement_id = st AND line_no = 1;
  SELECT id INTO l2 FROM public.bank_statement_lines WHERE statement_id = st AND line_no = 2;
  SELECT id INTO l3 FROM public.bank_statement_lines WHERE statement_id = st AND line_no = 3;
  res := res || pg_temp.check('an accountant imports a statement of three lines', l1 IS NOT NULL AND l3 IS NOT NULL);

  -- 2. matching
  PERFORM pg_temp.as_user(mgr);
  SELECT count(*) INTO v_n FROM public.rma_bank_match_candidates(st) c WHERE c.statement_line_id = l1 AND c.journal_line_id = pg_temp.bank_line(e1);
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('the receipt is offered for the statement''s 1 000 (a manager can read it)', v_n = 1, v_n::text);
  PERFORM pg_temp.as_user(acc);
  v_n := public.auto_match_bank_statement(st);
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('auto-match takes the two sure ones and leaves the charges',
    v_n = 2 AND (SELECT journal_line_id FROM public.bank_statement_lines WHERE id = l2) = pg_temp.bank_line(e2)
    AND (SELECT journal_line_id FROM public.bank_statement_lines WHERE id = l3) IS NULL, v_n::text);
  r := pg_temp.try(acc, format($$SELECT public.complete_bank_statement(%L)$$, st));
  res := res || pg_temp.check('a statement with an unmatched line cannot be completed', r LIKE 'err:P0001%1 statement lines are not matched%', r);
  r := pg_temp.try(acc, format($$SELECT public.match_bank_line(%L, %L)$$, l3, pg_temp.bank_line(e3)));
  res := res || pg_temp.check('an entry of another amount cannot be matched', r LIKE 'err:P0001%amounts differ%', r);
  r := pg_temp.try(acc, format($$SELECT public.match_bank_line(%L, %L)$$, l3, pg_temp.bank_line(e1)));
  res := res || pg_temp.check('an entry already matched cannot be matched again', r LIKE 'err:P0001%amounts differ%' OR r LIKE 'err:P0001%already matched%', r);

  -- 3. booking the charges from the line
  r := pg_temp.try(acc, format($$SELECT public.book_bank_line(%L, %L, 'charges')$$, l3, v_bank));
  res := res || pg_temp.check('the bank account itself cannot be the other side', r LIKE 'err:P0001%other side%', r);
  PERFORM pg_temp.as_user(acc);
  booked := public.book_bank_line(l3, pg_temp.acct('6100'), 'March bank charges');
  PERFORM pg_temp.as_owner();
  SELECT * INTO v_row FROM public.journal_entries WHERE id = booked;
  res := res || pg_temp.check('charges booked on the line''s date: Dr expenses 15, Cr bank 15, and the line matched',
    v_row.entry_date = '2023-03-31' AND v_row.source_type = 'bank_statement_line'
    AND (SELECT debit FROM public.journal_lines WHERE entry_id = booked AND account_id = pg_temp.acct('6100')) = 15
    AND (SELECT credit FROM public.journal_lines WHERE entry_id = booked AND account_id = v_bank) = 15
    AND (SELECT journal_line_id FROM public.bank_statement_lines WHERE id = l3) = pg_temp.bank_line(booked),
    v_row.entry_date::text);
  r := pg_temp.try(acc, format($$SELECT public.unmatch_bank_line(%L)$$, l3));
  res := res || pg_temp.check('a booked line stays matched', r LIKE 'err:P0001%booked from it%', r);

  -- 4. the reconciliation ties
  PERFORM pg_temp.as_user(acc);
  SELECT * INTO v_row FROM public.rma_bank_statement_summary(st);
  PERFORM pg_temp.as_owner();
  res := res || pg_temp.check('ledger 835 − uncleared 250 (the late receipt) = bank 585: difference 0',
    v_row.statement_balances AND v_row.ledger_balance = 835 AND v_row.uncleared_total = 250 AND v_row.uncleared_count = 1 AND v_row.difference = 0,
    v_row.ledger_balance || '/' || v_row.uncleared_total || '/' || v_row.difference);
  r := pg_temp.try(acc, format($$SELECT public.complete_bank_statement(%L)$$, st));
  res := res || pg_temp.check('then it completes', r = 'ok' AND (SELECT status FROM public.bank_statements WHERE id = st) = 'completed', r);
  r := pg_temp.try(acc, format($$SELECT public.unmatch_bank_line(%L)$$, l1));
  res := res || pg_temp.check('a completed statement is locked', r LIKE 'err:P0001%completed%', r);

  -- 5. the next statement opens where this one closed
  PERFORM pg_temp.as_user(acc);
  st2 := public.create_bank_statement(v_bank, '2023-04-30', 'APRIL-2023', 500, 750,
           jsonb_build_array(jsonb_build_object('txn_date', '2023-03-22', 'amount', '250', 'description', 'Late receipt')));
  PERFORM public.auto_match_bank_statement(st2);
  PERFORM pg_temp.as_owner();
  r := pg_temp.try(acc, format($$SELECT public.complete_bank_statement(%L)$$, st2));
  res := res || pg_temp.check('an opening that is not the last closing (500 ≠ 585) is refused', r LIKE 'err:P0001%previous statement''s closing 585%', r);
  r := pg_temp.try(acc, format($$SELECT public.create_bank_statement(%L, '2023-05-31', 'X', 0, 0, '[]'::jsonb)$$, v_bank));
  res := res || pg_temp.check('one open statement per account at a time', r LIKE 'err:P0001%still open%', r);
  r := pg_temp.try(acc, format($$SELECT public.delete_bank_statement(%L)$$, st2));
  PERFORM pg_temp.as_user(acc);
  st2 := public.create_bank_statement(v_bank, '2023-04-30', 'APRIL-2023', 585, 835,
           jsonb_build_array(jsonb_build_object('txn_date', '2023-03-22', 'amount', '250', 'description', 'Late receipt')));
  PERFORM public.auto_match_bank_statement(st2);
  PERFORM pg_temp.as_owner();
  r := pg_temp.try(acc, format($$SELECT public.complete_bank_statement(%L)$$, st2));
  res := res || pg_temp.check('deleted and recreated from 585, the late receipt clears and it completes', r = 'ok', r);
  r := pg_temp.try(acc, format($$SELECT public.reopen_bank_statement(%L)$$, st));
  res := res || pg_temp.check('only the latest statement can be reopened', r LIKE 'err:P0001%latest%', r);
  r := pg_temp.try(acc, format($$SELECT public.reopen_bank_statement(%L)$$, st2));
  res := res || pg_temp.check('the latest one can', r = 'ok' AND (SELECT status FROM public.bank_statements WHERE id = st2) = 'open', r);

  -- 6. the month-end checklist
  PERFORM pg_temp.as_user(acc);
  SELECT item_count INTO v_n FROM public.rma_period_close_checklist('2023-03-01') WHERE item = 'bank_reconciliation';
  res := res || pg_temp.check('March 2023 has its statement: nothing to reconcile', v_n = 0, COALESCE(v_n::text, 'null'));
  SELECT item_count INTO v_n FROM public.rma_period_close_checklist('2026-09-01') WHERE item = 'bank_reconciliation';
  res := res || pg_temp.check('September 2026 has bank postings and no statement: counted', v_n >= 1, COALESCE(v_n::text, 'null'));
  PERFORM pg_temp.as_owner();

  -- 7. a repointed bank rule marks its new account
  INSERT INTO public.gl_accounts (code, name, name_ar, account_type, parent_id, is_postable)
  VALUES ('1199', 'A07 second bank', 'بنك ثان', 'asset', (SELECT id FROM public.gl_accounts WHERE code = '1000'), true);
  UPDATE public.posting_rules SET account_id = pg_temp.acct('1199') WHERE role = 'bank';
  res := res || pg_temp.check('pointing the bank role at a new account makes it a bank account', (SELECT is_bank FROM public.gl_accounts WHERE code = '1199'));

  res := res || pg_temp.check('anon can execute none of it; the helpers are internal',
    to_regprocedure('public.complete_bank_statement(uuid)') IS NOT NULL
    AND NOT has_function_privilege('anon', 'public.create_bank_statement(uuid, date, text, numeric, numeric, jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rma_bank_statement_summary(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._rma_bank_open_statement(uuid)', 'EXECUTE'));

  RAISE EXCEPTION 'A07A_TEST_DONE %', E'\n' || array_to_string(res, E'\n');
END
$do$;
