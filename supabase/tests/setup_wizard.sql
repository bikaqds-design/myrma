-- supabase/tests/setup_wizard.sql — B-03c (20260922), rolled back.
-- A database with business data is marked finished; an empty one gets no row
-- (its first administrator is sent to the wizard); an existing row is kept.
-- #  node scripts/run-sql-test.mjs supabase/tests/setup_wizard.sql B03C_TEST_DONE

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT CASE WHEN p_ok THEN 'PASS  ' || p_label ELSE 'FAIL  ' || p_label || ' ' || COALESCE(p_detail, '') END
$f$;

DO $do$
DECLARE
  v_sql text := $m$
INSERT INTO public.rma_config (config_key, config_value, updated_by, updated_date)
SELECT 'setup_wizard',
       jsonb_build_object('status', 'finished', 'reason', 'existing data', 'finished_at', now()),
       'system@migration', now()
 WHERE NOT EXISTS (SELECT 1 FROM public.rma_config WHERE config_key = 'setup_wizard')
   AND (EXISTS (SELECT 1 FROM public.customers)
        OR EXISTS (SELECT 1 FROM public.rma_tickets)
        OR EXISTS (SELECT 1 FROM public.crm_invoices)
        OR EXISTS (SELECT 1 FROM public.rma_config
                    WHERE config_key = 'legal_name' AND btrim(config_value #>> '{}') <> ''));
$m$;
  v jsonb;
  res text[] := '{}';
BEGIN
  -- staging holds business data: finished
  DELETE FROM public.rma_config WHERE config_key = 'setup_wizard';
  EXECUTE v_sql;
  SELECT config_value INTO v FROM public.rma_config WHERE config_key = 'setup_wizard';
  res := res || pg_temp.check('a database with business data is marked finished', v->>'status' = 'finished', COALESCE(v::text, 'no row'));

  -- an existing row is left alone
  UPDATE public.rma_config SET config_value = '{"status":"skipped"}' WHERE config_key = 'setup_wizard';
  EXECUTE v_sql;
  SELECT config_value INTO v FROM public.rma_config WHERE config_key = 'setup_wizard';
  res := res || pg_temp.check('an existing row is kept', v->>'status' = 'skipped', v::text);

  -- an empty database gets no row (simulated: no customers, tickets, invoices or name)
  DELETE FROM public.rma_config WHERE config_key IN ('setup_wizard', 'legal_name');
  SET LOCAL session_replication_role = replica;   -- skip FK/audit triggers for the wipe, rolled back
  DELETE FROM public.crm_invoices; DELETE FROM public.rma_tickets; DELETE FROM public.customers;
  SET LOCAL session_replication_role = origin;
  EXECUTE v_sql;
  res := res || pg_temp.check('an empty database gets no row, so the wizard opens',
    NOT EXISTS (SELECT 1 FROM public.rma_config WHERE config_key = 'setup_wizard'));

  RAISE EXCEPTION 'B03C_TEST_DONE %', E'\n' || array_to_string(res, E'\n');
END
$do$;
