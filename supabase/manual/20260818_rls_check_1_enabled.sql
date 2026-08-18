-- RLS diagnostic, part 1 of 2. READ-ONLY.
--
-- Run this on its own. The Supabase SQL editor returns only the last
-- statement's result set, which is why a three-query file came back with just
-- the third answer.
--
-- What this answers: is row-level security actually switched on? A table with
-- policies but RLS disabled ignores them entirely and serves every row to
-- everyone — the single most likely explanation for a sales rep seeing other
-- reps' work, given every policy in the repo already scopes correctly.
--
-- Expected: rls_enabled = true on every row. Any false is the bug.

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
