-- Stop every staff member reading every colleague's full user_roles row.
--
-- 20260787 replaced a blanket `USING (true)` read on user_roles with
-- staff_read_user_roles — narrower, but still the whole row for anyone who can
-- sign in. The role probe measured the result: all six staff roles, viewer
-- included, read all 24 rows.
--
-- That row carries more than a directory:
--
--   password_hash        a legacy column from the Base44 era
--   permissions          the user's full permission map
--   notes                free text an administrator wrote about them
--   suspended_reason     why they were suspended, and by whom
--
-- None of it belongs to a viewer.
--
-- ── Why the policy was widened in the first place ────────────────────────────
--
-- Two reasons were given. One is real and one turned out not to exist.
--
-- Real: eleven pages call listAllRoles() to populate assignee dropdowns —
-- Customers, Leads, Pipeline, RMA Tickets, Sales Documents and their detail
-- views. Those need a list of who exists and what role they hold. Restricting
-- user_roles to "own row or admin" without providing that would empty every
-- assignee dropdown for non-admins.
--
-- Not real: the notification handlers were said to need another rep's phone
-- number. resolveRepPhone() in src/lib/events/crmEventHandlers.ts selects
-- `phone` from user_roles where `email` matches. user_roles has neither column
-- — it has user_email, and no phone at all. That lookup has never returned a
-- number, and the caller does `if (!phone) return`, so CRM WhatsApp
-- notifications to reps have silently done nothing since they were written.
-- See Finding 8; it is not fixed here, because deciding where a rep's phone
-- should live is a product question rather than a security one.
--
-- ── The shape ────────────────────────────────────────────────────────────────
--
-- A directory function returns the three fields the dropdowns actually use,
-- and nothing else. The table itself goes back to "your own row, or you are an
-- administrator".

CREATE OR REPLACE FUNCTION public.rma_staff_directory()
RETURNS TABLE(user_email text, role text, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  IF NOT public.rma_is_staff() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT ur.user_email, ur.role, ur.status
    FROM public.user_roles ur
   ORDER BY ur.user_email;
END;
$fn$;

COMMENT ON FUNCTION public.rma_staff_directory() IS
  'Who exists and what role they hold — the three fields the assignee dropdowns need. Deliberately excludes permissions, notes, suspended_reason and password_hash, which are administrator surface. Staff only; a suspended account fails rma_is_staff() and gets nothing.';

REVOKE ALL ON FUNCTION public.rma_staff_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rma_staff_directory() TO authenticated, service_role, postgres;

-- Back to own-row-or-admin. user_read_own from 20260526 already expresses
-- exactly that and is still in place, so this only removes the wider one.
DROP POLICY IF EXISTS staff_read_user_roles ON public.user_roles;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════
-- user_read_own must still exist, or User Management loses its own list and
-- nobody can read their own role — which would lock every user out at sign-in,
-- since finishLogin() treats an unreadable row as no access.

DO $do$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'user_roles'
     AND p.polcmd IN ('r', '*');

  IF v_n = 0 THEN
    RAISE EXCEPTION
      'Refusing to apply: user_roles would have no SELECT policy left. Nobody could read their own role, and finishLogin() would deny every sign-in. Nothing has been changed.';
  END IF;

  RAISE NOTICE 'user_roles narrowed to own-row-or-admin; % SELECT policy(ies) remain.', v_n;
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Re-run supabase/manual/20260823_probe_roles.sql. "read user_roles" should now
-- show 1 row for every non-admin role rather than 24, and still 24 for admin.
--
-- Also worth knowing, since it decides whether password_hash matters:
--
--   SELECT count(*) AS rows_with_a_password_hash
--     FROM public.user_roles WHERE password_hash IS NOT NULL;
--
-- If that is zero the column is dead weight and can be dropped. If it is not,
-- it is a credential store nobody is maintaining, and should be.
