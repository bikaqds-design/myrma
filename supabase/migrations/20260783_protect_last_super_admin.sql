-- Never let the system reach zero administrators.
--
-- The app now refuses to suspend, lock, deactivate, expire or delete your own
-- account, and refuses to remove the last active super_admin. That is a UI
-- check, and this month has been a long lesson in the difference between the
-- interface declining and the database refusing. A direct API call, a bulk
-- update, or a future screen that forgets the rule would all still get through.
--
-- If the last active super_admin is removed, rma_user_role() returns NULL for
-- everyone who mattered, every policy closes, and nobody can grant the role
-- back from inside the app — it needs SQL access to recover. That is the one
-- state worth making structurally unreachable.
--
-- Deliberately narrow: it only fires when the change would take the count of
-- ACTIVE super admins to zero. Demoting one of several, suspending a lone
-- admin while another is active, deleting anyone else — all still allowed.

CREATE OR REPLACE FUNCTION public.rma_protect_last_super_admin() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE
  v_remaining integer;
BEGIN
  -- Only interested in changes that could remove an active super admin.
  IF TG_OP = 'UPDATE'
     AND OLD.role = 'super_admin' AND OLD.status = 'active'
     AND NEW.role = 'super_admin' AND NEW.status = 'active' THEN
    RETURN NEW;   -- still an active super admin, nothing to check
  END IF;

  IF NOT (OLD.role = 'super_admin' AND OLD.status = 'active') THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT count(*) INTO v_remaining
    FROM public.user_roles
   WHERE role = 'super_admin'
     AND status = 'active'
     AND user_email <> OLD.user_email;

  IF v_remaining = 0 THEN
    RAISE EXCEPTION
      'Refusing to remove the last active Super Admin (%). Promote another one first — with none left, nobody can administer the system and recovery needs direct database access.',
      OLD.user_email
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DROP TRIGGER IF EXISTS trg_protect_last_super_admin ON public.user_roles;
CREATE TRIGGER trg_protect_last_super_admin
  BEFORE UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.rma_protect_last_super_admin();

-- ─── Verification ────────────────────────────────────────────────────────────
-- Inside a rolled-back transaction, with two active super admins:
--   UPDATE user_roles SET role='viewer' WHERE user_email='<one of them>';  -- allowed
--   UPDATE user_roles SET role='viewer' WHERE user_email='<the other>';    -- REFUSED
--   DELETE FROM user_roles WHERE user_email='<the last one>';              -- REFUSED
--
-- Count the guard is protecting:
--   SELECT count(*) FROM user_roles WHERE role='super_admin' AND status='active';
