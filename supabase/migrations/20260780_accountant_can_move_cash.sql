-- The accountant could read the whole ledger and change none of it.
--
-- Every RPC on the cash path gates on rma_is_manager_or_above(), and an
-- accountant is not manager_or_above. So the role shipped in 20260777 could see
-- every payment and invoice and was refused by the database the moment it tried
-- to record or reverse one — while the UI showed "+ Record Payment" and "Void"
-- enabled, because the app gates those on accounting.record_payment /
-- reverse_payment, which the role does have.
--
-- A control that renders enabled and then raises is worse than one that is
-- hidden. This closes the gap on the database side, which is the side that was
-- wrong: the permission matrix is what the business asked for.
--
-- Seven of the eight cash RPCs admit the accountant. issue_credit_note does
-- NOT: issuing a credit note creates a sales document and reduces revenue, which
-- is origination. The whole point of the role is that whoever settles money does
-- not also raise the paperwork behind it. Applying an already-issued credit note
-- to an invoice is settlement, so that one is included.

-- ── The predicate ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rma_can_handle_cash() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS
$$ SELECT public.rma_is_manager_or_above()
        OR public.rma_user_role() = 'accountant' $$;

COMMENT ON FUNCTION public.rma_can_handle_cash() IS
  'May record, apply and reverse money: manager and above, plus accountant. '
  'Deliberately excludes origination (issue_credit_note, post_invoice) so the '
  'role that settles cash cannot also raise the document behind it.';

-- ── Re-gate the seven ────────────────────────────────────────────────────────
--
-- Rewrites the LIVE definition rather than restating each body here. Starting
-- from pg_get_functiondef means this cannot drift from what is actually
-- deployed, and touching only the gate line means no other logic can be lost to
-- a transcription slip. It raises if the expected gate is absent, so a function
-- that has been changed underneath us fails loudly instead of silently keeping
-- the old rule.

DO $$
DECLARE
  v_names text[] := ARRAY[
    'record_payment',
    'void_payment',
    'record_vendor_payment',
    'void_vendor_payment',
    'apply_payment_to_invoice',
    'reverse_payment_application',
    'apply_credit_note_to_invoice'
  ];
  v_old  CONSTANT text := 'IF NOT public.rma_is_manager_or_above() THEN';
  v_new  CONSTANT text := 'IF NOT public.rma_can_handle_cash() THEN';
  r      record;
  v_def  text;
  v_rewritten text;
  v_count int := 0;
BEGIN
  FOR r IN
    SELECT p.oid,
           format('public.%I(%s)', p.proname,
                  pg_get_function_identity_arguments(p.oid)) AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY(v_names)
  LOOP
    v_def := pg_get_functiondef(r.oid);

    IF position(v_old in v_def) = 0 THEN
      -- already re-gated by a previous run, or the body changed
      IF position(v_new in v_def) > 0 THEN
        RAISE NOTICE 'already re-gated: %', r.sig;
        CONTINUE;
      END IF;
      RAISE EXCEPTION
        'Expected gate not found in % — inspect it by hand before re-running.', r.sig;
    END IF;

    v_rewritten := replace(v_def, v_old, v_new);
    EXECUTE v_rewritten;
    v_count := v_count + 1;
    RAISE NOTICE 're-gated: %', r.sig;
  END LOOP;

  IF v_count = 0 THEN
    RAISE NOTICE 'Nothing re-gated. If this is a first run, the function names may differ.';
  END IF;
END
$$;

-- ─── Verification ────────────────────────────────────────────────────────────
--
-- 1. Seven functions should now reference rma_can_handle_cash, and
--    issue_credit_note and post_invoice should still reference
--    rma_is_manager_or_above:
--
--      SELECT p.proname,
--             CASE WHEN pg_get_functiondef(p.oid) LIKE '%rma_can_handle_cash%'
--                  THEN 'accountant allowed' ELSE 'manager only' END AS gate
--        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--       WHERE n.nspname = 'public'
--         AND p.proname IN ('record_payment','void_payment',
--                           'record_vendor_payment','void_vendor_payment',
--                           'apply_payment_to_invoice','reverse_payment_application',
--                           'apply_credit_note_to_invoice',
--                           'issue_credit_note','post_invoice')
--       ORDER BY gate, p.proname;
--
-- 2. Then record a small payment as an accountant and void it again, to prove
--    the path works end to end rather than just that the gate reads correctly.
