-- ############################################################################
-- #  DB TEST TIER — inventory reservation hardening (extends HIGH-3 coverage)
-- #
-- #  Covers what audit_hardening.sql explicitly scoped out: "reserve→deliver→
-- #  release conserves quantity" and idempotency of the reservation RPCs.
-- #  The bulk-side checks directly answer the open question left in
-- #  20260741_warehouse_stock_reservation_rpcs.sql's own header comment:
-- #  "This makes release_warehouse_stock/deliver_warehouse_stock naturally
-- #  idempotent ... this must be verified explicitly in the gate tests, not
-- #  assumed." This file is that verification.
-- #
-- #  Same shape as audit_hardening.sql: RAISE EXCEPTION naming the specific
-- #  failing check on any failure, so `psql -v ON_ERROR_STOP=1` fails the CI
-- #  job cleanly. Run after audit_hardening.sql (independent — no shared state).
-- #
-- #  COVERAGE: reserve_units/deliver_units/release_units (serialized),
-- #  reserve/release/deliver_warehouse_stock (bulk), receive_stock (both
-- #  modes + duplicate-serial rejection). NOT covered: transfer_stock,
-- #  adjust_stock, recalculate_stock, receive_vendor_invoice, restore_units/
-- #  restore_warehouse_stock — a further increment, not attempted here.
-- ############################################################################

DO $$
DECLARE
  v_mgr        text := 'karim.nasser@test.com';  -- seeded by 20260706, role='manager'
  v_prod_ser   uuid;
  v_prod_bulk  uuid;
  v_wh         uuid;
  v_doc_id_1   uuid := gen_random_uuid();  -- stand-in "sales order" — doc_id/doc_type
  v_doc_id_2   uuid := gen_random_uuid();  -- are polymorphic, no FK to a real table
  v_avail      int;
  v_reserved   int;
  v_delivered  int;
  v_total      int;
  v_ws_id      uuid;
  v_qty        int;
  v_reserved_qty int;
  v_move_count_before int;
  v_move_count_after  int;
  v_failures   text[] := '{}';
  v_check_count int := 0;
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

  -- Throwaway fixtures. brand_id is nullable (ProductRow), so no brands
  -- dependency. sku carries a random suffix to avoid a uniqueness collision
  -- across repeat runs against a persistent (non-fresh) database.
  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode)
    VALUES ('CI-TEST-SER-' || floor(random() * 100000)::text, 'CI Test Serialized Product', 'hardware', 'active', 'serialized')
    RETURNING id INTO v_prod_ser;
  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode)
    VALUES ('CI-TEST-BULK-' || floor(random() * 100000)::text, 'CI Test Bulk Product', 'hardware', 'active', 'bulk')
    RETURNING id INTO v_prod_bulk;
  INSERT INTO public.warehouses (name) VALUES ('CI Test Warehouse') RETURNING id INTO v_wh;

  -- ══════════════════════════════════════════════════════════════════════
  -- SERIALIZED (inventory_units)
  -- ══════════════════════════════════════════════════════════════════════

  -- ── CHECK 1: receive_stock creates 3 available serialized units ──
  v_check_count := v_check_count + 1;
  PERFORM public.receive_stock(v_prod_ser, v_wh, v_mgr, 'CI-SER-A', NULL);
  PERFORM public.receive_stock(v_prod_ser, v_wh, v_mgr, 'CI-SER-B', NULL);
  PERFORM public.receive_stock(v_prod_ser, v_wh, v_mgr, 'CI-SER-C', NULL);

  SELECT COUNT(*) INTO v_avail FROM public.inventory_units
    WHERE product_id = v_prod_ser AND reservation_status = 'available' AND status <> 'closed';
  IF v_avail <> 3 THEN
    v_failures := array_append(v_failures,
      format('CHECK 1 (receive_stock serialized): expected 3 available units, got %s', v_avail));
  END IF;

  -- ── CHECK 2: duplicate serial rejected ──
  v_check_count := v_check_count + 1;
  BEGIN
    PERFORM public.receive_stock(v_prod_ser, v_wh, v_mgr, 'CI-SER-A', NULL);
    v_failures := array_append(v_failures, 'CHECK 2 (duplicate serial rejected): was NOT rejected');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ── CHECK 3: reserve_units reserves exactly 2, conservation holds ──
  v_check_count := v_check_count + 1;
  PERFORM public.reserve_units('sales_order', v_doc_id_1, v_prod_ser, 2, v_mgr);

  SELECT
    COUNT(*) FILTER (WHERE reservation_status = 'available'),
    COUNT(*) FILTER (WHERE reservation_status = 'reserved'),
    COUNT(*) FILTER (WHERE reservation_status = 'delivered'),
    COUNT(*)
  INTO v_avail, v_reserved, v_delivered, v_total
  FROM public.inventory_units
  WHERE product_id = v_prod_ser AND status <> 'closed';

  IF NOT (v_avail = 1 AND v_reserved = 2 AND v_delivered = 0 AND v_total = 3 AND v_avail + v_reserved + v_delivered = v_total) THEN
    v_failures := array_append(v_failures,
      format('CHECK 3 (reserve_units conservation): available=%s reserved=%s delivered=%s total=%s (expected 1/2/0/3, and available+reserved+delivered=total)',
             v_avail, v_reserved, v_delivered, v_total));
  END IF;

  -- ── CHECK 4: over-reservation rejected (only 1 available, asking for 5) ──
  v_check_count := v_check_count + 1;
  BEGIN
    PERFORM public.reserve_units('sales_order', v_doc_id_2, v_prod_ser, 5, v_mgr);
    v_failures := array_append(v_failures, 'CHECK 4 (over-reservation rejected): was NOT rejected');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ── CHECK 5: deliver_units moves the 2 reserved units to delivered ──
  v_check_count := v_check_count + 1;
  PERFORM public.deliver_units('sales_order', v_doc_id_1, v_mgr);

  SELECT
    COUNT(*) FILTER (WHERE reservation_status = 'available'),
    COUNT(*) FILTER (WHERE reservation_status = 'reserved'),
    COUNT(*) FILTER (WHERE reservation_status = 'delivered')
  INTO v_avail, v_reserved, v_delivered
  FROM public.inventory_units
  WHERE product_id = v_prod_ser AND status <> 'closed';

  IF NOT (v_avail = 1 AND v_reserved = 0 AND v_delivered = 2) THEN
    v_failures := array_append(v_failures,
      format('CHECK 5 (deliver_units): available=%s reserved=%s delivered=%s (expected 1/0/2)', v_avail, v_reserved, v_delivered));
  END IF;

  -- ── CHECK 6: release_units on an already-delivered doc is a safe no-op ──
  -- (nothing left in 'reserved' state for v_doc_id_1 — the FOR loop in
  -- release_units matches zero rows and does nothing, rather than erroring)
  v_check_count := v_check_count + 1;
  BEGIN
    PERFORM public.release_units('sales_order', v_doc_id_1, v_mgr);
    SELECT COUNT(*) INTO v_delivered FROM public.inventory_units
      WHERE product_id = v_prod_ser AND reservation_status = 'delivered' AND status <> 'closed';
    IF v_delivered <> 2 THEN
      v_failures := array_append(v_failures,
        format('CHECK 6 (release after deliver is a no-op): delivered count changed to %s (expected still 2)', v_delivered));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_failures := array_append(v_failures,
      format('CHECK 6 (release after deliver is a no-op): raised unexpectedly: %s', SQLERRM));
  END;

  -- ══════════════════════════════════════════════════════════════════════
  -- BULK (warehouse_stock) — idempotency is the explicit open question left
  -- in 20260741's own header comment; this section is that verification.
  -- ══════════════════════════════════════════════════════════════════════

  -- ── CHECK 7: receive_stock creates a warehouse_stock row with qty=20 ──
  v_check_count := v_check_count + 1;
  PERFORM public.receive_stock(v_prod_bulk, v_wh, v_mgr, NULL, 20);

  SELECT id, quantity, reserved_quantity INTO v_ws_id, v_qty, v_reserved_qty
    FROM public.warehouse_stock WHERE product_id = v_prod_bulk AND warehouse_id = v_wh;
  IF v_ws_id IS NULL OR v_qty <> 20 OR v_reserved_qty <> 0 THEN
    v_failures := array_append(v_failures,
      format('CHECK 7 (receive_stock bulk): quantity=%s reserved_quantity=%s (expected 20/0)', v_qty, v_reserved_qty));
  END IF;

  -- ── CHECK 8: reserve_warehouse_stock reserves 8, conservation holds ──
  v_check_count := v_check_count + 1;
  PERFORM public.reserve_warehouse_stock('sales_order', v_doc_id_1, v_prod_bulk, 8, v_mgr);
  SELECT quantity, reserved_quantity INTO v_qty, v_reserved_qty
    FROM public.warehouse_stock WHERE id = v_ws_id;
  IF NOT (v_qty = 20 AND v_reserved_qty = 8) THEN
    v_failures := array_append(v_failures,
      format('CHECK 8 (reserve_warehouse_stock): quantity=%s reserved_quantity=%s (expected 20/8)', v_qty, v_reserved_qty));
  END IF;

  -- ── CHECK 9: over-reservation rejected (12 available, asking for 15) ──
  v_check_count := v_check_count + 1;
  BEGIN
    PERFORM public.reserve_warehouse_stock('sales_order', v_doc_id_2, v_prod_bulk, 15, v_mgr);
    v_failures := array_append(v_failures, 'CHECK 9 (bulk over-reservation rejected): was NOT rejected');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ── CHECK 10: release_warehouse_stock returns the 8 units to available ──
  v_check_count := v_check_count + 1;
  PERFORM public.release_warehouse_stock('sales_order', v_doc_id_1, v_mgr);
  SELECT quantity, reserved_quantity INTO v_qty, v_reserved_qty
    FROM public.warehouse_stock WHERE id = v_ws_id;
  IF NOT (v_qty = 20 AND v_reserved_qty = 0) THEN
    v_failures := array_append(v_failures,
      format('CHECK 10 (release_warehouse_stock): quantity=%s reserved_quantity=%s (expected 20/0)', v_qty, v_reserved_qty));
  END IF;

  -- ── CHECK 11: calling release_warehouse_stock AGAIN is idempotent — the
  -- exact behavior 20260741's header comment says "must be verified
  -- explicitly, not assumed." A duplicate call must find nothing net-positive
  -- left (via the stock_moves ledger) and safely no-op: no negative
  -- reserved_quantity, no spurious extra 'release' stock_moves row.
  v_check_count := v_check_count + 1;
  SELECT COUNT(*) INTO v_move_count_before FROM public.stock_moves
    WHERE ref_type = 'warehouse_stock' AND doc_type = 'sales_order' AND doc_id = v_doc_id_1 AND move_type = 'release';
  PERFORM public.release_warehouse_stock('sales_order', v_doc_id_1, v_mgr);
  SELECT quantity, reserved_quantity INTO v_qty, v_reserved_qty
    FROM public.warehouse_stock WHERE id = v_ws_id;
  IF v_reserved_qty <> 0 OR v_qty <> 20 THEN
    v_failures := array_append(v_failures,
      format('CHECK 11 (release_warehouse_stock idempotent): second call changed state to quantity=%s reserved_quantity=%s (expected unchanged 20/0)',
             v_qty, v_reserved_qty));
  END IF;
  SELECT COUNT(*) INTO v_move_count_after FROM public.stock_moves
    WHERE ref_type = 'warehouse_stock' AND doc_type = 'sales_order' AND doc_id = v_doc_id_1 AND move_type = 'release';
  IF v_move_count_after <> v_move_count_before THEN
    v_failures := array_append(v_failures,
      format('CHECK 11 (release_warehouse_stock idempotent): second call inserted %s spurious extra stock_moves row(s)',
             v_move_count_after - v_move_count_before));
  END IF;

  -- ── CHECK 12: deliver_warehouse_stock decrements quantity, is also idempotent ──
  v_check_count := v_check_count + 1;
  PERFORM public.reserve_warehouse_stock('sales_order', v_doc_id_1, v_prod_bulk, 5, v_mgr);
  PERFORM public.deliver_warehouse_stock('sales_order', v_doc_id_1, v_mgr);
  SELECT quantity, reserved_quantity INTO v_qty, v_reserved_qty
    FROM public.warehouse_stock WHERE id = v_ws_id;
  IF NOT (v_qty = 15 AND v_reserved_qty = 0) THEN
    v_failures := array_append(v_failures,
      format('CHECK 12 (deliver_warehouse_stock): quantity=%s reserved_quantity=%s (expected 15/0)', v_qty, v_reserved_qty));
  END IF;

  PERFORM public.deliver_warehouse_stock('sales_order', v_doc_id_1, v_mgr);  -- duplicate call
  SELECT quantity, reserved_quantity INTO v_qty, v_reserved_qty
    FROM public.warehouse_stock WHERE id = v_ws_id;
  IF NOT (v_qty = 15 AND v_reserved_qty = 0) THEN
    v_failures := array_append(v_failures,
      format('CHECK 12b (deliver_warehouse_stock idempotent): duplicate call changed state to quantity=%s reserved_quantity=%s (expected unchanged 15/0)',
             v_qty, v_reserved_qty));
  END IF;

  -- ── Cleanup: hard-delete everything this run seeded ──
  DELETE FROM public.stock_moves WHERE ref_type = 'unit' AND ref_id IN (
    SELECT id FROM public.inventory_units WHERE product_id = v_prod_ser
  );
  DELETE FROM public.inventory_units WHERE product_id = v_prod_ser;
  DELETE FROM public.stock_moves WHERE ref_type = 'warehouse_stock' AND ref_id = v_ws_id;
  DELETE FROM public.warehouse_stock WHERE id = v_ws_id;
  DELETE FROM public.warehouses WHERE id = v_wh;
  DELETE FROM public.products WHERE id IN (v_prod_ser, v_prod_bulk);

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % inventory-hardening check(s) FAILED:\n%',
      array_length(v_failures, 1), v_check_count, array_to_string(v_failures, E'\n');
  END IF;

  RAISE NOTICE 'All % inventory-hardening checks passed', v_check_count;
END $$;
