-- ============================================================================
-- 20260877_lock_inventory_unit_writes.sql                    (BL-03 / I-03)
--
-- inventory_units is the serialized stock ledger's subject: one row per
-- physical unit. Before this migration any signed-in non-viewer (a technician,
-- a sales rep) could
--   * INSERT a unit as company_stock/available, straight into sellable stock,
--     with no stock_moves row and no cost (staff_write policy + INSERT grant);
--   * UPDATE its physical status (company_stock -> closed, -> active_rma ...)
--     with no stock_moves row, because status was not a guarded column.
-- Both are phantom or vanishing stock: the ledger and the shelf disagree and
-- nothing says who did it.
--
-- What changes:
--   1. Creation goes through rma_create_units_from_ticket, the only writer of
--      new client-originated units. It forces status active_rma and
--      reservation available, ignores every other column the caller sends
--      (warehouse, cost, reservation fields), takes rma_number from the ticket
--      rather than the caller, keeps the "one bad unit costs only itself"
--      behaviour RMA intake already had, and writes a stock_moves 'receive'
--      row per unit. Units enter company_stock only through receipt, return
--      disposition, promote_rma_unit or an approved adjustment, all of which
--      are already RPCs.
--   2. The client INSERT policy and INSERT/TRUNCATE grants are removed. With no
--      way to insert, a BEFORE INSERT guard would be dead code, so there is none.
--   3. status joins the guarded columns of rma_guard_inventory_ledger_columns.
--      Every legitimate status change is already an RPC (promote_rma_unit,
--      move_rma_units, create_manufacturer_batch, mark_batch_sent,
--      mark_batch_resolved, restore_units, ...) and those run as the owner,
--      which the guard already exempts. Nothing in src/ updates a unit's
--      status directly (searched 2026-09-20).
--   4. status gets the CHECK constraint CLAUDE.md has long said exists
--      (chk_inventory_status) but which the live schema never had, so a typo'd
--      or invented status could be stored. Production's data was checked first:
--      every row is company_stock or active_rma.
--
-- Found by an independent security review before this shipped, and fixed here:
--   * create_manufacturer_batch checked nothing about a unit's status, and
--     mark_batch_resolved/_sent then set status for every unit in the batch, so
--     a technician could batch a SELLABLE unit and close it entirely through
--     RPCs the new guard exempts -> only active_rma/available units can be
--     batched;
--   * manufacturer_batch_id, warehouse_id, rma_ticket_id, resolution_type,
--     resolved_date and created_date were still client-writable with no ledger
--     row (warehouse_id NULL re-buckets a unit into "Main", created_date changes
--     which unit a sale consumes) -> all guarded. Every legitimate writer of
--     these is an RPC running as the owner;
--   * rma_create_units_from_ticket let any non-viewer attach units to any
--     ticket, had no size cap (one subtransaction per element), swallowed every
--     error including timeouts and deadlocks into "this unit failed", returned
--     raw SQLERRM to the browser and lacked pg_temp in its search_path
--     -> creator/assignee/manager only, 200-unit cap, only data errors are
--     per-unit failures, a generic message except for the duplicate serial;
--   * the CHECK let NULL through, which also switches serial uniqueness off
--     -> status must be non-null;
--   * TRUNCATE on stock_moves was still granted to authenticated -> revoked.
--
-- Known and NOT changed here (each needs its own decision):
--   * adjust_stock (manager-gated, ledgered) can set a serialized unit's status
--     to company_stock without checking where it sits, e.g. a unit in SCRAP;
--     that belongs with the cycle-count/adjustment work (BL-18);
--   * the RPC leaves warehouse_id NULL and relies on the client's follow-up
--     move_rma_units to place the unit at RMA-RECEIVED, so if that call fails
--     the unit is recorded as received but not shown on the Warehouse Dashboard;
--     placing it here would need the system locations, which a freshly
--     provisioned tenant does not have (see the provisioning note in the PR);
--   * the intake ledger row uses to_status 'active_rma' where other 'receive'
--     rows use 'available'; nothing aggregates 'receive' today.
--
-- Not done here, on purpose:
--   * DELETE. An administrator can still delete a unit, and a ticket delete
--     cascades to its units through the foreign key, which is intended. The
--     deletion is at least recorded now, because inventory_units is in the
--     20260876 audit log. Blocking it would break ticket deletion and needs its
--     own decision.
--   * Backup & Restore: rma_restore_apply is a SECURITY DEFINER function and is
--     unaffected by the missing INSERT policy or the guard.
-- ============================================================================

-- ── 1. The intake RPC ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rma_create_units_from_ticket(p_ticket_id uuid, p_units jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rma      text;
  v_creator  text;
  v_assigned text;
  v_u       jsonb;
  v_i       integer := 0;
  v_serial  text;
  v_row     public.inventory_units;
  v_created jsonb := '[]'::jsonb;
  v_failed  jsonb := '[]'::jsonb;
BEGIN
  IF NOT COALESCE((public.rma_is_staff() AND public.rma_user_role() <> 'viewer'), false) THEN
    RAISE EXCEPTION 'Not authorized to create RMA units' USING ERRCODE = 'P0001';
  END IF;

  IF p_units IS NULL OR jsonb_typeof(p_units) <> 'array' THEN
    RAISE EXCEPTION 'p_units must be a JSON array of units' USING ERRCODE = 'P0001';
  END IF;

  -- Each unit below is its own subtransaction; without a cap one call could burn
  -- enough subtransaction ids to slow every other session down.
  IF jsonb_array_length(p_units) > 200 THEN
    RAISE EXCEPTION 'At most 200 units can be created in one call (got %)', jsonb_array_length(p_units)
      USING ERRCODE = 'P0001';
  END IF;

  SELECT rma_number, created_by, assigned_technician
    INTO v_rma, v_creator, v_assigned
    FROM public.rma_tickets WHERE id = p_ticket_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RMA ticket % not found', p_ticket_id USING ERRCODE = 'P0001';
  END IF;

  -- Any non-viewer may create a ticket, and units are only ever created on that
  -- create path, so the caller must have made this ticket, be the technician it
  -- is assigned to, or be a manager. Otherwise a technician could attach units
  -- to a ticket they cannot even edit (rma_tickets.staff_update).
  IF NOT COALESCE(
       public.rma_is_manager_or_above()
       OR v_creator = public.rma_current_user_email()
       OR (public.rma_user_role() = 'technician' AND v_assigned = public.rma_current_user_email()),
       false) THEN
    RAISE EXCEPTION 'Not authorized to add units to ticket %', v_rma USING ERRCODE = 'P0001';
  END IF;

  FOR v_u IN SELECT value FROM jsonb_array_elements(p_units)
  LOOP
    v_i := v_i + 1;
    v_serial := btrim(coalesce(v_u ->> 'serial_number', ''));

    -- Each unit in its own subtransaction: a duplicate serial fails that unit
    -- and leaves the others, and its ledger row, intact.
    BEGIN
      INSERT INTO public.inventory_units
        (rma_ticket_id, rma_number, product_id, product_name, serial_number,
         warranty_status, status, reservation_status)
      VALUES
        (p_ticket_id, v_rma, nullif(v_u ->> 'product_id', '')::uuid,
         coalesce(v_u ->> 'product_name', ''), v_serial,
         coalesce(v_u ->> 'warranty_status', ''), 'active_rma', 'available')
      RETURNING * INTO v_row;

      INSERT INTO public.stock_moves
        (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
      VALUES
        ('unit', v_row.id, 'rma_ticket', p_ticket_id, 'receive', 1, NULL, 'active_rma',
         coalesce(public.rma_current_user_email(), 'system'));

      v_created := v_created || to_jsonb(v_row);
    -- Only errors that are about THIS unit's data are per-unit failures. A
    -- timeout, a deadlock or a permission error is not, and must abort the call
    -- so the operator sees that creation is broken rather than "3 units failed".
    EXCEPTION WHEN unique_violation OR foreign_key_violation OR check_violation
                OR not_null_violation OR invalid_text_representation
                OR string_data_right_truncation THEN
      v_failed := v_failed || jsonb_build_object(
        'index', v_i - 1,
        'product_name', v_u ->> 'product_name',
        'serial_number', v_serial,
        -- The duplicate serial is the case the form explains to the user; the
        -- rest would only leak constraint and column names.
        'message', CASE WHEN SQLSTATE = '23505' THEN SQLERRM ELSE 'Invalid unit data' END,
        'code', SQLSTATE);
    END;
  END LOOP;

  RETURN jsonb_build_object('created', v_created, 'failed', v_failed);
END;
$function$;

REVOKE ALL ON FUNCTION public.rma_create_units_from_ticket(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rma_create_units_from_ticket(uuid, jsonb) TO authenticated, service_role;

-- ── 2. No client INSERT ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS staff_write ON public.inventory_units;
REVOKE INSERT, TRUNCATE ON public.inventory_units FROM authenticated, anon;

-- ── 3. status is a guarded column ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rma_guard_inventory_ledger_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  c_guarded constant text[] := ARRAY[
    'status',
    'reservation_status','reserved_by_doc_type','reserved_by_doc_id','reserved_at',
    'reserved_by_email','unit_cost_base','vendor_invoice_id','product_id','serial_number',
    -- added on review: each of these changes where a unit sits, what it is
    -- attached to, or which unit a sale consumes, and each has an RPC writer.
    'manufacturer_batch_id','warehouse_id','rma_ticket_id','resolution_type','resolved_date',
    'created_date'
  ];
  v_changed text[];
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(array_agg(k), ARRAY[]::text[]) INTO v_changed
    FROM unnest(c_guarded) k
   WHERE to_jsonb(OLD) -> k IS DISTINCT FROM to_jsonb(NEW) -> k;

  IF array_length(v_changed, 1) > 0 THEN
    RAISE EXCEPTION
      'Stock ledger columns cannot be changed directly (%). Use the stock RPCs, which record the movement in stock_moves.',
      array_to_string(v_changed, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

-- ── 4. status is a checked column ───────────────────────────────────────────

ALTER TABLE public.inventory_units DROP CONSTRAINT IF EXISTS chk_inventory_status;
ALTER TABLE public.inventory_units
  ADD CONSTRAINT chk_inventory_status
  CHECK (status IS NOT NULL AND status IN ('active_rma', 'company_stock', 'sent_to_manufacturer', 'closed'));

-- ── 5. Only RMA units can be sent to a manufacturer ─────────────────────────
-- create_manufacturer_batch is the door mark_batch_sent / mark_batch_resolved
-- walk through to change status, so it must not accept a unit that is on sale.
-- Body unchanged from the live definition except the marked check.

CREATE OR REPLACE FUNCTION public.create_manufacturer_batch(p_unit_ids uuid[], p_manufacturer_name text, p_actor_email text)
 RETURNS manufacturer_batches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_batch  public.manufacturer_batches;
  v_code   text;
  v_found  integer;
  v_taken  integer;
  v_wrong  integer;
BEGIN
  IF NOT COALESCE((public.rma_is_staff() AND public.rma_user_role() <> 'viewer'), false) THEN
    RAISE EXCEPTION 'Not authorized to create manufacturer batches' USING ERRCODE = 'P0001';
  END IF;
  IF p_unit_ids IS NULL OR array_length(p_unit_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'A batch needs at least one unit' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_found FROM public.inventory_units WHERE id = ANY(p_unit_ids);
  IF v_found <> array_length(p_unit_ids, 1) THEN
    RAISE EXCEPTION '% of the % unit(s) do not exist',
      array_length(p_unit_ids, 1) - v_found, array_length(p_unit_ids, 1)
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_taken FROM public.inventory_units
   WHERE id = ANY(p_unit_ids) AND manufacturer_batch_id IS NOT NULL;
  IF v_taken > 0 THEN
    RAISE EXCEPTION '% of the % unit(s) already belong to another batch',
      v_taken, array_length(p_unit_ids, 1) USING ERRCODE = 'P0001';
  END IF;

  -- (20260877) A unit that is on sale, reserved or delivered is not an RMA unit
  -- and must not be closed or sent away through a batch.
  SELECT count(*) INTO v_wrong FROM public.inventory_units
   WHERE id = ANY(p_unit_ids)
     AND (status IS DISTINCT FROM 'active_rma' OR reservation_status IS DISTINCT FROM 'available');
  IF v_wrong > 0 THEN
    RAISE EXCEPTION '% of the % unit(s) are not available RMA units and cannot be sent to a manufacturer',
      v_wrong, array_length(p_unit_ids, 1) USING ERRCODE = 'P0001';
  END IF;

  v_code := public.nextval_for_type('batch');

  INSERT INTO public.manufacturer_batches
    (batch_number, manufacturer_name, status, unit_count, created_date, created_by)
  VALUES
    (v_code, p_manufacturer_name, 'draft', array_length(p_unit_ids, 1), now(), p_actor_email)
  RETURNING * INTO v_batch;

  UPDATE public.inventory_units
     SET manufacturer_batch_id = v_batch.id
   WHERE id = ANY(p_unit_ids);

  RETURN v_batch;
END;
$function$;

-- ── 6. The ledger cannot be truncated by a client ───────────────────────────
REVOKE TRUNCATE ON public.stock_moves FROM authenticated, anon;
