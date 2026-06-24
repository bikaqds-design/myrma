-- ═══════════════════════════════════════════════════════════════════════════
--  CRM Sprint 1, Step 7 — extend customers table
--
--  account_manager (existing, free-text) is deliberately NOT touched —
--  verified it's a plain text input, not a foreign key, so it can't be
--  merged with assigned_rep (new, FK -> auth.users) without an unscoped
--  data-cleanup migration. They stay separate: account_manager is the
--  existing relationship-owner field, assigned_rep is the new CRM
--  deal-owner field. See CRM_UPGRADE_PLAN.md Architecture Lock.
--
--  last_activity_at is kept correct via a trigger on activities INSERT
--  (not an app-layer update in activities.create()) so it stays correct
--  regardless of which code path inserts an activity, matching the
--  DB-enforced-consistency approach already used for RLS/CHECK constraints
--  in this migration set. See data-model.md.
--
--  Also closes the loop from 20260618_crm_add_sales_rep_role.sql: adds the
--  sales_rep_update_assigned policy now that assigned_rep exists (deferred
--  because Postgres validates policy column references at CREATE time).
-- ═══════════════════════════════════════════════════════════════════════════


ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS lifecycle_stage text DEFAULT 'customer';
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS lead_source text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS assigned_rep uuid REFERENCES auth.users(id);
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

ALTER TABLE public.customers
  DROP CONSTRAINT IF EXISTS chk_customer_lifecycle_stage;
ALTER TABLE public.customers
  ADD CONSTRAINT chk_customer_lifecycle_stage
  CHECK (lifecycle_stage IN ('lead', 'prospect', 'customer', 'churned')) NOT VALID;


-- ── Close the loop: sales_rep_update_assigned policy (deferred from Step 1) ─

DROP POLICY IF EXISTS sales_rep_update_assigned ON public.customers;
CREATE POLICY sales_rep_update_assigned ON public.customers
  FOR UPDATE TO authenticated
  USING (
    public.rma_user_role() = 'sales_rep'
    AND assigned_rep = auth.uid()
  )
  WITH CHECK (
    public.rma_user_role() = 'sales_rep'
    AND assigned_rep = auth.uid()
  );


-- ── last_activity_at trigger ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.crm_update_customer_last_activity() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER AS
$$
DECLARE
  v_customer_id uuid;
BEGIN
  IF NEW.related_type = 'customer' THEN
    v_customer_id := NEW.related_id;
  ELSIF NEW.related_type = 'contact' THEN
    SELECT customer_id INTO v_customer_id FROM public.contacts WHERE id = NEW.related_id;
  ELSIF NEW.related_type = 'deal' THEN
    SELECT customer_id INTO v_customer_id FROM public.deals WHERE id = NEW.related_id;
  ELSIF NEW.related_type = 'lead' THEN
    SELECT converted_customer_id INTO v_customer_id FROM public.leads WHERE id = NEW.related_id;
  END IF;

  IF v_customer_id IS NOT NULL THEN
    UPDATE public.customers SET last_activity_at = now() WHERE id = v_customer_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_activities_update_customer_last_activity ON public.activities;
CREATE TRIGGER trg_activities_update_customer_last_activity
  AFTER INSERT ON public.activities
  FOR EACH ROW EXECUTE FUNCTION public.crm_update_customer_last_activity();


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT column_name, data_type, column_default FROM information_schema.columns
--   WHERE table_name = 'customers' AND column_name IN ('lifecycle_stage', 'lead_source', 'assigned_rep', 'last_activity_at');
-- SELECT conname FROM pg_constraint WHERE conname = 'chk_customer_lifecycle_stage';
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'customers' AND policyname = 'sales_rep_update_assigned';
-- SELECT tgname FROM pg_trigger WHERE tgname = 'trg_activities_update_customer_last_activity';
