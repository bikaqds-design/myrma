-- ============================================================================
-- 20260893_quote_edit_while_awaiting_approval.sql
-- A quotation awaiting approval ('sent') is approved on the figures it was
-- sent with. Until now update_quotation let its lines, total, validity date
-- and payment terms change while it waited, and the approver then accepted
-- figures nobody had asked them to approve (open since 20260883).
--
-- Now a change to what the customer is offered — the lines (and so the
-- total), the validity date or the payment terms — sends a sent quotation
-- back to 'draft' in the same statement. It must be sent for approval again,
-- and an approval clicked on the old request is refused by the transition
-- guard (draft -> accepted is not a legal move). Notes, the customer
-- reference and the assigned rep do not affect what is approved and leave
-- it 'sent'. The screens send the lines back on every save; an unchanged set
-- rebuilds an identical copy, so saving without changing the offer keeps the
-- quote 'sent'.
--
-- Purchase orders need no change: update_purchase_order edits a draft only
-- (20260888), so a PO awaiting confirmation cannot be edited at all.
--
-- Changed by rewriting one statement of the live definition, counted first
-- (20260867's pattern).
-- ============================================================================

DO $$
DECLARE
  v_def  text;
  v_old  text := '    assigned_rep    = v_rep
  WHERE id = p_id
  RETURNING * INTO v_row;';
  v_new  text := '    assigned_rep    = v_rep,
    -- A sent quotation awaits approval of exactly these figures (20260893):
    -- a change to what the customer is offered sends it back to draft.
    status          = CASE WHEN v_qt.status = ''sent''
                            AND (v_items IS DISTINCT FROM v_qt.line_items
                                 OR v_tot IS DISTINCT FROM v_qt.total
                                 OR (v_f ? ''validity_until'' AND v_valid IS DISTINCT FROM v_qt.validity_until)
                                 OR (v_f ? ''payment_terms'' AND (v_f->>''payment_terms'') IS DISTINCT FROM v_qt.payment_terms))
                           THEN ''draft'' ELSE status END
  WHERE id = p_id
  RETURNING * INTO v_row;';
  v_have integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'update_quotation';
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: update_quotation holds the final UPDATE % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END $$;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'update_quotation'
                    AND pg_get_functiondef(p.oid) LIKE '%THEN ''draft'' ELSE status END%') THEN
    RAISE EXCEPTION 'Refusing to finish: update_quotation does not send a changed sent quotation back to draft';
  END IF;
END $$;
