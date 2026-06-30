-- v_sales_documents: unified view powering the "All" tab in the Invoicing page.
-- UNIONs all four document tables with a doc_type discriminator.
-- Only includes the columns needed for the list view — detail pages query
-- their own tables directly.

CREATE OR REPLACE VIEW public.v_sales_documents AS

  SELECT
    id,
    'quotation'       AS doc_type,
    qt_code           AS doc_code,
    customer_id,
    assigned_rep,
    created_by,
    status            AS doc_status,
    NULL::text        AS payment_status,
    total,
    created_at,
    updated_at,
    validity_until    AS type_specific_date,
    'validity_until'  AS type_specific_date_label
  FROM public.quotations

  UNION ALL

  SELECT
    id,
    'sales_order'     AS doc_type,
    so_code           AS doc_code,
    customer_id,
    assigned_rep,
    created_by,
    status            AS doc_status,
    NULL::text        AS payment_status,
    total,
    created_at,
    updated_at,
    delivery_date     AS type_specific_date,
    'delivery_date'   AS type_specific_date_label
  FROM public.sales_orders

  UNION ALL

  SELECT
    id,
    'invoice'         AS doc_type,
    inv_code          AS doc_code,
    customer_id,
    assigned_rep,
    created_by,
    doc_status,
    payment_status,
    total,
    created_at,
    updated_at,
    due_date          AS type_specific_date,
    'due_date'        AS type_specific_date_label
  FROM public.crm_invoices

  UNION ALL

  SELECT
    id,
    'credit_note'     AS doc_type,
    cn_code           AS doc_code,
    customer_id,
    assigned_rep,
    created_by,
    status            AS doc_status,
    NULL::text        AS payment_status,
    total,
    created_at,
    updated_at,
    issued_at         AS type_specific_date,
    'issued_date'     AS type_specific_date_label
  FROM public.credit_notes;

-- Note: RLS on a VIEW in Postgres is enforced by the underlying tables'
-- policies when the view is created WITHOUT SECURITY DEFINER. This view
-- inherits each table's RLS automatically — no separate policy needed.
-- If querying this view returns empty for a staff user, check that their
-- assigned_rep / created_by matches their email on each underlying table.
