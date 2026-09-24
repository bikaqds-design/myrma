-- ############################################################################
-- #  CANCEL_SALES_ORDER REP CHECK — 20260895
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/cancel_sales_order_rep_check.sql CANCEL_REP_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- #  Puts the bare check back first (inside the transaction) so the probe
-- #  proves the hole on any database, then runs the migration's own block
-- #  (a copy; src/test/cancelSalesOrderRepCheck.test.js fails if it drifts).
-- ############################################################################

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail)
$f$;
CREATE FUNCTION pg_temp.call(p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE out text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    out := 'ok';
  EXCEPTION WHEN OTHERS THEN
    out := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 160);
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN out;
END $f$;

CREATE TEMP TABLE fx (tag text PRIMARY KEY, id uuid);

-- fixtures: two reps; orders created by rep 1 with no assigned rep
DO $do$
DECLARE
  v_cust uuid;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES
    ('cxr-rep1@test.local', 'sales_rep', 'active'), ('cxr-rep2@test.local', 'sales_rep', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type)
  VALUES ('CXR Co', 'CXR-C1', 'B2B') RETURNING id INTO v_cust;
  WITH a AS (
    INSERT INTO public.sales_orders (so_code, customer_id, created_by, assigned_rep, status)
    VALUES ('CXR-SO-A', v_cust, 'cxr-rep1@test.local', NULL, 'draft'),
           ('CXR-SO-B', v_cust, 'cxr-rep1@test.local', NULL, 'draft'),
           ('CXR-SO-C', v_cust, 'cxr-rep1@test.local', NULL, 'draft')
    RETURNING id, so_code)
  INSERT INTO fx SELECT so_code, id FROM a;
END $do$;

-- put the bare check back, whatever this database already has
DO $$
DECLARE v_def text;
BEGIN
  SELECT replace(pg_get_functiondef('public.cancel_sales_order'::regproc), E'\r\n', E'\n') INTO v_def;
  EXECUTE replace(v_def,
    E'IF NOT COALESCE(public.rma_is_manager_or_above()\n          OR v_so.assigned_rep = v_email\n          OR v_so.created_by  = v_email, false) THEN',
    E'IF NOT (public.rma_is_manager_or_above()\n          OR v_so.assigned_rep = v_email\n          OR v_so.created_by  = v_email) THEN');
END $$;

DO $do$
DECLARE v_out text;
BEGIN
  v_out := pg_temp.call('cxr-rep2@test.local', format('SELECT public.cancel_sales_order(%L, %L)', (SELECT id FROM fx WHERE tag = 'CXR-SO-A'), 'cxr-rep2@test.local'));
  RAISE NOTICE '%', pg_temp.check('before: the probe sees the hole (another rep cancels an unassigned order)', v_out = 'ok', '-> ' || v_out);
END $do$;

-- ── the migration's block, verbatim ────────────────────────────────────────
-- MIGRATION BLOCK START
DO $$
DECLARE
  v_def  text;
  v_have integer;
  v_old  text := E'IF NOT (public.rma_is_manager_or_above()\n          OR v_so.assigned_rep = v_email\n          OR v_so.created_by  = v_email) THEN';
  v_new  text := E'IF NOT COALESCE(public.rma_is_manager_or_above()\n          OR v_so.assigned_rep = v_email\n          OR v_so.created_by  = v_email, false) THEN';
BEGIN
  SELECT replace(pg_get_functiondef('public.cancel_sales_order'::regproc), E'\r\n', E'\n') INTO v_def;
  IF strpos(v_def, v_new) > 0 THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: cancel_sales_order holds its own-order check % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END $$;
-- MIGRATION BLOCK END

DO $do$
DECLARE v_out text;
BEGIN
  v_out := pg_temp.call('cxr-rep2@test.local', format('SELECT public.cancel_sales_order(%L, %L)', (SELECT id FROM fx WHERE tag = 'CXR-SO-B'), 'cxr-rep2@test.local'));
  RAISE NOTICE '%', pg_temp.check('after: another rep cannot cancel an unassigned order', v_out LIKE 'err:P0001%Not authorized to cancel this sales order%', '-> ' || v_out);
  v_out := pg_temp.call('cxr-rep1@test.local', format('SELECT public.cancel_sales_order(%L, %L)', (SELECT id FROM fx WHERE tag = 'CXR-SO-C'), 'cxr-rep1@test.local'));
  RAISE NOTICE '%', pg_temp.check('after: the rep who raised it still can', v_out = 'ok', '-> ' || v_out);
  RAISE EXCEPTION 'CANCEL_REP_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
