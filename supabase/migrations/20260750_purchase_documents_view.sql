-- ═══════════════════════════════════════════════════════════════════════════
--  v_purchase_documents: unified view powering the "All" tab on /purchasing.
--  Same UNION-of-tables pattern as v_sales_documents (20260720) — inherits
--  RLS from the underlying tables since it's a plain view (no SECURITY
--  DEFINER), same as that one.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.v_purchase_documents AS

  SELECT
    id,
    'proforma_invoice' AS doc_type,
    pi_code            AS doc_code,
    vendor_id,
    created_by,
    status             AS doc_status,
    total,
    created_at,
    updated_at,
    NULL::date         AS type_specific_date,
    NULL::text         AS type_specific_date_label
  FROM public.proforma_invoices

  UNION ALL

  SELECT
    id,
    'purchase_order'      AS doc_type,
    po_code                AS doc_code,
    vendor_id,
    created_by,
    status                 AS doc_status,
    total,
    created_at,
    updated_at,
    expected_delivery_date AS type_specific_date,
    'expected_delivery_date' AS type_specific_date_label
  FROM public.purchase_orders

  UNION ALL

  SELECT
    id,
    'vendor_invoice'  AS doc_type,
    vi_code           AS doc_code,
    vendor_id,
    created_by,
    status            AS doc_status,
    total,
    created_at,
    NULL::timestamptz AS updated_at,
    invoice_date      AS type_specific_date,
    'invoice_date'    AS type_specific_date_label
  FROM public.vendor_invoices;
