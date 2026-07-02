-- ═══════════════════════════════════════════════════════════════════════════
--  P4 — Converted-lead immutability guard + existing-customer validation
--
--  FR-009 (L1): guard_converted_lead() BEFORE UPDATE trigger on leads.
--    Once converted_at is set, only notes and updated_at may change.
--    Complements the client-side check in leads.update(); this is the
--    server-side invariant that cannot be bypassed by direct SQL.
--
--  FR-012 (L1): crm_convert_lead RPC extended to validate that
--    p_existing_customer_id actually exists before accepting it. Previously
--    an unknown UUID would succeed here and fail later on the FK constraint
--    (a silent hard-to-diagnose error vs. a clean RAISE EXCEPTION).
--    Also fixes a regression introduced in 20260726 where created_by was
--    set back to auth.uid() instead of public.rma_current_user_email().
--
--  All changes are idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Converted-lead immutability trigger ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_converted_lead()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- Only enforce once the lead has been converted.
  IF OLD.converted_at IS NOT NULL THEN
    IF (
      NEW.full_name              IS DISTINCT FROM OLD.full_name              OR
      NEW.company_name           IS DISTINCT FROM OLD.company_name           OR
      NEW.phone                  IS DISTINCT FROM OLD.phone                  OR
      NEW.email                  IS DISTINCT FROM OLD.email                  OR
      NEW.source                 IS DISTINCT FROM OLD.source                 OR
      NEW.status                 IS DISTINCT FROM OLD.status                 OR
      NEW.assigned_rep           IS DISTINCT FROM OLD.assigned_rep           OR
      NEW.converted_at           IS DISTINCT FROM OLD.converted_at           OR
      NEW.converted_customer_id  IS DISTINCT FROM OLD.converted_customer_id  OR
      NEW.converted_deal_id      IS DISTINCT FROM OLD.converted_deal_id
    ) THEN
      RAISE EXCEPTION 'Converted leads are immutable except for notes';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_converted_lead_trigger ON public.leads;
CREATE TRIGGER guard_converted_lead_trigger
  BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.guard_converted_lead();

-- ── 2. crm_convert_lead — validate p_existing_customer_id, fix created_by ───

CREATE OR REPLACE FUNCTION public.crm_convert_lead(
  p_lead_id              uuid,
  p_deal_title           text,
  p_pipeline_id          uuid,
  p_deal_value           numeric DEFAULT NULL,
  p_existing_customer_id uuid    DEFAULT NULL
) RETURNS TABLE(customer_id uuid, deal_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$$
DECLARE
  v_lead        public.leads%ROWTYPE;
  v_customer_id uuid;
  v_deal_id     uuid;
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
    -- FR-012: validate the customer exists before accepting it
    IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_existing_customer_id) THEN
      RAISE EXCEPTION 'Customer % not found', p_existing_customer_id;
    END IF;
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
    'OPP-' || floor(10000000 + random() * 89999999)::bigint::text,
    p_deal_title, v_customer_id, p_pipeline_id, v_first_stage,
    p_deal_value, v_lead.assigned_rep,
    public.rma_current_user_email()   -- fix: was auth.uid() in 20260726
  )
  RETURNING id INTO v_deal_id;

  UPDATE public.leads
  SET status                = 'converted',
      converted_at          = now(),
      converted_customer_id = v_customer_id,
      converted_deal_id     = v_deal_id,
      updated_at            = now()
  WHERE id = p_lead_id;

  RETURN QUERY SELECT v_customer_id, v_deal_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.crm_convert_lead(uuid, text, uuid, numeric, uuid) TO authenticated;
