-- 20260862_purchasing_lists.sql
--
-- Server-side reads for the Purchasing page and Vendor Details. (Audit finding
-- BUG-066, phase 5d.)
--
-- Purchasing loaded every purchase order and vendor invoice
-- (v_purchase_documents) and every brand, then did the tab split, the tab
-- counts, the search, the status and vendor filters, the sort, the paging, the
-- spend graph and the pivot in the browser; its Vendors tab searched, sorted and
-- paged every brand the same way. Vendor Details loaded every document to keep
-- one vendor's. The Data API returns at most 1 000 rows per request, so past
-- that the lists, the counts and — worse — the spend totals covered part of the
-- documents as if they were all.
--
--   v_purchase_documents_list        v_purchase_documents + the vendor name
--                                    shown, the keys the columns sort by, and
--                                    the total in base currency
--   rma_purchase_document_summary    per tab, how many documents it holds, and
--                                    the statuses its filter offers
--   rma_purchase_document_buckets    documents counted and spend summed per
--                                    type × status × vendor × created month —
--                                    every number the graph, the pivot and
--                                    Vendor Details show
--   v_vendors_list                   brands (the vendors) + sort keys
--
-- SECURITY INVOKER: RLS on purchase_orders, vendor_invoices and brands applies
-- as it did to the browser's own reads. Read-only; authenticated only.

-- ═══ Documents ═══════════════════════════════════════════════════════════════
-- vendor_sort is null when the vendor has no name, so a nameless row sorts
-- after every name ("—" did). doc_code_sort is case-insensitive.
-- total_base_value is the page's docTotalBase: total_base, or — for a row that
-- predates that column — total at the document's rate (1 when it has none).

CREATE OR REPLACE VIEW public.v_purchase_documents_list
WITH (security_invoker = true)
AS
SELECT d.*,
       x.vendor_name,
       lower(x.vendor_name) AS vendor_sort,
       lower(coalesce(d.doc_code, '')) AS doc_code_sort,
       coalesce(d.total_base, coalesce(d.total, 0) * coalesce(nullif(d.exchange_rate, 0), 1)) AS total_base_value
  FROM public.v_purchase_documents d
  LEFT JOIN public.brands b ON b.id = d.vendor_id
  CROSS JOIN LATERAL (SELECT nullif(b.brand_name, '') AS vendor_name) x;

COMMENT ON VIEW public.v_purchase_documents_list IS
  'Purchase documents with the vendor name, sort keys and base-currency total the Purchasing page shows. (BUG-066.)';

-- ═══ Which documents a tab holds ═════════════════════════════════════════════
-- Archived documents belong only to the Archive tab; 'all' and each document
-- type hold the active ones. 'any' is every document — Vendor Details.

CREATE OR REPLACE FUNCTION public.rma_purchase_tab_holds(p_tab text, p_doc_type text, p_archived boolean)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT CASE WHEN p_tab = 'any' THEN true
              WHEN p_tab = 'archive' THEN coalesce(p_archived, false)
              WHEN p_tab = 'all' OR p_tab IS NULL THEN NOT coalesce(p_archived, false)
              ELSE NOT coalesce(p_archived, false) AND p_doc_type = p_tab
         END;
$fn$;

-- ═══ Tab counts and status options ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_purchase_document_summary(p_tab text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH docs AS (
    SELECT doc_type, doc_status, archived FROM public.v_purchase_documents
  )
  SELECT jsonb_build_object(
    'counts', jsonb_build_object(
      'all',            (SELECT count(*) FROM docs WHERE NOT coalesce(archived, false)),
      'purchase_order', (SELECT count(*) FROM docs WHERE NOT coalesce(archived, false) AND doc_type = 'purchase_order'),
      'vendor_invoice', (SELECT count(*) FROM docs WHERE NOT coalesce(archived, false) AND doc_type = 'vendor_invoice'),
      'archive',        (SELECT count(*) FROM docs WHERE coalesce(archived, false)),
      'total',          (SELECT count(*) FROM docs)
    ),
    'statuses', coalesce((SELECT jsonb_agg(DISTINCT doc_status ORDER BY doc_status)
                            FROM docs
                           WHERE public.rma_purchase_tab_holds(p_tab, doc_type, archived)
                             AND doc_status IS NOT NULL AND doc_status <> ''), '[]'::jsonb)
  );
$fn$;

COMMENT ON FUNCTION public.rma_purchase_document_summary(text) IS
  'Purchasing tab counts and the statuses present in one tab. (BUG-066.)';

-- ═══ Counts and spend, grouped ═══════════════════════════════════════════════
-- The same documents the list shows for these filters (tab, status, vendor and
-- a search over code and vendor name, taken literally — % _ and \ are escaped),
-- grouped finely enough that every chart, pivot and total is a sum of rows.
-- Cancelled documents are included: the page decides what counts as spend.
-- Months are 'YYYY-MM' of created_at in the viewer's time zone; an unknown time
-- zone name falls back to UTC rather than failing.

CREATE OR REPLACE FUNCTION public.rma_purchase_document_buckets(
  p_tab text,
  p_status text,
  p_vendor_id uuid,
  p_term text,
  p_tz text
)
RETURNS TABLE (
  doc_type text,
  doc_status text,
  vendor_id uuid,
  vendor_name text,
  created_month text,
  doc_count bigint,
  spend numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH z AS (
    SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) THEN p_tz ELSE 'UTC' END AS tz
  ),
  q AS (
    SELECT btrim(coalesce(p_term, '')) AS term,
           '%' || replace(replace(replace(btrim(coalesce(p_term, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%' AS pattern
  )
  SELECT d.doc_type,
         d.doc_status,
         d.vendor_id,
         d.vendor_name,
         to_char(d.created_at AT TIME ZONE z.tz, 'YYYY-MM'),
         count(*),
         sum(d.total_base_value)
    FROM public.v_purchase_documents_list d, z, q
   WHERE public.rma_purchase_tab_holds(p_tab, d.doc_type, d.archived)
     AND (nullif(p_status, '') IS NULL OR d.doc_status = p_status)
     AND (p_vendor_id IS NULL OR d.vendor_id = p_vendor_id)
     AND (q.term = '' OR d.doc_code ILIKE q.pattern OR d.vendor_name ILIKE q.pattern)
   GROUP BY 1, 2, 3, 4, 5;
$fn$;

COMMENT ON FUNCTION public.rma_purchase_document_buckets(text, text, uuid, text, text) IS
  'Purchase document count and base-currency spend per type, status, vendor and created month. (BUG-066.)';

-- ═══ Vendors ═════════════════════════════════════════════════════════════════
-- The Vendors tab sorts case-insensitively with blank values last in either
-- direction; each key is null for a blank so NULLS LAST does exactly that.

CREATE OR REPLACE VIEW public.v_vendors_list
WITH (security_invoker = true)
AS
SELECT b.*,
       lower(nullif(b.brand_name, '')) AS brand_name_sort,
       lower(nullif(b.contact_person, '')) AS contact_person_sort,
       lower(nullif(b.email, '')) AS email_sort,
       lower(nullif(b.phone, '')) AS phone_sort,
       lower(nullif(b.payment_terms, '')) AS payment_terms_sort
  FROM public.brands b;

COMMENT ON VIEW public.v_vendors_list IS
  'Brands as the Purchasing Vendors tab lists them, with sort keys. (BUG-066.)';

-- ═══ Grants ══════════════════════════════════════════════════════════════════

REVOKE ALL ON public.v_purchase_documents_list, public.v_vendors_list FROM PUBLIC, anon;
GRANT SELECT ON public.v_purchase_documents_list, public.v_vendors_list TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.rma_purchase_tab_holds(text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_purchase_tab_holds(text, text, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.rma_purchase_document_summary(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_purchase_document_summary(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.rma_purchase_document_buckets(text, text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_purchase_document_buckets(text, text, uuid, text, text) TO authenticated, service_role;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $guard$
DECLARE
  v_counts jsonb := public.rma_purchase_document_summary('all') -> 'counts';
BEGIN
  IF (SELECT count(*) FROM public.v_purchase_documents_list) <> (SELECT count(*) FROM public.v_purchase_documents)
     OR (SELECT count(*) FROM public.v_vendors_list) <> (SELECT count(*) FROM public.brands) THEN
    RAISE EXCEPTION 'Refusing to apply: a list view does not have one row per source row';
  END IF;
  IF (v_counts->>'all')::int + (v_counts->>'archive')::int <> (v_counts->>'total')::int
     OR (v_counts->>'total')::int <> (SELECT count(*) FROM public.v_purchase_documents)
     OR (v_counts->>'all')::int <> (v_counts->>'purchase_order')::int + (v_counts->>'vendor_invoice')::int THEN
    RAISE EXCEPTION 'Refusing to apply: tab counts do not add up (%)', v_counts;
  END IF;
  IF (SELECT coalesce(sum(doc_count), 0) FROM public.rma_purchase_document_buckets('any', NULL, NULL, NULL, 'UTC'))
       <> (SELECT count(*) FROM public.v_purchase_documents)
     OR (SELECT coalesce(sum(spend), 0) FROM public.rma_purchase_document_buckets('any', NULL, NULL, NULL, 'UTC'))
       <> (SELECT coalesce(sum(total_base_value), 0) FROM public.v_purchase_documents_list) THEN
    RAISE EXCEPTION 'Refusing to apply: document buckets do not add up to the documents';
  END IF;
END
$guard$;
