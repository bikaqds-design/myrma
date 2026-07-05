-- ############################################################################
-- #  DB TEST TIER — inventory RPC hardening, part 2 (completes HIGH-3)
-- #
-- #  Covers the inventory/purchasing RPCs left uncovered by
-- #  inventory_hardening.sql: transfer_stock, adjust_stock, recalculate_stock,
-- #  restore_units, restore_warehouse_stock, receive_vendor_invoice — both
-- #  serialized and bulk modes, happy paths plus the key guards each enforces.
-- #
-- #  Same shape as the other two test files: RAISE EXCEPTION naming the
-- #  specific failing check, so `psql -v ON_ERROR_STOP=1` fails the CI job
-- #  cleanly. Independent of the other files (its own throwaway fixtures).
-- #
-- #  BUG FOUND AND FIXED while writing this file (2026-07-02, migration
-- #  20260755_fix_restore_units_status_conflation.sql): restore_units(...,
-- #  p_to_status => 'active_rma') used to set reservation_status =
-- #  'active_rma' directly from the parameter — but reservation_status has
-- #  CHECK (reservation_status IN ('available','reserved','delivered')), so
-- #  that call raised a constraint violation. It conflated the two status
-- #  axes CLAUDE.md says must never be conflated (status = physical/RMA
-- #  lifecycle, reservation_status = funnel state). Masked in production
-- #  because creditNotes.restoreUnits() only ever passed 'available'. Fixed
-- #  to always resolve reservation_status to 'available' regardless of which
-- #  physical status the unit returns to. CHECK 9b below tests the
-- #  previously-broken 'active_rma' path directly.
-- ############################################################################

DO $$
DECLARE
  v_mgr        text := 'karim.nasser@test.com';  -- seeded by 20260706, role='manager'
  v_vendor     uuid;
  -- products (dedicated per concern so each check's expected values are trivial)
  v_p_tr_ser   uuid;  v_p_tr_bulk  uuid;
  v_p_adj_ser  uuid;  v_p_adj_bulk uuid;
  v_p_recalc   uuid;
  v_p_rst_ser  uuid;  v_p_rst_bulk uuid;
  v_p_vi_bulk  uuid;  v_p_vi_ser   uuid;
  v_p_po_sync  uuid;
  v_wh1        uuid;  v_wh2        uuid;
  v_vi_bulk    uuid;  v_vi_ser     uuid;  v_vi_dup uuid;
  v_po_sync    uuid;  v_vi_po_sync uuid;  v_po_status text;
  -- work vars
  v_unit       uuid;
  v_reserved_unit uuid;
  v_from_wh    uuid;  v_to_wh      uuid;
  v_rst_unit   uuid;
  v_wh_check   uuid;
  v_qty_src    int;   v_qty_dst    int;
  v_qty        int;   v_reserved_qty int;
  v_status     text;
  v_res        text;
  v_code1      text;  v_code2      text;
  v_cnt        int;
  v_doc_rsv    uuid := gen_random_uuid();
  v_doc_recalc uuid := gen_random_uuid();
  v_doc_rst    uuid := gen_random_uuid();
  v_doc_rst2   uuid := gen_random_uuid();
  v_doc_rst3   uuid := gen_random_uuid();
  v_doc_rstw   uuid := gen_random_uuid();
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

  -- Throwaway fixtures. brand_id nullable → no brands dependency. Random sku
  -- suffix avoids a uniqueness collision on a persistent (non-fresh) DB.
  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode) VALUES
    ('CI-INV2-TRSER-'  || floor(random()*100000)::text, 'CI transfer serialized',  'hardware', 'active', 'serialized') RETURNING id INTO v_p_tr_ser;
  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode) VALUES
    ('CI-INV2-TRBLK-'  || floor(random()*100000)::text, 'CI transfer bulk',        'hardware', 'active', 'bulk')       RETURNING id INTO v_p_tr_bulk;
  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode) VALUES
    ('CI-INV2-ADSER-'  || floor(random()*100000)::text, 'CI adjust serialized',    'hardware', 'active', 'serialized') RETURNING id INTO v_p_adj_ser;
  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode) VALUES
    ('CI-INV2-ADBLK-'  || floor(random()*100000)::text, 'CI adjust bulk',          'hardware', 'active', 'bulk')       RETURNING id INTO v_p_adj_bulk;
  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode) VALUES
    ('CI-INV2-RECAL-'  || floor(random()*100000)::text, 'CI recalculate bulk',     'hardware', 'active', 'bulk')       RETURNING id INTO v_p_recalc;
  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode) VALUES
    ('CI-INV2-RSSER-'  || floor(random()*100000)::text, 'CI restore serialized',   'hardware', 'active', 'serialized') RETURNING id INTO v_p_rst_ser;
  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode) VALUES
    ('CI-INV2-RSBLK-'  || floor(random()*100000)::text, 'CI restore bulk',         'hardware', 'active', 'bulk')       RETURNING id INTO v_p_rst_bulk;
  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode) VALUES
    ('CI-INV2-VIBLK-'  || floor(random()*100000)::text, 'CI vendor-invoice bulk',  'hardware', 'active', 'bulk')       RETURNING id INTO v_p_vi_bulk;
  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode) VALUES
    ('CI-INV2-VISER-'  || floor(random()*100000)::text, 'CI vendor-invoice ser',   'hardware', 'active', 'serialized') RETURNING id INTO v_p_vi_ser;
  INSERT INTO public.products (sku, product_name, product_type, status, stock_tracking_mode) VALUES
    ('CI-INV2-POSYNC-' || floor(random()*100000)::text, 'CI PO-completion sync',   'hardware', 'active', 'bulk')       RETURNING id INTO v_p_po_sync;

  INSERT INTO public.warehouses (name) VALUES ('CI Test WH1') RETURNING id INTO v_wh1;
  INSERT INTO public.warehouses (name) VALUES ('CI Test WH2') RETURNING id INTO v_wh2;
  -- Brands ARE the vendors in the redesigned Purchasing module (no more
  -- standalone `vendors` table) — see 20260756/20260757.
  INSERT INTO public.brands (brand_name) VALUES ('CI Test Brand') RETURNING id INTO v_vendor;

  -- ══════════════════════════ transfer_stock ══════════════════════════════

  -- ── CHECK 1: transfer serialized moves a unit between warehouses ──
  v_check_count := v_check_count + 1;
  PERFORM public.receive_stock(v_p_tr_ser, v_wh1, v_mgr, 'CI-INV2-TRS-1', NULL);
  PERFORM public.receive_stock(v_p_tr_ser, v_wh1, v_mgr, 'CI-INV2-TRS-2', NULL);
  SELECT id INTO v_unit FROM public.inventory_units
    WHERE product_id = v_p_tr_ser AND serial_number = 'CI-INV2-TRS-1';
  PERFORM public.transfer_stock(v_p_tr_ser, v_wh1, v_wh2, v_mgr, v_unit, NULL);
  SELECT warehouse_id INTO v_wh_check FROM public.inventory_units WHERE id = v_unit;
  IF v_wh_check IS DISTINCT FROM v_wh2 THEN
    v_failures := array_append(v_failures,
      format('CHECK 1 (transfer serialized): unit warehouse_id did not move to WH2 (got %s)', v_wh_check));
  END IF;

  -- ── CHECK 2: transferring a RESERVED serialized unit is blocked ──
  v_check_count := v_check_count + 1;
  PERFORM public.reserve_units('sales_order', v_doc_rsv, v_p_tr_ser, 1, v_mgr);
  SELECT id, warehouse_id INTO v_reserved_unit, v_from_wh FROM public.inventory_units
    WHERE product_id = v_p_tr_ser AND reservation_status = 'reserved' LIMIT 1;
  v_to_wh := CASE WHEN v_from_wh = v_wh1 THEN v_wh2 ELSE v_wh1 END;
  BEGIN
    PERFORM public.transfer_stock(v_p_tr_ser, v_from_wh, v_to_wh, v_mgr, v_reserved_unit, NULL);
    v_failures := array_append(v_failures, 'CHECK 2 (transfer of reserved unit blocked): was NOT blocked');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ── CHECK 3: transfer bulk moves qty from source to destination ──
  v_check_count := v_check_count + 1;
  PERFORM public.receive_stock(v_p_tr_bulk, v_wh1, v_mgr, NULL, 20);
  PERFORM public.transfer_stock(v_p_tr_bulk, v_wh1, v_wh2, v_mgr, NULL, 8);
  SELECT quantity INTO v_qty_src FROM public.warehouse_stock WHERE product_id = v_p_tr_bulk AND warehouse_id = v_wh1;
  SELECT quantity INTO v_qty_dst FROM public.warehouse_stock WHERE product_id = v_p_tr_bulk AND warehouse_id = v_wh2;
  IF NOT (v_qty_src = 12 AND v_qty_dst = 8) THEN
    v_failures := array_append(v_failures,
      format('CHECK 3 (transfer bulk): source qty=%s dest qty=%s (expected 12/8)', v_qty_src, v_qty_dst));
  END IF;

  -- ── CHECK 4: transferring more bulk than available at source is rejected ──
  v_check_count := v_check_count + 1;
  BEGIN
    PERFORM public.transfer_stock(v_p_tr_bulk, v_wh1, v_wh2, v_mgr, NULL, 999);
    v_failures := array_append(v_failures, 'CHECK 4 (transfer bulk insufficient): was NOT rejected');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ══════════════════════════ adjust_stock ════════════════════════════════

  -- ── CHECK 5: adjust serialized changes a unit's physical status ──
  v_check_count := v_check_count + 1;
  PERFORM public.receive_stock(v_p_adj_ser, v_wh1, v_mgr, 'CI-INV2-ADJ-1', NULL);
  SELECT id INTO v_unit FROM public.inventory_units WHERE product_id = v_p_adj_ser AND serial_number = 'CI-INV2-ADJ-1';
  PERFORM public.adjust_stock(v_p_adj_ser, v_wh1, v_mgr, v_unit, 'sent_to_manufacturer', NULL, 'CI test adjust');
  SELECT status INTO v_status FROM public.inventory_units WHERE id = v_unit;
  IF v_status IS DISTINCT FROM 'sent_to_manufacturer' THEN
    v_failures := array_append(v_failures,
      format('CHECK 5 (adjust serialized status): status=%s (expected sent_to_manufacturer)', v_status));
  END IF;

  -- ── CHECK 6: adjust bulk applies a signed quantity delta (+5 then -3) ──
  v_check_count := v_check_count + 1;
  PERFORM public.receive_stock(v_p_adj_bulk, v_wh1, v_mgr, NULL, 10);
  PERFORM public.adjust_stock(v_p_adj_bulk, v_wh1, v_mgr, NULL, NULL, 5, NULL);
  PERFORM public.adjust_stock(v_p_adj_bulk, v_wh1, v_mgr, NULL, NULL, -3, NULL);
  SELECT quantity INTO v_qty FROM public.warehouse_stock WHERE product_id = v_p_adj_bulk AND warehouse_id = v_wh1;
  IF v_qty <> 12 THEN
    v_failures := array_append(v_failures,
      format('CHECK 6 (adjust bulk delta): quantity=%s (expected 12 = 10 + 5 - 3)', v_qty));
  END IF;

  -- ── CHECK 7: adjust bulk that would go negative is rejected ──
  v_check_count := v_check_count + 1;
  BEGIN
    PERFORM public.adjust_stock(v_p_adj_bulk, v_wh1, v_mgr, NULL, NULL, -999, NULL);
    v_failures := array_append(v_failures, 'CHECK 7 (adjust bulk negative guard): was NOT rejected');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ══════════════════════════ recalculate_stock ═══════════════════════════

  -- ── CHECK 8: recalculate_stock reconciles a drifted reserved_quantity ──
  -- Reserve 8 (ledger records net 8), then corrupt reserved_quantity to 15
  -- (a wrong but constraint-valid value ≤ quantity), then recalc → back to 8.
  v_check_count := v_check_count + 1;
  PERFORM public.receive_stock(v_p_recalc, v_wh1, v_mgr, NULL, 20);
  PERFORM public.reserve_warehouse_stock('sales_order', v_doc_recalc, v_p_recalc, 8, v_mgr);
  UPDATE public.warehouse_stock SET reserved_quantity = 15
    WHERE product_id = v_p_recalc AND warehouse_id = v_wh1;
  PERFORM public.recalculate_stock(v_p_recalc, v_wh1, v_mgr);
  SELECT reserved_quantity INTO v_reserved_qty FROM public.warehouse_stock
    WHERE product_id = v_p_recalc AND warehouse_id = v_wh1;
  IF v_reserved_qty <> 8 THEN
    v_failures := array_append(v_failures,
      format('CHECK 8 (recalculate_stock): reserved_quantity=%s after recalc (expected 8, the net from the ledger)', v_reserved_qty));
  END IF;

  -- ══════════════════════════ restore_units (available path) ══════════════

  -- ── CHECK 9: restore_units brings a delivered unit back to available ──
  v_check_count := v_check_count + 1;
  PERFORM public.receive_stock(v_p_rst_ser, v_wh1, v_mgr, 'CI-INV2-RST-1', NULL);
  PERFORM public.reserve_units('sales_order', v_doc_rst, v_p_rst_ser, 1, v_mgr);
  PERFORM public.deliver_units('sales_order', v_doc_rst, v_mgr);
  SELECT id INTO v_rst_unit FROM public.inventory_units
    WHERE product_id = v_p_rst_ser AND reservation_status = 'delivered' LIMIT 1;
  PERFORM public.restore_units(ARRAY[v_rst_unit], 'credit_note', v_doc_rst2, v_mgr, 'available');
  SELECT reservation_status INTO v_res FROM public.inventory_units WHERE id = v_rst_unit;
  IF v_res IS DISTINCT FROM 'available' THEN
    v_failures := array_append(v_failures,
      format('CHECK 9 (restore_units available): reservation_status=%s (expected available)', v_res));
  END IF;

  -- ── CHECK 9b: restore_units(p_to_status='active_rma') — the damaged/
  -- scrapped-return path that was broken before 20260755. Must set
  -- status='active_rma' (physical axis) while reservation_status stays
  -- 'available' (funnel axis) — never reservation_status='active_rma',
  -- which would violate its own CHECK constraint.
  v_check_count := v_check_count + 1;
  PERFORM public.receive_stock(v_p_rst_ser, v_wh1, v_mgr, 'CI-INV2-RST-2', NULL);
  PERFORM public.reserve_units('sales_order', v_doc_rst3, v_p_rst_ser, 1, v_mgr);
  PERFORM public.deliver_units('sales_order', v_doc_rst3, v_mgr);
  SELECT id INTO v_rst_unit FROM public.inventory_units
    WHERE product_id = v_p_rst_ser AND serial_number = 'CI-INV2-RST-2';
  PERFORM public.restore_units(ARRAY[v_rst_unit], 'credit_note', v_doc_rst2, v_mgr, 'active_rma');
  SELECT reservation_status, status INTO v_res, v_status FROM public.inventory_units WHERE id = v_rst_unit;
  IF NOT (v_res = 'available' AND v_status = 'active_rma') THEN
    v_failures := array_append(v_failures,
      format('CHECK 9b (restore_units active_rma): reservation_status=%s status=%s (expected available/active_rma)', v_res, v_status));
  END IF;

  -- ══════════════════════════ restore_warehouse_stock ═════════════════════

  -- ── CHECK 10: restore_warehouse_stock adds restocked qty (creates row) ──
  v_check_count := v_check_count + 1;
  PERFORM public.restore_warehouse_stock(v_p_rst_bulk, v_wh1, 5, 'credit_note', v_doc_rstw, v_mgr);
  SELECT quantity INTO v_qty FROM public.warehouse_stock WHERE product_id = v_p_rst_bulk AND warehouse_id = v_wh1;
  IF v_qty IS DISTINCT FROM 5 THEN
    v_failures := array_append(v_failures,
      format('CHECK 10 (restore_warehouse_stock): quantity=%s (expected 5)', v_qty));
  END IF;

  -- ══════════════════════════ receive_vendor_invoice ══════════════════════

  -- ── CHECK 11: receive_vendor_invoice bulk — full receipt, code assigned ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.vendor_invoices (vendor_id, status, line_items, total, created_by)
  VALUES (
    v_vendor, 'approved',
    jsonb_build_array(jsonb_build_object('product_id', v_p_vi_bulk::text, 'qty_ordered', 10, 'qty_received', 0)),
    0, v_mgr
  ) RETURNING id INTO v_vi_bulk;

  PERFORM public.receive_vendor_invoice(
    v_vi_bulk,
    jsonb_build_array(jsonb_build_object('product_id', v_p_vi_bulk::text, 'warehouse_id', v_wh1::text, 'qty', 10)),
    v_mgr
  );
  SELECT quantity INTO v_qty FROM public.warehouse_stock WHERE product_id = v_p_vi_bulk AND warehouse_id = v_wh1;
  SELECT status, vi_code INTO v_status, v_code1 FROM public.vendor_invoices WHERE id = v_vi_bulk;
  IF NOT (v_qty = 10 AND v_status = 'received' AND v_code1 IS NOT NULL) THEN
    v_failures := array_append(v_failures,
      format('CHECK 11 (receive_vendor_invoice bulk): quantity=%s status=%s vi_code=%s (expected 10/received/non-null)',
             v_qty, v_status, COALESCE(v_code1, 'NULL')));
  END IF;

  -- ── CHECK 12: receive_vendor_invoice serialized, partial then complete ──
  -- 3 ordered; receive 2 → partially_received (code assigned); receive 1 more
  -- → received, same code (code assigned only on first receipt).
  v_check_count := v_check_count + 1;
  INSERT INTO public.vendor_invoices (vendor_id, status, line_items, total, created_by)
  VALUES (
    v_vendor, 'approved',
    jsonb_build_array(jsonb_build_object('product_id', v_p_vi_ser::text, 'qty_ordered', 3, 'qty_received', 0)),
    0, v_mgr
  ) RETURNING id INTO v_vi_ser;

  PERFORM public.receive_vendor_invoice(
    v_vi_ser,
    jsonb_build_array(jsonb_build_object('product_id', v_p_vi_ser::text, 'warehouse_id', v_wh1::text,
                                         'serials', jsonb_build_array('CI-INV2-VIS-1', 'CI-INV2-VIS-2'))),
    v_mgr
  );
  SELECT status, vi_code INTO v_status, v_code1 FROM public.vendor_invoices WHERE id = v_vi_ser;

  PERFORM public.receive_vendor_invoice(
    v_vi_ser,
    jsonb_build_array(jsonb_build_object('product_id', v_p_vi_ser::text, 'warehouse_id', v_wh1::text,
                                         'serials', jsonb_build_array('CI-INV2-VIS-3'))),
    v_mgr
  );
  SELECT status, vi_code INTO v_res, v_code2 FROM public.vendor_invoices WHERE id = v_vi_ser;
  SELECT COUNT(*) INTO v_cnt FROM public.inventory_units WHERE product_id = v_p_vi_ser;

  IF NOT (v_status = 'partially_received' AND v_code1 IS NOT NULL
          AND v_res = 'received' AND v_code2 = v_code1 AND v_cnt = 3) THEN
    v_failures := array_append(v_failures,
      format('CHECK 12 (receive_vendor_invoice serialized partial): after-2 status=%s code=%s; after-3 status=%s code=%s units=%s (expected partially_received / code / received / same-code / 3)',
             v_status, COALESCE(v_code1,'NULL'), v_res, COALESCE(v_code2,'NULL'), v_cnt));
  END IF;

  -- ── CHECK 13: receiving a serial that is already a live unit is rejected ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.vendor_invoices (vendor_id, status, line_items, total, created_by)
  VALUES (
    v_vendor, 'approved',
    jsonb_build_array(jsonb_build_object('product_id', v_p_vi_ser::text, 'qty_ordered', 1, 'qty_received', 0)),
    0, v_mgr
  ) RETURNING id INTO v_vi_dup;
  BEGIN
    PERFORM public.receive_vendor_invoice(
      v_vi_dup,
      jsonb_build_array(jsonb_build_object('product_id', v_p_vi_ser::text, 'warehouse_id', v_wh1::text,
                                           'serials', jsonb_build_array('CI-INV2-VIS-1'))),  -- already received in CHECK 12
      v_mgr
    );
    v_failures := array_append(v_failures, 'CHECK 13 (receive_vendor_invoice duplicate serial): was NOT rejected');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ══════════════════ receive_vendor_invoice → PO completion sync ═════════
  -- New in the Purchasing redesign (20260758): receiving a VI linked to a PO
  -- must sync the PO's own status to partially_completed/completed.

  -- ── CHECK 14: partial receipt → PO 'partially_completed'; full → 'completed' ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.purchase_orders (po_code, vendor_id, status, line_items, total, created_by)
  VALUES (
    'CI-PO-SYNC-' || floor(random()*100000)::text, v_vendor, 'confirmed',
    jsonb_build_array(jsonb_build_object('product_id', v_p_po_sync::text, 'qty_ordered', 10, 'qty_received', 0)),
    0, v_mgr
  ) RETURNING id INTO v_po_sync;

  INSERT INTO public.vendor_invoices (vendor_id, purchase_order_id, status, line_items, total, created_by)
  VALUES (
    v_vendor, v_po_sync, 'approved',
    jsonb_build_array(jsonb_build_object('product_id', v_p_po_sync::text, 'qty_ordered', 10, 'qty_received', 0)),
    0, v_mgr
  ) RETURNING id INTO v_vi_po_sync;

  PERFORM public.receive_vendor_invoice(
    v_vi_po_sync,
    jsonb_build_array(jsonb_build_object('product_id', v_p_po_sync::text, 'warehouse_id', v_wh1::text, 'qty', 4)),
    v_mgr
  );
  SELECT status INTO v_po_status FROM public.purchase_orders WHERE id = v_po_sync;
  IF v_po_status IS DISTINCT FROM 'partially_completed' THEN
    v_failures := array_append(v_failures,
      format('CHECK 14a (PO completion sync, partial): PO status=%s (expected partially_completed)', v_po_status));
  END IF;

  PERFORM public.receive_vendor_invoice(
    v_vi_po_sync,
    jsonb_build_array(jsonb_build_object('product_id', v_p_po_sync::text, 'warehouse_id', v_wh1::text, 'qty', 6)),
    v_mgr
  );
  SELECT status INTO v_po_status FROM public.purchase_orders WHERE id = v_po_sync;
  IF v_po_status IS DISTINCT FROM 'completed' THEN
    v_failures := array_append(v_failures,
      format('CHECK 14b (PO completion sync, full): PO status=%s (expected completed)', v_po_status));
  END IF;

  -- ── Cleanup: hard-delete everything seeded, FK-safe order ──
  -- inventory_units.vendor_invoice_id → vendor_invoices has no ON DELETE, so
  -- units MUST be deleted before their vendor_invoices.
  DELETE FROM public.stock_moves WHERE ref_type = 'unit' AND ref_id IN (
    SELECT id FROM public.inventory_units WHERE product_id = ANY(ARRAY[
      v_p_tr_ser, v_p_tr_bulk, v_p_adj_ser, v_p_adj_bulk, v_p_recalc,
      v_p_rst_ser, v_p_rst_bulk, v_p_vi_bulk, v_p_vi_ser, v_p_po_sync]));
  DELETE FROM public.stock_moves WHERE ref_type = 'warehouse_stock' AND ref_id IN (
    SELECT id FROM public.warehouse_stock WHERE product_id = ANY(ARRAY[
      v_p_tr_ser, v_p_tr_bulk, v_p_adj_ser, v_p_adj_bulk, v_p_recalc,
      v_p_rst_ser, v_p_rst_bulk, v_p_vi_bulk, v_p_vi_ser, v_p_po_sync]));
  DELETE FROM public.inventory_units WHERE product_id = ANY(ARRAY[
    v_p_tr_ser, v_p_tr_bulk, v_p_adj_ser, v_p_adj_bulk, v_p_recalc,
    v_p_rst_ser, v_p_rst_bulk, v_p_vi_bulk, v_p_vi_ser, v_p_po_sync]);
  DELETE FROM public.warehouse_stock WHERE product_id = ANY(ARRAY[
    v_p_tr_ser, v_p_tr_bulk, v_p_adj_ser, v_p_adj_bulk, v_p_recalc,
    v_p_rst_ser, v_p_rst_bulk, v_p_vi_bulk, v_p_vi_ser, v_p_po_sync]);
  DELETE FROM public.vendor_invoices WHERE id = ANY(ARRAY[v_vi_bulk, v_vi_ser, v_vi_dup, v_vi_po_sync]);
  DELETE FROM public.purchase_orders WHERE id = v_po_sync;
  -- Brands ARE the vendors now — delete the throwaway brand, not a `vendors` row.
  DELETE FROM public.brands WHERE id = v_vendor;
  DELETE FROM public.warehouses WHERE id = ANY(ARRAY[v_wh1, v_wh2]);
  DELETE FROM public.products WHERE id = ANY(ARRAY[
    v_p_tr_ser, v_p_tr_bulk, v_p_adj_ser, v_p_adj_bulk, v_p_recalc,
    v_p_rst_ser, v_p_rst_bulk, v_p_vi_bulk, v_p_vi_ser, v_p_po_sync]);

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % inventory-RPC-hardening check(s) FAILED:\n%',
      array_length(v_failures, 1), v_check_count, array_to_string(v_failures, E'\n');
  END IF;

  RAISE NOTICE 'All % inventory-RPC-hardening checks passed', v_check_count;
END $$;
