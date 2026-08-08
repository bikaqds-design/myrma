-- ─── transfer_stock: refuse system locations ───────────────────────────────
--
-- Warehouse Module R1 (20260764) introduced 8 protected system locations and
-- established that units reach them ONLY through the RMA flow
-- (move_rma_units, promote_rma_unit, link_serial_to_rma_ticket).
--
-- public.transfer_stock predates all of that (20260744) and never learned the
-- rule, so a manual transfer could move sellable stock straight into SCRAP —
-- writing it off with no RMA ticket — or into RMA-RECEIVED, creating a unit
-- that shows on the Warehouse Dashboard as an RMA with a NULL rma_ticket_id.
-- Both corrupt the dashboard's RMA counts and Physical Total.
--
-- The UI hole was fixed alongside this (src/lib/warehouseDestinations.ts, used
-- by TransferStockModal / BulkStockActionModal / ReceiveStockModal). This is
-- the server-side backstop: a filtered dropdown is a convenience, not an
-- invariant — the RPC is callable directly.
--
-- Found in manual QA 2026-08-05, WAREHOUSE_R1_TEST_CHECKLIST.md §9.
--
-- Guards BOTH ends deliberately:
--   * destination — the actual defect;
--   * source      — moving stock OUT of an RMA location must go through
--                   promote_rma_unit, which enforces the sellable-destination
--                   and reservation rules transfer_stock does not.
--
-- transfer_stock's body below is byte-for-byte 20260744's, plus the two
-- PERFORM guards. It is restated in full rather than patched at runtime so the
-- change is reviewable as a diff.

CREATE OR REPLACE FUNCTION public.assert_not_system_warehouse(
  p_warehouse_id uuid,
  p_role         text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wh record;
BEGIN
  IF p_warehouse_id IS NULL THEN
    RETURN;
  END IF;

  SELECT name, is_system INTO v_wh
  FROM public.warehouses
  WHERE id = p_warehouse_id;

  IF FOUND AND v_wh.is_system THEN
    RAISE EXCEPTION
      '"%" is a protected system location and cannot be the % of a manual stock transfer — use the RMA workflow instead',
      v_wh.name, p_role
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.transfer_stock(
  p_product_id        uuid,
  p_from_warehouse_id uuid,
  p_to_warehouse_id   uuid,
  p_actor_email       text,
  p_unit_id           uuid DEFAULT NULL,
  p_qty               integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tracking_mode text;
  v_unit          record;
  v_src           record;
  v_dst_id        uuid;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to transfer stock' USING ERRCODE = 'P0001';
  END IF;

  -- ── NEW in 20260770 ──────────────────────────────────────────────────────
  PERFORM public.assert_not_system_warehouse(p_to_warehouse_id, 'destination');
  PERFORM public.assert_not_system_warehouse(p_from_warehouse_id, 'source');
  -- ─────────────────────────────────────────────────────────────────────────

  IF p_from_warehouse_id = p_to_warehouse_id THEN
    RAISE EXCEPTION 'Source and destination warehouse must differ' USING ERRCODE = 'P0001';
  END IF;

  SELECT stock_tracking_mode INTO v_tracking_mode FROM public.products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id USING ERRCODE = 'P0001';
  END IF;

  IF v_tracking_mode = 'bulk' THEN
    IF p_qty IS NULL OR p_qty <= 0 THEN
      RAISE EXCEPTION 'A positive quantity is required to transfer bulk stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_src FROM public.warehouse_stock
    WHERE product_id = p_product_id AND warehouse_id = p_from_warehouse_id
    FOR UPDATE;

    IF NOT FOUND OR (v_src.quantity - v_src.reserved_quantity) < p_qty THEN
      RAISE EXCEPTION 'Insufficient available stock at source warehouse: need %, only % available',
        p_qty, COALESCE(v_src.quantity - v_src.reserved_quantity, 0)
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.warehouse_stock SET quantity = quantity - p_qty, updated_at = now() WHERE id = v_src.id;

    SELECT id INTO v_dst_id FROM public.warehouse_stock
    WHERE product_id = p_product_id AND warehouse_id = p_to_warehouse_id
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity)
      VALUES (p_product_id, p_to_warehouse_id, p_qty, 0)
      RETURNING id INTO v_dst_id;
    ELSE
      UPDATE public.warehouse_stock SET quantity = quantity + p_qty, updated_at = now() WHERE id = v_dst_id;
    END IF;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('warehouse_stock', v_src.id, 'manual', NULL, 'transfer', p_qty, p_from_warehouse_id::text, p_to_warehouse_id::text, p_actor_email),
      ('warehouse_stock', v_dst_id, 'manual', NULL, 'transfer', p_qty, p_from_warehouse_id::text, p_to_warehouse_id::text, p_actor_email);
  ELSE
    IF p_unit_id IS NULL THEN
      RAISE EXCEPTION 'A unit id is required to transfer serialized stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_unit FROM public.inventory_units WHERE id = p_unit_id FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unit % not found', p_unit_id USING ERRCODE = 'P0001';
    END IF;

    IF v_unit.reservation_status != 'available' THEN
      RAISE EXCEPTION 'Cannot transfer unit % — it is currently %, not available',
        p_unit_id, v_unit.reservation_status
        USING ERRCODE = 'P0001';
    END IF;

    IF v_unit.warehouse_id IS DISTINCT FROM p_from_warehouse_id THEN
      RAISE EXCEPTION 'Unit % is not currently in the specified source warehouse', p_unit_id
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.inventory_units SET warehouse_id = p_to_warehouse_id WHERE id = p_unit_id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', p_unit_id, 'manual', NULL, 'transfer', 1, p_from_warehouse_id::text, p_to_warehouse_id::text, p_actor_email);
  END IF;
END;
$$;

-- ── EXECUTE lockdown (same posture as every other client RPC, 20260752) ─────

DO $$
DECLARE
  v_sig text;
BEGIN
  FOR v_sig IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('assert_not_system_warehouse', 'transfer_stock')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
  END LOOP;
END;
$$;
