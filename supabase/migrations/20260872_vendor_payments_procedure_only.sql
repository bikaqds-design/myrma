-- BUG-073 follow-up: vendor_payments is written only through the database
-- procedures, like its customer-side twin `payments`.
--
-- ── What was missed ──────────────────────────────────────────────────────────
--
-- 20260850 made payments, the three application tables and warehouse_stock
-- procedure-only. vendor_payments was not in its list, so on 2026-09-17 it still
-- had admin INSERT/UPDATE/DELETE policies and `authenticated` still held INSERT,
-- UPDATE, DELETE and TRUNCATE. An administrator with API access could create a
-- vendor payment with no VP- number and no allocation checks, change its amount
-- after it was applied (unapplied_amount is kept by the application trigger, not
-- by edits to the payment), or delete one that invoices had been paid from.
--
-- ── Why this is safe, measured before writing it ─────────────────────────────
--
--   * The app never writes vendor_payments directly: src/api/db/vendorPayments.ts
--     only reads it; recording and voiding go through record_vendor_payment and
--     void_vendor_payment.
--   * Every function that writes it — record_vendor_payment, void_vendor_payment,
--     sync_vendor_payment_balance — is SECURITY DEFINER, and so is the backup
--     restore (rma_restore_apply). The migration refuses to apply otherwise.
--
-- Read access is unchanged.

DO $do$
DECLARE v_invoker text;
BEGIN
  SELECT string_agg(DISTINCT p.proname, ', ') INTO v_invoker
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f' AND NOT p.prosecdef
     AND pg_get_functiondef(p.oid) ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?vendor_payments\y';
  IF v_invoker IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to apply: these functions write vendor_payments without SECURITY DEFINER and would break: %', v_invoker;
  END IF;
END
$do$;

-- ═══ Grants: read only ═══════════════════════════════════════════════════════

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON public.vendor_payments
  FROM authenticated, anon, PUBLIC;

-- ═══ Policies: drop the write ones ═══════════════════════════════════════════

DROP POLICY IF EXISTS admin_insert_vendor_payments ON public.vendor_payments;
DROP POLICY IF EXISTS admin_update_vendor_payments ON public.vendor_payments;
DROP POLICY IF EXISTS admin_delete_vendor_payments ON public.vendor_payments;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
BEGIN
  IF has_table_privilege('authenticated', 'public.vendor_payments', 'INSERT')
     OR has_table_privilege('authenticated', 'public.vendor_payments', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.vendor_payments', 'DELETE')
     OR has_table_privilege('authenticated', 'public.vendor_payments', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Refusing to finish: authenticated can still write vendor_payments.';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.vendor_payments', 'SELECT') THEN
    RAISE EXCEPTION 'Refusing to finish: authenticated lost read access to vendor_payments.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'vendor_payments' AND cmd IN ('SELECT', 'ALL')) THEN
    RAISE EXCEPTION 'Refusing to finish: vendor_payments has no read policy left.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'vendor_payments' AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')) THEN
    RAISE EXCEPTION 'Refusing to finish: vendor_payments still has a write policy.';
  END IF;
END
$do$;

-- ─── Rollback ────────────────────────────────────────────────────────────────
--   GRANT INSERT, UPDATE, DELETE ON public.vendor_payments TO authenticated;
--   and recreate the admin write policies from 20260760.
--   Not needed by the app, which never wrote this table directly.
