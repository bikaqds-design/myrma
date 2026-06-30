-- Adds sent / accepted / declined to sales_orders.status so the SO can run
-- the same approval workflow as quotations (draft → sent → accepted → confirmed).
-- The existing constraint was an inline CHECK named sales_orders_status_check by
-- PostgreSQL's auto-naming convention; drop and re-add with the expanded list.

DO $$
BEGIN
  BEGIN
    ALTER TABLE public.sales_orders DROP CONSTRAINT sales_orders_status_check;
  EXCEPTION WHEN undefined_object THEN NULL;
  END;

  ALTER TABLE public.sales_orders
    ADD CONSTRAINT sales_orders_status_check
    CHECK (status IN ('draft','sent','accepted','declined','confirmed','delivered','cancelled'));
END $$;
