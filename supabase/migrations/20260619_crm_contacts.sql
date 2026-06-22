-- ═══════════════════════════════════════════════════════════════════════════
--  CRM Sprint 1, Step 2 — contacts table
--
--  Many contacts → one customer (account). A deals.contact_id may later
--  reference one of an account's contacts as the deal's primary point of
--  contact (added in 20260622_crm_deals.sql).
--
--  The "at most one is_primary contact per customer_id" invariant is
--  enforced at the application layer (contacts.create()/update() unsets any
--  prior primary before setting a new one) — not a DB constraint, matching
--  the existing soft-business-rule pattern used elsewhere in this codebase.
--  See specs/002-crm-upgrade/data-model.md.
--
--  RLS matches the existing customers/products pattern: any staff role
--  (including sales_rep, via rma_is_staff()) can read; only manager+ can
--  write. sales_rep does not get insert/update here — contacts management
--  isn't part of the Sprint 1 sales_rep permission matrix.
-- ═══════════════════════════════════════════════════════════════════════════


CREATE TABLE IF NOT EXISTS public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  title text,
  phone text,
  email text,
  is_primary boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_contacts_customer_id ON public.contacts(customer_id);


-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_read ON public.contacts;
CREATE POLICY staff_read ON public.contacts
  FOR SELECT TO authenticated USING (public.rma_is_staff());

DROP POLICY IF EXISTS manager_insert ON public.contacts;
CREATE POLICY manager_insert ON public.contacts
  FOR INSERT TO authenticated WITH CHECK (public.rma_is_manager_or_above());

DROP POLICY IF EXISTS manager_update ON public.contacts;
CREATE POLICY manager_update ON public.contacts
  FOR UPDATE TO authenticated
  USING (public.rma_is_manager_or_above())
  WITH CHECK (public.rma_is_manager_or_above());

DROP POLICY IF EXISTS admin_delete ON public.contacts;
CREATE POLICY admin_delete ON public.contacts
  FOR DELETE TO authenticated USING (public.rma_is_admin());


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT rowsecurity FROM pg_tables WHERE tablename = 'contacts';
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'contacts' ORDER BY policyname;
