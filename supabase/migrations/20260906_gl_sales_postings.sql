-- ============================================================================
-- 20260906_gl_sales_postings.sql
-- A-01b (sales side) — invoices, credit notes, payments, refunds, deliveries
-- and customer returns post to the general ledger (20260905).
-- Posting map and defaults: docs/A01_GENERAL_LEDGER.md.
-- ============================================================================
-- Each document posts from the step that makes it final, in that step's
-- transaction, through the engine (_gl_post / _gl_reverse): a posting that
-- fails (a posting role with no account, an entry that does not balance)
-- fails the step. Triggers, not rewrites of the RPCs: every path that makes the
-- step — each RPC, and any future one — posts the same way.
--
--   invoice posted            Dr receivables (total) / Cr sales revenue (total - tax) / Cr VAT payable (tax)
--   whole-order invoice cost  Dr cost of goods sold / Cr inventory (crm_invoices.cogs_base, set by
--                             post_invoice in a second update — event 'cogs'); a delivery's invoice
--                             posts no cost: its delivery already did
--   invoice voided            both reversed ('voided', 'voided_cogs'); a draft cancelled posted nothing
--   credit note issued        Dr sales revenue (total - tax), Dr VAT payable / Cr receivables; voided: reversed
--   payment recorded          Dr cash / Cr receivables, on the payment date; voided: reversed
--   refund approved           Dr receivables / Cr cash, on the refund date
--   delivery confirmed        Dr cost of goods sold / Cr inventory (the known cost of its lines)
--   customer return confirmed Dr inventory / Cr cost of goods sold (the known cost of its lines)
--
-- Stock of unknown cost posts its known part only; the rest stays on the
-- uncosted worklist (default 2 in the design). Documents made final before
-- this migration are not back-posted (default 1): reversing one finds nothing
-- to reverse and posts nothing. A restore (rma.audit_suspended) posts nothing —
-- it brings the journals back itself.
--
-- Pinned by src/test/glSalesPostings.test.js; supabase/tests/gl_sales_postings.sql
-- is the rolled-back reference script.
-- ============================================================================

-- ── invoices ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_gl_post_crm_invoice()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_total numeric := COALESCE(NEW.total, 0);
  v_tax   numeric := COALESCE(NEW.tax_amount, 0);
  v_memo  text := 'Invoice ' || COALESCE(NEW.inv_code, NEW.id::text);
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;

  IF NEW.doc_status = 'posted' THEN
    PERFORM public._gl_post('crm_invoice', NEW.id, 'posted', public.rma_today(), NEW.inv_code, v_memo, jsonb_build_array(
      jsonb_build_object('role', 'accounts_receivable', 'debit', v_total, 'customer_id', NEW.customer_id),
      jsonb_build_object('role', 'sales_revenue', 'credit', v_total - v_tax),
      jsonb_build_object('role', 'sales_tax_payable', 'credit', v_tax)));
    -- a whole-order invoice carries its own cost of goods; a delivery's did not
    IF NEW.delivery_id IS NULL AND COALESCE(NEW.cogs_base, 0) > 0 THEN
      PERFORM public._gl_post('crm_invoice', NEW.id, 'cogs', public.rma_today(), NEW.inv_code, v_memo || ' — cost of goods', jsonb_build_array(
        jsonb_build_object('role', 'cost_of_goods_sold', 'debit', NEW.cogs_base),
        jsonb_build_object('role', 'inventory', 'credit', NEW.cogs_base)));
    END IF;
  ELSIF OLD.doc_status = 'posted' AND NEW.doc_status <> 'posted' THEN
    PERFORM public._gl_reverse('crm_invoice', NEW.id, 'posted', 'voided', public.rma_today(), 'Voids ' || v_memo);
    PERFORM public._gl_reverse('crm_invoice', NEW.id, 'cogs', 'voided_cogs', public.rma_today(), 'Voids ' || v_memo || ' — cost of goods');
  END IF;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_crm_invoices_gl ON public.crm_invoices;
CREATE TRIGGER trg_crm_invoices_gl AFTER UPDATE OF doc_status, cogs_base ON public.crm_invoices
  FOR EACH ROW WHEN (NEW.doc_status = 'posted' OR OLD.doc_status = 'posted')
  EXECUTE FUNCTION public.rma_gl_post_crm_invoice();

-- ── credit notes ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_gl_post_credit_note()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_total numeric := COALESCE(NEW.total, 0);
  v_tax   numeric := COALESCE(NEW.tax_amount, 0);
  v_memo  text := 'Credit note ' || COALESCE(NEW.cn_code, NEW.id::text);
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF NEW.status IN ('issued', 'applied') AND OLD.status NOT IN ('issued', 'applied') THEN
    PERFORM public._gl_post('credit_note', NEW.id, 'issued', public.rma_today(), NEW.cn_code, v_memo, jsonb_build_array(
      jsonb_build_object('role', 'sales_revenue', 'debit', v_total - v_tax),
      jsonb_build_object('role', 'sales_tax_payable', 'debit', v_tax),
      jsonb_build_object('role', 'accounts_receivable', 'credit', v_total, 'customer_id', NEW.customer_id)));
  ELSIF NEW.status = 'voided' AND OLD.status IN ('issued', 'applied') THEN
    PERFORM public._gl_reverse('credit_note', NEW.id, 'issued', 'voided', public.rma_today(), 'Voids ' || v_memo);
  END IF;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_credit_notes_gl ON public.credit_notes;
CREATE TRIGGER trg_credit_notes_gl AFTER UPDATE OF status ON public.credit_notes
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.rma_gl_post_credit_note();

-- ── payments ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_gl_post_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_memo text := 'Payment ' || COALESCE(NEW.payment_code, NEW.id::text);
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active') THEN
    PERFORM public._gl_post('payment', NEW.id, 'recorded', COALESCE(NEW.payment_date, public.rma_today()), NEW.payment_code, v_memo,
      jsonb_build_array(
        jsonb_build_object('role', 'cash', 'debit', NEW.amount),
        jsonb_build_object('role', 'accounts_receivable', 'credit', NEW.amount, 'customer_id', NEW.customer_id)));
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'voided' AND OLD.status = 'active' THEN
    PERFORM public._gl_reverse('payment', NEW.id, 'recorded', 'voided', public.rma_today(), 'Voids ' || v_memo);
  END IF;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_payments_gl ON public.payments;
CREATE TRIGGER trg_payments_gl AFTER INSERT OR UPDATE OF status ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.rma_gl_post_payment();

-- ── refunds ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_gl_post_customer_refund()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;
  PERFORM public._gl_post('customer_refund', NEW.id, 'approved', COALESCE(NEW.refund_date, public.rma_today()), NEW.refund_code,
    'Refund ' || COALESCE(NEW.refund_code, NEW.id::text), jsonb_build_array(
      jsonb_build_object('role', 'accounts_receivable', 'debit', NEW.amount, 'customer_id', NEW.customer_id),
      jsonb_build_object('role', 'cash', 'credit', NEW.amount)));
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_customer_refunds_gl ON public.customer_refunds;
CREATE TRIGGER trg_customer_refunds_gl AFTER UPDATE OF status ON public.customer_refunds
  FOR EACH ROW WHEN (NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved')
  EXECUTE FUNCTION public.rma_gl_post_customer_refund();

-- ── deliveries: the goods leave ──────────────────────────────────────────────
-- confirm_delivery writes each line's cost before it confirms the delivery.
CREATE OR REPLACE FUNCTION public.rma_gl_post_delivery()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_cost numeric;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(cogs_base), 0) INTO v_cost FROM public.delivery_lines WHERE delivery_id = NEW.id;
  PERFORM public._gl_post('delivery', NEW.id, 'confirmed', public.rma_today(), NEW.delivery_code,
    'Delivery ' || COALESCE(NEW.delivery_code, NEW.id::text) || ' — cost of goods', jsonb_build_array(
      jsonb_build_object('role', 'cost_of_goods_sold', 'debit', v_cost),
      jsonb_build_object('role', 'inventory', 'credit', v_cost)));
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_deliveries_gl ON public.deliveries;
CREATE TRIGGER trg_deliveries_gl AFTER UPDATE OF status ON public.deliveries
  FOR EACH ROW WHEN (NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed')
  EXECUTE FUNCTION public.rma_gl_post_delivery();

-- ── customer returns: the goods come back ────────────────────────────────────
-- confirm_customer_return writes each line's cost before it confirms.
CREATE OR REPLACE FUNCTION public.rma_gl_post_customer_return()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_cost numeric;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(cost_base), 0) INTO v_cost FROM public.customer_return_lines WHERE customer_return_id = NEW.id;
  PERFORM public._gl_post('customer_return', NEW.id, 'confirmed', public.rma_today(), NEW.return_code,
    'Return ' || COALESCE(NEW.return_code, NEW.id::text) || ' — goods back in stock', jsonb_build_array(
      jsonb_build_object('role', 'inventory', 'debit', v_cost),
      jsonb_build_object('role', 'cost_of_goods_sold', 'credit', v_cost)));
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_customer_returns_gl ON public.customer_returns;
CREATE TRIGGER trg_customer_returns_gl AFTER UPDATE OF status ON public.customer_returns
  FOR EACH ROW WHEN (NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed')
  EXECUTE FUNCTION public.rma_gl_post_customer_return();

-- ── none of it is client-callable ────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.rma_gl_post_crm_invoice() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rma_gl_post_credit_note() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rma_gl_post_payment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rma_gl_post_customer_refund() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rma_gl_post_delivery() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rma_gl_post_customer_return() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
        'trg_crm_invoices_gl', 'trg_credit_notes_gl', 'trg_payments_gl',
        'trg_customer_refunds_gl', 'trg_deliveries_gl', 'trg_customer_returns_gl')) <> 6 THEN
    RAISE EXCEPTION 'Refusing to finish: a sales posting trigger is missing';
  END IF;
  IF has_function_privilege('authenticated', 'public.rma_gl_post_payment()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: a posting trigger function is client-callable';
  END IF;
END $$;
