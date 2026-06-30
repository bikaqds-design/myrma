-- credit_note_applications: tracks which invoices a credit note has been applied to.
-- Supports partial application across multiple invoices.
-- A trigger keeps credit_notes.applied_amount in sync and flips status
-- to 'applied' when remaining_balance reaches zero.

CREATE TABLE IF NOT EXISTS public.credit_note_applications (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id uuid        NOT NULL REFERENCES public.credit_notes(id) ON DELETE CASCADE,
  invoice_id     uuid        NOT NULL REFERENCES public.crm_invoices(id) ON DELETE CASCADE,
  amount_applied numeric(12,2) NOT NULL CHECK (amount_applied > 0),
  applied_date   timestamptz NOT NULL DEFAULT NOW(),
  applied_by     text        NOT NULL,
  UNIQUE (credit_note_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS cn_applications_cn_idx      ON public.credit_note_applications (credit_note_id);
CREATE INDEX IF NOT EXISTS cn_applications_invoice_idx ON public.credit_note_applications (invoice_id);

-- RLS
ALTER TABLE public.credit_note_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_cn_applications" ON public.credit_note_applications;
CREATE POLICY "staff_read_cn_applications"
  ON public.credit_note_applications
  FOR SELECT
  USING (public.rma_is_staff());

DROP POLICY IF EXISTS "manager_insert_cn_applications" ON public.credit_note_applications;
CREATE POLICY "manager_insert_cn_applications"
  ON public.credit_note_applications
  FOR INSERT
  WITH CHECK (public.rma_is_manager_or_above());

DROP POLICY IF EXISTS "admin_delete_cn_applications" ON public.credit_note_applications;
CREATE POLICY "admin_delete_cn_applications"
  ON public.credit_note_applications
  FOR DELETE
  USING (public.rma_is_admin());

-- Trigger: after any application insert/delete, recalculate the credit note's
-- applied_amount and remaining_balance, then flip status to 'applied' if exhausted.
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
      ELSE status
    END,
    updated_at = NOW()
  WHERE id = v_cn_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_cn_balance ON public.credit_note_applications;
CREATE TRIGGER trg_sync_cn_balance
  AFTER INSERT OR DELETE OR UPDATE OF amount_applied
  ON public.credit_note_applications
  FOR EACH ROW EXECUTE FUNCTION public.sync_credit_note_balance();
