-- Let CI see which migrations production has applied. (BUG-014, the residual.)
--
-- ── Why ──────────────────────────────────────────────────────────────────────
--
-- BUG-014 was the migration ledger drifting from the files: in September it
-- held one row for 156 files. That was repaired, and it drifted again — every
-- migration applied through the dashboard/MCP `apply_migration` is recorded
-- under a generated timestamp instead of the file's version, so by 2026-09-16
-- forty-three rows (20260825–20260867) no longer matched their files, and
-- `supabase db push` would have treated all of them as unapplied. Nothing
-- noticed, because nothing compared the two. This adds the one thing a
-- comparison needs: a way for CI to read the applied versions.
--
-- ── Why a function, and why the anon key ─────────────────────────────────────
--
-- The alternatives were a read-only database login or the main database
-- password stored as a GitHub secret. Owner's choice (2026-09-16): no database
-- credential in the Actions of a public repository. CI already holds the
-- project URL and anon key for the integration tier, so a function the anon
-- key may call needs nothing new configured.
--
-- What it discloses is the list of applied version numbers and nothing else —
-- not names, not statements, not timestamps. Those numbers are the file-name
-- prefixes already published in this repository; the only new fact is whether
-- production has applied a given file, which is the fact the check exists to
-- report.
--
-- It returns ONE array rather than a set of rows, so the Data API's 1 000-row
-- cap (BUG-066) can never truncate the list and make applied migrations look
-- missing.
--
-- ── Grants, stated explicitly ────────────────────────────────────────────────
--
-- 20260841 changed the default privileges so new functions are NOT executable
-- by anon. That is the right default, and this function is a deliberate,
-- named exception to it — so EXECUTE is granted to anon here, and the finishing
-- guard checks that it took rather than trusting the default.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'Refusing to apply: supabase_migrations.schema_migrations does not exist.';
  END IF;
END
$do$;

-- ═══ The function ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_applied_migration_versions()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
-- Empty search_path: every name below is schema-qualified.
SET search_path TO ''
AS $fn$
  SELECT coalesce(array_agg(m.version ORDER BY m.version), ARRAY[]::text[])
    FROM supabase_migrations.schema_migrations AS m
$fn$;

COMMENT ON FUNCTION public.rma_applied_migration_versions() IS
  'Applied migration version numbers, for the CI drift check (BUG-014). Versions only — the same prefixes as the public migration file names. Deliberately executable by anon.';

REVOKE ALL ON FUNCTION public.rma_applied_migration_versions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rma_applied_migration_versions() TO anon, authenticated, service_role;

-- ═══ Guards: the migration refuses to finish if it did not take ══════════════

DO $do$
DECLARE
  v_versions text[];
BEGIN
  IF NOT has_function_privilege('anon', 'public.rma_applied_migration_versions()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: anon cannot execute rma_applied_migration_versions — the CI check could not read it.';
  END IF;

  -- The result must be the version column and nothing wider.
  IF (SELECT pg_get_function_result(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'rma_applied_migration_versions') <> 'text[]' THEN
    RAISE EXCEPTION 'Refusing to finish: rma_applied_migration_versions must return text[] only.';
  END IF;

  v_versions := public.rma_applied_migration_versions();
  IF v_versions IS NULL THEN
    RAISE EXCEPTION 'Refusing to finish: rma_applied_migration_versions returned NULL.';
  END IF;

  RAISE NOTICE 'BUG-014: % applied migration versions readable for the CI drift check.', cardinality(v_versions);
END
$do$;

-- ─── Rollback ────────────────────────────────────────────────────────────────
-- DROP FUNCTION public.rma_applied_migration_versions(), and remove or disable
-- .github/workflows/migration-drift.yml in the same change: the workflow
-- treats an unreadable production as a FAILURE, deliberately, so dropping the
-- function alone turns it red.
