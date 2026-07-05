-- ═══════════════════════════════════════════════════════════════════════════
--  Purchasing Redesign — Vendor Payments (Accounts Payable) (step 5 of 7)
--
--  Full mirror of the customer AR layer (payments/payment_applications), but
--  built HARDENED FROM DAY ONE — this project's AR layer started unhardened
--  (20260727) and needed a follow-up pass (20260751 CRIT-1/2/3, 20260754
--  CRIT-5) to add role guards, server-derived actor, allocation validation,
--  the de-clamped balance trigger + CHECK(unapplied_amount >= 0), and
--  ledger-style reversals. There is no reason to repeat that unhardened
--  first draft here — every one of those fixes is folded in from the start.
--
--  vendor_id references public.brands(id) — Brands ARE the vendors (see
--  20260756/20260757). A vendor payment can only be applied to a Vendor
--  Invoice that is itself payable (approved/partially_received/received —
--  the AP analogue of AR's `doc_status = 'posted'` gate).
--
--  Reversal semantics match payment_applications exactly: a reversal is a
--  new, negative-signed row — never a delete or UPDATE of history — so the
--  same (payment, invoice) pair can be applied -> reversed -> re-applied.
--
--  One deliberate improvement over the AR precedent: the internal
--  `_reverse_vendor_payment_application` helper is included in the EXECUTE
--  lockdown below (the AR equivalent, `_reverse_payment_application`,
--  was never locked down — a minor pre-existing gap, out of scope to fix
--  here, but no reason to copy it into new code).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── vendor_payments ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.vendor_payments (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_code      text          UNIQUE,
  vendor_id         uuid          NOT NULL REFERENCES public.brands(id) ON DELETE RESTRICT,
  amount            numeric(12,2) NOT NULL CHECK (amount > 0),
  unapplied_amount  numeric(12,2) NOT NULL DEFAULT 0 CHECK (unapplied_amount >= 0),
  method            text          NOT NULL
                                  CHECK (method IN (
                                    'cash','bank_transfer','check','card','other')),
  reference_number  text,
  payment_date      date          NOT NULL DEFAULT CURRENT_DATE,
  notes             text,
  status            text          NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active','voided')),
  voided_at         timestamptz,
  voided_by         text,
  void_reason       text,
  created_by        text          NOT NULL,
  created_at        timestamptz   NOT NULL DEFAULT NOW(),
  updated_at        timestamptz   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vendor_payments_vendor_idx ON public.vendor_payments (vendor_id);
CREATE INDEX IF NOT EXISTS vendor_payments_status_idx ON public.vendor_payments (status);

CREATE OR REPLACE FUNCTION public.set_vendor_payments_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_vendor_payments_updated_at ON public.vendor_payments;
CREATE TRIGGER trg_vendor_payments_updated_at
  BEFORE UPDATE ON public.vendor_payments
  FOR EACH ROW EXECUTE FUNCTION public.set_vendor_payments_updated_at();

ALTER TABLE public.vendor_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_vendor_payments" ON public.vendor_payments;
CREATE POLICY "staff_read_vendor_payments"
  ON public.vendor_payments FOR SELECT
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_is_staff() AND created_by = public.rma_current_user_email())
  );

DROP POLICY IF EXISTS "staff_insert_vendor_payments" ON public.vendor_payments;
CREATE POLICY "staff_insert_vendor_payments"
  ON public.vendor_payments FOR INSERT
  WITH CHECK (public.rma_is_staff());

DROP POLICY IF EXISTS "manager_update_vendor_payments" ON public.vendor_payments;
CREATE POLICY "manager_update_vendor_payments"
  ON public.vendor_payments FOR UPDATE
  USING (public.rma_is_manager_or_above() OR created_by = public.rma_current_user_email());

DROP POLICY IF EXISTS "admin_delete_vendor_payments" ON public.vendor_payments;
CREATE POLICY "admin_delete_vendor_payments"
  ON public.vendor_payments FOR DELETE
  USING (public.rma_is_admin());

-- ── vendor_payment_applications ──────────────────────────────────────────────
-- No UNIQUE(payment_id, invoice_id) — reversal rows must allow re-applying
-- against the same pair (ledger semantics, matching payment_applications).

CREATE TABLE IF NOT EXISTS public.vendor_payment_applications (
  id                        uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id                uuid          NOT NULL REFERENCES public.vendor_payments(id) ON DELETE CASCADE,
  invoice_id                uuid          NOT NULL REFERENCES public.vendor_invoices(id) ON DELETE CASCADE,
  amount_applied            numeric(12,2) NOT NULL,
  applied_date              timestamptz   NOT NULL DEFAULT NOW(),
  applied_by                text          NOT NULL,
  is_reversal               boolean       NOT NULL DEFAULT false,
  reverses_application_id   uuid          REFERENCES public.vendor_payment_applications(id),
  reversal_reason           text,
  CONSTRAINT vendor_payment_applications_amount_applied_check CHECK (
    (is_reversal = false AND amount_applied > 0) OR
    (is_reversal = true  AND amount_applied < 0)
  )
);

CREATE INDEX IF NOT EXISTS vendor_payment_applications_payment_idx ON public.vendor_payment_applications (payment_id);
CREATE INDEX IF NOT EXISTS vendor_payment_applications_invoice_idx ON public.vendor_payment_applications (invoice_id);

ALTER TABLE public.vendor_payment_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_vendor_payment_applications" ON public.vendor_payment_applications;
CREATE POLICY "staff_read_vendor_payment_applications"
  ON public.vendor_payment_applications FOR SELECT
  USING (public.rma_is_staff());

DROP POLICY IF EXISTS "manager_insert_vendor_payment_applications" ON public.vendor_payment_applications;
CREATE POLICY "manager_insert_vendor_payment_applications"
  ON public.vendor_payment_applications FOR INSERT
  WITH CHECK (public.rma_is_manager_or_above());

DROP POLICY IF EXISTS "admin_delete_vendor_payment_applications" ON public.vendor_payment_applications;
CREATE POLICY "admin_delete_vendor_payment_applications"
  ON public.vendor_payment_applications FOR DELETE
  USING (public.rma_is_admin());

-- Balance-sync trigger — de-clamped from day one (no GREATEST), so any
-- over-allocation drives unapplied_amount negative and trips the table's
-- own CHECK(unapplied_amount >= 0), aborting the transaction.
CREATE OR REPLACE FUNCTION public.sync_vendor_payment_balance()
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
  FROM public.vendor_payments WHERE id = v_payment_id;

  SELECT COALESCE(SUM(amount_applied), 0) INTO v_applied
  FROM public.vendor_payment_applications WHERE payment_id = v_payment_id;

  UPDATE public.vendor_payments
  SET unapplied_amount = v_amount - v_applied,
      updated_at = NOW()
  WHERE id = v_payment_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_vendor_payment_balance ON public.vendor_payment_applications;
CREATE TRIGGER trg_sync_vendor_payment_balance
  AFTER INSERT OR DELETE OR UPDATE OF amount_applied
  ON public.vendor_payment_applications
  FOR EACH ROW EXECUTE FUNCTION public.sync_vendor_payment_balance();

-- ── vendor_invoices: money-tracking columns ──────────────────────────────────

ALTER TABLE public.vendor_invoices
  ADD COLUMN IF NOT EXISTS amount_paid    numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid'
                           CHECK (payment_status IN ('unpaid','partial','paid','reversed')),
  ADD COLUMN IF NOT EXISTS paid_at        timestamptz;

-- ── record_vendor_payment ─────────────────────────────────────────────────────
-- Manager+ guard, server-derived actor, per-allocation running-sum <= amount,
-- invoice must be payable (approved/partially_received/received) and belong
-- to the paying vendor, FOR UPDATE locks — same contract as record_payment.
CREATE OR REPLACE FUNCTION public.record_vendor_payment(
  p_vendor_id        uuid,
  p_amount           numeric,
  p_method           text,
  p_reference_number text,
  p_payment_date     date,
  p_notes            text,
  p_actor_email      text,
  p_allocations      jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid   -- vendor_payments id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code  text;
  v_id    uuid;
  v_actor text;
  v_alloc record;
  v_sum   numeric(12,2) := 0;
  v_inv   record;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to record vendor payments';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  v_code := public.nextval_for_type('vendor_payment');

  INSERT INTO public.vendor_payments (
    payment_code, vendor_id, amount, unapplied_amount,
    method, reference_number, payment_date, notes, created_by
  )
  VALUES (
    v_code, p_vendor_id, p_amount, p_amount,
    p_method, p_reference_number,
    COALESCE(p_payment_date, CURRENT_DATE),
    p_notes, v_actor
  )
  RETURNING id INTO v_id;

  FOR v_alloc IN
    SELECT
      (x->>'invoice_id')::uuid AS invoice_id,
      (x->>'amount')::numeric  AS amount
    FROM jsonb_array_elements(p_allocations) AS x
    WHERE (x->>'amount')::numeric > 0
  LOOP
    v_sum := v_sum + v_alloc.amount;
    IF v_sum > p_amount THEN
      RAISE EXCEPTION 'Allocations (%) exceed payment amount (%)', v_sum, p_amount;
    END IF;

    SELECT id, vendor_id, total, amount_paid
      INTO v_inv
    FROM public.vendor_invoices
    WHERE id = v_alloc.invoice_id
      AND status IN ('approved', 'partially_received', 'received')
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Vendor invoice % is not payable', v_alloc.invoice_id;
    END IF;
    IF v_inv.vendor_id <> p_vendor_id THEN
      RAISE EXCEPTION 'Vendor invoice % belongs to a different vendor', v_alloc.invoice_id;
    END IF;

    INSERT INTO public.vendor_payment_applications (
      payment_id, invoice_id, amount_applied, applied_by
    )
    VALUES (v_id, v_alloc.invoice_id, v_alloc.amount, v_actor);

    UPDATE public.vendor_invoices
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

-- ── apply_vendor_payment_to_invoice ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_vendor_payment_to_invoice(
  p_payment_id  uuid,
  p_invoice_id  uuid,
  p_amount      numeric,
  p_actor_email text
)
RETURNS uuid   -- vendor_payment_applications id
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
    RAISE EXCEPTION 'Not authorized to apply vendor payments';
  END IF;

  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Applied amount must be positive';
  END IF;

  SELECT id, vendor_id, status, unapplied_amount
    INTO v_pay
  FROM public.vendor_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor payment not found: %', p_payment_id;
  END IF;
  IF v_pay.status <> 'active' THEN
    RAISE EXCEPTION 'Vendor payment must be active to apply (current: %)', v_pay.status;
  END IF;
  IF p_amount > v_pay.unapplied_amount THEN
    RAISE EXCEPTION 'Amount % exceeds unapplied balance %', p_amount, v_pay.unapplied_amount;
  END IF;

  SELECT id, vendor_id, total, amount_paid
    INTO v_inv
  FROM public.vendor_invoices
  WHERE id = p_invoice_id
    AND status IN ('approved', 'partially_received', 'received')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor invoice % is not payable', p_invoice_id;
  END IF;
  IF v_inv.vendor_id <> v_pay.vendor_id THEN
    RAISE EXCEPTION 'Vendor invoice % belongs to a different vendor', p_invoice_id;
  END IF;

  INSERT INTO public.vendor_payment_applications (
    payment_id, invoice_id, amount_applied, applied_by
  )
  VALUES (p_payment_id, p_invoice_id, p_amount, v_actor)
  RETURNING id INTO v_app;

  UPDATE public.vendor_invoices
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

-- ── reversal (internal helper, no guard — callers apply manager+ check) ─────

CREATE OR REPLACE FUNCTION public._reverse_vendor_payment_application(
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
  FROM public.vendor_payment_applications
  WHERE id = p_application_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor payment application not found: %', p_application_id;
  END IF;
  IF v_app.is_reversal THEN
    RAISE EXCEPTION 'Cannot reverse a reversal row';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.vendor_payment_applications
    WHERE reverses_application_id = p_application_id
  ) THEN
    RAISE EXCEPTION 'This application has already been reversed';
  END IF;

  PERFORM 1 FROM public.vendor_invoices WHERE id = v_app.invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor invoice not found for application: %', v_app.invoice_id;
  END IF;

  INSERT INTO public.vendor_payment_applications (
    payment_id, invoice_id, amount_applied, applied_by,
    is_reversal, reverses_application_id, reversal_reason
  )
  VALUES (
    v_app.payment_id, v_app.invoice_id, -v_app.amount_applied, p_actor,
    true, p_application_id, p_reason
  )
  RETURNING id INTO v_new;

  IF FOUND THEN
    UPDATE public.vendor_invoices
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

CREATE OR REPLACE FUNCTION public.reverse_vendor_payment_application(
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
    RAISE EXCEPTION 'Not authorized to reverse a vendor payment application';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reversal reason is required';
  END IF;
  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);
  RETURN public._reverse_vendor_payment_application(p_application_id, p_reason, v_actor);
END;
$$;

CREATE OR REPLACE FUNCTION public.void_vendor_payment(
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
    RAISE EXCEPTION 'Not authorized to void a vendor payment';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A void reason is required';
  END IF;
  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);

  SELECT * INTO v_pay FROM public.vendor_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor payment not found: %', p_payment_id;
  END IF;
  IF v_pay.status = 'voided' THEN
    RAISE EXCEPTION 'Vendor payment is already voided';
  END IF;

  FOR v_app_id IN
    SELECT pa.id
    FROM public.vendor_payment_applications pa
    WHERE pa.payment_id = p_payment_id
      AND pa.is_reversal = false
      AND NOT EXISTS (
        SELECT 1 FROM public.vendor_payment_applications r
        WHERE r.reverses_application_id = pa.id
      )
  LOOP
    PERFORM public._reverse_vendor_payment_application(v_app_id, p_reason, v_actor);
  END LOOP;

  UPDATE public.vendor_payments
  SET status = 'voided', voided_at = NOW(), voided_by = v_actor, void_reason = p_reason
  WHERE id = p_payment_id;
END;
$$;

-- ── register the vendor_payment sequence (VP- prefix) ────────────────────────
-- Re-declares nextval_for_type — MUST keep every existing WHEN clause
-- (invoice/credit_note/payment/vendor_invoice) or those codes break.

INSERT INTO public.document_sequences (seq_type, last_value, seq_year)
VALUES ('vendor_payment', 0, EXTRACT(YEAR FROM NOW())::integer)
ON CONFLICT (seq_type) DO NOTHING;

CREATE OR REPLACE FUNCTION public.nextval_for_type(p_seq_type text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year     integer := EXTRACT(YEAR FROM NOW())::integer;
  v_next     integer;
  v_prefix   text;
BEGIN
  UPDATE public.document_sequences
  SET
    last_value = CASE WHEN seq_year = v_year THEN last_value + 1 ELSE 1 END,
    seq_year   = v_year
  WHERE seq_type = p_seq_type
  RETURNING last_value INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Unknown sequence type: %', p_seq_type;
  END IF;

  v_prefix := CASE p_seq_type
    WHEN 'invoice'        THEN 'INV'
    WHEN 'credit_note'    THEN 'CN'
    WHEN 'payment'        THEN 'PAY'
    WHEN 'vendor_invoice' THEN 'VI'
    WHEN 'vendor_payment' THEN 'VP'
    ELSE UPPER(p_seq_type)
  END;

  RETURN v_prefix || '-' || v_year::text || '-' || LPAD(v_next::text, 5, '0');
END;
$$;

-- ── EXECUTE lockdown ──────────────────────────────────────────────────────────

DO $$
DECLARE
  v_names text[] := ARRAY[
    'record_vendor_payment',
    'apply_vendor_payment_to_invoice',
    'reverse_vendor_payment_application',
    'void_vendor_payment',
    '_reverse_vendor_payment_application'
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
