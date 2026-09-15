-- ############################################################################
-- #  DB TEST TIER — Activities page and Tech Calendar reads (BUG-066, phase 5c)
-- #
-- #  20260859's v_activities_list names each activity the way the Activities
-- #  page did in the browser, and two functions list the people its filter and
-- #  the Tech Calendar offer. Pinned here, on fixtures of its own:
-- #
-- #    - one row per activity;
-- #    - an approval: source = document type (quotation when missing), customer
-- #      and code from its title;
-- #    - a lead activity: the company, else the lead's name; its lead code;
-- #    - a deal activity: the deal's customer (company, else contact person);
-- #      its deal code; a customer activity: that customer;
-- #    - related_exists only when the lead / deal is there;
-- #    - rma_activity_assignees: planned vs completed, logs excluded, owner scope;
-- #    - rma_calendar_assignees: technicians and planned reps together;
-- #    - nothing callable by anon.
-- #
-- #  NOT in CI: the db-tests job is disabled (needs Docker). Run against the
-- #  hosted project with the cleanup replaced by an unconditional RAISE.
-- ############################################################################

DO $$
DECLARE
  v_tag text := floor(random() * 1000000)::text;
  v_pipe uuid; c_company uuid; c_person uuid; v_lead uuid; v_lead_noco uuid; v_deal uuid; v_ticket uuid;
  a_approval uuid; a_approval_bare uuid; a_lead uuid; a_lead_noco uuid; a_deal uuid; a_customer uuid; a_orphan uuid; a_done uuid; a_log uuid;
  r record;
  v_failures text[] := '{}';
  v_checks int := 0;
BEGIN
  INSERT INTO public.pipelines (name, stages)
    VALUES ('CI act pipeline ' || v_tag, '[{"id":"s1","name":"S1","order":1,"is_won":false,"is_lost":false}]'::jsonb)
    RETURNING id INTO v_pipe;
  INSERT INTO public.customers (customer_code, customer_type, company_name)
    VALUES ('CI-AC-' || v_tag, 'B2B', 'CI Acme ' || v_tag) RETURNING id INTO c_company;
  INSERT INTO public.customers (customer_code, customer_type, company_name, contact_person)
    VALUES ('CI-AP-' || v_tag, 'B2C', '', 'CI Person ' || v_tag) RETURNING id INTO c_person;
  INSERT INTO public.leads (full_name, company_name, source, lead_code)
    VALUES ('CI Lead Name', 'CI Lead Co ' || v_tag, 'phone', 'LD-CI' || v_tag) RETURNING id INTO v_lead;
  INSERT INTO public.leads (full_name, company_name, source)
    VALUES ('CI Only Name ' || v_tag, '', 'phone') RETURNING id INTO v_lead_noco;
  INSERT INTO public.deals (title, customer_id, pipeline_id, stage, deal_code)
    VALUES ('CI act deal', c_person, v_pipe, 's1', 'OPP-CI' || v_tag) RETURNING id INTO v_deal;
  INSERT INTO public.rma_tickets (rma_number, assigned_technician, priority)
    VALUES ('CI-RMA-' || v_tag, 'tech.' || v_tag || '@ci.test', 'Low') RETURNING id INTO v_ticket;

  INSERT INTO public.activities (related_type, related_id, type, title, due_date, assigned_rep)
    VALUES ('deal', v_deal, 'approval', 'approval|sales_order|' || gen_random_uuid() || '|SO-' || v_tag || '|990|CI Title Customer', now() + interval '1 day', 'rep.a.' || v_tag || '@ci.test')
    RETURNING id INTO a_approval;
  INSERT INTO public.activities (related_type, related_id, type, title, due_date, assigned_rep)
    VALUES ('customer', c_company, 'approval', 'approval', now() + interval '1 day', NULL)
    RETURNING id INTO a_approval_bare;
  INSERT INTO public.activities (related_type, related_id, type, title, due_date, assigned_rep)
    VALUES ('lead', v_lead, 'call', 'CI Call', now() + interval '2 days', 'rep.b.' || v_tag || '@ci.test') RETURNING id INTO a_lead;
  INSERT INTO public.activities (related_type, related_id, type, title, due_date)
    VALUES ('lead', v_lead_noco, 'call', 'CI Call 2', now() + interval '2 days') RETURNING id INTO a_lead_noco;
  INSERT INTO public.activities (related_type, related_id, type, title, due_date)
    VALUES ('deal', v_deal, 'meeting', 'CI Meet', now() - interval '2 days') RETURNING id INTO a_deal;
  INSERT INTO public.activities (related_type, related_id, type, title, due_date)
    VALUES ('customer', c_company, 'task', 'CI Task', now()) RETURNING id INTO a_customer;
  INSERT INTO public.activities (related_type, related_id, type, title, due_date, assigned_rep, completed_at)
    VALUES ('deal', v_deal, 'call', 'CI Done', now() - interval '5 days', 'rep.c.' || v_tag || '@ci.test', now()) RETURNING id INTO a_done;
  INSERT INTO public.activities (related_type, related_id, type, title, assigned_rep)
    VALUES ('deal', v_deal, 'log', 'stage_changed|a|b', 'rep.log.' || v_tag || '@ci.test') RETURNING id INTO a_log;

  -- ── CHECK 1: one row per activity ───────────────────────────────────────────
  v_checks := v_checks + 1;
  IF (SELECT count(*) FROM public.v_activities_list) <> (SELECT count(*) FROM public.activities) THEN
    v_failures := array_append(v_failures, 'CHECK 1: v_activities_list does not have one row per activity');
  END IF;

  -- ── CHECK 2: approvals are named from their title ───────────────────────────
  v_checks := v_checks + 1;
  SELECT source, customer_name, source_code INTO r FROM public.v_activities_list WHERE id = a_approval;
  IF r.source IS DISTINCT FROM 'sales_order' OR r.customer_name IS DISTINCT FROM 'CI Title Customer' OR r.source_code IS DISTINCT FROM 'SO-' || v_tag THEN
    v_failures := array_append(v_failures, format('CHECK 2a: approval named %s / %s / %s', r.source, r.customer_name, r.source_code));
  END IF;
  SELECT source, customer_name, source_code INTO r FROM public.v_activities_list WHERE id = a_approval_bare;
  IF r.source IS DISTINCT FROM 'quotation' OR r.customer_name IS DISTINCT FROM '—' OR r.source_code IS DISTINCT FROM '—' THEN
    v_failures := array_append(v_failures, format('CHECK 2b: a bare approval title gave %s / %s / %s', r.source, r.customer_name, r.source_code));
  END IF;

  -- ── CHECK 3: lead activities ────────────────────────────────────────────────
  v_checks := v_checks + 1;
  SELECT source, customer_name, source_code, related_exists INTO r FROM public.v_activities_list WHERE id = a_lead;
  IF r.source IS DISTINCT FROM 'lead' OR r.customer_name IS DISTINCT FROM 'CI Lead Co ' || v_tag OR r.source_code IS DISTINCT FROM 'LD-CI' || v_tag OR NOT r.related_exists THEN
    v_failures := array_append(v_failures, format('CHECK 3a: lead activity %s', row_to_json(r)));
  END IF;
  IF (SELECT customer_name FROM public.v_activities_list WHERE id = a_lead_noco) IS DISTINCT FROM 'CI Only Name ' || v_tag THEN
    v_failures := array_append(v_failures, 'CHECK 3b: a lead with no company is not named by its full name');
  END IF;

  -- ── CHECK 4: deal and customer activities ───────────────────────────────────
  v_checks := v_checks + 1;
  SELECT source, customer_name, source_code, related_exists INTO r FROM public.v_activities_list WHERE id = a_deal;
  IF r.source IS DISTINCT FROM 'deal' OR r.customer_name IS DISTINCT FROM 'CI Person ' || v_tag OR r.source_code IS DISTINCT FROM 'OPP-CI' || v_tag OR NOT r.related_exists THEN
    v_failures := array_append(v_failures, format('CHECK 4a: deal activity %s', row_to_json(r)));
  END IF;
  SELECT source, customer_name, source_code, related_exists INTO r FROM public.v_activities_list WHERE id = a_customer;
  IF r.source IS DISTINCT FROM 'customer' OR r.customer_name IS DISTINCT FROM 'CI Acme ' || v_tag OR r.source_code IS NOT NULL OR r.related_exists THEN
    v_failures := array_append(v_failures, format('CHECK 4b: customer activity %s', row_to_json(r)));
  END IF;
  IF (SELECT customer_sort FROM public.v_activities_list WHERE id = a_customer) IS DISTINCT FROM lower('CI Acme ' || v_tag)
     OR (SELECT title_sort FROM public.v_activities_list WHERE id = a_customer) IS DISTINCT FROM 'ci task' THEN
    v_failures := array_append(v_failures, 'CHECK 4c: sort keys are not lower-cased');
  END IF;

  -- ── CHECK 5: a missing lead/deal does not link ──────────────────────────────
  v_checks := v_checks + 1;
  INSERT INTO public.activities (related_type, related_id, type, title, due_date)
    VALUES ('lead', v_lead, 'note', 'CI orphan', now()) RETURNING id INTO a_orphan;
  DELETE FROM public.activities WHERE id IN (a_lead, a_approval_bare);
  UPDATE public.activities SET related_id = gen_random_uuid() WHERE id = a_orphan;
  SELECT related_exists, customer_name, source_code INTO r FROM public.v_activities_list WHERE id = a_orphan;
  IF r.related_exists OR r.customer_name IS NOT NULL OR r.source_code IS NOT NULL THEN
    v_failures := array_append(v_failures, format('CHECK 5: an activity on a missing lead %s', row_to_json(r)));
  END IF;

  -- ── CHECK 6: assignees for the Activities filter ────────────────────────────
  v_checks := v_checks + 1;
  IF NOT ('rep.a.' || v_tag || '@ci.test' = ANY (public.rma_activity_assignees(false)))
     OR 'rep.c.' || v_tag || '@ci.test' = ANY (public.rma_activity_assignees(false))
     OR 'rep.log.' || v_tag || '@ci.test' = ANY (public.rma_activity_assignees(false)) THEN
    v_failures := array_append(v_failures, 'CHECK 6a: planned assignees wrong (missing a planned rep, or a completed/log rep included)');
  END IF;
  IF NOT ('rep.c.' || v_tag || '@ci.test' = ANY (public.rma_activity_assignees(true)))
     OR 'rep.a.' || v_tag || '@ci.test' = ANY (public.rma_activity_assignees(true)) THEN
    v_failures := array_append(v_failures, 'CHECK 6b: completed assignees wrong');
  END IF;
  IF public.rma_activity_assignees(false, 'rep.a.' || v_tag || '@ci.test') IS DISTINCT FROM ARRAY['rep.a.' || v_tag || '@ci.test'] THEN
    v_failures := array_append(v_failures, 'CHECK 6c: the owner scope does not narrow to that rep');
  END IF;

  -- ── CHECK 7: people on the Tech Calendar ────────────────────────────────────
  v_checks := v_checks + 1;
  IF NOT ('tech.' || v_tag || '@ci.test' = ANY (public.rma_calendar_assignees()))
     OR NOT ('rep.a.' || v_tag || '@ci.test' = ANY (public.rma_calendar_assignees()))
     OR 'rep.c.' || v_tag || '@ci.test' = ANY (public.rma_calendar_assignees()) THEN
    v_failures := array_append(v_failures, 'CHECK 7: calendar people are not technicians + planned reps');
  END IF;

  -- ── CHECK 8: access ─────────────────────────────────────────────────────────
  v_checks := v_checks + 1;
  IF has_table_privilege('anon', 'public.v_activities_list', 'SELECT')
     OR has_function_privilege('anon', 'public.rma_activity_assignees(boolean, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_calendar_assignees()', 'EXECUTE')
     OR NOT has_table_privilege('authenticated', 'public.v_activities_list', 'SELECT') THEN
    v_failures := array_append(v_failures, 'CHECK 8: grants on the Activities view/functions are wrong');
  END IF;

  DELETE FROM public.activities WHERE id IN (a_approval, a_lead_noco, a_deal, a_customer, a_orphan, a_done, a_log);
  DELETE FROM public.rma_tickets WHERE id = v_ticket;
  DELETE FROM public.deals WHERE id = v_deal;
  DELETE FROM public.leads WHERE id IN (v_lead, v_lead_noco);
  DELETE FROM public.customers WHERE id IN (c_company, c_person);
  DELETE FROM public.pipelines WHERE id = v_pipe;

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % activities check(s) FAILED:\n%',
      array_length(v_failures, 1), v_checks, array_to_string(v_failures, E'\n');
  END IF;
  RAISE NOTICE 'All % activities checks passed', v_checks;
END $$;
