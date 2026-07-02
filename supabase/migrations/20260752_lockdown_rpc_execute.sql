-- ============================================================================
-- AUDIT 2026-07-02 — CRIT-1 (execute lockdown, comprehensive)
--
-- Postgres grants EXECUTE on functions to PUBLIC by default, which in Supabase
-- means both the `anon` and `authenticated` roles can reach every function via
-- /rest/v1/rpc/<name>. The Sprint 8/9 inventory RPCs carry internal
-- rma_is_manager_or_above() guards (so a guest is rejected at runtime), but
-- relying on the in-body guard alone is fragile: any future RPC that forgets
-- the guard is silently world-callable. This migration makes "not callable by
-- anon" the default posture for every client RPC.
--
-- Approach: enumerate each client-invoked RPC by name (from a grep of
-- supabase.rpc(...) calls in src/), resolve every overload via pg_proc, then
-- REVOKE ALL from PUBLIC + anon and GRANT EXECUTE to authenticated +
-- service_role. Idempotent — safe to re-run.
--
-- NOTE: the public.rma_* RLS helper functions are intentionally NOT in this
-- list. They are evaluated inside RLS policies for authenticated users and must
-- keep their default grants; anon has no table access so never triggers them.
-- ============================================================================

DO $$
DECLARE
  v_names text[] := ARRAY[
    'adjust_part_quantity',
    'adjust_stock',
    'apply_credit_note_to_invoice',
    'apply_payment_to_invoice',
    'approve_sales_order',
    'archive_warehouse',
    'cancel_sales_order',
    'convert_quotation_to_so',
    'crm_convert_lead',
    'delete_customer_cascade',
    'delete_customers_cascade',
    'generate_doc_code',
    'issue_credit_note',
    'mark_notifications_read',
    'post_invoice',
    'recalculate_stock',
    'receive_stock',
    'receive_vendor_invoice',
    'record_payment',
    'reject_sales_order',
    'restore_units',
    'rma_search_by_serial',
    'transfer_stock',
    'void_invoice'
  ];
  v_sig text;
BEGIN
  FOR v_sig IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY(v_names)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
    BEGIN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_sig);
    EXCEPTION WHEN undefined_object THEN NULL;  -- role may not exist off-Supabase
    END;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_sig);
    BEGIN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
    EXCEPTION WHEN undefined_object THEN NULL;
    END;
  END LOOP;
END $$;
