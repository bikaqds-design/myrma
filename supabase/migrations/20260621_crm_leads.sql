-- ═══════════════════════════════════════════════════════════════════════════
--  CRM Sprint 1, Step 4 — leads table
--
--  converted_deal_id is a plain uuid here, NOT a foreign key — deals doesn't
--  exist until 20260622_crm_deals.sql. That migration adds the FK constraint
--  once the target table exists (Postgres validates FK targets at ADD
--  CONSTRAINT time, so referencing a not-yet-existing table here would fail).
--
--  RLS: sales_rep is deliberately excluded from rma_is_manager_or_above(),
--  but the permission matrix requires sales_rep to create/edit their OWN
--  leads — so this table needs a composite policy (manager_or_above() OR
--  sales_rep-scoped-to-own-rows) instead of the simpler manager-only
--  insert/update pattern used on contacts/pipelines. A sales_rep only sees
--  leads already assigned to them — unassigned leads (assigned_rep IS NULL,
--  "before triage") are manager+-only until a rep is assigned.
-- ═══════════════════════════════════════════════════════════════════════════


CREATE TABLE IF NOT EXISTS public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  company_name text,
  phone text,
  email text,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'new',
  assigned_rep uuid REFERENCES auth.users(id),
  notes text,
  converted_at timestamptz,
  converted_customer_id uuid REFERENCES public.customers(id),
  converted_deal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  updated_at timestamptz
);

ALTER TABLE public.leads
  DROP CONSTRAINT IF EXISTS chk_lead_source;
ALTER TABLE public.leads
  ADD CONSTRAINT chk_lead_source
  CHECK (source IN (
    'walk-in', 'phone', 'referral', 'exhibition', 'website', 'whatsapp'
  )) NOT VALID;

ALTER TABLE public.leads
  DROP CONSTRAINT IF EXISTS chk_lead_status;
ALTER TABLE public.leads
  ADD CONSTRAINT chk_lead_status
  CHECK (status IN (
    'new', 'contacted', 'qualified', 'converted', 'disqualified'
  )) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_leads_assigned_rep ON public.leads(assigned_rep);
CREATE INDEX IF NOT EXISTS idx_leads_status        ON public.leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_source         ON public.leads(source);
CREATE INDEX IF NOT EXISTS idx_leads_created_at     ON public.leads(created_at);


-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS leads_read ON public.leads;
CREATE POLICY leads_read ON public.leads
  FOR SELECT TO authenticated
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = auth.uid())
  );

DROP POLICY IF EXISTS leads_insert ON public.leads;
CREATE POLICY leads_insert ON public.leads
  FOR INSERT TO authenticated
  WITH CHECK (
    public.rma_is_manager_or_above()
    OR public.rma_user_role() = 'sales_rep'
  );

DROP POLICY IF EXISTS leads_update ON public.leads;
CREATE POLICY leads_update ON public.leads
  FOR UPDATE TO authenticated
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = auth.uid())
  )
  WITH CHECK (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = auth.uid())
  );

DROP POLICY IF EXISTS admin_delete ON public.leads;
CREATE POLICY admin_delete ON public.leads
  FOR DELETE TO authenticated USING (public.rma_is_admin());


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('chk_lead_source', 'chk_lead_status');
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'leads' ORDER BY policyname;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'leads' ORDER BY indexname;
