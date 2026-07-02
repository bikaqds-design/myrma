-- ############################################################################
-- #  CRIT-5 VERIFICATION — payment / credit-note reversal (results as a table)
-- #  For migration 20260754_payment_cn_reversal.sql.
-- #
-- #  WHAT IT DOES:
-- #    CHECK 5  reversing ONE application line restores the invoice balance
-- #             and the payment's unapplied_amount, without voiding the payment
-- #    CHECK 6  voiding a payment that has an active application reverses it
-- #             automatically and marks the payment voided
-- #    CHECK 7a void_invoice SUCCEEDS once its only application was reversed
-- #             (this was PERMANENTLY blocked before the void_invoice guard fix)
-- #    CHECK 7b void_invoice still BLOCKS a genuinely-applied invoice
-- #             (regression check — the guard fix must not have loosened this)
-- #
-- #  HOW TO RUN: run this AFTER applying 20260754. Paste into the Supabase SQL
-- #  Editor; read the result-set grid — every row should say PASS.
-- #
-- #  DATA SAFETY: seeds throwaway invoices/payments, deletes them at the end.
-- ############################################################################

CREATE TEMP TABLE _verify5_results (
  ord        int,
  check_name text,
  status     text,
  detail     text
) ON COMMIT DROP;

DO $$
DECLARE
  v_mgr     text;
  v_cust    uuid;
  v_inv_a   uuid;  -- CHECK 5 invoice
  v_inv_b   uuid;  -- CHECK 6 invoice
  v_inv_c   uuid;  -- CHECK 7b invoice (left genuinely applied)
  v_pay_a   uuid;
  v_pay_b   uuid;
  v_pay_c   uuid;
  v_app_a   uuid;
  v_paid    numeric;
  v_unapp   numeric;
  v_pay_status text;
BEGIN
  SELECT user_email INTO v_mgr FROM public.user_roles
    WHERE role IN ('super_admin','admin','manager') ORDER BY role LIMIT 1;
  SELECT id INTO v_cust FROM public.customers LIMIT 1;

  IF v_mgr IS NULL OR v_cust IS NULL THEN
    INSERT INTO _verify5_results VALUES
      (0, 'PREREQ', 'MISSING', 'need >=1 admin/manager user AND >=1 customer — nothing seeded');
    RETURN;
  END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);

  -- ── Seed three posted invoices ──
  INSERT INTO public.crm_invoices (customer_id, doc_status, total, subtotal, created_by)
    VALUES (v_cust, 'posted', 150, 150, v_mgr) RETURNING id INTO v_inv_a;
  INSERT INTO public.crm_invoices (customer_id, doc_status, total, subtotal, created_by)
    VALUES (v_cust, 'posted', 80, 80, v_mgr) RETURNING id INTO v_inv_b;
  INSERT INTO public.crm_invoices (customer_id, doc_status, total, subtotal, created_by)
    VALUES (v_cust, 'posted', 30, 30, v_mgr) RETURNING id INTO v_inv_c;

  -- ── CHECK 5: reverse a single application line ──
  v_pay_a := public.record_payment(
    v_cust, 150, 'cash', NULL, CURRENT_DATE, 'verify5', v_mgr,
    json_build_array(json_build_object('invoice_id', v_inv_a, 'amount', 150))::jsonb);

  SELECT id INTO v_app_a FROM public.payment_applications
    WHERE payment_id = v_pay_a AND invoice_id = v_inv_a AND is_reversal = false;

  PERFORM public.reverse_payment_application(v_app_a, 'verify5 reversal', v_mgr);

  SELECT amount_paid, payment_status INTO v_paid, v_pay_status
    FROM public.crm_invoices WHERE id = v_inv_a;
  SELECT unapplied_amount INTO v_unapp FROM public.payments WHERE id = v_pay_a;

  INSERT INTO _verify5_results VALUES (5, 'CHECK 5 single-line reversal restores balances',
    CASE WHEN v_paid = 0 AND v_pay_status = 'unpaid' AND v_unapp = 150 THEN 'PASS' ELSE 'FAIL' END,
    format('invoice amount_paid=%s status=%s, payment unapplied_amount=%s (expected 0/unpaid/150)',
           v_paid, v_pay_status, v_unapp));

  -- ── CHECK 6: void a payment with an active application ──
  v_pay_b := public.record_payment(
    v_cust, 80, 'cash', NULL, CURRENT_DATE, 'verify5', v_mgr,
    json_build_array(json_build_object('invoice_id', v_inv_b, 'amount', 80))::jsonb);

  PERFORM public.void_payment(v_pay_b, 'verify5 void', v_mgr);

  SELECT amount_paid, payment_status INTO v_paid, v_pay_status
    FROM public.crm_invoices WHERE id = v_inv_b;
  SELECT status INTO v_pay_status FROM public.payments WHERE id = v_pay_b;

  INSERT INTO _verify5_results VALUES (6, 'CHECK 6 void reverses applications then voids payment',
    CASE WHEN v_paid = 0 AND v_pay_status = 'voided' THEN 'PASS' ELSE 'FAIL' END,
    format('invoice amount_paid=%s, payment status=%s (expected 0/voided)', v_paid, v_pay_status));

  -- ── CHECK 7a: void_invoice now succeeds once its only application was reversed ──
  BEGIN
    PERFORM public.void_invoice(v_inv_a, 'verify5 invoice void after reversal', v_mgr);
    INSERT INTO _verify5_results VALUES (7, 'CHECK 7a void_invoice unblocked after full reversal',
      'PASS', 'void_invoice succeeded — the stale EXISTS guard no longer blocks a reversed invoice');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _verify5_results VALUES (7, 'CHECK 7a void_invoice unblocked after full reversal',
      'FAIL', SQLERRM);
  END;

  -- ── CHECK 7b: void_invoice still blocks a genuinely-applied invoice ──
  v_pay_c := public.record_payment(
    v_cust, 30, 'cash', NULL, CURRENT_DATE, 'verify5', v_mgr,
    json_build_array(json_build_object('invoice_id', v_inv_c, 'amount', 30))::jsonb);

  BEGIN
    PERFORM public.void_invoice(v_inv_c, 'verify5 should be blocked', v_mgr);
    INSERT INTO _verify5_results VALUES (8, 'CHECK 7b void_invoice still blocks a genuinely-applied invoice',
      'FAIL', 'void_invoice succeeded but should have been blocked — regression in the guard fix');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _verify5_results VALUES (8, 'CHECK 7b void_invoice still blocks a genuinely-applied invoice',
      'PASS', SQLERRM);
  END;

  -- ── Cleanup: hard-delete everything seeded (payment_applications cascades
  -- from either side, so order between these two statements doesn't matter) ──
  DELETE FROM public.payments WHERE id IN (v_pay_a, v_pay_b, v_pay_c);
  DELETE FROM public.crm_invoices WHERE id IN (v_inv_a, v_inv_b, v_inv_c);
END $$;

SELECT check_name, status, detail
FROM _verify5_results
ORDER BY ord;
