-- 20260806_accept_invitation.sql
--
-- Turn an accepted invitation into a working account.
--
-- ── The shape of the problem ─────────────────────────────────────────────────
--
-- admin-invite-user writes the invitee's role into user_roles with status
-- 'pending' at the moment the invitation is sent, so the answer to "what will
-- this person be able to do" is settled and visible before the email goes out.
--
-- 'pending' grants nothing: rma_access_is_current() returns true only for
-- 'active'. So something has to flip it once the person actually accepts, and
-- that something cannot be the invitee — 20260790 leaves user_roles writable
-- by administrators only, which is exactly right and must stay that way.
--
-- ── Why an RPC rather than a trigger on auth.users ───────────────────────────
--
-- A trigger firing on first sign-in would be invisible from this repo and hard
-- to reason about later. This is an explicit, narrow, auditable step: the app
-- calls it after a successful sign-in, and it can only ever do one thing.
--
-- ── What stops this being a privilege escalation ─────────────────────────────
--
-- It is SECURITY DEFINER, so it writes past the admin-only policy. Three things
-- keep that safe, and all three matter:
--
--   * it acts ONLY on the caller's own row, matched on the JWT's email — the
--     caller cannot name a different user;
--   * it moves ONLY 'pending' to 'active'. A suspended, locked or deactivated
--     account calling this changes nothing, so it can never be used to undo a
--     suspension;
--   * it never touches `role`. The role was decided by the super_admin who sent
--     the invitation, and accepting cannot alter it.

BEGIN;

CREATE OR REPLACE FUNCTION public.rma_accept_invitation()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_email text;
  v_status text;
BEGIN
  v_email := auth.jwt() ->> 'email';
  IF v_email IS NULL THEN
    RETURN 'not_authenticated';
  END IF;

  SELECT status INTO v_status
    FROM public.user_roles
   WHERE user_email = v_email;

  IF v_status IS NULL THEN
    -- Signed in with no role row: not an invitee. Say so rather than creating
    -- one, which would be a way to grant yourself access.
    RETURN 'no_role';
  END IF;

  IF v_status <> 'pending' THEN
    -- Already active, or suspended/locked/deactivated. Nothing to do, and
    -- deliberately NOT an error: the app calls this on every sign-in.
    RETURN v_status;
  END IF;

  UPDATE public.user_roles
     SET status = 'active'
   WHERE user_email = v_email
     AND status = 'pending';

  RETURN 'activated';
END
$fn$;

REVOKE ALL ON FUNCTION public.rma_accept_invitation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rma_accept_invitation() TO authenticated;

COMMENT ON FUNCTION public.rma_accept_invitation() IS
  'Activates the caller''s own pending invitation. Only pending -> active, only the caller''s row, never the role.';

DO $do$
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.rma_accept_invitation()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to apply: authenticated cannot accept an invitation.';
  END IF;
  IF has_function_privilege('anon', 'public.rma_accept_invitation()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to apply: anon can call rma_accept_invitation.';
  END IF;
END
$do$;

COMMIT;

-- ═══ Verification ════════════════════════════════════════════════════════════
-- Every row must report PASS.

SELECT CASE WHEN p.prosecdef THEN 'PASS' ELSE 'FAIL' END AS result,
       'is SECURITY DEFINER' AS what, p.prosecdef::text AS actual
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'rma_accept_invitation'
UNION ALL
SELECT CASE WHEN array_to_string(p.proconfig, ',') LIKE '%search_path%' THEN 'PASS' ELSE 'FAIL' END,
       'search_path is pinned', COALESCE(array_to_string(p.proconfig, ','), 'mutable')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'rma_accept_invitation'
UNION ALL
SELECT CASE WHEN NOT has_function_privilege('anon', 'public.rma_accept_invitation()', 'EXECUTE')
            THEN 'PASS' ELSE 'FAIL' END,
       'anon cannot execute it', 'revoked'
UNION ALL
-- Called with no JWT it must decline, not raise and not act.
SELECT CASE WHEN public.rma_accept_invitation() = 'not_authenticated' THEN 'PASS' ELSE 'FAIL' END,
       'declines when there is no signed-in user', public.rma_accept_invitation();
