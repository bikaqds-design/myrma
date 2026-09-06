-- Verify 20260808_lock_down_direct_payment_writes.sql  (audit BUG-001)
--
-- Asks the database the question the migration claims to have settled: can a
-- viewer still fabricate a payment or an application row, and can an
-- administrator still restore one?
--
-- Everything runs inside one transaction that ends in a RAISE, so nothing is
-- committed. The RAISE is how the result is reported — a successful run ENDS IN
-- AN ERROR whose message is the verdict. Read the message, not the exit status.
--
-- Safe to run against production.
--
-- ── Why the ids are captured before the role switch ──────────────────────────
--
-- The first version of this script sourced its row from the tables it was about
-- to write to:
--
--     INSERT INTO payment_applications (...)
--     SELECT p.id, i.id, 1, v_viewer FROM payments p, crm_invoices i LIMIT 1;
--
-- and reported INCONCLUSIVE. The reason is worth keeping: a viewer's SELECT
-- policy on payments is `manager_or_above OR created_by = me`, and a viewer has
-- created nothing, so the sub-select returned no rows. Zero rows inserted means
-- zero WITH CHECK evaluations — the policy under test was never consulted, and
-- the probe could not tell that apart from a refusal.
--
-- The ids are therefore read at the top, before `SET LOCAL ROLE authenticated`,
-- while the script still runs unscoped, and used as literals afterwards.
--
-- ── Why 42501 specifically ───────────────────────────────────────────────────
--
-- Postgres forms the tuple before it applies the RLS WITH CHECK, so a missing
-- NOT NULL column or a failed foreign key answers *first* with its own error.
-- A probe that treats "any error" as a refusal will eventually report a wide
-- open table as closed. Only insufficient_privilege (42501) is a PASS here;
-- every other SQLSTATE is reported as INCONCLUSIVE, with its code, so it can be
-- chased rather than assumed. This is the same lesson the anonymous-access
-- probe learned in PRELAUNCH_REVIEW.md, finding 2.

DO $verify$
DECLARE
  v_viewer    text;
  v_admin     text;
  v_customer  uuid;
  v_payment   uuid;
  v_invoice   uuid;
  v_cn        uuid;
  v_vpayment  uuid;
  v_vinvoice  uuid;
  v_n         integer;
  v_out       text := '';
BEGIN
  -- ── Fixtures, read unscoped ────────────────────────────────────────────────
  SELECT user_email INTO v_viewer
    FROM public.user_roles WHERE role = 'viewer' AND status = 'active' LIMIT 1;
  SELECT user_email INTO v_admin
    FROM public.user_roles WHERE role IN ('admin', 'super_admin') AND status = 'active' LIMIT 1;
  SELECT id INTO v_customer FROM public.customers LIMIT 1;
  SELECT id INTO v_payment  FROM public.payments LIMIT 1;
  SELECT id INTO v_invoice  FROM public.crm_invoices WHERE doc_status = 'posted' LIMIT 1;
  SELECT id INTO v_cn       FROM public.credit_notes LIMIT 1;
  SELECT id INTO v_vpayment FROM public.vendor_payments LIMIT 1;
  SELECT id INTO v_vinvoice FROM public.vendor_invoices LIMIT 1;

  IF v_viewer IS NULL OR v_admin IS NULL OR v_customer IS NULL THEN
    RAISE EXCEPTION 'Cannot verify: need an active viewer (%), an active admin (%) and at least one customer (%).',
      coalesce(v_viewer, 'none'), coalesce(v_admin, 'none'), coalesce(v_customer::text, 'none');
  END IF;

  PERFORM set_config('role', 'authenticated', true);

  -- ═══ 1. A viewer must be refused everywhere ════════════════════════════════
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_viewer, 'role', 'authenticated')::text, true);

  BEGIN
    INSERT INTO public.payments
      (customer_id, amount, unapplied_amount, method, payment_date, created_by, status)
    VALUES (v_customer, 1, 1, 'cash', current_date, v_viewer, 'active');
    v_out := v_out || 'FAIL payments: viewer INSERT succeeded. ';
  EXCEPTION
    WHEN insufficient_privilege THEN v_out := v_out || 'PASS payments. ';
    WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE payments (SQLSTATE %s). ', SQLSTATE);
  END;

  IF v_payment IS NULL OR v_invoice IS NULL THEN
    v_out := v_out || 'SKIP payment_applications (no payment or posted invoice exists). ';
  ELSE
    BEGIN
      INSERT INTO public.payment_applications
        (payment_id, invoice_id, amount_applied, applied_by)
      VALUES (v_payment, v_invoice, 1, v_viewer);
      v_out := v_out || 'FAIL payment_applications: viewer INSERT succeeded. ';
    EXCEPTION
      WHEN insufficient_privilege THEN v_out := v_out || 'PASS payment_applications. ';
      WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE payment_applications (SQLSTATE %s). ', SQLSTATE);
    END;
  END IF;

  IF v_cn IS NULL OR v_invoice IS NULL THEN
    v_out := v_out || 'SKIP credit_note_applications (no credit note or posted invoice exists). ';
  ELSE
    BEGIN
      INSERT INTO public.credit_note_applications
        (credit_note_id, invoice_id, amount_applied, applied_by)
      VALUES (v_cn, v_invoice, 1, v_viewer);
      v_out := v_out || 'FAIL credit_note_applications: viewer INSERT succeeded. ';
    EXCEPTION
      WHEN insufficient_privilege THEN v_out := v_out || 'PASS credit_note_applications. ';
      WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE credit_note_applications (SQLSTATE %s). ', SQLSTATE);
    END;
  END IF;

  BEGIN
    INSERT INTO public.vendor_payments
      (vendor_id, amount, unapplied_amount, method, payment_date, created_by, status)
    SELECT id, 1, 1, 'cash', current_date, v_viewer, 'active' FROM public.brands LIMIT 1;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      v_out := v_out || 'SKIP vendor_payments (no vendor readable to build a row). ';
    ELSE
      v_out := v_out || 'FAIL vendor_payments: viewer INSERT succeeded. ';
    END IF;
  EXCEPTION
    WHEN insufficient_privilege THEN v_out := v_out || 'PASS vendor_payments. ';
    WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE vendor_payments (SQLSTATE %s). ', SQLSTATE);
  END;

  IF v_vpayment IS NULL OR v_vinvoice IS NULL THEN
    v_out := v_out || 'SKIP vendor_payment_applications (no vendor payment or vendor invoice exists). ';
  ELSE
    BEGIN
      INSERT INTO public.vendor_payment_applications
        (payment_id, invoice_id, amount_applied, applied_by)
      VALUES (v_vpayment, v_vinvoice, 1, v_viewer);
      v_out := v_out || 'FAIL vendor_payment_applications: viewer INSERT succeeded. ';
    EXCEPTION
      WHEN insufficient_privilege THEN v_out := v_out || 'PASS vendor_payment_applications. ';
      WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE vendor_payment_applications (SQLSTATE %s). ', SQLSTATE);
    END;
  END IF;

  -- ═══ 2. An administrator must still be able to restore ═════════════════════
  -- Backup & Restore upserts these tables from the browser as an admin. If this
  -- fails, a restore silently skips the whole payment ledger.
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_admin, 'role', 'authenticated')::text, true);

  BEGIN
    INSERT INTO public.payments
      (customer_id, amount, unapplied_amount, method, payment_date, created_by, status)
    VALUES (v_customer, 1, 1, 'cash', current_date, v_admin, 'active');
    v_out := v_out || 'PASS admin restore path (payments INSERT allowed, rolled back). ';
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_out := v_out || 'FAIL admin restore path: payments INSERT refused — Backup & Restore is broken. ';
    WHEN OTHERS THEN
      v_out := v_out || format('INCONCLUSIVE admin restore path (SQLSTATE %s). ', SQLSTATE);
  END;

  RAISE EXCEPTION 'VERIFY 20260808 (rolled back) :: %', v_out;
END
$verify$;
