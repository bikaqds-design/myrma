-- ############################################################################
-- #  SERVER-SIDE AUDIT LOG — BL-02 / I-02 (20260876)
-- #
-- #  Every insert, update and delete on the financial, stock, master-data and
-- #  access tables must leave an append-only row saying who, when, what changed
-- #  and the before/after values. Written FIRST (red) and kept as the
-- #  regression test.
-- #
-- #  HOW TO RUN: paste into the SQL editor or execute_sql against a project
-- #  that has 20260876 applied. ENDS WITH A FORCED ROLLBACK. Reference script,
-- #  not run by CI (db-tests is disabled).
-- ############################################################################

CREATE FUNCTION pg_temp.probe(p_label text, p_email text, p_sql text, p_expect text)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  n bigint;
  outcome text;
  ok boolean;
BEGIN
  IF p_email IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', p_email, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    outcome := 'ok:' || n;
  EXCEPTION WHEN OTHERS THEN
    outcome := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 100);
  END;
  IF p_email IS NOT NULL THEN
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', '', true);
  END IF;

  ok := CASE p_expect
          WHEN 'p0001'  THEN outcome LIKE 'err:P0001%'
          WHEN 'denied' THEN outcome LIKE 'err:42501%'
          ELSE outcome LIKE 'ok:%' AND outcome <> 'ok:0'
        END;
  RETURN format('%s  %-52s expect %-6s -> %s',
    CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_expect, outcome);
END $f$;

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail)
$f$;

DO $do$
DECLARE
  v_admin    text := 'bl02-admin@test.local';
  v_viewer   text := 'bl02-viewer@test.local';
  v_accountant text := 'bl02-accountant@test.local';
  v_session  uuid;
  v_customer uuid := gen_random_uuid();
  v_invoice  uuid := gen_random_uuid();
  v_row      record;
  v_n        bigint;
  v_before   bigint;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES (v_admin, 'admin', 'active'), (v_viewer, 'viewer', 'active');

  RAISE NOTICE '--- 1. Inserts, updates and deletes are captured ---';
  -- Written by the admin, so the actor is a real address.
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_admin, 'role', 'authenticated')::text, true);
  INSERT INTO public.customers (id, customer_code, customer_type, company_name)
  VALUES (v_customer, 'BL02-CUST', 'B2B', 'Before Ltd');

  SELECT * INTO v_row FROM public.audit_log
   WHERE table_name = 'customers' AND row_id = v_customer::text AND action = 'I';
  RAISE NOTICE '%', pg_temp.check('INSERT logged with the full new row',
    v_row.id IS NOT NULL AND v_row.new_row ->> 'company_name' = 'Before Ltd' AND v_row.old_row IS NULL);
  RAISE NOTICE '%', pg_temp.check('actor is the JWT email, not a database role',
    v_row.actor_email = v_admin, coalesce(v_row.actor_email, '<null>'));

  UPDATE public.customers SET company_name = 'After Ltd', notes = 'n' WHERE id = v_customer;
  SELECT * INTO v_row FROM public.audit_log
   WHERE table_name = 'customers' AND row_id = v_customer::text AND action = 'U';
  RAISE NOTICE '%', pg_temp.check('UPDATE logs only the changed keys',
    v_row.changed_keys = ARRAY['company_name', 'notes']
    AND v_row.old_row ->> 'company_name' = 'Before Ltd'
    AND v_row.new_row ->> 'company_name' = 'After Ltd'
    AND NOT (v_row.new_row ? 'customer_code'), coalesce(v_row.changed_keys::text, '<null>'));

  SELECT count(*) INTO v_before FROM public.audit_log WHERE table_name = 'customers';
  UPDATE public.customers SET company_name = 'After Ltd' WHERE id = v_customer;
  UPDATE public.customers SET updated_date = now() WHERE id = v_customer;
  SELECT count(*) INTO v_n FROM public.audit_log WHERE table_name = 'customers';
  RAISE NOTICE '%', pg_temp.check('a no-op or timestamp-only update adds no row', v_n = v_before,
    format('(%s -> %s)', v_before, v_n));

  DELETE FROM public.customers WHERE id = v_customer;
  SELECT * INTO v_row FROM public.audit_log
   WHERE table_name = 'customers' AND row_id = v_customer::text AND action = 'D';
  RAISE NOTICE '%', pg_temp.check('DELETE logged with the old row',
    v_row.id IS NOT NULL AND v_row.old_row ->> 'company_name' = 'After Ltd' AND v_row.new_row IS NULL);
  PERFORM set_config('request.jwt.claims', '', true);

  RAISE NOTICE '--- 2. Posting an invoice records the posting ---';
  INSERT INTO public.customers (id, customer_code, customer_type) VALUES (v_customer, 'BL02-C2', 'B2B');
  INSERT INTO public.crm_invoices (id, customer_id, doc_status, total, created_by)
  VALUES (v_invoice, v_customer, 'draft', 100, 'system@test');
  UPDATE public.crm_invoices
     SET doc_status = 'posted', posted_at = now(), inv_code = 'INV-2026-99002'
   WHERE id = v_invoice;
  SELECT * INTO v_row FROM public.audit_log
   WHERE table_name = 'crm_invoices' AND row_id = v_invoice::text AND action = 'U';
  RAISE NOTICE '%', pg_temp.check('posting logs doc_status, posted_at and inv_code',
    v_row.changed_keys @> ARRAY['doc_status', 'posted_at', 'inv_code'], coalesce(v_row.changed_keys::text, '<null>'));

  RAISE NOTICE '--- 3. Sensitive columns are redacted ---';
  RAISE NOTICE '%', pg_temp.check('rma_audit_redact hides secrets, keeps the rest',
    public.rma_audit_redact('{"api_token":"abc","password_hash":"x","name":"y"}'::jsonb)
      = '{"api_token":"[REDACTED]","password_hash":"[REDACTED]","name":"y"}'::jsonb);

  RAISE NOTICE '--- 4. The log cannot be written or altered from the client ---';
  RAISE NOTICE '%', pg_temp.probe('client INSERT into audit_log', v_admin,
    'INSERT INTO public.audit_log (table_name, row_id, action) VALUES (''x'', ''1'', ''I'')', 'denied');
  RAISE NOTICE '%', pg_temp.probe('client UPDATE of audit_log', v_admin,
    'UPDATE public.audit_log SET actor_email = ''forged''', 'denied');
  RAISE NOTICE '%', pg_temp.probe('client DELETE from audit_log', v_admin,
    'DELETE FROM public.audit_log', 'denied');
  RAISE NOTICE '%', pg_temp.probe('owner UPDATE of audit_log (append-only)', NULL,
    'UPDATE public.audit_log SET actor_email = ''forged''', 'p0001');
  RAISE NOTICE '%', pg_temp.probe('owner DELETE from audit_log (append-only)', NULL,
    'DELETE FROM public.audit_log', 'p0001');
  RAISE NOTICE '%', pg_temp.probe('owner TRUNCATE of audit_log (append-only)', NULL,
    'TRUNCATE public.audit_log', 'p0001');

  RAISE NOTICE '--- 5. Who can read it ---';
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_admin, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM public.audit_log;
  EXECUTE 'RESET ROLE';
  RAISE NOTICE '%', pg_temp.check('admin can read the log', v_n > 0, format('(%s rows)', v_n));

  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_viewer, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM public.audit_log;
  EXECUTE 'RESET ROLE';
  RAISE NOTICE '%', pg_temp.check('viewer sees no rows', v_n = 0, format('(%s rows)', v_n));

  PERFORM set_config('request.jwt.claims', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    SELECT count(*) INTO v_n FROM public.audit_log;
    RAISE NOTICE '%', pg_temp.check('anon cannot read the log', false, '(query succeeded)');
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '%', pg_temp.check('anon cannot read the log', true);
  END;
  EXECUTE 'RESET ROLE';

  RAISE NOTICE '--- 6. Review findings: accountant scope, service_role, TRUNCATE ---';
  INSERT INTO public.user_roles (user_email, role, status) VALUES (v_accountant, 'accountant', 'active');
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_accountant, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM public.audit_log WHERE table_name = 'crm_invoices';
  SELECT count(*) INTO v_before FROM public.audit_log WHERE table_name IN ('user_roles', 'rma_config', 'customers');
  EXECUTE 'RESET ROLE';
  RAISE NOTICE '%', pg_temp.check('accountant reads financial-document history', v_n > 0, format('(%s rows)', v_n));
  RAISE NOTICE '%', pg_temp.check('accountant does NOT read user_roles / rma_config / customers history',
    v_before = 0, format('(%s rows)', v_before));

  RAISE NOTICE '%', pg_temp.check('service_role has no INSERT/UPDATE/DELETE/TRUNCATE on audit_log',
    NOT has_table_privilege('service_role', 'public.audit_log', 'INSERT')
    AND NOT has_table_privilege('service_role', 'public.audit_log', 'UPDATE')
    AND NOT has_table_privilege('service_role', 'public.audit_log', 'DELETE')
    AND NOT has_table_privilege('service_role', 'public.audit_log', 'TRUNCATE'));
  RAISE NOTICE '%', pg_temp.check('authenticated cannot TRUNCATE an audited table',
    NOT has_table_privilege('authenticated', 'public.crm_invoices', 'TRUNCATE')
    AND NOT has_table_privilege('authenticated', 'public.user_roles', 'TRUNCATE'));

  SELECT count(*) INTO v_before FROM public.audit_log WHERE table_name = 'brands' AND action = 'T';
  TRUNCATE public.brands CASCADE;
  SELECT count(*) INTO v_n FROM public.audit_log WHERE table_name = 'brands' AND action = 'T';
  RAISE NOTICE '%', pg_temp.check('TRUNCATE by the owner leaves an audit row', v_n = v_before + 1);

  RAISE NOTICE '--- 7. Restore writes one summary row per table, not one per row ---';
  SELECT count(*) INTO v_before FROM public.audit_log WHERE table_name = 'crm_invoices' AND action IN ('I', 'U');
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_admin, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_session := public.rma_restore_begin();
  PERFORM public.rma_restore_stage(v_session, 'crm_invoices', jsonb_build_array(
    jsonb_build_object('id', v_invoice, 'customer_id', v_customer, 'doc_status', 'posted',
                       'total', 250, 'created_by', 'system@test')));
  PERFORM public.rma_restore_apply(v_session);
  EXECUTE 'RESET ROLE';
  SELECT count(*) INTO v_n FROM public.audit_log WHERE table_name = 'crm_invoices' AND action IN ('I', 'U');
  RAISE NOTICE '%', pg_temp.check('restore wrote no per-row I/U audit row', v_n = v_before, format('(%s -> %s)', v_before, v_n));
  SELECT * INTO v_row FROM public.audit_log WHERE table_name = 'crm_invoices' AND action = 'R';
  RAISE NOTICE '%', pg_temp.check('restore wrote one R summary row with the counts',
    v_row.id IS NOT NULL AND (v_row.new_row ->> 'rows_written')::int = 1 AND v_row.actor_email = v_admin,
    coalesce(v_row.new_row::text, '<none>'));
  UPDATE public.crm_invoices SET notes = 'after restore' WHERE id = v_invoice;
  SELECT count(*) INTO v_n FROM public.audit_log WHERE table_name = 'crm_invoices' AND action = 'U' AND new_row ? 'notes';
  RAISE NOTICE '%', pg_temp.check('per-row auditing is back after the restore', v_n = 1, format('(%s rows)', v_n));
  PERFORM set_config('request.jwt.claims', '', true);

  RAISE EXCEPTION 'BL02_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
