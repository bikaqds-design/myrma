-- Take the anonymous role's grants back to what the public pages use.
-- (Audit finding BUG-057.)
--
-- ── What was measured (2026-09-10) ───────────────────────────────────────────
--
-- `anon` — anyone holding the public API key, which ships in every page load —
-- held SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER on 26
-- tables (payments, crm_invoices, credit_notes, vendor_payments, ...) and on all
-- six views, and EXECUTE on 44 functions, 22 of them SECURITY DEFINER.
--
-- None of it was exploitable today, and each part was checked rather than
-- assumed: every one of those tables has RLS on with no policy admitting anon;
-- all six views are security_invoker, so they run under anon's RLS; and the four
-- business RPCs anon could call (create_manufacturer_batch, mark_batch_sent,
-- mark_batch_resolved, issue_credit_note) each refuse a caller who is not staff.
-- The exposure is structural: one future policy written `TO public` instead of
-- `TO authenticated` — two such were found in the pre-launch review — would turn
-- straight into an anonymous write, because the grant underneath is already there.
--
-- ── Why it kept coming back ──────────────────────────────────────────────────
--
-- Default privileges. For objects that `postgres` creates in `public`, this
-- project grants anon full table rights and EXECUTE on every new function. So the
-- grant was not a past mistake to clean up once: every migration re-created it,
-- including three RPCs added during this remediation. Revoking the existing
-- grants without changing the defaults would last until the next migration.
--
-- ── What anon actually needs ─────────────────────────────────────────────────
--
-- Traced, not guessed. The public pages are Login and Reset Password (Auth only),
-- the RMA tracker (the public-track Edge Function, which uses the service role,
-- plus storage policies scoped to comment attachments), and the public Knowledge
-- Base, which reads published kb_articles. Every Edge Function either uses the
-- service role or forwards the caller's own token. PostgREST has no pre-request
-- hook and pg_graphql is not installed. So anon keeps exactly one grant here:
-- SELECT on kb_articles, whose anon-applicable policy calls no function.
--
-- ── What this does ───────────────────────────────────────────────────────────
--
--   1. Revokes every privilege anon holds on public tables and views, then grants
--      back SELECT on kb_articles.
--   2. Revokes EXECUTE from anon on every function in public. Where that access
--      came through PUBLIC, PUBLIC is revoked too — after first granting EXECUTE
--      explicitly to every OTHER role that had it, so authenticated, service_role
--      and the Supabase service roles lose nothing. A guard verifies that.
--   3. Also revokes EXECUTE from authenticated on TRIGGER functions only. Calling
--      one through /rpc can only error, and a rolled-back probe confirmed that
--      firing a trigger does not require EXECUTE on its function. (The first
--      attempt at that probe was invalid — the default privileges had left
--      EXECUTE in place — and was redone with the privilege verified absent.)
--   4. Changes the default privileges so new tables, sequences and functions are
--      not granted to anon, and new functions are not executable by PUBLIC.
--      authenticated and service_role keep their defaults.
--
-- ── Consequence for future work, deliberately ────────────────────────────────
--
-- A table or RPC meant for signed-out visitors now needs an explicit
-- `GRANT ... TO anon` in its migration. That is the point: exposure to the
-- internet becomes a line someone writes, not a default someone forgets.
--
-- ── Not done here ────────────────────────────────────────────────────────────
--   pg_net stays in public. It is not relocatable (extrelocatable = false), its
--     functions live in the `net` schema regardless, and moving it means drop and
--     recreate, which would interrupt the cron-driven notification drain.
--   Leaked-password protection (HaveIBeenPwned) is an Auth setting, not SQL; it is
--     switched on in the Supabase dashboard.
--   Defaults for objects created by supabase_admin cannot be altered from here; in
--     public that role creates only extension objects.

DO $do$
DECLARE
  keep_roles text[] := ARRAY['authenticated', 'service_role', 'authenticator', 'supabase_auth_admin',
                             'supabase_storage_admin', 'supabase_realtime_admin', 'dashboard_user'];
  r           record;
  fn          record;
  role_name   text;
  kept        jsonb := '{}'::jsonb;
  v_bad       text;
  n_tables    int := 0;
  n_functions int := 0;
BEGIN
  IF to_regclass('public.kb_articles') IS NULL THEN
    RAISE EXCEPTION 'Refusing to apply: public.kb_articles does not exist.';
  END IF;

  -- ── 1. Tables and views ────────────────────────────────────────────────────
  FOR r IN
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
       AND (   has_table_privilege('anon', c.oid, 'SELECT')   OR has_table_privilege('anon', c.oid, 'INSERT')
            OR has_table_privilege('anon', c.oid, 'UPDATE')   OR has_table_privilege('anon', c.oid, 'DELETE')
            OR has_table_privilege('anon', c.oid, 'TRUNCATE') OR has_table_privilege('anon', c.oid, 'REFERENCES')
            OR has_table_privilege('anon', c.oid, 'TRIGGER'))
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', r.relname);
    n_tables := n_tables + 1;
  END LOOP;
  GRANT SELECT ON TABLE public.kb_articles TO anon;

  -- ── 2 & 3. Functions ───────────────────────────────────────────────────────
  FOR fn IN
    SELECT p.oid, p.oid::regprocedure::text AS sig, p.prorettype = 'trigger'::regtype AS is_trigger
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind IN ('f', 'p')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    FOREACH role_name IN ARRAY keep_roles LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name);
      CONTINUE WHEN fn.is_trigger AND role_name = 'authenticated';
      IF has_function_privilege(role_name, fn.oid, 'EXECUTE') THEN
        kept := kept || jsonb_build_object(role_name || '|' || fn.sig, true);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn.sig, role_name);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn.sig);
    IF fn.is_trigger THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', fn.sig);
    END IF;
    n_functions := n_functions + 1;
  END LOOP;

  -- ── 4. Defaults for what future migrations create ─────────────────────────
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

  -- ═══ Guards ═══════════════════════════════════════════════════════════════

  -- anon holds nothing on a public relation except SELECT on kb_articles.
  SELECT string_agg(c.relname, ', ') INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
     AND (   (c.relname <> 'kb_articles' AND has_table_privilege('anon', c.oid, 'SELECT'))
          OR has_table_privilege('anon', c.oid, 'INSERT')   OR has_table_privilege('anon', c.oid, 'UPDATE')
          OR has_table_privilege('anon', c.oid, 'DELETE')   OR has_table_privilege('anon', c.oid, 'TRUNCATE')
          OR has_table_privilege('anon', c.oid, 'REFERENCES') OR has_table_privilege('anon', c.oid, 'TRIGGER'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to finish: anon still holds privileges on: %', v_bad;
  END IF;
  IF NOT has_table_privilege('anon', 'public.kb_articles', 'SELECT') THEN
    RAISE EXCEPTION 'Refusing to finish: anon lost SELECT on kb_articles, which would break the public Knowledge Base.';
  END IF;

  SELECT string_agg(DISTINCT table_name, ', ') INTO v_bad
    FROM information_schema.column_privileges
   WHERE grantee = 'anon' AND table_schema = 'public' AND table_name <> 'kb_articles';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to finish: anon still holds column privileges on: %', v_bad;
  END IF;

  -- anon can execute no application function.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to finish: anon can still execute: %', v_bad;
  END IF;

  -- Every other role kept exactly the function access it had.
  SELECT string_agg(k, ', ') INTO v_bad
    FROM jsonb_object_keys(kept) AS k
   WHERE NOT has_function_privilege(split_part(k, '|', 1), split_part(k, '|', 2)::regprocedure, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to finish: these lost EXECUTE and must not have: %', v_bad;
  END IF;

  RAISE NOTICE 'BUG-057: anon revoked from % relation(s) and % function(s); % role/function grants preserved.',
    n_tables, n_functions, (SELECT count(*) FROM jsonb_object_keys(kept));
END
$do$;

-- ─── Rollback ────────────────────────────────────────────────────────────────
-- Deliberately not scripted in full: restoring anon's table grants restores the
-- exposure this removes. To re-open a single object for signed-out visitors,
-- grant exactly what it needs, e.g.
--   GRANT SELECT ON public.<table> TO anon;
--   GRANT EXECUTE ON FUNCTION public.<fn>(<args>) TO anon;
-- and to restore the old defaults:
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
