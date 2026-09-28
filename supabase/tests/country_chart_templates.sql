-- ############################################################################
-- #  COUNTRY CHART TEMPLATES — A-02 (20260908)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/country_chart_templates.sql A02_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI. The final
-- #  error message also carries every PASS/FAIL line.
-- ############################################################################

SELECT set_config('a02.log', '', false);
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE l text := format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, CASE WHEN COALESCE(p_ok, false) THEN '' ELSE p_detail END);
BEGIN
  PERFORM set_config('a02.log', COALESCE(current_setting('a02.log', true), '') || E'\n' || l, false);
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
-- run a function returning jsonb as a signed-in user
CREATE FUNCTION pg_temp.json_as(p_email text, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE out jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  EXECUTE p_sql INTO out;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN out;
END $f$;
CREATE FUNCTION pg_temp.rule(p_role text) RETURNS text LANGUAGE sql AS $f$
  SELECT a.code FROM public.posting_rules r JOIN public.gl_accounts a ON a.id = r.account_id WHERE r.role = p_role
$f$;

-- Applying a template needs an empty journal. Staging keeps real entries (the
-- journal is immutable), so inside this transaction — which always rolls back
-- — the journal tables' own triggers are switched off to empty it. Needs the
-- table owner; nothing here survives the rollback.
ALTER TABLE public.journal_lines DISABLE TRIGGER USER;    -- the immutability and deferred balance triggers
ALTER TABLE public.journal_entries DISABLE TRIGGER USER;
DELETE FROM public.journal_lines;
DELETE FROM public.journal_entries;
-- (left off: the queued foreign-key events forbid re-enabling them in this
-- transaction, and the rollback restores them. The steps below do not rely on them.)

DO $do$
DECLARE
  v_admin text := 'a02-admin@test.local';
  v_mgr   text := 'a02-mgr@test.local';
  v_tech  text := 'a02-tech@test.local';
  v_res   jsonb;
  v_out   text;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES
    (v_admin, 'admin', 'active'), (v_mgr, 'manager', 'active'), (v_tech, 'technician', 'active');

  -- ══ 1. the templates ═══════════════════════════════════════════════════════
  PERFORM pg_temp.check('three templates: Egypt 95, UAE 92, Saudi Arabia 95 accounts',
    (SELECT string_agg(country_code || ':' || n, ',' ORDER BY country_code)
       FROM (SELECT country_code, count(*) n FROM public.gl_chart_templates GROUP BY 1) x) = 'AE:92,EG:95,SA:95');
  PERFORM pg_temp.check('every template account has an Arabic name',
    NOT EXISTS (SELECT 1 FROM public.gl_chart_templates WHERE btrim(name_ar) = ''));
  v_out := pg_temp.call(v_tech, 'SELECT count(*) FROM public.gl_chart_templates');
  PERFORM pg_temp.check('staff can read them', v_out = 'ok', '-> ' || v_out);
  v_out := pg_temp.call(v_admin, $s$INSERT INTO public.gl_chart_templates VALUES ('EG', '9999', 'x', 'x', 'asset', NULL, true, NULL)$s$);
  PERFORM pg_temp.check('nobody writes them, not even an administrator', v_out LIKE 'err:42501%', '-> ' || v_out);

  -- ══ 2. applying one ════════════════════════════════════════════════════════
  v_out := pg_temp.call(v_mgr, $s$SELECT public.rma_apply_chart_template('EG')$s$);
  PERFORM pg_temp.check('a manager cannot replace the chart', v_out LIKE 'err:42501%', '-> ' || v_out);
  v_out := pg_temp.call(v_admin, $s$SELECT public.rma_apply_chart_template('FR')$s$);
  PERFORM pg_temp.check('an unknown country is refused', v_out LIKE 'err:22023%', '-> ' || v_out);

  v_res := pg_temp.json_as(v_admin, $s$SELECT public.rma_apply_chart_template('eg')$s$);
  PERFORM pg_temp.check('Egypt applied: the chart is exactly the template',
    v_res ->> 'country' = 'EG'
    AND (SELECT count(*) FROM public.gl_accounts) = 95
    AND NOT EXISTS (SELECT 1 FROM public.gl_accounts a WHERE NOT EXISTS
          (SELECT 1 FROM public.gl_chart_templates t WHERE t.country_code = 'EG' AND t.code = a.code
              AND t.name = a.name AND t.account_type = a.account_type AND t.is_postable = a.is_postable)),
    '-> ' || v_res::text || ' / ' || (SELECT count(*) FROM public.gl_accounts));
  PERFORM pg_temp.check('each account sits under the template''s parent',
    NOT EXISTS (SELECT 1 FROM public.gl_accounts a JOIN public.gl_chart_templates t ON t.country_code = 'EG' AND t.code = a.code
                 LEFT JOIN public.gl_accounts p ON p.id = a.parent_id
                WHERE p.code IS DISTINCT FROM t.parent_code));
  PERFORM pg_temp.check('the posting rules follow the template (receivables 1210, cash 1110, bank 1130, VAT out 2210, rounding 6990)',
    pg_temp.rule('accounts_receivable') = '1210' AND pg_temp.rule('cash') = '1110' AND pg_temp.rule('bank') = '1130'  -- 20260909
    AND pg_temp.rule('sales_tax_payable') = '2210' AND pg_temp.rule('rounding') = '6990'
    AND pg_temp.rule('fx_gain') = '4910' AND pg_temp.rule('fx_loss') = '6520'  -- 20260912
    AND (SELECT count(*) FROM public.posting_rules) = 19);  -- 20260909 adds bank, 20260912 the two exchange roles
  PERFORM pg_temp.check('the default chart''s 1200 (receivables) became the Receivables header; Egypt''s own accounts are there',
    (SELECT NOT is_postable AND name = 'Receivables' FROM public.gl_accounts WHERE code = '1200')
    AND EXISTS (SELECT 1 FROM public.gl_accounts WHERE code = '2230' AND name = 'Salary tax payable')
    AND (SELECT name FROM public.gl_accounts WHERE code = '3200') = 'Legal reserve');
  PERFORM pg_temp.check('the choice is remembered',
    (SELECT config_value #>> '{}' FROM public.rma_config WHERE config_key = 'chart_template') = 'EG');
  PERFORM pg_temp.check('a new account''s id comes from its code, as the default chart''s do',
    (SELECT id FROM public.gl_accounts WHERE code = '2230') = md5('gl_account:2230')::uuid);

  -- another country, still before anything is posted
  v_res := pg_temp.json_as(v_admin, $s$SELECT public.rma_apply_chart_template('SA')$s$);
  PERFORM pg_temp.check('then Saudi Arabia: Egypt-only accounts go, shared codes take the Saudi meaning',
    (SELECT count(*) FROM public.gl_accounts) = 95
    AND NOT EXISTS (SELECT 1 FROM public.gl_accounts WHERE code = '1420')
    AND (SELECT name FROM public.gl_accounts WHERE code = '2240') = 'Zakat payable'
    AND (SELECT name FROM public.gl_accounts WHERE code = '3200') = 'Statutory reserve',
    '-> ' || v_res::text);

  -- the engine posts to the new chart
  PERFORM public._gl_post('a02_test', gen_random_uuid(), 'posted', NULL, 'A02-1', NULL,
    '[{"role":"accounts_receivable","debit":10},{"role":"sales_revenue","credit":10}]'::jsonb);
  PERFORM pg_temp.check('postings land on the template''s accounts',
    EXISTS (SELECT 1 FROM public.journal_lines l JOIN public.gl_accounts a ON a.id = l.account_id
             JOIN public.journal_entries e ON e.id = l.entry_id WHERE e.source_code = 'A02-1' AND a.code = '1210'));
  v_out := pg_temp.call(v_admin, $s$SELECT public.rma_apply_chart_template('AE')$s$);
  PERFORM pg_temp.check('once anything is posted, the chart cannot be replaced', v_out LIKE 'err:P0001%before anything has been posted%', '-> ' || v_out);

  -- ══ 3. importing accounts ══════════════════════════════════════════════════
  v_res := pg_temp.json_as(v_admin, $s$SELECT public.rma_import_chart_accounts('[
    {"code":"6190","name":"Staff training","name_ar":"تدريب الموظفين","type":"expense","parent_code":"6000"},
    {"code":"6100","name":"Salaries, wages and allowances"},
    {"code":"1250","name":"Bad type","type":"money","parent_code":"1200"},
    {"code":"1260","name":"No parent","type":"asset","parent_code":"1999"},
    {"code":"1270","name":"Under a postable","type":"asset","parent_code":"1210"},
    {"code":"","name":"No code"},
    {"code":"8000","name":"Other items","type":"expense","header":"yes"},
    {"code":"8100","name":"Donations","type":"expense","parent_code":"8000"}
  ]'::jsonb)$s$);
  PERFORM pg_temp.check('import: new accounts created (a header, and one under it, in one file)',
    EXISTS (SELECT 1 FROM public.gl_accounts WHERE code = '6190' AND name_ar = 'تدريب الموظفين' AND is_postable)
    AND (SELECT NOT is_postable FROM public.gl_accounts WHERE code = '8000')
    AND (SELECT p.code FROM public.gl_accounts a JOIN public.gl_accounts p ON p.id = a.parent_id WHERE a.code = '8100') = '8000',
    '-> ' || v_res::text);
  PERFORM pg_temp.check('import: an existing account is renamed only',
    (SELECT name FROM public.gl_accounts WHERE code = '6100') = 'Salaries, wages and allowances'
    AND v_res @> '[{"code":"6100","status":"updated"}]');
  PERFORM pg_temp.check('import: bad rows are reported one by one, the rest still go in',
    (SELECT count(*) FROM jsonb_array_elements(v_res) e WHERE e ->> 'status' = 'error') = 4
    AND v_res @> '[{"code":"1250","status":"error"},{"code":"1260","status":"error"},{"code":"1270","status":"error"}]'
    AND NOT EXISTS (SELECT 1 FROM public.gl_accounts WHERE code IN ('1250', '1260', '1270')),
    '-> ' || v_res::text);
  v_out := pg_temp.call(v_mgr, $s$SELECT public.rma_import_chart_accounts('[{"code":"6191","name":"x","type":"expense"}]')$s$);
  PERFORM pg_temp.check('a manager cannot import', v_out LIKE 'err:42501%', '-> ' || v_out);

  PERFORM pg_temp.check('anon runs neither',
    NOT has_function_privilege('anon', 'public.rma_apply_chart_template(text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rma_import_chart_accounts(jsonb)', 'EXECUTE'));

  RAISE EXCEPTION 'A02_TEST_DONE %', current_setting('a02.log', true);
END $do$;
