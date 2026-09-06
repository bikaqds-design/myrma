-- Verifies 20260819_stop_viewer_writes.sql (BUG-011).
--
-- A lockdown is only correct if it closes the hole AND leaves the real work
-- alone, so this checks both directions: the viewer must be refused, and a
-- technician / admin must still be able to do their job.
--
-- Everything runs inside a transaction aborted by the closing RAISE, so nothing
-- here can change production. Read the VERDICT in the error message.
--
-- NOTE on measuring the notifications hole: use a LITERAL assignment.
-- `UPDATE notifications SET title = title` reads the column, which pulls in the
-- SELECT policy and returns 0 rows even when the UPDATE policy is wide open.

DO $verify$
DECLARE
  v_out   text := E'\n';
  v_pass  integer := 0;
  v_fail  integer := 0;
  v_viewer text; v_tech text; v_admin text; v_rep text;
  v_tkt uuid; v_n integer; v_created text;
BEGIN
  SELECT user_email INTO v_viewer FROM public.user_roles WHERE role='viewer'      AND status='active' LIMIT 1;
  SELECT user_email INTO v_tech   FROM public.user_roles WHERE role='technician'  AND status='active' LIMIT 1;
  SELECT user_email INTO v_admin  FROM public.user_roles WHERE role='admin'       AND status='active' LIMIT 1;
  SELECT user_email INTO v_rep    FROM public.user_roles WHERE role='sales_rep'   AND status='active' LIMIT 1;
  SELECT id INTO v_tkt FROM public.rma_tickets LIMIT 1;

  v_out := v_out || format('viewer=%s tech=%s admin=%s rep=%s%s',
                           v_viewer, v_tech, v_admin, v_rep, E'\n');

  PERFORM set_config('role','authenticated', true);

  ---------------------------------------------------------------------------
  -- A. The viewer must now be refused everywhere
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_viewer, 'role','authenticated')::text, true);

  UPDATE public.notifications SET title = 'PROBE';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN v_pass := v_pass + 1;
    v_out := v_out || format('PASS  viewer UPDATE notifications (literal): 0 rows%s', E'\n');
  ELSE v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  viewer UPDATE notifications still affected %s rows%s', v_n, E'\n');
  END IF;

  BEGIN
    INSERT INTO public.ticket_resolutions (ticket_id, type, created_by, reason, amount, currency)
    VALUES (v_tkt, 'refund', v_viewer, 'PROBE', 9999, 'EGP');
    v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  viewer INSERT ticket_resolutions was ALLOWED%s', E'\n');
  EXCEPTION WHEN insufficient_privilege THEN
    v_pass := v_pass + 1;
    v_out := v_out || format('PASS  viewer INSERT ticket_resolutions refused (42501)%s', E'\n');
  END;

  UPDATE public.rma_config SET config_value = config_value WHERE config_key='appearance_settings';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN v_pass := v_pass + 1;
    v_out := v_out || format('PASS  viewer UPDATE rma_config appearance: 0 rows%s', E'\n');
  ELSE v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  viewer UPDATE rma_config appearance affected %s rows%s', v_n, E'\n');
  END IF;

  BEGIN
    INSERT INTO public.notifications (type, title, message, created_by, target_roles)
    VALUES ('custom_alert','PROBE','PROBE','someone-else@example.com', ARRAY['super_admin']);
    v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  viewer INSERT notifications was ALLOWED%s', E'\n');
  EXCEPTION WHEN insufficient_privilege THEN
    v_pass := v_pass + 1;
    v_out := v_out || format('PASS  viewer INSERT notifications refused (42501)%s', E'\n');
  END;

  ---------------------------------------------------------------------------
  -- B. sales_rep is excluded from resolutions (owner's decision) but is
  --    otherwise still staff
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_rep, 'role','authenticated')::text, true);
  BEGIN
    INSERT INTO public.ticket_resolutions (ticket_id, type, created_by, reason)
    VALUES (v_tkt, 'exchange', v_rep, 'PROBE');
    v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  sales_rep INSERT ticket_resolutions was ALLOWED%s', E'\n');
  EXCEPTION WHEN insufficient_privilege THEN
    v_pass := v_pass + 1;
    v_out := v_out || format('PASS  sales_rep INSERT ticket_resolutions refused (42501)%s', E'\n');
  END;

  ---------------------------------------------------------------------------
  -- C. The real work must still succeed
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_tech, 'role','authenticated')::text, true);

  BEGIN
    INSERT INTO public.ticket_resolutions (ticket_id, type, created_by, reason)
    VALUES (v_tkt, 'replacement', 'forged@example.com', 'PROBE')
    RETURNING created_by INTO v_created;
    v_pass := v_pass + 1;
    v_out := v_out || format('PASS  technician INSERT ticket_resolutions allowed%s', E'\n');
    IF v_created = v_tech THEN v_pass := v_pass + 1;
      v_out := v_out || format('PASS  created_by stamped to the actor (%s), forged value discarded%s',
                               v_created, E'\n');
    ELSE v_fail := v_fail + 1;
      v_out := v_out || format('FAIL  created_by kept the forged value: %s%s', v_created, E'\n');
    END IF;
  EXCEPTION WHEN others THEN
    v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  technician INSERT ticket_resolutions refused (%s) - fix is too tight%s',
                             SQLSTATE, E'\n');
  END;

  BEGIN
    INSERT INTO public.notifications (type, title, message, created_by, target_roles)
    VALUES ('ticket_status_changed','PROBE','PROBE','forged@example.com', ARRAY['admin','manager'])
    RETURNING created_by INTO v_created;
    v_pass := v_pass + 1;
    v_out := v_out || format('PASS  technician INSERT notifications targeting admin/manager allowed%s', E'\n');
    IF v_created = v_tech THEN v_pass := v_pass + 1;
      v_out := v_out || format('PASS  notification created_by stamped to the actor (%s)%s', v_created, E'\n');
    ELSE v_fail := v_fail + 1;
      v_out := v_out || format('FAIL  notification created_by kept forged value: %s%s', v_created, E'\n');
    END IF;
  EXCEPTION WHEN others THEN
    v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  technician INSERT notifications refused (%s) - would break ticket alerts%s',
                             SQLSTATE, E'\n');
  END;

  -- Staff must still READ the branding, or every page loses its favicon/title.
  SELECT count(*) INTO v_n FROM public.rma_config WHERE config_key='appearance_settings';
  IF v_n > 0 THEN v_pass := v_pass + 1;
    v_out := v_out || format('PASS  technician can still READ appearance_settings%s', E'\n');
  ELSE v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  appearance_settings unreadable - branding will break%s', E'\n');
  END IF;

  -- Admin must still be able to change the branding.
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_admin, 'role','authenticated')::text, true);
  UPDATE public.rma_config SET config_value = config_value WHERE config_key='appearance_settings';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_pass := v_pass + 1;
    v_out := v_out || format('PASS  admin UPDATE rma_config appearance still allowed (%s row)%s', v_n, E'\n');
  ELSE v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  admin can no longer edit appearance - Branding screen is broken%s', E'\n');
  END IF;

  PERFORM set_config('role','postgres', true);
  v_out := v_out || format('%s%s passed, %s failed.%s', E'\n', v_pass, v_fail, E'\n');

  RAISE EXCEPTION 'VERDICT :: %', v_out;
END
$verify$;
