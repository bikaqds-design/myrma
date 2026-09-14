-- BUG-073: payments, their applications and warehouse stock are written only
-- through the database procedures. Direct client writes are removed.
--
-- ── Why this is safe, measured before writing it (2026-09-14) ─────────────────
--
--   * The app never writes these tables directly. Every reference in src/ is a
--     read; payments, applications and stock changes all go through RPCs
--     (record_payment, apply_payment_to_invoice, void_payment, receive_stock,
--     transfer_stock, …).
--   * Every function that writes them is SECURITY DEFINER — 21 procedures and
--     the trg_sync_payment_balance trigger — so they run with the owner's rights
--     and do not depend on the caller's grants or policies. None runs as INVOKER.
--   * The backup restore (rma_restore_apply) is SECURITY DEFINER too.
--
-- ── What was there ────────────────────────────────────────────────────────────
--
--   Admin-only INSERT/UPDATE/DELETE policies on payments and the three
--   application tables (narrowed by BUG-001), a manager ALL policy on
--   warehouse_stock — and, underneath, table grants giving `authenticated`
--   INSERT, UPDATE, DELETE and TRUNCATE. TRUNCATE ignores row-level security
--   entirely. PostgREST cannot issue it, so it was not reachable through the app,
--   but no client role had any reason to hold it.
--
-- The procedures are where the ledger rules live — balances kept in step,
-- reversals recorded rather than rows deleted, stock moved with a history. A
-- direct write skips all of that, even from an administrator with API access.
-- After this, it cannot happen.
--
-- Read access is unchanged: every SELECT policy stays, and the manager ALL
-- policy's read half on warehouse_stock is already covered by the staff read
-- policy (managers are staff).

DO $do$
DECLARE v_invoker text;
BEGIN
  -- Refuse if any function writing these tables would lose its access.
  SELECT string_agg(DISTINCT p.proname, ', ') INTO v_invoker
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f' AND NOT p.prosecdef
     AND pg_get_functiondef(p.oid) ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?(payments|payment_applications|credit_note_applications|vendor_payment_applications|warehouse_stock)\y';
  IF v_invoker IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to apply: these functions write the tables without SECURITY DEFINER and would break: %', v_invoker;
  END IF;
END
$do$;

-- ═══ Grants: read only ═══════════════════════════════════════════════════════

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON public.payments, public.payment_applications, public.credit_note_applications,
     public.vendor_payment_applications, public.warehouse_stock
  FROM authenticated, anon, PUBLIC;

-- ═══ Policies: drop the write ones ═══════════════════════════════════════════

DROP POLICY IF EXISTS admin_insert_payments ON public.payments;
DROP POLICY IF EXISTS admin_update_payments ON public.payments;
DROP POLICY IF EXISTS admin_delete_payments ON public.payments;

DROP POLICY IF EXISTS admin_insert_payment_applications ON public.payment_applications;
DROP POLICY IF EXISTS admin_delete_payment_applications ON public.payment_applications;

DROP POLICY IF EXISTS admin_insert_cn_applications ON public.credit_note_applications;
DROP POLICY IF EXISTS admin_delete_cn_applications ON public.credit_note_applications;

DROP POLICY IF EXISTS admin_insert_vendor_payment_applications ON public.vendor_payment_applications;
DROP POLICY IF EXISTS admin_delete_vendor_payment_applications ON public.vendor_payment_applications;

DROP POLICY IF EXISTS manager_write_warehouse_stock ON public.warehouse_stock;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payments', 'payment_applications', 'credit_note_applications',
                           'vendor_payment_applications', 'warehouse_stock'] LOOP
    IF has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || t, 'DELETE')
       OR has_table_privilege('authenticated', 'public.' || t, 'TRUNCATE') THEN
      RAISE EXCEPTION 'Refusing to finish: authenticated can still write %.', t;
    END IF;
    IF NOT has_table_privilege('authenticated', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'Refusing to finish: authenticated lost read access to %.', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND cmd IN ('SELECT', 'ALL')) THEN
      RAISE EXCEPTION 'Refusing to finish: % has no read policy left.', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')) THEN
      RAISE EXCEPTION 'Refusing to finish: % still has a write policy.', t;
    END IF;
  END LOOP;
  RAISE NOTICE 'BUG-073: payments, applications and warehouse stock are procedure-only.';
END
$do$;

-- ─── Rollback ────────────────────────────────────────────────────────────────
--   GRANT INSERT, UPDATE, DELETE ON <tables> TO authenticated;
--   and recreate the admin/manager write policies from 20260801 and earlier.
--   Not needed by the app, which never wrote these tables directly.
