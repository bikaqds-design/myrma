-- Make suspension real.
--
-- User Management offers Suspend, Lock, Deactivate and Set Expiration. Before
-- this migration none of them removed any access:
--
--   * rma_user_role() reads user_roles.role without looking at status, and
--     every other RLS helper — rma_is_admin, rma_is_manager_or_above,
--     rma_is_staff, rma_can_handle_cash — is defined in terms of it. So a
--     suspended user kept their full role at the database layer.
--   * The application never reads status either. finishLogin() takes
--     roleData.role and renders the app.
--
--   A suspended or locked account therefore retained complete access until
--   somebody deleted its auth user. For an offboarded employee that is the
--   whole point of the feature, and it did nothing.
--
-- Two more defects in the same screen:
--
--   * Deactivate writes status 'deactivated', which chk_user_status
--     (active, suspended, locked) rejects. The action always failed.
--   * Set Expiration calls db.userRoles.setUserExpiration, which does not
--     exist, against a column that does not exist. It always threw.
--
-- StatusBadge already renders five states — active, suspended, locked,
-- deactivated, pending — so the UI was built for a domain the column never
-- allowed.
--
-- This migration fixes the database half. The application half is in
-- src/App.jsx (an explicit no-access screen) and src/api/db/users.ts
-- (setUserExpiration).
--
-- SAFETY: the last statement refuses the whole migration if applying it would
-- leave nobody able to administer the system. The Supabase SQL editor runs a
-- script in one implicit transaction, so that RAISE rolls back everything
-- above it. It is safe to run without knowing the current status values.

-- ── 1. Normalise NULL status ─────────────────────────────────────────────────
-- Rows predating the status column hold NULL. Once status is enforced, NULL
-- has to mean something explicit, and the only safe reading of an existing
-- working account is 'active'. Done first so everything below sees clean data.

UPDATE public.user_roles SET status = 'active' WHERE status IS NULL;

-- ── 2. Widen the status domain to the one the UI already renders ────────────

ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS chk_user_status;
ALTER TABLE public.user_roles
  ADD CONSTRAINT chk_user_status
  CHECK (status IN ('active', 'suspended', 'locked', 'deactivated', 'pending'));

-- Not NOT VALID this time: step 1 guarantees every existing row satisfies it,
-- so it can be validated now rather than leaving a constraint that has never
-- been checked against the data it guards.

ALTER TABLE public.user_roles ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE public.user_roles ALTER COLUMN status SET NOT NULL;

-- ── 3. The expiry column Set Expiration was always missing ──────────────────

ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS access_expires_at timestamptz;

COMMENT ON COLUMN public.user_roles.access_expires_at IS
  'Access ends at this instant. NULL means no expiry. Enforced centrally by rma_access_is_current(), so every RLS policy honours it without change.';

-- ── 4. One definition of "this account may act right now" ───────────────────
-- Three places need this test: the role lookup, the last-super-admin trigger,
-- and the guard at the bottom of this file. Defining it once is deliberate —
-- the permissions rebuild earlier in this project shipped two copies of a
-- ceiling rule that then drifted apart, and this is the same shape of risk.

CREATE OR REPLACE FUNCTION public.rma_access_is_current(
  p_status  text,
  p_expires timestamptz
) RETURNS boolean
  LANGUAGE sql STABLE AS
$fn$ SELECT COALESCE(p_status, 'active') = 'active'
        AND (p_expires IS NULL OR p_expires > now()) $fn$;

COMMENT ON FUNCTION public.rma_access_is_current(text, timestamptz) IS
  'True when a user_roles row grants access at this moment: active status and no expiry, or an expiry still in the future. Any non-active status — suspended, locked, deactivated, pending — denies. Unknown future statuses deny too, which is the correct direction to fail.';

-- ── 5. Gate the role lookup ─────────────────────────────────────────────────
-- Returning NULL rather than the role means rma_is_staff(), rma_is_admin(),
-- rma_is_manager_or_above() and rma_can_handle_cash() all become false at
-- once, and every policy written in terms of them denies. No policy changes.
--
-- Preserves 20260782 exactly: a custom role still resolves to its base_role.

CREATE OR REPLACE FUNCTION public.rma_user_role() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER AS
$fn$
  SELECT COALESCE(cr.base_role, ur.role)
    FROM public.user_roles ur
    LEFT JOIN public.custom_roles cr ON cr.role_name = ur.role
   WHERE ur.user_email = (auth.jwt() ->> 'email')
     AND public.rma_access_is_current(ur.status, ur.access_expires_at)
   LIMIT 1
$fn$;

COMMENT ON FUNCTION public.rma_user_role() IS
  'The role RLS should treat this user as, or NULL if the account is not currently usable. A custom role resolves to its base_role, so policies never need to know custom roles exist. Suspension, locking, deactivation and expiry all take effect here, which is why no individual policy mentions status.';

-- ── 6. The last-super-admin guard must count expiry too ─────────────────────
-- 20260783 counts super admins with status = 'active'. With an expiry column
-- that is no longer the whole test: setting an expiry on the last super admin
-- would have walked straight past the guard. Rewritten in terms of the shared
-- helper so the two can no longer disagree.
--
-- Also fixes a NULL hole in the original: `OLD.status = 'active'` evaluates to
-- NULL rather than false when status is NULL, so `NOT (...)` never returned
-- true and the early exit was skipped. Step 1 removes the NULLs and the helper
-- coalesces regardless.

CREATE OR REPLACE FUNCTION public.rma_protect_last_super_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_remaining integer;
  v_was_admin boolean;
  v_is_admin  boolean;
BEGIN
  v_was_admin := OLD.role = 'super_admin'
                 AND rma_access_is_current(OLD.status, OLD.access_expires_at);

  -- Not an effective super admin before the change: nothing can be lost.
  IF NOT v_was_admin THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_is_admin := NEW.role = 'super_admin'
                  AND rma_access_is_current(NEW.status, NEW.access_expires_at);
    IF v_is_admin THEN
      RETURN NEW;   -- still an effective super admin
    END IF;
  END IF;

  SELECT count(*) INTO v_remaining
    FROM public.user_roles
   WHERE role = 'super_admin'
     AND rma_access_is_current(status, access_expires_at)
     AND user_email <> OLD.user_email;

  IF v_remaining = 0 THEN
    RAISE EXCEPTION
      'Refusing to remove the last active Super Admin (%). Promote another one first — with none left, nobody can administer the system and recovery needs direct database access.',
      OLD.user_email
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

DROP TRIGGER IF EXISTS trg_protect_last_super_admin ON public.user_roles;
CREATE TRIGGER trg_protect_last_super_admin
  BEFORE UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.rma_protect_last_super_admin();

-- ── 7. Refuse the whole migration if it would lock everyone out ─────────────
-- Everything above is undone if this raises.

DO $do$
DECLARE
  v_admins integer;
BEGIN
  SELECT count(*) INTO v_admins
    FROM public.user_roles ur
    LEFT JOIN public.custom_roles cr ON cr.role_name = ur.role
   WHERE COALESCE(cr.base_role, ur.role) IN ('super_admin', 'admin')
     AND public.rma_access_is_current(ur.status, ur.access_expires_at);

  IF v_admins = 0 THEN
    RAISE EXCEPTION
      'Refusing to enforce user status: no active, unexpired admin or super admin would remain, so nobody could administer the system afterwards. Set one user to active status with a NULL access_expires_at first, then re-run. Nothing has been changed.';
  END IF;

  RAISE NOTICE 'User status enforced. % admin/super_admin account(s) remain able to sign in.', v_admins;
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Run supabase/manual/20260820_verify_user_status.sql — it simulates a
-- suspended user and confirms the role lookup now returns NULL for them.
