-- 20260855_knowledge_explorer_views.sql
--
-- The Knowledge Center's folder tree, built in the database. (Audit finding
-- BUG-066, phase 5b.)
--
-- The Vault tab loaded every brand, category, subcategory, product and live
-- document, built the Brand > Category > Subcategory > Product tree in the
-- browser (src/lib/knowledgeTree.js) and rolled the folder sizes up from it.
-- The Data API returns at most 1 000 rows per request, so past that the tree
-- silently lost products — and with them the documents filed under them —
-- while search could still find those documents. These views carry the same
-- placement and roll-up rules so the screen can read one folder at a time.
--
-- Placement (unchanged from knowledgeTree.js): a product sits under its brand,
-- then under its category only if that category belongs to the same brand,
-- then under its subcategory only if that subcategory belongs to that
-- category. The walk stops at the last level that agrees, so every product
-- appears exactly once. A category whose brand is missing, or a subcategory
-- whose category is missing, hangs off the root.
--
-- Every view is security_invoker (the caller's RLS applies, as it did to the
-- browser's own reads); the functions are SECURITY INVOKER. Read-only, to
-- authenticated only.

-- ═══ v_knowledge_product_placement ═══════════════════════════════════════════

CREATE OR REPLACE VIEW public.v_knowledge_product_placement
WITH (security_invoker = true) AS
SELECT
  p.id AS product_id,
  p.product_name,
  p.sku,
  p.product_image_url,
  -- The product's own columns, for display and for the catalogue filters.
  p.brand_id AS product_brand_id,
  p.category_id AS product_category_id,
  p.subcategory_id AS product_subcategory_id,
  -- Where the tree puts it.
  b.id AS brand_id,
  b.brand_name,
  CASE WHEN c.id IS NOT NULL AND c.brand_id IS NOT DISTINCT FROM p.brand_id THEN c.id END AS category_id,
  CASE WHEN c.id IS NOT NULL AND c.brand_id IS NOT DISTINCT FROM p.brand_id THEN c.category_name END AS category_name,
  CASE WHEN c.id IS NOT NULL AND c.brand_id IS NOT DISTINCT FROM p.brand_id AND s.category_id = c.id THEN s.id END AS subcategory_id,
  CASE WHEN c.id IS NOT NULL AND c.brand_id IS NOT DISTINCT FROM p.brand_id AND s.category_id = c.id THEN s.subcategory_name END AS subcategory_name
FROM public.products p
LEFT JOIN public.brands b ON b.id = p.brand_id
LEFT JOIN public.categories c ON c.id = p.category_id
LEFT JOIN public.subcategories s ON s.id = p.subcategory_id;

COMMENT ON VIEW public.v_knowledge_product_placement IS
  'Where each product sits in the Knowledge Center folder tree. (BUG-066.)';

-- ═══ v_knowledge_nodes ═══════════════════════════════════════════════════════
-- Every folder: id, kind, parent, the ancestor path (root excluded, self
-- included), the direct child-folder count, and the size of everything
-- beneath it — live documents only, as the tree counted them.

CREATE OR REPLACE VIEW public.v_knowledge_nodes
WITH (security_invoker = true) AS
WITH docs AS (
  SELECT product_id,
         count(*)::int AS n,
         coalesce(sum(file_size), 0)::bigint AS bytes,
         max(updated_at) AS modified
    FROM public.product_documents
   WHERE deleted_at IS NULL
   GROUP BY product_id
),
prod AS (
  SELECT pl.*, coalesce(d.n, 0) AS n, coalesce(d.bytes, 0) AS bytes, d.modified
    FROM public.v_knowledge_product_placement pl
    LEFT JOIN docs d ON d.product_id = pl.product_id
),
all_nodes AS (
  SELECT b.id::text AS id, 'brand'::text AS kind, 0 AS kind_rank, b.brand_name AS name,
         '__root__'::text AS parent_id, ARRAY[b.id::text] AS path,
         NULL::text AS sku, b.brand_logo_url AS logo_url, NULL::text AS image_url,
         coalesce(sum(pr.n), 0)::int AS doc_count, coalesce(sum(pr.bytes), 0)::bigint AS doc_bytes,
         max(pr.modified) AS modified
    FROM public.brands b
    LEFT JOIN prod pr ON pr.brand_id = b.id
   GROUP BY b.id
  UNION ALL
  SELECT c.id::text, 'category', 1, c.category_name,
         coalesce(b.id::text, '__root__'),
         CASE WHEN b.id IS NULL THEN ARRAY[c.id::text] ELSE ARRAY[b.id::text, c.id::text] END,
         NULL, NULL, NULL,
         coalesce(sum(pr.n), 0)::int, coalesce(sum(pr.bytes), 0)::bigint, max(pr.modified)
    FROM public.categories c
    LEFT JOIN public.brands b ON b.id = c.brand_id
    LEFT JOIN prod pr ON pr.category_id = c.id
   GROUP BY c.id, b.id
  UNION ALL
  SELECT s.id::text, 'subcategory', 2, s.subcategory_name,
         coalesce(c.id::text, '__root__'),
         CASE WHEN c.id IS NULL THEN ARRAY[s.id::text]
              WHEN b.id IS NULL THEN ARRAY[c.id::text, s.id::text]
              ELSE ARRAY[b.id::text, c.id::text, s.id::text] END,
         NULL, NULL, NULL,
         coalesce(sum(pr.n), 0)::int, coalesce(sum(pr.bytes), 0)::bigint, max(pr.modified)
    FROM public.subcategories s
    LEFT JOIN public.categories c ON c.id = s.category_id
    LEFT JOIN public.brands b ON b.id = c.brand_id
    LEFT JOIN prod pr ON pr.subcategory_id = s.id
   GROUP BY s.id, c.id, b.id
  UNION ALL
  SELECT pr.product_id::text, 'product', 3, pr.product_name,
         coalesce(pr.subcategory_id, pr.category_id, pr.brand_id)::text,
         array_remove(ARRAY[pr.brand_id::text, pr.category_id::text, pr.subcategory_id::text, pr.product_id::text], NULL),
         pr.sku, NULL, pr.product_image_url,
         pr.n, pr.bytes, pr.modified
    FROM prod pr
)
SELECT a.id, a.kind, a.kind_rank, a.name,
       -- A product with no brand at all sits at the root.
       coalesce(a.parent_id, '__root__') AS parent_id,
       a.path, a.sku, a.logo_url, a.image_url,
       a.doc_count, a.doc_bytes, a.modified,
       coalesce(cc.child_count, 0)::int AS child_count
  FROM all_nodes a
  LEFT JOIN (
    SELECT coalesce(parent_id, '__root__') AS parent_id, count(*) AS child_count
      FROM all_nodes
     GROUP BY 1
  ) cc ON cc.parent_id = a.id;

COMMENT ON VIEW public.v_knowledge_nodes IS
  'Knowledge Center folders with parent, path, child count and rolled-up document totals. (BUG-066.)';

-- ═══ v_knowledge_documents ═══════════════════════════════════════════════════
-- Every document (live and trashed) with its product and its place in the
-- tree: `path` for scoping to a folder, `folder_path` for naming it.

CREATE OR REPLACE VIEW public.v_knowledge_documents
WITH (security_invoker = true) AS
SELECT
  d.id, d.product_id, d.title, d.doc_type, d.description, d.file_name, d.file_url,
  d.storage_path, d.file_size, d.mime_type, d.extracted_text, d.extraction_status,
  d.page_count, d.uploaded_by, d.created_at, d.updated_at, d.deleted_at, d.deleted_by,
  d.search_vector,
  pl.sku AS product_sku,
  pl.product_name,
  pl.product_brand_id,
  pl.product_category_id,
  pl.product_subcategory_id,
  array_remove(ARRAY[pl.brand_id::text, pl.category_id::text, pl.subcategory_id::text, pl.product_id::text], NULL) AS path,
  array_to_string(
    array_remove(ARRAY[pl.brand_name, pl.category_name, pl.subcategory_name, pl.product_name], NULL),
    ' / '
  ) AS folder_path
FROM public.product_documents d
JOIN public.v_knowledge_product_placement pl ON pl.product_id = d.product_id;

COMMENT ON VIEW public.v_knowledge_documents IS
  'Product documents with their product and folder path, for the Knowledge Center. (BUG-066.)';

-- ═══ rma_knowledge_documents_matching ════════════════════════════════════════
-- The search: a document matches on its text (websearch syntax, which never
-- throws on punctuation) or on its product's SKU or name, taken literally.
-- SETOF, so PostgREST filters, orders, pages and counts on top of it. It used
-- to cap text matches at 100 and product matches at 50 products.

CREATE OR REPLACE FUNCTION public.rma_knowledge_documents_matching(p_term text)
RETURNS SETOF public.v_knowledge_documents
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH t AS (
    SELECT btrim(coalesce(p_term, '')) AS term,
           '%' || replace(replace(replace(btrim(coalesce(p_term, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%' AS pattern
  )
  SELECT v.*
    FROM public.v_knowledge_documents v, t
   WHERE t.term <> ''
     AND (
       v.search_vector @@ websearch_to_tsquery('simple', t.term)
       OR v.product_sku ILIKE t.pattern
       OR v.product_name ILIKE t.pattern
     );
$fn$;

COMMENT ON FUNCTION public.rma_knowledge_documents_matching(text) IS
  'Knowledge Center search: document text, or the product SKU/name. (BUG-066.)';

-- ═══ rma_knowledge_folder_stats ══════════════════════════════════════════════
-- The sidebar counts for a folder: live documents beneath it, how many are
-- not searchable, and how many of each type.

CREATE OR REPLACE FUNCTION public.rma_knowledge_folder_stats(p_folder text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH d AS (
    SELECT doc_type, extraction_status
      FROM public.v_knowledge_documents
     WHERE deleted_at IS NULL
       AND (p_folder IS NULL OR p_folder = '__root__' OR p_folder = ANY (path))
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM d),
    'unsearchable', (SELECT count(*) FROM d WHERE extraction_status IS DISTINCT FROM 'ok'),
    'by_type', coalesce((SELECT jsonb_object_agg(doc_type, n) FROM (SELECT doc_type, count(*) AS n FROM d GROUP BY doc_type) x), '{}'::jsonb)
  );
$fn$;

COMMENT ON FUNCTION public.rma_knowledge_folder_stats(text) IS
  'Live document totals beneath a Knowledge Center folder. (BUG-066.)';

-- ═══ Grants ══════════════════════════════════════════════════════════════════

DO $grants$
DECLARE
  v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['v_knowledge_product_placement', 'v_knowledge_nodes', 'v_knowledge_documents'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', v);
  END LOOP;
END
$grants$;

REVOKE ALL ON FUNCTION public.rma_knowledge_documents_matching(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_knowledge_documents_matching(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.rma_knowledge_folder_stats(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_knowledge_folder_stats(text) TO authenticated, service_role;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $guard$
BEGIN
  IF (SELECT count(*) FROM public.v_knowledge_nodes WHERE kind = 'product') <> (SELECT count(*) FROM public.products) THEN
    RAISE EXCEPTION 'Refusing to apply: every product must appear exactly once in the tree';
  END IF;
  IF (SELECT count(*) FROM public.v_knowledge_nodes) <> (SELECT count(DISTINCT id) FROM public.v_knowledge_nodes) THEN
    RAISE EXCEPTION 'Refusing to apply: a folder id appears twice';
  END IF;
  IF (SELECT coalesce(sum(doc_count), 0) FROM public.v_knowledge_nodes WHERE kind = 'product')
     <> (SELECT count(*) FROM public.product_documents WHERE deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Refusing to apply: product folder sizes do not add up to the live document count';
  END IF;
  -- Every folder's total equals the products beneath it.
  IF EXISTS (
    SELECT 1
      FROM public.v_knowledge_nodes n
     WHERE n.kind <> 'product'
       AND n.doc_count <> (SELECT coalesce(sum(p.doc_count), 0) FROM public.v_knowledge_nodes p
                            WHERE p.kind = 'product' AND n.id = ANY (p.path))
  ) THEN
    RAISE EXCEPTION 'Refusing to apply: a folder total does not match the products beneath it';
  END IF;
  IF (SELECT (public.rma_knowledge_folder_stats('__root__')->>'total')::bigint)
     <> (SELECT count(*) FROM public.product_documents WHERE deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Refusing to apply: root stats do not match the live document count';
  END IF;
END
$guard$;
