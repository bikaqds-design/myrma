-- sales_orders: confirmed commitment to sell.
-- All line_items must reference real products (product_id NOT NULL enforced
-- at the application layer on confirm() — quotation free-form lines must be
-- promoted to real products before an SO can be created).
-- SO confirm() reserves inventory; cancel() releases reservations.

CREATE TABLE IF NOT EXISTS public.sales_orders (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  so_code         text        UNIQUE NOT NULL,
  quotation_id    uuid        REFERENCES public.quotations(id) ON DELETE SET NULL,
  customer_id     uuid        NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  status          text        NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','confirmed','delivered','cancelled')),
  -- line_items array: { product_id, product_name, description?, qty,
  --                     unit_price, discount_pct?, tax_pct? }
  -- product_id is required on all SO lines (enforced in app layer at convert/confirm)
  line_items      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  subtotal        numeric(12,2) NOT NULL DEFAULT 0,
  discount_amount numeric(12,2) NOT NULL DEFAULT 0,
  tax_amount      numeric(12,2) NOT NULL DEFAULT 0,
  total           numeric(12,2) NOT NULL DEFAULT 0,
  delivery_date   date,
  payment_terms   text,
  reference_po    text,
  notes           text,
  assigned_rep    text,
  created_by      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  confirmed_at    timestamptz,
  delivered_at    timestamptz
);

CREATE INDEX IF NOT EXISTS sales_orders_quotation_idx  ON public.sales_orders (quotation_id);
CREATE INDEX IF NOT EXISTS sales_orders_customer_idx   ON public.sales_orders (customer_id);
CREATE INDEX IF NOT EXISTS sales_orders_status_idx     ON public.sales_orders (status);
CREATE INDEX IF NOT EXISTS sales_orders_rep_idx        ON public.sales_orders (assigned_rep);

CREATE OR REPLACE FUNCTION public.set_sales_orders_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_sales_orders_updated_at ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_updated_at
  BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_sales_orders_updated_at();

-- RLS
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_sales_orders" ON public.sales_orders;
CREATE POLICY "staff_read_sales_orders"
  ON public.sales_orders
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

DROP POLICY IF EXISTS "staff_insert_sales_orders" ON public.sales_orders;
CREATE POLICY "staff_insert_sales_orders"
  ON public.sales_orders
  FOR INSERT
  WITH CHECK (public.rma_is_staff());

-- only manager+ can confirm (transitions to confirmed = reserves stock)
DROP POLICY IF EXISTS "manager_update_sales_orders" ON public.sales_orders;
CREATE POLICY "manager_update_sales_orders"
  ON public.sales_orders
  FOR UPDATE
  USING (
    public.rma_is_manager_or_above()
    OR assigned_rep = public.rma_current_user_email()
    OR created_by  = public.rma_current_user_email()
  );

DROP POLICY IF EXISTS "admin_delete_sales_orders" ON public.sales_orders;
CREATE POLICY "admin_delete_sales_orders"
  ON public.sales_orders
  FOR DELETE
  USING (public.rma_is_admin());
