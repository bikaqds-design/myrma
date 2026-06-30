-- ────────────────────────────────────────────────────────────────────────────
-- CRM Sprint 6 — Archive flag for all sales documents
--
-- Policy: sales documents are NEVER hard-deleted or removed from the system.
-- When a document must leave the main document tabs (for any reason) it is
-- ARCHIVED — hidden from the type tabs and surfaced in a dedicated "Archive"
-- tab, from which it can be restored. (Archiving is intended for admins/
-- managers only once the roles system is rebuilt.)
--
-- Idempotent: IF NOT EXISTS on every column; CREATE OR REPLACE on the view.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.quotations   ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
ALTER TABLE public.quotations   ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.quotations   ADD COLUMN IF NOT EXISTS archived_by text;

ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS archived_by text;

ALTER TABLE public.crm_invoices ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
ALTER TABLE public.crm_invoices ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.crm_invoices ADD COLUMN IF NOT EXISTS archived_by text;

ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS archived_by text;

-- Recreate the unified view to expose `archived` + `archived_at`.
-- (CREATE OR REPLACE allows appending columns to the end of the select list.)
CREATE OR REPLACE VIEW public.v_sales_documents AS

  SELECT
    id, 'quotation' AS doc_type, qt_code AS doc_code, customer_id, assigned_rep, created_by,
    status AS doc_status, NULL::text AS payment_status, total, created_at, updated_at,
    validity_until AS type_specific_date, 'validity_until' AS type_specific_date_label,
    archived, archived_at
  FROM public.quotations

  UNION ALL

  SELECT
    id, 'sales_order', so_code, customer_id, assigned_rep, created_by,
    status, NULL::text, total, created_at, updated_at,
    delivery_date, 'delivery_date', archived, archived_at
  FROM public.sales_orders

  UNION ALL

  SELECT
    id, 'invoice', inv_code, customer_id, assigned_rep, created_by,
    doc_status, payment_status, total, created_at, updated_at,
    due_date, 'due_date', archived, archived_at
  FROM public.crm_invoices

  UNION ALL

  SELECT
    id, 'credit_note', cn_code, customer_id, assigned_rep, created_by,
    status, NULL::text, total, created_at, updated_at,
    issued_at, 'issued_date', archived, archived_at
  FROM public.credit_notes;
