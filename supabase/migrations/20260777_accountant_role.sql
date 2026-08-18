-- The accountant role.
--
-- Owns cashflow: records and reverses customer and vendor payments and reads
-- the documents behind them. Cannot raise or post an invoice, or approve a
-- purchase order. That split is deliberate — standard AR/AP segregation of
-- duties holds that no single person should authorise, execute and record a
-- payment, because that combination is what lets money move unnoticed.
--
-- Two things have to change server-side or the role cannot exist:
--
--   1. chk_user_role rejects any role not in its list, so inserting an
--      accountant fails outright.
--   2. rma_is_staff() gates read access on most tables. Omitting the role
--      there would leave an accountant able to sign in and see nothing —
--      the same trap sales_rep hit before 20260618 added it.

-- ── 1. Allow the role ────────────────────────────────────────────────────────

ALTER TABLE public.user_roles
  DROP CONSTRAINT IF EXISTS chk_user_role;
ALTER TABLE public.user_roles
  ADD CONSTRAINT chk_user_role
  CHECK (role IN (
    'super_admin', 'admin', 'manager', 'technician', 'viewer',
    'sales_rep', 'accountant'
  )) NOT VALID;

-- ── 2. Treat it as staff ─────────────────────────────────────────────────────
-- Staff is the broad "is an internal user" gate. It is NOT manager_or_above,
-- so this grants no elevated rights: policies that scope by owner still scope,
-- and manager-only policies still exclude the accountant.

CREATE OR REPLACE FUNCTION public.rma_is_staff() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS
$$ SELECT public.rma_user_role() IN (
  'super_admin', 'admin', 'manager', 'technician', 'viewer',
  'sales_rep', 'accountant'
) $$;

-- ── 3. Full read on sales documents, for reconciliation ──────────────────────
-- The staff read policies scope non-managers to their own rows
-- (assigned_rep = me OR created_by = me). An accountant is assigned to none of
-- them, so without this they would see an empty ledger — which defeats the
-- role. Reading every document is the job; writing them is not, and the
-- existing manager_update_* / admin_delete_* policies already exclude them.

DROP POLICY IF EXISTS "accountant_read_quotations" ON public.quotations;
CREATE POLICY "accountant_read_quotations" ON public.quotations
  FOR SELECT USING (public.rma_user_role() = 'accountant');

DROP POLICY IF EXISTS "accountant_read_sales_orders" ON public.sales_orders;
CREATE POLICY "accountant_read_sales_orders" ON public.sales_orders
  FOR SELECT USING (public.rma_user_role() = 'accountant');

DROP POLICY IF EXISTS "accountant_read_crm_invoices" ON public.crm_invoices;
CREATE POLICY "accountant_read_crm_invoices" ON public.crm_invoices
  FOR SELECT USING (public.rma_user_role() = 'accountant');

DROP POLICY IF EXISTS "accountant_read_credit_notes" ON public.credit_notes;
CREATE POLICY "accountant_read_credit_notes" ON public.credit_notes
  FOR SELECT USING (public.rma_user_role() = 'accountant');

-- ─── Verification ────────────────────────────────────────────────────────────
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_user_role';
-- SELECT pg_get_functiondef('public.rma_is_staff'::regproc);
-- Should list the four accountant_read_* policies:
--   SELECT tablename, policyname FROM pg_policies
--    WHERE policyname LIKE 'accountant%' ORDER BY tablename;
