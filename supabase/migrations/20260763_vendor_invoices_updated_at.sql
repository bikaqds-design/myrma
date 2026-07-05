-- ═══════════════════════════════════════════════════════════════════════════
--  Purchasing Redesign — fix: vendor_invoices was missing updated_at
--
--  BUG (found 2026-07-05 while testing vendor_payments.sql against a live
--  database): record_vendor_payment / apply_vendor_payment_to_invoice /
--  _reverse_vendor_payment_application (20260760) all set
--  `vendor_invoices.updated_at = NOW()`, but that column was never added —
--  vendor_invoices' sibling table, purchase_orders, has had `updated_at`
--  since 20260747; vendor_invoices never did, and 20260757 (which added a
--  batch of new columns to both tables) missed it. Every affected call
--  failed with "column updated_at does not exist".
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.vendor_invoices
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;
