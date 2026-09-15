-- 20260860_sales_documents_list_view.sql
--
-- Server-side reads for the Sales Documents page. (Audit finding BUG-066, phase 5d.)
--
-- The page loaded every quotation, sales order, invoice and credit note
-- (v_sales_documents) and the customers they name, then did the tab split,
-- the tab counts, the search, the status and rep filters, the sort and the
-- paging in the browser. The Data API returns at most 1 000 rows per request,
-- so past that the list, its counts and its exports covered part of the
-- documents as if they were all.
--
--   v_sales_documents_list        v_sales_documents + the customer name the
--                                 page shows (the company, or the contact
--                                 person) and the keys its columns sort by
--   rma_sales_document_summary    per tab, how many documents it holds, and
--                                 the statuses and reps the filters offer
--
-- SECURITY INVOKER: RLS on the four document tables and on customers applies
-- as it did to the browser's own reads. Read-only; authenticated only.

-- ═══ The list view ═══════════════════════════════════════════════════════════
-- customer_sort is null when there is no name, so a nameless row sorts after
-- every name ("—" did). doc_code_sort / rep_sort are case-insensitive; a
-- missing total sorts as 0, as it displayed.

CREATE OR REPLACE VIEW public.v_sales_documents_list
WITH (security_invoker = true)
AS
SELECT s.*,
       x.customer_name,
       lower(x.customer_name) AS customer_sort,
       lower(coalesce(s.doc_code, '')) AS doc_code_sort,
       lower(coalesce(s.assigned_rep, '')) AS rep_sort,
       coalesce(s.total, 0) AS total_sort
  FROM public.v_sales_documents s
  LEFT JOIN public.customers c ON c.id = s.customer_id
  CROSS JOIN LATERAL (
    SELECT coalesce(nullif(c.company_name, ''), nullif(c.contact_person, '')) AS customer_name
  ) x;

COMMENT ON VIEW public.v_sales_documents_list IS
  'Sales documents with the customer name and sort keys the Sales Documents page shows. (BUG-066.)';

-- ═══ Tab counts and filter options ═══════════════════════════════════════════
-- Archived documents belong only to the Archive tab; every other tab holds the
-- active ones ('all', or one document type). A rep scoped to their own work
-- owns a document they are assigned to or raised — the policy's own test.
-- The status options are those present in the selected tab; the rep options
-- span every document the caller can see.

CREATE OR REPLACE FUNCTION public.rma_sales_document_summary(p_tab text, p_owner text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH docs AS (
    SELECT doc_type, doc_status, assigned_rep, archived
      FROM public.v_sales_documents
     WHERE p_owner IS NULL OR assigned_rep = p_owner OR created_by = p_owner
  ),
  in_tab AS (
    SELECT * FROM docs
     WHERE CASE WHEN p_tab = 'archive' THEN archived
                WHEN p_tab = 'all' OR p_tab IS NULL THEN NOT archived
                ELSE NOT archived AND doc_type = p_tab
           END
  )
  SELECT jsonb_build_object(
    'counts', jsonb_build_object(
      'all',         (SELECT count(*) FROM docs WHERE NOT archived),
      'quotation',   (SELECT count(*) FROM docs WHERE NOT archived AND doc_type = 'quotation'),
      'sales_order', (SELECT count(*) FROM docs WHERE NOT archived AND doc_type = 'sales_order'),
      'invoice',     (SELECT count(*) FROM docs WHERE NOT archived AND doc_type = 'invoice'),
      'credit_note', (SELECT count(*) FROM docs WHERE NOT archived AND doc_type = 'credit_note'),
      'archive',     (SELECT count(*) FROM docs WHERE archived)
    ),
    'statuses', coalesce((SELECT jsonb_agg(DISTINCT doc_status ORDER BY doc_status) FROM in_tab WHERE doc_status IS NOT NULL AND doc_status <> ''), '[]'::jsonb),
    'reps',     coalesce((SELECT jsonb_agg(DISTINCT assigned_rep ORDER BY assigned_rep) FROM docs WHERE assigned_rep IS NOT NULL AND assigned_rep <> ''), '[]'::jsonb)
  );
$fn$;

COMMENT ON FUNCTION public.rma_sales_document_summary(text, text) IS
  'Sales Documents tab counts and filter options, optionally for one owner. (BUG-066.)';

-- ═══ Grants ══════════════════════════════════════════════════════════════════

REVOKE ALL ON public.v_sales_documents_list FROM PUBLIC, anon;
GRANT SELECT ON public.v_sales_documents_list TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.rma_sales_document_summary(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_sales_document_summary(text, text) TO authenticated, service_role;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $guard$
DECLARE
  v_counts jsonb := public.rma_sales_document_summary('all') -> 'counts';
BEGIN
  IF (SELECT count(*) FROM public.v_sales_documents_list) <> (SELECT count(*) FROM public.v_sales_documents) THEN
    RAISE EXCEPTION 'Refusing to apply: v_sales_documents_list does not have one row per document';
  END IF;
  IF (v_counts->>'all')::int + (v_counts->>'archive')::int <> (SELECT count(*) FROM public.v_sales_documents)
     OR (v_counts->>'all')::int <> (v_counts->>'quotation')::int + (v_counts->>'sales_order')::int
                                  + (v_counts->>'invoice')::int + (v_counts->>'credit_note')::int THEN
    RAISE EXCEPTION 'Refusing to apply: tab counts do not add up (%)', v_counts;
  END IF;
END
$guard$;
