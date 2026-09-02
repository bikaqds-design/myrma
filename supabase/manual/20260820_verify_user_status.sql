-- Verify 20260786_enforce_user_status.sql.
--
-- Run AFTER applying that migration. Returns one result set; every row must
-- read PASS.
--
-- This is a genuine end-to-end check, not an inspection. It creates one probe
-- user, drives the real rma_user_role() through each status, and removes the
-- row again — including if something raises partway, via the EXCEPTION block.
-- The probe email cannot collide with a real account.
--
-- Why a pg_temp function rather than BEGIN … ROLLBACK: a rollback would
-- discard the results along with the probe row, and the Supabase SQL editor
-- shows only the last statement's output. Collecting into variables and
-- deleting explicitly gives both the cleanup and the report.

CREATE OR REPLACE FUNCTION pg_temp.zz_verify_user_status()
RETURNS TABLE(check_name text, result text, detail text)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_email    text := 'zz-status-probe@example.invalid';
  v_claims   text := '{"email":"zz-status-probe@example.invalid"}';
  v_active   text;
  v_susp     text;
  v_locked   text;
  v_deact    text;
  v_pending  text;
  v_expired  text;
  v_future   text;
  v_custom   text;
  v_domain   text;
  v_hascol   boolean;
  v_fnwired  boolean;
  v_trgwired boolean;
BEGIN
  -- ── structural checks, no data needed ──────────────────────────────────────
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='user_roles'
       AND column_name='access_expires_at'
  ) INTO v_hascol;

  SELECT pg_get_constraintdef(oid) INTO v_domain
    FROM pg_constraint
   WHERE conrelid='public.user_roles'::regclass AND conname='chk_user_status';

  -- Both must call the shared helper. If either stops doing so they can drift
  -- apart, which is the failure this migration was written to avoid.
  SELECT pg_get_functiondef('public.rma_user_role()'::regprocedure)
           LIKE '%rma_access_is_current%' INTO v_fnwired;
  SELECT pg_get_functiondef('public.rma_protect_last_super_admin()'::regprocedure)
           LIKE '%rma_access_is_current%' INTO v_trgwired;

  -- ── end-to-end: drive the real lookup through every status ────────────────
  DELETE FROM public.user_roles WHERE user_email = v_email;
  INSERT INTO public.user_roles (user_email, role, status)
       VALUES (v_email, 'manager', 'active');

  PERFORM set_config('request.jwt.claims', v_claims, true);

  v_active := COALESCE(public.rma_user_role(), 'NULL');

  UPDATE public.user_roles SET status='suspended'   WHERE user_email=v_email;
  v_susp    := COALESCE(public.rma_user_role(), 'NULL');

  UPDATE public.user_roles SET status='locked'      WHERE user_email=v_email;
  v_locked  := COALESCE(public.rma_user_role(), 'NULL');

  UPDATE public.user_roles SET status='deactivated' WHERE user_email=v_email;
  v_deact   := COALESCE(public.rma_user_role(), 'NULL');

  UPDATE public.user_roles SET status='pending'     WHERE user_email=v_email;
  v_pending := COALESCE(public.rma_user_role(), 'NULL');

  -- Active again, but expired in the past.
  UPDATE public.user_roles
     SET status='active', access_expires_at = now() - interval '1 day'
   WHERE user_email=v_email;
  v_expired := COALESCE(public.rma_user_role(), 'NULL');

  -- Active with an expiry still ahead.
  UPDATE public.user_roles
     SET access_expires_at = now() + interval '1 day'
   WHERE user_email=v_email;
  v_future  := COALESCE(public.rma_user_role(), 'NULL');

  -- A custom role must still resolve to its base_role (20260782 preserved).
  SELECT COALESCE(
    (SELECT cr.base_role FROM public.custom_roles cr LIMIT 1), 'no-custom-roles'
  ) INTO v_custom;

  DELETE FROM public.user_roles WHERE user_email = v_email;
  PERFORM set_config('request.jwt.claims', '', true);

  RETURN QUERY
  SELECT * FROM (VALUES
    ('access_expires_at column exists',
     CASE WHEN v_hascol THEN 'PASS' ELSE 'FAIL' END, v_hascol::text),
    ('status domain includes all five UI states',
     CASE WHEN v_domain LIKE '%deactivated%' AND v_domain LIKE '%pending%'
          THEN 'PASS' ELSE 'FAIL' END, COALESCE(v_domain,'no constraint')),
    ('rma_user_role calls rma_access_is_current',
     CASE WHEN v_fnwired THEN 'PASS' ELSE 'FAIL' END, v_fnwired::text),
    ('last-super-admin trigger calls rma_access_is_current',
     CASE WHEN v_trgwired THEN 'PASS' ELSE 'FAIL' END, v_trgwired::text),
    ('active account resolves to its role',
     CASE WHEN v_active = 'manager' THEN 'PASS' ELSE 'FAIL' END, v_active),
    ('suspended account resolves to NULL',
     CASE WHEN v_susp = 'NULL' THEN 'PASS' ELSE 'FAIL' END, v_susp),
    ('locked account resolves to NULL',
     CASE WHEN v_locked = 'NULL' THEN 'PASS' ELSE 'FAIL' END, v_locked),
    ('deactivated account resolves to NULL',
     CASE WHEN v_deact = 'NULL' THEN 'PASS' ELSE 'FAIL' END, v_deact),
    ('pending account resolves to NULL',
     CASE WHEN v_pending = 'NULL' THEN 'PASS' ELSE 'FAIL' END, v_pending),
    ('expired account resolves to NULL',
     CASE WHEN v_expired = 'NULL' THEN 'PASS' ELSE 'FAIL' END, v_expired),
    ('unexpired account resolves to its role',
     CASE WHEN v_future = 'manager' THEN 'PASS' ELSE 'FAIL' END, v_future),
    ('probe row removed',
     CASE WHEN NOT EXISTS (
       SELECT 1 FROM public.user_roles WHERE user_email = v_email
     ) THEN 'PASS' ELSE 'FAIL' END, v_email),
    ('custom roles still resolve to a base_role',
     'INFO', v_custom)
  ) AS t(check_name, result, detail);

EXCEPTION WHEN OTHERS THEN
  -- Never leave the probe row behind, whatever went wrong.
  DELETE FROM public.user_roles WHERE user_email = v_email;
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE;
END
$fn$;

SELECT * FROM pg_temp.zz_verify_user_status();
