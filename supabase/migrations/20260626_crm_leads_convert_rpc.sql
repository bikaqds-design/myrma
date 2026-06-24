-- ═══════════════════════════════════════════════════════════════════════════
--  CRM Sprint 1, Step 12 prerequisite — atomic lead-to-deal conversion RPC
--
--  Backs db.leads.convert(). A customer row, a deal row, and the lead's
--  converted_* fields must all succeed or all fail together — see
--  research.md §1. A single SECURITY DEFINER function body is atomic by
--  construction (any RAISE EXCEPTION rolls back everything already done in
--  this call), avoiding the partial-failure window a client-side sequence
--  of insert/update calls would have.
--
--  Unlike the existing delete_customer_cascade/delete_customers_cascade
--  RPCs (granted to anon+authenticated with no internal auth check, relying
--  entirely on UI-level canDo() gating), this function explicitly
--  replicates the leads_update RLS policy's authorization logic inside the
--  function body. SECURITY DEFINER bypasses RLS, so without this check any
--  authenticated sales_rep could convert ANY lead (not just their own) by
--  calling the RPC directly. Granted to `authenticated` only, not `anon` —
--  no public/tracker use case for this.
--
--  Known limitation: if a lead has neither phone nor email (data-model.md's
--  soft-validation case) and a NEW customer is created, customers.mobile
--  (NOT NULL) gets an empty string. Not blocking for Sprint 1 — the rep
--  fills it in manually afterward.
-- ═══════════════════════════════════════════════════════════════════════════


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
    OR (public.rma_user_role() = 'sales_rep' AND v_lead.assigned_rep = auth.uid())
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

GRANT EXECUTE ON FUNCTION public.crm_convert_lead(uuid, text, uuid, numeric, uuid) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT proname FROM pg_proc WHERE proname = 'crm_convert_lead';
-- SELECT has_function_privilege('authenticated', 'public.crm_convert_lead(uuid, text, uuid, numeric, uuid)', 'execute');
