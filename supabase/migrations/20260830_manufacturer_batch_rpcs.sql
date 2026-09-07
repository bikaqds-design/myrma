-- Manufacturer batches: sequence-backed numbers, and one transaction per action.
-- (Audit finding BUG-029.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- `createBatch` built its own identifier from a row count:
--
--   const { count } = await supabase.from('manufacturer_batches')
--     .select('*', { count: 'exact', head: true })
--   const batchNumber = `BATCH-${dateStr}-${String((count||0)+1).padStart(3,'0')}`
--
-- `manufacturer_batches.batch_number` is UNIQUE, and a count is not a sequence.
-- Delete any batch and the next create re-derives a number already in use, so
-- it fails. Two people creating a batch at the same moment derive the same
-- number, so one fails. Both surface as an unexplained "batch create failed".
--
-- The second write was worse than the numbering:
--
--   await supabase.from('inventory_units')
--     .update({ manufacturer_batch_id: batchId }).in('id', unitIds)
--
-- No error was captured from it, and it is a separate statement from the
-- insert. If it failed, the batch existed claiming `unit_count` units with no
-- units actually linked to it — and nothing said so.
--
-- `markBatchSent` and `markBatchResolved` have the same two-statement shape.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- Three RPCs, one transaction each, so the batch and its units always agree.
-- Numbering moves to the existing `nextval_for_type()` / `document_sequences`
-- mechanism that every other document code in this system already uses, giving
-- `BATCH-2026-00001`.
--
-- The format changes from `BATCH-<yyyymmdd>-<nnn>`. That is free right now:
-- there are **zero** manufacturer_batches rows and zero units carrying a
-- `manufacturer_batch_id`, so no existing identifier is being invalidated.
--
-- ── What is deliberately NOT changed ─────────────────────────────────────────
--
-- `markBatchResolved` sets every unit in the batch to `closed` regardless of
-- what the resolution actually was — a repaired unit and a scrapped one end up
-- identical. That is a business rule, not a bug I can settle from the code, so
-- the semantics are carried over unchanged and the question is recorded against
-- BUG-032 rather than guessed at here. This migration makes the writes atomic;
-- it does not invent an outcome model.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='nextval_for_type') THEN
    RAISE EXCEPTION 'Refusing to apply: nextval_for_type() does not exist.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.manufacturer_batches) THEN
    RAISE NOTICE 'manufacturer_batches is not empty; existing numbers keep their old format.';
  END IF;
END
$do$;

-- ═══ Sequence row ════════════════════════════════════════════════════════════

INSERT INTO public.document_sequences (seq_type, last_value, seq_year)
VALUES ('batch', 0, EXTRACT(YEAR FROM NOW())::integer)
ON CONFLICT (seq_type) DO NOTHING;

-- ═══ create_manufacturer_batch ═══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.create_manufacturer_batch(
  p_unit_ids          uuid[],
  p_manufacturer_name text,
  p_actor_email       text
)
RETURNS public.manufacturer_batches
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_batch  public.manufacturer_batches;
  v_code   text;
  v_found  integer;
  v_taken  integer;
BEGIN
  IF NOT (public.rma_is_staff() AND public.rma_user_role() <> 'viewer') THEN
    RAISE EXCEPTION 'Not authorized to create manufacturer batches' USING ERRCODE = 'P0001';
  END IF;

  IF p_unit_ids IS NULL OR array_length(p_unit_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'A batch needs at least one unit' USING ERRCODE = 'P0001';
  END IF;

  -- Every id must exist, and none may already belong to a batch. Checked as a
  -- set before anything is written, so a bad list changes nothing.
  SELECT count(*) INTO v_found
    FROM public.inventory_units WHERE id = ANY(p_unit_ids);
  IF v_found <> array_length(p_unit_ids, 1) THEN
    RAISE EXCEPTION '% of the % unit(s) do not exist',
      array_length(p_unit_ids, 1) - v_found, array_length(p_unit_ids, 1)
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_taken
    FROM public.inventory_units
   WHERE id = ANY(p_unit_ids) AND manufacturer_batch_id IS NOT NULL;
  IF v_taken > 0 THEN
    RAISE EXCEPTION '% of the % unit(s) already belong to another batch',
      v_taken, array_length(p_unit_ids, 1)
      USING ERRCODE = 'P0001';
  END IF;

  v_code := public.nextval_for_type('batch');

  INSERT INTO public.manufacturer_batches
    (batch_number, manufacturer_name, status, unit_count, created_date, created_by)
  VALUES
    (v_code, p_manufacturer_name, 'draft', array_length(p_unit_ids, 1), now(), p_actor_email)
  RETURNING * INTO v_batch;

  -- Same transaction: the batch cannot exist without its units.
  UPDATE public.inventory_units
     SET manufacturer_batch_id = v_batch.id
   WHERE id = ANY(p_unit_ids);

  RETURN v_batch;
END;
$function$;

-- ═══ mark_batch_sent ═════════════════════════════════════════════════════════

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
BEGIN
  IF NOT (public.rma_is_staff() AND public.rma_user_role() <> 'viewer') THEN
    RAISE EXCEPTION 'Not authorized to update manufacturer batches' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.manufacturer_batches
     SET status = 'sent', sent_date = p_sent_date, tracking_number = p_tracking_number
   WHERE id = p_batch_id
  RETURNING * INTO v_batch;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch % does not exist', p_batch_id USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.inventory_units
     SET status = 'sent_to_manufacturer'
   WHERE manufacturer_batch_id = p_batch_id;

  RETURN v_batch;
END;
$function$;

-- ═══ mark_batch_resolved ═════════════════════════════════════════════════════

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
BEGIN
  IF NOT (public.rma_is_staff() AND public.rma_user_role() <> 'viewer') THEN
    RAISE EXCEPTION 'Not authorized to update manufacturer batches' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.manufacturer_batches
     SET status          = 'resolved',
         resolution_type = p_resolution_type,
         resolution_date = p_resolution_date,
         resolution_notes = p_notes
   WHERE id = p_batch_id
  RETURNING * INTO v_batch;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch % does not exist', p_batch_id USING ERRCODE = 'P0001';
  END IF;

  -- Carried over unchanged from the client: every unit becomes 'closed'
  -- whatever the resolution was. See the note at the top of this file — that
  -- is an open question for BUG-032, not something to settle here.
  UPDATE public.inventory_units
     SET status = 'closed'
   WHERE manufacturer_batch_id = p_batch_id;

  RETURN v_batch;
END;
$function$;

-- ═══ Guards ══════════════════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.document_sequences WHERE seq_type = 'batch') THEN
    RAISE EXCEPTION 'Refusing to finish: the batch sequence row was not created.';
  END IF;
  IF to_regprocedure('public.create_manufacturer_batch(uuid[], text, text)') IS NULL
     OR to_regprocedure('public.mark_batch_sent(uuid, timestamptz, text)') IS NULL
     OR to_regprocedure('public.mark_batch_resolved(uuid, text, timestamptz, text)') IS NULL THEN
    RAISE EXCEPTION 'Refusing to finish: one of the batch RPCs was not created.';
  END IF;
  RAISE NOTICE 'BUG-029: batch numbering is sequence-backed and each batch action is one transaction.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Rolled-back probe: two batches in a row get consecutive numbers; deleting one
-- and creating another does not collide; a list containing an unknown unit id
-- is refused and writes nothing; a unit already in a batch cannot be re-batched.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
-- Point the client back at its inline logic; the RPCs can be dropped. That
-- restores the count-derived numbering and the unchecked second write.
