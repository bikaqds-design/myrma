-- Make every role guard fail CLOSED for a caller with no current role.
-- (Audit finding BUG-087.)
--
-- ── The defect ───────────────────────────────────────────────────────────────
--
-- rma_user_role() looks the caller up in user_roles and keeps only a CURRENT
-- row (rma_access_is_current: active and not expired). A suspended or expired
-- account, or an auth account with no user_roles row at all, gets NULL back —
-- not a role, and not an error.
--
-- The helpers are `SELECT rma_user_role() IN (…)`, and `NULL IN (…)` is NULL.
-- Everything then depends on where the helper is used:
--
--   * In an RLS policy, NULL means "no". The policy fails closed. Safe.
--   * In plpgsql, `IF NOT public.rma_is_manager_or_above() THEN RAISE …` is an
--     IF on `NOT NULL`, which is NULL, and an IF on NULL does not fire. The
--     guard raises nothing and execution falls into the body. It fails OPEN.
--
-- Measured on production 2026-09-16: a caller with an auth identity and no
-- current role got all 17 rows out of the manager-only rma_staff_directory().
-- Production holds 10 suspended user_roles rows and at least one auth account
-- with no role row, and suspension does not by itself end a live session.
--
-- ── The fix, and why it is shaped this way ───────────────────────────────────
--
-- 1. The four helpers return false instead of NULL. That closes every guard of
--    the form `IF NOT helper() THEN` (~34 SECURITY DEFINER functions) in one
--    place, and `helper() AND rma_user_role() <> 'viewer'` along with it,
--    because `false AND NULL` is false.
--
--    Checked before writing this, not assumed: NULL -> false can only change an
--    outcome where a helper is NEGATED, COMPARED or NULL-TESTED for a positive
--    purpose. No RLS policy does any of those (every policy uses the helpers
--    positively, where NULL and false are both "no"), and the only positive
--    function uses are `IF public.rma_is_admin() THEN <allow>` in three trigger
--    guards, where NULL and false both skip the branch. So policies and those
--    triggers behave exactly as before; only the fail-open guards change.
--
--    rma_can_handle_cash() is included because fixing the others does not fix
--    it: `false OR rma_user_role() = 'accountant'` is `false OR NULL`, still NULL.
--
-- 2. Three guards compare rma_user_role() directly, so the helper fix does not
--    reach them — `false OR rma_user_role() = 'sales_rep'` is still NULL:
--    cancel_sales_order, convert_quotation_to_so and crm_convert_lead. Each is
--    wrapped in COALESCE(…, false).
--
--    Four more carry `IF NOT (rma_is_staff() AND rma_user_role() <> 'viewer')`:
--    adjust_part_quantity, create_manufacturer_batch, link_serial_to_rma_ticket
--    and move_rma_units. Step 1 already closes those (`false AND NULL` is
--    false), but they are wrapped as well, so that no guard anywhere depends on
--    a helper's NULL handling — and so the finishing check below can refuse ANY
--    unwrapped role comparison without exceptions to remember.
--
--    All seven are rewritten from their LIVE definitions, replacing only the
--    guard text, rather than re-declared from a copy of an older migration.
--    Several money and funnel functions were amended in place by later
--    migrations; re-typing a whole body is exactly how a fixed bug comes back.
--    Each rewrite must replace exactly the expected number of guards, or the
--    migration refuses.
--
-- rma_user_role() itself is deliberately left returning NULL. Making it return
-- a sentinel such as '' would flip every `rma_user_role() <> 'viewer'` in a
-- policy to TRUE for a role-less caller — the opposite of the goal.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
BEGIN
  IF to_regprocedure('public.rma_user_role()') IS NULL
     OR to_regprocedure('public.rma_is_staff()') IS NULL
     OR to_regprocedure('public.rma_is_admin()') IS NULL
     OR to_regprocedure('public.rma_is_manager_or_above()') IS NULL
     OR to_regprocedure('public.rma_can_handle_cash()') IS NULL THEN
    RAISE EXCEPTION 'Refusing to apply: one of the role helpers is missing.';
  END IF;

  -- The reasoning above rests on no policy negating or comparing a helper. If
  -- one has appeared since this was written, stop and re-check by hand.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE coalesce(qual, '') || ' ' || coalesce(with_check, '')
           ~* '(not\s*\(?\s*(public\.)?rma_(is_[a-z_]+|can_handle_cash)\(\)|rma_(is_[a-z_]+|can_handle_cash)\(\)\s*(is|=|<>|!=))'
  ) THEN
    RAISE EXCEPTION 'Refusing to apply: a policy negates or compares a role helper, so NULL -> false could widen it. Review before applying.';
  END IF;
END
$do$;

-- ═══ 1. The helpers return false, never NULL ═════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_is_staff()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$ SELECT COALESCE(public.rma_user_role() IN (
  'super_admin', 'admin', 'manager', 'technician', 'viewer',
  'sales_rep', 'accountant'
), false) $function$;

CREATE OR REPLACE FUNCTION public.rma_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$ SELECT COALESCE(public.rma_user_role() IN ('super_admin', 'admin'), false) $function$;

CREATE OR REPLACE FUNCTION public.rma_is_manager_or_above()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$ SELECT COALESCE(public.rma_user_role() IN ('super_admin', 'admin', 'manager'), false) $function$;

CREATE OR REPLACE FUNCTION public.rma_can_handle_cash()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$ SELECT COALESCE(public.rma_is_manager_or_above()
        OR public.rma_user_role() = 'accountant', false) $function$;

-- ═══ 2. The guards that compare the role directly ═══════════════════════════

DO $do$
DECLARE
  v_fn        record;
  v_def       text;
  v_new       text;
  v_before    integer;
  v_after     integer;
  -- An `IF NOT ( … ) THEN` whose condition mentions rma_user_role(). `[^;]`
  -- keeps a match inside one guard: a guard's condition holds no semicolon,
  -- and every statement between two guards ends in one.
  c_pattern   constant text := 'IF(\s+)NOT(\s+)(\((?:[^;])*?rma_user_role\(\)(?:[^;])*?\))(\s+)THEN';
BEGIN
  FOR v_fn IN
    SELECT p.oid, p.proname, x.expected
      FROM (VALUES ('cancel_sales_order', 1),
                   ('convert_quotation_to_so', 1),
                   ('crm_convert_lead', 1),
                   ('adjust_part_quantity', 1),
                   ('create_manufacturer_batch', 1),
                   ('link_serial_to_rma_ticket', 1),
                   ('move_rma_units', 1)) AS x(name, expected)
      JOIN pg_proc p ON p.proname = x.name
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  LOOP
    v_def := pg_get_functiondef(v_fn.oid);

    SELECT count(*) INTO v_before FROM regexp_matches(v_def, c_pattern, 'g');
    IF v_before <> v_fn.expected THEN
      RAISE EXCEPTION 'Refusing to apply: % has % unwrapped role guard(s), expected %. Its body has changed since this migration was written.',
        v_fn.proname, v_before, v_fn.expected;
    END IF;

    v_new := regexp_replace(v_def, c_pattern, 'IF\1NOT\2COALESCE(\3, false)\4THEN', 'g');

    SELECT count(*) INTO v_after FROM regexp_matches(v_new, c_pattern, 'g');
    IF v_after <> 0 THEN
      RAISE EXCEPTION 'Refusing to apply: % still has % unwrapped role guard(s) after the rewrite.', v_fn.proname, v_after;
    END IF;

    -- CREATE OR REPLACE keeps the owner and the EXECUTE grants.
    EXECUTE v_new;
  END LOOP;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('cancel_sales_order', 'convert_quotation_to_so', 'crm_convert_lead',
                           'adjust_part_quantity', 'create_manufacturer_batch',
                           'link_serial_to_rma_ticket', 'move_rma_units')) <> 7 THEN
    RAISE EXCEPTION 'Refusing to apply: expected exactly one definition each of the seven guarded functions.';
  END IF;
END
$do$;

-- ═══ Guards: the migration refuses to finish if it did not take ══════════════

DO $do$
DECLARE
  v_open text;
BEGIN
  -- 1. As a caller with no current role, every helper is false — not NULL.
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', 'bug-087-guard@invalid.example', 'role', 'authenticated')::text, true);

  IF public.rma_user_role() IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to finish: the guard caller unexpectedly has a role — pick another address.';
  END IF;
  IF public.rma_is_staff() IS DISTINCT FROM false
     OR public.rma_is_admin() IS DISTINCT FROM false
     OR public.rma_is_manager_or_above() IS DISTINCT FROM false
     OR public.rma_can_handle_cash() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Refusing to finish: a role helper still returns something other than false for a caller with no role.';
  END IF;

  PERFORM set_config('request.jwt.claims', '', true);

  -- 2. No SECURITY DEFINER function anywhere still guards on a direct role
  --    comparison without COALESCE — including any added since this was written.
  SELECT string_agg(p.proname, ', ') INTO v_open
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef
     AND pg_get_functiondef(p.oid) ~ 'IF\s+NOT\s+\((?:[^;])*?rma_user_role\(\)(?:[^;])*?\)\s+THEN';
  IF v_open IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to finish: still guarded by an unwrapped role comparison: %', v_open;
  END IF;

  RAISE NOTICE 'BUG-087: role helpers and direct role guards now fail closed.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- supabase/tests/role_guards_fail_closed.sql — the helpers are false (not NULL)
-- for a caller with no role, a suspended caller and an expired caller; they are
-- still true for the roles that should pass; a sample of guarded RPCs refuses a
-- role-less caller with "Not authorized"; cancel_sales_order,
-- convert_quotation_to_so and crm_convert_lead refuse one too.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
-- Restoring the NULL-returning helpers reopens every guard; there is no reason
-- to. If a helper change must be undone, re-create it WITH the COALESCE and
-- change only the role list.
