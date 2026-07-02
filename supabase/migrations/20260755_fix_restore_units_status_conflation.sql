-- ============================================================================
-- Bug found 2026-07-02 while extending DB test coverage to restore_units.
--
-- restore_units(p_unit_ids, p_doc_type, p_doc_id, p_actor_email, p_to_status)
-- set `reservation_status = p_to_status` UNCONDITIONALLY, reusing the same
-- parameter for both of the two orthogonal status axes CLAUDE.md's own
-- architecture notes say must never be conflated: `status` (physical/RMA
-- lifecycle: active_rma/company_stock/sent_to_manufacturer/closed) vs
-- `reservation_status` (funnel state: available/reserved/delivered,
-- CHECK-constrained to exactly those three values).
--
-- The function's own documented "damaged/scrapped return" path calls it with
-- p_to_status='active_rma' — which is a valid `status` value but NOT a valid
-- `reservation_status` value, so that call raised a CHECK constraint
-- violation. Masked in production because the only current caller,
-- creditNotes.restoreUnits(), always passes p_to_status='available'.
--
-- Fix: reservation_status always resolves to 'available' (a restore always
-- means "no longer committed to a document" from the funnel's perspective —
-- the only sensible outcome regardless of which physical status the unit is
-- returning to). `status` is set to 'active_rma' only when that's what the
-- caller specified for the physical axis, otherwise left unchanged — same
-- behavior as before for that column.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.restore_units(
  p_unit_ids    uuid[],
  p_doc_type    text,
  p_doc_id      uuid,
  p_actor_email text,
  p_to_status   text DEFAULT 'available'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit_id uuid;
BEGIN
  FOREACH v_unit_id IN ARRAY p_unit_ids
  LOOP
    UPDATE public.inventory_units
    SET
      reservation_status = 'available',
      status             = CASE
                             WHEN p_to_status = 'active_rma' THEN 'active_rma'
                             ELSE status
                           END
    WHERE id = v_unit_id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit_id, p_doc_type, p_doc_id, 'restore', 1, 'delivered', p_to_status, p_actor_email);
  END LOOP;
END;
$$;
