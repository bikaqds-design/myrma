-- ═══════════════════════════════════════════════════════════════════════════
--  CRM Sprint 1, Step 5 — deals table
--
--  stage is plain text, not a foreign key — pipelines.stages is a per-pipeline
--  JSONB array, not a fixed enum, so a static CHECK/FK can't express "valid
--  for this row's pipeline_id." Validated in deals.moveStage()/create() at
--  the API layer instead. See research.md §4.
--
--  product_lines is a JSONB ARRAY (never an object) — order-sensitive line
--  items. See CONSTITUTION.md §7.5a and research.md §3.
--
--  RLS uses the same composite pattern as leads: sales_rep is excluded from
--  rma_is_manager_or_above() by design, but needs create/edit on their own
--  deals, so this table needs its own scoped policy rather than the simple
--  manager-only insert/update pattern.
--
--  Also closes the loop from 20260621_crm_leads.sql: adds the FK on
--  leads.converted_deal_id now that deals exists (deferred because Postgres
--  validates FK targets at ADD CONSTRAINT time).
-- ═══════════════════════════════════════════════════════════════════════════


CREATE TABLE IF NOT EXISTS public.deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  contact_id uuid REFERENCES public.contacts(id),
  pipeline_id uuid NOT NULL REFERENCES public.pipelines(id),
  stage text NOT NULL,
  value numeric(12,2),
  probability integer NOT NULL DEFAULT 0,
  expected_close_date date,
  assigned_rep uuid REFERENCES auth.users(id),
  product_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open',
  lost_reason text,
  won_at timestamptz,
  lost_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  updated_at timestamptz
);

ALTER TABLE public.deals
  DROP CONSTRAINT IF EXISTS chk_deal_status;
ALTER TABLE public.deals
  ADD CONSTRAINT chk_deal_status
  CHECK (status IN ('open', 'won', 'lost')) NOT VALID;

ALTER TABLE public.deals
  DROP CONSTRAINT IF EXISTS chk_deal_probability;
ALTER TABLE public.deals
  ADD CONSTRAINT chk_deal_probability
  CHECK (probability >= 0 AND probability <= 100) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_deals_customer_id          ON public.deals(customer_id);
CREATE INDEX IF NOT EXISTS idx_deals_assigned_rep         ON public.deals(assigned_rep);
CREATE INDEX IF NOT EXISTS idx_deals_status               ON public.deals(status);
CREATE INDEX IF NOT EXISTS idx_deals_expected_close_date  ON public.deals(expected_close_date);


-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deals_read ON public.deals;
CREATE POLICY deals_read ON public.deals
  FOR SELECT TO authenticated
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = auth.uid())
  );

DROP POLICY IF EXISTS deals_insert ON public.deals;
CREATE POLICY deals_insert ON public.deals
  FOR INSERT TO authenticated
  WITH CHECK (
    public.rma_is_manager_or_above()
    OR public.rma_user_role() = 'sales_rep'
  );

DROP POLICY IF EXISTS deals_update ON public.deals;
CREATE POLICY deals_update ON public.deals
  FOR UPDATE TO authenticated
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = auth.uid())
  )
  WITH CHECK (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = auth.uid())
  );

DROP POLICY IF EXISTS admin_delete ON public.deals;
CREATE POLICY admin_delete ON public.deals
  FOR DELETE TO authenticated USING (public.rma_is_admin());


-- ── Close the loop: leads.converted_deal_id FK (deferred from Step 4) ──────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_converted_deal') THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT fk_leads_converted_deal
      FOREIGN KEY (converted_deal_id) REFERENCES public.deals(id);
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('chk_deal_status', 'chk_deal_probability', 'fk_leads_converted_deal');
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'deals' ORDER BY policyname;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'deals' ORDER BY indexname;
