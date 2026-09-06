-- Verify 20260813_guard_sales_order_status.sql  (audit BUG-004, part 1)
--
-- Runs inside one transaction that ends in a RAISE, so nothing is committed —
-- including the fixture sales order it creates. A successful run ENDS IN AN
-- ERROR whose message is the verdict. Read the message, not the exit status.
--
-- Safe to run against production.
--
-- ── What each check is for ───────────────────────────────────────────────────
--
--   1  the exploit itself: a rep marking their own order delivered, which in
--      the real system would reserve stock via approve_sales_order and here
--      reserves nothing
--   2  the same bypass under the legacy vocabulary still present in the data
--      ('accepted', 'confirmed' — statuses no current code path writes)
--   3  the one legitimate client transition must survive (submit for approval)
--   4  editing a draft without touching status must survive
--   5  the RPC path must be unaffected — checked by confirming the guard stands
--      aside when the caller is not the client role, which is how every
--      SECURITY DEFINER money/stock function runs
--   6  an administrator must still get through, for Backup & Restore

DO $verify$
DECLARE
  v_rep      text;
  v_admin    text;
  v_customer uuid;
  v_id       uuid;
  v_out      text := '';
BEGIN
  SELECT user_email INTO v_rep
    FROM public.user_roles WHERE role = 'sales_rep' AND status = 'active' LIMIT 1;
  IF v_rep IS NULL THEN
    SELECT user_email INTO v_rep
      FROM public.user_roles WHERE role = 'manager' AND status = 'active' LIMIT 1;
  END IF;
  SELECT user_email INTO v_admin
    FROM public.user_roles WHERE role IN ('admin', 'super_admin') AND status = 'active' LIMIT 1;
  SELECT id INTO v_customer FROM public.customers LIMIT 1;

  IF v_rep IS NULL OR v_admin IS NULL OR v_customer IS NULL THEN
    RAISE EXCEPTION 'Cannot verify: need an active rep/manager (%), an active admin (%) and a customer (%).',
      coalesce(v_rep, 'none'), coalesce(v_admin, 'none'), coalesce(v_customer::text, 'none');
  END IF;

  INSERT INTO public.sales_orders
    (so_code, customer_id, status, line_items,
     subtotal, discount_amount, tax_amount, total, created_by, assigned_rep)
  VALUES ('SO-PROBE-' || substr(gen_random_uuid()::text, 1, 8), v_customer, 'sent', '[]'::jsonb,
          0, 0, 0, 0, v_rep, v_rep)
  RETURNING id INTO v_id;

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_rep, 'role', 'authenticated')::text, true);

  -- ═══ 1. The bypass: sent -> delivered without reserving anything ═══════════
  BEGIN
    UPDATE public.sales_orders SET status = 'delivered' WHERE id = v_id;
    v_out := v_out || 'FAIL rep marked the order delivered directly. ';
  EXCEPTION
    WHEN raise_exception THEN v_out := v_out || 'PASS delivered refused. ';
    WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE delivered (SQLSTATE %s). ', SQLSTATE);
  END;

  -- ═══ 2. The same bypass in the legacy vocabulary ═══════════════════════════
  BEGIN
    UPDATE public.sales_orders SET status = 'confirmed' WHERE id = v_id;
    v_out := v_out || 'FAIL rep set the legacy status confirmed directly. ';
  EXCEPTION
    WHEN raise_exception THEN v_out := v_out || 'PASS legacy confirmed refused. ';
    WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE confirmed (SQLSTATE %s). ', SQLSTATE);
  END;

  -- ═══ 3. Submitting for approval must still work ════════════════════════════
  -- Fixture starts at 'sent'; move it to draft as a privileged caller first so
  -- this exercises the real draft -> sent path.
  RESET ROLE;
  UPDATE public.sales_orders SET status = 'draft' WHERE id = v_id;
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_rep, 'role', 'authenticated')::text, true);

  BEGIN
    UPDATE public.sales_orders SET status = 'sent' WHERE id = v_id;
    v_out := v_out || 'PASS submit for approval still allowed. ';
  EXCEPTION
    WHEN OTHERS THEN
      v_out := v_out || format('FAIL submit for approval refused (SQLSTATE %s) - guard too tight. ', SQLSTATE);
  END;

  -- ═══ 4. Editing without touching status must still work ════════════════════
  BEGIN
    UPDATE public.sales_orders SET notes = 'probe', total = 5 WHERE id = v_id;
    v_out := v_out || 'PASS editing an order without a status change still allowed. ';
  EXCEPTION
    WHEN OTHERS THEN
      v_out := v_out || format('FAIL plain edit refused (SQLSTATE %s) - guard too tight. ', SQLSTATE);
  END;

  -- ═══ 5. The RPC path is unaffected ═════════════════════════════════════════
  -- Every stock/money RPC is SECURITY DEFINER and runs as its owner, so the
  -- guard's first branch stands aside. Reproduced here by leaving the client
  -- role rather than by calling approve_sales_order itself, which would reserve
  -- real inventory and fail for unrelated reasons on a zero-line fixture.
  RESET ROLE;
  BEGIN
    UPDATE public.sales_orders SET status = 'delivered' WHERE id = v_id;
    v_out := v_out || 'PASS a non-client caller (the RPC context) can still set delivered. ';
  EXCEPTION
    WHEN OTHERS THEN
      v_out := v_out || format('FAIL the RPC context is blocked (SQLSTATE %s) - approve_sales_order would break. ', SQLSTATE);
  END;

  -- ═══ 6. Administrators pass, for Backup & Restore ══════════════════════════
  RESET ROLE;
  UPDATE public.sales_orders SET status = 'draft' WHERE id = v_id;
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_admin, 'role', 'authenticated')::text, true);

  BEGIN
    UPDATE public.sales_orders SET status = 'delivered' WHERE id = v_id;
    v_out := v_out || 'PASS admin restore path still writes status.';
  EXCEPTION
    WHEN OTHERS THEN
      v_out := v_out || format('FAIL admin restore path blocked (SQLSTATE %s).', SQLSTATE);
  END;

  RAISE EXCEPTION 'VERIFY 20260813 (rolled back) :: %', v_out;
END
$verify$;
