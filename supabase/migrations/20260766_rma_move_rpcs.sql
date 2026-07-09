-- ═══════════════════════════════════════════════════════════════════════════
--  Warehouse Module Redesign R1 — RMA stage auto-move + promote-to-sellable
--
--  move_rma_units: called every time a ticket's product statuses are saved
--  (create/edit/bulk). Relocates each affected unit to the matching system
--  RMA location and logs a stock_moves row. Idempotent — a unit already at
--  its target location is skipped, so re-saving a ticket with unchanged
--  statuses is a safe no-op. Staff-non-viewer guard: technicians drive this
--  indirectly via ordinary ticket edits, not a privileged action.
--
--  promote_rma_unit: THE previously-missing path from active_rma to sellable
--  company_stock (resolve_units() had zero callers anywhere in src/). Manager+
--  only — this is a real inventory-value decision, not a routine ticket edit.
--  Blocked for reserved units (nothing promised to a document should be
--  silently relocated) and for is_system/non-sellable destinations.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.move_rma_units(
  p_ticket_id   uuid,
  p_moves       jsonb,
  p_actor_email text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_move        jsonb;
  v_unit        record;
  v_target_wh   record;
  v_moved_count integer := 0;
BEGIN
  IF NOT (public.rma_is_staff() AND public.rma_user_role() <> 'viewer') THEN
    RAISE EXCEPTION 'Not authorized to move RMA units' USING ERRCODE = 'P0001';
  END IF;

  FOR v_move IN SELECT * FROM jsonb_array_elements(p_moves)
  LOOP
    SELECT * INTO v_unit
    FROM public.inventory_units
    WHERE id = (v_move->>'unit_id')::uuid
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unit % not found', v_move->>'unit_id' USING ERRCODE = 'P0001';
    END IF;

    IF v_unit.rma_ticket_id IS DISTINCT FROM p_ticket_id THEN
      RAISE EXCEPTION 'Unit % does not belong to ticket %', v_unit.id, p_ticket_id
        USING ERRCODE = 'P0001';
    END IF;

    IF v_unit.status <> 'active_rma' THEN
      RAISE EXCEPTION 'Unit % is not an active RMA unit (status=%)', v_unit.id, v_unit.status
        USING ERRCODE = 'P0001';
    END IF;

    IF v_unit.reservation_status <> 'available' THEN
      RAISE EXCEPTION 'Unit % is currently % — cannot auto-move a reserved/delivered unit',
        v_unit.id, v_unit.reservation_status
        USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_target_wh
    FROM public.warehouses
    WHERE code = (v_move->>'to_code') AND is_system
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown system RMA location code: %', v_move->>'to_code'
        USING ERRCODE = 'P0001';
    END IF;

    -- Idempotent no-op: unit is already at its target location.
    CONTINUE WHEN v_unit.warehouse_id = v_target_wh.id;

    UPDATE public.inventory_units
    SET warehouse_id = v_target_wh.id
    WHERE id = v_unit.id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit.id, 'rma_ticket', p_ticket_id, 'transfer', 1,
       COALESCE(v_unit.warehouse_id::text, 'unassigned'), v_target_wh.id::text, p_actor_email);

    v_moved_count := v_moved_count + 1;
  END LOOP;

  RETURN v_moved_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.promote_rma_unit(
  p_unit_id         uuid,
  p_warehouse_id    uuid,
  p_actor_email     text,
  p_resolution_type text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit      record;
  v_dest      record;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to promote an RMA unit to sellable stock' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_unit FROM public.inventory_units WHERE id = p_unit_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unit % not found', p_unit_id USING ERRCODE = 'P0001';
  END IF;

  IF v_unit.status <> 'active_rma' THEN
    RAISE EXCEPTION 'Unit % is not an active RMA unit (status=%)', p_unit_id, v_unit.status
      USING ERRCODE = 'P0001';
  END IF;

  IF v_unit.reservation_status <> 'available' THEN
    RAISE EXCEPTION 'Unit % is currently % — cannot promote a reserved/delivered unit',
      p_unit_id, v_unit.reservation_status
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_dest FROM public.warehouses WHERE id = p_warehouse_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Destination warehouse % not found', p_warehouse_id USING ERRCODE = 'P0001';
  END IF;

  IF v_dest.is_system THEN
    RAISE EXCEPTION 'Cannot promote into a system RMA/transit/virtual location — choose a sellable warehouse'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_dest.warehouse_type IS NOT NULL AND v_dest.warehouse_type NOT IN ('main', 'branch') THEN
    RAISE EXCEPTION 'Destination warehouse "%" is not a sellable location (type=%)', v_dest.name, v_dest.warehouse_type
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.inventory_units
  SET
    status          = 'company_stock',
    warehouse_id    = p_warehouse_id,
    resolved_date   = now(),
    resolution_type = COALESCE(p_resolution_type, resolution_type)
  WHERE id = p_unit_id;

  INSERT INTO public.stock_moves
    (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
  VALUES
    ('unit', p_unit_id, 'rma_ticket', v_unit.rma_ticket_id, 'transfer', 1,
     COALESCE(v_unit.warehouse_id::text, 'unassigned'), p_warehouse_id::text, p_actor_email);
END;
$$;

-- ── EXECUTE lockdown (same posture as every other client RPC, 20260752) ─────

DO $$
DECLARE
  v_names text[] := ARRAY['move_rma_units', 'promote_rma_unit'];
  v_sig text;
BEGIN
  FOR v_sig IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY(v_names)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    BEGIN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_sig);
    EXCEPTION WHEN undefined_object THEN NULL;
    END;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_sig);
    BEGIN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
    EXCEPTION WHEN undefined_object THEN NULL;
    END;
  END LOOP;
END $$;
