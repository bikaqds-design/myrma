-- ############################################################################
-- #  RECONCILE DOCUMENT COUNTERS AFTER A RESTORE — BL-04 (20260878)
-- #
-- #  A backup cannot carry document_sequences, so a project restored into a
-- #  fresh database starts its counters at 0 while the restored invoices already
-- #  hold INV-<year>-00001 ... . The next post_invoice then reuses a number,
-- #  violates the unique code, and rolls its own counter bump back: every retry
-- #  yields the same number and no invoice can ever be posted.
-- #
-- #  HOW TO RUN:
-- #  node scripts/run-sql-test.mjs supabase/tests/reconcile_document_sequences.sql BL04B_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- ############################################################################

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail)
$f$;

CREATE FUNCTION pg_temp.counter(p_type text) RETURNS integer LANGUAGE sql AS $f$
  SELECT last_value FROM public.document_sequences WHERE seq_type = p_type
$f$;

DO $do$
DECLARE
  v_year  integer := EXTRACT(YEAR FROM now())::integer;
  v_cust  uuid;
  v_out   text;
  v_code  text;
BEGIN
  INSERT INTO public.customers (company_name, customer_code, customer_type, email)
  VALUES ('Reconcile Co', 'RECON-001', 'B2B', 'recon@example.invalid')
  RETURNING id INTO v_cust;

  -- Invoices already on the database (staging keeps real test data) would
  -- collide with the fixtures below; set their codes aside, rolled back.
  UPDATE public.crm_invoices SET inv_code = 'OLD-' || inv_code WHERE inv_code LIKE 'INV-%';

  -- A restored project: documents exist, the counters are back at zero.
  INSERT INTO public.crm_invoices (customer_id, doc_status, subtotal, total, created_by, inv_code)
  VALUES (v_cust, 'posted', 10, 10, 'recon@example.invalid', 'INV-' || v_year || '-00001'),
         (v_cust, 'posted', 10, 10, 'recon@example.invalid', 'INV-' || v_year || '-00042'),
         -- an older year's number must not raise this year's counter
         (v_cust, 'posted', 10, 10, 'recon@example.invalid', 'INV-' || (v_year - 1) || '-09999');
  UPDATE public.document_sequences SET last_value = 0, seq_year = v_year;

  -- ── the deadlock, reproduced ──────────────────────────────────────────────
  v_code := public.nextval_for_type('invoice');
  RAISE NOTICE '%', pg_temp.check('WITHOUT reconciling, the next number collides with a restored invoice',
    EXISTS (SELECT 1 FROM public.crm_invoices WHERE inv_code = v_code), '-> ' || v_code);
  UPDATE public.document_sequences SET last_value = 0 WHERE seq_type = 'invoice';

  -- ── the fix ───────────────────────────────────────────────────────────────
  PERFORM public.rma_reconcile_document_sequences();
  RAISE NOTICE '%', pg_temp.check('the invoice counter is set to the highest issued number',
    pg_temp.counter('invoice') = 42, '-> ' || pg_temp.counter('invoice'));
  RAISE NOTICE '%', pg_temp.check('a previous year''s number does not raise the counter',
    pg_temp.counter('invoice') <> 9999);
  v_code := public.nextval_for_type('invoice');
  RAISE NOTICE '%', pg_temp.check('the next invoice is the one AFTER the last restored',
    v_code = 'INV-' || v_year || '-00043', '-> ' || v_code);

  -- Types with nothing issued stay at zero and still hand out number 1.
  RAISE NOTICE '%', pg_temp.check('a type with no documents stays at 0',
    pg_temp.counter('batch') = 0 AND pg_temp.counter('customer_refund') = 0);  -- types staging has never numbered (it has since issued a credit note and a payment)

  -- Never lowers a counter: a healthy project is left exactly as it was.
  UPDATE public.document_sequences SET last_value = 500 WHERE seq_type = 'invoice';
  PERFORM public.rma_reconcile_document_sequences();
  RAISE NOTICE '%', pg_temp.check('it never lowers a counter that is already ahead',
    pg_temp.counter('invoice') = 500, '-> ' || pg_temp.counter('invoice'));

  -- A counter left over from an earlier year rolls over on its own; treating it
  -- as 0 stops a stale high value from being carried into the new year.
  UPDATE public.document_sequences SET last_value = 900, seq_year = v_year - 1 WHERE seq_type = 'invoice';
  PERFORM public.rma_reconcile_document_sequences();
  RAISE NOTICE '%', pg_temp.check('a counter from an earlier year is rebuilt from this year''s documents',
    pg_temp.counter('invoice') = 42 AND
    (SELECT seq_year FROM public.document_sequences WHERE seq_type = 'invoice') = v_year,
    '-> ' || pg_temp.counter('invoice'));

  -- A project provisioned with --no-seed has no rows at all.
  DELETE FROM public.document_sequences;
  PERFORM public.rma_reconcile_document_sequences();
  RAISE NOTICE '%', pg_temp.check('it recreates missing rows (a --no-seed project)',
    (SELECT count(*) FROM public.document_sequences) = 11 AND EXISTS (SELECT 1 FROM public.document_sequences WHERE seq_type = 'journal_entry') AND EXISTS (SELECT 1 FROM public.document_sequences WHERE seq_type = 'delivery') AND EXISTS (SELECT 1 FROM public.document_sequences WHERE seq_type = 'goods_receipt') AND pg_temp.counter('invoice') = 42,
    '-> ' || (SELECT count(*) FROM public.document_sequences) || ' rows');

  -- ── authorisation ─────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', 'nobody@example.invalid', 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.rma_reconcile_document_sequences();
    v_out := 'ok';
  EXCEPTION WHEN OTHERS THEN
    v_out := SQLSTATE;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE '%', pg_temp.check('a signed-in user with no admin role is refused',
    v_out = '42501', '-> ' || v_out);

  -- ...and a real administrator, through the same signed-in path, is allowed.
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES ('recon-admin@example.invalid', 'admin', 'active');
  UPDATE public.document_sequences SET last_value = 0 WHERE seq_type = 'invoice';
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', 'recon-admin@example.invalid', 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.rma_reconcile_document_sequences();
    v_out := 'ok';
  EXCEPTION WHEN OTHERS THEN
    v_out := SQLSTATE || ' ' || SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE NOTICE '%', pg_temp.check('an administrator can run it, and it repairs the counter',
    v_out = 'ok' AND pg_temp.counter('invoice') = 42, '-> ' || v_out);

  RAISE NOTICE '%', pg_temp.check('anon cannot execute it',
    NOT has_function_privilege('anon', 'public.rma_reconcile_document_sequences()', 'EXECUTE'));
  RAISE NOTICE '%', pg_temp.check('PUBLIC cannot execute it',
    NOT EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.oid = 'public.rma_reconcile_document_sequences()'::regprocedure
         AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'));
  RAISE NOTICE '%', pg_temp.check('search_path is pinned with pg_temp last',
    EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'rma_reconcile_document_sequences'
            AND proconfig::text LIKE '%pg_temp%'));

  RAISE EXCEPTION 'BL04B_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
