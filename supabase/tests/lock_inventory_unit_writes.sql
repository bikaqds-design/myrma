-- ############################################################################
-- #  LOCK DOWN SERIALIZED STOCK WRITES — BL-03 / I-03 (20260877)
-- #
-- #  Before: any non-viewer (a technician, a sales rep) could INSERT a
-- #  sellable company_stock unit straight into inventory_units, and could
-- #  UPDATE its status, with no stock_moves row. Now creation goes through
-- #  rma_create_units_from_ticket (which forces active_rma and writes the
-- #  ledger), direct client INSERT is gone, and status is a guarded column.
-- #
-- #  Written FIRST (red) and kept as the regression test. HOW TO RUN:
-- #  node scripts/run-sql-test.mjs supabase/tests/lock_inventory_unit_writes.sql BL03_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI.
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
          WHEN 'denied' THEN outcome LIKE 'err:42501%'
          WHEN 'guard'  THEN outcome LIKE 'err:23514%'
          WHEN 'p0001'  THEN outcome LIKE 'err:P0001%'
          ELSE outcome LIKE 'ok:%' AND outcome <> 'ok:0'
        END;
  RETURN format('%s  %-56s expect %-6s -> %s',
    CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_expect, outcome);
END $f$;

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE sql AS $f$
  SELECT format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, p_detail)
$f$;

-- Calls the RPC as a signed-in user and returns its jsonb result.
CREATE FUNCTION pg_temp.create_units(p_email text, p_ticket uuid, p_units jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    r := public.rma_create_units_from_ticket(p_ticket, p_units);
  EXCEPTION WHEN OTHERS THEN
    r := jsonb_build_object('error', SQLSTATE || ' ' || left(SQLERRM, 100));
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;

DO $do$
DECLARE
  v_tech    text := 'bl03-tech@test.local';
  v_rep     text := 'bl03-rep@test.local';
  v_viewer  text := 'bl03-viewer@test.local';
  v_mgr     text := 'bl03-mgr@test.local';
  v_ticket2 uuid := gen_random_uuid();
  v_wh      uuid := gen_random_uuid();
  v_batch   record;
  v_ticket  uuid := gen_random_uuid();
  v_unit    uuid := gen_random_uuid();
  v_r       jsonb;
  v_n       bigint;
  v_row     record;
  v_rma     text;
BEGIN
  -- A freshly provisioned project has no document_sequences rows (they were seeded by
  -- historical migrations the baseline skips), so seed the one this test needs.
  INSERT INTO public.document_sequences (seq_type, last_value, seq_year)
  SELECT 'batch', 0, 2026 WHERE NOT EXISTS (SELECT 1 FROM public.document_sequences WHERE seq_type = 'batch');
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES (v_tech, 'technician', 'active'), (v_rep, 'sales_rep', 'active'), (v_viewer, 'viewer', 'active'),
         (v_mgr, 'manager', 'active');
  -- v_ticket was created by the technician; v_ticket2 by somebody else and assigned to nobody.
  INSERT INTO public.rma_tickets (id, rma_number, created_by) VALUES (v_ticket, 'RMA-BL03-001', v_tech);
  INSERT INTO public.rma_tickets (id, rma_number, created_by) VALUES (v_ticket2, 'RMA-BL03-002', 'someone.else@test.local');
  -- A trigger assigns the real number on insert, so read it back rather than assume.
  SELECT rma_number INTO v_rma FROM public.rma_tickets WHERE id = v_ticket;
  -- A real, sellable unit, written as the owner (which the guards treat as an RPC).
  INSERT INTO public.warehouses (id, name) VALUES (v_wh, 'BL03 Branch');
  INSERT INTO public.inventory_units (id, product_name, serial_number, status, reservation_status, warehouse_id)
  VALUES (v_unit, 'Existing unit', 'BL03-EXISTING', 'company_stock', 'available', v_wh);

  RAISE NOTICE '--- 1. A client can no longer put a unit into stock or change its status ---';
  RAISE NOTICE '%', pg_temp.probe('technician INSERTs a company_stock unit', v_tech,
    'INSERT INTO public.inventory_units (product_name, serial_number, status) VALUES (''Phantom'', ''BL03-PH1'', ''company_stock'')', 'denied');
  RAISE NOTICE '%', pg_temp.probe('sales rep INSERTs an active_rma unit', v_rep,
    'INSERT INTO public.inventory_units (product_name, serial_number, status) VALUES (''Phantom'', ''BL03-PH2'', ''active_rma'')', 'denied');
  RAISE NOTICE '%', pg_temp.probe('technician UPDATEs a unit status', v_tech,
    format('UPDATE public.inventory_units SET status = ''closed'' WHERE id = %L', v_unit), 'guard');
  RAISE NOTICE '%', pg_temp.probe('sales rep UPDATEs a unit status', v_rep,
    format('UPDATE public.inventory_units SET status = ''active_rma'' WHERE id = %L', v_unit), 'guard');
  RAISE NOTICE '%', pg_temp.probe('technician can still edit notes (control)', v_tech,
    format('UPDATE public.inventory_units SET notes = ''checked'' WHERE id = %L', v_unit), 'ok');

  RAISE NOTICE '--- 2. status is a checked column ---';
  RAISE NOTICE '%', pg_temp.probe('owner INSERT with a made-up status', NULL,
    'INSERT INTO public.inventory_units (product_name, serial_number, status) VALUES (''X'', ''BL03-BAD'', ''sellable'')', 'guard');

  RAISE NOTICE '--- 3. The RMA intake RPC creates units and writes the ledger ---';
  v_r := pg_temp.create_units(v_tech, v_ticket, jsonb_build_array(
    -- the client asks for company_stock; the RPC must ignore that
    jsonb_build_object('product_name', 'Camera', 'serial_number', '  BL03-A  ', 'warranty_status', 'In Warranty',
                       'status', 'company_stock', 'reservation_status', 'reserved'),
    jsonb_build_object('product_name', 'Recorder', 'serial_number', 'BL03-B')));
  RAISE NOTICE '%', pg_temp.check('two units created, none failed',
    jsonb_array_length(v_r -> 'created') = 2 AND jsonb_array_length(v_r -> 'failed') = 0, coalesce(v_r ->> 'error', ''));
  SELECT * INTO v_row FROM public.inventory_units WHERE serial_number = 'BL03-A';
  RAISE NOTICE '%', pg_temp.check('forced to active_rma / available / unplaced, serial trimmed, ticket number from the ticket',
    v_row.status = 'active_rma' AND v_row.reservation_status = 'available' AND v_row.warehouse_id IS NULL
    AND v_row.rma_ticket_id = v_ticket AND v_row.rma_number = v_rma
    AND v_row.reserved_by_doc_id IS NULL AND v_row.unit_cost_base IS NULL,
    format('(%s/%s/%s)', v_row.status, v_row.reservation_status, v_row.rma_number));
  SELECT count(*) INTO v_n FROM public.stock_moves
   WHERE ref_type = 'unit' AND doc_type = 'rma_ticket' AND doc_id = v_ticket AND move_type = 'receive'
     AND to_status = 'active_rma' AND actor_email = v_tech;
  RAISE NOTICE '%', pg_temp.check('one stock_moves receive row per unit, actor = the caller', v_n = 2, format('(%s rows)', v_n));

  RAISE NOTICE '--- 4. One bad unit costs only itself ---';
  v_r := pg_temp.create_units(v_tech, v_ticket, jsonb_build_array(
    jsonb_build_object('product_name', 'Fresh', 'serial_number', 'BL03-C'),
    jsonb_build_object('product_name', 'Duplicate', 'serial_number', 'BL03-A'),
    jsonb_build_object('product_name', 'Fresh 2', 'serial_number', 'BL03-D')));
  RAISE NOTICE '%', pg_temp.check('2 created, 1 failed with its serial and the 23505 code',
    jsonb_array_length(v_r -> 'created') = 2 AND jsonb_array_length(v_r -> 'failed') = 1
    AND v_r -> 'failed' -> 0 ->> 'serial_number' = 'BL03-A' AND v_r -> 'failed' -> 0 ->> 'code' = '23505',
    coalesce(v_r -> 'failed' ->> 0, '<none>'));
  SELECT count(*) INTO v_n FROM public.stock_moves WHERE doc_id = v_ticket AND move_type = 'receive';
  RAISE NOTICE '%', pg_temp.check('the failed unit left no ledger row (2 + 2 = 4)', v_n = 4, format('(%s rows)', v_n));

  RAISE NOTICE '--- 5. Who may call it, and on what ---';
  v_r := pg_temp.create_units(v_viewer, v_ticket, jsonb_build_array(jsonb_build_object('serial_number', 'BL03-V')));
  RAISE NOTICE '%', pg_temp.check('a viewer is refused', v_r ? 'error' AND v_r ->> 'error' LIKE 'P0001%', coalesce(v_r ->> 'error', '<no error>'));
  v_r := pg_temp.create_units(v_tech, gen_random_uuid(), jsonb_build_array(jsonb_build_object('serial_number', 'BL03-N')));
  RAISE NOTICE '%', pg_temp.check('an unknown ticket is refused', v_r ? 'error' AND v_r ->> 'error' LIKE 'P0001%', coalesce(v_r ->> 'error', '<no error>'));
  v_r := pg_temp.create_units(v_tech, v_ticket, '{"not":"an array"}'::jsonb);
  RAISE NOTICE '%', pg_temp.check('a non-array payload is refused', v_r ? 'error' AND v_r ->> 'error' LIKE 'P0001%', coalesce(v_r ->> 'error', '<no error>'));

  RAISE NOTICE '--- 6. Review: the batch RPCs cannot be used to change a sellable unit ---';
  RAISE NOTICE '%', pg_temp.probe('technician batches a sellable company_stock unit', v_tech,
    format('SELECT public.create_manufacturer_batch(ARRAY[%L::uuid], ''x'', ''x'')', v_unit), 'p0001');
  SELECT id INTO v_row FROM public.inventory_units WHERE serial_number = 'BL03-B';
  RAISE NOTICE '%', pg_temp.probe('technician batches an active_rma unit (control)', v_tech,
    format('SELECT public.create_manufacturer_batch(ARRAY[%L::uuid], ''x'', ''x'')', v_row.id), 'ok');

  RAISE NOTICE '--- 7. Review: more columns are guarded ---';
  RAISE NOTICE '%', pg_temp.probe('PATCH manufacturer_batch_id', v_tech,
    format('UPDATE public.inventory_units SET manufacturer_batch_id = gen_random_uuid() WHERE id = %L', v_unit), 'guard');
  RAISE NOTICE '%', pg_temp.probe('PATCH warehouse_id to NULL', v_tech,
    format('UPDATE public.inventory_units SET warehouse_id = NULL, notes = ''x'' WHERE id = %L', v_unit), 'guard');
  RAISE NOTICE '%', pg_temp.probe('PATCH rma_ticket_id', v_tech,
    format('UPDATE public.inventory_units SET rma_ticket_id = %L WHERE id = %L', v_ticket2, v_unit), 'guard');
  RAISE NOTICE '%', pg_temp.probe('PATCH resolution_type', v_tech,
    format('UPDATE public.inventory_units SET resolution_type = ''replacement'' WHERE id = %L', v_unit), 'guard');
  RAISE NOTICE '%', pg_temp.probe('PATCH created_date (FIFO order)', v_tech,
    format('UPDATE public.inventory_units SET created_date = now() - interval ''1 year'' WHERE id = %L', v_unit), 'guard');
  RAISE NOTICE '%', pg_temp.probe('notes and warranty_status stay editable (control)', v_tech,
    format('UPDATE public.inventory_units SET notes = ''n'', warranty_status = ''Out'' WHERE id = %L', v_unit), 'ok');
  RAISE NOTICE '%', pg_temp.probe('owner INSERT with a NULL status', NULL,
    'INSERT INTO public.inventory_units (product_name, serial_number, status) VALUES (''X'', ''BL03-NULL'', NULL)', 'guard');

  RAISE NOTICE '--- 8. Review: who may attach units to which ticket ---';
  v_r := pg_temp.create_units(v_tech, v_ticket2, jsonb_build_array(jsonb_build_object('serial_number', 'BL03-T2')));
  RAISE NOTICE '%', pg_temp.check('a technician cannot attach units to a ticket they did not create',
    v_r ? 'error' AND v_r ->> 'error' LIKE 'P0001%', coalesce(v_r ->> 'error', '<no error>'));
  v_r := pg_temp.create_units(v_mgr, v_ticket2, jsonb_build_array(jsonb_build_object('serial_number', 'BL03-T2')));
  RAISE NOTICE '%', pg_temp.check('a manager can (control)', jsonb_array_length(v_r -> 'created') = 1, coalesce(v_r ->> 'error', ''));

  RAISE NOTICE '--- 9. Review: size cap, error handling, hygiene ---';
  v_r := pg_temp.create_units(v_tech, v_ticket, (SELECT jsonb_agg(jsonb_build_object('serial_number', 'BL03-BULK-' || g)) FROM generate_series(1, 201) g));
  RAISE NOTICE '%', pg_temp.check('201 units in one call is refused', v_r ? 'error' AND v_r ->> 'error' LIKE 'P0001%', coalesce(v_r ->> 'error', '<no error>'));
  v_r := pg_temp.create_units(v_tech, v_ticket, jsonb_build_array(
    jsonb_build_object('serial_number', 'BL03-OKAY'),
    jsonb_build_object('serial_number', 'BL03-BADUUID', 'product_id', 'not-a-uuid')));
  RAISE NOTICE '%', pg_temp.check('a malformed product_id fails that unit only, with a generic message',
    jsonb_array_length(v_r -> 'created') = 1 AND jsonb_array_length(v_r -> 'failed') = 1
    AND v_r -> 'failed' -> 0 ->> 'code' = '22P02' AND v_r -> 'failed' -> 0 ->> 'message' NOT LIKE '%not-a-uuid%',
    coalesce(v_r -> 'failed' -> 0 ->> 'message', '<none>'));
  RAISE NOTICE '%', pg_temp.check('the RPC pins pg_temp last in its search_path',
    EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'rma_create_units_from_ticket'
            AND proconfig::text LIKE '%pg_temp%'));
  RAISE NOTICE '%', pg_temp.check('authenticated cannot TRUNCATE the stock ledger',
    NOT has_table_privilege('authenticated', 'public.stock_moves', 'TRUNCATE'));

  RAISE EXCEPTION 'BL03_TEST_DONE — rolling back fixtures (this is not a real failure)';
END $do$;
