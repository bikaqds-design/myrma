-- ############################################################################
-- #  DB TEST TIER — audit hardening regression suite
-- #  Closes audit HIGH-3 ("zero automated tests on the money/inventory RPC
-- #  paths — the exact code most likely to lose money").
-- #
-- #  This is the same set of checks manually run and confirmed PASS against
-- #  production in scripts/manual/archive/VERIFY_audit_hardening.sql and
-- #  VERIFY_crit5_reversal.sql (both superseded by this file, archived),
-- #  restructured for unattended CI execution:
-- #  instead of returning a result-set grid for a human to read, this file
-- #  RAISES AN EXCEPTION if any check fails, so `psql -v ON_ERROR_STOP=1`
-- #  exits non-zero and fails the CI job with the exact failing check named
-- #  in the error message.
-- #
-- #  RUN AGAINST: a fresh local Supabase Postgres (`supabase start`, which
-- #  applies every migration in supabase/migrations/ in order — this file
-- #  therefore also doubles as a regression check that the full migration
-- #  history still applies cleanly from scratch, generalizing the exact class
-- #  of failure the audit's CRIT-4 finding was about).
-- #
-- #    supabase start
-- #    psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
-- #      -v ON_ERROR_STOP=1 -f supabase/tests/audit_hardening.sql
-- #
-- #  (See .github/workflows/ci.yml "DB · Audit Hardening Tests" job, and the
-- #  `npm run test:db` script, for the two places this actually runs.)
-- #
-- #  PREREQUISITES: relies on the manager/viewer test users seeded by
-- #  migration 20260706_seed_test_users_and_deals.sql (no auth.users rows
-- #  needed — user_roles.user_email is plain text). Seeds its own throwaway
-- #  customer, since no migration seeds customers on a from-scratch DB.
-- #
-- #  COVERAGE: CRIT-1 (role guard), CRIT-2 (allocation validation), CRIT-3
-- #  (server-derived actor), CRIT-5 (payment/CN reversal), HIGH-2 (atomic
-- #  apply). Inventory/purchasing RPCs (reserve/deliver/release, receive,
-- #  transfer) are NOT yet covered — a good next increment once this harness
-- #  is proven out, not attempted in this pass.
-- ############################################################################

DO $$
DECLARE
  v_mgr    text := 'karim.nasser@test.com';   -- seeded by 20260706, role='manager'
  v_viewer text := 'rami.farouk@test.com';    -- seeded by 20260706, role='viewer'
  v_cust   uuid;
  v_inv1   uuid;
  v_inv2   uuid;
  v_inv_a  uuid;
  v_inv_b  uuid;
  v_inv_c  uuid;
  v_pay    uuid;
  v_pay_a  uuid;
  v_pay_b  uuid;
  v_pay_c  uuid;
  v_app_a  uuid;
  v_sm     uuid;
  v_paid1  numeric;
  v_paid2  numeric;
  v_paid   numeric;
  v_unapp  numeric;
  v_status text;
  v_actor  text;
  v_failures text[] := '{}';
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

  -- Throwaway customer — no migration seeds one on a from-scratch DB.
  INSERT INTO public.customers (customer_code, customer_type, contact_person, mobile, email)
    VALUES ('CI-TEST-' || floor(random() * 100000)::text, 'B2C', 'CI Test Customer', '0000000000', 'ci-test@example.com')
    RETURNING id INTO v_cust;

  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);

  -- ── CHECK 1 (CRIT-2/HIGH-2): manager records a split payment 60+40 ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.crm_invoices (customer_id, doc_status, total, subtotal, created_by)
    VALUES (v_cust, 'posted', 100, 100, v_mgr) RETURNING id INTO v_inv1;
  INSERT INTO public.crm_invoices (customer_id, doc_status, total, subtotal, created_by)
    VALUES (v_cust, 'posted', 100, 100, v_mgr) RETURNING id INTO v_inv2;

  v_pay := public.record_payment(
    v_cust, 100, 'cash', NULL, CURRENT_DATE, 'ci audit test', v_mgr,
    json_build_array(
      json_build_object('invoice_id', v_inv1, 'amount', 60),
      json_build_object('invoice_id', v_inv2, 'amount', 40)
    )::jsonb);
  SELECT amount_paid INTO v_paid1 FROM public.crm_invoices WHERE id = v_inv1;
  SELECT amount_paid INTO v_paid2 FROM public.crm_invoices WHERE id = v_inv2;
  IF NOT (v_paid1 = 60 AND v_paid2 = 40) THEN
    v_failures := array_append(v_failures,
      format('CHECK 1 (split payment): expected inv1=60/inv2=40, got %s/%s', v_paid1, v_paid2));
  END IF;

  -- ── CHECK 2 (CRIT-2): over-allocation rejected ──
  v_check_count := v_check_count + 1;
  BEGIN
    PERFORM public.record_payment(
      v_cust, 50, 'cash', NULL, CURRENT_DATE, 'ci audit test', v_mgr,
      json_build_array(
        json_build_object('invoice_id', v_inv1, 'amount', 30),
        json_build_object('invoice_id', v_inv2, 'amount', 40)
      )::jsonb);
    v_failures := array_append(v_failures, 'CHECK 2 (over-allocation): was NOT rejected');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ── CHECK 3 (CRIT-1): viewer denied ──
  v_check_count := v_check_count + 1;
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_viewer, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.record_payment(
      v_cust, 10, 'cash', NULL, CURRENT_DATE, 'ci audit test', v_viewer,
      json_build_array(json_build_object('invoice_id', v_inv1, 'amount', 10))::jsonb);
    v_failures := array_append(v_failures, 'CHECK 3 (viewer denied): viewer WAS allowed to record a payment');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);

  -- ── CHECK 4 (CRIT-3): stock_moves.actor_email stamped from JWT, not the caller ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.stock_moves (ref_type, ref_id, doc_type, doc_id, move_type, qty, actor_email)
    VALUES ('unit', gen_random_uuid(), 'manual', NULL, 'adjust', 1, 'spoofed@example.com')
    RETURNING id, actor_email INTO v_sm, v_actor;
  IF v_actor <> v_mgr THEN
    v_failures := array_append(v_failures,
      format('CHECK 4 (actor stamping): stored actor_email=%s, expected %s (spoofed value not overwritten)', v_actor, v_mgr));
  END IF;

  -- ── CHECK 5 (CRIT-5): single-line reversal restores balances without voiding ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.crm_invoices (customer_id, doc_status, total, subtotal, created_by)
    VALUES (v_cust, 'posted', 150, 150, v_mgr) RETURNING id INTO v_inv_a;
  v_pay_a := public.record_payment(
    v_cust, 150, 'cash', NULL, CURRENT_DATE, 'ci audit test', v_mgr,
    json_build_array(json_build_object('invoice_id', v_inv_a, 'amount', 150))::jsonb);
  SELECT id INTO v_app_a FROM public.payment_applications
    WHERE payment_id = v_pay_a AND invoice_id = v_inv_a AND is_reversal = false;
  PERFORM public.reverse_payment_application(v_app_a, 'ci audit test reversal', v_mgr);
  SELECT amount_paid, payment_status INTO v_paid, v_status FROM public.crm_invoices WHERE id = v_inv_a;
  SELECT unapplied_amount INTO v_unapp FROM public.payments WHERE id = v_pay_a;
  IF NOT (v_paid = 0 AND v_status = 'unpaid' AND v_unapp = 150) THEN
    v_failures := array_append(v_failures,
      format('CHECK 5 (single-line reversal): invoice amount_paid=%s status=%s, payment unapplied_amount=%s (expected 0/unpaid/150)',
             v_paid, v_status, v_unapp));
  END IF;

  -- ── CHECK 6 (CRIT-5): void reverses applications then voids the payment ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.crm_invoices (customer_id, doc_status, total, subtotal, created_by)
    VALUES (v_cust, 'posted', 80, 80, v_mgr) RETURNING id INTO v_inv_b;
  v_pay_b := public.record_payment(
    v_cust, 80, 'cash', NULL, CURRENT_DATE, 'ci audit test', v_mgr,
    json_build_array(json_build_object('invoice_id', v_inv_b, 'amount', 80))::jsonb);
  PERFORM public.void_payment(v_pay_b, 'ci audit test void', v_mgr);
  SELECT amount_paid INTO v_paid FROM public.crm_invoices WHERE id = v_inv_b;
  SELECT status INTO v_status FROM public.payments WHERE id = v_pay_b;
  IF NOT (v_paid = 0 AND v_status = 'voided') THEN
    v_failures := array_append(v_failures,
      format('CHECK 6 (void reverses then voids): invoice amount_paid=%s, payment status=%s (expected 0/voided)', v_paid, v_status));
  END IF;

  -- ── CHECK 7 (CRIT-5): void_invoice unblocked once its only application was reversed ──
  v_check_count := v_check_count + 1;
  BEGIN
    PERFORM public.void_invoice(v_inv_a, 'ci audit test invoice void after reversal', v_mgr);
  EXCEPTION WHEN OTHERS THEN
    v_failures := array_append(v_failures,
      format('CHECK 7 (void_invoice unblocked after reversal): should have succeeded, got: %s', SQLERRM));
  END;

  -- ── CHECK 8 (CRIT-5 regression guard): void_invoice still blocks a genuinely-applied invoice ──
  v_check_count := v_check_count + 1;
  INSERT INTO public.crm_invoices (customer_id, doc_status, total, subtotal, created_by)
    VALUES (v_cust, 'posted', 30, 30, v_mgr) RETURNING id INTO v_inv_c;
  v_pay_c := public.record_payment(
    v_cust, 30, 'cash', NULL, CURRENT_DATE, 'ci audit test', v_mgr,
    json_build_array(json_build_object('invoice_id', v_inv_c, 'amount', 30))::jsonb);
  BEGIN
    PERFORM public.void_invoice(v_inv_c, 'ci audit test should be blocked', v_mgr);
    v_failures := array_append(v_failures,
      'CHECK 8 (void_invoice still blocks applied invoice): succeeded but should have been blocked — regression in the guard fix');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- expected
  END;

  -- ── Cleanup: hard-delete everything this run seeded ──
  DELETE FROM public.payments WHERE id IN (v_pay, v_pay_a, v_pay_b, v_pay_c);
  DELETE FROM public.crm_invoices WHERE id IN (v_inv1, v_inv2, v_inv_a, v_inv_b, v_inv_c);
  DELETE FROM public.stock_moves WHERE id = v_sm;
  DELETE FROM public.customers WHERE id = v_cust;

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % audit-hardening check(s) FAILED:\n%',
      array_length(v_failures, 1), v_check_count, array_to_string(v_failures, E'\n');
  END IF;

  RAISE NOTICE 'All % audit-hardening checks passed', v_check_count;
END $$;
