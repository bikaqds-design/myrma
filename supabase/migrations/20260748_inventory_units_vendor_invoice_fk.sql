-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 9 — Purchase Module: inventory_units.vendor_invoice_id
--
--  Traces every serialized unit back to the vendor invoice it was received
--  against. Nullable — units that predate this sprint (RMA-workflow-created,
--  or received via Sprint 8's interim manual receive_stock) have no vendor
--  invoice to point to.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.inventory_units
  ADD COLUMN IF NOT EXISTS vendor_invoice_id uuid REFERENCES public.vendor_invoices(id);

CREATE INDEX IF NOT EXISTS inv_units_vendor_invoice_idx
  ON public.inventory_units (vendor_invoice_id);
