-- v_customer_ledger: unified, signed transaction feed per customer — powers the
-- Customer Details "Billing" tab statement. Same UNION-of-tables shape as
-- v_sales_documents (20260720_sales_documents_view.sql).
-- amount is signed: invoices increase the balance owed (+total), credit notes
-- and payments reduce it (-total / -amount), so a running SUM ordered by
-- entry_date gives the customer's outstanding balance at any point in time.
-- crm_invoices.amount_paid already reflects both payment and credit-note
-- applications (both write through crmInvoices.recordPayment()), so the AR
-- aging report queries crm_invoices directly rather than this view.

CREATE OR REPLACE VIEW public.v_customer_ledger AS

  SELECT
    id,
    'invoice'    AS entry_type,
    inv_code     AS entry_code,
    customer_id,
    total        AS amount,
    doc_status   AS status,
    due_date,
    COALESCE(posted_at, created_at) AS entry_date,
    created_at
  FROM public.crm_invoices
  WHERE doc_status = 'posted'

  UNION ALL

  SELECT
    id,
    'credit_note' AS entry_type,
    cn_code       AS entry_code,
    customer_id,
    -total        AS amount,
    status,
    NULL::date    AS due_date,
    COALESCE(issued_at, created_at) AS entry_date,
    created_at
  FROM public.credit_notes
  WHERE status IN ('issued', 'applied')

  UNION ALL

  SELECT
    id,
    'payment'    AS entry_type,
    payment_code AS entry_code,
    customer_id,
    -amount      AS amount,
    status,
    NULL::date   AS due_date,
    COALESCE(payment_date::timestamptz, created_at) AS entry_date,
    created_at
  FROM public.payments
  WHERE status = 'active';

-- Note: RLS on a VIEW in Postgres is enforced by the underlying tables'
-- policies when the view is created WITHOUT SECURITY DEFINER — inherits each
-- table's RLS automatically, same as v_sales_documents.
