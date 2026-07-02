-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 9 — Purchase Module: vendors
--
--  Vendor master data. RLS mirrors every other CRM entity in this project:
--  staff read, manager+ write.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.vendors (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text        NOT NULL,
  contact_person text,
  email          text,
  phone          text,
  tax_id         text,
  payment_terms  text,
  created_by     text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz
);

ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_vendors" ON public.vendors;
CREATE POLICY "staff_read_vendors"
  ON public.vendors FOR SELECT
  USING (public.rma_is_staff());

DROP POLICY IF EXISTS "manager_write_vendors" ON public.vendors;
CREATE POLICY "manager_write_vendors"
  ON public.vendors FOR ALL
  USING (public.rma_is_manager_or_above())
  WITH CHECK (public.rma_is_manager_or_above());
