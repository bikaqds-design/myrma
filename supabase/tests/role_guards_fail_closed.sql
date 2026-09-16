-- ############################################################################
-- #  DB TEST TIER — BUG-087: role guards fail CLOSED
-- #
-- #  rma_user_role() is NULL for a caller with no current role — no user_roles
-- #  row, a suspended one, or an expired one. The helpers used to pass that NULL
-- #  on (`NULL IN (…)` is NULL), and `IF NOT helper() THEN RAISE` is an IF on
-- #  NULL, which does not fire: every such guard let the caller through.
-- #  20260867 makes the helpers return false and wraps the guards that compare
-- #  the role directly.
-- #
-- #  Pinned here in both directions — the role-less, suspended and expired
-- #  callers are refused, and every real role still gets exactly what it had —
-- #  plus two catalog invariants that catch the defect coming back in a
-- #  migration written later.
-- #
-- #  Same shape as the other files: collect failures, RAISE naming each one.
-- #  Seeded users from 20260706 are active in a fresh database; this file
-- #  suspends and expires one temporarily and puts it back.
-- ############################################################################

DO $$
DECLARE
  v_admin    text := 'dina.adel@test.com';      -- admin
  v_mgr      text := 'karim.nasser@test.com';   -- manager
  v_tech     text := 'hana.sayed@test.com';     -- technician
  v_rep      text := 'ahmed.hassan@test.com';   -- sales_rep
  v_viewer   text := 'rami.farouk@test.com';    -- viewer
  v_nobody   text := 'bug-087-test@invalid.example';
  v_failures text[] := '{}';
  v_checks   int := 0;
  v_open     text;
  v_status   text;
  v_expires  timestamptz;

  -- helper snapshot for the current claims: staff, admin, manager, cash
  v_s boolean; v_a boolean; v_m boolean; v_c boolean;
BEGIN
  IF (SELECT count(*) FROM public.user_roles
       WHERE user_email IN (v_admin, v_mgr, v_tech, v_rep, v_viewer)
         AND public.rma_access_is_current(status, access_expires_at)) <> 5 THEN
    RAISE EXCEPTION 'Test prerequisite missing: the five seeded users from 20260706 must exist and be active.';
  END IF;

  -- ── CHECK 1: a caller with NO user_roles row gets false from every helper,
  --            never NULL ──
  v_checks := v_checks + 1;
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_nobody, 'role', 'authenticated')::text, true);
  v_s := public.rma_is_staff(); v_a := public.rma_is_admin(); v_m := public.rma_is_manager_or_above(); v_c := public.rma_can_handle_cash();
  IF v_s IS DISTINCT FROM false OR v_a IS DISTINCT FROM false OR v_m IS DISTINCT FROM false OR v_c IS DISTINCT FROM false THEN
    v_failures := array_append(v_failures, format('CHECK 1 (no role row → false): staff=%s admin=%s mgr=%s cash=%s', v_s, v_a, v_m, v_c));
  END IF;

  -- ── CHECK 2: …and is refused by guarded RPCs of every guard shape ──
  --   bare helper guard / staff-and-not-viewer guard / helper-OR-role guard
  v_checks := v_checks + 1;
  BEGIN
    PERFORM public.rma_staff_directory();
    v_failures := array_append(v_failures, 'CHECK 2 (no role row refused): rma_staff_directory answered');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%not authorized%' THEN
      v_failures := array_append(v_failures, 'CHECK 2: rma_staff_directory failed for another reason — ' || SQLERRM);
    END IF;
  END;
  BEGIN
    PERFORM public.transfer_stock(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), NULL, gen_random_uuid(), NULL);
    v_failures := array_append(v_failures, 'CHECK 2 (no role row refused): transfer_stock was not refused');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%not authorized%' THEN
      v_failures := array_append(v_failures, 'CHECK 2: transfer_stock failed for another reason — ' || SQLERRM);
    END IF;
  END;
  BEGIN
    PERFORM public.move_rma_units(gen_random_uuid(), '[]'::jsonb, NULL);
    v_failures := array_append(v_failures, 'CHECK 2 (no role row refused): move_rma_units was not refused');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%not authorized%' THEN
      v_failures := array_append(v_failures, 'CHECK 2: move_rma_units failed for another reason — ' || SQLERRM);
    END IF;
  END;
  BEGIN
    PERFORM public.cancel_sales_order(gen_random_uuid(), NULL);
    v_failures := array_append(v_failures, 'CHECK 2 (no role row refused): cancel_sales_order was not refused');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%not authorized%' THEN
      v_failures := array_append(v_failures, 'CHECK 2: cancel_sales_order failed for another reason — ' || SQLERRM);
    END IF;
  END;
  BEGIN
    PERFORM public.convert_quotation_to_so(gen_random_uuid(), NULL);
    v_failures := array_append(v_failures, 'CHECK 2 (no role row refused): convert_quotation_to_so was not refused');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%not authorized%' THEN
      v_failures := array_append(v_failures, 'CHECK 2: convert_quotation_to_so failed for another reason — ' || SQLERRM);
    END IF;
  END;

  -- ── CHECK 3: a SUSPENDED manager is refused like a stranger ──
  --   The live case: suspension is recorded in user_roles and does not end a
  --   session that is already open.
  v_checks := v_checks + 1;
  SELECT status INTO v_status FROM public.user_roles WHERE user_email = v_mgr;
  UPDATE public.user_roles SET status = 'suspended' WHERE user_email = v_mgr;
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);
  IF public.rma_is_manager_or_above() IS DISTINCT FROM false OR public.rma_is_staff() IS DISTINCT FROM false THEN
    v_failures := array_append(v_failures, 'CHECK 3 (suspended manager): a helper did not return false');
  END IF;
  BEGIN
    PERFORM public.transfer_stock(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), NULL, gen_random_uuid(), NULL);
    v_failures := array_append(v_failures, 'CHECK 3 (suspended manager): transfer_stock was not refused');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%not authorized%' THEN
      v_failures := array_append(v_failures, 'CHECK 3: transfer_stock failed for another reason — ' || SQLERRM);
    END IF;
  END;
  UPDATE public.user_roles SET status = v_status WHERE user_email = v_mgr;

  -- ── CHECK 4: an EXPIRED admin is refused too ──
  v_checks := v_checks + 1;
  SELECT access_expires_at INTO v_expires FROM public.user_roles WHERE user_email = v_admin;
  UPDATE public.user_roles SET access_expires_at = now() - interval '1 day' WHERE user_email = v_admin;
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_admin, 'role', 'authenticated')::text, true);
  IF public.rma_is_admin() IS DISTINCT FROM false OR public.rma_is_manager_or_above() IS DISTINCT FROM false THEN
    v_failures := array_append(v_failures, 'CHECK 4 (expired admin): a helper did not return false');
  END IF;
  UPDATE public.user_roles SET access_expires_at = v_expires WHERE user_email = v_admin;

  -- ── CHECK 5: every real role keeps exactly what it had ──
  v_checks := v_checks + 1;
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_admin, 'role', 'authenticated')::text, true);
  v_s := public.rma_is_staff(); v_a := public.rma_is_admin(); v_m := public.rma_is_manager_or_above(); v_c := public.rma_can_handle_cash();
  IF NOT (v_s AND v_a AND v_m AND v_c) THEN
    v_failures := array_append(v_failures, format('CHECK 5 (admin): staff=%s admin=%s mgr=%s cash=%s — want all true', v_s, v_a, v_m, v_c));
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);
  v_s := public.rma_is_staff(); v_a := public.rma_is_admin(); v_m := public.rma_is_manager_or_above(); v_c := public.rma_can_handle_cash();
  IF NOT (v_s AND NOT v_a AND v_m AND v_c) THEN
    v_failures := array_append(v_failures, format('CHECK 5 (manager): staff=%s admin=%s mgr=%s cash=%s — want t/f/t/t', v_s, v_a, v_m, v_c));
  END IF;

  FOREACH v_status IN ARRAY ARRAY[v_tech, v_rep, v_viewer] LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_status, 'role', 'authenticated')::text, true);
    v_s := public.rma_is_staff(); v_a := public.rma_is_admin(); v_m := public.rma_is_manager_or_above(); v_c := public.rma_can_handle_cash();
    IF NOT (v_s AND NOT v_a AND NOT v_m AND NOT v_c) THEN
      v_failures := array_append(v_failures, format('CHECK 5 (%s): staff=%s admin=%s mgr=%s cash=%s — want t/f/f/f', v_status, v_s, v_a, v_m, v_c));
    END IF;
  END LOOP;

  PERFORM set_config('request.jwt.claims', '', true);

  -- ── CHECK 6: no SECURITY DEFINER function guards on an unwrapped direct
  --            role comparison — catches a later migration re-declaring one
  --            of these bodies from an old copy ──
  v_checks := v_checks + 1;
  SELECT string_agg(p.proname, ', ') INTO v_open
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef
     AND pg_get_functiondef(p.oid) ~ 'IF\s+NOT\s+\((?:[^;])*?rma_user_role\(\)(?:[^;])*?\)\s+THEN';
  IF v_open IS NOT NULL THEN
    v_failures := array_append(v_failures, 'CHECK 6 (no unwrapped role guard): ' || v_open);
  END IF;

  -- ── CHECK 7: no RLS policy negates or compares a helper. The NULL -> false
  --            change was only safe because none did; a policy that starts
  --            to would be widened for role-less callers ──
  v_checks := v_checks + 1;
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO v_open
    FROM pg_policies
   WHERE coalesce(qual, '') || ' ' || coalesce(with_check, '')
         ~* '(not\s*\(?\s*(public\.)?rma_(is_[a-z_]+|can_handle_cash)\(\)|rma_(is_[a-z_]+|can_handle_cash)\(\)\s*(is|=|<>|!=))';
  IF v_open IS NOT NULL THEN
    v_failures := array_append(v_failures, 'CHECK 7 (no policy negates a helper): ' || v_open);
  END IF;

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % role-guard check(s) FAILED:\n%',
      array_length(v_failures, 1), v_checks, array_to_string(v_failures, E'\n');
  END IF;

  RAISE NOTICE 'All % role-guard checks passed', v_checks;
END $$;
