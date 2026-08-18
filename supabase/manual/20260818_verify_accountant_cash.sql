-- Verify 20260780: can an accountant actually move money?
--
-- Everything runs inside a transaction that is rolled back — the payment, the
-- void and the throwaway accountant row all disappear.
--
-- Why this exercises the functions instead of reading their gates: the role was
-- previously "verified" by checking that the Record Payment and Void buttons
-- rendered enabled. They did. The database refused the action anyway, because
-- the app's permission gate and the RPC's role gate are different things.
--
-- v2. The first attempt failed on its own scaffolding: after SET LOCAL ROLE
-- authenticated, the temp results table (owned by postgres) was not writable,
-- so even the error handler errored. Outcomes are now held in variables and
-- written after RESET ROLE. The full message is reported, so a gate refusal is
-- distinguishable from an argument or constraint error — the earlier version
-- would have read any failure as "refused", which is the same mistake in a
-- different costume.

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
-- Expect seven "accountant allowed"; issue_credit_note and post_invoice stay
-- "manager only" — origination is kept away from whoever settles the cash.


-- ── 2. Exercise it, as an accountant ────────────────────────────────────────
BEGIN;

INSERT INTO public.user_roles (user_email, role, status)
VALUES ('zz-verify-accountant@example.com', 'accountant', 'active')
ON CONFLICT (user_email) DO UPDATE SET role = 'accountant';

CREATE TEMP TABLE _cash_result(step text, outcome text) ON COMMIT DROP;

DO $$
DECLARE
  v_customer uuid;
  v_cn       uuid;
  v_payment  uuid;
  r_role     text;
  r_pred     text;
  r_record   text;
  r_void     text;
  r_issue    text;
BEGIN
  SELECT id INTO v_customer FROM public.customers ORDER BY created_date LIMIT 1;
  SELECT id INTO v_cn       FROM public.credit_notes LIMIT 1;

  PERFORM set_config('request.jwt.claims',
    json_build_object('email','zz-verify-accountant@example.com',
                      'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- what the database thinks we are, and whether the new predicate passes.
  -- Isolates a failed role lookup from a gate that was never re-written.
  BEGIN r_role := coalesce(public.rma_user_role(), '(null)');
  EXCEPTION WHEN OTHERS THEN r_role := 'ERROR: ' || SQLERRM; END;
  BEGIN r_pred := public.rma_can_handle_cash()::text;
  EXCEPTION WHEN OTHERS THEN r_pred := 'ERROR: ' || SQLERRM; END;

  BEGIN
    v_payment := public.record_payment(
      p_customer_id      => v_customer,
      p_amount           => 1.00,
      p_method           => 'bank_transfer',
      p_reference_number => 'ZZ-VERIFY',
      p_payment_date     => CURRENT_DATE,
      p_notes            => 'rollback verification',
      p_actor_email      => 'zz-verify-accountant@example.com',
      p_allocations      => '[]'::jsonb);
    r_record := 'ALLOWED';
  EXCEPTION WHEN OTHERS THEN r_record := 'FAILED: ' || SQLERRM; END;

  IF v_payment IS NOT NULL THEN
    BEGIN
      PERFORM public.void_payment(
        p_payment_id  => v_payment,
        p_reason      => 'rollback verification',
        p_actor_email => 'zz-verify-accountant@example.com');
      r_void := 'ALLOWED';
    EXCEPTION WHEN OTHERS THEN r_void := 'FAILED: ' || SQLERRM; END;
  ELSE
    r_void := 'skipped — nothing was recorded to void';
  END IF;

  -- Negative control. Correct signature this time: (p_cn_id, p_actor_email).
  BEGIN
    PERFORM public.issue_credit_note(v_cn, 'zz-verify-accountant@example.com');
    r_issue := 'ALLOWED — SEGREGATION BROKEN';
  EXCEPTION WHEN OTHERS THEN r_issue := 'refused: ' || SQLERRM; END;

  RESET ROLE;

  INSERT INTO _cash_result VALUES
    ('0. role seen by db',   r_role),
    ('1. can_handle_cash',   r_pred),
    ('2. record_payment',    r_record),
    ('3. void_payment',      r_void),
    ('4. issue_credit_note', r_issue);
END
$$;

RESET ROLE;
SELECT * FROM _cash_result ORDER BY step;

ROLLBACK;

-- ── Reading the result ───────────────────────────────────────────────────────
--   0. accountant
--   1. true
--   2. ALLOWED
--   3. ALLOWED
--   4. refused: Not authorized ...      <- segregation of duties held
--
-- 0 not 'accountant'      -> the role lookup failed, nothing below is meaningful
-- 1 false                 -> rma_can_handle_cash did not take
-- 2/3 FAILED: Not authorized -> the re-gate did not apply to that function
-- 2/3 FAILED: anything else  -> not a permissions problem; read the message
-- 4 ALLOWED               -> the accountant can originate revenue documents,
--                            the one thing the role must not do
