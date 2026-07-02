-- ============================================================================
-- AUDIT 2026-07-02 — CRIT-5: payment / credit-note reversal
--
-- Closes the last open Critical: voiding an APPLIED payment or credit note was
-- blocked outright, with no way to correct a wrong amount/invoice/customer
-- (see CRIT-2) short of manual SQL. This adds the standard ledger fix: a
-- reversal is a new, negative-signed row in the SAME append-only application
-- table — never a delete or an UPDATE of history — exactly the pattern this
-- codebase already trusts for stock_moves.
--
-- Shape:
--   payment_applications / credit_note_applications gain is_reversal,
--   reverses_application_id, reversal_reason. The UNIQUE(payment_id/cn_id,
--   invoice_id) constraint is dropped — a ledger allows apply → reverse →
--   re-apply against the same pair, which a single-row-per-pair UNIQUE would
--   block forever after the first reversal. The CHECK on amount_applied is
--   relaxed so reversal rows carry the negative of what they reverse; the
--   existing SUM-based sync triggers (sync_payment_balance /
--   sync_credit_note_balance) already net these out correctly with no
--   further change to their arithmetic.
--
--   reverse_payment_application / reverse_credit_note_application: reverse
--   ONE application line (manager+, guarded, server-derived actor — same
--   contract as 20260751/20260753). Useful for the CRIT-2 scenario: a payment
--   applied to the wrong invoice can be corrected without voiding the whole
--   payment.
--
--   void_payment / void_credit_note: reverse EVERY still-active application
--   of a payment/CN, then mark it voided. This is what a "Void" button now
--   does even when the payment/CN has been applied — the exact fix the audit
--   asked for.
--
-- Side-fix: void_invoice's guard checked EXISTS(...) on the application
-- tables, which — once reversal rows exist — would find rows FOREVER (the
-- original + its reversal both remain) and block invoice voiding
-- permanently, even after everything was properly reversed. Rewritten to a
-- net-SUM check, matching the same nothing-net-applied test the reversal
-- functions use.
-- ============================================================================


-- ── payment_applications: ledger columns + relax constraints ────────────────

ALTER TABLE public.payment_applications
  ADD COLUMN IF NOT EXISTS is_reversal             boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reverses_application_id  uuid REFERENCES public.payment_applications(id),
  ADD COLUMN IF NOT EXISTS reversal_reason          text;

DO $$
DECLARE v_constraint_name text;
BEGIN
  -- Drop UNIQUE(payment_id, invoice_id) — a ledger must allow re-applying
  -- after a reversal, which a single-row-per-pair UNIQUE would prevent.
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.payment_applications'::regclass AND contype = 'u';
  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.payment_applications DROP CONSTRAINT %I', v_constraint_name);
  END IF;

  -- Relax amount_applied CHECK: positive for real applications, negative for
  -- reversal rows, never zero.
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.payment_applications'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%amount_applied%';
  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.payment_applications DROP CONSTRAINT %I', v_constraint_name);
  END IF;
END $$;

ALTER TABLE public.payment_applications
  ADD CONSTRAINT payment_applications_amount_applied_check
  CHECK (
    (is_reversal = false AND amount_applied > 0) OR
    (is_reversal = true  AND amount_applied < 0)
  );


-- ── credit_note_applications: same treatment ─────────────────────────────────

ALTER TABLE public.credit_note_applications
  ADD COLUMN IF NOT EXISTS is_reversal             boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reverses_application_id  uuid REFERENCES public.credit_note_applications(id),
  ADD COLUMN IF NOT EXISTS reversal_reason          text;

DO $$
DECLARE v_constraint_name text;
BEGIN
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.credit_note_applications'::regclass AND contype = 'u';
  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.credit_note_applications DROP CONSTRAINT %I', v_constraint_name);
  END IF;

  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.credit_note_applications'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%amount_applied%';
  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.credit_note_applications DROP CONSTRAINT %I', v_constraint_name);
  END IF;
END $$;

ALTER TABLE public.credit_note_applications
  ADD CONSTRAINT credit_note_applications_amount_applied_check
  CHECK (
    (is_reversal = false AND amount_applied > 0) OR
    (is_reversal = true  AND amount_applied < 0)
  );


-- ── payments / credit_notes: void audit-trail columns ────────────────────────

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS voided_at  timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by  text,
  ADD COLUMN IF NOT EXISTS void_reason text;

ALTER TABLE public.credit_notes
  ADD COLUMN IF NOT EXISTS voided_at  timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by  text,
  ADD COLUMN IF NOT EXISTS void_reason text;


-- ── sync_credit_note_balance: fix one-directional status flip ───────────────
-- Previously only flipped issued -> applied when exhausted, never back. A
-- reversal that drops applied amount below total must be able to flip
-- applied -> issued again, or the CN would show 'applied' with money owed.
CREATE OR REPLACE FUNCTION public.sync_credit_note_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cn_id   uuid;
  v_total   numeric(12,2);
  v_applied numeric(12,2);
BEGIN
  v_cn_id := COALESCE(NEW.credit_note_id, OLD.credit_note_id);

  SELECT total INTO v_total
  FROM public.credit_notes WHERE id = v_cn_id;

  SELECT COALESCE(SUM(amount_applied), 0) INTO v_applied
  FROM public.credit_note_applications WHERE credit_note_id = v_cn_id;

  UPDATE public.credit_notes
  SET
    applied_amount    = v_applied,
    remaining_balance = GREATEST(v_total - v_applied, 0),
    status = CASE
      WHEN v_applied >= v_total AND status = 'issued' THEN 'applied'
      WHEN v_applied <  v_total AND status = 'applied' THEN 'issued'
      ELSE status
    END,
    updated_at = NOW()
  WHERE id = v_cn_id;

  RETURN NULL;
END;
$$;


-- ── internal helpers (no guard — callers apply the manager+ check) ──────────

CREATE OR REPLACE FUNCTION public._reverse_payment_application(
  p_application_id uuid,
  p_reason         text,
  p_actor          text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app  record;
  v_inv  record;
  v_new  uuid;
BEGIN
  SELECT * INTO v_app
  FROM public.payment_applications
  WHERE id = p_application_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment application not found: %', p_application_id;
  END IF;
  IF v_app.is_reversal THEN
    RAISE EXCEPTION 'Cannot reverse a reversal row';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payment_applications
    WHERE reverses_application_id = p_application_id
  ) THEN
    RAISE EXCEPTION 'This application has already been reversed';
  END IF;

  SELECT id, total, amount_paid INTO v_inv
  FROM public.crm_invoices
  WHERE id = v_app.invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found for application: %', v_app.invoice_id;
  END IF;

  INSERT INTO public.payment_applications (
    payment_id, invoice_id, amount_applied, applied_by,
    is_reversal, reverses_application_id, reversal_reason
  )
  VALUES (
    v_app.payment_id, v_app.invoice_id, -v_app.amount_applied, p_actor,
    true, p_application_id, p_reason
  )
  RETURNING id INTO v_new;

  IF FOUND THEN
    UPDATE public.crm_invoices
    SET
      amount_paid    = GREATEST(amount_paid - v_app.amount_applied, 0),
      payment_status = CASE
        WHEN GREATEST(amount_paid - v_app.amount_applied, 0) >= total THEN 'paid'
        WHEN GREATEST(amount_paid - v_app.amount_applied, 0) > 0     THEN 'partial'
        ELSE 'unpaid'
        END,
      paid_at = CASE
        WHEN GREATEST(amount_paid - v_app.amount_applied, 0) >= total THEN paid_at
        ELSE NULL
        END,
      updated_at = NOW()
    WHERE id = v_app.invoice_id;
  END IF;

  RETURN v_new;
END;
$$;

CREATE OR REPLACE FUNCTION public._reverse_credit_note_application(
  p_application_id uuid,
  p_reason         text,
  p_actor          text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app record;
  v_new uuid;
BEGIN
  SELECT * INTO v_app
  FROM public.credit_note_applications
  WHERE id = p_application_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note application not found: %', p_application_id;
  END IF;
  IF v_app.is_reversal THEN
    RAISE EXCEPTION 'Cannot reverse a reversal row';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.credit_note_applications
    WHERE reverses_application_id = p_application_id
  ) THEN
    RAISE EXCEPTION 'This application has already been reversed';
  END IF;

  PERFORM 1 FROM public.crm_invoices WHERE id = v_app.invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found for application: %', v_app.invoice_id;
  END IF;

  INSERT INTO public.credit_note_applications (
    credit_note_id, invoice_id, amount_applied, applied_by,
    is_reversal, reverses_application_id, reversal_reason
  )
  VALUES (
    v_app.credit_note_id, v_app.invoice_id, -v_app.amount_applied, p_actor,
    true, p_application_id, p_reason
  )
  RETURNING id INTO v_new;

  IF FOUND THEN
    UPDATE public.crm_invoices
    SET
      amount_paid    = GREATEST(amount_paid - v_app.amount_applied, 0),
      payment_status = CASE
        WHEN GREATEST(amount_paid - v_app.amount_applied, 0) >= total THEN 'paid'
        WHEN GREATEST(amount_paid - v_app.amount_applied, 0) > 0     THEN 'partial'
        ELSE 'unpaid'
        END,
      paid_at = CASE
        WHEN GREATEST(amount_paid - v_app.amount_applied, 0) >= total THEN paid_at
        ELSE NULL
        END,
      updated_at = NOW()
    WHERE id = v_app.invoice_id;
  END IF;

  RETURN v_new;
END;
$$;


-- ── public, guarded entry points ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reverse_payment_application(
  p_application_id uuid,
  p_reason         text,
  p_actor_email    text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor text;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to reverse a payment application';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reversal reason is required';
  END IF;
  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);
  RETURN public._reverse_payment_application(p_application_id, p_reason, v_actor);
END;
$$;

CREATE OR REPLACE FUNCTION public.reverse_credit_note_application(
  p_application_id uuid,
  p_reason         text,
  p_actor_email    text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor text;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to reverse a credit note application';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reversal reason is required';
  END IF;
  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);
  RETURN public._reverse_credit_note_application(p_application_id, p_reason, v_actor);
END;
$$;

CREATE OR REPLACE FUNCTION public.void_payment(
  p_payment_id  uuid,
  p_reason      text,
  p_actor_email text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor  text;
  v_pay    record;
  v_app_id uuid;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to void a payment';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A void reason is required';
  END IF;
  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  SELECT * INTO v_pay FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found: %', p_payment_id;
  END IF;
  IF v_pay.status = 'voided' THEN
    RAISE EXCEPTION 'Payment is already voided';
  END IF;

  -- Reverse every application that hasn't already been reversed
  FOR v_app_id IN
    SELECT pa.id
    FROM public.payment_applications pa
    WHERE pa.payment_id = p_payment_id
      AND pa.is_reversal = false
      AND NOT EXISTS (
        SELECT 1 FROM public.payment_applications r
        WHERE r.reverses_application_id = pa.id
      )
  LOOP
    PERFORM public._reverse_payment_application(v_app_id, p_reason, v_actor);
  END LOOP;

  UPDATE public.payments
  SET status = 'voided', voided_at = NOW(), voided_by = v_actor, void_reason = p_reason
  WHERE id = p_payment_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.void_credit_note(
  p_cn_id       uuid,
  p_reason      text,
  p_actor_email text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor  text;
  v_cn     record;
  v_app_id uuid;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to void a credit note';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A void reason is required';
  END IF;
  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = p_cn_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found: %', p_cn_id;
  END IF;
  IF v_cn.status = 'voided' THEN
    RAISE EXCEPTION 'Credit note is already voided';
  END IF;

  FOR v_app_id IN
    SELECT ca.id
    FROM public.credit_note_applications ca
    WHERE ca.credit_note_id = p_cn_id
      AND ca.is_reversal = false
      AND NOT EXISTS (
        SELECT 1 FROM public.credit_note_applications r
        WHERE r.reverses_application_id = ca.id
      )
  LOOP
    PERFORM public._reverse_credit_note_application(v_app_id, p_reason, v_actor);
  END LOOP;

  UPDATE public.credit_notes
  SET status = 'voided', voided_at = NOW(), voided_by = v_actor, void_reason = p_reason
  WHERE id = p_cn_id;
END;
$$;


-- ── void_invoice: fix the now-permanent EXISTS guard ─────────────────────────
-- Body is otherwise unchanged from 20260734 — only the two blocking checks
-- change from "any row exists" to "net applied amount > 0", so that an
-- invoice whose payments/CNs have been fully reversed can be voided, while
-- one with a genuinely outstanding application still cannot.
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

  IF (
    SELECT COALESCE(SUM(amount_applied), 0)
    FROM public.payment_applications WHERE invoice_id = p_invoice_id
  ) > 0 THEN
    RAISE EXCEPTION 'Reverse payments before voiding';
  END IF;

  IF (
    SELECT COALESCE(SUM(amount_applied), 0)
    FROM public.credit_note_applications WHERE invoice_id = p_invoice_id
  ) > 0 THEN
    RAISE EXCEPTION 'Reverse credit notes before voiding';
  END IF;

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


-- ── Execute lockdown for the 6 new/changed public entry points ──────────────
-- (void_invoice keeps its existing grants from 20260752 — CREATE OR REPLACE
-- does not reset GRANTs. Only the genuinely new functions need this.)
DO $$
DECLARE
  v_names text[] := ARRAY[
    'reverse_payment_application',
    'reverse_credit_note_application',
    'void_payment',
    'void_credit_note'
  ];
  v_sig text;
BEGIN
  FOR v_sig IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY(v_names)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    BEGIN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_sig);
    EXCEPTION WHEN undefined_object THEN NULL;
    END;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_sig);
    BEGIN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
    EXCEPTION WHEN undefined_object THEN NULL;
    END;
  END LOOP;
END $$;
