-- restore_units must only restore units the document actually delivered.
-- (Audit finding BUG-031.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- The function checked the caller's role and then trusted the id list:
--
--   FOREACH v_unit_id IN ARRAY p_unit_ids LOOP
--     UPDATE inventory_units SET reservation_status = 'available' WHERE id = v_unit_id;
--     INSERT INTO stock_moves (… from_status, …) VALUES (… 'delivered', …);
--   END LOOP;
--
-- Nothing tied a unit to the document being credited. A manager could pass ids
-- for units delivered on a *different* invoice, or units currently reserved for
-- somebody else's open sales order, and every one would be flipped to
-- 'available'. The sales order that still expects those units would then find
-- them gone at delivery time.
--
-- The ledger entry made it worse rather than recording it: `from_status` was
-- the literal `'delivered'` whatever the unit's real state was, so a unit taken
-- straight out of `reserved` was written into `stock_moves` as though it had
-- been delivered and returned. The audit trail agreed with the corruption.
--
-- ── The rule now enforced ────────────────────────────────────────────────────
--
-- A unit may be restored only if the document being credited is the one that
-- delivered it. Delivery is recorded against the SALES ORDER, not the invoice
-- (`stock_moves.doc_type = 'sales_order'`, `move_type = 'deliver'` — 25 such
-- rows today, and zero delivered against an invoice), so the chain is:
--
--   credit_note -> source_invoice_id -> crm_invoices.so_id -> deliver moves
--   invoice     -> crm_invoices.so_id -> deliver moves
--
-- and each unit must additionally still be sitting at `reservation_status =
-- 'delivered'`, which rejects a unit that was already restored once or that has
-- since been reserved again.
--
-- All-or-nothing: if any id fails, the whole call is refused. A partial restore
-- is how you end up with a half-corrected ledger nobody can reconcile.
--
-- `from_status` is now read from the unit rather than assumed.
--
-- ── Compatibility ────────────────────────────────────────────────────────────
--
-- Signature unchanged, so `creditNotes.restoreUnits()` and `void_invoice` keep
-- working. A `p_doc_type` this function cannot resolve to a sales order is
-- refused rather than waved through — failing closed on an unknown document
-- type is the point of the change.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='restore_units') THEN
    RAISE EXCEPTION 'Refusing to apply: restore_units() does not exist.';
  END IF;
END
$do$;

-- ═══ The function ════════════════════════════════════════════════════════════

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
SET search_path TO 'public'
AS $function$
DECLARE
  v_unit_id  uuid;
  v_so_id    uuid;
  v_from     text;
  v_bad      integer;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to restore units' USING ERRCODE = 'P0001';
  END IF;

  IF p_unit_ids IS NULL OR array_length(p_unit_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  -- ── Which sales order did this document deliver against? ──────────────────
  IF p_doc_type = 'credit_note' THEN
    SELECT i.so_id INTO v_so_id
      FROM public.credit_notes cn
      JOIN public.crm_invoices i ON i.id = cn.source_invoice_id
     WHERE cn.id = p_doc_id;

    IF v_so_id IS NULL THEN
      RAISE EXCEPTION
        'Credit note % is not linked to an invoice with a sales order, so there is nothing it could have delivered',
        p_doc_id USING ERRCODE = 'P0001';
    END IF;

  ELSIF p_doc_type IN ('invoice', 'crm_invoice') THEN
    SELECT i.so_id INTO v_so_id FROM public.crm_invoices i WHERE i.id = p_doc_id;

    IF v_so_id IS NULL THEN
      RAISE EXCEPTION
        'Invoice % is not linked to a sales order, so there is nothing it could have delivered',
        p_doc_id USING ERRCODE = 'P0001';
    END IF;

  ELSE
    -- Fail closed: an unrecognised document type cannot be checked, so it is
    -- not allowed to move stock.
    RAISE EXCEPTION
      'restore_units cannot verify ownership for document type %', p_doc_type
      USING ERRCODE = 'P0001';
  END IF;

  -- ── Every unit must have been delivered by that sales order, and still be
  --    sitting at 'delivered'. Checked as a set first, so the call is refused
  --    before anything is written.
  SELECT count(*) INTO v_bad
    FROM unnest(p_unit_ids) AS u(unit_id)
   WHERE NOT EXISTS (
           SELECT 1 FROM public.stock_moves sm
            WHERE sm.ref_type   = 'unit'
              AND sm.ref_id     = u.unit_id
              AND sm.move_type  = 'deliver'
              AND sm.doc_type   = 'sales_order'
              AND sm.doc_id     = v_so_id
         )
      OR NOT EXISTS (
           SELECT 1 FROM public.inventory_units iu
            WHERE iu.id = u.unit_id
              AND iu.reservation_status = 'delivered'
         );

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      '% of the % unit(s) were not delivered by this document, or are no longer in a delivered state. Nothing has been restored.',
      v_bad, array_length(p_unit_ids, 1)
      USING ERRCODE = 'P0001';
  END IF;

  -- ── Apply ─────────────────────────────────────────────────────────────────
  FOREACH v_unit_id IN ARRAY p_unit_ids
  LOOP
    SELECT reservation_status INTO v_from
      FROM public.inventory_units WHERE id = v_unit_id FOR UPDATE;

    UPDATE public.inventory_units
       SET reservation_status = 'available',
           status             = CASE WHEN p_to_status = 'active_rma' THEN 'active_rma' ELSE status END
     WHERE id = v_unit_id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      -- from_status read from the unit, not assumed to be 'delivered'.
      ('unit', v_unit_id, p_doc_type, p_doc_id, 'restore', 1, v_from, p_to_status, p_actor_email);
  END LOOP;
END;
$function$;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  v_def text := pg_get_functiondef('public.restore_units(uuid[], text, uuid, text, text)'::regprocedure);
BEGIN
  IF v_def NOT LIKE '%were not delivered by this document%' THEN
    RAISE EXCEPTION 'Refusing to finish: the ownership check is not present.';
  END IF;
  IF v_def LIKE '%1, ''delivered'', p_to_status%' THEN
    RAISE EXCEPTION 'Refusing to finish: from_status is still hard-coded.';
  END IF;
  RAISE NOTICE 'BUG-031: restore_units now verifies each unit was delivered by the document being credited.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Rolled-back probe: a unit delivered by the credit note's own source invoice
-- restores; a unit delivered by a different sales order is refused; a unit
-- currently 'reserved' is refused; an unknown doc_type is refused.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
-- Restoring the previous body returns the ability to free any unit under any
-- document, and to write a ledger entry that misstates where it came from.
