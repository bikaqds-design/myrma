-- ############################################################################
-- #  DB TEST TIER — Warehouse Module Redesign R1: system RMA locations,
-- #  move_rma_units, promote_rma_unit
-- #
-- #  Covers the migrations that close the gap identified in the Warehouse
-- #  Module redesign research: RMA ticket stages had no real inventory
-- #  location (units sat with warehouse_id = NULL forever) and there was no
-- #  runtime path from active_rma back to sellable company_stock.
-- #
-- #  Same shape as the other hardening files: RAISE EXCEPTION naming the
-- #  specific failing check, so `psql -v ON_ERROR_STOP=1` fails the CI job
-- #  cleanly. Independent of the other files (its own throwaway fixtures).
-- ############################################################################

DO $$
DECLARE
  v_mgr          text := 'karim.nasser@test.com';  -- seeded by 20260706, role='manager'
  v_p1           uuid;
  v_wh_legacy    uuid;
  v_rma_received uuid;
  v_rma_repair   uuid;
  v_ticket1      uuid;
  v_ticket2      uuid;
  v_unit1        uuid;  v_unit2 uuid;  v_unit3 uuid;  v_unit4 uuid;  v_unit5 uuid;  v_unit6 uuid;
  v_unit_res     uuid;  -- CHECK 6b: active_rma + reserved (own variable; v_unit6 is reused later)
  v_wh_check     uuid;
  v_status       text;
  v_res          text;
  v_resolution   text;
  v_moved        integer;
  v_move_count   integer;
  v_system_count integer;
  v_unplaced     integer;
  v_failures     text[] := '{}';
  v_check_count  int := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_email = v_mgr AND role = 'manager'
  ) THEN
    RAISE EXCEPTION
      'Test prerequisite missing: manager user % not found in user_roles — did 20260706_seed_test_users_and_deals.sql apply?',
      v_mgr;
  END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);

  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode) VALUES
    ('CI-INV3-P1-' || floor(random()*100000)::text, 'CI RMA-location product', 'hardware', 'active', 'serialized')
    RETURNING id INTO v_p1;

  INSERT INTO public.warehouses (name) VALUES ('CI Legacy WH (no type)') RETURNING id INTO v_wh_legacy;

  SELECT id INTO v_rma_received FROM public.warehouses WHERE code = 'RMA-RECEIVED' AND is_system;
  SELECT id INTO v_rma_repair   FROM public.warehouses WHERE code = 'RMA-REPAIR'   AND is_system;

  INSERT INTO public.rma_tickets (rma_number, customer_name, ticket_status, priority, products)
  VALUES (
    'CI-RMA3-1-' || floor(random()*100000)::text, 'CI Test Customer', 'Open', 'Medium',
    jsonb_build_array(jsonb_build_object('product_name', 'CI RMA-location product', 'serial_number', 'CI-INV3-UNIT-1', 'product_status', 'Under Repair'))
  ) RETURNING id INTO v_ticket1;

  INSERT INTO public.rma_tickets (rma_number, customer_name, ticket_status, priority, products)
  VALUES (
    'CI-RMA3-2-' || floor(random()*100000)::text, 'CI Test Customer', 'Open', 'Medium', '[]'::jsonb
  ) RETURNING id INTO v_ticket2;

  -- ══════════════════════════ system locations ════════════════════════════

  -- ── CHECK 1: 8 system locations are seeded with the fixed codes ──
  v_check_count := v_check_count + 1;
  SELECT COUNT(*) INTO v_system_count
  FROM public.warehouses
  WHERE is_system AND code IN (
    'RMA-RECEIVED', 'RMA-REPAIR', 'RMA-REPAIRED', 'RMA-CANTREPAIR',
    'RMA-STOCK', 'REPLACEMENT', 'CREDIT-NOTE', 'SCRAP');
  IF v_system_count <> 8 THEN
    v_failures := array_append(v_failures,
      format('CHECK 1 (system locations seeded): found %s of 8 expected system rows', v_system_count));
  END IF;

  -- ══════════════════════════ move_rma_units ═══════════════════════════════

  -- ── CHECK 2: happy path moves the unit and writes a ledger row ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.inventory_units (product_id, product_name, serial_number, status, reservation_status, rma_ticket_id, created_date)
  VALUES (v_p1, 'CI RMA-location product', 'CI-INV3-UNIT-1', 'active_rma', 'available', v_ticket1, now())
  RETURNING id INTO v_unit1;

  SELECT public.move_rma_units(v_ticket1,
    jsonb_build_array(jsonb_build_object('unit_id', v_unit1::text, 'to_code', 'RMA-REPAIR')),
    v_mgr) INTO v_moved;

  SELECT warehouse_id INTO v_wh_check FROM public.inventory_units WHERE id = v_unit1;
  SELECT COUNT(*) INTO v_move_count FROM public.stock_moves
    WHERE ref_type = 'unit' AND ref_id = v_unit1 AND doc_type = 'rma_ticket' AND doc_id = v_ticket1 AND move_type = 'transfer';

  IF NOT (v_moved = 1 AND v_wh_check = v_rma_repair AND v_move_count = 1) THEN
    v_failures := array_append(v_failures,
      format('CHECK 2 (move_rma_units happy path): moved=%s warehouse=%s (expected RMA-REPAIR) ledger_rows=%s',
             v_moved, v_wh_check, v_move_count));
  END IF;

  -- ── CHECK 3: repeating the same move is an idempotent no-op ──
  v_check_count := v_check_count + 1;
  SELECT public.move_rma_units(v_ticket1,
    jsonb_build_array(jsonb_build_object('unit_id', v_unit1::text, 'to_code', 'RMA-REPAIR')),
    v_mgr) INTO v_moved;

  SELECT COUNT(*) INTO v_move_count FROM public.stock_moves
    WHERE ref_type = 'unit' AND ref_id = v_unit1 AND doc_type = 'rma_ticket' AND doc_id = v_ticket1;

  IF NOT (v_moved = 0 AND v_move_count = 1) THEN
    v_failures := array_append(v_failures,
      format('CHECK 3 (move_rma_units idempotent repeat): moved=%s ledger_rows=%s (expected 0/1)', v_moved, v_move_count));
  END IF;

  -- ── CHECK 4: moving a unit that belongs to a different ticket is rejected ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.inventory_units (product_id, product_name, status, reservation_status, rma_ticket_id, created_date)
  VALUES (v_p1, 'CI RMA-location product', 'active_rma', 'available', v_ticket2, now())
  RETURNING id INTO v_unit2;
  BEGIN
    PERFORM public.move_rma_units(v_ticket1,
      jsonb_build_array(jsonb_build_object('unit_id', v_unit2::text, 'to_code', 'RMA-REPAIR')), v_mgr);
    v_failures := array_append(v_failures, 'CHECK 4 (move unit not on ticket blocked): was NOT blocked');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ── CHECK 5: moving a non-active_rma (company_stock) unit is rejected ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.inventory_units (product_id, product_name, status, reservation_status, rma_ticket_id, created_date)
  VALUES (v_p1, 'CI RMA-location product', 'company_stock', 'available', v_ticket1, now())
  RETURNING id INTO v_unit3;
  BEGIN
    PERFORM public.move_rma_units(v_ticket1,
      jsonb_build_array(jsonb_build_object('unit_id', v_unit3::text, 'to_code', 'RMA-REPAIR')), v_mgr);
    v_failures := array_append(v_failures, 'CHECK 5 (move company_stock unit blocked): was NOT blocked');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ── CHECK 6: an unknown system location code is rejected ──
  v_check_count := v_check_count + 1;
  BEGIN
    PERFORM public.move_rma_units(v_ticket1,
      jsonb_build_array(jsonb_build_object('unit_id', v_unit1::text, 'to_code', 'NOT-A-REAL-CODE')), v_mgr);
    v_failures := array_append(v_failures, 'CHECK 6 (move unknown to_code blocked): was NOT blocked');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ── CHECK 6b: moving a RESERVED active_rma unit is rejected ──
  -- Added 2026-08-06. This is the rejection behind the UI's
  -- `inventory.autoMoveFailed` toast ("Ticket saved, but moving the unit(s)…
  -- failed") — WAREHOUSE_R1_TEST_CHECKLIST.md §4. That row sat unrunnable for
  -- the whole manual QA pass because the application cannot produce the state:
  -- the sales funnel only ever reserves `company_stock`, never an RMA unit. It
  -- is trivially stageable here, so the guard is asserted in CI rather than
  -- left to a tester who can never reach it.
  --
  -- Unlike the checks above this asserts the SQLSTATE, not merely "something
  -- threw" — a negative test that accepts any error would also pass if the
  -- fixture itself were malformed.
  v_check_count := v_check_count + 1;
  INSERT INTO public.inventory_units (product_id, product_name, status, reservation_status, warehouse_id, rma_ticket_id, created_date)
  VALUES (v_p1, 'CI RMA-location product', 'active_rma', 'reserved', v_rma_received, v_ticket1, now())
  RETURNING id INTO v_unit_res;
  BEGIN
    PERFORM public.move_rma_units(v_ticket1,
      jsonb_build_array(jsonb_build_object('unit_id', v_unit_res::text, 'to_code', 'RMA-REPAIR')), v_mgr);
    v_failures := array_append(v_failures, 'CHECK 6b (move reserved unit blocked): was NOT blocked');
  EXCEPTION
    WHEN sqlstate 'P0001' THEN
      NULL; -- expected: "cannot auto-move a reserved/delivered unit"
    WHEN OTHERS THEN
      v_failures := array_append(v_failures,
        format('CHECK 6b (move reserved unit blocked): wrong error %s — %s', SQLSTATE, SQLERRM));
  END;

  -- ══════════════════════════ promote_rma_unit ═════════════════════════════

  -- ── CHECK 7: promote into a legacy NULL-type warehouse succeeds (backward compat) ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.inventory_units (product_id, product_name, status, reservation_status, warehouse_id, rma_ticket_id, created_date)
  VALUES (v_p1, 'CI RMA-location product', 'active_rma', 'available', v_rma_received, v_ticket1, now())
  RETURNING id INTO v_unit4;

  PERFORM public.promote_rma_unit(v_unit4, v_wh_legacy, v_mgr, 'replacement');
  SELECT status, warehouse_id, resolution_type INTO v_status, v_wh_check, v_resolution FROM public.inventory_units WHERE id = v_unit4;

  IF NOT (v_status = 'company_stock' AND v_wh_check = v_wh_legacy AND v_resolution = 'replacement') THEN
    v_failures := array_append(v_failures,
      format('CHECK 7 (promote into legacy NULL-type warehouse): status=%s warehouse=%s resolution=%s', v_status, v_wh_check, v_resolution));
  END IF;

  -- ── CHECK 8: promoting a reserved unit is rejected ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.inventory_units (product_id, product_name, status, reservation_status, warehouse_id, rma_ticket_id, created_date)
  VALUES (v_p1, 'CI RMA-location product', 'active_rma', 'reserved', v_rma_received, v_ticket1, now())
  RETURNING id INTO v_unit5;
  BEGIN
    PERFORM public.promote_rma_unit(v_unit5, v_wh_legacy, v_mgr);
    v_failures := array_append(v_failures, 'CHECK 8 (promote reserved unit blocked): was NOT blocked');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ── CHECK 9: promoting into an is_system location is rejected ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.inventory_units (product_id, product_name, status, reservation_status, warehouse_id, rma_ticket_id, created_date)
  VALUES (v_p1, 'CI RMA-location product', 'active_rma', 'available', v_rma_received, v_ticket1, now())
  RETURNING id INTO v_unit6;
  BEGIN
    PERFORM public.promote_rma_unit(v_unit6, v_rma_repair, v_mgr);
    v_failures := array_append(v_failures, 'CHECK 9 (promote into is_system location blocked): was NOT blocked');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ══════════════════════════ protection trigger ═══════════════════════════

  -- ── CHECK 10: renaming a system warehouse row is rejected ──
  v_check_count := v_check_count + 1;
  BEGIN
    UPDATE public.warehouses SET name = 'Hacked Name' WHERE id = v_rma_received;
    v_failures := array_append(v_failures, 'CHECK 10 (system warehouse rename blocked): was NOT blocked');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ── CHECK 11: archiving a system warehouse is rejected ──
  v_check_count := v_check_count + 1;
  BEGIN
    PERFORM public.archive_warehouse(v_rma_received, v_mgr);
    v_failures := array_append(v_failures, 'CHECK 11 (archive_warehouse on system row blocked): was NOT blocked');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ── Cleanup: hard-delete everything seeded, FK-safe order ──
  DELETE FROM public.stock_moves WHERE ref_type = 'unit' AND ref_id IN (
    SELECT id FROM public.inventory_units WHERE product_id = v_p1);
  DELETE FROM public.inventory_units WHERE product_id = v_p1;
  DELETE FROM public.rma_tickets WHERE id = ANY(ARRAY[v_ticket1, v_ticket2]);
  DELETE FROM public.warehouses WHERE id = v_wh_legacy;
  DELETE FROM public.products WHERE id = v_p1;

  -- ══════════════════════════ global invariant ═════════════════════════════

  -- ── CHECK 12: no active_rma unit on a non-cancelled ticket is left unplaced ──
  -- (the exact property the 20260767 backfill and every move/promote RPC
  -- above exist to guarantee going forward). Runs after this file's own
  -- fixtures are cleaned up, so it reflects real pre-existing data only.
  v_check_count := v_check_count + 1;
  SELECT COUNT(*) INTO v_unplaced
  FROM public.inventory_units u
  JOIN public.rma_tickets t ON t.id = u.rma_ticket_id
  WHERE u.status = 'active_rma'
    AND u.warehouse_id IS NULL
    AND t.ticket_status <> 'Cancelled';

  IF v_unplaced <> 0 THEN
    v_failures := array_append(v_failures,
      format('CHECK 12 (no unplaced active_rma units): found %s unplaced unit(s) on non-cancelled tickets', v_unplaced));
  END IF;

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % warehouse-module-R1 check(s) FAILED:\n%',
      array_length(v_failures, 1), v_check_count, array_to_string(v_failures, E'\n');
  END IF;

  RAISE NOTICE 'All % warehouse-module-R1 checks passed', v_check_count;
END $$;
