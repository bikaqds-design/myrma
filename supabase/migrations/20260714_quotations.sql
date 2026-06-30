-- quotations: the first sales document in the funnel.
-- Can be created from a Deal (deal_id set) or standalone (deal_id NULL).
-- Free-form product lines are allowed (product_id nullable on line_items).
-- Quotations never touch inventory.

CREATE TABLE IF NOT EXISTS public.quotations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  qt_code         text        UNIQUE NOT NULL,
  deal_id         uuid        REFERENCES public.deals(id) ON DELETE SET NULL,
  customer_id     uuid        NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  status          text        NOT NULL DEFAULT 'draft'
                              CHECK (status IN (
                                'draft','sent','accepted','declined','expired','cancelled')),
  -- line_items is always a JSONB array (never object) per CONSTITUTION rule.
  -- Each element: { product_id?, product_name, description?, qty, unit_price,
  --                 discount_pct?, tax_pct? }
  line_items      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  subtotal        numeric(12,2) NOT NULL DEFAULT 0,
  discount_amount numeric(12,2) NOT NULL DEFAULT 0,
  tax_amount      numeric(12,2) NOT NULL DEFAULT 0,
  total           numeric(12,2) NOT NULL DEFAULT 0,
  validity_until  date,
  payment_terms   text,
  reference_po    text,
  notes           text,
  -- "who" convention: email text, never uuid FK (matches assigned_rep on leads/deals)
  assigned_rep    text,
  created_by      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS quotations_deal_idx      ON public.quotations (deal_id);
CREATE INDEX IF NOT EXISTS quotations_customer_idx  ON public.quotations (customer_id);
CREATE INDEX IF NOT EXISTS quotations_status_idx    ON public.quotations (status);
CREATE INDEX IF NOT EXISTS quotations_rep_idx       ON public.quotations (assigned_rep);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_quotations_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_quotations_updated_at ON public.quotations;
CREATE TRIGGER trg_quotations_updated_at
  BEFORE UPDATE ON public.quotations
  FOR EACH ROW EXECUTE FUNCTION public.set_quotations_updated_at();

-- RLS
ALTER TABLE public.quotations ENABLE ROW LEVEL SECURITY;

-- sales_rep: read own (assigned_rep or created_by) and those linked to their deals
DROP POLICY IF EXISTS "sales_rep_read_quotations" ON public.quotations;
CREATE POLICY "sales_rep_read_quotations"
  ON public.quotations
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

-- manager+ can insert
DROP POLICY IF EXISTS "manager_insert_quotations" ON public.quotations;
CREATE POLICY "manager_insert_quotations"
  ON public.quotations
  FOR INSERT
  WITH CHECK (public.rma_is_manager_or_above() OR created_by = public.rma_current_user_email());

-- owner or manager+ can update (but not once accepted/expired — enforced in app layer)
DROP POLICY IF EXISTS "manager_update_quotations" ON public.quotations;
CREATE POLICY "manager_update_quotations"
  ON public.quotations
  FOR UPDATE
  USING (
    public.rma_is_manager_or_above()
    OR assigned_rep = public.rma_current_user_email()
    OR created_by  = public.rma_current_user_email()
  );

-- only admin can hard-delete; use status='cancelled' from application layer instead
DROP POLICY IF EXISTS "admin_delete_quotations" ON public.quotations;
CREATE POLICY "admin_delete_quotations"
  ON public.quotations
  FOR DELETE
  USING (public.rma_is_admin());
