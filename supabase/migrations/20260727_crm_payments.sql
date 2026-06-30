-- payments: a customer payment receipt (cash/bank transfer/check/card/other).
-- payment_code is NULL until record() assigns it via nextval_for_type('payment').
-- unapplied_amount tracks any portion not yet allocated to an invoice (a
-- customer credit/prepayment sitting on file) — kept in sync by a trigger on
-- payment_applications, mirroring sync_credit_note_balance for credit notes.

CREATE TABLE IF NOT EXISTS public.payments (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_code      text        UNIQUE,
  customer_id       uuid        NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  amount            numeric(12,2) NOT NULL CHECK (amount > 0),
  unapplied_amount  numeric(12,2) NOT NULL DEFAULT 0,
  method            text        NOT NULL
                                CHECK (method IN (
                                  'cash','bank_transfer','check','card','other')),
  reference_number  text,
  payment_date      date        NOT NULL DEFAULT CURRENT_DATE,
  notes             text,
  status            text        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','voided')),
  created_by        text        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  updated_at        timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payments_customer_idx ON public.payments (customer_id);
CREATE INDEX IF NOT EXISTS payments_status_idx   ON public.payments (status);

CREATE OR REPLACE FUNCTION public.set_payments_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_payments_updated_at ON public.payments;
CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.set_payments_updated_at();

-- RLS
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_payments" ON public.payments;
CREATE POLICY "staff_read_payments"
  ON public.payments
  FOR SELECT
  USING (
    public.rma_is_manager_or_above()
    OR (
      public.rma_is_staff()
      AND created_by = public.rma_current_user_email()
    )
  );

DROP POLICY IF EXISTS "staff_insert_payments" ON public.payments;
CREATE POLICY "staff_insert_payments"
  ON public.payments
  FOR INSERT
  WITH CHECK (public.rma_is_staff());

DROP POLICY IF EXISTS "manager_update_payments" ON public.payments;
CREATE POLICY "manager_update_payments"
  ON public.payments
  FOR UPDATE
  USING (
    public.rma_is_manager_or_above()
    OR created_by = public.rma_current_user_email()
  );

DROP POLICY IF EXISTS "admin_delete_payments" ON public.payments;
CREATE POLICY "admin_delete_payments"
  ON public.payments
  FOR DELETE
  USING (public.rma_is_admin());

-- payment_applications: tracks which invoices a payment has been allocated to.
-- Supports a single payment covering multiple invoices, and partial allocation.

CREATE TABLE IF NOT EXISTS public.payment_applications (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id     uuid        NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  invoice_id     uuid        NOT NULL REFERENCES public.crm_invoices(id) ON DELETE CASCADE,
  amount_applied numeric(12,2) NOT NULL CHECK (amount_applied > 0),
  applied_date   timestamptz NOT NULL DEFAULT NOW(),
  applied_by     text        NOT NULL,
  UNIQUE (payment_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS payment_applications_payment_idx ON public.payment_applications (payment_id);
CREATE INDEX IF NOT EXISTS payment_applications_invoice_idx ON public.payment_applications (invoice_id);

-- RLS
ALTER TABLE public.payment_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_payment_applications" ON public.payment_applications;
CREATE POLICY "staff_read_payment_applications"
  ON public.payment_applications
  FOR SELECT
  USING (public.rma_is_staff());

DROP POLICY IF EXISTS "manager_insert_payment_applications" ON public.payment_applications;
CREATE POLICY "manager_insert_payment_applications"
  ON public.payment_applications
  FOR INSERT
  WITH CHECK (public.rma_is_manager_or_above());

DROP POLICY IF EXISTS "admin_delete_payment_applications" ON public.payment_applications;
CREATE POLICY "admin_delete_payment_applications"
  ON public.payment_applications
  FOR DELETE
  USING (public.rma_is_admin());

-- Trigger: after any application insert/delete, recalculate the payment's
-- unapplied_amount — mirrors sync_credit_note_balance for credit notes.
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
  SET
    unapplied_amount = GREATEST(v_amount - v_applied, 0),
    updated_at        = NOW()
  WHERE id = v_payment_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_payment_balance ON public.payment_applications;
CREATE TRIGGER trg_sync_payment_balance
  AFTER INSERT OR DELETE OR UPDATE OF amount_applied
  ON public.payment_applications
  FOR EACH ROW EXECUTE FUNCTION public.sync_payment_balance();

-- record_payment: assigns the gapless PAY- code and sets the initial
-- unapplied_amount (before any allocations are inserted). Called by
-- payments.record() in the API layer.
CREATE OR REPLACE FUNCTION public.record_payment(
  p_customer_id      uuid,
  p_amount           numeric,
  p_method           text,
  p_reference_number text,
  p_payment_date     date,
  p_notes            text,
  p_actor_email      text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text;
  v_id   uuid;
BEGIN
  v_code := public.nextval_for_type('payment');

  INSERT INTO public.payments (
    payment_code, customer_id, amount, unapplied_amount,
    method, reference_number, payment_date, notes, created_by
  )
  VALUES (
    v_code, p_customer_id, p_amount, p_amount,
    p_method, p_reference_number, COALESCE(p_payment_date, CURRENT_DATE), p_notes, p_actor_email
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
