-- ============================================================================
-- 20260904_customer_refunds.sql
-- P-05c — paying money back to a customer, with a second manager's approval.
-- Design and the owner's decisions: docs/P05_RETURNS_REFUNDS.md.
-- ============================================================================
-- Before this a "refund" was only a ticket_resolutions row: nothing paid a
-- customer back out of a credit note's remaining balance or a payment's
-- unapplied (overpaid) amount, and nobody approved it.
--
--   * customer_refunds: money back to a customer from ONE source — a credit
--     note (issued/applied, with a remaining balance) or a payment (active,
--     with an unapplied amount). pending_approval -> approved (numbered
--     RF-YYYY-NNNNN) or pending_approval -> rejected.
--   * record_customer_refund (managers and above) never asks for more than the
--     source has left after the other refunds waiting on it.
--   * approve_customer_refund (owner decision: EVERY refund needs a second
--     manager — one who did not record it) checks the source again under its
--     lock, numbers the refund and takes it off the source's balance.
--   * A credit note's remaining balance and a payment's unapplied amount now
--     subtract approved refunds (rma_credit_note_resync / rma_payment_resync,
--     which the existing balance triggers call). A payment or credit note with
--     a refund waiting or paid cannot be voided (the money left).
--   * The customer statement (v_customer_ledger) shows an approved refund as a
--     positive entry: money paid back raises what the customer's account shows.
--
-- Pinned by src/test/customerRefunds.test.js; supabase/tests/customer_refunds.sql
-- is the rolled-back reference script.
-- ============================================================================

-- ── 1. numbering: RF-YYYY-NNNNN ──────────────────────────────────────────────
INSERT INTO public.document_sequences (seq_type, last_value, seq_year)
VALUES ('customer_refund', 0, EXTRACT(YEAR FROM now())::integer)
ON CONFLICT (seq_type) DO NOTHING;

DO $$
DECLARE
  v_def  text;
  v_old  text := '    WHEN ''goods_receipt''  THEN ''GRN''';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.nextval_for_type'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%WHEN ''customer_refund''%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: nextval_for_type holds the goods_receipt prefix % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_old || E'\n    WHEN ''customer_refund'' THEN ''RF''');
END $$;

DO $$
DECLARE
  v_def  text;
  v_old  text := '(''goods_receipt'',  ''goods_receipts'',        ''grn_code'',       ''GRN'')';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.rma_reconcile_document_sequences'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%''customer_refunds''%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: rma_reconcile_document_sequences lists goods_receipt % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_old || E',\n      (''customer_refund'', ''customer_refunds'',     ''refund_code'',    ''RF'')');
END $$;

-- ── 2. the table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.customer_refunds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_code      text UNIQUE,                                  -- assigned at approval
  customer_id      uuid NOT NULL REFERENCES public.customers(id),
  credit_note_id   uuid REFERENCES public.credit_notes(id),
  payment_id       uuid REFERENCES public.payments(id),
  amount           numeric(12,2) NOT NULL CHECK (amount > 0),
  method           text NOT NULL CHECK (method IN ('cash', 'bank_transfer', 'check', 'card', 'other')),
  reference_number text,
  refund_date      date NOT NULL DEFAULT CURRENT_DATE,
  notes            text,
  status           text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'approved', 'rejected')),
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  approved_by      text,
  approved_at      timestamptz,
  rejected_by      text,
  rejected_at      timestamptz,
  reject_reason    text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_refunds_one_source CHECK ((credit_note_id IS NULL) <> (payment_id IS NULL)),
  CONSTRAINT customer_refunds_approved_has_code CHECK (status <> 'approved' OR (refund_code IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS customer_refunds_cn_idx ON public.customer_refunds (credit_note_id) WHERE credit_note_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_refunds_payment_idx ON public.customer_refunds (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_refunds_customer_idx ON public.customer_refunds (customer_id);

COMMENT ON TABLE public.customer_refunds IS
  'Money paid back to a customer from a credit note or an overpayment (P-05c). Every refund is approved by a manager who did not record it. Procedure-only: record_customer_refund / approve_customer_refund / reject_customer_refund.';

ALTER TABLE public.customer_refunds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.customer_refunds FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.customer_refunds FROM authenticated;
GRANT SELECT ON TABLE public.customer_refunds TO authenticated;
GRANT ALL ON TABLE public.customer_refunds TO service_role;
-- money leaving the company: managers and accountants
DROP POLICY IF EXISTS "read_customer_refunds" ON public.customer_refunds;
CREATE POLICY "read_customer_refunds" ON public.customer_refunds FOR SELECT
  USING (COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = 'accountant', false));

DROP TRIGGER IF EXISTS trg_audit_customer_refunds ON public.customer_refunds;
CREATE TRIGGER trg_audit_customer_refunds AFTER INSERT OR DELETE OR UPDATE ON public.customer_refunds
  FOR EACH ROW EXECUTE FUNCTION public.rma_audit_row();
DROP TRIGGER IF EXISTS trg_audit_truncate_customer_refunds ON public.customer_refunds;
CREATE TRIGGER trg_audit_truncate_customer_refunds AFTER TRUNCATE ON public.customer_refunds
  FOR EACH STATEMENT EXECUTE FUNCTION public.rma_audit_truncate();

-- ── 3. balances subtract approved refunds ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_credit_note_resync(p_cn_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_total    numeric(12,2);
  v_applied  numeric(12,2);
  v_refunded numeric(12,2);
BEGIN
  SELECT total INTO v_total FROM public.credit_notes WHERE id = p_cn_id;
  SELECT COALESCE(SUM(amount_applied), 0) INTO v_applied FROM public.credit_note_applications WHERE credit_note_id = p_cn_id;
  SELECT COALESCE(SUM(amount), 0) INTO v_refunded FROM public.customer_refunds WHERE credit_note_id = p_cn_id AND status = 'approved';
  UPDATE public.credit_notes
     SET applied_amount    = v_applied,
         remaining_balance = GREATEST(v_total - v_applied - v_refunded, 0),
         status = CASE
           WHEN v_applied + v_refunded >= v_total AND status = 'issued'  THEN 'applied'
           WHEN v_applied + v_refunded <  v_total AND status = 'applied' THEN 'issued'
           ELSE status END,
         updated_at = now()
   WHERE id = p_cn_id;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rma_payment_resync(p_payment_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_amount   numeric(12,2);
  v_applied  numeric(12,2);
  v_refunded numeric(12,2);
BEGIN
  SELECT amount INTO v_amount FROM public.payments WHERE id = p_payment_id;
  SELECT COALESCE(SUM(amount_applied), 0) INTO v_applied FROM public.payment_applications WHERE payment_id = p_payment_id;
  SELECT COALESCE(SUM(amount), 0) INTO v_refunded FROM public.customer_refunds WHERE payment_id = p_payment_id AND status = 'approved';
  -- not clamped: over-allocation must trip payments' CHECK (unapplied_amount >= 0), as since 20260751
  UPDATE public.payments
     SET unapplied_amount = v_amount - v_applied - v_refunded,
         updated_at = now()
   WHERE id = p_payment_id;
END
$fn$;

DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['rma_credit_note_resync(uuid)', 'rma_payment_resync(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', s);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', s);
  END LOOP;
END $$;

-- the existing balance triggers now go through them (same trigger names)
CREATE OR REPLACE FUNCTION public.sync_credit_note_balance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  PERFORM public.rma_credit_note_resync(COALESCE(NEW.credit_note_id, OLD.credit_note_id));
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.sync_payment_balance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  PERFORM public.rma_payment_resync(COALESCE(NEW.payment_id, OLD.payment_id));
  RETURN NULL;
END
$fn$;

-- ── 4. what a source has left for another refund ─────────────────────────────
-- Its live balance less the refunds already waiting on it.
CREATE OR REPLACE FUNCTION public._rma_refund_room(p_credit_note_id uuid, p_payment_id uuid, p_except uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT COALESCE(
           CASE WHEN p_credit_note_id IS NOT NULL
                THEN (SELECT remaining_balance FROM public.credit_notes WHERE id = p_credit_note_id)
                ELSE (SELECT unapplied_amount FROM public.payments WHERE id = p_payment_id) END, 0)
       - COALESCE((SELECT SUM(amount) FROM public.customer_refunds r
                    WHERE r.status = 'pending_approval'
                      AND r.id IS DISTINCT FROM p_except
                      AND (r.credit_note_id = p_credit_note_id OR r.payment_id = p_payment_id)), 0)
$fn$;
REVOKE ALL ON FUNCTION public._rma_refund_room(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._rma_refund_room(uuid, uuid, uuid) TO service_role;

-- ── 5. record_customer_refund ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_customer_refund(
  p_source_type text, p_source_id uuid, p_amount numeric, p_method text,
  p_reference_number text, p_refund_date date, p_notes text, p_actor_email text)
RETURNS public.customer_refunds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_actor    text := public.rma_current_user_email();
  v_customer uuid;
  v_cn_id    uuid;
  v_pay_id   uuid;
  v_room     numeric;
  v_row      public.customer_refunds;
BEGIN
  IF v_actor IS NULL OR NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Only managers and above can record a refund' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'The refund amount must be positive, in whole cents' USING ERRCODE = 'P0001';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('cash', 'bank_transfer', 'check', 'card', 'other') THEN
    RAISE EXCEPTION 'Choose how the money is paid back' USING ERRCODE = 'P0001';
  END IF;

  IF p_source_type = 'credit_note' THEN
    SELECT customer_id INTO v_customer FROM public.credit_notes
     WHERE id = p_source_id AND status IN ('issued', 'applied') FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Only an issued credit note can be refunded' USING ERRCODE = 'P0001';
    END IF;
    v_cn_id := p_source_id;
  ELSIF p_source_type = 'payment' THEN
    SELECT customer_id INTO v_customer FROM public.payments
     WHERE id = p_source_id AND status = 'active' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Only an active payment can be refunded' USING ERRCODE = 'P0001';
    END IF;
    v_pay_id := p_source_id;
  ELSE
    RAISE EXCEPTION 'A refund comes from a credit note or a payment' USING ERRCODE = 'P0001';
  END IF;

  v_room := public._rma_refund_room(v_cn_id, v_pay_id, NULL);
  IF p_amount > v_room THEN
    RAISE EXCEPTION 'Only % is left to refund from this % (after the refunds already waiting on it)',
      GREATEST(v_room, 0), replace(p_source_type, '_', ' ') USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.customer_refunds
    (customer_id, credit_note_id, payment_id, amount, method, reference_number, refund_date, notes, created_by)
  VALUES (v_customer, v_cn_id, v_pay_id, p_amount, p_method, NULLIF(btrim(COALESCE(p_reference_number, '')), ''),
          COALESCE(p_refund_date, CURRENT_DATE), NULLIF(btrim(COALESCE(p_notes, '')), ''), v_actor)
  RETURNING * INTO v_row;
  RETURN v_row;
END
$fn$;

-- ── 6. approve / reject ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_customer_refund(p_refund_id uuid, p_actor_email text)
RETURNS public.customer_refunds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_r     public.customer_refunds;
  v_room  numeric;
BEGIN
  IF v_actor IS NULL OR NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Only managers and above can approve a refund' USING ERRCODE = 'P0001';
  END IF;
  -- the source first (as record_customer_refund), then the refund
  SELECT * INTO v_r FROM public.customer_refunds WHERE id = p_refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Refund % not found', p_refund_id USING ERRCODE = 'P0001';
  END IF;
  IF v_r.credit_note_id IS NOT NULL THEN
    PERFORM 1 FROM public.credit_notes WHERE id = v_r.credit_note_id FOR UPDATE;
  ELSE
    PERFORM 1 FROM public.payments WHERE id = v_r.payment_id FOR UPDATE;
  END IF;
  SELECT * INTO v_r FROM public.customer_refunds WHERE id = p_refund_id FOR UPDATE;
  IF v_r.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Only a refund waiting for approval can be approved (this one is %)', v_r.status USING ERRCODE = 'P0001';
  END IF;
  -- owner decision: every refund is approved by a second manager
  IF lower(v_actor) = lower(v_r.created_by) THEN
    RAISE EXCEPTION 'The person who recorded a refund cannot approve it. Ask another manager.' USING ERRCODE = 'P0001';
  END IF;
  -- again: the source may have been applied, refunded or voided meanwhile
  IF v_r.credit_note_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.credit_notes WHERE id = v_r.credit_note_id AND status IN ('issued', 'applied')) THEN
    RAISE EXCEPTION 'The credit note is no longer issued; reject this refund' USING ERRCODE = 'P0001';
  END IF;
  IF v_r.payment_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.payments WHERE id = v_r.payment_id AND status = 'active') THEN
    RAISE EXCEPTION 'The payment is no longer active; reject this refund' USING ERRCODE = 'P0001';
  END IF;
  v_room := public._rma_refund_room(v_r.credit_note_id, v_r.payment_id, v_r.id);
  IF v_r.amount > v_room THEN
    RAISE EXCEPTION 'Only % is left to refund from this source now; reject this refund and record a smaller one', GREATEST(v_room, 0)
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.customer_refunds
     SET status = 'approved', refund_code = public.nextval_for_type('customer_refund'),
         approved_by = v_actor, approved_at = now(), updated_at = now()
   WHERE id = p_refund_id
  RETURNING * INTO v_r;
  IF v_r.credit_note_id IS NOT NULL THEN
    PERFORM public.rma_credit_note_resync(v_r.credit_note_id);
  ELSE
    PERFORM public.rma_payment_resync(v_r.payment_id);
  END IF;
  RETURN v_r;
END
$fn$;

CREATE OR REPLACE FUNCTION public.reject_customer_refund(p_refund_id uuid, p_reason text, p_actor_email text)
RETURNS public.customer_refunds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_r     public.customer_refunds;
BEGIN
  IF v_actor IS NULL OR NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Only managers and above can reject a refund' USING ERRCODE = 'P0001';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'Say why the refund is rejected' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_r FROM public.customer_refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Refund % not found', p_refund_id USING ERRCODE = 'P0001';
  END IF;
  IF v_r.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Only a refund waiting for approval can be rejected (this one is %) — the money has left', v_r.status
      USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.customer_refunds
     SET status = 'rejected', rejected_by = v_actor, rejected_at = now(), reject_reason = btrim(p_reason), updated_at = now()
   WHERE id = p_refund_id
  RETURNING * INTO v_r;
  RETURN v_r;
END
$fn$;

DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['record_customer_refund(text, uuid, numeric, text, text, date, text, text)',
                           'approve_customer_refund(uuid, text)', 'reject_customer_refund(uuid, text, text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', s);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', s);
  END LOOP;
END $$;

-- ── 7. a refunded payment or credit note is not voided ───────────────────────
DO $$
DECLARE
  v_def  text;
  v_old  text := E'  IF v_pay.status = ''voided'' THEN\n    RAISE EXCEPTION ''Payment is already voided'';\n  END IF;\n';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.void_payment'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%-- 20260904:%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: void_payment holds its voided check % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_old
    || E'  -- 20260904: money paid back from it has left (or is about to)\n'
    || E'  IF EXISTS (SELECT 1 FROM public.customer_refunds WHERE payment_id = p_payment_id AND status IN (''pending_approval'', ''approved'')) THEN\n'
    || E'    RAISE EXCEPTION ''This payment has a refund; it cannot be voided'' USING ERRCODE = ''P0001'';\n'
    || E'  END IF;\n');
END $$;

DO $$
DECLARE
  v_def  text;
  v_old  text := E'  IF v_cn.status = ''voided'' THEN\n    RAISE EXCEPTION ''Credit note is already voided'';\n  END IF;\n';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.void_credit_note'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%-- 20260904:%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: void_credit_note holds its voided check % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_old
    || E'  -- 20260904: money paid back from it has left (or is about to)\n'
    || E'  IF EXISTS (SELECT 1 FROM public.customer_refunds WHERE credit_note_id = p_cn_id AND status IN (''pending_approval'', ''approved'')) THEN\n'
    || E'    RAISE EXCEPTION ''This credit note has a refund; it cannot be voided'' USING ERRCODE = ''P0001'';\n'
    || E'  END IF;\n');
END $$;

-- ── 8. the customer statement shows refunds ──────────────────────────────────
CREATE OR REPLACE VIEW public.v_customer_ledger WITH (security_invoker = true) AS
 SELECT crm_invoices.id,
    'invoice'::text AS entry_type,
    crm_invoices.inv_code AS entry_code,
    crm_invoices.customer_id,
    crm_invoices.total AS amount,
    crm_invoices.doc_status AS status,
    crm_invoices.due_date,
    COALESCE(crm_invoices.posted_at, crm_invoices.created_at) AS entry_date,
    crm_invoices.created_at
   FROM public.crm_invoices
  WHERE crm_invoices.doc_status = 'posted'::text
UNION ALL
 SELECT credit_notes.id,
    'credit_note'::text AS entry_type,
    credit_notes.cn_code AS entry_code,
    credit_notes.customer_id,
    - credit_notes.total AS amount,
    credit_notes.status,
    NULL::date AS due_date,
    COALESCE(credit_notes.issued_at, credit_notes.created_at) AS entry_date,
    credit_notes.created_at
   FROM public.credit_notes
  WHERE credit_notes.status = ANY (ARRAY['issued'::text, 'applied'::text])
UNION ALL
 SELECT payments.id,
    'payment'::text AS entry_type,
    payments.payment_code AS entry_code,
    payments.customer_id,
    - payments.amount AS amount,
    payments.status,
    NULL::date AS due_date,
    COALESCE(payments.payment_date::timestamp with time zone, payments.created_at) AS entry_date,
    payments.created_at
   FROM public.payments
  WHERE payments.status = 'active'::text
UNION ALL
 SELECT customer_refunds.id,
    'refund'::text AS entry_type,
    customer_refunds.refund_code AS entry_code,
    customer_refunds.customer_id,
    customer_refunds.amount,
    customer_refunds.status,
    NULL::date AS due_date,
    COALESCE(customer_refunds.refund_date::timestamp with time zone, customer_refunds.approved_at) AS entry_date,
    customer_refunds.created_at
   FROM public.customer_refunds
  WHERE customer_refunds.status = 'approved'::text;

-- ── 9. Backup & Restore: the restorable BACKUP_TABLES, in order ──────────────
-- (src/test/restoreManifest.test.js fails if the two drift apart)
CREATE OR REPLACE FUNCTION public.rma_restore_manifest()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    'currencies', 'countries', 'country_area_codes', 'rma_config', 'brands', 'categories',
    'subcategories', 'warehouses', 'pipelines', 'parts', 'custom_field_definitions',
    'custom_roles', 'user_roles', 'user_preferences', 'announcements', 'kb_articles',
    'branding_settings', 'email_templates', 'whatsapp_templates', 'notification_settings',
    'notification_preferences', 'products', 'product_images', 'product_documents',
    'company_documents', 'customers', 'contacts', 'customer_notes', 'deals', 'leads',
    'rma_tickets', 'ticket_comments', 'ticket_activity', 'ticket_parts', 'ticket_resolutions',
    'time_entries', 'purchase_orders', 'purchase_order_lines', 'vendor_invoices',
    'vendor_invoice_lines', 'vendor_invoice_charges', 'vendor_payments',
    'vendor_payment_applications', 'goods_receipts', 'goods_receipt_lines',
    'vendor_invoice_receipt_lines', 'purchase_cost_adjustments', 'manufacturer_batches',
    'inventory_units', 'warehouse_stock', 'goods_receipt_line_units', 'goods_receipt_line_bins',
    'quotations', 'quotation_lines', 'sales_orders', 'sales_order_lines', 'deliveries',
    'delivery_lines', 'delivery_line_units', 'delivery_line_bins', 'customer_returns',
    'customer_return_lines', 'customer_return_line_units', 'customer_return_line_bins',
    'crm_invoices', 'crm_invoice_lines', 'invoices', 'payments', 'payment_applications',
    'credit_notes', 'credit_note_lines', 'credit_note_applications', 'customer_refunds',
    'activities', 'notifications', 'user_activity_log'
  ]::text[]
$function$;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.approve_customer_refund(uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rma_payment_resync(uuid)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.customer_refunds', 'INSERT') THEN
    RAISE EXCEPTION 'Refusing to finish: customer refunds are writable outside their RPCs';
  END IF;
  IF pg_get_functiondef('public.nextval_for_type'::regproc) NOT LIKE '%WHEN ''customer_refund'' THEN ''RF''%'
     OR NOT EXISTS (SELECT 1 FROM public.document_sequences WHERE seq_type = 'customer_refund')
     OR pg_get_functiondef('public.rma_reconcile_document_sequences'::regproc) NOT LIKE '%''customer_refunds''%' THEN
    RAISE EXCEPTION 'Refusing to finish: the customer_refund sequence is not registered as RF-';
  END IF;
  IF pg_get_functiondef('public.void_payment'::regproc) NOT LIKE '%This payment has a refund%'
     OR pg_get_functiondef('public.void_credit_note'::regproc) NOT LIKE '%This credit note has a refund%' THEN
    RAISE EXCEPTION 'Refusing to finish: void_payment or void_credit_note was not updated';
  END IF;
END $$;
