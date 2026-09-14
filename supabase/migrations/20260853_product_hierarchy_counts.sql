-- 20260853_product_hierarchy_counts.sql
--
-- Product counts for the Products screen's Hierarchy tab. (Audit finding
-- BUG-066, phase 3.)
--
-- The tab showed "N products" per brand and per category, and a grand total,
-- by counting the product list the page had loaded. That list is capped by the
-- Data API at 1 000 rows, so past that every one of those numbers is quietly
-- low. PostgREST cannot group, so the counts come from here.
--
-- SECURITY INVOKER: it counts the products the caller may read, the same rows
-- the tab would have loaded. Read-only.

CREATE OR REPLACE FUNCTION public.rma_product_hierarchy_counts()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM public.products),
    'by_brand', coalesce((
      SELECT jsonb_object_agg(brand_id::text, n)
        FROM (SELECT brand_id, count(*) AS n FROM public.products WHERE brand_id IS NOT NULL GROUP BY brand_id) b
    ), '{}'::jsonb),
    'by_category', coalesce((
      SELECT jsonb_object_agg(category_id::text, n)
        FROM (SELECT category_id, count(*) AS n FROM public.products WHERE category_id IS NOT NULL GROUP BY category_id) c
    ), '{}'::jsonb)
  );
$fn$;

COMMENT ON FUNCTION public.rma_product_hierarchy_counts() IS
  'Product totals overall, per brand and per category, for the Products Hierarchy tab. (BUG-066.)';

REVOKE ALL ON FUNCTION public.rma_product_hierarchy_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_product_hierarchy_counts() TO authenticated;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  v jsonb := public.rma_product_hierarchy_counts();
  v_brand_sum bigint;
  v_cat_sum bigint;
BEGIN
  IF (v->>'total')::bigint <> (SELECT count(*) FROM public.products) THEN
    RAISE EXCEPTION 'Refusing to apply: total % does not match the table', v->>'total';
  END IF;
  SELECT coalesce(sum(value::bigint), 0) INTO v_brand_sum FROM jsonb_each_text(v->'by_brand');
  SELECT coalesce(sum(value::bigint), 0) INTO v_cat_sum FROM jsonb_each_text(v->'by_category');
  IF v_brand_sum <> (SELECT count(*) FROM public.products WHERE brand_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Refusing to apply: per-brand counts sum to %, not the branded product count', v_brand_sum;
  END IF;
  IF v_cat_sum <> (SELECT count(*) FROM public.products WHERE category_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Refusing to apply: per-category counts sum to %, not the categorised product count', v_cat_sum;
  END IF;
END
$do$;
