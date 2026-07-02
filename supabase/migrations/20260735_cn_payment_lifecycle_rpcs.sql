-- Credit note + payment atomic RPCs. Closes H4c (CN issue + apply in one tx)
-- and H4d (payment record + allocations in one tx). Both also get FOR UPDATE
-- locks closing M1 for their respective flows.

-- ── issue_credit_note (extended) ────────────────────────────────────────────
-- Extends the existing RPC: still assigns the CN code and sets status, but
-- now also inserts the credit_note_applications row AND updates the linked
-- invoice's amount_paid/payment_status in the same transaction.
-- The sync_credit_note_balance trigger fires on the INSERT and keeps
-- credit_notes.applied_amount/remaining_balance in sync automatically.
CREATE OR REPLACE FUNCTION public.issue_credit_note(
  p_cn_id       uuid,
  p_actor_email text
)
RETURNS text   -- assigned cn_code
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cn            record;
  v_code          text;
  v_inv_remaining numeric(12,2);
  v_apply_amount  numeric(12,2);
BEGIN
  SELECT * INTO v_cn
  FROM public.credit_notes
  WHERE id = p_cn_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found: %', p_cn_id;
  END IF;

  IF v_cn.status <> 'draft' THEN
    RAISE EXCEPTION 'Credit note is already % — cannot issue again', v_cn.status;
  END IF;

  v_code := public.nextval_for_type('credit_note');

  UPDATE public.credit_notes
  SET
    cn_code           = v_code,
    status            = 'issued',
    remaining_balance = v_cn.total,
    issued_at         = NOW(),
    updated_at        = NOW()
  WHERE id = p_cn_id;

  -- Apply to source invoice in the same transaction (Invariant A1)
  IF v_cn.source_invoice_id IS NOT NULL THEN
    SELECT GREATEST(total - amount_paid, 0) INTO v_inv_remaining
    FROM public.crm_invoices
    WHERE id = v_cn.source_invoice_id
      AND doc_status = 'posted';

    IF FOUND AND v_inv_remaining > 0 THEN
      v_apply_amount := LEAST(v_cn.total, v_inv_remaining);

      -- Insert application row; sync_credit_note_balance trigger fires here
      INSERT INTO public.credit_note_applications (
        credit_note_id, invoice_id, amount_applied, applied_by
      )
      VALUES (p_cn_id, v_cn.source_invoice_id, v_apply_amount, p_actor_email);

      -- Update invoice balance in same tx
      UPDATE public.crm_invoices
      SET
        amount_paid    = LEAST(amount_paid + v_apply_amount, total),
        payment_status = CASE
          WHEN LEAST(amount_paid + v_apply_amount, total) >= total THEN 'paid'
          WHEN LEAST(amount_paid + v_apply_amount, total) > 0     THEN 'partial'
          ELSE 'unpaid'
          END,
        paid_at = CASE
          WHEN LEAST(amount_paid + v_apply_amount, total) >= total THEN NOW()
          ELSE paid_at
          END,
        updated_at = NOW()
      WHERE id = v_cn.source_invoice_id;
    END IF;
  END IF;

  RETURN v_code;
END;
$$;

-- ── record_payment (extended) ────────────────────────────────────────────────
-- Extends the existing RPC to accept p_allocations (JSONB array of
-- {invoice_id, amount} objects) and apply them within the same transaction.
-- The sync_payment_balance trigger fires on each payment_applications INSERT
-- and keeps payments.unapplied_amount in sync automatically.
-- The old 7-argument overload is dropped first so only the new 8-argument
-- version exists (prevents stale callers from silently using the old path).
DROP FUNCTION IF EXISTS public.record_payment(uuid, numeric, text, text, date, text, text);

CREATE OR REPLACE FUNCTION public.record_payment(
  p_customer_id      uuid,
  p_amount           numeric,
  p_method           text,
  p_reference_number text,
  p_payment_date     date,
  p_notes            text,
  p_actor_email      text,
  p_allocations      jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid   -- payment id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code  text;
  v_id    uuid;
  v_alloc record;
BEGIN
  v_code := public.nextval_for_type('payment');

  INSERT INTO public.payments (
    payment_code, customer_id, amount, unapplied_amount,
    method, reference_number, payment_date, notes, created_by
  )
  VALUES (
    v_code, p_customer_id, p_amount, p_amount,
    p_method, p_reference_number,
    COALESCE(p_payment_date, CURRENT_DATE),
    p_notes, p_actor_email
  )
  RETURNING id INTO v_id;

  -- Apply allocations atomically in the same transaction (Invariant A2)
  FOR v_alloc IN
    SELECT
      (x->>'invoice_id')::uuid AS invoice_id,
      (x->>'amount')::numeric  AS amount
    FROM jsonb_array_elements(p_allocations) AS x
    WHERE (x->>'amount')::numeric > 0
  LOOP
    -- Insert application row; sync_payment_balance trigger fires here
    INSERT INTO public.payment_applications (
      payment_id, invoice_id, amount_applied, applied_by
    )
    VALUES (v_id, v_alloc.invoice_id, v_alloc.amount, p_actor_email);

    -- Update invoice balance in same tx
    UPDATE public.crm_invoices
    SET
      amount_paid    = LEAST(amount_paid + v_alloc.amount, total),
      payment_status = CASE
        WHEN LEAST(amount_paid + v_alloc.amount, total) >= total THEN 'paid'
        WHEN LEAST(amount_paid + v_alloc.amount, total) > 0     THEN 'partial'
        ELSE 'unpaid'
        END,
      paid_at = CASE
        WHEN LEAST(amount_paid + v_alloc.amount, total) >= total THEN NOW()
        ELSE paid_at
        END,
      updated_at = NOW()
    WHERE id = v_alloc.invoice_id
      AND doc_status = 'posted';
  END LOOP;

  RETURN v_id;
END;
$$;
