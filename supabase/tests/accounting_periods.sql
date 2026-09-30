-- ############################################################################
-- #  ACCOUNTING PERIODS AND MONTH-END CLOSE — A-03 (20260910)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/accounting_periods.sql A03_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI. The final
-- #  error message also carries every PASS/FAIL line.
-- #
-- #  Covers the gap analysis' T-09a (close August, then a posting dated
-- #  2026-08-25 is refused) and T-09b (reopening needs a second approver and
-- #  leaves an audit entry). Postings go through the engine (_gl_post) with a
-- #  signed-in user's claims, as a document step's trigger would.
-- ############################################################################

SELECT set_config('a03.log', '', false);
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE l text := format('%s  %s %s', CASE WHEN COALESCE(p_ok, false) THEN 'PASS' ELSE 'FAIL' END, p_label, CASE WHEN COALESCE(p_ok, false) THEN '' ELSE p_detail END);
BEGIN
  PERFORM set_config('a03.log', COALESCE(current_setting('a03.log', true), '') || E'\n' || l, false);
  RETURN l;
END $f$;
-- run SQL as a signed-in client
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
-- post through the engine as a document step run by p_email would
CREATE FUNCTION pg_temp.post(p_email text, p_date date, p_code text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE out text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public._gl_post('a03_test', gen_random_uuid(), 'posted', p_date, p_code, NULL,
      '[{"role":"accounts_receivable","debit":10},{"role":"sales_revenue","credit":10}]'::jsonb);
    out := 'ok';
  EXCEPTION WHEN OTHERS THEN
    out := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 200);
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN out;
END $f$;
CREATE FUNCTION pg_temp.st(p_month date) RETURNS text LANGUAGE sql AS $f$
  SELECT public.rma_period_status(p_month)
$f$;

DO $do$
DECLARE
  v_acct   text := 'a03-acct@test.local';
  v_admin1 text := 'a03-admin1@test.local';
  v_admin2 text := 'a03-admin2@test.local';
  v_mgr    text := 'a03-mgr@test.local';
  v_tech   text := 'a03-tech@test.local';
  v_out    text;
  v_req    uuid;
  v_n      integer;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES
    (v_acct, 'accountant', 'active'), (v_admin1, 'admin', 'active'), (v_admin2, 'admin', 'active'),
    (v_mgr, 'manager', 'active'), (v_tech, 'technician', 'active');

  -- ══ 1. an open month takes postings from anyone who can post ══════════════
  PERFORM pg_temp.check('a month with no row is open', pg_temp.st('2026-08-10') = 'open');
  v_out := pg_temp.post(v_mgr, '2026-08-25', 'A03-OPEN');
  PERFORM pg_temp.check('open August: a manager''s posting dated 2026-08-25 goes in', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.post(v_mgr, '2026-07-10', 'A03-JUL');
  PERFORM pg_temp.check('and one dated in July', v_out = 'ok', '-> ' || v_out);

  -- ══ 2. who may close, and when ════════════════════════════════════════════
  v_out := pg_temp.call(v_mgr, $s$SELECT public.soft_close_accounting_period('2026-07-01')$s$);
  PERFORM pg_temp.check('a manager cannot close a period', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_tech, $s$SELECT public.soft_close_accounting_period('2026-07-01')$s$);
  PERFORM pg_temp.check('a technician cannot either', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, format('SELECT public.soft_close_accounting_period(%L)', date_trunc('month', public.rma_today())::date));
  PERFORM pg_temp.check('the current month cannot be closed before it ends', v_out LIKE 'err:22023%', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, $s$SELECT public.soft_close_accounting_period('2026-08-01')$s$);
  PERFORM pg_temp.check('months close in order: August waits for July', v_out LIKE 'err:P0001%Close July 2026 first%', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, $s$SELECT public.close_accounting_period('2026-07-01')$s$);
  PERFORM pg_temp.check('a month is soft closed before it is closed', v_out LIKE 'err:P0001%must be soft closed%', '-> ' || v_out);

  v_out := pg_temp.call(v_acct, $s$SELECT public.soft_close_accounting_period('2026-07-15')$s$);
  PERFORM pg_temp.check('an accountant soft closes July (any day of it names the month)', v_out = 'ok' AND pg_temp.st('2026-07-01') = 'soft_closed', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, $s$SELECT public.soft_close_accounting_period('2026-08-01')$s$);
  PERFORM pg_temp.check('then August', v_out = 'ok' AND pg_temp.st('2026-08-01') = 'soft_closed', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, $s$SELECT public.soft_close_accounting_period('2026-08-01')$s$);
  PERFORM pg_temp.check('soft closing it twice is refused', v_out LIKE 'err:P0001%already%', '-> ' || v_out);

  -- ══ 3. a soft-closed month takes finance postings only ═════════════════════
  v_out := pg_temp.post(v_mgr, '2026-08-26', 'A03-SOFT-MGR');
  PERFORM pg_temp.check('soft-closed August: a manager''s posting is refused', v_out LIKE 'err:P0001%being closed%', '-> ' || v_out);
  v_out := pg_temp.post(v_acct, '2026-08-26', 'A03-SOFT-ACCT');
  PERFORM pg_temp.check('an accountant''s goes in', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.post(v_admin1, '2026-08-26', 'A03-SOFT-ADMIN');
  PERFORM pg_temp.check('so does an administrator''s', v_out = 'ok', '-> ' || v_out);

  -- reopening a soft-closed month: finance alone, latest first
  v_out := pg_temp.call(v_acct, $s$SELECT public.reopen_soft_closed_period('2026-07-01')$s$);
  PERFORM pg_temp.check('July cannot reopen while August is being closed', v_out LIKE 'err:P0001%Reopen August 2026 first%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, $s$SELECT public.reopen_soft_closed_period('2026-08-01')$s$);
  PERFORM pg_temp.check('a manager cannot reopen', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, $s$SELECT public.reopen_soft_closed_period('2026-08-01')$s$);
  PERFORM pg_temp.check('an accountant reopens soft-closed August on their own', v_out = 'ok' AND pg_temp.st('2026-08-01') = 'open', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, $s$SELECT public.soft_close_accounting_period('2026-08-01')$s$);
  PERFORM pg_temp.check('and soft closes it again', v_out = 'ok', '-> ' || v_out);

  -- ══ 4. close (T-09a) ═══════════════════════════════════════════════════════
  v_out := pg_temp.call(v_acct, $s$SELECT public.close_accounting_period('2026-08-01')$s$);
  PERFORM pg_temp.check('August cannot close while July is only soft closed', v_out LIKE 'err:P0001%Close July 2026 first%', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, $s$SELECT public.close_accounting_period('2026-07-01')$s$);
  PERFORM pg_temp.check('July closes', v_out = 'ok' AND pg_temp.st('2026-07-31') = 'closed', '-> ' || v_out);
  v_out := pg_temp.call(v_admin1, $s$SELECT public.close_accounting_period('2026-08-01')$s$);
  PERFORM pg_temp.check('an administrator closes August', v_out = 'ok' AND pg_temp.st('2026-08-01') = 'closed', '-> ' || v_out);
  PERFORM pg_temp.check('who closed it and when is kept',
    (SELECT closed_by = v_admin1 AND closed_at IS NOT NULL AND soft_closed_by = v_acct FROM public.accounting_periods WHERE period_start = '2026-08-01'));

  v_out := pg_temp.post(v_mgr, '2026-08-25', 'A03-T09A');
  PERFORM pg_temp.check('T-09a: a posting dated 2026-08-25 is refused once August is closed', v_out LIKE 'err:P0001%is closed%', '-> ' || v_out);
  v_out := pg_temp.post(v_admin1, '2026-08-25', 'A03-T09A-ADMIN');
  PERFORM pg_temp.check('even an administrator''s', v_out LIKE 'err:P0001%is closed%', '-> ' || v_out);
  v_out := pg_temp.post(v_mgr, public.rma_today(), 'A03-TODAY');
  PERFORM pg_temp.check('today''s postings are untouched', v_out = 'ok', '-> ' || v_out);
  PERFORM pg_temp.check('nothing dated in closed August got in after the close',
    NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE source_code LIKE 'A03-T09A%'));

  -- a restore writes rows as they were
  PERFORM set_config('rma.audit_suspended', 'on', true);
  v_out := pg_temp.post(v_mgr, '2026-08-20', 'A03-RESTORE');
  PERFORM set_config('rma.audit_suspended', 'off', true);
  PERFORM pg_temp.check('a restore is left alone', v_out = 'ok', '-> ' || v_out);

  -- ══ 5. reopening a closed month (T-09b) ════════════════════════════════════
  v_out := pg_temp.call(v_acct, $s$SELECT public.request_period_reopen('2026-07-01', 'Missed a supplier bill')$s$);
  PERFORM pg_temp.check('July cannot be reopened while August is closed', v_out LIKE 'err:P0001%Reopen August 2026 first%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, $s$SELECT public.request_period_reopen('2026-08-01', 'Missed a supplier bill')$s$);
  PERFORM pg_temp.check('a manager cannot ask', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, $s$SELECT public.request_period_reopen('2026-08-01', 'oops')$s$);
  PERFORM pg_temp.check('a reason of at least 10 characters is required', v_out LIKE 'err:22023%', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, $s$SELECT public.reopen_soft_closed_period('2026-08-01')$s$);
  PERFORM pg_temp.check('a closed month is not reopened by one person', v_out LIKE 'err:P0001%not soft closed%', '-> ' || v_out);

  v_out := pg_temp.call(v_admin1, $s$SELECT public.request_period_reopen('2026-08-01', 'Supplier bill INV-77 was dated August')$s$);
  SELECT id INTO v_req FROM public.period_reopen_requests WHERE period_start = '2026-08-01' AND status = 'pending';
  PERFORM pg_temp.check('an administrator asks to reopen August', v_out = 'ok' AND v_req IS NOT NULL, '-> ' || v_out);
  v_out := pg_temp.call(v_acct, $s$SELECT public.request_period_reopen('2026-08-01', 'A second request for August')$s$);
  PERFORM pg_temp.check('one waiting request per month', v_out LIKE 'err:P0001%already waiting%', '-> ' || v_out);
  v_out := pg_temp.call(v_admin1, format('SELECT public.approve_period_reopen(%L)', v_req));
  PERFORM pg_temp.check('T-09b: the one who asked cannot approve', v_out LIKE 'err:42501%Another administrator%' AND pg_temp.st('2026-08-01') = 'closed', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, format('SELECT public.approve_period_reopen(%L)', v_req));
  PERFORM pg_temp.check('an accountant cannot approve', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('SELECT public.reject_period_reopen(%L)', v_req));
  PERFORM pg_temp.check('a manager cannot turn it down', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_admin2, format('SELECT public.reject_period_reopen(%L, %L)', v_req, 'Post it in September'));
  PERFORM pg_temp.check('another administrator turns it down; August stays closed',
    v_out = 'ok' AND pg_temp.st('2026-08-01') = 'closed'
    AND (SELECT status = 'rejected' AND decided_by = v_admin2 AND decision_note = 'Post it in September' FROM public.period_reopen_requests WHERE id = v_req),
    '-> ' || v_out);

  -- ask again, withdraw
  v_out := pg_temp.call(v_acct, $s$SELECT public.request_period_reopen('2026-08-01', 'Supplier bill INV-77 was dated August')$s$);
  SELECT id INTO v_req FROM public.period_reopen_requests WHERE period_start = '2026-08-01' AND status = 'pending';
  v_out := pg_temp.call(v_acct, format('SELECT public.reject_period_reopen(%L)', v_req));
  PERFORM pg_temp.check('the one who asked may withdraw it', v_out = 'ok', '-> ' || v_out);

  -- ask again, approve
  v_out := pg_temp.call(v_acct, $s$SELECT public.request_period_reopen('2026-08-01', 'Supplier bill INV-77 was dated August')$s$);
  SELECT id INTO v_req FROM public.period_reopen_requests WHERE period_start = '2026-08-01' AND status = 'pending';
  v_out := pg_temp.call(v_admin2, format('SELECT public.approve_period_reopen(%L, %L)', v_req, 'OK, close again this week'));
  PERFORM pg_temp.check('T-09b: another administrator approves; August returns to soft closed with the reason',
    v_out = 'ok' AND pg_temp.st('2026-08-01') = 'soft_closed'
    AND (SELECT reopened_by = v_admin2 AND reopen_reason = 'Supplier bill INV-77 was dated August' FROM public.accounting_periods WHERE period_start = '2026-08-01'),
    '-> ' || v_out);
  v_out := pg_temp.call(v_admin1, format('SELECT public.approve_period_reopen(%L)', v_req));
  PERFORM pg_temp.check('a request is approved once', v_out LIKE 'err:P0001%not waiting%', '-> ' || v_out);
  v_out := pg_temp.post(v_acct, '2026-08-25', 'A03-REOPENED');
  PERFORM pg_temp.check('the accountant can now post the correction dated 2026-08-25', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.post(v_mgr, '2026-08-25', 'A03-REOPENED-MGR');
  PERFORM pg_temp.check('a manager still cannot', v_out LIKE 'err:P0001%being closed%', '-> ' || v_out);

  SELECT count(*) INTO v_n FROM public.audit_log
   WHERE table_name IN ('accounting_periods', 'period_reopen_requests') AND actor_email = v_admin2;
  PERFORM pg_temp.check('T-09b: the approval is in the audit log under the approver', v_n >= 2, '-> ' || v_n);

  -- ══ 6. the checklist ═══════════════════════════════════════════════════════
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_acct, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM public.rma_period_close_checklist('2026-08-01');
  PERFORM pg_temp.check('the checklist lists nine items (bank reconciliation not available yet; 20260918 adds foreign balances not revalued)',
    v_n = 9 AND EXISTS (SELECT 1 FROM public.rma_period_close_checklist('2026-08-01') WHERE item = 'bank_reconciliation' AND item_count IS NULL));
  PERFORM set_config('request.jwt.claims', '', true);
  v_out := pg_temp.call(v_acct, $s$SELECT * FROM public.rma_period_close_checklist('2026-08-01')$s$);
  PERFORM pg_temp.check('an accountant reads it', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_tech, $s$SELECT * FROM public.rma_period_close_checklist('2026-08-01')$s$);
  PERFORM pg_temp.check('a technician cannot', v_out LIKE 'err:42501%', '-> ' || v_out);

  -- ══ 7. nobody writes the tables directly ══════════════════════════════════
  v_out := pg_temp.call(v_admin1, $s$UPDATE public.accounting_periods SET status = 'open' WHERE period_start = '2026-07-01'$s$);
  PERFORM pg_temp.check('not even an administrator reopens a month by hand', v_out LIKE 'err:42501%' AND pg_temp.st('2026-07-01') = 'closed', '-> ' || v_out);
  v_out := pg_temp.call(v_admin1, $s$INSERT INTO public.period_reopen_requests (period_start, reason, requested_by, status) VALUES ('2026-07-01', 'Sneaky approval here', 'x', 'approved')$s$);
  PERFORM pg_temp.check('or writes a request', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_tech, $s$SELECT count(*) FROM public.accounting_periods$s$);
  PERFORM pg_temp.check('staff can see which months are closed', v_out = 'ok', '-> ' || v_out);
  PERFORM pg_temp.check('anon runs none of the period functions',
    NOT has_function_privilege('anon', 'public.soft_close_accounting_period(date)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.request_period_reopen(date, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rma_period_status(date)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._period_lock_month(date)', 'EXECUTE'));

  RAISE EXCEPTION 'A03_TEST_DONE %', current_setting('a03.log', true);
END $do$;
