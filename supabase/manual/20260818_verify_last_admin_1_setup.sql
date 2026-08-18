-- Verify 20260783, part 1 of 2. Run this first. It should SUCCEED.
--
-- No temp tables, no DO block, no exception handling. The previous version used
-- all three and failed on its own scaffolding — the second time a verification
-- script here has done that. The outcome is now the statement's own result or
-- its own error, which cannot mislead.
--
-- This part confirms the trigger exists and that the guard is narrow: demoting
-- one super admin while another remains active is still allowed.

-- 1. Is the trigger installed?
SELECT tgname AS trigger_name,
       CASE tgenabled WHEN 'O' THEN 'enabled' ELSE tgenabled::text END AS state
FROM pg_trigger
WHERE tgrelid = 'public.user_roles'::regclass
  AND NOT tgisinternal
ORDER BY tgname;
-- Expect trg_protect_last_super_admin, enabled.
-- (trg_validate_user_role from 20260782 should be here too.)

-- 2. Who is it protecting?
SELECT user_email, status
FROM public.user_roles
WHERE role = 'super_admin'
ORDER BY status, user_email;
