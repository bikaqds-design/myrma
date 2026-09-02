-- Can a viewer bypass RLS by calling an RPC directly?
--
-- Every function below is SECURITY DEFINER and lives in the public schema, so
-- PostgREST exposes it at /rest/v1/rpc/<name> and it executes as its owner —
-- which means RLS does not apply to anything it does.
--
-- That is fine when the function checks who is calling. Many do:
-- post_invoice, record_payment, void_invoice, transfer_stock and others all
-- open with rma_is_manager_or_above() or rma_can_handle_cash(). But a number
-- appear to check nothing at all, including delete_customer_cascade — which
-- would let any signed-in user delete a customer that 20260787 just stopped
-- them deleting directly.
--
-- This measures it instead of assuming.
--
-- ── Why it is safe to run ────────────────────────────────────────────────────
--
-- Every call uses a non-existent UUID or an unknown key, so the function has
-- nothing to act on. What matters is *which* error comes back:
--
--   "Not authorized …"        → the function checked. GUARDED.
--   anything else, or success → execution reached the body. UNGUARDED:
--                               the only thing that stopped it was bad input.
--
-- The one exception is delete_customer_cascade, which is given a real
-- throwaway customer created for the purpose, because "deleted nothing" and
-- "refused" are otherwise indistinguishable. That row is removed either way.
--
-- Nothing else in the database is touched. Sequence numbers are not consumed:
-- nextval_for_type is probed with an unknown type so it raises before
-- incrementing.

CREATE OR REPLACE FUNCTION pg_temp.zz_probe_rpc()
RETURNS TABLE(fn text, verdict text, detail text)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_rows  text[] := ARRAY[]::text[];
  v_dead  uuid   := '00000000-0000-0000-0000-000000000000';
  v_cust  uuid;
  v_n     integer;
  v_notif uuid;
  v_read  text[];
BEGIN
  DELETE FROM public.user_roles WHERE user_email = 'rpcprobe@zz-probe.invalid';
  DELETE FROM public.notifications WHERE type = 'zz_probe';
  INSERT INTO public.user_roles (user_email, role, status)
  VALUES ('rpcprobe@zz-probe.invalid', 'viewer', 'active');

  INSERT INTO public.customers (customer_code, customer_type, contact_person)
  VALUES ('ZZ-RPC-PROBE', 'B2C', 'zz rpc probe')
  RETURNING id INTO v_cust;

  INSERT INTO public.notifications (type, title, message, target_emails)
  VALUES ('zz_probe', 'ZZ probe', 'ZZ probe', ARRAY['rpcprobe@zz-probe.invalid'])
  RETURNING id INTO v_notif;

  PERFORM set_config('request.jwt.claims',
                     '{"email":"rpcprobe@zz-probe.invalid","role":"authenticated"}',
                     true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- ── The headline: can a viewer delete a customer through the RPC? ──────────
  BEGIN
    PERFORM public.delete_customer_cascade(v_cust);
    v_rows := v_rows || (E'delete_customer_cascade\tUNGUARDED\tran as viewer')::text;
  EXCEPTION WHEN OTHERS THEN
    v_rows := v_rows || ('delete_customer_cascade' || E'\t' ||
      CASE WHEN SQLERRM ILIKE '%not authorized%' THEN 'guarded'
           WHEN SQLERRM ILIKE '%permission denied for function%' THEN 'REVOKED'
           ELSE 'UNGUARDED' END ||
      E'\t' || left(SQLERRM, 70));
  END;

  BEGIN
    PERFORM public.delete_customers_cascade(ARRAY[v_dead]);
    v_rows := v_rows || (E'delete_customers_cascade\tUNGUARDED\tran as viewer')::text;
  EXCEPTION WHEN OTHERS THEN
    v_rows := v_rows || ('delete_customers_cascade' || E'\t' ||
      CASE WHEN SQLERRM ILIKE '%not authorized%' THEN 'guarded'
           WHEN SQLERRM ILIKE '%permission denied for function%' THEN 'REVOKED'
           ELSE 'UNGUARDED' END ||
      E'\t' || left(SQLERRM, 70));
  END;

  -- ── Financial reversals. The public wrappers check; these internals are
  --    exposed at the same endpoint and may not. ────────────────────────────
  BEGIN
    PERFORM public._reverse_payment_application(v_dead, 'zz', 'zz');
    v_rows := v_rows || (E'_reverse_payment_application\tUNGUARDED\tran as viewer')::text;
  EXCEPTION WHEN OTHERS THEN
    v_rows := v_rows || ('_reverse_payment_application' || E'\t' ||
      CASE WHEN SQLERRM ILIKE '%not authorized%' THEN 'guarded'
           WHEN SQLERRM ILIKE '%permission denied for function%' THEN 'REVOKED'
           ELSE 'UNGUARDED' END ||
      E'\t' || left(SQLERRM, 70));
  END;

  BEGIN
    PERFORM public._reverse_credit_note_application(v_dead, 'zz', 'zz');
    v_rows := v_rows || (E'_reverse_credit_note_application\tUNGUARDED\tran as viewer')::text;
  EXCEPTION WHEN OTHERS THEN
    v_rows := v_rows || ('_reverse_credit_note_application' || E'\t' ||
      CASE WHEN SQLERRM ILIKE '%not authorized%' THEN 'guarded'
           WHEN SQLERRM ILIKE '%permission denied for function%' THEN 'REVOKED'
           ELSE 'UNGUARDED' END ||
      E'\t' || left(SQLERRM, 70));
  END;

  BEGIN
    PERFORM public._reverse_vendor_payment_application(v_dead, 'zz', 'zz');
    v_rows := v_rows || (E'_reverse_vendor_payment_application\tUNGUARDED\tran as viewer')::text;
  EXCEPTION WHEN OTHERS THEN
    v_rows := v_rows || ('_reverse_vendor_payment_application' || E'\t' ||
      CASE WHEN SQLERRM ILIKE '%not authorized%' THEN 'guarded'
           WHEN SQLERRM ILIKE '%permission denied for function%' THEN 'REVOKED'
           ELSE 'UNGUARDED' END ||
      E'\t' || left(SQLERRM, 70));
  END;

  -- ── Stock movement. These are called by guarded RPCs, but are themselves
  --    endpoints. ──────────────────────────────────────────────────────────
  BEGIN
    PERFORM public.reserve_units('sales_order', v_dead, v_dead, 1, 'zz');
    v_rows := v_rows || (E'reserve_units\tUNGUARDED\tran as viewer')::text;
  EXCEPTION WHEN OTHERS THEN
    v_rows := v_rows || ('reserve_units' || E'\t' ||
      CASE WHEN SQLERRM ILIKE '%not authorized%' THEN 'guarded'
           WHEN SQLERRM ILIKE '%permission denied for function%' THEN 'REVOKED'
           ELSE 'UNGUARDED' END ||
      E'\t' || left(SQLERRM, 70));
  END;

  BEGIN
    PERFORM public.release_units('sales_order', v_dead, 'zz');
    v_rows := v_rows || (E'release_units\tUNGUARDED\tran as viewer (no-op, nothing reserved)')::text;
  EXCEPTION WHEN OTHERS THEN
    v_rows := v_rows || ('release_units' || E'\t' ||
      CASE WHEN SQLERRM ILIKE '%not authorized%' THEN 'guarded'
           WHEN SQLERRM ILIKE '%permission denied for function%' THEN 'REVOKED'
           ELSE 'UNGUARDED' END ||
      E'\t' || left(SQLERRM, 70));
  END;

  BEGIN
    PERFORM public.adjust_part_quantity(v_dead, 0);
    v_rows := v_rows || (E'adjust_part_quantity\tUNGUARDED\tran as viewer')::text;
  EXCEPTION WHEN OTHERS THEN
    v_rows := v_rows || ('adjust_part_quantity' || E'\t' ||
      CASE WHEN SQLERRM ILIKE '%not authorized%' THEN 'guarded'
           WHEN SQLERRM ILIKE '%permission denied for function%' THEN 'REVOKED'
           ELSE 'UNGUARDED' END ||
      E'\t' || left(SQLERRM, 70));
  END;

  -- ── Sales document state changes ──────────────────────────────────────────
  BEGIN
    PERFORM public.cancel_sales_order(v_dead, 'zz');
    v_rows := v_rows || (E'cancel_sales_order\tUNGUARDED\tran as viewer')::text;
  EXCEPTION WHEN OTHERS THEN
    v_rows := v_rows || ('cancel_sales_order' || E'\t' ||
      CASE WHEN SQLERRM ILIKE '%not authorized%' THEN 'guarded'
           WHEN SQLERRM ILIKE '%permission denied for function%' THEN 'REVOKED'
           ELSE 'UNGUARDED' END ||
      E'\t' || left(SQLERRM, 70));
  END;

  BEGIN
    PERFORM public.convert_quotation_to_so(v_dead, 'zz');
    v_rows := v_rows || (E'convert_quotation_to_so\tUNGUARDED\tran as viewer')::text;
  EXCEPTION WHEN OTHERS THEN
    v_rows := v_rows || ('convert_quotation_to_so' || E'\t' ||
      CASE WHEN SQLERRM ILIKE '%not authorized%' THEN 'guarded'
           WHEN SQLERRM ILIKE '%permission denied for function%' THEN 'REVOKED'
           ELSE 'UNGUARDED' END ||
      E'\t' || left(SQLERRM, 70));
  END;

  -- ── Someone else's notifications ──────────────────────────────────────────
  BEGIN
    PERFORM public.mark_notifications_read('someone.else@example.com', ARRAY[v_notif]);
    NULL; -- verdict is decided after RESET ROLE, by inspecting read_by
  EXCEPTION WHEN OTHERS THEN
    v_rows := v_rows || ('mark_notifications_read' || E'\t' ||
      CASE WHEN SQLERRM ILIKE '%not authorized%' THEN 'guarded'
           WHEN SQLERRM ILIKE '%permission denied for function%' THEN 'REVOKED'
           ELSE 'UNGUARDED' END ||
      E'\t' || left(SQLERRM, 70));
  END;

  -- ── A control: this one is known to check, and must come back guarded.
  --    If it does not, the probe itself is wrong. ─────────────────────────────
  BEGIN
    PERFORM public.post_invoice(v_dead, 'zz');
    v_rows := v_rows || (E'post_invoice (CONTROL)\tPROBE BROKEN\tshould have refused a viewer')::text;
  EXCEPTION WHEN OTHERS THEN
    v_rows := v_rows || ('post_invoice (CONTROL)' || E'\t' ||
      CASE WHEN SQLERRM ILIKE '%not authorized%' THEN 'guarded — probe is sound'
           ELSE 'PROBE BROKEN' END ||
      E'\t' || left(SQLERRM, 70));
  END;

  EXECUTE 'RESET ROLE';

  -- ── Did mark_notifications_read honour the email it was handed? ───────────
  -- 20260788 made it take the caller identity from the JWT and ignore p_email.
  -- The call above passed someone.else@example.com while signed in as the
  -- probe viewer, so read_by must contain the viewer and not the stranger.
  SELECT read_by INTO v_read FROM public.notifications WHERE id = v_notif;
  v_rows := v_rows || ('mark_notifications_read' || E'	' ||
    CASE
      WHEN v_read @> ARRAY['someone.else@example.com']
        THEN 'UNGUARDED'
      WHEN v_read @> ARRAY['rpcprobe@zz-probe.invalid']
        THEN 'guarded'
      ELSE 'guarded'
    END || E'	' ||
    CASE
      WHEN v_read @> ARRAY['someone.else@example.com']
        THEN 'p_email was trusted — marked a stranger''s notification'
      WHEN v_read @> ARRAY['rpcprobe@zz-probe.invalid']
        THEN 'p_email ignored; marked the caller''s own, which is correct'
      ELSE 'refused outright'
    END);

  -- ── Cleanup ───────────────────────────────────────────────────────────────
  DELETE FROM public.customers  WHERE customer_code = 'ZZ-RPC-PROBE';
  DELETE FROM public.user_roles WHERE user_email = 'rpcprobe@zz-probe.invalid';
  DELETE FROM public.notifications WHERE type = 'zz_probe';

  SELECT (SELECT count(*) FROM public.customers  WHERE customer_code = 'ZZ-RPC-PROBE')
       + (SELECT count(*) FROM public.user_roles WHERE user_email = 'rpcprobe@zz-probe.invalid')
       + (SELECT count(*) FROM public.notifications WHERE type = 'zz_probe')
    INTO v_n;
  v_rows := v_rows || ('— cleanup' || E'\t' ||
    CASE WHEN v_n = 0 THEN 'CLEAN' ELSE 'LEFTOVER' END || E'\t' || v_n || ' probe rows remaining');

  RETURN QUERY
  SELECT split_part(r, E'\t', 1), split_part(r, E'\t', 2), split_part(r, E'\t', 3)
    FROM unnest(v_rows) AS r;

EXCEPTION WHEN OTHERS THEN
  EXECUTE 'RESET ROLE';
  DELETE FROM public.customers  WHERE customer_code = 'ZZ-RPC-PROBE';
  DELETE FROM public.user_roles WHERE user_email = 'rpcprobe@zz-probe.invalid';
  DELETE FROM public.notifications WHERE type = 'zz_probe';
  RAISE;
END
$fn$;

SELECT * FROM pg_temp.zz_probe_rpc();

-- ─── Reading the result ──────────────────────────────────────────────────────
--
-- The CONTROL row must say "guarded — probe is sound". If it says PROBE BROKEN,
-- the probe is not reaching the functions as a viewer and every other row is
-- meaningless — a detector that cannot fail is not evidence.
--
-- Any other row reading UNGUARDED is an RLS bypass: that function can be
-- called from the browser by anyone with a session, at
-- /rest/v1/rpc/<name>, and it runs as the table owner.
