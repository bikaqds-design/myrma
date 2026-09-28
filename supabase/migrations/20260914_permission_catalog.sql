-- ============================================================================
-- 20260914_permission_catalog.sql
-- W6 / S-01 — the permission matrix is enforced by the database.
-- ============================================================================
-- Until now permissions lived in the browser only. user_roles.permissions holds
-- per-user overrides that canDo() reads, and ROLE_DEFAULT_PERMISSIONS
-- (src/lib/permissions.ts) the defaults, but the database enforced roles alone
-- (rma_is_manager_or_above() and the like). An administrator could switch
-- "post invoices" off for one manager in User Management and the screen would
-- hide the button, while the same manager could still post through the API.
--
--   * permission_catalog — every action the database now enforces, the roles
--     that have it by default and the functions that check it. Readable by
--     staff; written only by migrations. The defaults are what each role can do
--     in the app today (its role guard, narrowed to what the screens offer), so
--     nobody loses access they have; src/test/serverPermissionCatalog.test.js fails
--     CI if they drift from ROLE_DEFAULT_PERMISSIONS.
--   * rma_has_permission(section, action) — resolvePermissions() in SQL:
--     administrators always; otherwise the user's stored override when it is a
--     real boolean, else a custom role's own map, else the catalog default.
--   * rma_require_permission(section, action) — called first in each catalogued
--     function (inserted after the body's opening BEGIN in its live definition,
--     each insertion counted). It refuses with 42501 "Not authorized: …". A call
--     with no login (the database itself, a service job) is left to the
--     function's own guard. The role guards stay: a permission can only narrow
--     what a role may do, never widen it.
--
-- Pinned by src/test/serverPermissionCatalog.test.js; supabase/tests/
-- permission_catalog.sql is the rolled-back reference script.
-- ============================================================================

-- ── 1. the catalog ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.permission_catalog (
  section       text NOT NULL,
  action        text NOT NULL,
  label         text NOT NULL,
  default_roles text[] NOT NULL DEFAULT '{}',
  functions     text[] NOT NULL,
  PRIMARY KEY (section, action),
  CHECK (default_roles <@ ARRAY['manager', 'accountant', 'technician', 'viewer', 'sales_rep']::text[]),
  CHECK (cardinality(functions) > 0)
);
COMMENT ON TABLE public.permission_catalog IS
  'Actions the database enforces (S-01, 20260914): default roles and the functions that check them. Written only by migrations.';

ALTER TABLE public.permission_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.permission_catalog FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.permission_catalog FROM authenticated;
GRANT SELECT ON TABLE public.permission_catalog TO authenticated;
GRANT ALL ON TABLE public.permission_catalog TO service_role;
DROP POLICY IF EXISTS "read_permission_catalog" ON public.permission_catalog;
CREATE POLICY "read_permission_catalog" ON public.permission_catalog FOR SELECT USING (COALESCE(public.rma_is_staff(), false));

INSERT INTO public.permission_catalog (section, action, label, default_roles, functions) VALUES
  ('sales', 'post', 'post invoices', '{manager}', '{post_invoice}'),
  ('sales', 'void', 'void invoices and credit notes', '{manager}', '{void_invoice,void_credit_note}'),
  ('sales', 'cancel', 'cancel sales orders', '{manager}', '{cancel_sales_order}'),
  ('sales', 'approve', 'approve sales orders', '{manager}', '{approve_sales_order}'),
  ('sales', 'issue_credit', 'issue credit notes', '{manager}', '{issue_credit_note,submit_credit_note_for_approval}'),
  ('sales', 'deliver', 'ship deliveries', '{manager}', '{create_delivery,confirm_delivery,cancel_delivery}'),
  ('sales', 'return', 'take customer returns', '{manager}', '{create_customer_return,confirm_customer_return,cancel_customer_return,create_credit_note_from_return}'),
  ('accounting', 'record_payment', 'record payments', '{manager,accountant}',
    '{record_payment,apply_payment_to_invoice,apply_credit_note_to_invoice,record_vendor_payment,apply_vendor_payment_to_invoice}'),
  ('accounting', 'reverse_payment', 'reverse payments', '{manager,accountant}',
    '{void_payment,reverse_payment_application,reverse_credit_note_application,void_vendor_payment,reverse_vendor_payment_application}'),
  ('accounting', 'refund', 'record refunds', '{manager}', '{record_customer_refund,reject_customer_refund}'),
  ('accounting', 'approve_refund', 'approve refunds', '{manager}', '{approve_customer_refund}'),
  ('accounting', 'approve_payment', 'approve supplier payments', '{manager}', '{approve_vendor_payment}'),
  ('accounting', 'close_period', 'close accounting periods', '{accountant}',
    '{soft_close_accounting_period,close_accounting_period,reopen_soft_closed_period,request_period_reopen}'),
  ('purchasing', 'receive', 'receive goods', '{manager}', '{create_goods_receipt,confirm_goods_receipt,cancel_goods_receipt,receive_vendor_invoice}'),
  ('purchasing', 'amend', 'amend confirmed purchase orders', '{manager}', '{amend_purchase_order}'),
  ('inventory', 'transfer', 'transfer stock', '{manager}', '{transfer_stock,transfer_units}'),
  ('inventory', 'adjust', 'adjust stock', '{manager}', '{adjust_stock}'),
  ('inventory', 'receive', 'receive stock without a purchase order', '{manager}', '{receive_stock}'),
  ('inventory', 'manage_warehouses', 'archive warehouses', '{manager}', '{archive_warehouse}')
ON CONFLICT (section, action) DO UPDATE
   SET label = EXCLUDED.label, default_roles = EXCLUDED.default_roles, functions = EXCLUDED.functions;

-- ── 2. the check ─────────────────────────────────────────────────────────────
-- resolvePermissions() + canDo() in SQL. user_roles.permissions only ever
-- overrides with a real JSON boolean; anything else reads as "not set".
CREATE OR REPLACE FUNCTION public.rma_has_permission(p_section text, p_action text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  WITH me AS (
    SELECT ur.role, ur.permissions, cr.permissions AS custom_defaults
      FROM public.user_roles ur
      LEFT JOIN public.custom_roles cr ON cr.role_name = ur.role
     WHERE ur.user_email = (auth.jwt() ->> 'email')
       AND public.rma_access_is_current(ur.status, ur.access_expires_at)
     LIMIT 1
  )
  SELECT CASE
    WHEN COALESCE(public.rma_is_admin(), false) THEN true
    ELSE COALESCE((
      SELECT CASE
               WHEN jsonb_typeof(me.permissions -> p_section -> p_action) = 'boolean'
                 THEN (me.permissions -> p_section ->> p_action)::boolean
               WHEN me.custom_defaults IS NOT NULL
                 THEN jsonb_typeof(me.custom_defaults -> p_section -> p_action) = 'boolean'
                      AND (me.custom_defaults -> p_section ->> p_action)::boolean
               ELSE me.role = ANY (c.default_roles)
             END
        FROM me JOIN public.permission_catalog c ON c.section = p_section AND c.action = p_action), false)
  END
$fn$;

CREATE OR REPLACE FUNCTION public.rma_require_permission(p_section text, p_action text)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_label text;
BEGIN
  SELECT label INTO v_label FROM public.permission_catalog WHERE section = p_section AND action = p_action;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown permission %.%', p_section, p_action;
  END IF;
  -- no login: the database itself or a service job — the function's own guard decides
  IF public.rma_current_user_email() IS NULL THEN
    RETURN;
  END IF;
  IF NOT COALESCE(public.rma_has_permission(p_section, p_action), false) THEN
    RAISE EXCEPTION 'Not authorized: you do not have permission to %.', v_label USING ERRCODE = 'insufficient_privilege';
  END IF;
END $fn$;

REVOKE ALL ON FUNCTION public.rma_has_permission(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_has_permission(text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.rma_require_permission(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rma_require_permission(text, text) TO service_role;

-- ── 3. every catalogued function checks it first ─────────────────────────────
DO $$
DECLARE
  r      record;
  f      text;
  v_oid  oid;
  v_def  text;
  v_new  text;
  v_call text;
BEGIN
  FOR r IN SELECT section, action, functions FROM public.permission_catalog LOOP
    FOREACH f IN ARRAY r.functions LOOP
      SELECT p.oid INTO v_oid FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f;
      IF NOT FOUND OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f) <> 1 THEN
        RAISE EXCEPTION 'Refusing to apply: % is missing or overloaded', f;
      END IF;
      v_call := format('PERFORM public.rma_require_permission(%L, %L);', r.section, r.action);
      v_def := replace(pg_get_functiondef(v_oid), E'\r\n', E'\n');
      CONTINUE WHEN position('rma_require_permission(' IN v_def) > 0;   -- already done
      IF (SELECT l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = v_oid) <> 'plpgsql' THEN
        RAISE EXCEPTION 'Refusing to apply: % is not plpgsql', f;
      END IF;
      -- the body's first line that is exactly BEGIN opens its outer block
      -- (a DECLARE section cannot contain one)
      IF v_def !~ E'\nBEGIN\n' THEN
        RAISE EXCEPTION 'Refusing to apply: % has no BEGIN line', f;
      END IF;
      v_new := regexp_replace(v_def, E'\nBEGIN\n', E'\nBEGIN\n  ' || v_call || E'\n');   -- first only
      IF (length(v_new) - length(replace(v_new, v_call, ''))) / length(v_call) <> 1 THEN
        RAISE EXCEPTION 'Refusing to apply: % does not read as expected', f;
      END IF;
      EXECUTE v_new;
    END LOOP;
  END LOOP;
END $$;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(f, ', ') INTO v_missing
    FROM public.permission_catalog c, unnest(c.functions) f
   WHERE position(format('rma_require_permission(%L, %L)', c.section, c.action)
                  IN (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
                       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f)) = 0;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to finish: % do not check their permission', v_missing;
  END IF;
  IF has_function_privilege('anon', 'public.rma_has_permission(text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_require_permission(text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rma_require_permission(text, text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.permission_catalog', 'INSERT') THEN
    RAISE EXCEPTION 'Refusing to finish: the permission functions or the catalog are open to the wrong role';
  END IF;
END $$;
