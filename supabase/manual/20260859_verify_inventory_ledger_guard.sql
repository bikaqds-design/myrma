-- Verifies 20260822_guard_inventory_ledger_columns.sql (BUG-010).
--
-- Three directions, because a guard that only refuses is not proven correct:
--   A. the exploit from the finding is refused
--   B. the four live client paths that write inventory_units still work
--   C. server-side callers (the RPCs) pass straight through
--
-- Everything runs inside a transaction aborted by the closing RAISE, so the
-- probe writes below never persist. Read the VERDICT in the error message.

DO $verify$
DECLARE
  v_out text := E'\n'; v_pass int := 0; v_fail int := 0;
  v_tech text; v_unit uuid; v_n integer;
BEGIN
  SELECT user_email INTO v_tech FROM public.user_roles
   WHERE role='technician' AND status='active' LIMIT 1;
  SELECT id INTO v_unit FROM public.inventory_units WHERE reserved_by_doc_id IS NOT NULL LIMIT 1;
  IF v_unit IS NULL THEN SELECT id INTO v_unit FROM public.inventory_units LIMIT 1; END IF;

  PERFORM set_config('role','authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_tech, 'role','authenticated')::text, true);

  ---------------------------------------------------------------------------
  -- A. The exploit
  ---------------------------------------------------------------------------
  BEGIN
    UPDATE public.inventory_units
       SET reserved_by_doc_id = NULL, reservation_status = 'available'
     WHERE id = v_unit;
    v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  technician un-reserved stock - still allowed%s', E'\n');
  EXCEPTION WHEN check_violation THEN
    v_pass := v_pass + 1;
    v_out := v_out || format('PASS  un-reserving refused%s', E'\n');
  END;

  BEGIN
    UPDATE public.inventory_units SET unit_cost_base = 1 WHERE id = v_unit;
    v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  technician rewrote unit_cost_base (COGS)%s', E'\n');
  EXCEPTION WHEN check_violation THEN
    v_pass := v_pass + 1;
    v_out := v_out || format('PASS  unit_cost_base change refused%s', E'\n');
  END;

  BEGIN
    UPDATE public.inventory_units SET serial_number = 'TAMPERED' WHERE id = v_unit;
    v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  technician rewrote serial_number%s', E'\n');
  EXCEPTION WHEN check_violation THEN
    v_pass := v_pass + 1;
    v_out := v_out || format('PASS  serial_number change refused%s', E'\n');
  END;

  ---------------------------------------------------------------------------
  -- B. The live client paths (inventory.ts:335, :389, :405, :440)
  --    These MUST keep working; status and warehouse_id are out of scope until
  --    BUG-032 moves them onto RPCs.
  ---------------------------------------------------------------------------
  UPDATE public.inventory_units
     SET status='closed', resolution_type='repaired', resolved_date=now(), notes='probe'
   WHERE id = v_unit;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN v_pass := v_pass + 1;
    v_out := v_out || format('PASS  RMA resolution write still works%s', E'\n');
  ELSE v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  RMA resolution write blocked%s', E'\n'); END IF;

  UPDATE public.inventory_units SET warehouse_id = warehouse_id WHERE id = v_unit;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN v_pass := v_pass + 1;
    v_out := v_out || format('PASS  warehouse move still works%s', E'\n');
  ELSE v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  warehouse move blocked%s', E'\n'); END IF;

  UPDATE public.inventory_units SET manufacturer_batch_id = manufacturer_batch_id WHERE id = v_unit;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN v_pass := v_pass + 1;
    v_out := v_out || format('PASS  manufacturer batch write still works%s', E'\n');
  ELSE v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  manufacturer batch write blocked%s', E'\n'); END IF;

  ---------------------------------------------------------------------------
  -- C. Server-side callers pass through, or every stock RPC breaks
  ---------------------------------------------------------------------------
  PERFORM set_config('role','postgres', true);
  UPDATE public.inventory_units SET reservation_status = reservation_status WHERE id = v_unit;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN v_pass := v_pass + 1;
    v_out := v_out || format('PASS  server-side write to a guarded column passes through%s', E'\n');
  ELSE v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  server-side write blocked - the stock RPCs would break%s', E'\n'); END IF;

  v_out := v_out || format('%s%s passed, %s failed.%s', E'\n', v_pass, v_fail, E'\n');
  RAISE EXCEPTION 'VERDICT :: %', v_out;
END
$verify$;
