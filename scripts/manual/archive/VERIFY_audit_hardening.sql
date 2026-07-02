-- ############################################################################
-- #  AUDIT HARDENING — VERIFICATION SMOKE TEST (results as a table)
-- #  For the 2026-07-02 audit fixes in migrations 20260751 / 20260752 / 20260753.
-- #
-- #  WHAT IT DOES — asserts the four money/authz invariants the audit closed:
-- #    CHECK 1  a manager CAN record a payment split across two invoices
-- #    CHECK 2  an over-allocation (allocations > payment amount) is REJECTED   [CRIT-2]
-- #    CHECK 3  a viewer/technician is DENIED from recording a payment          [CRIT-1]
-- #    CHECK 4  stock_moves.actor_email is stamped from the JWT, not the caller [CRIT-3]
-- #
-- #  HOW TO RUN
-- #    Run this AFTER applying the migration bundle. Paste the whole file into
-- #    the Supabase SQL Editor and run. Results come back as a RESULT-SET GRID
-- #    (the final SELECT) — every row's status should read PASS (or SKIP for
-- #    CHECK 3 if you have no viewer/technician user). NOTICE output is NOT used
-- #    because the SQL Editor hides it.
-- #
-- #  DATA SAFETY
-- #    The script seeds two throwaway invoices + one payment + one stock_moves
-- #    row, then DELETES all of them again at the end (FK-safe order). The
-- #    results are held in an ON COMMIT DROP temp table. On any unexpected
-- #    error the whole batch rolls back (Supabase wraps it in a transaction),
-- #    so nothing is left behind either way.
-- #
-- #  ASSUMPTIONS
-- #    • Run as the default SQL-Editor role (postgres): CHECK 4 inserts a
-- #      stock_moves row directly (RLS bypassed for the table owner).
-- #    • Your DB already has >= 1 admin/manager user AND >= 1 customer, else the
-- #      grid shows a single PREREQ row and nothing is seeded.
-- ############################################################################

CREATE TEMP TABLE _verify_results (
  ord        int,
  check_name text,
  status     text,
  detail     text
) ON COMMIT DROP;

DO $$
DECLARE
  v_mgr    text;
  v_viewer text;
  v_cust   uuid;
  v_inv1   uuid;
  v_inv2   uuid;
  v_pay    uuid;
  v_sm     uuid;
  v_paid1  numeric;
  v_paid2  numeric;
  v_actor  text;
BEGIN
  -- ── Prerequisites (reuse existing rows; never create users/customers) ──
  SELECT user_email INTO v_mgr FROM public.user_roles
    WHERE role IN ('super_admin','admin','manager') ORDER BY role LIMIT 1;
  SELECT user_email INTO v_viewer FROM public.user_roles
    WHERE role IN ('viewer','technician') LIMIT 1;
  SELECT id INTO v_cust FROM public.customers LIMIT 1;

  IF v_mgr IS NULL OR v_cust IS NULL THEN
    INSERT INTO _verify_results VALUES
      (0, 'PREREQ', 'MISSING', 'need >=1 admin/manager user AND >=1 customer — nothing seeded');
    RETURN;
  END IF;

  -- ── Seed two posted invoices (total 100 each) ──
  INSERT INTO public.crm_invoices (customer_id, doc_status, total, subtotal, created_by)
    VALUES (v_cust, 'posted', 100, 100, v_mgr) RETURNING id INTO v_inv1;
  INSERT INTO public.crm_invoices (customer_id, doc_status, total, subtotal, created_by)
    VALUES (v_cust, 'posted', 100, 100, v_mgr) RETURNING id INTO v_inv2;

  -- Simulate the manager's JWT (drives rma_current_user_email() + role guards)
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);

  -- ── CHECK 1: manager records a split payment 60 + 40 on a 100 payment ──
  v_pay := public.record_payment(
    v_cust, 100, 'cash', NULL, CURRENT_DATE, 'audit verify', v_mgr,
    json_build_array(
      json_build_object('invoice_id', v_inv1, 'amount', 60),
      json_build_object('invoice_id', v_inv2, 'amount', 40)
    )::jsonb);
  SELECT amount_paid INTO v_paid1 FROM public.crm_invoices WHERE id = v_inv1;
  SELECT amount_paid INTO v_paid2 FROM public.crm_invoices WHERE id = v_inv2;
  INSERT INTO _verify_results VALUES (1, 'CHECK 1 split payment applied',
    CASE WHEN v_paid1 = 60 AND v_paid2 = 40 THEN 'PASS' ELSE 'FAIL' END,
    format('inv1 amount_paid=%s, inv2 amount_paid=%s (expected 60 / 40)', v_paid1, v_paid2));

  -- ── CHECK 2: over-allocation (amount 50, allocations 30 + 40 = 70) rejected ──
  BEGIN
    PERFORM public.record_payment(
      v_cust, 50, 'cash', NULL, CURRENT_DATE, 'audit verify', v_mgr,
      json_build_array(
        json_build_object('invoice_id', v_inv1, 'amount', 30),
        json_build_object('invoice_id', v_inv2, 'amount', 40)
      )::jsonb);
    INSERT INTO _verify_results VALUES (2, 'CHECK 2 over-allocation rejected',
      'FAIL', 'over-allocation was NOT rejected');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _verify_results VALUES (2, 'CHECK 2 over-allocation rejected',
      'PASS', SQLERRM);
  END;

  -- ── CHECK 3: a viewer/technician is denied ──
  IF v_viewer IS NULL THEN
    INSERT INTO _verify_results VALUES (3, 'CHECK 3 viewer denied',
      'SKIP', 'no viewer/technician user exists to test denial');
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', v_viewer, 'role', 'authenticated')::text, true);
    BEGIN
      PERFORM public.record_payment(
        v_cust, 10, 'cash', NULL, CURRENT_DATE, 'audit verify', v_viewer,
        json_build_array(json_build_object('invoice_id', v_inv1, 'amount', 10))::jsonb);
      INSERT INTO _verify_results VALUES (3, 'CHECK 3 viewer denied',
        'FAIL', format('viewer/technician %s WAS allowed to record a payment', v_viewer));
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO _verify_results VALUES (3, 'CHECK 3 viewer denied',
        'PASS', SQLERRM);
    END;
    -- restore manager JWT for CHECK 4
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);
  END IF;

  -- ── CHECK 4: stock_moves.actor_email is stamped from the JWT, not the caller ──
  INSERT INTO public.stock_moves (ref_type, ref_id, doc_type, doc_id, move_type, qty, actor_email)
    VALUES ('unit', gen_random_uuid(), 'manual', NULL, 'adjust', 1, 'spoofed@example.com')
    RETURNING id, actor_email INTO v_sm, v_actor;
  INSERT INTO _verify_results VALUES (4, 'CHECK 4 actor stamped from JWT',
    CASE WHEN v_actor = v_mgr THEN 'PASS' ELSE 'FAIL' END,
    format('stored actor_email=%s (expected %s; sent spoofed@example.com)', v_actor, v_mgr));

  -- ── Cleanup: delete everything this script created (FK-safe order) ──
  DELETE FROM public.stock_moves  WHERE id = v_sm;
  DELETE FROM public.payments     WHERE id = v_pay;         -- cascades payment_applications
  DELETE FROM public.crm_invoices WHERE id IN (v_inv1, v_inv2);
END $$;

-- Results grid:
SELECT check_name, status, detail
FROM _verify_results
ORDER BY ord;
