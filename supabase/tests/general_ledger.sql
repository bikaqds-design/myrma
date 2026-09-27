-- ############################################################################
-- #  GENERAL LEDGER — A-01a (20260905)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/general_ledger.sql A01A_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI. The final
-- #  error message also carries every PASS/FAIL line, for runners that do not
-- #  show notices.
-- ############################################################################

SELECT set_config('a01a.log', '', false);
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE l text := format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, CASE WHEN COALESCE(p_ok, false) THEN '' ELSE p_detail END);
BEGIN
  PERFORM set_config('a01a.log', COALESCE(current_setting('a01a.log', true), '') || E'\n' || l, false);
  RETURN l;
END $f$;
-- run SQL as a signed-in user; 'ok' or the error
CREATE FUNCTION pg_temp.call(p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE out text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    out := 'ok';
  EXCEPTION WHEN OTHERS THEN
    out := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 200);
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN out;
END $f$;
-- run SQL as the owner; 'ok' or the error
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN 'err:' || SQLSTATE || ' ' || left(SQLERRM, 200);
END $f$;
-- count rows as a signed-in user
CREATE FUNCTION pg_temp.seen(p_email text, p_sql text) RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE n integer;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  EXECUTE p_sql INTO n;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN n;
END $f$;

DO $do$
DECLARE
  v_admin text := 'a01a-admin@test.local';
  v_mgr   text := 'a01a-mgr@test.local';
  v_acct  text := 'a01a-acct@test.local';
  v_tech  text := 'a01a-tech@test.local';
  v_src   uuid := gen_random_uuid();
  v_src2  uuid := gen_random_uuid();
  v_e1    uuid;
  v_e2    uuid;
  v_rev   uuid;
  v_out   text;
  v_n     integer;
  v_ar    uuid;
  v_hdr   uuid;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES
    (v_admin, 'admin', 'active'), (v_mgr, 'manager', 'active'),
    (v_acct, 'accountant', 'active'), (v_tech, 'technician', 'active');
  SELECT id INTO v_ar FROM public.gl_accounts WHERE code = '1200';
  SELECT id INTO v_hdr FROM public.gl_accounts WHERE code = '1000';

  -- ══ 1. the seeded chart ════════════════════════════════════════════════════
  PERFORM pg_temp.check('the default chart is seeded (25 accounts, 6 headers)',
    (SELECT count(*) FROM public.gl_accounts WHERE code IN ('1000','1100','1110','1200','1300','1400','2000','2100','2150','2200','2300',
      '3000','3100','3200','3900','4000','4100','4900','5000','5100','5200','5300','6000','6100','6900')) = 25
    AND (SELECT count(*) FROM public.gl_accounts WHERE code IN ('1000','2000','3000','4000','5000','6000') AND NOT is_postable) = 6);
  PERFORM pg_temp.check('a seeded account has the same id in every tenant (from its code)',
    v_ar = md5('gl_account:1200')::uuid);
  PERFORM pg_temp.check('every posting role has an active account that is posted to',
    (SELECT count(*) FROM public.posting_rules r JOIN public.gl_accounts a ON a.id = r.account_id AND a.is_postable AND a.is_active)
      = (SELECT count(*) FROM public.posting_rules) AND (SELECT count(*) FROM public.posting_rules) >= 15);  -- later migrations add roles (20260907: accrued_landed_costs)

  -- ══ 2. posting ════════════════════════════════════════════════════════════
  v_e1 := public._gl_post('test_doc', v_src, 'posted', DATE '2026-09-10', 'TST-1', 'a test sale', jsonb_build_array(
    jsonb_build_object('role', 'accounts_receivable', 'debit', 115, 'customer_id', gen_random_uuid()),
    jsonb_build_object('role', 'sales_revenue', 'credit', 100),
    jsonb_build_object('role', 'sales_tax_payable', 'credit', 15)));
  PERFORM pg_temp.check('a balanced posting writes one numbered entry with its lines',
    v_e1 IS NOT NULL
    AND (SELECT entry_no LIKE 'JE-2026-%' AND entry_date = DATE '2026-09-10' AND source_code = 'TST-1' FROM public.journal_entries WHERE id = v_e1)
    AND (SELECT count(*) FROM public.journal_lines WHERE entry_id = v_e1) = 3);
  PERFORM pg_temp.check('the same source and event posts once',
    public._gl_post('test_doc', v_src, 'posted', NULL, NULL, NULL, jsonb_build_array(
      jsonb_build_object('role', 'accounts_receivable', 'debit', 999),
      jsonb_build_object('role', 'sales_revenue', 'credit', 999))) = v_e1
    AND (SELECT count(*) FROM public.journal_entries WHERE source_id = v_src) = 1);

  v_out := pg_temp.try(format($s$SELECT public._gl_post('test_doc', %L, 'unbalanced', NULL, 'TST-2', NULL,
    '[{"role":"accounts_receivable","debit":100},{"role":"sales_revenue","credit":99.99}]')$s$, v_src2));
  PERFORM pg_temp.check('an entry that does not balance is refused', v_out LIKE 'err:23514%does not balance%', '-> ' || v_out);
  v_out := pg_temp.try(format($s$SELECT public._gl_post('test_doc', %L, 'one', NULL, NULL, NULL,
    '[{"role":"accounts_receivable","debit":0},{"role":"sales_revenue","credit":0}]')$s$, v_src2));
  PERFORM pg_temp.check('an all-zero posting writes nothing',
    v_out = 'ok' AND NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE source_id = v_src2), '-> ' || v_out);
  v_e2 := public._gl_post('test_doc', v_src2, 'rounded', DATE '2026-09-10', NULL, NULL,
    '[{"role":"cash","debit":10.005},{"role":"accounts_receivable","credit":10.005}]'::jsonb);
  PERFORM pg_temp.check('amounts are kept to the cent',
    (SELECT sum(debit) = 10.01 AND sum(credit) = 10.01 FROM public.journal_lines WHERE entry_id = v_e2));
  -- the commit-time check passes the engine's entries (run it now, not at commit)
  v_out := pg_temp.try('SET CONSTRAINTS trg_journal_lines_balanced, trg_journal_entries_balanced IMMEDIATE');
  PERFORM pg_temp.check('the engine''s entries pass the commit-time balance check', v_out = 'ok', '-> ' || v_out);
  SET CONSTRAINTS ALL DEFERRED;
  v_out := pg_temp.try(format($s$SELECT public._gl_post('test_doc', %L, 'header', NULL, NULL, NULL,
    jsonb_build_array(jsonb_build_object('account_id', %L, 'debit', 5), jsonb_build_object('role', 'sales_revenue', 'credit', 5)))$s$, v_src2, v_hdr));
  PERFORM pg_temp.check('a header account is never posted to', v_out LIKE 'err:P0001%1000 cannot be posted to%', '-> ' || v_out);
  v_out := pg_temp.try(format($s$SELECT public._gl_post('test_doc', %L, 'both', NULL, NULL, NULL,
    '[{"role":"cash","debit":5,"credit":5},{"role":"sales_revenue","credit":0}]')$s$, v_src2));
  PERFORM pg_temp.check('a line is a debit or a credit, not both', v_out LIKE 'err:22023%', '-> ' || v_out);
  v_out := pg_temp.try(format($s$SELECT public._gl_post('test_doc', %L, 'neg', NULL, NULL, NULL,
    '[{"role":"cash","debit":-5},{"role":"sales_revenue","debit":5}]')$s$, v_src2));
  PERFORM pg_temp.check('a negative amount is refused', v_out LIKE 'err:22023%', '-> ' || v_out);
  v_out := pg_temp.try(format($s$SELECT public._gl_post('test_doc', %L, 'both_keys', NULL, NULL, NULL,
    jsonb_build_array(jsonb_build_object('role', 'cash', 'account_id', %L, 'debit', 5), jsonb_build_object('role', 'sales_revenue', 'credit', 5)))$s$, v_src2, v_ar));
  PERFORM pg_temp.check('a line names a role or an account, not both', v_out LIKE 'err:22023%', '-> ' || v_out);

  -- a role with no account stops the posting (strict by default)
  PERFORM set_config('rma.audit_suspended', 'on', true);
  DELETE FROM public.posting_rules WHERE role = 'rounding';
  PERFORM set_config('rma.audit_suspended', 'off', true);
  v_out := pg_temp.try(format($s$SELECT public._gl_post('test_doc', %L, 'norule', NULL, NULL, NULL,
    '[{"role":"rounding","debit":1},{"role":"cash","credit":1}]')$s$, v_src2));
  PERFORM pg_temp.check('a posting whose role has no account fails', v_out LIKE 'err:P0001%No account is set for "rounding"%', '-> ' || v_out);
  INSERT INTO public.posting_rules (role, account_id) SELECT 'rounding', id FROM public.gl_accounts WHERE code = '6900';

  -- ══ 3. reversal ═══════════════════════════════════════════════════════════
  v_rev := public._gl_reverse('test_doc', v_src, 'posted', 'voided', DATE '2026-09-11', NULL);
  PERFORM pg_temp.check('a reversal swaps every line and points at the entry it reverses',
    (SELECT reverses_entry_id = v_e1 AND event = 'voided' AND memo LIKE 'Reverses JE-%' FROM public.journal_entries WHERE id = v_rev)
    AND (SELECT sum(debit) FROM public.journal_lines WHERE entry_id = v_rev AND account_id = v_ar) = 0  -- debit is NOT NULL DEFAULT 0
    AND (SELECT sum(credit) FROM public.journal_lines WHERE entry_id = v_rev AND account_id = v_ar) = 115
    AND (SELECT count(*) FROM public.journal_lines WHERE entry_id = v_rev AND customer_id IS NOT NULL) = 1);
  PERFORM pg_temp.check('reversing twice returns the first reversal',
    public._gl_reverse('test_doc', v_src, 'posted', 'voided', NULL, NULL) = v_rev);
  PERFORM pg_temp.check('reversing what was never posted does nothing',
    public._gl_reverse('test_doc', gen_random_uuid(), 'posted', 'voided', NULL, NULL) IS NULL);

  -- ══ 4. immutability ═══════════════════════════════════════════════════════
  v_out := pg_temp.try(format('UPDATE public.journal_entries SET memo = %L WHERE id = %L', 'edited', v_e1));
  PERFORM pg_temp.check('an entry cannot be changed, even by the owner', v_out LIKE 'err:P0001%reversing entry%', '-> ' || v_out);
  v_out := pg_temp.try(format('UPDATE public.journal_lines SET debit = 1 WHERE entry_id = %L AND debit > 0', v_e1));
  PERFORM pg_temp.check('a line cannot be changed', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.try(format('DELETE FROM public.journal_lines WHERE entry_id = %L', v_e1));
  PERFORM pg_temp.check('a line cannot be deleted', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.try('TRUNCATE public.journal_lines');
  PERFORM pg_temp.check('the journals cannot be truncated', v_out LIKE 'err:%', '-> ' || v_out);

  -- the balance is checked for any writer, at commit
  v_out := pg_temp.try(format($s$
    WITH e AS (INSERT INTO public.journal_entries (entry_no, entry_date, source_type, event, created_by)
               VALUES ('JE-TEST-X', DATE '2026-01-01', 'manual', 'direct', 'x') RETURNING id)
    INSERT INTO public.journal_lines (entry_id, line_no, account_id, debit) SELECT id, 0, %L, 50 FROM e$s$, v_ar));
  IF v_out = 'ok' THEN
    v_out := pg_temp.try('SET CONSTRAINTS trg_journal_lines_balanced, trg_journal_entries_balanced IMMEDIATE');
  END IF;
  PERFORM pg_temp.check('a one-sided entry written directly fails its balance check', v_out LIKE 'err:23514%does not balance%', '-> ' || v_out);
  SET CONSTRAINTS ALL DEFERRED;

  -- ══ 5. the chart keeps its meaning ════════════════════════════════════════
  v_out := pg_temp.try($s$UPDATE public.gl_accounts SET code = '1201' WHERE code = '1200'$s$);
  PERFORM pg_temp.check('an account with postings keeps its code', v_out LIKE 'err:P0001%code and type%', '-> ' || v_out);
  v_out := pg_temp.try($s$UPDATE public.gl_accounts SET account_type = 'expense' WHERE code = '1200'$s$);
  PERFORM pg_temp.check('... and its type', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.try($s$DELETE FROM public.gl_accounts WHERE code = '1200'$s$);
  PERFORM pg_temp.check('an account with postings cannot be deleted', v_out LIKE 'err:P0001%make it inactive%', '-> ' || v_out);
  v_out := pg_temp.try($s$UPDATE public.gl_accounts SET is_active = false WHERE code = '1110'$s$);
  PERFORM pg_temp.check('an account a posting rule uses cannot be made inactive', v_out LIKE 'err:P0001%posting rule%', '-> ' || v_out);
  v_out := pg_temp.try($s$UPDATE public.gl_accounts SET name = 'Main bank' WHERE code = '1110'$s$);
  PERFORM pg_temp.check('an account can be renamed', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.try(format($s$INSERT INTO public.gl_accounts (code, name, account_type, parent_id) VALUES ('1210', 'Other receivables', 'asset', %L)$s$, v_ar));
  PERFORM pg_temp.check('an account can only sit under a header', v_out LIKE 'err:P0001%header%', '-> ' || v_out);
  v_out := pg_temp.try($s$UPDATE public.posting_rules SET account_id = (SELECT id FROM public.gl_accounts WHERE code = '1000') WHERE role = 'cash'$s$);
  PERFORM pg_temp.check('a posting rule cannot point at a header', v_out LIKE 'err:P0001%', '-> ' || v_out);
  v_out := pg_temp.try($s$DELETE FROM public.posting_rules WHERE role = 'cash'$s$);
  PERFORM pg_temp.check('a posting rule cannot be removed', v_out LIKE 'err:P0001%', '-> ' || v_out);

  -- ══ 6. who reads and writes ═══════════════════════════════════════════════
  PERFORM pg_temp.check('an accountant reads the journals',
    pg_temp.seen(v_acct, format('SELECT count(*) FROM public.journal_lines WHERE entry_id = %L', v_e1)) = 3);
  PERFORM pg_temp.check('a technician reads none of them, but sees the chart',
    pg_temp.seen(v_tech, format('SELECT count(*) FROM public.journal_entries WHERE id = %L', v_e1)) = 0
    AND pg_temp.seen(v_tech, 'SELECT count(*) FROM public.gl_accounts WHERE code = ''1200''') = 1);
  PERFORM pg_temp.check('the trial balance nets a reversed sale to zero',
    pg_temp.seen(v_acct, $s$SELECT count(*) FROM public.rma_trial_balance(DATE '2026-09-10', DATE '2026-09-11')
      WHERE (code = '1200' AND debit = 115 AND credit = 125.01 AND balance = -10.01)
         OR (code = '4100' AND debit = 100 AND credit = 100 AND balance = 0)
         OR (code = '2200' AND balance = 0)$s$) = 3);
  v_out := pg_temp.call(v_tech, 'SELECT * FROM public.rma_trial_balance()');
  PERFORM pg_temp.check('a technician cannot run the trial balance', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, $s$INSERT INTO public.gl_accounts (code, name, account_type) VALUES ('4950', 'Mgr income', 'income')$s$);
  PERFORM pg_temp.check('a manager cannot change the chart', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_admin, format($s$INSERT INTO public.gl_accounts (code, name, account_type, parent_id) VALUES ('4950', 'Admin income', 'income', %L)$s$,
    (SELECT id FROM public.gl_accounts WHERE code = '4000')));
  PERFORM pg_temp.check('an administrator adds an account', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_admin, format($s$INSERT INTO public.journal_entries (entry_no, entry_date, source_type, event, created_by) VALUES ('JE-X', now()::date, 'manual', 'x', %L)$s$, v_admin));
  PERFORM pg_temp.check('nobody writes a journal directly, not even an administrator', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_admin, format($s$SELECT public._gl_post('manual', %L, 'x', NULL, NULL, NULL, '[{"role":"cash","debit":1},{"role":"sales_revenue","credit":1}]')$s$, gen_random_uuid()));
  PERFORM pg_temp.check('... and no client runs the posting engine', v_out LIKE 'err:42501%', '-> ' || v_out);
  PERFORM pg_temp.check('anon runs none of it',
    NOT has_function_privilege('anon', 'public.rma_trial_balance(date, date)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public._gl_reverse(text, uuid, text, text, date, text)', 'EXECUTE')
    AND NOT has_table_privilege('anon', 'public.gl_accounts', 'SELECT'));

  RAISE EXCEPTION 'A01A_TEST_DONE %', current_setting('a01a.log', true);
END $do$;
