-- ═══════════════════════════════════════════════════════════════════════════
--  Purchasing Redesign — activities can now relate to purchase documents
--  (step 4 of 7)
--
--  The approval-pool pattern (an `activities` row with type='approval') is
--  being extended to Vendor Invoices (submit-for-approval flow) and the
--  Purchasing detail pages will render an ActivityChatter history feed for
--  both Purchase Orders and Vendor Invoices. `chk_activity_related_type`
--  (20260623_crm_activities.sql) currently only allows
--  lead/deal/customer/contact — widened here as a pure superset. NOT VALID
--  (matching the original), so no existing row is touched.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.activities
  DROP CONSTRAINT IF EXISTS chk_activity_related_type;

ALTER TABLE public.activities
  ADD CONSTRAINT chk_activity_related_type
  CHECK (related_type IN ('lead', 'deal', 'customer', 'contact', 'purchase_order', 'vendor_invoice'))
  NOT VALID;
