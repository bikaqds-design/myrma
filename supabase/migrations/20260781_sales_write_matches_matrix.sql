-- Sales-document writes did not match the permission matrix, in both
-- directions. Found reviewing this area after the read policies were fixed.
--
-- Too narrow. Every UPDATE policy on the four sales-document tables requires
-- manager_or_above, and quotations.update() / markSent() are direct table
-- updates rather than RPCs. A sales rep has `sales.edit: true` and owns the
-- document, and the database refused the save. The rep could raise a quotation
-- and then not correct a typo in it.
--
-- Too wide. Every INSERT policy is `WITH CHECK (rma_is_staff())`, which is every
-- internal role — so a technician or a viewer could create a quotation, sales
-- order, invoice or credit note through the API. Neither has a Sales page.
-- Same shape as the read holes in 20260779: the interface hides it, the
-- database allows it.
--
-- Target, straight from the matrix:
--
--   INSERT   manager+ and sales_rep
--   UPDATE   manager+ anything; sales_rep only documents they own
--
-- The accountant is deliberately excluded from both: `sales.create` and
-- `sales.edit` are false for that role, because settling cash and raising the
-- paperwork must not be the same person. Its read access is untouched.
--
-- Document-status rules — draft-only editing, posted invoices being immutable —
-- live in the RPCs and application logic and are not affected here. This governs
-- who may write, not which states are writable.

-- ── INSERT: manager+ and sales reps only ─────────────────────────────────────

DROP POLICY IF EXISTS "staff_insert_quotations" ON public.quotations;
CREATE POLICY "sales_insert_quotations" ON public.quotations
  FOR INSERT WITH CHECK (
    public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep'
  );

DROP POLICY IF EXISTS "staff_insert_sales_orders" ON public.sales_orders;
CREATE POLICY "sales_insert_sales_orders" ON public.sales_orders
  FOR INSERT WITH CHECK (
    public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep'
  );

DROP POLICY IF EXISTS "staff_insert_crm_invoices" ON public.crm_invoices;
CREATE POLICY "sales_insert_crm_invoices" ON public.crm_invoices
  FOR INSERT WITH CHECK (
    public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep'
  );

DROP POLICY IF EXISTS "staff_insert_credit_notes" ON public.credit_notes;
CREATE POLICY "sales_insert_credit_notes" ON public.credit_notes
  FOR INSERT WITH CHECK (
    public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep'
  );

-- ── UPDATE: a rep may edit what they own ─────────────────────────────────────
-- Both USING and WITH CHECK carry the ownership test, so a rep cannot edit
-- someone else's document and cannot reassign one away from themselves either.

DROP POLICY IF EXISTS "manager_update_quotations" ON public.quotations;
CREATE POLICY "sales_update_quotations" ON public.quotations
  FOR UPDATE
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep'
        AND (assigned_rep = public.rma_current_user_email()
             OR created_by = public.rma_current_user_email()))
  )
  WITH CHECK (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep'
        AND (assigned_rep = public.rma_current_user_email()
             OR created_by = public.rma_current_user_email()))
  );

DROP POLICY IF EXISTS "manager_update_sales_orders" ON public.sales_orders;
CREATE POLICY "sales_update_sales_orders" ON public.sales_orders
  FOR UPDATE
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep'
        AND (assigned_rep = public.rma_current_user_email()
             OR created_by = public.rma_current_user_email()))
  )
  WITH CHECK (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep'
        AND (assigned_rep = public.rma_current_user_email()
             OR created_by = public.rma_current_user_email()))
  );

-- crm_invoices and credit_notes keep manager-only UPDATE. A rep may raise an
-- invoice but not alter one after the fact; posting and voiding are already
-- manager-gated in post_invoice() and void_invoice(), and letting the raiser
-- edit it afterwards would undo that.

-- ─── Verification ────────────────────────────────────────────────────────────
-- As a sales_rep, inside a rolled-back transaction:
--   UPDATE quotations SET notes = 'x' WHERE assigned_rep = <their email>;  -> 1 row
--   UPDATE quotations SET notes = 'x' WHERE assigned_rep <> <their email>; -> 0 rows
-- As a technician:
--   INSERT INTO quotations ...                                             -> refused
