-- Verify 20260783, part 2 of 2. THIS SCRIPT IS SUPPOSED TO FAIL.
--
-- It leaves one active super admin and then tries to remove them. A successful
-- run means the guard did NOT hold and the system can be emptied of
-- administrators. The expected outcome is:
--
--   ERROR: Refusing to remove the last active Super Admin (...)
--
-- Everything is inside a transaction. The error aborts it, so nothing here
-- persists whether it passes or fails — but end with ROLLBACK anyway if your
-- editor leaves the transaction open.

BEGIN;

-- Leave exactly one active super admin: demote every other one.
-- This part must SUCCEED — proof the guard is narrow rather than blanket.
UPDATE public.user_roles
   SET role = 'manager'
 WHERE role = 'super_admin'
   AND status = 'active'
   AND user_email <> (
     SELECT user_email FROM public.user_roles
      WHERE role = 'super_admin' AND status = 'active'
      ORDER BY user_email LIMIT 1
   );

-- Sanity: this should report exactly 1.
SELECT count(*) AS active_super_admins_remaining
  FROM public.user_roles WHERE role = 'super_admin' AND status = 'active';

-- Now remove the last one. THIS MUST RAISE.
UPDATE public.user_roles
   SET role = 'manager'
 WHERE role = 'super_admin' AND status = 'active';

-- Only reached if the guard failed:
SELECT 'GUARD FAILED — the system now has no administrators' AS result;

ROLLBACK;
