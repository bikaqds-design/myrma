-- Verify 20260783. Everything inside a transaction that is rolled back.
--
-- Why this is in SQL rather than clicked through: the app-level guard for "last
-- active super admin" can only be reached by a session that is NOT that admin,
-- and the only signed-in admin cannot demote themselves (the self-guard fires
-- first, correctly). So the state this protects against cannot be produced from
-- the UI at all — which is the point of putting the rule in the database too.

BEGIN;

-- Reduce to a single active super admin, then try to remove them.
CREATE TEMP TABLE _lastadmin(step text, outcome text) ON COMMIT DROP;

DO $$
DECLARE
  v_keep text;
  v_other text;
  r_demote_one text;
  r_demote_last text;
  r_delete_last text;
  r_suspend_last text;
BEGIN
  SELECT user_email INTO v_keep
    FROM public.user_roles WHERE role='super_admin' AND status='active'
    ORDER BY user_email LIMIT 1;
  SELECT user_email INTO v_other
    FROM public.user_roles WHERE role='super_admin' AND status='active'
      AND user_email <> v_keep LIMIT 1;

  -- demoting one of several is fine
  IF v_other IS NOT NULL THEN
    BEGIN
      UPDATE public.user_roles SET role='manager' WHERE user_email = v_other;
      r_demote_one := 'allowed (correct — another admin remains)';
    EXCEPTION WHEN OTHERS THEN r_demote_one := 'REFUSED: ' || SQLERRM;
    END;
  ELSE
    r_demote_one := 'skipped — only one active super admin to begin with';
  END IF;

  -- now v_keep is the last one. each of these must be refused.
  BEGIN
    UPDATE public.user_roles SET role='manager' WHERE user_email = v_keep;
    r_demote_last := 'ALLOWED — GUARD FAILED';
  EXCEPTION WHEN OTHERS THEN r_demote_last := 'refused: ' || left(SQLERRM, 60);
  END;

  BEGIN
    UPDATE public.user_roles SET status='suspended' WHERE user_email = v_keep;
    r_suspend_last := 'ALLOWED — GUARD FAILED';
  EXCEPTION WHEN OTHERS THEN r_suspend_last := 'refused: ' || left(SQLERRM, 60);
  END;

  BEGIN
    DELETE FROM public.user_roles WHERE user_email = v_keep;
    r_delete_last := 'ALLOWED — GUARD FAILED';
  EXCEPTION WHEN OTHERS THEN r_delete_last := 'refused: ' || left(SQLERRM, 60);
  END;

  INSERT INTO _lastadmin VALUES
    ('0. last admin under test', v_keep),
    ('1. demote one of several', r_demote_one),
    ('2. demote the last',       r_demote_last),
    ('3. suspend the last',      r_suspend_last),
    ('4. delete the last',       r_delete_last);
END
$$;

SELECT * FROM _lastadmin ORDER BY step;

ROLLBACK;

-- ── Reading the result ───────────────────────────────────────────────────────
--   1. allowed                    <- the guard is narrow, not blanket
--   2/3/4. refused: Refusing to remove the last active Super Admin ...
--
-- Any "ALLOWED — GUARD FAILED" means that path can still empty the system of
-- administrators, and recovery from that state needs direct database access.
