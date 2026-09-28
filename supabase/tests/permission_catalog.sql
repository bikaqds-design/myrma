-- ############################################################################
-- #  THE DATABASE ENFORCES THE PERMISSION MATRIX — W6 / S-01 (20260914)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/permission_catalog.sql S01_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI. The final
-- #  error message also carries every PASS/FAIL line.
-- #
-- #  Calls use ids that do not exist: a call that gets past the permission check
-- #  then fails on its own "not found"-type error, one that does not fails with
-- #  "Not authorized: you do not have permission …". So each check tells which
-- #  of the two refused it without building documents.
-- ############################################################################

SELECT set_config('s01.log', '', false);
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE l text := format('%s  %s %s', CASE WHEN COALESCE(p_ok, false) THEN 'PASS' ELSE 'FAIL' END, p_label, CASE WHEN COALESCE(p_ok, false) THEN '' ELSE p_detail END);
BEGIN
  PERFORM set_config('s01.log', COALESCE(current_setting('s01.log', true), '') || E'\n' || l, false);
  RETURN l;
END $f$;
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
CREATE FUNCTION pg_temp.has(p_email text, p_section text, p_action text) RETURNS boolean LANGUAGE plpgsql AS $f$
DECLARE out boolean;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  out := public.rma_has_permission(p_section, p_action);
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN out;
END $f$;
-- refused by the permission check, not by the function's own guard or data
CREATE FUNCTION pg_temp.denied(p_out text) RETURNS boolean LANGUAGE sql AS $f$
  SELECT p_out LIKE 'err:42501 Not authorized: you do not have permission%'
$f$;

DO $do$
DECLARE
  v_mgr    text := 's01-mgr@test.local';
  v_mgr2   text := 's01-mgr2@test.local';
  v_acct   text := 's01-acct@test.local';
  v_tech   text := 's01-tech@test.local';
  v_rep    text := 's01-rep@test.local';
  v_admin  text := 's01-admin@test.local';
  v_susp   text := 's01-susp@test.local';
  v_x      uuid := gen_random_uuid();
  v_out    text;
  v_n      int;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status, permissions) VALUES
    (v_mgr, 'manager', 'active', NULL),
    -- the plan's test: may post, may not void
    (v_mgr2, 'manager', 'active', '{"sales": {"post": true, "void": false}, "inventory": {"transfer": "no"}}'),
    (v_acct, 'accountant', 'active', '{}'),
    (v_tech, 'technician', 'active', '{"sales": {"post": true}}'),
    (v_rep, 'sales_rep', 'active', NULL),
    (v_admin, 'admin', 'active', '{"sales": {"void": false}}'),
    (v_susp, 'manager', 'suspended', NULL);

  -- ══ 1. the catalog ═════════════════════════════════════════════════════════
  SELECT count(*) INTO v_n FROM public.permission_catalog;
  PERFORM pg_temp.check('nineteen actions are enforced', v_n = 19, '-> ' || v_n);
  SELECT count(*) INTO v_n FROM public.permission_catalog c, unnest(c.functions) f
   WHERE position(format('rma_require_permission(%L, %L)', c.section, c.action)
                  IN pg_get_functiondef((SELECT p.oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f))) = 0;
  PERFORM pg_temp.check('every catalogued function checks its permission', v_n = 0, '-> ' || v_n || ' do not');

  -- ══ 2. what each role has by default ═══════════════════════════════════════
  PERFORM pg_temp.check('a manager may post, void, deliver and transfer; not close a period',
    pg_temp.has(v_mgr, 'sales', 'post') AND pg_temp.has(v_mgr, 'sales', 'void') AND pg_temp.has(v_mgr, 'sales', 'deliver')
    AND pg_temp.has(v_mgr, 'inventory', 'transfer') AND NOT pg_temp.has(v_mgr, 'accounting', 'close_period'));
  PERFORM pg_temp.check('an accountant (empty override) records payments and closes periods; does not post',
    pg_temp.has(v_acct, 'accounting', 'record_payment') AND pg_temp.has(v_acct, 'accounting', 'close_period')
    AND NOT pg_temp.has(v_acct, 'sales', 'post'));
  PERFORM pg_temp.check('a sales rep may not cancel an order, a technician may not adjust stock',
    NOT pg_temp.has(v_rep, 'sales', 'cancel') AND NOT pg_temp.has(v_tech, 'inventory', 'adjust'));
  PERFORM pg_temp.check('an administrator has everything, whatever is stored',
    pg_temp.has(v_admin, 'sales', 'void') AND pg_temp.has(v_admin, 'accounting', 'close_period'));
  PERFORM pg_temp.check('a suspended user has nothing', NOT pg_temp.has(v_susp, 'sales', 'post'));
  PERFORM pg_temp.check('an action not in the catalog is nobody''s but an administrator''s',
    NOT pg_temp.has(v_mgr, 'sales', 'teleport') AND pg_temp.has(v_admin, 'sales', 'teleport'));

  -- ══ 3. overrides ═══════════════════════════════════════════════════════════
  PERFORM pg_temp.check('an explicit false removes the action; a non-boolean is ignored',
    pg_temp.has(v_mgr2, 'sales', 'post') AND NOT pg_temp.has(v_mgr2, 'sales', 'void')
    AND pg_temp.has(v_mgr2, 'inventory', 'transfer'));

  -- the plan's test: a user with post but not void cannot void
  v_out := pg_temp.call(v_mgr2, format('SELECT public.void_invoice(%L, %L, %L)', v_x, 'S01 void', v_mgr2));
  PERFORM pg_temp.check('T: a manager with post but not void cannot void an invoice', pg_temp.denied(v_out), '-> ' || v_out);
  v_out := pg_temp.call(v_mgr2, format('SELECT public.void_credit_note(%L, %L, %L)', v_x, 'S01 void', v_mgr2));
  PERFORM pg_temp.check('… nor a credit note', pg_temp.denied(v_out), '-> ' || v_out);
  v_out := pg_temp.call(v_mgr2, format('SELECT public.post_invoice(%L, %L)', v_x, v_mgr2));
  PERFORM pg_temp.check('… and still gets past the check to post (then: no such invoice)',
    v_out LIKE 'err:%' AND NOT pg_temp.denied(v_out), '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('SELECT public.void_invoice(%L, %L, %L)', v_x, 'S01 void', v_mgr));
  PERFORM pg_temp.check('a manager with no override gets past it to void', v_out LIKE 'err:%' AND NOT pg_temp.denied(v_out), '-> ' || v_out);

  -- ══ 4. a permission never widens a role ════════════════════════════════════
  v_out := pg_temp.call(v_tech, format('SELECT public.post_invoice(%L, %L)', v_x, v_tech));
  PERFORM pg_temp.check('a technician granted sales.post still meets the manager guard',
    pg_temp.has(v_tech, 'sales', 'post') AND v_out LIKE 'err:%Not authorized%' AND NOT pg_temp.denied(v_out), '-> ' || v_out);

  -- ══ 5. refusals by default ═════════════════════════════════════════════════
  v_out := pg_temp.call(v_rep, format('SELECT public.cancel_sales_order(%L, %L)', v_x, v_rep));
  PERFORM pg_temp.check('a sales rep cannot cancel an order (the app never offered it)', pg_temp.denied(v_out), '-> ' || v_out);
  v_out := pg_temp.call(v_acct, format('SELECT public.post_invoice(%L, %L)', v_x, v_acct));
  PERFORM pg_temp.check('an accountant cannot post an invoice', pg_temp.denied(v_out), '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('SELECT public.soft_close_accounting_period(%L)', '2020-01-01'));
  PERFORM pg_temp.check('a manager cannot close a period', pg_temp.denied(v_out), '-> ' || v_out);
  v_out := pg_temp.call(v_acct, format('SELECT public.void_payment(%L, %L, %L)', v_x, 'S01', v_acct));
  PERFORM pg_temp.check('an accountant gets past the check to reverse a payment', v_out LIKE 'err:%' AND NOT pg_temp.denied(v_out), '-> ' || v_out);

  -- ══ 6. internals ═══════════════════════════════════════════════════════════
  BEGIN
    PERFORM public.rma_require_permission('sales', 'post');
    PERFORM pg_temp.check('with no login the function''s own guard decides (no refusal here)', true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('with no login the function''s own guard decides (no refusal here)', false, SQLERRM);
  END;
  BEGIN
    PERFORM public.rma_require_permission('sales', 'teleport');
    PERFORM pg_temp.check('an unknown permission is a programming error', false);
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.check('an unknown permission is a programming error', SQLERRM LIKE 'Unknown permission%', SQLERRM);
  END;
  v_out := pg_temp.call(v_mgr, $s$SELECT public.rma_require_permission('sales', 'post')$s$);
  PERFORM pg_temp.check('signed-in users cannot call rma_require_permission directly', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_admin, $s$INSERT INTO public.permission_catalog VALUES ('sales', 'x', 'x', '{}', '{post_invoice}')$s$);
  PERFORM pg_temp.check('nobody writes the catalog, not even an administrator', v_out LIKE 'err:42501%', '-> ' || v_out);
  PERFORM pg_temp.check('anon runs neither function',
    NOT has_function_privilege('anon', 'public.rma_has_permission(text, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rma_require_permission(text, text)', 'EXECUTE'));

  RAISE EXCEPTION 'S01_TEST_DONE %', current_setting('s01.log', true);
END $do$;
