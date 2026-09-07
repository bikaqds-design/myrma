-- Stop parts stock going silently wrong.
-- (Audit finding BUG-030, database half.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- `adjust_part_quantity` clamped instead of refusing:
--
--   SET quantity = GREATEST(0, parts.quantity + p_delta)
--
-- So adding 5 of a part with 3 in stock succeeded. The ticket recorded 5
-- consumed, the parts table went to 0, and the missing 2 were accounted for
-- nowhere — with no error for anyone to notice. Stock drifts from reality one
-- silent clamp at a time, and the drift is invisible precisely because the
-- operation reports success.
--
-- It also returned no rows when `p_id` matched nothing, which the caller read
-- as an empty result rather than as "that part does not exist".
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- Refuse the adjustment when it would take the balance below zero, and say by
-- how much. `GREATEST` is gone: a quantity that would be negative is a bug in
-- the caller or a genuine shortage, and both deserve to be seen. Also raises
-- when the part does not exist.
--
-- The authorisation check is unchanged (non-viewer staff).
--
-- ── What this does NOT fix ───────────────────────────────────────────────────
--
-- The second half of BUG-030 is that `ticketParts.add()` calls this RPC and
-- *then* inserts into `ticket_parts` as two separate statements: if the insert
-- fails, stock is decremented with no consumption record, and `remove()` has
-- the mirror problem. Making those atomic needs a single RPC that does both,
-- which is a larger change to the client contract. This migration removes the
-- silent-drift half; the atomicity half remains open and is recorded as such in
-- the report rather than implied to be closed.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
DECLARE
  v_negative integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'adjust_part_quantity') THEN
    RAISE EXCEPTION 'Refusing to apply: adjust_part_quantity() does not exist.';
  END IF;

  -- Any part already sitting at a negative balance would make the new check
  -- refuse every further adjustment on it, including corrections.
  SELECT count(*) INTO v_negative FROM public.parts WHERE quantity < 0;
  IF v_negative > 0 THEN
    RAISE EXCEPTION
      'Refusing to apply: % part(s) already have a negative quantity; correct them first or the new check will block adjustments. Nothing has been changed.',
      v_negative;
  END IF;
END
$do$;

-- ═══ The function ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.adjust_part_quantity(p_id uuid, p_delta integer)
RETURNS TABLE(id uuid, quantity integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_current integer;
  v_name    text;
BEGIN
  IF NOT (public.rma_is_staff() AND public.rma_user_role() <> 'viewer') THEN
    RAISE EXCEPTION 'Not authorized to adjust part quantities' USING ERRCODE = 'P0001';
  END IF;

  -- Lock the row: two technicians consuming the last unit at the same moment
  -- would otherwise both read the same balance and both pass the check.
  SELECT parts.quantity, parts.part_name INTO v_current, v_name
    FROM public.parts WHERE parts.id = p_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Part % does not exist', p_id USING ERRCODE = 'P0001';
  END IF;

  -- Was GREATEST(0, ...), which silently swallowed the shortfall.
  IF v_current + p_delta < 0 THEN
    RAISE EXCEPTION
      'Not enough % in stock: % available, % requested'
      , coalesce(v_name, 'part'), v_current, abs(p_delta)
      USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  UPDATE public.parts
     SET quantity     = parts.quantity + p_delta,
         updated_date = now()
   WHERE parts.id = p_id
  RETURNING parts.id, parts.quantity;
END;
$function$;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
BEGIN
  IF pg_get_functiondef('public.adjust_part_quantity(uuid, integer)'::regprocedure) LIKE '%GREATEST(0%' THEN
    RAISE EXCEPTION 'Refusing to finish: the silent clamp is still present.';
  END IF;
  RAISE NOTICE 'BUG-030 (half): parts adjustments now refuse to go negative instead of clamping.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- supabase/manual/20260860_verify_parts_negative_guard.sql
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
-- Restore GREATEST(0, parts.quantity + p_delta), which returns to losing stock
-- silently. Prefer correcting the caller.
