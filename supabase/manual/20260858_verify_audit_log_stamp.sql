-- Verifies 20260821_stamp_audit_log_actor.sql (BUG-019).
--
-- Three things must hold together: forgery is rewritten, honest writes are
-- untouched, and server-side callers keep their own actor. Everything runs
-- inside a transaction aborted by the closing RAISE, so the probe rows below
-- never persist. Read the VERDICT in the error message.
--
-- NOTE: user_activity_log.action_details is JSON, not text — a bare string
-- literal fails with 22P02. Probe rows use '"probe"' and are identified by
-- action_type instead.

DO $verify$
DECLARE
  v_out text := E'\n'; v_pass int := 0; v_fail int := 0;
  v_viewer text; v_admin text; v_stored text; v_n integer;
BEGIN
  SELECT user_email INTO v_viewer FROM public.user_roles WHERE role='viewer' AND status='active' LIMIT 1;
  SELECT user_email INTO v_admin  FROM public.user_roles WHERE role='admin'  AND status='active' LIMIT 1;

  PERFORM set_config('role','authenticated', true);

  ---------------------------------------------------------------------------
  -- 1. The exact forgery from the finding: a viewer framing an admin
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_viewer, 'role','authenticated')::text, true);
  INSERT INTO public.user_activity_log (user_email, action_type, action_details, created_date)
  VALUES (v_admin, 'PROBE_FORGERY', '"probe"', now());

  PERFORM set_config('role','postgres', true);
  SELECT user_email INTO v_stored FROM public.user_activity_log
   WHERE action_type='PROBE_FORGERY' ORDER BY created_date DESC LIMIT 1;
  IF v_stored = v_viewer THEN v_pass := v_pass + 1;
    v_out := v_out || format('PASS  forged actor rewritten: submitted %s, stored %s%s',
                             v_admin, v_stored, E'\n');
  ELSE v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  forgery survived: stored %s%s', v_stored, E'\n');
  END IF;

  ---------------------------------------------------------------------------
  -- 2. An honest write is accepted and unchanged
  ---------------------------------------------------------------------------
  PERFORM set_config('role','authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_admin, 'role','authenticated')::text, true);
  INSERT INTO public.user_activity_log (user_email, action_type, action_details, created_date)
  VALUES (v_admin, 'PROBE_HONEST', '"probe"', now());
  GET DIAGNOSTICS v_n = ROW_COUNT;

  PERFORM set_config('role','postgres', true);
  SELECT user_email INTO v_stored FROM public.user_activity_log
   WHERE action_type='PROBE_HONEST' ORDER BY created_date DESC LIMIT 1;
  IF v_n = 1 AND v_stored = v_admin THEN v_pass := v_pass + 1;
    v_out := v_out || format('PASS  honest write accepted and unchanged (%s)%s', v_stored, E'\n');
  ELSE v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  honest write broken: rows=%s stored=%s%s', v_n, v_stored, E'\n');
  END IF;

  ---------------------------------------------------------------------------
  -- 3. Server-side callers carry no JWT and keep their own actor
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO public.user_activity_log (user_email, action_type, action_details, created_date)
  VALUES ('system', 'PROBE_SERVER', '"probe"', now());
  SELECT user_email INTO v_stored FROM public.user_activity_log
   WHERE action_type='PROBE_SERVER' ORDER BY created_date DESC LIMIT 1;
  IF v_stored = 'system' THEN v_pass := v_pass + 1;
    v_out := v_out || format('PASS  server-side write (no JWT) kept its actor (%s)%s', v_stored, E'\n');
  ELSE v_fail := v_fail + 1;
    v_out := v_out || format('FAIL  server-side write rewritten to %s%s', v_stored, E'\n');
  END IF;

  v_out := v_out || format('%s%s passed, %s failed.%s', E'\n', v_pass, v_fail, E'\n');
  RAISE EXCEPTION 'VERDICT :: %', v_out;
END
$verify$;
