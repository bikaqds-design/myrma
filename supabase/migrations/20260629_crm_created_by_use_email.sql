-- ═══════════════════════════════════════════════════════════════════════════
--  CRM Sprint 2 fix — created_by: uuid FK -> auth.users(id) becomes text (email)
--
--  Same root cause as 20260628_crm_assigned_rep_use_email.sql: leads,
--  contacts, deals, and activities were created with
--  `created_by uuid REFERENCES auth.users(id)`, but every page in this app
--  (Leads/index.jsx, customers.ts, tickets.ts, ...) writes the current
--  user's EMAIL into created_by, matching the established convention
--  (customers.created_by / rma_tickets.created_by are TEXT, not a uuid FK).
--  Inserting an email string into a uuid column fails with "invalid uuid",
--  surfaced when testing "Add Lead" in the UI.
--
--  No RLS policy on these 4 tables references created_by (only
--  assigned_rep is policy-scoped — see the table migrations), so unlike
--  the assigned_rep fix, no policies need to be dropped/recreated here.
--
--  Safe to ALTER COLUMN directly (no USING cast / data migration needed):
--  no lead/contact/deal/activity row has ever had created_by written to it,
--  since every UI write to these tables until now has errored out.
-- ═══════════════════════════════════════════════════════════════════════════


ALTER TABLE public.leads      DROP CONSTRAINT IF EXISTS leads_created_by_fkey;
ALTER TABLE public.contacts   DROP CONSTRAINT IF EXISTS contacts_created_by_fkey;
ALTER TABLE public.deals      DROP CONSTRAINT IF EXISTS deals_created_by_fkey;
ALTER TABLE public.activities DROP CONSTRAINT IF EXISTS activities_created_by_fkey;

ALTER TABLE public.leads      ALTER COLUMN created_by TYPE text;
ALTER TABLE public.contacts   ALTER COLUMN created_by TYPE text;
ALTER TABLE public.deals      ALTER COLUMN created_by TYPE text;
ALTER TABLE public.activities ALTER COLUMN created_by TYPE text;


-- ── crm_convert_lead RPC: the deal it inserts also wrote auth.uid() into
--    created_by — fix the same way (use the current user's email instead) ──

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
  VALUES (p_deal_title, v_customer_id, p_pipeline_id, v_first_stage, p_deal_value, v_lead.assigned_rep, public.rma_current_user_email())
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
--   WHERE column_name = 'created_by' AND table_name IN ('leads', 'contacts', 'deals', 'activities');
-- Expected: data_type = 'text' for all 4 rows
-- SELECT conname FROM pg_constraint WHERE conname LIKE '%created_by_fkey%' AND conname LIKE '%leads%' OR conname LIKE '%contacts%' OR conname LIKE '%deals%' OR conname LIKE '%activities%';
-- Expected: 0 rows
