-- End a user's sessions whenever they lose access, however they lose it.
-- (Follow-up to BUG-049 and BUG-087.)
--
-- ── What was already true ────────────────────────────────────────────────────
--
-- BUG-049 made suspension end sessions: `users.updateUserStatus()` calls
-- rma_revoke_user_sessions_by_email after writing 'suspended' or 'locked',
-- which deletes the user's auth.sessions rows (their refresh tokens cascade).
-- BUG-087 (20260867) made every database guard refuse a caller whose access is
-- not current. So a suspended user's still-valid access token already gets
-- nothing from the database, and Edge Functions check status themselves
-- (_shared/access.ts, BUG-021).
--
-- ── The gaps this closes ─────────────────────────────────────────────────────
--
-- The revoke lived in the browser, after the status write, best-effort:
--
--   1. 'deactivated' never revoked anything — the client only did it for
--      'suspended' and 'locked'.
--   2. Any other route to a status change revoked nothing: the SQL editor, a
--      restore, a future bulk action, or the client call simply failing (it is
--      reported to Sentry and swallowed, by design).
--   3. Setting an access expiry in the past revoked nothing.
--   4. Deleting a user's role row revoked nothing.
--   5. An expiry that PASSES revoked nothing, because nothing changes at that
--      moment — the row is untouched, the clock just moves.
--
-- Each of these left a device holding a refresh token that keeps minting new
-- access tokens indefinitely. The database would refuse every one of them, but
-- a session that should not exist should not exist.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- 1-4: an AFTER trigger on user_roles, so the revoke happens in the SAME
--      transaction as the change, whatever made it. If the revoke fails, the
--      change fails with it — no more "suspended but still signed in".
-- 5:   a sweep every 15 minutes (pg_cron), which is also a backstop for
--      anything the trigger cannot see.
--
-- 'pending' is deliberately NOT a loss of access. An invited user signs in
-- while their row is still 'pending' and then calls rma_accept_invitation
-- (20260806); revoking pending sessions would break every invitation.
--
-- Accounts with an auth login but no user_roles row are also left alone by the
-- sweep: that is the moment between signing up and the role row existing, and
-- sweeping it would race onboarding. Such a caller already gets nothing from
-- the database (20260867).
--
-- ── Residual, stated plainly ─────────────────────────────────────────────────
--
-- Deleting sessions ends refresh, not an access token already issued: that
-- stays cryptographically valid until it expires (Supabase default: 1 hour).
-- Within that window the database refuses it (20260867) and Edge Functions
-- check status (BUG-021), so the token opens nothing.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
BEGIN
  IF to_regclass('auth.sessions') IS NULL THEN
    RAISE EXCEPTION 'Refusing to apply: auth.sessions does not exist.';
  END IF;
  IF to_regprocedure('public.rma_access_is_current(text, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'Refusing to apply: rma_access_is_current(text, timestamptz) is missing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'Refusing to apply: pg_cron is not installed, so the expiry sweep could not be scheduled.';
  END IF;
  -- The trigger must see refresh tokens die with their session.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'auth.refresh_tokens'::regclass
       AND confrelid = 'auth.sessions'::regclass
       AND confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'Refusing to apply: auth.refresh_tokens no longer cascades from auth.sessions — deleting a session would not end refresh.';
  END IF;
END
$do$;

-- ═══ Internal: end every session for one email ═══════════════════════════════
-- No authorization check of its own, so it is NOT granted to any client role:
-- only the trigger and the sweep below call it. The admin-facing
-- rma_revoke_user_sessions_by_email (with its admin check) is unchanged.

CREATE OR REPLACE FUNCTION public.rma_end_sessions_for_email(p_email text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_deleted integer;
BEGIN
  IF p_email IS NULL OR btrim(p_email) = '' THEN
    RETURN 0;
  END IF;

  DELETE FROM auth.sessions s
   USING auth.users u
   WHERE s.user_id = u.id
     AND lower(u.email) = lower(btrim(p_email));

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rma_end_sessions_for_email(text) FROM PUBLIC;
DO $do$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.rma_end_sessions_for_email(text) FROM anon, authenticated';
END
$do$;

-- ═══ 1-4: the trigger ════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_user_roles_end_sessions_on_access_loss()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A removed user, or a cancelled invitation: nothing left to grant access.
    PERFORM public.rma_end_sessions_for_email(OLD.user_email);
    RETURN OLD;
  END IF;

  -- The row now describes a different person; the old address lost access.
  IF NEW.user_email IS DISTINCT FROM OLD.user_email THEN
    PERFORM public.rma_end_sessions_for_email(OLD.user_email);
  END IF;

  -- Moved INTO a status that grants nothing. 'pending' is excluded on purpose:
  -- an invitee signs in while pending (see the header).
  IF NEW.status IN ('suspended', 'locked', 'deactivated')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM public.rma_end_sessions_for_email(NEW.user_email);
  END IF;

  -- An expiry set (or moved) to a moment that has already passed.
  IF NEW.access_expires_at IS NOT NULL
     AND NEW.access_expires_at <= now()
     AND OLD.access_expires_at IS DISTINCT FROM NEW.access_expires_at THEN
    PERFORM public.rma_end_sessions_for_email(NEW.user_email);
  END IF;

  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rma_user_roles_end_sessions_on_access_loss() FROM PUBLIC;
DO $do$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.rma_user_roles_end_sessions_on_access_loss() FROM anon, authenticated';
END
$do$;

DROP TRIGGER IF EXISTS trg_user_roles_end_sessions_on_access_loss ON public.user_roles;
CREATE TRIGGER trg_user_roles_end_sessions_on_access_loss
  AFTER UPDATE OF status, access_expires_at, user_email OR DELETE ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.rma_user_roles_end_sessions_on_access_loss();

-- ═══ 5: the sweep ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_end_sessions_without_access()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_deleted integer;
BEGIN
  -- Users who HAVE a role row, whose access is not current, and who are not
  -- merely pending. Role-less logins are left alone (see the header).
  DELETE FROM auth.sessions s
   USING auth.users u, public.user_roles ur
   WHERE s.user_id = u.id
     AND lower(ur.user_email) = lower(u.email)
     AND COALESCE(ur.status, 'active') <> 'pending'
     AND NOT public.rma_access_is_current(ur.status, ur.access_expires_at);

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rma_end_sessions_without_access() FROM PUBLIC;
DO $do$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.rma_end_sessions_without_access() FROM anon, authenticated';
END
$do$;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'end-sessions-without-access') THEN
    PERFORM cron.unschedule('end-sessions-without-access');
  END IF;
  PERFORM cron.schedule(
    'end-sessions-without-access',
    '*/15 * * * *',
    'SELECT public.rma_end_sessions_without_access()'
  );
END
$do$;

-- ═══ Guards: the migration refuses to finish if it did not take ══════════════

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_user_roles_end_sessions_on_access_loss'
       AND tgrelid = 'public.user_roles'::regclass
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Refusing to finish: the user_roles trigger was not created.';
  END IF;

  -- None of these may be callable from a browser: they end sessions without
  -- asking who is asking.
  IF has_function_privilege('authenticated', 'public.rma_end_sessions_for_email(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_end_sessions_for_email(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rma_end_sessions_without_access()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_end_sessions_without_access()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: a session-ending function is executable by a client role.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'end-sessions-without-access' AND active
       AND schedule = '*/15 * * * *'
  ) THEN
    RAISE EXCEPTION 'Refusing to finish: the session sweep was not scheduled.';
  END IF;

  RAISE NOTICE 'Sessions now end on suspension, lock, deactivation, past expiry or removal; swept every 15 minutes.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Rolled-back probe (see the PR): a throwaway auth user with a session is
-- suspended → session gone; reactivated, new session, deactivated → gone;
-- pending → session KEPT; expiry set in the past → gone; expiry passing
-- silently → the sweep removes it; role row deleted → gone; an unrelated
-- user's session untouched throughout.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
-- SELECT cron.unschedule('end-sessions-without-access');
-- DROP TRIGGER trg_user_roles_end_sessions_on_access_loss ON public.user_roles;
-- DROP FUNCTION public.rma_user_roles_end_sessions_on_access_loss(),
--               public.rma_end_sessions_without_access(),
--               public.rma_end_sessions_for_email(text);
-- The client-side revoke in users.updateUserStatus() was removed with this
-- migration; restore it if the trigger is rolled back.
