-- credit_notes: the only legal way to reduce or cancel a posted invoice.
-- type drives whether inventory is restocked (rma_return = yes, all others = no).
-- cn_code is NULL until issue() assigns it via nextval_for_type('credit_note').

CREATE TABLE IF NOT EXISTS public.credit_notes (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- cn_code is NULL on drafts; assigned on issue() via nextval_for_type RPC.
  -- Format: CN-YYYY-NNNNN (year-reset, gapless sequential).
  cn_code               text        UNIQUE,
  type                  text        NOT NULL
                                    CHECK (type IN (
                                      'rma_return','rebate','discount','correction')),
  source_invoice_id     uuid        REFERENCES public.crm_invoices(id) ON DELETE SET NULL,
  -- Denormalized for PDF printing (legally required reference to original invoice)
  source_invoice_number text,
  -- Only populated for rma_return type
  ticket_id             uuid,
  customer_id           uuid        NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  status                text        NOT NULL DEFAULT 'draft'
                                    CHECK (status IN ('draft','issued','applied','voided')),
  -- line_items array: { product_id?, product_name, qty, unit_price, restock, warehouse_id? }
  line_items            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  subtotal              numeric(12,2) NOT NULL DEFAULT 0,
  tax_amount            numeric(12,2) NOT NULL DEFAULT 0,
  total                 numeric(12,2) NOT NULL DEFAULT 0,
  applied_amount        numeric(12,2) NOT NULL DEFAULT 0,
  remaining_balance     numeric(12,2) NOT NULL DEFAULT 0,
  reason                text        NOT NULL,
  -- affects_inventory is derived from type; stored for fast querying.
  -- True only for rma_return — rebate/discount/correction never move stock.
  affects_inventory     boolean     GENERATED ALWAYS AS (type = 'rma_return') STORED,
  restock_status        text        NOT NULL DEFAULT 'not_applicable'
                                    CHECK (restock_status IN (
                                      'not_applicable','pending','restocked')),
  assigned_rep          text,
  created_by            text        NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT NOW(),
  updated_at            timestamptz NOT NULL DEFAULT NOW(),
  issued_at             timestamptz
);

CREATE INDEX IF NOT EXISTS credit_notes_invoice_idx  ON public.credit_notes (source_invoice_id);
CREATE INDEX IF NOT EXISTS credit_notes_customer_idx ON public.credit_notes (customer_id);
CREATE INDEX IF NOT EXISTS credit_notes_status_idx   ON public.credit_notes (status);
CREATE INDEX IF NOT EXISTS credit_notes_type_idx     ON public.credit_notes (type);

CREATE OR REPLACE FUNCTION public.set_credit_notes_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_credit_notes_updated_at ON public.credit_notes;
CREATE TRIGGER trg_credit_notes_updated_at
  BEFORE UPDATE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.set_credit_notes_updated_at();

-- RLS
ALTER TABLE public.credit_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_credit_notes" ON public.credit_notes;
CREATE POLICY "staff_read_credit_notes"
  ON public.credit_notes
  FOR SELECT
  USING (
    public.rma_is_manager_or_above()
    OR (
      public.rma_is_staff()
      AND (
        assigned_rep = public.rma_current_user_email()
        OR created_by = public.rma_current_user_email()
      )
    )
  );

DROP POLICY IF EXISTS "staff_insert_credit_notes" ON public.credit_notes;
CREATE POLICY "staff_insert_credit_notes"
  ON public.credit_notes
  FOR INSERT
  WITH CHECK (public.rma_is_staff());

DROP POLICY IF EXISTS "manager_update_credit_notes" ON public.credit_notes;
CREATE POLICY "manager_update_credit_notes"
  ON public.credit_notes
  FOR UPDATE
  USING (
    public.rma_is_manager_or_above()
    OR assigned_rep = public.rma_current_user_email()
    OR created_by  = public.rma_current_user_email()
  );

DROP POLICY IF EXISTS "admin_delete_credit_notes" ON public.credit_notes;
CREATE POLICY "admin_delete_credit_notes"
  ON public.credit_notes
  FOR DELETE
  USING (public.rma_is_admin());

-- issue_credit_note: assigns the gapless CN- code and locks the credit note.
-- Called by creditNotes.issue() in the API layer.
CREATE OR REPLACE FUNCTION public.issue_credit_note(p_cn_id uuid, p_actor_email text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code    text;
  v_status  text;
  v_total   numeric(12,2);
BEGIN
  SELECT status, total INTO v_status, v_total
  FROM public.credit_notes
  WHERE id = p_cn_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Credit note not found: %', p_cn_id;
  END IF;

  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Credit note % is already % — cannot issue again', p_cn_id, v_status;
  END IF;

  v_code := public.nextval_for_type('credit_note');

  UPDATE public.credit_notes
  SET
    cn_code           = v_code,
    status            = 'issued',
    remaining_balance = v_total,
    issued_at         = NOW(),
    updated_at        = NOW()
  WHERE id = p_cn_id;

  RETURN v_code;
END;
$$;
