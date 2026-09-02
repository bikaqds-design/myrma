-- Create (or restore) a Super Admin.
--
-- ── When you need this ───────────────────────────────────────────────────────
--
--   1. First run of a new deployment. Nobody can be made an administrator
--      through the UI, because the admin_write policy on user_roles requires
--      rma_is_admin() — an existing admin. The first one has to be inserted
--      here.
--
--   2. Recovery. Since 20260786 a suspended, locked, deactivated, expired or
--      unprovisioned account genuinely has no access, at both layers. If the
--      last administrator loses theirs, this is the way back in.
--
-- ── Order of operations ──────────────────────────────────────────────────────
--
--   1. The person signs up in the app, or is invited from
--      Supabase Dashboard → Authentication → Users. They need an auth account;
--      this table is keyed on email and knows nothing about passwords.
--   2. On signing in they will see "Your account is not set up yet". That is
--      correct — they have no role.
--   3. Edit the email below and run this.
--   4. They reload the page. No new sign-in is needed.
--
-- ── Before running ───────────────────────────────────────────────────────────
--
-- Replace the address in v_email below — it appears once. The script refuses
-- to run while the placeholder is still in place, so a copy-paste cannot
-- create an account called 'you@example.com' with full administrative rights.

DO $$
DECLARE
  v_email    text := 'you@example.com';   -- ← edit this
  v_existing text;
BEGIN
  IF v_email = 'you@example.com' THEN
    RAISE EXCEPTION
      'Edit this script first: replace you@example.com with the real address (the v_email line near the top). Nothing has been changed.';
  END IF;

  SELECT role INTO v_existing FROM public.user_roles WHERE user_email = v_email;

  IF v_existing IS NULL THEN
    INSERT INTO public.user_roles (user_email, role, status)
         VALUES (v_email, 'super_admin', 'active');
    RAISE NOTICE 'Created % as an active super_admin.', v_email;
  ELSE
    -- Also clears any expiry and any stale permission overrides, so a recovered
    -- account comes back with the full super-admin defaults rather than
    -- whatever narrower map it was carrying.
    UPDATE public.user_roles
       SET role              = 'super_admin',
           status            = 'active',
           access_expires_at = NULL,
           permissions       = NULL,
           suspended_reason  = NULL,
           suspended_by      = NULL,
           suspended_date    = NULL
     WHERE user_email = v_email;
    RAISE NOTICE 'Restored % from % to an active super_admin.', v_email, v_existing;
  END IF;
END
$$;

-- Confirm. The new account must appear with status 'active' and no expiry.
SELECT user_email,
       role,
       status,
       access_expires_at,
       public.rma_access_is_current(status, access_expires_at) AS can_sign_in
  FROM public.user_roles
 WHERE role IN ('super_admin', 'admin')
 ORDER BY role, user_email;
