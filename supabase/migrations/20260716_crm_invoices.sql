-- crm_invoices: the legal payment request document.
-- Two separate status fields (doc_status + payment_status) — never collapse
-- into one column. inv_code is NULL until post() assigns it via
-- nextval_for_type('invoice'). Once posted, lines are locked; corrections
-- go through a credit note, never an edit.

CREATE TABLE IF NOT EXISTS public.crm_invoices (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- inv_code is NULL on drafts; assigned on post() via nextval_for_type RPC.
  -- Format: INV-YYYY-NNNNN (year-reset, gapless sequential).
  inv_code         text        UNIQUE,
  so_id            uuid        REFERENCES public.sales_orders(id) ON DELETE SET NULL,
  customer_id      uuid        NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  -- Document lifecycle: governs editability. Lines lock when doc_status = 'posted'.
  doc_status       text        NOT NULL DEFAULT 'draft'
                               CHECK (doc_status IN ('draft','posted','cancelled')),
  -- Payment state: derived from amount_paid vs total. Never manually set via form.
  payment_status   text        NOT NULL DEFAULT 'unpaid'
                               CHECK (payment_status IN ('unpaid','partial','paid','reversed')),
  -- line_items array: { product_id, product_name, description?, qty,
  --                     unit_price, discount_pct?, tax_pct? }
  line_items       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  subtotal         numeric(12,2) NOT NULL DEFAULT 0,
  discount_amount  numeric(12,2) NOT NULL DEFAULT 0,
  tax_amount       numeric(12,2) NOT NULL DEFAULT 0,
  total            numeric(12,2) NOT NULL DEFAULT 0,
  amount_paid      numeric(12,2) NOT NULL DEFAULT 0,
  due_date         date,
  payment_terms    text,
  reference_po     text,
  notes            text,
  void_reason      text,
  assigned_rep     text,
  created_by       text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT NOW(),
  updated_at       timestamptz NOT NULL DEFAULT NOW(),
  posted_at        timestamptz,
  paid_at          timestamptz
);

CREATE INDEX IF NOT EXISTS crm_invoices_so_idx         ON public.crm_invoices (so_id);
CREATE INDEX IF NOT EXISTS crm_invoices_customer_idx   ON public.crm_invoices (customer_id);
CREATE INDEX IF NOT EXISTS crm_invoices_doc_status_idx ON public.crm_invoices (doc_status);
CREATE INDEX IF NOT EXISTS crm_invoices_pay_status_idx ON public.crm_invoices (payment_status);
CREATE INDEX IF NOT EXISTS crm_invoices_rep_idx        ON public.crm_invoices (assigned_rep);

CREATE OR REPLACE FUNCTION public.set_crm_invoices_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_crm_invoices_updated_at ON public.crm_invoices;
CREATE TRIGGER trg_crm_invoices_updated_at
  BEFORE UPDATE ON public.crm_invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_crm_invoices_updated_at();

-- RLS
ALTER TABLE public.crm_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_crm_invoices" ON public.crm_invoices;
CREATE POLICY "staff_read_crm_invoices"
  ON public.crm_invoices
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

DROP POLICY IF EXISTS "staff_insert_crm_invoices" ON public.crm_invoices;
CREATE POLICY "staff_insert_crm_invoices"
  ON public.crm_invoices
  FOR INSERT
  WITH CHECK (public.rma_is_staff());

DROP POLICY IF EXISTS "manager_update_crm_invoices" ON public.crm_invoices;
CREATE POLICY "manager_update_crm_invoices"
  ON public.crm_invoices
  FOR UPDATE
  USING (
    public.rma_is_manager_or_above()
    OR assigned_rep = public.rma_current_user_email()
    OR created_by  = public.rma_current_user_email()
  );

DROP POLICY IF EXISTS "admin_delete_crm_invoices" ON public.crm_invoices;
CREATE POLICY "admin_delete_crm_invoices"
  ON public.crm_invoices
  FOR DELETE
  USING (public.rma_is_admin());

-- post_invoice: assigns the gapless INV- code and locks the invoice.
-- Called by crmInvoices.post() in the API layer.
CREATE OR REPLACE FUNCTION public.post_invoice(p_invoice_id uuid, p_actor_email text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code    text;
  v_status  text;
BEGIN
  SELECT doc_status INTO v_status
  FROM public.crm_invoices
  WHERE id = p_invoice_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Invoice % is already % — cannot post again', p_invoice_id, v_status;
  END IF;

  -- Assign the gapless sequential code
  v_code := public.nextval_for_type('invoice');

  UPDATE public.crm_invoices
  SET
    inv_code    = v_code,
    doc_status  = 'posted',
    posted_at   = NOW(),
    updated_at  = NOW()
  WHERE id = p_invoice_id;

  RETURN v_code;
END;
$$;
