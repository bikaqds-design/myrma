-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 8 Phase 8a — adjust_stock, archive_warehouse, recalculate_stock
--
--  Three standalone, lower-complexity RPCs with no interdependencies on
--  each other. All manager+ enforced server-side.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── adjust_stock: manual correction, dual-mode ───────────────────────────────
-- serialized → change a unit's physical status (found/missing/damaged/etc.,
--   constrained by chk_inventory_status — an invalid value is rejected by
--   that existing CHECK, no extra validation needed here).
-- bulk → apply a signed quantity delta to warehouse_stock.quantity.

CREATE OR REPLACE FUNCTION public.adjust_stock(
  p_product_id   uuid,
  p_warehouse_id uuid,
  p_actor_email  text,
  p_unit_id      uuid DEFAULT NULL,
  p_new_status   text DEFAULT NULL,
  p_qty_delta    integer DEFAULT NULL,
  p_reason       text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tracking_mode text;
  v_old_status    text;
  v_ws_id         uuid;
  v_old_qty       integer;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to adjust stock' USING ERRCODE = 'P0001';
  END IF;

  SELECT stock_tracking_mode INTO v_tracking_mode FROM public.products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id USING ERRCODE = 'P0001';
  END IF;

  IF v_tracking_mode = 'bulk' THEN
    IF p_qty_delta IS NULL OR p_qty_delta = 0 THEN
      RAISE EXCEPTION 'A non-zero quantity delta is required to adjust bulk stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT id, quantity INTO v_ws_id, v_old_qty FROM public.warehouse_stock
    WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
    FOR UPDATE;

    IF NOT FOUND THEN
      IF p_qty_delta < 0 THEN
        RAISE EXCEPTION 'No stock exists at this warehouse to reduce' USING ERRCODE = 'P0001';
      END IF;
      INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity)
      VALUES (p_product_id, p_warehouse_id, p_qty_delta, 0)
      RETURNING id INTO v_ws_id;
      v_old_qty := 0;
    ELSE
      IF v_old_qty + p_qty_delta < 0 THEN
        RAISE EXCEPTION 'Adjustment would take quantity negative (current %, delta %)', v_old_qty, p_qty_delta
          USING ERRCODE = 'P0001';
      END IF;
      UPDATE public.warehouse_stock SET quantity = quantity + p_qty_delta, updated_at = now() WHERE id = v_ws_id;
    END IF;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('warehouse_stock', v_ws_id, 'manual', NULL, 'adjust', abs(p_qty_delta),
       v_old_qty::text, (v_old_qty + p_qty_delta)::text, p_actor_email);
  ELSE
    IF p_unit_id IS NULL OR p_new_status IS NULL THEN
      RAISE EXCEPTION 'A unit id and new status are required to adjust serialized stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT status INTO v_old_status FROM public.inventory_units WHERE id = p_unit_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unit % not found', p_unit_id USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.inventory_units SET status = p_new_status, notes = COALESCE(p_reason, notes) WHERE id = p_unit_id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', p_unit_id, 'manual', NULL, 'adjust', 1, v_old_status, p_new_status, p_actor_email);
  END IF;
END;
$$;

-- ── archive_warehouse: soft-delete guard ──────────────────────────────────────
-- Blocks if any live stock still references this warehouse — serialized
-- units not already 'closed', or bulk quantity > 0.

CREATE OR REPLACE FUNCTION public.archive_warehouse(
  p_warehouse_id uuid,
  p_actor_email  text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit_count  integer;
  v_stock_count integer;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to archive a warehouse' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*) INTO v_unit_count
  FROM public.inventory_units
  WHERE warehouse_id = p_warehouse_id AND status <> 'closed';

  SELECT COUNT(*) INTO v_stock_count
  FROM public.warehouse_stock
  WHERE warehouse_id = p_warehouse_id AND quantity > 0;

  IF v_unit_count > 0 OR v_stock_count > 0 THEN
    RAISE EXCEPTION 'Cannot archive warehouse: % live serialized unit(s) and % bulk-stock product(s) still present',
      v_unit_count, v_stock_count
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.warehouses SET is_active = false WHERE id = p_warehouse_id;
END;
$$;

-- ── recalculate_stock: reconciliation tool — bulk only, reserved_quantity only ──
-- Serialized availability is always a live COUNT(*), nothing to drift.
-- Deliberately does NOT replay `quantity` from the full stock_moves history
-- (a transfer touches two warehouse_stock rows and a fragile full-ledger
-- replay is not worth the risk for a manual, low-frequency admin tool).
-- Only recomputes reserved_quantity, using the exact same net-reserved
-- query already proven correct in release/deliver_warehouse_stock above —
-- reserved_quantity is the counter most likely to drift given the
-- multi-document, multi-warehouse splitting logic; quantity itself is a
-- directly-managed counter (receive/adjust) with no such risk.

CREATE OR REPLACE FUNCTION public.recalculate_stock(
  p_product_id   uuid,
  p_warehouse_id uuid,
  p_actor_email  text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ws_id             uuid;
  v_computed_reserved integer;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to recalculate stock' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_ws_id FROM public.warehouse_stock
  WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No warehouse_stock row for this product/warehouse' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(SUM(
    CASE WHEN move_type = 'reserve' THEN qty
         WHEN move_type IN ('release', 'deliver') THEN -qty
         ELSE 0 END), 0)
  INTO v_computed_reserved
  FROM public.stock_moves
  WHERE ref_type = 'warehouse_stock' AND ref_id = v_ws_id;

  UPDATE public.warehouse_stock
  SET reserved_quantity = GREATEST(v_computed_reserved, 0), updated_at = now()
  WHERE id = v_ws_id;
END;
$$;
