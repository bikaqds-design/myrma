-- Invoice lifecycle RPCs: atomic post + guarded void. Closes H4b (post is
-- atomic with deliver), M4 (void blocked when applied), M1 (FOR UPDATE),
-- M5 (role checks in both RPCs), FR-010, FR-011.

-- ── post_invoice (replaces existing) ────────────────────────────────────────
-- Assigns the gapless INV code, sets status, and delivers reserved inventory
-- all in one transaction. The previous RPC only assigned the code; inventory
-- delivery was a separate TS await (gap that allowed posted-without-stock).
CREATE OR REPLACE FUNCTION public.post_invoice(
  p_invoice_id  uuid,
  p_actor_email text
)
RETURNS text   -- assigned inv_code
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv  record;
  v_code text;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to post invoices';
  END IF;

  SELECT * INTO v_inv
  FROM public.crm_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.doc_status <> 'draft' THEN
    RAISE EXCEPTION 'Invoice is already % — cannot post again', v_inv.doc_status;
  END IF;

  -- Assign gapless code inside this tx; rolls back if deliver_units fails below
  v_code := public.nextval_for_type('invoice');

  UPDATE public.crm_invoices
  SET
    inv_code   = v_code,
    doc_status = 'posted',
    posted_at  = NOW(),
    updated_at = NOW()
  WHERE id = p_invoice_id;

  -- Deliver inventory reserved by the linked SO — same transaction (Invariant I1)
  IF v_inv.so_id IS NOT NULL THEN
    PERFORM public.deliver_units('sales_order', v_inv.so_id, p_actor_email);
  END IF;

  RETURN v_code;
END;
$$;

-- ── void_invoice (new) ───────────────────────────────────────────────────────
-- Refuses to void if any payments or credit notes have been applied (M4).
-- For a clean posted-but-unpaid invoice, reverses the inventory delivery by
-- restoring delivered serialized units back to available via stock_moves lookup.
CREATE OR REPLACE FUNCTION public.void_invoice(
  p_invoice_id  uuid,
  p_reason      text,
  p_actor_email text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv      record;
  v_unit_ids uuid[];
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to void invoices';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A void reason is required';
  END IF;

  SELECT * INTO v_inv
  FROM public.crm_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.doc_status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted invoices can be voided (current: %)', v_inv.doc_status;
  END IF;

  -- Block if any payment has been applied (Invariant I2)
  IF EXISTS (
    SELECT 1 FROM public.payment_applications WHERE invoice_id = p_invoice_id
  ) THEN
    RAISE EXCEPTION 'Reverse payments/credit notes before voiding';
  END IF;

  -- Block if any credit note has been applied (Invariant I2)
  IF EXISTS (
    SELECT 1 FROM public.credit_note_applications WHERE invoice_id = p_invoice_id
  ) THEN
    RAISE EXCEPTION 'Reverse payments/credit notes before voiding';
  END IF;

  -- Restore serialized units that were delivered by the linked SO
  IF v_inv.so_id IS NOT NULL THEN
    SELECT array_agg(DISTINCT ref_id) INTO v_unit_ids
    FROM public.stock_moves
    WHERE doc_type  = 'sales_order'
      AND doc_id    = v_inv.so_id
      AND move_type = 'deliver'
      AND ref_type  = 'unit';

    IF v_unit_ids IS NOT NULL AND array_length(v_unit_ids, 1) > 0 THEN
      PERFORM public.restore_units(
        v_unit_ids, 'invoice', p_invoice_id, p_actor_email, 'available'
      );
    END IF;
  END IF;

  UPDATE public.crm_invoices
  SET
    doc_status     = 'cancelled',
    payment_status = 'reversed',
    void_reason    = p_reason,
    updated_at     = NOW()
  WHERE id = p_invoice_id;
END;
$$;
