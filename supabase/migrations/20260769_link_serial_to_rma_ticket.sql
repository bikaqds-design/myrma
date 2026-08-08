-- ─── link_serial_to_rma_ticket — RMA on an already-tracked serial ──────────
--
-- Closes the gap left by the 2026-08-05 duplicate-serial fix
-- (WAREHOUSE_R1_TEST_CHECKLIST.md §2). That fix stopped silent data loss by
-- REJECTING a ticket whose serial already exists in inventory_units — correct
-- as a stop-gap, but it blocks the commonest RMA of all: a customer returning
-- a unit the shop sold them. There was no route through the UI for it.
--
-- This RPC is that route. Instead of inserting a second unit for the serial
-- (which the partial unique index inv_units_serial_unique_idx rightly forbids),
-- it MOVES the existing unit into the RMA: company_stock → active_rma, parked
-- in RMA-RECEIVED, attached to the new ticket, with a stock_moves row so the
-- transition is auditable like every other stock movement.
--
-- Guards, per the 2026-08-05 decision:
--   * reserved / delivered units are refused — pulling a unit promised to an
--     open sales order or invoice would quietly break that document;
--   * a unit already sitting on an open RMA is refused — it cannot be on two
--     tickets at once, and silently reassigning it would strand the first;
--   * a closed unit is refused — the serial is free to be re-inserted normally,
--     which is exactly what inv_units_serial_unique_idx's `status <> 'closed'`
--     filter already allows.
--
-- Returns the linked unit's id so the caller can include it in the auto-move
-- pass that follows a ticket save.

CREATE OR REPLACE FUNCTION public.link_serial_to_rma_ticket(
  p_serial      text,
  p_ticket_id   uuid,
  p_rma_number  text,
  p_actor_email text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit     record;
  v_received record;
  v_doc      text;
BEGIN
  -- Same posture as move_rma_units: any non-viewer staff member can do this,
  -- because it happens as a side effect of an ordinary ticket save.
  IF NOT (public.rma_is_staff() AND public.rma_user_role() <> 'viewer') THEN
    RAISE EXCEPTION 'Not authorized to link a serial to an RMA ticket' USING ERRCODE = 'P0001';
  END IF;

  IF btrim(COALESCE(p_serial, '')) = '' THEN
    RAISE EXCEPTION 'A serial number is required to link an existing unit' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_unit
  FROM public.inventory_units
  WHERE btrim(serial_number) = btrim(p_serial)
    AND status <> 'closed'          -- mirrors inv_units_serial_unique_idx
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No live unit holds serial %', p_serial USING ERRCODE = 'P0001';
  END IF;

  IF v_unit.status = 'active_rma' THEN
    RAISE EXCEPTION 'Serial % is already on RMA % — resolve that ticket before opening another',
      p_serial, COALESCE(v_unit.rma_number, '(unknown)')
      USING ERRCODE = 'P0001';
  END IF;

  IF v_unit.status <> 'company_stock' THEN
    RAISE EXCEPTION 'Serial % is % — only a unit in company stock can be taken onto an RMA',
      p_serial, v_unit.status
      USING ERRCODE = 'P0001';
  END IF;

  IF v_unit.reservation_status <> 'available' THEN
    -- Point at the holding document. The reservation link is polymorphic
    -- (reserved_by_doc_type / reserved_by_doc_id, 20260719), so the id is
    -- reported as-is rather than joined — "reserved" with nothing to look up
    -- just sends the user hunting.
    v_doc := COALESCE(
      NULLIF(btrim(COALESCE(v_unit.reserved_by_doc_type, '')), '') || ' ' || COALESCE(v_unit.reserved_by_doc_id::text, ''),
      'an open document'
    );

    RAISE EXCEPTION 'Serial % is % on % — release it there before opening an RMA',
      p_serial, v_unit.reservation_status, v_doc
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_received
  FROM public.warehouses
  WHERE code = 'RMA-RECEIVED' AND is_system;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'System location RMA-RECEIVED is missing — apply 20260764 first'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.inventory_units
  SET
    status        = 'active_rma',
    rma_ticket_id = p_ticket_id,
    rma_number    = p_rma_number,
    warehouse_id  = v_received.id
  WHERE id = v_unit.id;

  INSERT INTO public.stock_moves
    (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
  VALUES
    ('unit', v_unit.id, 'rma_ticket', p_ticket_id, 'transfer', 1,
     COALESCE(v_unit.warehouse_id::text, 'unassigned'), v_received.id::text, p_actor_email);

  RETURN v_unit.id;
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
    WHERE n.nspname = 'public' AND p.proname = 'link_serial_to_rma_ticket'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
  END LOOP;
END;
$$;
