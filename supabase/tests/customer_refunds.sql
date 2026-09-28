-- ############################################################################
-- #  CUSTOMER REFUNDS — P-05c (20260904)
-- #
-- #  node scripts/run-sql-test.mjs supabase/tests/customer_refunds.sql P05C_TEST_DONE
-- #  ENDS WITH A FORCED ROLLBACK. Reference script, not run by CI. The final
-- #  error message also carries every PASS/FAIL line, for runners that do not
-- #  show notices.
-- ############################################################################

SELECT set_config('p05c.log', '', false);
CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT '')
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE l text := format('%s  %s %s', CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_label, CASE WHEN p_ok THEN '' ELSE p_detail END);
BEGIN
  PERFORM set_config('p05c.log', COALESCE(current_setting('p05c.log', true), '') || E'\n' || l, false);
  RETURN l;
END $f$;
CREATE FUNCTION pg_temp.call(p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE out text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    out := 'ok';
  EXCEPTION WHEN OTHERS THEN
    out := 'err:' || SQLSTATE || ' ' || left(SQLERRM, 200);
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN out;
END $f$;
-- record a refund as someone; 'ok:<id>' or the error
CREATE FUNCTION pg_temp.refund(p_email text, p_type text, p_src uuid, p_amount numeric) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_id uuid;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT (public.record_customer_refund(p_type, p_src, p_amount, 'bank_transfer', 'TRX-1', NULL, NULL, p_email)).id INTO v_id;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN 'ok:' || v_id;
EXCEPTION WHEN OTHERS THEN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN 'err:' || SQLSTATE || ' ' || left(SQLERRM, 200);
END $f$;

DO $do$
DECLARE
  v_mgr   text := 'p05c-mgr@test.local';
  v_mgr2  text := 'p05c-mgr2@test.local';
  v_rep   text := 'p05c-rep@test.local';
  v_acct  text := 'p05c-acct@test.local';
  v_tech  text := 'p05c-tech@test.local';
  v_cust  uuid;
  v_inv   uuid := gen_random_uuid();
  v_inv2  uuid := gen_random_uuid();
  v_pay   uuid := gen_random_uuid();
  v_cn    uuid := gen_random_uuid();
  v_rf    uuid;
  v_out   text;
  v_n     integer;
BEGIN
  INSERT INTO public.user_roles (user_email, role, status) VALUES
    (v_mgr, 'manager', 'active'), (v_mgr2, 'manager', 'active'), (v_rep, 'sales_rep', 'active'),
    (v_acct, 'accountant', 'active'), (v_tech, 'technician', 'active');
  INSERT INTO public.customers (company_name, customer_code, customer_type) VALUES ('P05c Co', 'P05C-C1', 'B2B') RETURNING id INTO v_cust;
  -- a posted invoice of 1000, paid with 1200 (200 over); a second of 100, unpaid
  INSERT INTO public.crm_invoices (id, inv_code, customer_id, created_by, doc_status, payment_status, subtotal, total, line_items)
  VALUES (v_inv, 'INV-P05C-1', v_cust, v_mgr, 'posted', 'unpaid', 1000, 1000, '[]'),
         (v_inv2, 'INV-P05C-2', v_cust, v_mgr, 'posted', 'unpaid', 100, 100, '[]');
  INSERT INTO public.payments (id, payment_code, customer_id, amount, unapplied_amount, method, created_by)
  VALUES (v_pay, 'PAY-P05C-1', v_cust, 1200, 1200, 'bank_transfer', v_mgr);
  INSERT INTO public.payment_applications (payment_id, invoice_id, amount_applied, applied_by) VALUES (v_pay, v_inv, 1000, v_mgr);
  -- an issued credit note of 300, nothing applied
  INSERT INTO public.credit_notes (id, cn_code, type, customer_id, status, total, remaining_balance, applied_amount, reason, reason_code, created_by, issued_at)
  VALUES (v_cn, 'CN-P05C-1', 'rebate', v_cust, 'issued', 300, 300, 0, 'Volume rebate', 'rebate', v_mgr, now());
  PERFORM pg_temp.check('fixture: the payment has 200 unapplied, the credit note 300 remaining',
    (SELECT unapplied_amount FROM public.payments WHERE id = v_pay) = 200
    AND (SELECT remaining_balance FROM public.credit_notes WHERE id = v_cn) = 300);

  -- ══ 1. recording ══════════════════════════════════════════════════════════
  v_out := pg_temp.refund(v_rep, 'payment', v_pay, 50);
  PERFORM pg_temp.check('a sales rep cannot record a refund', v_out LIKE 'err:42501%permission to record refunds%', '-> ' || v_out);
  v_out := pg_temp.refund(v_mgr, 'payment', v_pay, 250);
  PERFORM pg_temp.check('never more than the payment has left (250 of 200)', v_out LIKE 'err:P0001%Only 200.00 is left%', '-> ' || v_out);
  v_out := pg_temp.refund(v_mgr, 'payment', v_pay, 0.001);
  PERFORM pg_temp.check('an amount in fractions of a cent is refused', v_out LIKE 'err:P0001%whole cents%', '-> ' || v_out);
  v_out := pg_temp.refund(v_mgr, 'payment', v_pay, 150);
  v_rf := substr(v_out, 4)::uuid;
  PERFORM pg_temp.check('a refund waits for approval: no number, the payment untouched',
    v_out LIKE 'ok:%' AND (SELECT status = 'pending_approval' AND refund_code IS NULL AND customer_id = v_cust FROM public.customer_refunds WHERE id = v_rf)
    AND (SELECT unapplied_amount FROM public.payments WHERE id = v_pay) = 200, '-> ' || v_out);
  v_out := pg_temp.refund(v_mgr2, 'payment', v_pay, 60);
  PERFORM pg_temp.check('refunds waiting count (150 waiting + 60 > 200)', v_out LIKE 'err:P0001%Only 50.00 is left%', '-> ' || v_out);

  -- ══ 2. a second manager approves ══════════════════════════════════════════
  v_out := pg_temp.call(v_mgr, format('SELECT public.approve_customer_refund(%L, %L)', v_rf, v_mgr));
  PERFORM pg_temp.check('the manager who recorded it cannot approve it', v_out LIKE 'err:P0001%recorded a refund cannot approve%', '-> ' || v_out);
  v_out := pg_temp.call(v_acct, format('SELECT public.approve_customer_refund(%L, %L)', v_rf, v_acct));
  PERFORM pg_temp.check('an accountant cannot approve it (a second MANAGER)', v_out LIKE 'err:42501%permission to approve refunds%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr2, format('SELECT public.approve_customer_refund(%L, %L)', v_rf, v_mgr2));
  PERFORM pg_temp.check('another manager approves it: numbered RF-, approver recorded, the payment has 50 left',
    v_out = 'ok' AND (SELECT status = 'approved' AND refund_code LIKE 'RF-%' AND approved_by = v_mgr2 FROM public.customer_refunds WHERE id = v_rf)
    AND (SELECT unapplied_amount FROM public.payments WHERE id = v_pay) = 50, '-> ' || v_out);
  v_out := pg_temp.call(v_mgr2, format('SELECT public.approve_customer_refund(%L, %L)', v_rf, v_mgr2));
  PERFORM pg_temp.check('approved once', v_out LIKE 'err:P0001%Only a refund waiting%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr2, format('SELECT public.reject_customer_refund(%L, %L, %L)', v_rf, 'changed mind', v_mgr2));
  PERFORM pg_temp.check('an approved refund cannot be rejected (the money has left)', v_out LIKE 'err:P0001%money has left%', '-> ' || v_out);
  PERFORM pg_temp.check('the customer statement shows it as +150',
    EXISTS (SELECT 1 FROM public.v_customer_ledger WHERE id = v_rf AND entry_type = 'refund' AND amount = 150));
  v_out := pg_temp.call(v_mgr, format('SELECT public.apply_payment_to_invoice(%L, %L, 60, %L)', v_pay, v_inv2, v_mgr));
  PERFORM pg_temp.check('what was refunded cannot also be applied to an invoice (60 of 50)', v_out LIKE 'err:%', '-> ' || v_out);

  -- ══ 3. rejecting, and the check again at approval ═════════════════════════
  v_out := pg_temp.refund(v_mgr, 'payment', v_pay, 50);
  v_rf := substr(v_out, 4)::uuid;
  v_out := pg_temp.call(v_mgr, format('SELECT public.reject_customer_refund(%L, %L, %L)', v_rf, 'Customer wants it on the next invoice', v_mgr));
  PERFORM pg_temp.check('a waiting refund is rejected; the recorder may withdraw it',
    v_out = 'ok' AND (SELECT status = 'rejected' AND refund_code IS NULL FROM public.customer_refunds WHERE id = v_rf), '-> ' || v_out);
  v_out := pg_temp.refund(v_mgr, 'payment', v_pay, 50);
  v_rf := substr(v_out, 4)::uuid;
  PERFORM pg_temp.check('a rejected refund frees its amount', v_out LIKE 'ok:%', '-> ' || v_out);
  INSERT INTO public.payment_applications (payment_id, invoice_id, amount_applied, applied_by) VALUES (v_pay, v_inv2, 30, v_mgr);
  v_out := pg_temp.call(v_mgr2, format('SELECT public.approve_customer_refund(%L, %L)', v_rf, v_mgr2));
  PERFORM pg_temp.check('approval checks again: 30 applied meanwhile leaves 20, the 50 is refused', v_out LIKE 'err:P0001%Only 20.00 is left%', '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('SELECT public.void_payment(%L, %L, %L)', v_pay, 'test', v_mgr));
  PERFORM pg_temp.check('a payment with a refund cannot be voided', v_out LIKE 'err:P0001%has a refund%', '-> ' || v_out);

  -- ══ 4. from a credit note ═════════════════════════════════════════════════
  v_out := pg_temp.refund(v_mgr, 'credit_note', v_cn, 300);
  v_rf := substr(v_out, 4)::uuid;
  v_out := pg_temp.call(v_mgr2, format('SELECT public.approve_customer_refund(%L, %L)', v_rf, v_mgr2));
  PERFORM pg_temp.check('a credit note refunded in full: nothing remaining, status applied',
    v_out = 'ok' AND (SELECT remaining_balance = 0 AND status = 'applied' AND applied_amount = 0 FROM public.credit_notes WHERE id = v_cn), '-> ' || v_out);
  v_out := pg_temp.call(v_mgr, format('SELECT public.void_credit_note(%L, %L, %L)', v_cn, 'test', v_mgr));
  PERFORM pg_temp.check('a refunded credit note cannot be voided', v_out LIKE 'err:P0001%has a refund%', '-> ' || v_out);
  v_out := pg_temp.refund(v_mgr, 'credit_note', v_cn, 1);
  PERFORM pg_temp.check('nothing left to refund from it', v_out LIKE 'err:P0001%Only 0%', '-> ' || v_out);

  -- ══ 5. who sees and writes ════════════════════════════════════════════════
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_acct, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*)::integer INTO v_n FROM public.customer_refunds WHERE customer_id = v_cust;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.check('an accountant sees the refunds', v_n = 4, '-> ' || v_n);
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_tech, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*)::integer INTO v_n FROM public.customer_refunds WHERE customer_id = v_cust;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM pg_temp.check('a technician sees none', v_n = 0, '-> ' || v_n);
  v_out := pg_temp.call(v_mgr, format('INSERT INTO public.customer_refunds (customer_id, payment_id, amount, method, created_by, status) VALUES (%L, %L, 1, %L, %L, %L)',
    v_cust, v_pay, 'cash', v_mgr, 'approved'));
  PERFORM pg_temp.check('no direct writes', v_out LIKE 'err:42501%', '-> ' || v_out);
  PERFORM pg_temp.check('anon runs none of it; no client runs the balance recalculation',
    NOT has_function_privilege('anon', 'public.record_customer_refund(text, uuid, numeric, text, text, date, text, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.approve_customer_refund(uuid, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.rma_credit_note_resync(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public._rma_refund_room(uuid, uuid, uuid)', 'EXECUTE'));

  RAISE EXCEPTION 'P05C_TEST_DONE %', current_setting('p05c.log', true);
END $do$;
