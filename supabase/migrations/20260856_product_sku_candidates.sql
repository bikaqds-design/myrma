-- 20260856_product_sku_candidates.sql
--
-- Candidate products for bulk-upload filenames. (Audit finding BUG-066,
-- phase 5b.)
--
-- Bulk upload matched each filename against the whole catalogue loaded into the
-- browser. The Data API returns at most 1 000 rows per request, so past that a
-- datasheet whose product was not in the loaded part stayed "unmatched" — or,
-- worse, matched a shorter SKU that was, because the longer, more specific one
-- was never seen.
--
-- This returns, for each normalised filename base, only the products that
-- src/lib/skuMatch.js could pick: an exact normalised-SKU match, or a SKU of at
-- least 4 characters contained in the name. The browser still makes the
-- decision (exact beats contained, longest wins, ties are left to a person) on
-- that short list, so the tested rule is unchanged.
--
-- Normalising: skuMatch.js upper-cases and drops everything but A-Z and 0-9;
-- the caller sends the filename bases already normalised that way, and the SKU
-- is normalised the same way here.
--
-- SECURITY INVOKER: the caller's own product visibility applies. Read-only.

CREATE OR REPLACE FUNCTION public.rma_product_sku_candidates(p_bases text[])
RETURNS TABLE (base_index int, id uuid, sku text, product_name text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH b AS (
    SELECT u.base, u.ord::int AS ord
      FROM unnest(coalesce(p_bases, '{}'::text[])) WITH ORDINALITY AS u(base, ord)
     WHERE coalesce(u.base, '') <> ''
  ),
  p AS (
    SELECT pr.id, pr.sku, pr.product_name,
           regexp_replace(upper(coalesce(pr.sku, '')), '[^A-Z0-9]', '', 'g') AS norm
      FROM public.products pr
  )
  SELECT b.ord, p.id, p.sku, p.product_name
    FROM b
    JOIN p ON p.norm <> ''
          AND (p.norm = b.base OR (length(p.norm) >= 4 AND strpos(b.base, p.norm) > 0));
$fn$;

COMMENT ON FUNCTION public.rma_product_sku_candidates(text[]) IS
  'Products whose SKU could match each normalised filename base (exact, or contained when 4+ chars). (BUG-066.)';

REVOKE ALL ON FUNCTION public.rma_product_sku_candidates(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_product_sku_candidates(text[]) TO authenticated, service_role;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════
-- Every product with a usable SKU must find itself by its own SKU.

DO $guard$
DECLARE
  v_missing bigint;
BEGIN
  SELECT count(*) INTO v_missing
    FROM public.products pr
   WHERE regexp_replace(upper(coalesce(pr.sku, '')), '[^A-Z0-9]', '', 'g') <> ''
     AND NOT EXISTS (
       SELECT 1 FROM public.rma_product_sku_candidates(ARRAY[regexp_replace(upper(pr.sku), '[^A-Z0-9]', '', 'g')]) c
        WHERE c.id = pr.id
     );
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'Refusing to apply: % product(s) do not match their own SKU', v_missing;
  END IF;
END
$guard$;
