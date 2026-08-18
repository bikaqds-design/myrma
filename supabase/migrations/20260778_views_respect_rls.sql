-- Views were bypassing row-level security. This is the leak.
--
-- Symptom: a sales rep could see every other rep's quotations, sales orders and
-- invoices.
--
-- Not the policies. RLS is enabled on all nine CRM tables and every SELECT
-- policy scopes correctly — deals/leads/activities to
-- `assigned_rep = rma_current_user_email()`, and the sales documents to
-- assigned_rep or created_by. Verified live on 2026-08-18.
--
-- The cause is that the pages do not read those tables. They read views:
--
--     v_sales_documents    -> Sales page          (quotations, sales_orders,
--                                                  crm_invoices, credit_notes)
--     v_purchase_documents -> Purchasing          (purchase_orders, vendor_invoices)
--     v_customer_ledger    -> Accounting, CustomerDetails
--                                                 (crm_invoices, credit_notes, payments)
--     v_vendor_ledger      -> Accounting, VendorDetails
--                                                 (vendor_invoices, vendor_payments)
--
-- In PostgreSQL a view runs with the privileges of its OWNER unless it is
-- created with `security_invoker = true`. The owner here is the table owner,
-- which bypasses RLS. So the policies on the base tables were never consulted
-- for anything read through a view, and every row was served to every
-- authenticated user. None of the four views set the flag.
--
-- Requires PostgreSQL 15 or later, where security_invoker was introduced.

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'security_invoker requires PostgreSQL 15+. This server is %. Do not apply — the views would silently keep bypassing RLS.',
      current_setting('server_version');
  END IF;
END
$$;

ALTER VIEW public.v_sales_documents    SET (security_invoker = on);
ALTER VIEW public.v_purchase_documents SET (security_invoker = on);
ALTER VIEW public.v_customer_ledger    SET (security_invoker = on);
ALTER VIEW public.v_vendor_ledger      SET (security_invoker = on);

-- ── The accountant needs the whole ledger, not their own corner of it ────────
--
-- Turning on invoker rights makes the ledger views obey the base-table
-- policies, and `payments` / `vendor_payments` read as:
--
--     rma_is_manager_or_above()
--     OR (rma_is_staff() AND created_by = rma_current_user_email())
--
-- An accountant is staff but not manager_or_above, so without this they would
-- see only the payments they personally recorded — an incomplete cash position,
-- which is precisely the job the role exists to do. Those policies were written
-- before anything read them through an invoker-rights view, so this is fallout
-- from the fix rather than a pre-existing hole.
--
-- Read-only. Recording and reversing are still governed by the existing
-- staff_insert_* / manager_update_* / admin_delete_* policies.

DROP POLICY IF EXISTS "accountant_read_payments" ON public.payments;
CREATE POLICY "accountant_read_payments" ON public.payments
  FOR SELECT USING (public.rma_user_role() = 'accountant');

DROP POLICY IF EXISTS "accountant_read_vendor_payments" ON public.vendor_payments;
CREATE POLICY "accountant_read_vendor_payments" ON public.vendor_payments
  FOR SELECT USING (public.rma_user_role() = 'accountant');

-- Same reasoning for the purchase side of v_purchase_documents: an accountant
-- reconciling vendor invoices must see all of them, and purchase_orders gives
-- the context for what a vendor invoice is settling.

DROP POLICY IF EXISTS "accountant_read_vendor_invoices" ON public.vendor_invoices;
CREATE POLICY "accountant_read_vendor_invoices" ON public.vendor_invoices
  FOR SELECT USING (public.rma_user_role() = 'accountant');

DROP POLICY IF EXISTS "accountant_read_purchase_orders" ON public.purchase_orders;
CREATE POLICY "accountant_read_purchase_orders" ON public.purchase_orders
  FOR SELECT USING (public.rma_user_role() = 'accountant');

-- ─── Verification ────────────────────────────────────────────────────────────
--
-- 1. All four should report security_invoker=on:
--
--    SELECT c.relname,
--           COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
--                      WHERE option_name = 'security_invoker'), 'off') AS security_invoker
--      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--     WHERE n.nspname = 'public' AND c.relkind = 'v'
--       AND c.relname IN ('v_sales_documents','v_purchase_documents',
--                         'v_customer_ledger','v_vendor_ledger');
--
-- 2. Then check nothing that SHOULD be visible disappeared. The views now obey
--    the base-table policies, so a role with no policy on an underlying table
--    will see nothing rather than everything. Worth confirming as each role:
--
--      - manager / admin  -> still sees all sales and purchase documents
--      - accountant       -> still sees all four sales-document types
--                            (granted by the accountant_read_* policies in
--                            20260777) and both ledgers
--      - sales_rep        -> sees only their own
--
--    The accountant grants above cover the ledger tables. If any role still
--    sees an empty list after this, the fix is a read policy on the underlying
--    table, not reverting this migration — reverting restores the leak.
--
-- Rollback, should it be needed:
--    ALTER VIEW public.v_sales_documents    SET (security_invoker = off);
--    ALTER VIEW public.v_purchase_documents SET (security_invoker = off);
--    ALTER VIEW public.v_customer_ledger    SET (security_invoker = off);
--    ALTER VIEW public.v_vendor_ledger      SET (security_invoker = off);
--  — but note that reverting restores the leak.
