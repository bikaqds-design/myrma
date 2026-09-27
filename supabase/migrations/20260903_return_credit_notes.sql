-- ============================================================================
-- 20260903_return_credit_notes.sql
-- P-05b — a return's credit note is made from the return. Design and the
-- owner's decisions: docs/P05_RETURNS_REFUNDS.md (goods first).
-- ============================================================================
-- create_credit_note_from_return(return, actor) makes a draft 'rma_return'
-- credit note for exactly what a confirmed return brought back: one line per
-- return line, at the order line's price, discount and tax (what the delivery's
-- invoice billed — create_invoice_from_delivery priced it from the same line),
-- against the delivery's posted invoice, reason code 'return'. It goes through
-- create_credit_note, so the caps (never more units than sold, never more than
-- the invoice has left) and the approval rules of 20260880 apply unchanged;
-- submitting and issuing it are the existing steps. The goods are already back,
-- so its restock_status is 'restocked' and no line asks for a restock.
--
-- Goods first: an 'rma_return' credit note against a delivery's invoice (and
-- not raised from an RMA ticket) can only be made this way, and a return's
-- note keeps the return's lines — update_credit_note refuses new ones. One live
-- note per return (a voided one frees it).
--
-- Pinned by src/test/returnCreditNotes.test.js; supabase/tests/return_credit_notes.sql
-- is the rolled-back reference script.
-- ============================================================================

ALTER TABLE public.credit_notes
  ADD COLUMN IF NOT EXISTS customer_return_id uuid REFERENCES public.customer_returns(id);
COMMENT ON COLUMN public.credit_notes.customer_return_id IS
  'P-05b: the return this credit note credits (create_credit_note_from_return). Its lines are what came back.';
CREATE UNIQUE INDEX IF NOT EXISTS credit_notes_one_live_per_return_idx ON public.credit_notes (customer_return_id)
  WHERE customer_return_id IS NOT NULL AND status <> 'voided';

-- ── 1. goods first: a return credit note on a delivery invoice comes from a return
DO $$
DECLARE
  v_def  text;
  v_old  text := E'  INSERT INTO public.credit_notes\n    (id, type, customer_id, status, line_items, reason, reason_code,';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.create_credit_note'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%-- 20260903:%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: create_credit_note holds its INSERT % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old,
       E'  -- 20260903: goods sold on a delivery come back by a return (P-05a), and\n'
    || E'  -- their credit note is made from it, so it credits exactly what came back.\n'
    || E'  -- An RMA ticket''s own credit note is left as it is.\n'
    || E'  IF p_type = ''rma_return'' AND p_ticket_id IS NULL AND v_inv.delivery_id IS NOT NULL\n'
    || E'     AND current_setting(''rma.cn_from_return'', true) IS DISTINCT FROM ''on'' THEN\n'
    || E'    RAISE EXCEPTION ''Goods from a delivery come back by a return: record the return, then make its credit note from it''\n'
    || E'      USING ERRCODE = ''P0001'';\n'
    || E'  END IF;\n\n'
    || v_old);
END $$;

-- ── 2. a return's credit note keeps the return's lines ──────────────────────
DO $$
DECLARE
  v_def  text;
  v_old  text := E'  IF p_lines IS NULL THEN\n';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.update_credit_note'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%-- 20260903:%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: update_credit_note holds its line reread % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old,
       E'  -- 20260903: a return''s credit note credits what came back, no more, no less\n'
    || E'  IF v_cn.customer_return_id IS NOT NULL AND v_sent THEN\n'
    || E'    RAISE EXCEPTION ''This credit note is for a return; its lines are what came back and cannot be changed''\n'
    || E'      USING ERRCODE = ''P0001'';\n'
    || E'  END IF;\n\n'
    || v_old);
END $$;

-- ── 3. create_credit_note_from_return ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_credit_note_from_return(p_return_id uuid, p_actor_email text)
RETURNS public.credit_notes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_r     public.customer_returns;
  v_inv   public.crm_invoices;
  v_lines jsonb;
  v_cn    public.credit_notes;
BEGIN
  -- as the return itself (owner decision: managers and above)
  IF v_actor IS NULL OR NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Only managers and above can credit a return' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_r FROM public.customer_returns WHERE id = p_return_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return % not found', p_return_id USING ERRCODE = 'P0001';
  END IF;
  IF v_r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Only a confirmed return is credited (this one is %)', v_r.status USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.credit_notes WHERE customer_return_id = p_return_id AND status <> 'voided') THEN
    RAISE EXCEPTION 'This return already has a credit note' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_inv FROM public.crm_invoices
   WHERE delivery_id = v_r.delivery_id AND doc_status = 'posted';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The delivery these goods left on has no posted invoice to credit' USING ERRCODE = 'P0001';
  END IF;

  -- what came back, at what the delivery's invoice charged for it
  SELECT jsonb_agg(jsonb_build_object(
           'product_id', sol.product_id, 'product_name', sol.product_name, 'description', sol.description,
           'qty', rl.qty, 'unit_price', sol.unit_price, 'discount_pct', sol.discount_pct, 'tax_pct', sol.tax_pct,
           'restock', false) ORDER BY rl.line_no)
    INTO v_lines
    FROM public.customer_return_lines rl
    JOIN public.delivery_lines dl ON dl.id = rl.delivery_line_id
    JOIN public.sales_order_lines sol ON sol.id = dl.sales_order_line_id
   WHERE rl.customer_return_id = p_return_id;

  PERFORM set_config('rma.cn_from_return', 'on', true);
  v_cn := public.create_credit_note(
    'rma_return', v_r.customer_id,
    COALESCE(v_r.reason, 'Goods returned') || ' (' || v_r.return_code || ')',
    'return', v_lines, v_inv.id, NULL, v_inv.assigned_rep, v_actor);
  PERFORM set_config('rma.cn_from_return', 'off', true);

  UPDATE public.credit_notes
     SET customer_return_id = p_return_id, restock_status = 'restocked'
   WHERE id = v_cn.id
  RETURNING * INTO v_cn;
  RETURN v_cn;
END
$fn$;
REVOKE ALL ON FUNCTION public.create_credit_note_from_return(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_credit_note_from_return(uuid, text) TO authenticated, service_role;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.create_credit_note_from_return(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: anon can make a credit note from a return';
  END IF;
  IF pg_get_functiondef('public.create_credit_note'::regproc) NOT LIKE '%Goods from a delivery come back by a return%'
     OR pg_get_functiondef('public.update_credit_note'::regproc) NOT LIKE '%This credit note is for a return%' THEN
    RAISE EXCEPTION 'Refusing to finish: create_credit_note or update_credit_note was not updated';
  END IF;
END $$;
