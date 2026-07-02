-- ============================================================================
-- AUDIT 2026-07-02 — Money-layer hardening
-- Closes CRIT-1 (SECURITY DEFINER money RPCs had no role guard / no REVOKE),
-- CRIT-2 (record_payment did not validate allocation sum or customer match),
-- CRIT-3 (actor identity was client-supplied / spoofable),
-- HIGH-2 (non-atomic client-side applyToInvoice → transactional RPCs).
--
-- Idempotent: CREATE OR REPLACE + guarded DO blocks. Safe to re-run.
-- ============================================================================


-- ── CRIT-3 helper contract ──────────────────────────────────────────────────
-- Inside a SECURITY DEFINER function auth.jwt() still reflects the CALLING
-- user's request claims (PostgREST sets request.jwt.claims per request,
-- independent of the definer role), so public.rma_current_user_email() and the
-- role helpers evaluate against the real caller. We therefore DERIVE the actor
-- server-side and only fall back to the passed-in value for genuine
-- service-role/system callers that carry no JWT email.


-- ── record_payment (hardened) ────────────────────────────────────────────────
-- CRIT-1: manager+ guard. CRIT-2: per-allocation running-sum + customer-match
-- + posted checks with FOR UPDATE. CRIT-3: server-derived actor.
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
  v_code   text;
  v_id     uuid;
  v_actor  text;
  v_alloc  record;
  v_sum    numeric(12,2) := 0;
  v_inv    record;
BEGIN
  -- CRIT-1: authorization
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to record payments';
  END IF;

  -- CRIT-3: trust the JWT, not the parameter
  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  v_code := public.nextval_for_type('payment');

  INSERT INTO public.payments (
    payment_code, customer_id, amount, unapplied_amount,
    method, reference_number, payment_date, notes, created_by
  )
  VALUES (
    v_code, p_customer_id, p_amount, p_amount,
    p_method, p_reference_number,
    COALESCE(p_payment_date, CURRENT_DATE),
    p_notes, v_actor
  )
  RETURNING id INTO v_id;

  -- Apply allocations atomically (Invariant A2)
  FOR v_alloc IN
    SELECT
      (x->>'invoice_id')::uuid AS invoice_id,
      (x->>'amount')::numeric  AS amount
    FROM jsonb_array_elements(p_allocations) AS x
    WHERE (x->>'amount')::numeric > 0
  LOOP
    -- CRIT-2: allocations may never exceed the payment amount
    v_sum := v_sum + v_alloc.amount;
    IF v_sum > p_amount THEN
      RAISE EXCEPTION
        'Allocations (%) exceed payment amount (%)', v_sum, p_amount;
    END IF;

    -- CRIT-2 + M1: lock the invoice, verify it exists, is posted, and belongs
    -- to the paying customer
    SELECT id, customer_id, total, amount_paid
      INTO v_inv
    FROM public.crm_invoices
    WHERE id = v_alloc.invoice_id
      AND doc_status = 'posted'
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice % is not a posted invoice', v_alloc.invoice_id;
    END IF;

    IF v_inv.customer_id <> p_customer_id THEN
      RAISE EXCEPTION
        'Invoice % belongs to a different customer', v_alloc.invoice_id;
    END IF;

    -- Insert application row; sync_payment_balance trigger recomputes unapplied
    INSERT INTO public.payment_applications (
      payment_id, invoice_id, amount_applied, applied_by
    )
    VALUES (v_id, v_alloc.invoice_id, v_alloc.amount, v_actor);

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
    WHERE id = v_alloc.invoice_id;
  END LOOP;

  RETURN v_id;
END;
$$;


-- ── issue_credit_note (hardened) ─────────────────────────────────────────────
-- CRIT-1: manager+ guard. CRIT-3: server-derived actor. Body otherwise
-- identical to 20260735 (assign code, apply to source invoice in same tx).
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
  v_actor         text;
  v_inv_remaining numeric(12,2);
  v_apply_amount  numeric(12,2);
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to issue credit notes';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

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

  IF v_cn.source_invoice_id IS NOT NULL THEN
    SELECT GREATEST(total - amount_paid, 0) INTO v_inv_remaining
    FROM public.crm_invoices
    WHERE id = v_cn.source_invoice_id
      AND doc_status = 'posted'
    FOR UPDATE;

    IF FOUND AND v_inv_remaining > 0 THEN
      v_apply_amount := LEAST(v_cn.total, v_inv_remaining);

      INSERT INTO public.credit_note_applications (
        credit_note_id, invoice_id, amount_applied, applied_by
      )
      VALUES (p_cn_id, v_cn.source_invoice_id, v_apply_amount, v_actor);

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


-- ── sync_payment_balance (de-clamped) ────────────────────────────────────────
-- CRIT-2 backstop: compute the TRUE unapplied balance (no GREATEST clamp) so
-- that any over-allocation — even via a direct payment_applications INSERT that
-- bypasses record_payment — drives unapplied_amount negative and trips the
-- CHECK constraint below, aborting the transaction.
CREATE OR REPLACE FUNCTION public.sync_payment_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment_id uuid;
  v_amount     numeric(12,2);
  v_applied    numeric(12,2);
BEGIN
  v_payment_id := COALESCE(NEW.payment_id, OLD.payment_id);

  SELECT amount INTO v_amount
  FROM public.payments WHERE id = v_payment_id;

  SELECT COALESCE(SUM(amount_applied), 0) INTO v_applied
  FROM public.payment_applications WHERE payment_id = v_payment_id;

  UPDATE public.payments
  SET unapplied_amount = v_amount - v_applied,
      updated_at = NOW()
  WHERE id = v_payment_id;

  RETURN NULL;
END;
$$;


-- ── CRIT-2: unapplied_amount may never go negative ───────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_payments_unapplied_nonneg'
      AND conrelid = 'public.payments'::regclass
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT chk_payments_unapplied_nonneg
      CHECK (unapplied_amount >= 0);
  END IF;
END $$;


-- ── apply_payment_to_invoice (new, transactional) ────────────────────────────
-- HIGH-2: replaces the non-atomic read-then-write in payments.applyToInvoice.
-- Guards, validates unapplied balance + customer + posted, applies and updates
-- the invoice balance in one transaction (trigger recomputes unapplied).
CREATE OR REPLACE FUNCTION public.apply_payment_to_invoice(
  p_payment_id  uuid,
  p_invoice_id  uuid,
  p_amount      numeric,
  p_actor_email text
)
RETURNS uuid   -- payment_applications id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor text;
  v_pay   record;
  v_inv   record;
  v_app   uuid;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to apply payments';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Applied amount must be positive';
  END IF;

  SELECT id, customer_id, status, unapplied_amount
    INTO v_pay
  FROM public.payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found: %', p_payment_id;
  END IF;
  IF v_pay.status <> 'active' THEN
    RAISE EXCEPTION 'Payment must be active to apply (current: %)', v_pay.status;
  END IF;
  IF p_amount > v_pay.unapplied_amount THEN
    RAISE EXCEPTION 'Amount % exceeds unapplied balance %',
      p_amount, v_pay.unapplied_amount;
  END IF;

  SELECT id, customer_id, total, amount_paid
    INTO v_inv
  FROM public.crm_invoices
  WHERE id = p_invoice_id
    AND doc_status = 'posted'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % is not a posted invoice', p_invoice_id;
  END IF;
  IF v_inv.customer_id <> v_pay.customer_id THEN
    RAISE EXCEPTION 'Invoice % belongs to a different customer', p_invoice_id;
  END IF;

  INSERT INTO public.payment_applications (
    payment_id, invoice_id, amount_applied, applied_by
  )
  VALUES (p_payment_id, p_invoice_id, p_amount, v_actor)
  RETURNING id INTO v_app;

  UPDATE public.crm_invoices
  SET
    amount_paid    = LEAST(amount_paid + p_amount, total),
    payment_status = CASE
      WHEN LEAST(amount_paid + p_amount, total) >= total THEN 'paid'
      WHEN LEAST(amount_paid + p_amount, total) > 0     THEN 'partial'
      ELSE 'unpaid'
      END,
    paid_at = CASE
      WHEN LEAST(amount_paid + p_amount, total) >= total THEN NOW()
      ELSE paid_at
      END,
    updated_at = NOW()
  WHERE id = p_invoice_id;

  RETURN v_app;
END;
$$;


-- ── apply_credit_note_to_invoice (new, transactional) ────────────────────────
-- HIGH-2: replaces the non-atomic (and invoice-balance-missing) client path in
-- creditNotes.applyToInvoice. Same guard/validation/atomicity shape.
CREATE OR REPLACE FUNCTION public.apply_credit_note_to_invoice(
  p_cn_id       uuid,
  p_invoice_id  uuid,
  p_amount      numeric,
  p_actor_email text
)
RETURNS uuid   -- credit_note_applications id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor text;
  v_cn    record;
  v_inv   record;
  v_app   uuid;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to apply credit notes';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Applied amount must be positive';
  END IF;

  SELECT id, customer_id, status, remaining_balance
    INTO v_cn
  FROM public.credit_notes
  WHERE id = p_cn_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found: %', p_cn_id;
  END IF;
  IF v_cn.status <> 'issued' THEN
    RAISE EXCEPTION 'Credit note must be issued to apply (current: %)', v_cn.status;
  END IF;
  IF p_amount > v_cn.remaining_balance THEN
    RAISE EXCEPTION 'Amount % exceeds remaining balance %',
      p_amount, v_cn.remaining_balance;
  END IF;

  SELECT id, customer_id, total, amount_paid
    INTO v_inv
  FROM public.crm_invoices
  WHERE id = p_invoice_id
    AND doc_status = 'posted'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % is not a posted invoice', p_invoice_id;
  END IF;
  IF v_inv.customer_id <> v_cn.customer_id THEN
    RAISE EXCEPTION 'Invoice % belongs to a different customer', p_invoice_id;
  END IF;

  INSERT INTO public.credit_note_applications (
    credit_note_id, invoice_id, amount_applied, applied_by
  )
  VALUES (p_cn_id, p_invoice_id, p_amount, v_actor)
  RETURNING id INTO v_app;

  UPDATE public.crm_invoices
  SET
    amount_paid    = LEAST(amount_paid + p_amount, total),
    payment_status = CASE
      WHEN LEAST(amount_paid + p_amount, total) >= total THEN 'paid'
      WHEN LEAST(amount_paid + p_amount, total) > 0     THEN 'partial'
      ELSE 'unpaid'
      END,
    paid_at = CASE
      WHEN LEAST(amount_paid + p_amount, total) >= total THEN NOW()
      ELSE paid_at
      END,
    updated_at = NOW()
  WHERE id = p_invoice_id;

  RETURN v_app;
END;
$$;


-- ── CRIT-1: lock down EXECUTE ────────────────────────────────────────────────
-- Default Postgres grants EXECUTE to PUBLIC. Revoke, then grant only to real
-- authenticated users (and service_role for server-side callers). anon can no
-- longer reach these via /rest/v1/rpc/*.
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.record_payment(uuid, numeric, text, text, date, text, text, jsonb)',
    'public.issue_credit_note(uuid, text)',
    'public.apply_payment_to_invoice(uuid, uuid, numeric, text)',
    'public.apply_credit_note_to_invoice(uuid, uuid, numeric, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    BEGIN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXCEPTION WHEN undefined_object THEN NULL;
    END;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    BEGIN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    EXCEPTION WHEN undefined_object THEN NULL;
    END;
  END LOOP;
END $$;
