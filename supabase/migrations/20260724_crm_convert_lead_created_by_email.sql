-- Fix: crm_convert_lead RPC used auth.uid() (UUID) for created_by instead of
-- the user's email. All CRM tables store created_by as text/email, not uuid FK.
-- Replace auth.uid() with public.rma_current_user_email() to match convention.

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
      customer_code, customer_type, contact_person, company_name, mobile, email,
      lifecycle_stage, lead_source, assigned_rep
    ) VALUES (
      'CB-' || floor(10000000 + random() * 89999999)::bigint::text,
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

  INSERT INTO public.deals (
    deal_code, title, customer_id, pipeline_id, stage, value, assigned_rep, created_by
  ) VALUES (
    'QT-' || floor(10000000 + random() * 89999999)::bigint::text,
    p_deal_title, v_customer_id, p_pipeline_id, v_first_stage,
    p_deal_value, v_lead.assigned_rep, public.rma_current_user_email()
  )
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
