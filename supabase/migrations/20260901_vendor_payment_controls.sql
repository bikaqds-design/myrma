-- ============================================================================
-- 20260901_vendor_payment_controls.sql
-- P-04b — paying a supplier for goods that have not arrived needs a
-- prepayment flag; supplier payments can require a second person.
-- ============================================================================
-- Gap analysis BL-11 (part 2) / test T-05c: an approved supplier bill could be
-- paid in full while none of its goods had arrived (the older whole-order path
-- receives on the bill itself, after approval), and nothing marked that money
-- as paid in advance. And any manager recorded and applied a payment in one
-- step with no one else looking. Owner decisions (2026-09-27): any manager may
-- mark a prepayment; the second approval is a setting, off by default.
--
--   1. vendor_payments.is_prepayment. Paying (recording with an allocation, or
--      applying later) a bill that still has goods outstanding is refused
--      unless the payment is a prepayment. Outstanding = a line of a stock
--      product received less than billed and not billed from a goods receipt
--      (a line from a receipt bills goods that arrived; services never arrive).
--   2. rma_config 'vendor_payment_approval' (true/false, default false). When
--      on, record_vendor_payment stores the payment as 'pending_approval': no
--      VP- number, nothing applied, its allocations kept in
--      pending_allocations. approve_vendor_payment (a manager who did not
--      record it) numbers it, marks it active and applies the allocations,
--      checking them again. A pending payment is turned down by voiding it.
--      Pending payments are outside the vendor ledger (it lists active ones)
--      and cannot be applied (apply_vendor_payment_to_invoice wants active).
--
-- Pinned by src/test/vendorPaymentControls.test.jsx; supabase/tests/vendor_payment_controls.sql
-- is the rolled-back reference script.
-- ============================================================================

ALTER TABLE public.vendor_payments
  ADD COLUMN IF NOT EXISTS is_prepayment boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS pending_allocations jsonb;
COMMENT ON COLUMN public.vendor_payments.is_prepayment IS
  'P-04b: paid before the goods it pays for arrived. Required to pay a bill that still has goods outstanding.';
COMMENT ON COLUMN public.vendor_payments.pending_allocations IS
  'P-04b: while pending_approval, the allocations to apply when it is approved ([{invoice_id, amount}]).';

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.vendor_payments'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%status%voided%' LOOP
    EXECUTE format('ALTER TABLE public.vendor_payments DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE public.vendor_payments ADD CONSTRAINT vendor_payments_status_check
  CHECK (status IN ('pending_approval', 'active', 'voided'));

-- ── helpers ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_vendor_payment_approval_required()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT COALESCE((SELECT lower(c.config_value #>> '{}') = 'true'
                     FROM public.rma_config c WHERE c.config_key = 'vendor_payment_approval'), false)
$fn$;
REVOKE ALL ON FUNCTION public.rma_vendor_payment_approval_required() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_vendor_payment_approval_required() TO authenticated, service_role;

-- Goods still to arrive on a bill (see the header).
CREATE OR REPLACE FUNCTION public.rma_vi_goods_outstanding(p_vi_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.vendor_invoice_lines l
      LEFT JOIN public.products p ON p.id = l.product_id
     WHERE l.vendor_invoice_id = p_vi_id
       AND COALESCE(p.product_type, 'hardware') <> 'service'
       AND COALESCE(l.qty_received, 0) < l.qty_ordered
       AND NOT EXISTS (SELECT 1 FROM public.vendor_invoice_receipt_lines k
                        WHERE k.vendor_invoice_id = l.vendor_invoice_id AND k.line_no = l.line_no))
$fn$;
REVOKE ALL ON FUNCTION public.rma_vi_goods_outstanding(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_vi_goods_outstanding(uuid) TO authenticated, service_role;

-- ── the allocations, checked (and applied) in one place ─────────────────────
-- Not client-callable. p_apply = false checks only (a payment waiting for
-- approval); true also writes the applications and the bills' paid amounts,
-- exactly as record_vendor_payment did before.
CREATE OR REPLACE FUNCTION public._vendor_payment_allocate(
  p_payment_id uuid, p_vendor_id uuid, p_currency character, p_amount numeric,
  p_allocations jsonb, p_is_prepayment boolean, p_actor text, p_apply boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_alloc record;
  v_sum   numeric(12,2) := 0;
  v_inv   record;
  v_kept  jsonb := '[]'::jsonb;
BEGIN
  IF p_allocations IS NOT NULL AND jsonb_typeof(p_allocations) <> 'array' THEN
    RAISE EXCEPTION 'Allocations must be a list' USING ERRCODE = 'P0001';
  END IF;
  FOR v_alloc IN
    SELECT (x->>'invoice_id')::uuid AS invoice_id, (x->>'amount')::numeric AS amount
      FROM jsonb_array_elements(COALESCE(p_allocations, '[]'::jsonb)) AS x
     WHERE (x->>'amount')::numeric > 0
  LOOP
    v_sum := v_sum + v_alloc.amount;
    IF v_sum > p_amount THEN
      RAISE EXCEPTION 'Allocations (%) exceed payment amount (%)', v_sum, p_amount;
    END IF;

    SELECT id, vendor_id, total, amount_paid, currency, vi_code, supplier_invoice_no INTO v_inv
      FROM public.vendor_invoices
     WHERE id = v_alloc.invoice_id AND status IN ('approved', 'partially_received', 'received')
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Vendor invoice % is not payable', v_alloc.invoice_id;
    END IF;
    IF v_inv.vendor_id <> p_vendor_id THEN
      RAISE EXCEPTION 'Vendor invoice % belongs to a different vendor', v_alloc.invoice_id;
    END IF;
    IF v_inv.currency IS DISTINCT FROM p_currency THEN
      RAISE EXCEPTION 'Cannot settle a % invoice with a % payment. Record the payment in % instead.',
        v_inv.currency, p_currency, v_inv.currency USING ERRCODE = 'P0001';
    END IF;
    -- 20260901: paying for goods that have not arrived is a prepayment
    IF NOT COALESCE(p_is_prepayment, false) AND public.rma_vi_goods_outstanding(v_inv.id) THEN
      RAISE EXCEPTION 'Some goods on % have not arrived yet. Paying for them now is a prepayment: mark the payment as a prepayment, or pay once they are received.',
        COALESCE(v_inv.vi_code, v_inv.supplier_invoice_no, 'this bill') USING ERRCODE = 'P0001';
    END IF;

    v_kept := v_kept || jsonb_build_object('invoice_id', v_alloc.invoice_id, 'amount', v_alloc.amount);

    IF p_apply THEN
      INSERT INTO public.vendor_payment_applications (payment_id, invoice_id, amount_applied, applied_by)
      VALUES (p_payment_id, v_alloc.invoice_id, v_alloc.amount, p_actor);
      UPDATE public.vendor_invoices
         SET amount_paid    = LEAST(amount_paid + v_alloc.amount, total),
             payment_status = CASE
               WHEN LEAST(amount_paid + v_alloc.amount, total) >= total THEN 'paid'
               WHEN LEAST(amount_paid + v_alloc.amount, total) > 0     THEN 'partial'
               ELSE 'unpaid' END,
             paid_at = CASE WHEN LEAST(amount_paid + v_alloc.amount, total) >= total THEN NOW() ELSE paid_at END,
             updated_at = NOW()
       WHERE id = v_alloc.invoice_id;
    END IF;
  END LOOP;
  RETURN v_kept;
END
$fn$;
REVOKE ALL ON FUNCTION public._vendor_payment_allocate(uuid, uuid, character, numeric, jsonb, boolean, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._vendor_payment_allocate(uuid, uuid, character, numeric, jsonb, boolean, text, boolean) TO service_role;

-- ── record_vendor_payment: + prepayment, + approval when the tenant wants it ─
DROP FUNCTION IF EXISTS public.record_vendor_payment(uuid, numeric, text, text, date, text, text, jsonb, character, numeric);
CREATE OR REPLACE FUNCTION public.record_vendor_payment(
  p_vendor_id uuid, p_amount numeric, p_method text, p_reference_number text, p_payment_date date,
  p_notes text, p_actor_email text, p_allocations jsonb DEFAULT '[]'::jsonb,
  p_currency character DEFAULT NULL::bpchar, p_exchange_rate numeric DEFAULT NULL::numeric,
  p_is_prepayment boolean DEFAULT false)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_id      uuid;
  v_actor   text;
  v_base    text;
  v_cur     char(3);
  v_rate    numeric(18,8);
  v_pending boolean := public.rma_vendor_payment_approval_required();
  v_kept    jsonb;
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Not authorized to record vendor payments';
  END IF;
  v_actor := COALESCE(public.rma_current_user_email(), p_actor_email);
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  SELECT config_value #>> '{}' INTO v_base FROM public.rma_config WHERE config_key = 'default_currency';
  v_cur  := COALESCE(p_currency, v_base);
  v_rate := COALESCE(p_exchange_rate, 1);

  INSERT INTO public.vendor_payments (
    payment_code, vendor_id, amount, unapplied_amount, method, reference_number, payment_date, notes,
    created_by, currency, exchange_rate, is_prepayment, status)
  VALUES (
    CASE WHEN v_pending THEN NULL ELSE public.nextval_for_type('vendor_payment') END,
    p_vendor_id, p_amount, p_amount, p_method, p_reference_number, COALESCE(p_payment_date, CURRENT_DATE), p_notes,
    v_actor, v_cur, v_rate, COALESCE(p_is_prepayment, false),
    CASE WHEN v_pending THEN 'pending_approval' ELSE 'active' END)
  RETURNING id INTO v_id;

  -- Waiting for a second person: check the allocations now (so a bad one is
  -- said at once), keep them, apply nothing.
  v_kept := public._vendor_payment_allocate(v_id, p_vendor_id, v_cur, p_amount, p_allocations,
                                            COALESCE(p_is_prepayment, false), v_actor, NOT v_pending);
  IF v_pending THEN
    UPDATE public.vendor_payments SET pending_allocations = v_kept WHERE id = v_id;
  END IF;
  RETURN v_id;
END
$fn$;
REVOKE ALL ON FUNCTION public.record_vendor_payment(uuid, numeric, text, text, date, text, text, jsonb, character, numeric, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_vendor_payment(uuid, numeric, text, text, date, text, text, jsonb, character, numeric, boolean) TO authenticated, service_role;

-- ── approve_vendor_payment ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_vendor_payment(p_payment_id uuid, p_actor_email text)
RETURNS public.vendor_payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_pay   public.vendor_payments;
BEGIN
  IF v_actor IS NULL OR NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Not authorized to approve vendor payments' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_pay FROM public.vendor_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor payment not found: %', p_payment_id USING ERRCODE = 'P0001';
  END IF;
  IF v_pay.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Only a payment waiting for approval can be approved (this one is %)', v_pay.status USING ERRCODE = 'P0001';
  END IF;
  IF lower(v_actor) = lower(v_pay.created_by) THEN
    RAISE EXCEPTION 'The person who recorded a payment cannot approve it. Ask another manager.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.vendor_payments
     SET status = 'active', payment_code = public.nextval_for_type('vendor_payment'),
         approved_by = v_actor, approved_at = now(), pending_allocations = NULL, updated_at = now()
   WHERE id = p_payment_id;
  -- applied now, and checked again: a bill may have been paid or cancelled meanwhile
  PERFORM public._vendor_payment_allocate(v_pay.id, v_pay.vendor_id, v_pay.currency, v_pay.amount,
                                          v_pay.pending_allocations, v_pay.is_prepayment, v_actor, true);
  SELECT * INTO v_pay FROM public.vendor_payments WHERE id = p_payment_id;
  RETURN v_pay;
END
$fn$;
REVOKE ALL ON FUNCTION public.approve_vendor_payment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_vendor_payment(uuid, text) TO authenticated, service_role;

-- ── apply_vendor_payment_to_invoice: the same prepayment rule ───────────────
DO $$
DECLARE
  v_def text;
  v_old text := E'  INSERT INTO public.vendor_payment_applications (\n    payment_id, invoice_id, amount_applied, applied_by\n  )\n  VALUES (p_payment_id, p_invoice_id, p_amount, v_actor)';
  v_ins text := E'  -- 20260901: paying for goods that have not arrived is a prepayment\n'
             || E'  IF NOT COALESCE((SELECT vp.is_prepayment FROM public.vendor_payments vp WHERE vp.id = p_payment_id), false)\n'
             || E'     AND public.rma_vi_goods_outstanding(p_invoice_id) THEN\n'
             || E'    RAISE EXCEPTION ''Some goods on this bill have not arrived yet. Only a payment marked as a prepayment can be applied to it now.''\n'
             || E'      USING ERRCODE = ''P0001'';\n'
             || E'  END IF;\n\n';
BEGIN
  SELECT replace(pg_get_functiondef('public.apply_vendor_payment_to_invoice'::regproc), E'\r\n', E'\n') INTO v_def;
  IF strpos(v_def, '-- 20260901: paying for goods') > 0 THEN
    RETURN; -- already applied
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION '20260901: apply_vendor_payment_to_invoice does not read as expected; not changed';
  END IF;
  EXECUTE replace(v_def, v_old, v_ins || v_old);
END $$;

-- v_vendor_payments_list shows the new columns (a view is fixed at creation)
DROP VIEW IF EXISTS public.v_vendor_payments_list;
CREATE VIEW public.v_vendor_payments_list WITH (security_invoker = true) AS
  SELECT vp.id, vp.payment_code, vp.vendor_id, vp.amount, vp.unapplied_amount, vp.method, vp.reference_number,
         vp.payment_date, vp.notes, vp.status, vp.voided_at, vp.voided_by, vp.void_reason, vp.created_by,
         vp.created_at, vp.updated_at, vp.currency, vp.exchange_rate, vp.amount_base,
         vp.is_prepayment, vp.approved_by, vp.approved_at, vp.pending_allocations,
         NULLIF(b.brand_name, '') AS vendor_name
    FROM public.vendor_payments vp
    LEFT JOIN public.brands b ON b.id = vp.vendor_id;
-- a new view is granted to anon by the project's default privileges; 20260861
-- revoked that, so revoke it again
REVOKE ALL ON public.v_vendor_payments_list FROM PUBLIC, anon;
GRANT SELECT ON public.v_vendor_payments_list TO authenticated, service_role;
COMMENT ON VIEW public.v_vendor_payments_list IS 'Vendor payments with the vendor name the Accounting page shows. (BUG-066; P-04b columns 20260901.)';
