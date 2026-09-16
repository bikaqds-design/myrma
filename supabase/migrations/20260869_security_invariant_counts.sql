-- Let CI check, against production, that the BUG-087 fix has not been undone.
--
-- ── Why ──────────────────────────────────────────────────────────────────────
--
-- 20260867 made every role guard fail closed. What undoes it is ordinary
-- work: a later migration that re-declares a helper without its COALESCE, or
-- copies an old function body that still compares rma_user_role() in a bare
-- `IF NOT (…)`. The unit test in src/test/roleGuardsFailClosed.test.js reads
-- the migration FILES; it cannot see a change made directly in production.
--
-- The SQL test files cannot fill that gap: the CI `db-tests` job is disabled
-- (`if: false` since 2026-08-07) and is not coming back. The job that does run
-- against production is the integration tier, which only holds the anon key —
-- and anon cannot read function definitions or policies. So this exposes the
-- answers, and nothing else.
--
-- ── What it discloses — counts, deliberately ─────────────────────────────────
--
-- Owner's choice (2026-09-16): three numbers, no names and no code.
--
--   unwrapped_role_guards      SECURITY DEFINER functions whose guard compares
--                              rma_user_role() in a bare `IF NOT (…) THEN` —
--                              the shape that fails open. Must be 0.
--   helpers_without_coalesce   of rma_is_staff / rma_is_admin /
--                              rma_is_manager_or_above / rma_can_handle_cash,
--                              how many no longer COALESCE to false. Must be 0.
--   policies_negating_helpers  RLS policies that negate or compare a helper —
--                              the one place NULL -> false could WIDEN access,
--                              which 20260867's safety argument depends on
--                              never happening. Must be 0.
--   anon_executable_functions  functions in `public` the anon role may run —
--                              a tripwire, since 20260841 made "none" the
--                              default and every exception should be chosen.
--
-- A zero discloses nothing. A non-zero says only that something regressed,
-- which is what CI exists to say; which function is left to someone with
-- database access.

-- ═══ The function ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_security_invariant_counts()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $fn$
  SELECT jsonb_build_object(
    'unwrapped_role_guards', (
      SELECT count(*)
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef
         AND pg_catalog.pg_get_functiondef(p.oid)
             ~ 'IF\s+NOT\s+\((?:[^;])*?rma_user_role\(\)(?:[^;])*?\)\s+THEN'
    ),
    'helpers_without_coalesce', (
      SELECT count(*)
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('rma_is_staff', 'rma_is_admin', 'rma_is_manager_or_above', 'rma_can_handle_cash')
         AND pg_catalog.pg_get_functiondef(p.oid) !~ 'COALESCE\('
    ),
    'policies_negating_helpers', (
      SELECT count(*)
        FROM pg_catalog.pg_policies
       WHERE coalesce(qual, '') || ' ' || coalesce(with_check, '')
             ~* '(not\s*\(?\s*(public\.)?rma_(is_[a-z_]+|can_handle_cash)\(\)|rma_(is_[a-z_]+|can_handle_cash)\(\)\s*(is|=|<>|!=))'
    ),
    'anon_executable_functions', (
      SELECT count(*)
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
         AND pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
    )
  )
$fn$;

COMMENT ON FUNCTION public.rma_security_invariant_counts() IS
  'Counts only, for the CI integration tier (BUG-087 regression check): unwrapped role guards, helpers without COALESCE, policies negating a helper, anon-executable functions. Deliberately executable by anon.';

REVOKE ALL ON FUNCTION public.rma_security_invariant_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rma_security_invariant_counts() TO anon, authenticated, service_role;

-- ═══ Guards: the migration refuses to finish if it did not take ══════════════

DO $do$
DECLARE
  v jsonb;
BEGIN
  IF NOT has_function_privilege('anon', 'public.rma_security_invariant_counts()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: anon cannot execute rma_security_invariant_counts — the CI check could not read it.';
  END IF;

  v := public.rma_security_invariant_counts();

  -- Applying this into a database where the invariants already fail would
  -- publish a red check from day one; refuse instead and say which count.
  IF (v->>'unwrapped_role_guards')::int <> 0
     OR (v->>'helpers_without_coalesce')::int <> 0
     OR (v->>'policies_negating_helpers')::int <> 0 THEN
    RAISE EXCEPTION 'Refusing to finish: a security invariant already fails here: %', v;
  END IF;

  RAISE NOTICE 'Security invariant counts: %', v;
END
$do$;

-- ─── Rollback ────────────────────────────────────────────────────────────────
-- DROP FUNCTION public.rma_security_invariant_counts(); and remove
-- tests/integration/security-invariants.test.ts in the same change — the test
-- treats a missing function as a failure, not a skip.
