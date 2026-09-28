-- 20260915_maker_checker.sql — W6 / S-02: the maker is not the checker.
--
-- Credit notes, refunds, supplier payments, reopening a closed month and a
-- supplier bill with no order already refuse the person who made them. Five
-- approvals did not:
--   quotation accepted · sales order confirmed (approve_sales_order) ·
--   invoice posted (post_invoice) · purchase order confirmed ·
--   supplier invoice approved.
-- This adds that rule to all five, behind a per-customer setting.
--
-- Owner decisions (2026-09-28):
--   * rma_config 'separation_of_duties' (true/false) is OFF by default, so a
--     one-manager company can still work on day one; an administrator switches
--     it on in Control Panel.
--   * Administrators are exempt: an admin may approve their own document.
--
-- One BEFORE UPDATE trigger per table, not a rewrite of each RPC, so every path
-- to the approval (the RPC, a direct status change, any future function) is
-- covered in the same way. It runs for SECURITY DEFINER callers too, reading
-- the approver from the JWT (rma_current_user_email): the RPCs run under the
-- signed-in user's token. With no login (the database itself, a cron job) and
-- during a restore (rma.audit_suspended) it stands aside.

-- ── 1. the setting ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_separation_of_duties()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT COALESCE((SELECT lower(c.config_value #>> '{}') = 'true'
                     FROM public.rma_config c WHERE c.config_key = 'separation_of_duties'), false)
$fn$;
REVOKE ALL ON FUNCTION public.rma_separation_of_duties() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_separation_of_duties() TO authenticated, service_role;

-- ── 2. the guard ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_guard_maker_checker()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_me       text := lower(public.rma_current_user_email());
  v_approved boolean;
  v_what     text;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN RETURN NEW; END IF;
  IF v_me IS NULL OR v_me = '' THEN RETURN NEW; END IF;

  CASE TG_TABLE_NAME
    WHEN 'quotations' THEN
      v_approved := NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted';
      v_what := 'quotation';
    WHEN 'sales_orders' THEN
      v_approved := NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed';
      v_what := 'sales order';
    WHEN 'crm_invoices' THEN
      v_approved := NEW.doc_status = 'posted' AND OLD.doc_status IS DISTINCT FROM 'posted';
      v_what := 'invoice';
    WHEN 'purchase_orders' THEN
      v_approved := NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed';
      v_what := 'purchase order';
    WHEN 'vendor_invoices' THEN
      v_approved := NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved';
      v_what := 'supplier invoice';
    ELSE
      RETURN NEW;
  END CASE;

  IF NOT COALESCE(v_approved, false) THEN RETURN NEW; END IF;
  IF NOT public.rma_separation_of_duties() THEN RETURN NEW; END IF;
  IF COALESCE(public.rma_is_admin(), false) THEN RETURN NEW; END IF;   -- owner decision

  IF lower(COALESCE(OLD.created_by, '')) = v_me THEN
    RAISE EXCEPTION 'You created this %, so someone else must approve it.', v_what
      USING ERRCODE = 'P0001',
            HINT = 'Separation of duties is on in Control Panel: the person who creates a document cannot approve it.';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.rma_guard_maker_checker() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_quotations_maker_checker ON public.quotations;
CREATE TRIGGER trg_quotations_maker_checker BEFORE UPDATE OF status ON public.quotations
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_maker_checker();
DROP TRIGGER IF EXISTS trg_sales_orders_maker_checker ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_maker_checker BEFORE UPDATE OF status ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_maker_checker();
DROP TRIGGER IF EXISTS trg_crm_invoices_maker_checker ON public.crm_invoices;
CREATE TRIGGER trg_crm_invoices_maker_checker BEFORE UPDATE OF doc_status ON public.crm_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_maker_checker();
DROP TRIGGER IF EXISTS trg_purchase_orders_maker_checker ON public.purchase_orders;
CREATE TRIGGER trg_purchase_orders_maker_checker BEFORE UPDATE OF status ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_maker_checker();
DROP TRIGGER IF EXISTS trg_vendor_invoices_maker_checker ON public.vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_maker_checker BEFORE UPDATE OF status ON public.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_maker_checker();

-- ── 3. checks ────────────────────────────────────────────────────────────────
DO $chk$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg\_%\_maker\_checker' AND NOT tgisinternal) <> 5 THEN
    RAISE EXCEPTION '20260915: expected 5 maker-checker triggers';
  END IF;
  IF has_function_privilege('anon', 'public.rma_separation_of_duties()', 'EXECUTE') THEN
    RAISE EXCEPTION '20260915: anon can execute rma_separation_of_duties';
  END IF;
END
$chk$;
