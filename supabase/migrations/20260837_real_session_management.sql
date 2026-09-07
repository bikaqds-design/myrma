-- Real session listing and revocation. (Audit finding BUG-049.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- Account Settings → Security shows "Active sessions" and offers to sign out
-- of them. The Edge Function behind it documents two actions in its own header
-- comment:
--
--   Body: { action: 'list' }
--         { action: 'revoke', sessionId: '<uuid>' }
--
-- Only `list` was implemented, and `list` did not list anything: it decoded the
-- caller's own JWT and returned that single session as an array of one. So the
-- screen always said "1 active session" no matter how many devices were signed
-- in — checked against the live database, which holds 7 sessions across 2
-- users. A user cannot notice an unfamiliar device on a screen that structurally
-- cannot show one.
--
-- `revoke` returned "Unknown action", 400.
--
-- ── Why this is SQL rather than more Edge Function ───────────────────────────
--
-- Sessions live in `auth.sessions`, and PostgREST does not expose the `auth`
-- schema — which is why the original settled for decoding the JWT. A SECURITY
-- DEFINER function in `public` is the supported way across that boundary, and
-- it puts the ownership rule (`user_id = auth.uid()`) in the database rather
-- than in a function holding a service-role key, where a mistake in request
-- parsing would be the difference between reading your own sessions and
-- reading everyone's.
--
-- ── What revocation actually does ────────────────────────────────────────────
--
-- Deleting the `auth.sessions` row cascades to `refresh_tokens` and
-- `mfa_amr_claims` (both FKs are ON DELETE CASCADE — verified in the live
-- catalog), which is exactly what GoTrue's own sign-out does. The device can no
-- longer refresh, so it is signed out for good at the next refresh.
--
-- It does NOT invalidate an access token already issued: those are signed JWTs,
-- valid until `exp` regardless of any server-side state, so a revoked device
-- keeps API access for up to the token lifetime. That is a property of JWT
-- auth, not something this migration can fix, and the UI should not promise
-- otherwise.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='auth' AND c.relname='sessions') THEN
    RAISE EXCEPTION 'Refusing to apply: auth.sessions does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='rma_is_admin') THEN
    RAISE EXCEPTION 'Refusing to apply: public.rma_is_admin() does not exist.';
  END IF;
END
$do$;

-- ═══ List my own sessions ════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_list_my_sessions()
RETURNS TABLE (
  id          uuid,
  created_at  timestamptz,
  refreshed_at timestamptz,
  not_after   timestamptz,
  aal         text,
  user_agent  text,
  ip          text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public', 'auth'
AS $fn$
  SELECT s.id,
         s.created_at,
         s.refreshed_at AT TIME ZONE 'UTC',
         s.not_after,
         s.aal::text,
         s.user_agent,
         host(s.ip)
    FROM auth.sessions s
   -- The whole security boundary. auth.uid() is null for an unauthenticated
   -- caller, and `user_id = null` matches nothing, so an anonymous call
   -- returns an empty set rather than everything.
   WHERE s.user_id = auth.uid()
   ORDER BY s.refreshed_at DESC NULLS LAST, s.created_at DESC;
$fn$;

REVOKE ALL ON FUNCTION public.rma_list_my_sessions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_list_my_sessions() TO authenticated;

-- ═══ Revoke one of my own sessions ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_revoke_my_session(p_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_deleted integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- `user_id = auth.uid()` is in the DELETE itself rather than checked first,
  -- so there is no window between the check and the delete and no way to pass
  -- someone else's session id and have it matter.
  DELETE FROM auth.sessions s
   WHERE s.id = p_session_id AND s.user_id = auth.uid();

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rma_revoke_my_session(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_revoke_my_session(uuid) TO authenticated;

-- ═══ Revoke every session of another user (admins only) ══════════════════════
-- Suspending a user in User Management previously left their existing sessions
-- running: nothing called signOut, so a suspended account kept working for
-- anything not guarded by rma_user_role().

CREATE OR REPLACE FUNCTION public.rma_revoke_user_sessions(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_deleted integer;
BEGIN
  IF NOT public.rma_is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can revoke another user''s sessions.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM auth.sessions s WHERE s.user_id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rma_revoke_user_sessions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_revoke_user_sessions(uuid) TO authenticated;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['rma_list_my_sessions','rma_revoke_my_session','rma_revoke_user_sessions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                    WHERE n.nspname='public' AND p.proname=v_name AND p.prosecdef) THEN
      RAISE EXCEPTION 'Refusing to finish: public.% is missing or not SECURITY DEFINER.', v_name;
    END IF;
    IF has_function_privilege('anon', 'public.' || v_name || '(uuid)', 'EXECUTE')
       AND v_name <> 'rma_list_my_sessions' THEN
      RAISE EXCEPTION 'Refusing to finish: anon can execute public.%.', v_name;
    END IF;
  END LOOP;
  RAISE NOTICE 'BUG-049: session listing and revocation are now real.';
END
$do$;

-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP FUNCTION public.rma_revoke_user_sessions(uuid);
--   DROP FUNCTION public.rma_revoke_my_session(uuid);
--   DROP FUNCTION public.rma_list_my_sessions();
