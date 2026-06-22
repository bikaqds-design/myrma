-- ═══════════════════════════════════════════════════════════════════════════
--  CRM Sprint 1 hotfix — drop the duplicate, stale user_roles role CHECK
--
--  user_roles had TWO independent CHECK constraints on the role column:
--  chk_user_role (explicit, added in 20260526_check_constraints.sql — fixed
--  to include sales_rep in 20260618_crm_add_sales_rep_role.sql) and
--  user_roles_role_check (an auto-named inline constraint from the original
--  CREATE TABLE, predating this migration folder — never updated, so it
--  still rejected sales_rep even after Step 1 "fixed" the role).
--
--  Dropping the duplicate rather than updating both — two constraints
--  enforcing the same rule on the same column is exactly the kind of
--  drift that caused this bug, not a safety net.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.user_roles
  DROP CONSTRAINT IF EXISTS user_roles_role_check;


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.user_roles'::regclass AND contype = 'c';
-- Expected: only chk_user_role and chk_user_status remain, both including sales_rep where relevant.
