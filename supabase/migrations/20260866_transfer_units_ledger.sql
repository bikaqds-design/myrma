-- Put the last direct-mutation inventory paths on the ledger. (BUG-032, the
-- open half.)
--
-- ── What was left open ───────────────────────────────────────────────────────
--
-- `20260831_guard_direct_warehouse_moves.sql` closed the two behaviours that
-- corrupt state: a browser PATCH can no longer relocate a RESERVED unit, nor
-- move one INTO a protected system location. What it did not close is the
-- ledger: those transfers, and the manufacturer-batch status writes, still
-- wrote no `stock_moves` row, so the Warehouse Dashboard and margin reporting
-- could not see a unit move or leave.
--
-- ── Why a new function rather than routing to `transfer_stock` ───────────────
--
-- The R2 note said to route the screens through `transfer_stock`, and the
-- comment on `transferUnits()` warned "the feature sets differ; don't merge
-- blindly". Re-checked before writing this, the difference is smaller than the
-- warning implies but it is not nothing:
--
--   * The System Pool (null-warehouse) destination that comment names is gone.
--     `TransferModal` dropped it in the Warehouse R1 redesign and no unit is
--     unplaced any more, so there is nothing left to preserve there.
--   * `transfer_stock` moves ONE unit per call and needs the product and the
--     source warehouse passed in. The three screens transfer a whole selection
--     — up to everything in a warehouse — and know only the unit ids. Calling
--     it in a loop from the browser would leave a half-finished transfer when
--     one unit in the middle is refused.
--   * It is also the bulk/serialized dispatcher, and only the serialized half
--     can ever apply here: these screens list `inventory_units` rows.
--
-- So this adds the set-based sibling `transfer_units(uuid[], uuid, text)`,
-- built on the same conventions `transfer_stock` established (`move_type
-- 'transfer'`, `ref_type 'unit'`, the two warehouse ids carried in
-- `from_status`/`to_status`). All-or-nothing: any refusal raises before
-- anything is written.
--
-- ── The guard does NOT protect this path, so the rules are repeated here ────
--
-- `rma_guard_direct_warehouse_move()` is SECURITY INVOKER and returns early
-- when `current_user` is not 'authenticated'/'anon' — inside a SECURITY
-- DEFINER function it reads 'postgres', which is exactly how the stock RPCs
-- are allowed to move units into system locations legitimately. A function
-- that skips the guard must therefore carry the guard's rules itself, and this
-- one does: no reserved unit, no system destination. Verified below in both
-- directions rather than assumed.
--
-- ── Who may transfer ─────────────────────────────────────────────────────────
--
-- `rma_is_manager_or_above()`, matching `transfer_stock`. This is not a
-- narrowing in practice: the button is drawn behind `canDo('inventory',
-- 'transfer')`, which is `false` in every role default, and no stored
-- permission row in production grants it — so today it is visible only to
-- admin/super_admin, who bypass `canDo` entirely. Owner's decision, 2026-09-16.
--
-- ── Manufacturer batches ─────────────────────────────────────────────────────
--
-- `mark_batch_sent` and `mark_batch_resolved` move every unit in a batch to
-- `sent_to_manufacturer` and then `closed`. Both now write one ledger row per
-- unit that actually changed, under the new `manufacturer_batch` doc type so
-- the row points back at the batch.
--
-- Resolution semantics are deliberately UNCHANGED: every unit still closes,
-- whatever the outcome was. The open question recorded against BUG-032 was
-- whether a "Replacement Rcvd" batch should instead return its units to
-- company stock; the owner settled it on 2026-09-16 — the unit that was sent
-- away does not come back, and a replacement arriving is a separate receipt
-- against a vendor invoice. So this migration ledgers the closure rather than
-- redefining it.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
BEGIN
  IF to_regprocedure('public.rma_is_manager_or_above()') IS NULL THEN
    RAISE EXCEPTION 'Refusing to apply: rma_is_manager_or_above() is missing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.warehouses'::regclass
                    AND attname = 'is_system' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Refusing to apply: warehouses.is_system does not exist.';
  END IF;
  IF to_regprocedure('public.mark_batch_sent(uuid, timestamptz, text)') IS NULL
     OR to_regprocedure('public.mark_batch_resolved(uuid, text, timestamptz, text)') IS NULL THEN
    RAISE EXCEPTION 'Refusing to apply: the batch RPCs from 20260830 are missing.';
  END IF;
END
$do$;

-- ═══ doc_type: a ledger row may now point at a manufacturer batch ════════════
-- Same catalog-lookup drop pattern as 20260765 added 'rma_ticket'.

DO $do$
DECLARE
  v_name text;
BEGIN
  SELECT conname INTO v_name
    FROM pg_constraint
   WHERE conrelid = 'public.stock_moves'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%doc_type%';
  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.stock_moves DROP CONSTRAINT %I', v_name);
  END IF;
END
$do$;

ALTER TABLE public.stock_moves
  ADD CONSTRAINT stock_moves_doc_type_check
  CHECK (doc_type = ANY (ARRAY[
    'sales_order', 'invoice', 'credit_note', 'manual',
    'vendor_invoice', 'rma_ticket', 'manufacturer_batch'
  ]));

-- ═══ transfer_units ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.transfer_units(
  p_unit_ids         uuid[],
  p_to_warehouse_id  uuid,
  p_actor_email      text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_actor  text;
  v_dest   record;
  v_unit   record;
  v_moved  integer := 0;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to transfer units' USING ERRCODE = 'P0001';
  END IF;

  IF p_unit_ids IS NULL OR array_length(p_unit_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No units were given to transfer' USING ERRCODE = 'P0001';
  END IF;

  IF p_to_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'A destination warehouse is required' USING ERRCODE = 'P0001';
  END IF;

  -- The passed actor is a fallback only; the signed-in identity wins wherever
  -- there is one (the convention set by 20260751, and `stock_moves` has its own
  -- BEFORE INSERT stamp from 20260753 on top of this).
  -- 'system' only as a last resort: actor_email is NOT NULL, and a server-side
  -- caller with no JWT and no argument must not fail the whole transfer.
  v_actor := COALESCE(public.rma_current_user_email(), NULLIF(p_actor_email, ''), 'system');

  SELECT id, name, is_active, is_system INTO v_dest
    FROM public.warehouses WHERE id = p_to_warehouse_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Destination warehouse % does not exist', p_to_warehouse_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Units reach the RMA/scrap locations through move_rma_units and
  -- promote_rma_unit, never a manual transfer — the same rule the browser-side
  -- guard enforces, repeated because SECURITY DEFINER skips that guard.
  IF v_dest.is_system THEN
    RAISE EXCEPTION 'Cannot transfer into the system location "%" — it is managed by the RMA workflow',
      v_dest.name USING ERRCODE = 'P0001';
  END IF;

  IF NOT COALESCE(v_dest.is_active, true) THEN
    RAISE EXCEPTION 'Warehouse "%" is archived', v_dest.name USING ERRCODE = 'P0001';
  END IF;

  -- Ordered by id so two concurrent bulk transfers lock the overlap in the
  -- same sequence and cannot deadlock against each other.
  FOR v_unit IN
    SELECT u.id, u.warehouse_id, u.reservation_status, u.serial_number
      FROM public.inventory_units u
     WHERE u.id = ANY(p_unit_ids)
     ORDER BY u.id
     FOR UPDATE
  LOOP
    IF v_unit.reservation_status = 'reserved' THEN
      RAISE EXCEPTION 'Unit % is reserved for a sales order and cannot be transferred',
        COALESCE(NULLIF(v_unit.serial_number, ''), v_unit.id::text)
        USING ERRCODE = 'P0001';
    END IF;

    -- Already there: not an error, and not a movement to record.
    CONTINUE WHEN v_unit.warehouse_id IS NOT DISTINCT FROM p_to_warehouse_id;

    UPDATE public.inventory_units
       SET warehouse_id = p_to_warehouse_id
     WHERE id = v_unit.id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit.id, 'manual', NULL, 'transfer', 1,
       v_unit.warehouse_id::text, p_to_warehouse_id::text, v_actor);

    v_moved := v_moved + 1;
  END LOOP;

  -- Every id must have been a real unit. Checked after the loop because the
  -- whole function is one transaction: raising here still writes nothing.
  IF (SELECT count(*) FROM public.inventory_units WHERE id = ANY(p_unit_ids))
     <> (SELECT count(DISTINCT x) FROM unnest(p_unit_ids) AS x) THEN
    RAISE EXCEPTION 'Some of the units given do not exist' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_moved;
END;
$fn$;

COMMENT ON FUNCTION public.transfer_units(uuid[], uuid, text) IS
  'Set-based serialized warehouse transfer with a stock_moves row per unit moved (BUG-032). Refuses reserved units and system/archived destinations; a unit already at the destination is a no-op. All-or-nothing.';

-- ═══ mark_batch_sent — same behaviour, now on the ledger ═════════════════════

CREATE OR REPLACE FUNCTION public.mark_batch_sent(
  p_batch_id        uuid,
  p_sent_date       timestamptz,
  p_tracking_number text
)
RETURNS public.manufacturer_batches
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_batch public.manufacturer_batches;
  v_actor text;
BEGIN
  IF NOT (public.rma_is_staff() AND public.rma_user_role() <> 'viewer') THEN
    RAISE EXCEPTION 'Not authorized to update manufacturer batches' USING ERRCODE = 'P0001';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), 'system');

  UPDATE public.manufacturer_batches
     SET status = 'sent', sent_date = p_sent_date, tracking_number = p_tracking_number
   WHERE id = p_batch_id
  RETURNING * INTO v_batch;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch % does not exist', p_batch_id USING ERRCODE = 'P0001';
  END IF;

  -- The old status has to be read before the write to be recorded: RETURNING
  -- cannot see the pre-update row.
  WITH before AS (
    SELECT id, status
      FROM public.inventory_units
     WHERE manufacturer_batch_id = p_batch_id
     ORDER BY id
     FOR UPDATE
  ), moved AS (
    UPDATE public.inventory_units u
       SET status = 'sent_to_manufacturer'
      FROM before b
     WHERE u.id = b.id
       AND b.status IS DISTINCT FROM 'sent_to_manufacturer'
    RETURNING u.id, b.status AS from_status
  )
  INSERT INTO public.stock_moves
    (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
  SELECT 'unit', id, 'manufacturer_batch', p_batch_id, 'adjust', 1,
         from_status, 'sent_to_manufacturer', v_actor
    FROM moved;

  RETURN v_batch;
END;
$function$;

-- ═══ mark_batch_resolved — same behaviour, now on the ledger ═════════════════

CREATE OR REPLACE FUNCTION public.mark_batch_resolved(
  p_batch_id        uuid,
  p_resolution_type text,
  p_resolution_date timestamptz,
  p_notes           text DEFAULT NULL
)
RETURNS public.manufacturer_batches
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_batch public.manufacturer_batches;
  v_actor text;
BEGIN
  IF NOT (public.rma_is_staff() AND public.rma_user_role() <> 'viewer') THEN
    RAISE EXCEPTION 'Not authorized to update manufacturer batches' USING ERRCODE = 'P0001';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), 'system');

  UPDATE public.manufacturer_batches
     SET status           = 'resolved',
         resolution_type  = p_resolution_type,
         resolution_date  = p_resolution_date,
         resolution_notes = p_notes
   WHERE id = p_batch_id
  RETURNING * INTO v_batch;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch % does not exist', p_batch_id USING ERRCODE = 'P0001';
  END IF;

  -- Every unit closes, whatever the resolution was — unchanged, and now the
  -- owner's explicit decision rather than an inherited accident (see header).
  -- The resolution is recorded on the batch; the ledger records the closure.
  WITH before AS (
    SELECT id, status
      FROM public.inventory_units
     WHERE manufacturer_batch_id = p_batch_id
     ORDER BY id
     FOR UPDATE
  ), moved AS (
    UPDATE public.inventory_units u
       SET status = 'closed'
      FROM before b
     WHERE u.id = b.id
       AND b.status IS DISTINCT FROM 'closed'
    RETURNING u.id, b.status AS from_status
  )
  INSERT INTO public.stock_moves
    (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
  SELECT 'unit', id, 'manufacturer_batch', p_batch_id, 'adjust', 1,
         from_status, 'closed', v_actor
    FROM moved;

  RETURN v_batch;
END;
$function$;

-- ═══ EXECUTE lockdown ════════════════════════════════════════════════════════
-- Same treatment every client-invoked RPC got in 20260752.

REVOKE ALL ON FUNCTION public.transfer_units(uuid[], uuid, text) FROM PUBLIC;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.transfer_units(uuid[], uuid, text) FROM anon';
  END IF;
END
$do$;
GRANT EXECUTE ON FUNCTION public.transfer_units(uuid[], uuid, text) TO authenticated, service_role;

-- ═══ Guards: the migration refuses to finish if it did not take ══════════════

DO $do$
BEGIN
  IF to_regprocedure('public.transfer_units(uuid[], uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'Refusing to finish: transfer_units was not created.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'transfer_units' AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'Refusing to finish: transfer_units must be SECURITY DEFINER.';
  END IF;

  IF has_function_privilege('anon', 'public.transfer_units(uuid[], uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: anon can still execute transfer_units.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.stock_moves'::regclass
       AND conname = 'stock_moves_doc_type_check'
       AND pg_get_constraintdef(oid) LIKE '%manufacturer_batch%'
  ) THEN
    RAISE EXCEPTION 'Refusing to finish: stock_moves.doc_type does not allow manufacturer_batch.';
  END IF;

  -- The batch RPCs must still exist with their original signatures — the
  -- client calls them by name with named arguments.
  IF to_regprocedure('public.mark_batch_sent(uuid, timestamptz, text)') IS NULL
     OR to_regprocedure('public.mark_batch_resolved(uuid, text, timestamptz, text)') IS NULL THEN
    RAISE EXCEPTION 'Refusing to finish: a batch RPC lost its signature.';
  END IF;

  RAISE NOTICE 'BUG-032: warehouse transfers and batch status changes now write stock_moves.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- supabase/tests/transfer_units_ledger.sql — rolled-back probe: a transfer
-- moves the unit and writes exactly one ledger row carrying both warehouse
-- ids; a second call to the same destination moves nothing and writes nothing;
-- a reserved unit is refused and the whole batch is left untouched; a system
-- destination is refused; an archived destination is refused; an unknown id is
-- refused; a non-manager is refused; batch send and resolve each write one row
-- per unit with the correct from/to status.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
-- Point `transferUnits()` back at a direct PATCH of warehouse_id (the browser
-- guard from 20260831 still stands), drop transfer_units, and restore the two
-- batch RPC bodies from 20260830. The doc_type value can stay; removing it
-- would orphan any ledger row already written under it.
