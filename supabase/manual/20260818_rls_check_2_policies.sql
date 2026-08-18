-- RLS diagnostic, part 2 of 2. READ-ONLY. Run separately from part 1.
--
-- What this answers: what do the live SELECT policies actually say? Compare the
-- using_clause against what the repo expects:
--
--   deals / leads / activities
--     rma_is_manager_or_above()
--     OR (rma_user_role() = 'sales_rep' AND assigned_rep = rma_current_user_email())
--
--   quotations / sales_orders / crm_invoices / credit_notes
--     rma_is_manager_or_above()
--     OR (rma_is_staff() AND (assigned_rep = rma_current_user_email()
--                             OR created_by = rma_current_user_email()))
--
-- Tells: a clause of `true`, a missing sales_rep branch, or assigned_rep
-- compared against auth.uid() (a uuid against an email column — the superseded
-- form from 20260622, before 20260628 corrected it).

SELECT tablename, policyname, cmd, roles, qual AS using_clause
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('quotations','sales_orders','crm_invoices','credit_notes',
                    'deals','leads','activities')
  AND cmd IN ('SELECT','ALL')
ORDER BY tablename, policyname;
