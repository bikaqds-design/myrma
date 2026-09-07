-- NOTE ON PROVENANCE: recovered on 2026-09-07 from
-- `supabase_migrations.schema_migrations` (version 20260906153745). Applied to
-- production 2026-09-06; the .sql file was never written to the repository.
-- This is the SQL that actually ran, verbatim.

-- One policy per table for the two preference tables. (Audit finding BUG-050.)
--
-- ── What the finding got wrong, checked before acting ────────────────────────
--
-- BUG-050 claimed `users_own_prefs` (ALL, USING only) allowed an UPDATE that
-- reassigns `user_email` to another user, hijacking their preference row. It
-- does not. Postgres reuses a policy's USING expression as its implicit
-- WITH CHECK when none is given, so the NEW row is tested too. Probed live as a
-- technician against an admin's address:
--
--   UPDATE user_preferences SET user_email='<admin>' WHERE user_email='<me>'
--     -> ERROR 42501: new row violates row-level security policy
--   UPDATE user_preferences SET prefs='{"x":1}' WHERE user_email='<me>'
--     -> 1 row
--
-- This is the same misreading the report already corrected once for BUG-002.
-- No hole is being closed here.
--
-- ── What is real ─────────────────────────────────────────────────────────────
--
-- Overlap. `user_preferences` carried five permissive policies and
-- `notification_preferences` four, all OR-ed, all evaluated per row:
--
--   user_preferences: users_own_prefs (ALL) plus four single-command policies
--     saying exactly the same thing.
--   notification_preferences: user_own (ALL, and the only one that also admits
--     admins) plus three legacy policies calling bare auth.email(), which is
--     what the auth_rls_initplan advisor flags -- it is re-evaluated for every
--     row instead of once per query.
--
-- Redundant permissive policies cannot tighten anything, only widen it, so the
-- cost is paid for nothing: more work per row, and an authorisation model that
-- takes four policies to reason about instead of one.
--
-- WITH CHECK is now written out explicitly rather than left implicit. The
-- behaviour is identical; the intent stops depending on knowing that rule.

DO $do$
DECLARE v_before integer;
BEGIN
  SELECT count(*) INTO v_before
    FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
   WHERE c.relname IN ('user_preferences','notification_preferences');
  RAISE NOTICE 'policies before: %', v_before;
END
$do$;

-- ═══ user_preferences: keep one ALL policy ═══════════════════════════════════

DROP POLICY IF EXISTS user_own_preferences_select ON public.user_preferences;
DROP POLICY IF EXISTS user_own_preferences_insert ON public.user_preferences;
DROP POLICY IF EXISTS user_own_preferences_update ON public.user_preferences;
DROP POLICY IF EXISTS user_own_preferences_delete ON public.user_preferences;
DROP POLICY IF EXISTS users_own_prefs            ON public.user_preferences;

CREATE POLICY user_own_prefs ON public.user_preferences
  FOR ALL TO public
  USING      (user_email = public.rma_current_user_email())
  WITH CHECK (user_email = public.rma_current_user_email());

-- ═══ notification_preferences: keep one ALL policy ═══════════════════════════
-- The three legacy policies used bare auth.email(); user_own already covered
-- everything they allowed, and also admits admins.

DROP POLICY IF EXISTS "Users can read their own preferences"   ON public.notification_preferences;
DROP POLICY IF EXISTS "Users can insert their own preferences" ON public.notification_preferences;
DROP POLICY IF EXISTS "Users can update their own preferences" ON public.notification_preferences;
DROP POLICY IF EXISTS user_own                                 ON public.notification_preferences;

CREATE POLICY user_own ON public.notification_preferences
  FOR ALL TO public
  USING      (user_email = public.rma_current_user_email() OR public.rma_is_admin())
  WITH CHECK (user_email = public.rma_current_user_email() OR public.rma_is_admin());

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  v_up integer; v_np integer;
BEGIN
  SELECT count(*) INTO v_up FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
   WHERE c.relname='user_preferences';
  SELECT count(*) INTO v_np FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
   WHERE c.relname='notification_preferences';

  IF v_up <> 1 THEN
    RAISE EXCEPTION 'Refusing to finish: user_preferences has % policies, expected 1.', v_up;
  END IF;
  IF v_np <> 1 THEN
    RAISE EXCEPTION 'Refusing to finish: notification_preferences has % policies, expected 1.', v_np;
  END IF;

  -- Every surviving policy must carry an explicit WITH CHECK.
  IF EXISTS (SELECT 1 FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
              WHERE c.relname IN ('user_preferences','notification_preferences')
                AND pol.polwithcheck IS NULL) THEN
    RAISE EXCEPTION 'Refusing to finish: a surviving policy has no explicit WITH CHECK.';
  END IF;

  RAISE NOTICE 'BUG-050: 9 overlapping policies reduced to 2, each with an explicit WITH CHECK.';
END
$do$;
