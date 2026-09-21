-- ############################################################################
-- #  A FRESH TENANT CAN WORK ON DAY ONE — BL-04 (00000002_baseline_seed_data)
-- #
-- #  Provisioning mycrm-staging from the baseline produced a project whose
-- #  FIRST invoice could not be numbered (nextval_for_type raised 'Unknown
-- #  sequence type'), whose RMA stage auto-move had no locations to move units
-- #  to, and whose lead conversion had no pipeline. Those rows existed only
-- #  inside historical migrations, which a new tenant never runs.
-- #
-- #  Written FIRST (red) against staging before 00000002 was applied, and kept
-- #  as the regression test for every tenant provisioned from here on.
-- #
-- #  HOW TO RUN:
-- #  node scripts/run-sql-test.mjs supabase/tests/baseline_seed_data.sql BL04_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
-- ############################################################################

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail)
$f$;

-- Names from a list that have no row, as a readable string ('' when none).
CREATE FUNCTION pg_temp.missing(p_names text[], p_sql_template text)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; found boolean; out text := '';
BEGIN
  FOREACH n IN ARRAY p_names LOOP
    EXECUTE format(p_sql_template, n) INTO found;
    IF NOT found THEN out := out || CASE WHEN out = '' THEN '' ELSE ', ' END || n; END IF;
  END LOOP;
  RETURN out;
END $f$;

DO $do$
DECLARE
  v_miss text;
  v_code text;
  v_n    integer;
  v_cust uuid;
BEGIN

  -- ══ Document sequences ════════════════════════════════════════════════════
  v_miss := pg_temp.missing(
    ARRAY['invoice','credit_note','payment','vendor_invoice','vendor_payment','batch'],
    $q$SELECT EXISTS (SELECT 1 FROM public.document_sequences WHERE seq_type = %L)$q$);
  RAISE NOTICE '%', pg_temp.check('every document type has a sequence row', v_miss = '',
    CASE WHEN v_miss = '' THEN '' ELSE '-> missing: ' || v_miss END);

  -- The end-to-end proof: the row exists AND hands out a real code.
  v_code := public.nextval_for_type('invoice');
  RAISE NOTICE '%', pg_temp.check('the first invoice of a fresh tenant gets a number',
    v_code ~ ('^INV-' || EXTRACT(YEAR FROM now())::text || '-[0-9]{5}$'), '-> ' || v_code);

  -- 'batch' has no prefix mapping, so it falls through to UPPER(seq_type).
  -- Its missing row is what made a "sellable unit refused" check pass for the
  -- wrong reason while I-03 was being tested.
  v_code := public.nextval_for_type('batch');
  RAISE NOTICE '%', pg_temp.check('a manufacturer batch can be numbered',
    v_code ~ '^BATCH-[0-9]{4}-[0-9]{5}$', '-> ' || v_code);

  -- ══ System warehouses ═════════════════════════════════════════════════════
  v_miss := pg_temp.missing(
    ARRAY['RMA-RECEIVED','RMA-REPAIR','RMA-REPAIRED','RMA-CANTREPAIR',
          'RMA-STOCK','REPLACEMENT','CREDIT-NOTE','SCRAP'],
    $q$SELECT EXISTS (SELECT 1 FROM public.warehouses
                      WHERE code = %L AND is_system AND is_active)$q$);
  RAISE NOTICE '%', pg_temp.check('all eight system locations exist', v_miss = '',
    CASE WHEN v_miss = '' THEN '' ELSE '-> missing: ' || v_miss END);

  -- Their type decides the dashboard arithmetic. A system row typed main/branch
  -- (or left NULL, which reads as legacy-sellable) would count RMA intake as
  -- stock available to sell.
  SELECT count(*) INTO v_n FROM public.warehouses
   WHERE is_system AND (warehouse_type IS NULL OR warehouse_type IN ('main','branch'));
  RAISE NOTICE '%', pg_temp.check('no system location counts as sellable stock', v_n = 0,
    '-> ' || v_n || ' would');

  RAISE NOTICE '%', pg_temp.check('SCRAP is virtual, so write-offs are not stock',
    EXISTS (SELECT 1 FROM public.warehouses WHERE code = 'SCRAP' AND warehouse_type = 'virtual'));

  -- The rows are seeded as ordinary inserts, so prove the protection trigger
  -- actually covers them rather than assuming it.
  BEGIN
    UPDATE public.warehouses SET code = 'RMA-RENAMED' WHERE code = 'RMA-RECEIVED';
    RAISE NOTICE '%', pg_temp.check('a seeded system location cannot be re-coded', false,
      '-> the UPDATE succeeded');
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '%', pg_temp.check('a seeded system location cannot be re-coded', true,
      '-> ' || SQLSTATE);
  END;

  -- ══ Pipeline ══════════════════════════════════════════════════════════════
  SELECT count(*) INTO v_n FROM public.pipelines WHERE is_active;
  RAISE NOTICE '%', pg_temp.check('a lead has a pipeline to convert into', v_n > 0,
    '-> ' || v_n || ' active');

  -- validateStages() in src/api/db/pipelines.ts throws on anything but EXACTLY
  -- one won and one lost stage, so "at least one" would let a bad seed through
  -- and break the first time an admin saves Pipelines & Stages.
  SELECT count(*) INTO v_n FROM public.pipelines p, jsonb_array_elements(p.stages) s
   WHERE p.is_active AND (s->>'is_won')::boolean;
  RAISE NOTICE '%', pg_temp.check('the pipeline has exactly one won stage (deal value needs it)', v_n = 1, '-> ' || v_n);

  SELECT count(*) INTO v_n FROM public.pipelines p, jsonb_array_elements(p.stages) s
   WHERE p.is_active AND (s->>'is_lost')::boolean;
  RAISE NOTICE '%', pg_temp.check('the pipeline has exactly one lost stage', v_n = 1, '-> ' || v_n);

  -- Every stage needs an id and an order, or the Kanban cannot place a card.
  SELECT count(*) INTO v_n FROM public.pipelines p, jsonb_array_elements(p.stages) s
   WHERE p.is_active AND (s->>'id' IS NULL OR s->>'order' IS NULL);
  RAISE NOTICE '%', pg_temp.check('every seeded stage has an id and an order', v_n = 0,
    '-> ' || v_n || ' malformed');

  -- ══ E-mail templates ══════════════════════════════════════════════════════
  v_miss := pg_temp.missing(
    ARRAY['ticket_created','ticket_assigned','status_changed',
          'priority_changed','comment_added','ticket_overdue'],
    $q$SELECT EXISTS (SELECT 1 FROM public.email_templates
                      WHERE template_name = %L AND is_active)$q$);
  RAISE NOTICE '%', pg_temp.check('the six ticket e-mails have a template', v_miss = '',
    CASE WHEN v_miss = '' THEN '' ELSE '-> missing: ' || v_miss END);

  -- An undeclared {{placeholder}} reaches a customer's inbox as a raw token.
  SELECT coalesce(string_agg(DISTINCT e.template_name || ':' || m[1], ', '), '') INTO v_miss
    FROM public.email_templates e,
         LATERAL regexp_matches(e.template_body || ' ' || e.template_subject,
                                '\{\{([a-z_]+)\}\}', 'g') AS m
   WHERE NOT e.variables ? m[1];
  RAISE NOTICE '%', pg_temp.check('every e-mail placeholder is declared', v_miss = '',
    CASE WHEN v_miss = '' THEN '' ELSE '-> ' || v_miss END);

  SELECT coalesce(string_agg(template_name, ', '), '') INTO v_miss
    FROM public.email_templates
   WHERE template_body ~* '(bearer |authorization|api[_-]?key|EAA[A-Za-z0-9]{20,}|password)';
  RAISE NOTICE '%', pg_temp.check('no e-mail template body carries a credential', v_miss = '',
    CASE WHEN v_miss = '' THEN '' ELSE '-> ' || v_miss END);

  -- A seeded body must not carry one deployment's tracker URL.
  SELECT coalesce(string_agg(template_name, ', '), '') INTO v_miss
    FROM public.email_templates WHERE template_body ILIKE '%http%';
  RAISE NOTICE '%', pg_temp.check('no e-mail template hard-codes a URL', v_miss = '',
    CASE WHEN v_miss = '' THEN '' ELSE '-> ' || v_miss END);

  -- ══ WhatsApp templates ════════════════════════════════════════════════════
  v_miss := pg_temp.missing(
    ARRAY['ticket_created','ticket_updated','ticket_assigned','ticket_closed','payment_received'],
    $q$SELECT EXISTS (SELECT 1 FROM public.whatsapp_templates WHERE name = %L)$q$);
  RAISE NOTICE '%', pg_temp.check('the WhatsApp templates exist', v_miss = '',
    CASE WHEN v_miss = '' THEN '' ELSE '-> missing: ' || v_miss END);

  -- THE ONE THAT MATTERS. Production's ticket_created body holds a pasted curl
  -- command with a live Meta bearer token; copying bodies verbatim from it
  -- would have shipped that credential into every tenant's database.
  SELECT coalesce(string_agg(name, ', '), '') INTO v_miss
    FROM public.whatsapp_templates
   WHERE coalesce(body_content, '') || ' ' || coalesce(header_content, '') || ' ' || coalesce(footer_content, '')
         ~* '(bearer |authorization|access_token|EAA[A-Za-z0-9]{20,}|curl )';
  RAISE NOTICE '%', pg_temp.check('no WhatsApp template body carries a credential', v_miss = '',
    CASE WHEN v_miss = '' THEN '' ELSE '-> ' || v_miss END);

  RAISE NOTICE '%', pg_temp.check('no tenant Meta ids were seeded',
    NOT EXISTS (SELECT 1 FROM public.notification_settings WHERE setting_key = 'whatsapp_config'));

  -- Placeholders must be declared: the positional {{n}} params are built from
  -- `variables`, and an object round-tripped through JSONB loses key order.
  SELECT coalesce(string_agg(DISTINCT w.name || ':' || m[1], ', '), '') INTO v_miss
    FROM public.whatsapp_templates w,
         LATERAL regexp_matches(w.body_content, '\{\{[#/]?([a-z_]+)\}\}', 'g') AS m
   WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(w.variables) v WHERE v->>'key' = m[1]);
  RAISE NOTICE '%', pg_temp.check('every WhatsApp placeholder is declared', v_miss = '',
    CASE WHEN v_miss = '' THEN '' ELSE '-> ' || v_miss END);

  -- ══ Tenant identity ═══════════════════════════════════════════════════════
  -- 00000001 was first exported from QDS Egypt; these two rows printed its
  -- name and address on every other tenant's PDFs.
  SELECT coalesce(string_agg(config_key, ', '), '') INTO v_miss
    FROM public.rma_config
   WHERE config_key IN ('pdf_layout', 'sales_doc_layout')
     AND (config_value->>'companyName' <> '' OR config_value->>'companyPhone' <> ''
          OR config_value->>'companyAddress' <> '');
  RAISE NOTICE '%', pg_temp.check('PDF layouts carry no company name, phone or address', v_miss = '',
    CASE WHEN v_miss = '' THEN '' ELSE '-> ' || v_miss END);

  -- ══ Notification settings ═════════════════════════════════════════════════
  v_miss := pg_temp.missing(
    ARRAY['whatsapp_enabled','email_enabled','sms_enabled',
          'notification_events','retry_config','rate_limit'],
    $q$SELECT EXISTS (SELECT 1 FROM public.notification_settings WHERE setting_key = %L)$q$);
  RAISE NOTICE '%', pg_temp.check('the notification switches exist', v_miss = '',
    CASE WHEN v_miss = '' THEN '' ELSE '-> missing: ' || v_miss END);

  -- Sending starts off: a new tenant has no Meta account and no sender, so a
  -- seeded 'true' would have it messaging customers on day one.
  SELECT coalesce(string_agg(setting_key, ', '), '') INTO v_miss
    FROM public.notification_settings
   WHERE setting_key IN ('whatsapp_enabled','email_enabled','sms_enabled')
     AND setting_value::text = 'true';
  RAISE NOTICE '%', pg_temp.check('no messaging channel is on by default', v_miss = '',
    CASE WHEN v_miss = '' THEN '' ELSE '-> on: ' || v_miss END);

  -- ══ The seed is configuration, not data ═══════════════════════════════════
  -- Re-running it must change nothing. Run the file's own guarded inserts
  -- again and prove the counts hold.
  SELECT count(*) INTO v_n FROM public.document_sequences;
  INSERT INTO public.document_sequences (seq_type, seq_year, last_value)
  SELECT v.t, EXTRACT(YEAR FROM now())::integer, 0
    FROM (VALUES ('invoice'),('credit_note'),('payment'),
                 ('vendor_invoice'),('vendor_payment'),('batch')) AS v(t)
   WHERE NOT EXISTS (SELECT 1 FROM public.document_sequences d WHERE d.seq_type = v.t);
  RAISE NOTICE '%', pg_temp.check('re-seeding adds no duplicate sequence rows',
    (SELECT count(*) FROM public.document_sequences) = v_n, '-> ' || v_n);

  SELECT count(*) INTO v_n FROM public.warehouses WHERE is_system;
  INSERT INTO public.warehouses (code, name, description, warehouse_type, is_system, is_active)
  SELECT v.c, v.c, '', 'rma', true, true
    FROM (VALUES ('RMA-RECEIVED'),('SCRAP')) AS v(c)
   WHERE NOT EXISTS (SELECT 1 FROM public.warehouses w WHERE w.code = v.c AND w.is_system);
  RAISE NOTICE '%', pg_temp.check('re-seeding adds no duplicate system locations',
    (SELECT count(*) FROM public.warehouses WHERE is_system) = v_n, '-> ' || v_n);

  -- A tenant's own edit must survive the guard, not be reset by it.
  UPDATE public.email_templates SET template_subject = 'Tenant edited this'
   WHERE template_name = 'ticket_created';
  INSERT INTO public.email_templates (template_name, template_subject, template_body, variables, is_active)
  SELECT 'ticket_created', 'Seed default', 'body', '[]'::jsonb, true
   WHERE NOT EXISTS (SELECT 1 FROM public.email_templates WHERE template_name = 'ticket_created');
  RAISE NOTICE '%', pg_temp.check('re-seeding does not overwrite a tenant''s edit',
    (SELECT template_subject FROM public.email_templates
      WHERE template_name = 'ticket_created' LIMIT 1) = 'Tenant edited this');

  -- ══ End to end ════════════════════════════════════════════════════════════
  -- The reported symptom, reproduced: create a customer and number an invoice.
  INSERT INTO public.customers (company_name, customer_code, customer_type, email)
  VALUES ('Seed Test Co', 'SEED-TEST-001', 'B2B', 'seed-test@example.invalid')
  RETURNING id INTO v_cust;
  INSERT INTO public.crm_invoices (customer_id, doc_status, subtotal, total, created_by)
  VALUES (v_cust, 'draft', 100, 100, 'seed-test@example.invalid');
  v_code := public.nextval_for_type('invoice');
  RAISE NOTICE '%', pg_temp.check('a brand-new tenant can raise and number an invoice',
    v_code IS NOT NULL, '-> ' || v_code);

  RAISE EXCEPTION 'BL04_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
