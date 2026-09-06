-- Verifies 20260818_publish_realtime_tables.sql.
--
-- Two things have to hold, and they pull in opposite directions:
--   1. The seven subscribed tables are in the publication (so events flow).
--   2. Publishing them leaked nothing (so RLS still scopes who sees what).
--
-- Check 2 reproduces the context Realtime evaluates policies in — role
-- 'authenticated' plus request.jwt.claims — rather than trusting that it does.
--
-- Everything runs inside a transaction that is aborted by the closing RAISE, so
-- nothing here can change production. Read the VERDICT in the error message.

DO $verify$
DECLARE
  v_out      text := E'\n';
  v_expected constant text[] := ARRAY[
    'activities', 'customers', 'inventory_units', 'leads',
    'notifications', 'products', 'rma_tickets'
  ];
  v_actual   text[];
  v_absent   text[];
  v_extra    text[];
  v_bad_ri   text[];
  v_viewer   text;
  v_rep      text;
  v_n        integer;
  v_pass     integer := 0;
  v_fail     integer := 0;
BEGIN
  ---------------------------------------------------------------------------
  -- 1. Publication membership is exactly the seven tables
  ---------------------------------------------------------------------------
  SELECT coalesce(array_agg(tablename ORDER BY tablename), ARRAY[]::text[])
    INTO v_actual
    FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime' AND schemaname = 'public';

  SELECT coalesce(array_agg(t), ARRAY[]::text[]) INTO v_absent
    FROM unnest(v_expected) t WHERE t <> ALL (v_actual);
  SELECT coalesce(array_agg(t), ARRAY[]::text[]) INTO v_extra
    FROM unnest(v_actual) t WHERE t <> ALL (v_expected);

  IF array_length(v_absent, 1) IS NULL THEN
    v_pass := v_pass + 1;
    v_out := v_out || format('PASS  all 7 subscribed tables are published (%s)%s',
      array_to_string(v_actual, ', '), E'\n');
  ELSE
    v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  not published: %s%s', array_to_string(v_absent, ', '), E'\n');
  END IF;

  IF array_length(v_extra, 1) IS NULL THEN
    v_pass := v_pass + 1;
    v_out := v_out || format('PASS  nothing else is published%s', E'\n');
  ELSE
    v_out := v_out || format('WARN  also published, confirm intentional: %s%s',
      array_to_string(v_extra, ', '), E'\n');
  END IF;

  ---------------------------------------------------------------------------
  -- 2. The publication publishes all four operations
  ---------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM pg_publication
              WHERE pubname='supabase_realtime'
                AND pubinsert AND pubupdate AND pubdelete) THEN
    v_pass := v_pass + 1;
    v_out := v_out || format('PASS  publication carries INSERT, UPDATE and DELETE%s', E'\n');
  ELSE
    v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  publication does not publish all of insert/update/delete%s', E'\n');
  END IF;

  ---------------------------------------------------------------------------
  -- 3. Every published table can still be deleted from
  --    A published table with REPLICA IDENTITY NOTHING makes Postgres reject
  --    DELETE outright, so this guards writes, not just replication.
  ---------------------------------------------------------------------------
  SELECT coalesce(array_agg(c.relname ORDER BY c.relname), ARRAY[]::text[])
    INTO v_bad_ri
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = ANY (v_expected)
     AND (c.relreplident = 'n'
          OR (c.relreplident = 'd'
              AND NOT EXISTS (SELECT 1 FROM pg_index i
                               WHERE i.indrelid = c.oid AND i.indisprimary)));

  IF array_length(v_bad_ri, 1) IS NULL THEN
    v_pass := v_pass + 1;
    v_out := v_out || format('PASS  every published table has a usable row identity%s', E'\n');
  ELSE
    v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  no usable replica identity, DELETE will be rejected on: %s%s',
      array_to_string(v_bad_ri, ', '), E'\n');
  END IF;

  ---------------------------------------------------------------------------
  -- 4. RLS still scopes subscribers
  --    Same context Realtime uses when it decides whether to forward a row.
  ---------------------------------------------------------------------------
  SELECT user_email INTO v_viewer
    FROM public.user_roles WHERE role = 'viewer' AND status = 'active' LIMIT 1;
  SELECT user_email INTO v_rep
    FROM public.user_roles WHERE role = 'sales_rep' AND status = 'active'
   ORDER BY user_email LIMIT 1;

  PERFORM set_config('role', 'authenticated', true);

  -- 4a. a staff subscriber does receive ticket rows
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_viewer, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM public.rma_tickets;
  IF v_n > 0 THEN
    v_pass := v_pass + 1;
    v_out := v_out || format('PASS  staff (viewer) can see rma_tickets: %s rows%s', v_n, E'\n');
  ELSE
    v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  staff (viewer) sees 0 rma_tickets - subscriptions would stay silent%s', E'\n');
  END IF;

  -- 4b. an authenticated account with no role row receives nothing
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', 'ahmed@qdsegypt.com', 'role', 'authenticated')::text, true);
  SELECT (SELECT count(*) FROM public.rma_tickets)
       + (SELECT count(*) FROM public.customers)
       + (SELECT count(*) FROM public.products)
       + (SELECT count(*) FROM public.inventory_units)
    INTO v_n;
  IF v_n = 0 THEN
    v_pass := v_pass + 1;
    v_out := v_out || format('PASS  authenticated-but-unassigned account sees 0 rows across the staff tables%s', E'\n');
  ELSE
    v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  authenticated-but-unassigned account can see %s rows - publishing leaks them%s',
      v_n, E'\n');
  END IF;

  -- 4c. a sales_rep is still scoped to their own activities and leads
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_rep, 'role', 'authenticated')::text, true);
  SELECT (SELECT count(*) FROM public.activities WHERE assigned_rep IS DISTINCT FROM v_rep)
       + (SELECT count(*) FROM public.leads      WHERE assigned_rep IS DISTINCT FROM v_rep)
    INTO v_n;
  IF v_n = 0 THEN
    v_pass := v_pass + 1;
    v_out := v_out || format('PASS  sales_rep sees no foreign activities or leads%s', E'\n');
  ELSE
    v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  sales_rep can see %s foreign activity/lead rows%s', v_n, E'\n');
  END IF;

  PERFORM set_config('role', 'postgres', true);

  v_out := v_out || format('%s%s passed, %s failed.%s',
    E'\n', v_pass, v_fail,
    CASE WHEN v_fail = 0
         THEN ' Note: DELETE events reach every subscriber regardless of RLS, by design; the payload is the primary key only.'
         ELSE '' END);

  RAISE EXCEPTION 'VERDICT :: %', v_out;
END
$verify$;
