-- Suspending a user actually ends their sessions. (Audit finding BUG-049, second half.)
--
-- Suspension previously only wrote `user_roles.status = 'suspended'`. Nothing
-- called any sign-out, so every device the user had signed in on kept a valid
-- refresh token and went on renewing. RLS stops them wherever a policy consults
-- `rma_user_role()`, but that is not everywhere — Edge Functions in particular
-- do their own checks (BUG-021) — so "suspended" meant less than the screen
-- implied.
--
-- The app keys users by email everywhere (`user_roles.user_email` is the join
-- column, and the User Management screen never has an auth id in hand), so the
-- callable form takes an email and resolves the auth id itself. The uuid
-- function from 20260837 stays as the primitive that carries the admin check.

CREATE OR REPLACE FUNCTION public.rma_revoke_user_sessions_by_email(p_email text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_user_id uuid;
BEGIN
  IF NOT public.rma_is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can revoke another user''s sessions.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT u.id INTO v_user_id FROM auth.users u WHERE lower(u.email) = lower(btrim(p_email));

  -- A user_roles row can exist for someone who has never signed in. That is not
  -- an error: there are simply no sessions to end.
  IF v_user_id IS NULL THEN
    RETURN 0;
  END IF;

  RETURN public.rma_revoke_user_sessions(v_user_id);
END;
$fn$;

REVOKE ALL ON FUNCTION public.rma_revoke_user_sessions_by_email(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_revoke_user_sessions_by_email(text) TO authenticated;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='rma_revoke_user_sessions_by_email' AND p.prosecdef) THEN
    RAISE EXCEPTION 'Refusing to finish: the function is missing or not SECURITY DEFINER.';
  END IF;
  RAISE NOTICE 'BUG-049: suspension can now end a user''s sessions.';
END
$do$;

-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP FUNCTION public.rma_revoke_user_sessions_by_email(text);
