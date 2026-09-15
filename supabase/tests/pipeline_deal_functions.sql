-- ############################################################################
-- #  DB TEST TIER — Pipeline reads (BUG-066, phase 5c)
-- #
-- #  20260858 moves the Pipeline's search, sort keys, totals, graph/pivot
-- #  buckets and activity summaries into the database. Pinned here, on a
-- #  fixture pipeline of its own:
-- #
-- #    - v_deals_list: one row per deal; the customer name is the company, or
-- #      the contact person; stage_order is the stage's place in its pipeline;
-- #      a deal with no value sorts as 0;
-- #    - rma_deals_matching: an empty term is the whole pipeline; the term
-- #      matches title, code, rep or customer name, literally (% and _);
-- #    - rma_deal_buckets: counts and values add up to the pipeline; months are
-- #      in the time zone given, and an unknown zone falls back to UTC;
-- #    - rma_deal_activity_values: a deal's state is its worst dated open
-- #      activity; completed and undated activities do not count;
-- #    - rma_deal_activity_type_counts: open deals only, with done counts;
-- #    - rma_deal_reps; and none of it is callable by anon.
-- #
-- #  NOT in CI: the db-tests job is disabled (needs Docker). Run against the
-- #  hosted project with the cleanup replaced by an unconditional RAISE.
-- ############################################################################

DO $$
DECLARE
  v_tag text := floor(random() * 1000000)::text;
  v_pipe uuid;
  c_company uuid; c_person uuid;
  d_open uuid; d_won uuid; d_novalue uuid; d_late uuid;
  v_failures text[] := '{}';
  v_checks int := 0;
  v_now timestamptz := now();
  v_today_end timestamptz := date_trunc('day', now()) + interval '1 day' - interval '1 microsecond';
  v_json jsonb;
BEGIN
  INSERT INTO public.pipelines (name, stages)
  VALUES ('CI pipeline ' || v_tag, '[
    {"id":"s_new","name":"New","order":1,"is_won":false,"is_lost":false},
    {"id":"s_quote","name":"Quote","order":2,"is_won":false,"is_lost":false},
    {"id":"s_won","name":"Won","order":3,"is_won":true,"is_lost":false},
    {"id":"s_lost","name":"Lost","order":4,"is_won":false,"is_lost":true}
  ]'::jsonb)
  RETURNING id INTO v_pipe;

  INSERT INTO public.customers (customer_code, customer_type, company_name)
    VALUES ('CI-PC-' || v_tag, 'B2B', 'Zephyr 50% Traders') RETURNING id INTO c_company;
  INSERT INTO public.customers (customer_code, customer_type, company_name, contact_person)
    VALUES ('CI-PP-' || v_tag, 'B2C', '', 'Mona Person') RETURNING id INTO c_person;

  INSERT INTO public.deals (title, customer_id, pipeline_id, stage, value, assigned_rep, created_at, expected_close_date)
    VALUES ('CI open deal', c_company, v_pipe, 's_quote', 1000, 'rep.a@ci.test', '2026-08-31 23:30:00+00', '2026-10-15')
    RETURNING id INTO d_open;
  INSERT INTO public.deals (title, customer_id, pipeline_id, stage, value, assigned_rep, created_at)
    VALUES ('CI won deal', c_person, v_pipe, 's_won', 400, 'rep.b@ci.test', '2026-09-10 10:00:00+00')
    RETURNING id INTO d_won;
  INSERT INTO public.deals (title, customer_id, pipeline_id, stage, value, assigned_rep, created_at)
    VALUES ('ci under_score', c_company, v_pipe, 's_new', NULL, 'rep.a@ci.test', '2026-09-11 10:00:00+00')
    RETURNING id INTO d_novalue;
  INSERT INTO public.deals (title, customer_id, pipeline_id, stage, value, assigned_rep, created_at)
    VALUES ('CI late deal', c_company, v_pipe, 's_new', 250, NULL, '2026-09-12 10:00:00+00')
    RETURNING id INTO d_late;

  -- d_open: overdue (one past due, one in the future) · d_late: planned only
  -- d_novalue: an overdue activity that is completed, and an undated one → no state
  INSERT INTO public.activities (related_type, related_id, type, title, due_date, completed_at) VALUES
    ('deal', d_open,    'call',    'CI past',      v_now - interval '2 days', NULL),
    ('deal', d_open,    'meeting', 'CI future',    v_now + interval '5 days', NULL),
    ('deal', d_open,    'call',    'CI done',      v_now - interval '9 days', v_now - interval '8 days'),
    ('deal', d_late,    'task',    'CI planned',   v_now + interval '3 days', NULL),
    ('deal', d_novalue, 'call',    'CI completed', v_now - interval '2 days', v_now),
    ('deal', d_novalue, 'email',   'CI undated',   NULL, NULL),
    ('deal', d_won,     'call',    'CI on won',    v_now - interval '1 day', NULL);

  -- ── CHECK 1: v_deals_list columns ───────────────────────────────────────────
  v_checks := v_checks + 1;
  IF (SELECT count(*) FROM public.v_deals_list WHERE pipeline_id = v_pipe) <> 4 THEN
    v_failures := array_append(v_failures, 'CHECK 1a: v_deals_list does not have one row per deal');
  END IF;
  IF (SELECT customer_name FROM public.v_deals_list WHERE id = d_won) IS DISTINCT FROM 'Mona Person' THEN
    v_failures := array_append(v_failures, 'CHECK 1b: an empty company name does not fall back to the contact person');
  END IF;
  IF (SELECT array_agg(stage_order ORDER BY created_at) FROM public.v_deals_list WHERE pipeline_id = v_pipe)
     IS DISTINCT FROM ARRAY[2, 3, 1, 1]::numeric[] THEN
    v_failures := array_append(v_failures, 'CHECK 1c: stage_order is not the stage''s place in the pipeline');
  END IF;
  IF (SELECT value_sort FROM public.v_deals_list WHERE id = d_novalue) IS DISTINCT FROM 0::numeric THEN
    v_failures := array_append(v_failures, 'CHECK 1d: a deal with no value does not sort as 0');
  END IF;

  -- ── CHECK 2: the search ─────────────────────────────────────────────────────
  v_checks := v_checks + 1;
  IF (SELECT count(*) FROM public.rma_deals_matching(v_pipe, '  ')) <> 4 THEN
    v_failures := array_append(v_failures, 'CHECK 2a: a blank term is not the whole pipeline');
  END IF;
  IF (SELECT array_agg(id ORDER BY id) FROM public.rma_deals_matching(v_pipe, 'mona')) IS DISTINCT FROM ARRAY[d_won] THEN
    v_failures := array_append(v_failures, 'CHECK 2b: the customer name (contact person) is not searched');
  END IF;
  IF (SELECT count(*) FROM public.rma_deals_matching(v_pipe, 'REP.B@')) <> 1 THEN
    v_failures := array_append(v_failures, 'CHECK 2c: the rep is not searched case-insensitively');
  END IF;
  -- As a wildcard, _ would match the space in "CI open deal".
  IF (SELECT array_agg(id) FROM public.rma_deals_matching(v_pipe, 'CI_open')) IS NOT NULL THEN
    v_failures := array_append(v_failures, 'CHECK 2d: _ in the term is a wildcard');
  END IF;
  IF (SELECT count(*) FROM public.rma_deals_matching(v_pipe, '50%')) <> 3
     OR (SELECT count(*) FROM public.rma_deals_matching(v_pipe, '5%T')) <> 0 THEN
    v_failures := array_append(v_failures, 'CHECK 2e: % in the term is not taken literally');
  END IF;
  IF (SELECT count(*) FROM public.rma_deals_matching(v_pipe, 'under_score')) <> 1 THEN
    v_failures := array_append(v_failures, 'CHECK 2f: a literal _ does not match itself');
  END IF;

  -- ── CHECK 3: buckets ────────────────────────────────────────────────────────
  v_checks := v_checks + 1;
  IF (SELECT sum(deal_count) FROM public.rma_deal_buckets(v_pipe, '', 'UTC')) <> 4
     OR (SELECT sum(value_sum) FROM public.rma_deal_buckets(v_pipe, '', 'UTC')) <> 1650 THEN
    v_failures := array_append(v_failures, 'CHECK 3a: buckets do not add up to the pipeline');
  END IF;
  IF (SELECT created_month FROM public.rma_deal_buckets(v_pipe, 'CI open', 'UTC')) IS DISTINCT FROM '2026-08'
     OR (SELECT created_month FROM public.rma_deal_buckets(v_pipe, 'CI open', 'Africa/Cairo')) IS DISTINCT FROM '2026-09' THEN
    v_failures := array_append(v_failures, 'CHECK 3b: created month does not follow the time zone given');
  END IF;
  IF (SELECT created_month FROM public.rma_deal_buckets(v_pipe, 'CI open', 'Not/AZone')) IS DISTINCT FROM '2026-08' THEN
    v_failures := array_append(v_failures, 'CHECK 3c: an unknown time zone does not fall back to UTC');
  END IF;
  IF (SELECT close_month FROM public.rma_deal_buckets(v_pipe, 'CI open', 'UTC')) IS DISTINCT FROM '2026-10' THEN
    v_failures := array_append(v_failures, 'CHECK 3d: close month is not expected_close_date''s month');
  END IF;
  IF (SELECT sum(deal_count) FROM public.rma_deal_buckets(v_pipe, '', 'UTC') WHERE status = 'won') <> 1 THEN
    v_failures := array_append(v_failures, 'CHECK 3e: the won deal is not bucketed as won');
  END IF;

  -- ── CHECK 4: activity state values ──────────────────────────────────────────
  v_checks := v_checks + 1;
  SELECT jsonb_object_agg(stage || '/' || activity_state, value_sum)
    INTO v_json
    FROM public.rma_deal_activity_values(v_pipe, '', v_now, v_today_end);
  IF v_json IS DISTINCT FROM '{"s_quote/overdue": 1000, "s_new/planned": 250, "s_won/overdue": 400}'::jsonb THEN
    v_failures := array_append(v_failures, format('CHECK 4: activity values %s, expected quote overdue 1000, new planned 250, won overdue 400', v_json));
  END IF;

  -- ── CHECK 5: activity type counts (open deals only) ─────────────────────────
  v_checks := v_checks + 1;
  SELECT jsonb_object_agg(activity_type, jsonb_build_array(activity_count, done_count))
    INTO v_json
    FROM (
      SELECT activity_type, sum(activity_count) AS activity_count, sum(done_count) AS done_count
        FROM public.rma_deal_activity_type_counts(v_pipe, '')
       GROUP BY activity_type
    ) x;
  IF v_json IS DISTINCT FROM '{"call": [3, 2], "meeting": [1, 0], "task": [1, 0], "email": [1, 0]}'::jsonb THEN
    v_failures := array_append(v_failures, format('CHECK 5: type counts %s', v_json));
  END IF;

  -- ── CHECK 6: reps ───────────────────────────────────────────────────────────
  v_checks := v_checks + 1;
  IF public.rma_deal_reps(v_pipe) IS DISTINCT FROM ARRAY['rep.a@ci.test', 'rep.b@ci.test'] THEN
    v_failures := array_append(v_failures, 'CHECK 6: rma_deal_reps is not the distinct, sorted, non-null reps');
  END IF;

  -- ── CHECK 7: access ─────────────────────────────────────────────────────────
  v_checks := v_checks + 1;
  IF has_table_privilege('anon', 'public.v_deals_list', 'SELECT')
     OR has_function_privilege('anon', 'public.rma_deals_matching(uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_deal_buckets(uuid, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_deal_activity_values(uuid, text, timestamptz, timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_deal_activity_type_counts(uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_deal_reps(uuid)', 'EXECUTE') THEN
    v_failures := array_append(v_failures, 'CHECK 7: anon can read the Pipeline view or call its functions');
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.rma_deal_buckets(uuid, text, text)', 'EXECUTE') THEN
    v_failures := array_append(v_failures, 'CHECK 7b: authenticated cannot call rma_deal_buckets');
  END IF;

  DELETE FROM public.activities WHERE related_type = 'deal' AND related_id IN (d_open, d_won, d_novalue, d_late);
  DELETE FROM public.deals WHERE pipeline_id = v_pipe;
  DELETE FROM public.customers WHERE id IN (c_company, c_person);
  DELETE FROM public.pipelines WHERE id = v_pipe;

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % pipeline check(s) FAILED:\n%',
      array_length(v_failures, 1), v_checks, array_to_string(v_failures, E'\n');
  END IF;
  RAISE NOTICE 'All % pipeline checks passed', v_checks;
END $$;
