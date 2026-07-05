-- ############################################################################
-- #  DB TEST TIER — vendor payments (Accounts Payable) hardening
-- #
-- #  Mirrors audit_hardening.sql's checks for the customer AR layer
-- #  (record_payment / apply_payment_to_invoice / reverse / void), but for
-- #  the new vendor-payment RPCs added by the Purchasing redesign
-- #  (20260760_vendor_payments.sql). Unlike the AR layer, this one was
-- #  hardened FROM DAY ONE — these checks confirm that hardening rather
-- #  than reproduce a before/after fix.
-- #
-- #  RUN AGAINST: a fresh local Supabase Postgres (`supabase start`).
-- #    psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
-- #      -v ON_ERROR_STOP=1 -f supabase/tests/vendor_payments.sql
-- #
-- #  PREREQUISITES: manager/viewer test users seeded by
-- #  20260706_seed_test_users_and_deals.sql. Seeds its own throwaway brands
-- #  (vendors) and vendor invoices — no dependency on other test files.
-- ############################################################################

DO $$
DECLARE
  v_mgr        text := 'karim.nasser@test.com';   -- seeded by 20260706, role='manager'
  v_viewer     text := 'rami.farouk@test.com';    -- seeded by 20260706, role='viewer'
  v_vendor_a   uuid;
  v_vendor_b   uuid;
  v_vi1        uuid;  v_vi2        uuid;
  v_vi_draft   uuid;
  v_vi_a       uuid;  v_vi_b       uuid;  v_vi_c uuid;
  v_pay        uuid;  v_pay_a      uuid;  v_pay_b uuid;  v_pay_c uuid;
  v_app_a      uuid;
  v_paid1      numeric; v_paid2    numeric; v_paid numeric;
  v_unapp      numeric;
  v_status     text;
  v_actor      text;
  v_failures   text[] := '{}';
  v_check_count int := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_email = v_mgr AND role = 'manager'
  ) THEN
    RAISE EXCEPTION
      'Test prerequisite missing: manager user % not found in user_roles — did 20260706_seed_test_users_and_deals.sql apply?',
      v_mgr;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_email = v_viewer AND role = 'viewer'
  ) THEN
    RAISE EXCEPTION
      'Test prerequisite missing: viewer user % not found in user_roles — did 20260706_seed_test_users_and_deals.sql apply?',
      v_viewer;
  END IF;

  INSERT INTO public.brands (brand_name) VALUES ('CI Test Vendor A') RETURNING id INTO v_vendor_a;
  INSERT INTO public.brands (brand_name) VALUES ('CI Test Vendor B') RETURNING id INTO v_vendor_b;

  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);

  -- ── CHECK 1: manager records a split vendor payment 60+40 across 2 VIs ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.vendor_invoices (vendor_id, status, line_items, total, created_by)
    VALUES (v_vendor_a, 'approved', '[]'::jsonb, 100, v_mgr) RETURNING id INTO v_vi1;
  INSERT INTO public.vendor_invoices (vendor_id, status, line_items, total, created_by)
    VALUES (v_vendor_a, 'approved', '[]'::jsonb, 100, v_mgr) RETURNING id INTO v_vi2;

  v_pay := public.record_vendor_payment(
    v_vendor_a, 100, 'bank_transfer', NULL, CURRENT_DATE, 'ci vp test', v_mgr,
    json_build_array(
      json_build_object('invoice_id', v_vi1, 'amount', 60),
      json_build_object('invoice_id', v_vi2, 'amount', 40)
    )::jsonb);
  SELECT amount_paid INTO v_paid1 FROM public.vendor_invoices WHERE id = v_vi1;
  SELECT amount_paid INTO v_paid2 FROM public.vendor_invoices WHERE id = v_vi2;
  IF NOT (v_paid1 = 60 AND v_paid2 = 40) THEN
    v_failures := array_append(v_failures,
      format('CHECK 1 (split vendor payment): expected vi1=60/vi2=40, got %s/%s', v_paid1, v_paid2));
  END IF;

  -- ── CHECK 2: over-allocation rejected ──
  v_check_count := v_check_count + 1;
  BEGIN
    PERFORM public.record_vendor_payment(
      v_vendor_a, 50, 'bank_transfer', NULL, CURRENT_DATE, 'ci vp test', v_mgr,
      json_build_array(
        json_build_object('invoice_id', v_vi1, 'amount', 30),
        json_build_object('invoice_id', v_vi2, 'amount', 40)
      )::jsonb);
    v_failures := array_append(v_failures, 'CHECK 2 (over-allocation): was NOT rejected');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ── CHECK 3: viewer denied ──
  v_check_count := v_check_count + 1;
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_viewer, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.record_vendor_payment(
      v_vendor_a, 10, 'cash', NULL, CURRENT_DATE, 'ci vp test', v_viewer,
      json_build_array(json_build_object('invoice_id', v_vi1, 'amount', 10))::jsonb);
    v_failures := array_append(v_failures, 'CHECK 3 (viewer denied): viewer WAS allowed to record a vendor payment');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);

  -- ── CHECK 4: allocation against a draft (not-yet-approved) VI rejected ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.vendor_invoices (vendor_id, status, line_items, total, created_by)
    VALUES (v_vendor_a, 'draft', '[]'::jsonb, 50, v_mgr) RETURNING id INTO v_vi_draft;
  BEGIN
    PERFORM public.record_vendor_payment(
      v_vendor_a, 50, 'cash', NULL, CURRENT_DATE, 'ci vp test', v_mgr,
      json_build_array(json_build_object('invoice_id', v_vi_draft, 'amount', 50))::jsonb);
    v_failures := array_append(v_failures, 'CHECK 4 (draft VI not payable): was NOT rejected');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ── CHECK 5: vendor-mismatch rejected (VI belongs to a different vendor) ──
  v_check_count := v_check_count + 1;
  BEGIN
    PERFORM public.record_vendor_payment(
      v_vendor_b, 60, 'cash', NULL, CURRENT_DATE, 'ci vp test', v_mgr,
      json_build_array(json_build_object('invoice_id', v_vi1, 'amount', 40))::jsonb);
    v_failures := array_append(v_failures, 'CHECK 5 (vendor mismatch): was NOT rejected');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ── CHECK 6 (actor spoofing): created_by is derived from the JWT, not p_actor_email ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.vendor_invoices (vendor_id, status, line_items, total, created_by)
    VALUES (v_vendor_a, 'approved', '[]'::jsonb, 20, v_mgr) RETURNING id INTO v_vi_a;
  v_pay_a := public.record_vendor_payment(
    v_vendor_a, 20, 'cash', NULL, CURRENT_DATE, 'ci vp test', 'spoofed@example.com',
    json_build_array(json_build_object('invoice_id', v_vi_a, 'amount', 20))::jsonb);
  SELECT created_by INTO v_actor FROM public.vendor_payments WHERE id = v_pay_a;
  IF v_actor <> v_mgr THEN
    v_failures := array_append(v_failures,
      format('CHECK 6 (actor derivation): created_by=%s, expected %s (spoofed p_actor_email not honored)', v_actor, v_mgr));
  END IF;

  -- ── CHECK 7: single-line reversal restores the invoice balance ──
  v_check_count := v_check_count + 1;
  SELECT id INTO v_app_a FROM public.vendor_payment_applications
    WHERE payment_id = v_pay_a AND invoice_id = v_vi_a AND is_reversal = false;
  PERFORM public.reverse_vendor_payment_application(v_app_a, 'ci vp test reversal', v_mgr);
  SELECT amount_paid, payment_status INTO v_paid, v_status FROM public.vendor_invoices WHERE id = v_vi_a;
  SELECT unapplied_amount INTO v_unapp FROM public.vendor_payments WHERE id = v_pay_a;
  IF NOT (v_paid = 0 AND v_status = 'unpaid' AND v_unapp = 20) THEN
    v_failures := array_append(v_failures,
      format('CHECK 7 (single-line reversal): invoice amount_paid=%s status=%s, payment unapplied_amount=%s (expected 0/unpaid/20)',
             v_paid, v_status, v_unapp));
  END IF;

  -- ── CHECK 8: apply -> reverse -> re-apply the SAME (payment, invoice) pair ──
  v_check_count := v_check_count + 1;
  PERFORM public.apply_vendor_payment_to_invoice(v_pay_a, v_vi_a, 20, v_mgr);
  SELECT amount_paid INTO v_paid FROM public.vendor_invoices WHERE id = v_vi_a;
  IF v_paid IS DISTINCT FROM 20 THEN
    v_failures := array_append(v_failures,
      format('CHECK 8 (re-apply after reversal): amount_paid=%s (expected 20 — same pair must be re-appliable, no UNIQUE constraint blocking it)', v_paid));
  END IF;

  -- ── CHECK 9: void reverses every active application, then voids the payment ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.vendor_invoices (vendor_id, status, line_items, total, created_by)
    VALUES (v_vendor_a, 'approved', '[]'::jsonb, 80, v_mgr) RETURNING id INTO v_vi_b;
  v_pay_b := public.record_vendor_payment(
    v_vendor_a, 80, 'cash', NULL, CURRENT_DATE, 'ci vp test', v_mgr,
    json_build_array(json_build_object('invoice_id', v_vi_b, 'amount', 80))::jsonb);
  PERFORM public.void_vendor_payment(v_pay_b, 'ci vp test void', v_mgr);
  SELECT amount_paid INTO v_paid FROM public.vendor_invoices WHERE id = v_vi_b;
  SELECT status INTO v_status FROM public.vendor_payments WHERE id = v_pay_b;
  IF NOT (v_paid = 0 AND v_status = 'voided') THEN
    v_failures := array_append(v_failures,
      format('CHECK 9 (void reverses then voids): invoice amount_paid=%s, payment status=%s (expected 0/voided)', v_paid, v_status));
  END IF;

  -- ── CHECK 10: direct over-insert into vendor_payment_applications trips CHECK(unapplied_amount >= 0) ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.vendor_invoices (vendor_id, status, line_items, total, created_by)
    VALUES (v_vendor_a, 'approved', '[]'::jsonb, 30, v_mgr) RETURNING id INTO v_vi_c;
  v_pay_c := public.record_vendor_payment(
    v_vendor_a, 30, 'cash', NULL, CURRENT_DATE, 'ci vp test', v_mgr, '[]'::jsonb);
  BEGIN
    INSERT INTO public.vendor_payment_applications (payment_id, invoice_id, amount_applied, applied_by)
      VALUES (v_pay_c, v_vi_c, 999, v_mgr);
    v_failures := array_append(v_failures,
      'CHECK 10 (unapplied_amount CHECK): a direct over-allocating insert was NOT rejected');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected — CHECK(unapplied_amount >= 0) aborts the transaction
  END;

  -- ── Cleanup: hard-delete everything this run seeded ──
  DELETE FROM public.vendor_payment_applications WHERE payment_id IN (v_pay, v_pay_a, v_pay_b, v_pay_c);
  DELETE FROM public.vendor_payments WHERE id IN (v_pay, v_pay_a, v_pay_b, v_pay_c);
  DELETE FROM public.vendor_invoices WHERE id IN (v_vi1, v_vi2, v_vi_draft, v_vi_a, v_vi_b, v_vi_c);
  DELETE FROM public.brands WHERE id IN (v_vendor_a, v_vendor_b);

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % vendor-payment-hardening check(s) FAILED:\n%',
      array_length(v_failures, 1), v_check_count, array_to_string(v_failures, E'\n');
  END IF;

  RAISE NOTICE 'All % vendor-payment-hardening checks passed', v_check_count;
END $$;
