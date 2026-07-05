-- ═══════════════════════════════════════════════════════════════════════════
--  Purchasing Redesign — v_purchase_documents rebuild (step 7 of 7)
--
--  Down to 2 branches (proforma_invoice is gone — see 20260757). Adds
--  payment_status/archived/archived_at columns for parity with
--  v_sales_documents (20260722_sales_documents_archive.sql) — powers the
--  redesigned Purchasing list's Archive tab and the Vendor Invoice payment
--  status pill.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.v_purchase_documents AS

  SELECT
    id,
    'purchase_order'         AS doc_type,
    po_code                  AS doc_code,
    vendor_id,
    created_by,
    status                   AS doc_status,
    NULL::text               AS payment_status,
    total,
    created_at,
    updated_at,
    expected_delivery_date   AS type_specific_date,
    'expected_delivery_date' AS type_specific_date_label,
    archived,
    archived_at
  FROM public.purchase_orders

  UNION ALL

  SELECT
    id,
    'vendor_invoice'  AS doc_type,
    vi_code           AS doc_code,
    vendor_id,
    created_by,
    status            AS doc_status,
    payment_status,
    total,
    created_at,
    NULL::timestamptz AS updated_at,
    due_date          AS type_specific_date,
    'due_date'        AS type_specific_date_label,
    archived,
    archived_at
  FROM public.vendor_invoices;
