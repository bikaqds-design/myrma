-- Align RLS with the permission matrix. Two holes of the same kind as the view
-- leak, found by the role simulation after 20260778 closed that one.
--
-- Measured through the views as each role:
--
--   role         sales_docs  purchase_docs  vend_ledger
--   manager           101          9             4
--   accountant        101          9             4
--   sales_rep           5          9             4     <- 5 is correct, 9 and 4 are not
--   technician          3          9             4     <- none of these are correct
--
-- Two causes.
--
-- 1. purchase_orders and vendor_invoices carry no ownership condition at all:
--
--        USING (public.rma_is_staff())
--
--    rma_is_staff() is every internal role, so every sales rep and technician
--    could read every purchase order and vendor invoice. The Purchasing page is
--    hidden from them in the app, which is why nobody noticed — but the API
--    served it. Widening rma_is_staff() to include 'accountant' in 20260777
--    made this broader still.
--
--    v_vendor_ledger reads vendor_invoices, which is why the vendor ledger was
--    fully visible too: fixing the table fixes the ledger.
--
-- 2. The four sales-document tables scope their ownership branch to
--    rma_is_staff() rather than to sales reps, so a technician sees any
--    document they happen to have created. The app gives technicians and
--    viewers no Sales access at all; the database should say the same.
--
-- Target, matching the app's permission matrix:
--
--   purchasing docs   manager+ and accountant see all; nobody else, any
--   sales docs        manager+ and accountant see all; sales_rep sees own;
--                     technician and viewer see none

-- ── 1. Purchasing is not for all staff ───────────────────────────────────────
-- accountant_read_purchase_orders / accountant_read_vendor_invoices from
-- 20260778 still grant the accountant full read, so this only removes the
-- unintended roles.

DROP POLICY IF EXISTS "staff_read_purchase_orders" ON public.purchase_orders;
CREATE POLICY "manager_read_purchase_orders" ON public.purchase_orders
  FOR SELECT USING (public.rma_is_manager_or_above());

DROP POLICY IF EXISTS "staff_read_vendor_invoices" ON public.vendor_invoices;
CREATE POLICY "manager_read_vendor_invoices" ON public.vendor_invoices
  FOR SELECT USING (public.rma_is_manager_or_above());

-- ── 2. Sales-document ownership belongs to sales reps, not to all staff ──────

DROP POLICY IF EXISTS "sales_rep_read_quotations" ON public.quotations;
CREATE POLICY "sales_rep_read_quotations" ON public.quotations
  FOR SELECT USING (
    public.rma_is_manager_or_above()
    OR (
      public.rma_user_role() = 'sales_rep'
      AND (assigned_rep = public.rma_current_user_email()
           OR created_by = public.rma_current_user_email())
    )
  );

DROP POLICY IF EXISTS "staff_read_sales_orders" ON public.sales_orders;
CREATE POLICY "sales_rep_read_sales_orders" ON public.sales_orders
  FOR SELECT USING (
    public.rma_is_manager_or_above()
    OR (
      public.rma_user_role() = 'sales_rep'
      AND (assigned_rep = public.rma_current_user_email()
           OR created_by = public.rma_current_user_email())
    )
  );

DROP POLICY IF EXISTS "staff_read_crm_invoices" ON public.crm_invoices;
CREATE POLICY "sales_rep_read_crm_invoices" ON public.crm_invoices
  FOR SELECT USING (
    public.rma_is_manager_or_above()
    OR (
      public.rma_user_role() = 'sales_rep'
      AND (assigned_rep = public.rma_current_user_email()
           OR created_by = public.rma_current_user_email())
    )
  );

DROP POLICY IF EXISTS "staff_read_credit_notes" ON public.credit_notes;
CREATE POLICY "sales_rep_read_credit_notes" ON public.credit_notes
  FOR SELECT USING (
    public.rma_is_manager_or_above()
    OR (
      public.rma_user_role() = 'sales_rep'
      AND (assigned_rep = public.rma_current_user_email()
           OR created_by = public.rma_current_user_email())
    )
  );

-- ─── Verification ────────────────────────────────────────────────────────────
-- Re-run supabase/manual/20260818_verify_view_rls.sql. Expected afterwards:
--
--   role         sales_docs  purchase_docs  cust_ledger  vend_ledger
--   manager           101          9            21            4
--   accountant        101          9            21            4
--   sales_rep           5          0             1            0
--   technician          0          0             0            0
--
-- Anything else — particularly a manager or accountant dropping to 0 — means a
-- policy was removed that something still needed. Restoring reads is the fix;
-- reverting reopens the hole.
