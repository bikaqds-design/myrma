-- 20260851_pin_search_path_new_helpers.sql
--
-- Pin search_path on the three helpers added since 20260805 pinned the rest.
--
-- The security advisor flagged them (function_search_path_mutable) on
-- 2026-09-14. They came from this remediation's own migrations —
-- 20260845 (rma_mobile_key, rma_is_egyptian_mobile) and 20260848
-- (rma_restore_manifest) — which did not follow the convention 20260805 set.
--
-- None of the three is SECURITY DEFINER and none reads a table: two are
-- regexp_replace over their argument, one returns a literal array of table
-- names. So this is consistency and defence in depth, not a live exposure.
-- ALTER rather than CREATE OR REPLACE, for the reason 20260805 gives: the
-- bodies are not restated, so nothing about what they compute can change.

ALTER FUNCTION public.rma_mobile_key(text)         SET search_path = public;
ALTER FUNCTION public.rma_is_egyptian_mobile(text) SET search_path = public;
ALTER FUNCTION public.rma_restore_manifest()       SET search_path = public;

-- ═══ Guard: pinned, and still computing the same answers ═════════════════════

DO $do$
DECLARE
  v_unpinned text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_unpinned
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('rma_mobile_key', 'rma_is_egyptian_mobile', 'rma_restore_manifest')
     AND NOT coalesce(p.proconfig, '{}'::text[]) @> ARRAY['search_path=public'];
  IF v_unpinned IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to apply: search_path still unpinned on %', v_unpinned;
  END IF;

  IF public.rma_mobile_key('+20 100 123 4567') <> public.rma_mobile_key('0100 123 4567')
     OR public.rma_mobile_key(NULL) <> ''
     OR NOT public.rma_is_egyptian_mobile('+201091768465')
     OR public.rma_is_egyptian_mobile('0223456789') THEN
    RAISE EXCEPTION 'Refusing to apply: the phone helpers no longer give the answers 20260845 tested.';
  END IF;

  IF coalesce(array_length(public.rma_restore_manifest(), 1), 0) <> 55 THEN
    RAISE EXCEPTION 'Refusing to apply: rma_restore_manifest no longer lists 55 tables.';
  END IF;
END
$do$;
