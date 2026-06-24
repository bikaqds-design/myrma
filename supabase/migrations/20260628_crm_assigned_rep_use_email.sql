-- ═══════════════════════════════════════════════════════════════════════════
--  CRM Sprint 2 prerequisite — assigned_rep: uuid FK -> auth.users(id) becomes text (email)
--
--  Found while building the Leads page UI: there is no client-side way to
--  resolve a rep's auth.users.id from the browser (auth.users is Supabase's
--  protected auth schema, not queryable via PostgREST). db.userRoles
--  .listAllRoles() only returns user_roles rows keyed by email. RLS only
--  ever compared assigned_rep against auth.uid() (the CURRENT session's own
--  id, always available) — nothing in Sprint 1 needed to resolve an OTHER
--  user's id, so this gap was invisible until the UI needed to populate an
--  "assign rep" dropdown.
--
--  Fix: switch to text (email), matching the codebase's existing convention
--  for "who is this assigned to" — rma_tickets.assigned_technician is text,
--  not a uuid FK, and RLS elsewhere already compares against
--  rma_current_user_email() (e.g. time_entries.user_email). This brings the
--  4 new assigned_rep columns in line with that instead of being the one
--  place that diverged.
--
--  Safe to ALTER COLUMN directly (no USING cast / data migration needed):
--  Sprint 1 shipped with no UI, so no lead/deal/activity/customer row has
--  ever had assigned_rep written to it.
--
--  Postgres will not allow ALTER COLUMN TYPE while a policy still
--  references that column, so every policy touching assigned_rep must be
--  dropped first and recreated after the column type change.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── Drop every policy that references assigned_rep ──────────────────────────

DROP POLICY IF EXISTS leads_read ON public.leads;
DROP POLICY IF EXISTS leads_update ON public.leads;
DROP POLICY IF EXISTS deals_read ON public.deals;
DROP POLICY IF EXISTS deals_update ON public.deals;
DROP POLICY IF EXISTS activities_read ON public.activities;
DROP POLICY IF EXISTS activities_update ON public.activities;
DROP POLICY IF EXISTS sales_rep_update_assigned ON public.customers;


-- ── Drop FK constraints, then alter the column type ─────────────────────────

ALTER TABLE public.leads      DROP CONSTRAINT IF EXISTS leads_assigned_rep_fkey;
ALTER TABLE public.deals      DROP CONSTRAINT IF EXISTS deals_assigned_rep_fkey;
ALTER TABLE public.activities DROP CONSTRAINT IF EXISTS activities_assigned_rep_fkey;
ALTER TABLE public.customers  DROP CONSTRAINT IF EXISTS customers_assigned_rep_fkey;

ALTER TABLE public.leads      ALTER COLUMN assigned_rep TYPE text;
ALTER TABLE public.deals      ALTER COLUMN assigned_rep TYPE text;
ALTER TABLE public.activities ALTER COLUMN assigned_rep TYPE text;
ALTER TABLE public.customers  ALTER COLUMN assigned_rep TYPE text;


-- ── Recreate the policies: assigned_rep = auth.uid() -> rma_current_user_email() ──

CREATE POLICY leads_read ON public.leads
  FOR SELECT TO authenticated
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = public.rma_current_user_email())
  );

CREATE POLICY leads_update ON public.leads
  FOR UPDATE TO authenticated
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = public.rma_current_user_email())
  )
  WITH CHECK (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = public.rma_current_user_email())
  );

CREATE POLICY deals_read ON public.deals
  FOR SELECT TO authenticated
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = public.rma_current_user_email())
  );

CREATE POLICY deals_update ON public.deals
  FOR UPDATE TO authenticated
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = public.rma_current_user_email())
  )
  WITH CHECK (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = public.rma_current_user_email())
  );

CREATE POLICY activities_read ON public.activities
  FOR SELECT TO authenticated
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = public.rma_current_user_email())
  );

CREATE POLICY activities_update ON public.activities
  FOR UPDATE TO authenticated
  USING (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = public.rma_current_user_email())
  )
  WITH CHECK (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND assigned_rep = public.rma_current_user_email())
  );

CREATE POLICY sales_rep_update_assigned ON public.customers
  FOR UPDATE TO authenticated
  USING (
    public.rma_user_role() = 'sales_rep'
    AND assigned_rep = public.rma_current_user_email()
  )
  WITH CHECK (
    public.rma_user_role() = 'sales_rep'
    AND assigned_rep = public.rma_current_user_email()
  );


-- ── crm_convert_lead RPC: fix its internal auth check the same way ─────────

CREATE OR REPLACE FUNCTION public.crm_convert_lead(
  p_lead_id uuid,
  p_deal_title text,
  p_pipeline_id uuid,
  p_deal_value numeric DEFAULT NULL,
  p_existing_customer_id uuid DEFAULT NULL
) RETURNS TABLE(customer_id uuid, deal_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$$
DECLARE
  v_lead public.leads%ROWTYPE;
  v_customer_id uuid;
  v_deal_id uuid;
  v_first_stage text;
BEGIN
  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead % not found', p_lead_id;
  END IF;

  IF v_lead.converted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Lead % is already converted', p_lead_id;
  END IF;

  IF NOT (
    public.rma_is_manager_or_above()
    OR (public.rma_user_role() = 'sales_rep' AND v_lead.assigned_rep = public.rma_current_user_email())
  ) THEN
    RAISE EXCEPTION 'Not authorized to convert this lead';
  END IF;

  IF p_existing_customer_id IS NOT NULL THEN
    v_customer_id := p_existing_customer_id;
  ELSE
    INSERT INTO public.customers (
      customer_type, contact_person, company_name, mobile, email,
      lifecycle_stage, lead_source, assigned_rep
    ) VALUES (
      CASE WHEN v_lead.company_name IS NOT NULL THEN 'B2B' ELSE 'B2C' END,
      v_lead.full_name,
      v_lead.company_name,
      COALESCE(v_lead.phone, ''),
      v_lead.email,
      'customer',
      v_lead.source,
      v_lead.assigned_rep
    )
    RETURNING id INTO v_customer_id;
  END IF;

  SELECT stage->>'id' INTO v_first_stage
  FROM public.pipelines, jsonb_array_elements(stages) AS stage
  WHERE pipelines.id = p_pipeline_id
  ORDER BY (stage->>'order')::int ASC
  LIMIT 1;

  IF v_first_stage IS NULL THEN
    RAISE EXCEPTION 'Pipeline % has no stages', p_pipeline_id;
  END IF;

  INSERT INTO public.deals (title, customer_id, pipeline_id, stage, value, assigned_rep, created_by)
  VALUES (p_deal_title, v_customer_id, p_pipeline_id, v_first_stage, p_deal_value, v_lead.assigned_rep, auth.uid())
  RETURNING id INTO v_deal_id;

  UPDATE public.leads
  SET status = 'converted',
      converted_at = now(),
      converted_customer_id = v_customer_id,
      converted_deal_id = v_deal_id,
      updated_at = now()
  WHERE id = p_lead_id;

  RETURN QUERY SELECT v_customer_id, v_deal_id;
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT table_name, column_name, data_type FROM information_schema.columns
--   WHERE column_name = 'assigned_rep' AND table_name IN ('leads', 'deals', 'activities', 'customers');
-- Expected: data_type = 'text' for all 4 rows
-- SELECT conname FROM pg_constraint WHERE conname LIKE '%assigned_rep_fkey%';
-- Expected: 0 rows
-- SELECT tablename, policyname FROM pg_policies WHERE policyname IN
--   ('leads_read','leads_update','deals_read','deals_update','activities_read','activities_update','sales_rep_update_assigned');
-- Expected: 7 rows (all recreated)
