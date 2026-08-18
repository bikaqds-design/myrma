-- Verify 20260780: can an accountant actually move money?
--
-- Everything runs inside a transaction that is rolled back — the payment, the
-- void and the throwaway accountant row all disappear.
--
-- Why the second half exists: last time this role was "verified" by checking
-- that the Record Payment and Void buttons rendered enabled. They did. The
-- database refused the action anyway, because the app's permission gate and the
-- RPC's role gate are different things. Reading a gate is not exercising it, so
-- this calls the functions for real.

-- ── 1. Which functions now admit the accountant ─────────────────────────────
SELECT p.proname,
       CASE WHEN pg_get_functiondef(p.oid) LIKE '%rma_can_handle_cash%'
            THEN 'accountant allowed'
            ELSE 'manager only' END AS gate
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('record_payment','void_payment',
                    'record_vendor_payment','void_vendor_payment',
                    'apply_payment_to_invoice','reverse_payment_application',
                    'apply_credit_note_to_invoice',
                    'issue_credit_note','post_invoice')
ORDER BY gate, p.proname;
-- Expect: seven "accountant allowed"; issue_credit_note and post_invoice
-- "manager only" — origination stays away from whoever settles the cash.


-- ── 2. Exercise it for real, as an accountant ───────────────────────────────
BEGIN;

INSERT INTO public.user_roles (user_email, role, status)
VALUES ('zz-verify-accountant@example.com', 'accountant', 'active')
ON CONFLICT (user_email) DO UPDATE SET role = 'accountant';

CREATE TEMP TABLE _cash_result(step text, outcome text) ON COMMIT DROP;

DO $$
DECLARE
  v_customer uuid;
  v_payment  uuid;
BEGIN
  SELECT id INTO v_customer FROM public.customers ORDER BY created_date LIMIT 1;

  PERFORM set_config('request.jwt.claims',
    json_build_object('email','zz-verify-accountant@example.com','role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- record
  BEGIN
    v_payment := public.record_payment(
      p_customer_id     => v_customer,
      p_amount          => 1.00,
      p_method          => 'cash',
      p_reference_number=> 'ZZ-VERIFY',
      p_payment_date    => CURRENT_DATE,
      p_notes           => 'rollback verification',
      p_actor_email     => 'zz-verify-accountant@example.com',
      p_allocations     => '[]'::jsonb
    );
    INSERT INTO _cash_result VALUES ('record_payment', 'ALLOWED (id ' || v_payment || ')');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _cash_result VALUES ('record_payment', 'REFUSED: ' || SQLERRM);
  END;

  -- void the one just recorded
  IF v_payment IS NOT NULL THEN
    BEGIN
      PERFORM public.void_payment(
        p_payment_id  => v_payment,
        p_reason      => 'rollback verification',
        p_actor_email => 'zz-verify-accountant@example.com');
      INSERT INTO _cash_result VALUES ('void_payment', 'ALLOWED');
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO _cash_result VALUES ('void_payment', 'REFUSED: ' || SQLERRM);
    END;
  END IF;

  -- negative control: origination must still be refused
  BEGIN
    PERFORM public.issue_credit_note(
      (SELECT id FROM public.crm_invoices LIMIT 1),
      'rma_return', 1.00, 'rollback verification',
      'zz-verify-accountant@example.com');
    INSERT INTO _cash_result VALUES ('issue_credit_note', 'ALLOWED — SEGREGATION BROKEN');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _cash_result VALUES ('issue_credit_note', 'refused (correct): ' || left(SQLERRM, 60));
  END;

  RESET ROLE;
END
$$;

RESET ROLE;
SELECT * FROM _cash_result ORDER BY step;

ROLLBACK;

-- ── Reading the result ───────────────────────────────────────────────────────
--   record_payment     ALLOWED                  <- the fix works
--   void_payment       ALLOWED                  <- the fix works
--   issue_credit_note  refused (correct)        <- segregation of duties held
--
-- A REFUSED on either of the first two means the gate did not take. ALLOWED on
-- the third means the accountant can originate revenue documents, which is the
-- one thing the role must not do — tell me and I will re-gate it.
--
-- If issue_credit_note errors for an unrelated reason (no invoices, a bad
-- argument type) it will still read as "refused"; the message shows which.
