-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 8 Phase 8a — receive_stock (dual-mode)
--
--  Interim manual stock-entry path — Sprint 9's Purchase Module will
--  eventually replace this with vendor-invoice-driven receipt for both
--  modes. Branches by the product's stock_tracking_mode:
--    serialized → inserts one inventory_units row per call (one serial)
--    bulk       → upserts warehouse_stock.quantity for that product+warehouse
--
--  manager+ enforced server-side (rma_is_manager_or_above()), matching every
--  other write RPC in this sprint.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.receive_stock(
  p_product_id   uuid,
  p_warehouse_id uuid,
  p_actor_email  text,
  p_serial       text DEFAULT NULL,
  p_qty          integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tracking_mode text;
  v_product_name  text;
  v_unit_id       uuid;
  v_ws_id         uuid;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to receive stock' USING ERRCODE = 'P0001';
  END IF;

  SELECT stock_tracking_mode, product_name INTO v_tracking_mode, v_product_name
  FROM public.products WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id USING ERRCODE = 'P0001';
  END IF;

  IF v_tracking_mode = 'bulk' THEN
    IF p_qty IS NULL OR p_qty <= 0 THEN
      RAISE EXCEPTION 'A positive quantity is required to receive bulk stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT id INTO v_ws_id FROM public.warehouse_stock
    WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity)
      VALUES (p_product_id, p_warehouse_id, p_qty, 0)
      RETURNING id INTO v_ws_id;
    ELSE
      UPDATE public.warehouse_stock SET quantity = quantity + p_qty, updated_at = now() WHERE id = v_ws_id;
    END IF;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('warehouse_stock', v_ws_id, 'manual', NULL, 'receive', p_qty, NULL, 'available', p_actor_email);
  ELSE
    IF p_serial IS NULL OR btrim(p_serial) = '' THEN
      RAISE EXCEPTION 'A serial number is required to receive serialized stock' USING ERRCODE = 'P0001';
    END IF;

    BEGIN
      INSERT INTO public.inventory_units
        (product_id, product_name, serial_number, status, reservation_status, warehouse_id, created_date)
      VALUES
        (p_product_id, v_product_name, p_serial, 'company_stock', 'available', p_warehouse_id, now())
      RETURNING id INTO v_unit_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Serial number % is already in use', p_serial USING ERRCODE = 'P0001';
    END;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit_id, 'manual', NULL, 'receive', 1, NULL, 'available', p_actor_email);
  END IF;
END;
$$;
