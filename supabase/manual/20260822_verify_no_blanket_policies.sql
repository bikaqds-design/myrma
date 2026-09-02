-- Verify 20260787. Run AFTER applying it.
--
-- Should return ZERO rows. Every row is a policy that grants access without
-- consulting the role model — either a blanket true / auth.role() test, or a
-- hand-rolled admin check that skips the status and expiry gate that
-- rma_access_is_current() applies.
--
-- Read-only.

SELECT c.relname                                   AS table_name,
       p.polname                                   AS policy_name,
       CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                     WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                     ELSE 'ALL' END                AS cmd,
       CASE WHEN p.polroles = '{0}'::oid[] THEN 'PUBLIC'
            ELSE array_to_string(
                   ARRAY(SELECT pg_get_userbyid(r) FROM unnest(p.polroles) r), ', ')
       END                                         AS roles,
       CASE
         WHEN pg_get_expr(p.polqual, p.polrelid) ILIKE '%auth.role()%'
           OR pg_get_expr(p.polwithcheck, p.polrelid) ILIKE '%auth.role()%'
           THEN 'BLANKET — any signed-in session passes, ignores user_roles entirely'
         WHEN pg_get_expr(p.polqual, p.polrelid) ILIKE '%FROM user_roles%'
           OR pg_get_expr(p.polwithcheck, p.polrelid) ILIKE '%FROM user_roles%'
           THEN 'HAND-ROLLED ADMIN — skips the status/expiry check in rma_access_is_current()'
         ELSE 'UNCONDITIONAL — grants without any test'
       END                                         AS problem,
       COALESCE(pg_get_expr(p.polqual, p.polrelid), '(none)')      AS using_expr,
       COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '(none)') AS with_check_expr
  FROM pg_policy p
  JOIN pg_class c     ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND (
     -- a blanket authenticated test
     pg_get_expr(p.polqual, p.polrelid)      ILIKE '%auth.role()%'
     OR pg_get_expr(p.polwithcheck, p.polrelid) ILIKE '%auth.role()%'
     -- an admin check that reads user_roles directly instead of rma_is_admin()
     OR pg_get_expr(p.polqual, p.polrelid)      ILIKE '%FROM user_roles%'
     OR pg_get_expr(p.polwithcheck, p.polrelid) ILIKE '%FROM user_roles%'
     -- an unconditional grant
     OR pg_get_expr(p.polqual, p.polrelid)      = 'true'
     OR pg_get_expr(p.polwithcheck, p.polrelid) = 'true'
   )
   -- kb_public_read is deliberately open to anon for the /kb page, and tests a
   -- column rather than granting unconditionally, so it is not caught above.
   AND p.polname <> 'kb_public_read'
 ORDER BY c.relname, p.polname;
