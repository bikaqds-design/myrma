-- ═══════════════════════════════════════════════════════════════════════════
--  Purchasing Redesign — v_vendor_ledger (step 6 of 7)
--
--  AP mirror of v_customer_ledger (20260730): a unified, signed transaction
--  feed per vendor. amount is signed: a payable vendor invoice increases the
--  balance owed (+total), a vendor payment reduces it (-amount) — a running
--  SUM ordered by entry_date gives the outstanding payable at any point.
--  Plain view (no SECURITY DEFINER) — inherits RLS from the underlying
--  tables, same as v_customer_ledger and v_purchase_documents.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.v_vendor_ledger AS

  SELECT
    id,
    'vendor_invoice' AS entry_type,
    vi_code          AS entry_code,
    vendor_id,
    total            AS amount,
    status,
    due_date,
    COALESCE(approved_at, created_at) AS entry_date,
    created_at
  FROM public.vendor_invoices
  WHERE status IN ('approved', 'partially_received', 'received')

  UNION ALL

  SELECT
    id,
    'vendor_payment' AS entry_type,
    payment_code     AS entry_code,
    vendor_id,
    -amount          AS amount,
    status,
    NULL::date       AS due_date,
    COALESCE(payment_date::timestamptz, created_at) AS entry_date,
    created_at
  FROM public.vendor_payments
  WHERE status = 'active';
