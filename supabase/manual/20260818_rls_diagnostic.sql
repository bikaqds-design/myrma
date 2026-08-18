-- READ-ONLY diagnostic. Changes nothing.
--
-- Reported symptom: a sales_rep can see other reps' work. Every migration in
-- this repo says that should already be impossible, so the question is what is
-- actually live. Run all three queries and paste the output back.

-- 1. Is row-level security even switched on? A table with policies but RLS
--    disabled ignores them completely, and everyone sees everything. This is
--    the single most likely explanation for the symptom.
SELECT c.relname             AS table_name,
       c.relrowsecurity      AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       (SELECT count(*) FROM pg_policies p
         WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('quotations','sales_orders','crm_invoices','credit_notes',
                    'payments','deals','leads','activities','customers')
ORDER BY c.relrowsecurity, c.relname;

-- 2. What do the SELECT policies actually say right now? Compare the USING
--    clause against assigned_rep / rma_current_user_email(). If a policy reads
--    `true`, or `auth.uid()` against an email column, that is the leak.
SELECT tablename, policyname, cmd, roles, qual AS using_clause
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('quotations','sales_orders','crm_invoices','credit_notes',
                    'deals','leads','activities')
  AND cmd IN ('SELECT','ALL')
ORDER BY tablename, policyname;

-- 3. Are the helper functions the current versions? rma_is_staff() must include
--    'sales_rep' (added in 20260618) or a rep sees no sales documents at all,
--    and rma_current_user_email() must return the JWT email.
SELECT p.proname, pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('rma_is_staff','rma_is_manager_or_above',
                    'rma_user_role','rma_current_user_email')
ORDER BY p.proname;
