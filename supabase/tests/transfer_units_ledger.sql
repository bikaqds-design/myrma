-- ############################################################################
-- #  DB TEST TIER — BUG-032: warehouse transfers and manufacturer-batch
-- #  status changes write to the stock_moves ledger
-- #
-- #  20260866 adds transfer_units() (the set-based sibling of transfer_stock)
-- #  and puts mark_batch_sent / mark_batch_resolved on the ledger. The rules
-- #  the browser-side guard from 20260831 enforces — no reserved unit, no
-- #  system destination — have to be repeated inside the function, because a
-- #  SECURITY DEFINER caller skips that guard by design. So they are asserted
-- #  here directly rather than assumed from the guard's own tests.
-- #
-- #  Same shape as the other hardening files: collect failures, RAISE
-- #  EXCEPTION naming each one, so `psql -v ON_ERROR_STOP=1` fails CI cleanly.
-- #  Own throwaway fixtures; independent of the other files.
-- ############################################################################

DO $$
DECLARE
  v_mgr          text := 'karim.nasser@test.com';  -- seeded by 20260706, role='manager'
  v_tech         text := 'hana.sayed@test.com';    -- seeded by 20260706, role='technician'
  v_p1           uuid;
  v_wh_a         uuid;
  v_wh_b         uuid;
  v_wh_archived  uuid;
  v_sys          uuid;
  v_unit1        uuid;
  v_unit2        uuid;
  v_unit_res     uuid;
  v_batch        uuid;
  v_moved        integer;
  v_rows         integer;
  v_where        uuid;
  v_from         text;
  v_to           text;
  v_status       text;
  v_closed       integer;
  v_failures     text[] := '{}';
  v_check_count  int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_email = v_mgr AND role = 'manager')
     OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_email = v_tech AND role = 'technician') THEN
    RAISE EXCEPTION
      'Test prerequisite missing: seeded manager/technician not found — did 20260706_seed_test_users_and_deals.sql apply?';
  END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);

  -- ── Fixtures ──
  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode)
  VALUES ('CI-TRF-P1-' || floor(random()*100000)::text, 'CI transfer-ledger product', 'hardware', 'active', 'serialized')
  RETURNING id INTO v_p1;

  INSERT INTO public.warehouses (name, warehouse_type) VALUES ('CI Transfer WH A', 'main') RETURNING id INTO v_wh_a;
  INSERT INTO public.warehouses (name, warehouse_type) VALUES ('CI Transfer WH B', 'branch') RETURNING id INTO v_wh_b;
  INSERT INTO public.warehouses (name, warehouse_type, is_active) VALUES ('CI Transfer WH Archived', 'branch', false)
  RETURNING id INTO v_wh_archived;

  SELECT id INTO v_sys FROM public.warehouses WHERE code = 'RMA-RECEIVED' AND is_system;

  INSERT INTO public.inventory_units (product_id, serial_number, status, reservation_status, warehouse_id)
  VALUES (v_p1, 'CI-TRF-U1-' || floor(random()*100000)::text, 'company_stock', 'available', v_wh_a)
  RETURNING id INTO v_unit1;

  INSERT INTO public.inventory_units (product_id, serial_number, status, reservation_status, warehouse_id)
  VALUES (v_p1, 'CI-TRF-U2-' || floor(random()*100000)::text, 'company_stock', 'available', v_wh_a)
  RETURNING id INTO v_unit2;

  INSERT INTO public.inventory_units (product_id, serial_number, status, reservation_status, warehouse_id)
  VALUES (v_p1, 'CI-TRF-U3-' || floor(random()*100000)::text, 'company_stock', 'reserved', v_wh_a)
  RETURNING id INTO v_unit_res;

  -- ══════════════════════════ transfer_units ═══════════════════════════════

  -- ── CHECK 1: a transfer moves the units and writes one ledger row each,
  --            carrying both warehouse ids ──
  v_check_count := v_check_count + 1;
  v_moved := public.transfer_units(ARRAY[v_unit1, v_unit2], v_wh_b, v_mgr);

  SELECT warehouse_id INTO v_where FROM public.inventory_units WHERE id = v_unit1;
  SELECT count(*) INTO v_rows FROM public.stock_moves
   WHERE ref_type = 'unit' AND ref_id IN (v_unit1, v_unit2) AND move_type = 'transfer';
  SELECT from_status, to_status INTO v_from, v_to FROM public.stock_moves
   WHERE ref_type = 'unit' AND ref_id = v_unit1 AND move_type = 'transfer';

  IF v_moved <> 2 OR v_where IS DISTINCT FROM v_wh_b OR v_rows <> 2
     OR v_from IS DISTINCT FROM v_wh_a::text OR v_to IS DISTINCT FROM v_wh_b::text THEN
    v_failures := array_append(v_failures, format(
      'CHECK 1 (transfer moves and ledgers): moved=%s, unit1 at=%s (want %s), ledger rows=%s (want 2), from=%s to=%s',
      v_moved, v_where, v_wh_b, v_rows, v_from, v_to));
  END IF;

  -- ── CHECK 2: a unit already at the destination is a no-op, not a second
  --            ledger row (re-saving must not inflate the history) ──
  v_check_count := v_check_count + 1;
  v_moved := public.transfer_units(ARRAY[v_unit1, v_unit2], v_wh_b, v_mgr);
  SELECT count(*) INTO v_rows FROM public.stock_moves
   WHERE ref_type = 'unit' AND ref_id IN (v_unit1, v_unit2) AND move_type = 'transfer';

  IF v_moved <> 0 OR v_rows <> 2 THEN
    v_failures := array_append(v_failures, format(
      'CHECK 2 (repeat transfer is a no-op): moved=%s (want 0), ledger rows=%s (want 2)', v_moved, v_rows));
  END IF;

  -- ── CHECK 3: a reserved unit is refused, and the rest of the batch is left
  --            alone — all-or-nothing, not partial ──
  v_check_count := v_check_count + 1;
  BEGIN
    PERFORM public.transfer_units(ARRAY[v_unit1, v_unit_res], v_wh_a, v_mgr);
    v_failures := array_append(v_failures, 'CHECK 3 (reserved unit refused): was NOT refused');
  EXCEPTION WHEN OTHERS THEN
    SELECT warehouse_id INTO v_where FROM public.inventory_units WHERE id = v_unit1;
    IF v_where IS DISTINCT FROM v_wh_b THEN
      v_failures := array_append(v_failures, format(
        'CHECK 3 (refusal is all-or-nothing): unit1 moved anyway, now at %s (want %s)', v_where, v_wh_b));
    END IF;
  END;

  -- ── CHECK 4: a system location cannot be a manual destination ──
  --   (units reach those through move_rma_units / promote_rma_unit only)
  v_check_count := v_check_count + 1;
  IF v_sys IS NULL THEN
    v_failures := array_append(v_failures, 'CHECK 4 (system destination refused): RMA-RECEIVED system warehouse not found');
  ELSE
    BEGIN
      PERFORM public.transfer_units(ARRAY[v_unit1], v_sys, v_mgr);
      v_failures := array_append(v_failures, 'CHECK 4 (system destination refused): was NOT refused');
    EXCEPTION WHEN OTHERS THEN
      NULL; -- expected
    END;
  END IF;

  -- ── CHECK 5: an archived destination is refused ──
  v_check_count := v_check_count + 1;
  BEGIN
    PERFORM public.transfer_units(ARRAY[v_unit1], v_wh_archived, v_mgr);
    v_failures := array_append(v_failures, 'CHECK 5 (archived destination refused): was NOT refused');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ── CHECK 6: an id that is not a unit is refused and writes nothing ──
  v_check_count := v_check_count + 1;
  BEGIN
    PERFORM public.transfer_units(ARRAY[v_unit1, gen_random_uuid()], v_wh_a, v_mgr);
    v_failures := array_append(v_failures, 'CHECK 6 (unknown unit id refused): was NOT refused');
  EXCEPTION WHEN OTHERS THEN
    SELECT warehouse_id INTO v_where FROM public.inventory_units WHERE id = v_unit1;
    IF v_where IS DISTINCT FROM v_wh_b THEN
      v_failures := array_append(v_failures, 'CHECK 6 (unknown id writes nothing): unit1 was moved anyway');
    END IF;
  END;

  -- ── CHECK 7: below manager is refused ──
  v_check_count := v_check_count + 1;
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_tech, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.transfer_units(ARRAY[v_unit1], v_wh_a, v_tech);
    v_failures := array_append(v_failures, 'CHECK 7 (technician refused): was NOT refused');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);

  -- ── CHECK 8: the actor on the ledger row is the signed-in user, not the
  --            string the caller passed ──
  v_check_count := v_check_count + 1;
  PERFORM public.transfer_units(ARRAY[v_unit1], v_wh_a, 'forged@example.com');
  SELECT actor_email INTO v_from FROM public.stock_moves
   WHERE ref_type = 'unit' AND ref_id = v_unit1 AND move_type = 'transfer'
   ORDER BY created_at DESC LIMIT 1;

  IF v_from IS DISTINCT FROM v_mgr THEN
    v_failures := array_append(v_failures, format(
      'CHECK 8 (actor from the JWT): ledger says %s, want %s', v_from, v_mgr));
  END IF;

  -- ══════════════════════ manufacturer batch ledger ════════════════════════

  -- ── CHECK 9: mark_batch_sent writes one row per unit, active_rma → sent ──
  v_check_count := v_check_count + 1;
  UPDATE public.inventory_units SET status = 'active_rma' WHERE id IN (v_unit1, v_unit2);
  v_batch := (public.create_manufacturer_batch(ARRAY[v_unit1, v_unit2], 'CI Test Manufacturer', v_mgr)).id;
  PERFORM public.mark_batch_sent(v_batch, now(), 'CI-TRACK-1');

  SELECT count(*) INTO v_rows FROM public.stock_moves
   WHERE doc_type = 'manufacturer_batch' AND doc_id = v_batch AND to_status = 'sent_to_manufacturer';
  SELECT status INTO v_status FROM public.inventory_units WHERE id = v_unit1;
  SELECT from_status INTO v_from FROM public.stock_moves
   WHERE doc_type = 'manufacturer_batch' AND doc_id = v_batch AND ref_id = v_unit1
     AND to_status = 'sent_to_manufacturer';

  IF v_rows <> 2 OR v_status IS DISTINCT FROM 'sent_to_manufacturer' OR v_from IS DISTINCT FROM 'active_rma' THEN
    v_failures := array_append(v_failures, format(
      'CHECK 9 (batch sent ledger): rows=%s (want 2), unit status=%s, from_status=%s (want active_rma)',
      v_rows, v_status, v_from));
  END IF;

  -- ── CHECK 10: mark_batch_resolved closes every unit — unchanged behaviour,
  --             now recorded — and writes one row per unit ──
  v_check_count := v_check_count + 1;
  PERFORM public.mark_batch_resolved(v_batch, 'replacement_received', now(), 'CI note');

  SELECT count(*) INTO v_rows FROM public.stock_moves
   WHERE doc_type = 'manufacturer_batch' AND doc_id = v_batch AND to_status = 'closed';
  SELECT count(*) INTO v_closed FROM public.inventory_units
   WHERE manufacturer_batch_id = v_batch AND status = 'closed';

  IF v_rows <> 2 OR v_closed <> 2 THEN
    v_failures := array_append(v_failures, format(
      'CHECK 10 (batch resolved ledger): rows=%s (want 2), closed units=%s (want 2)', v_rows, v_closed));
  END IF;

  -- ── Cleanup: hard-delete everything seeded, FK-safe order ──
  DELETE FROM public.stock_moves WHERE ref_type = 'unit' AND ref_id IN (
    SELECT id FROM public.inventory_units WHERE product_id = v_p1);
  UPDATE public.inventory_units SET manufacturer_batch_id = NULL WHERE manufacturer_batch_id = v_batch;
  DELETE FROM public.manufacturer_batches WHERE id = v_batch;
  DELETE FROM public.inventory_units WHERE product_id = v_p1;
  DELETE FROM public.warehouses WHERE id = ANY(ARRAY[v_wh_a, v_wh_b, v_wh_archived]);
  DELETE FROM public.products WHERE id = v_p1;

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % transfer-ledger check(s) FAILED:\n%',
      array_length(v_failures, 1), v_check_count, array_to_string(v_failures, E'\n');
  END IF;

  RAISE NOTICE 'All % transfer-ledger checks passed', v_check_count;
END $$;
