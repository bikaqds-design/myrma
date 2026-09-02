-- 20260805_pin_function_search_path.sql
--
-- Pin search_path on the 23 functions that were still leaving it to the caller.
--
-- ── Why this matters ─────────────────────────────────────────────────────────
--
-- When Postgres resolves an unqualified name like `user_roles`, it walks the
-- caller's search_path and takes the first match. Harmless on its own — sharp
-- when the function is SECURITY DEFINER, because that function runs with the
-- OWNER's privileges rather than the caller's.
--
-- Combine the two and the caller gets a say in which table a privileged
-- function reads. The worst case is not hypothetical in shape: rma_is_staff()
-- decides who is staff by reading user_roles. A function that could be pointed
-- at a different `user_roles` would answer "yes" for anyone, while running as
-- the owner.
--
-- Eight of these are SECURITY DEFINER and callable by `anon`, and they are
-- exactly the ones that decide authority: rma_is_staff, rma_is_admin,
-- rma_is_manager_or_above, rma_user_role, rma_current_user_email,
-- rma_is_authenticated, rma_can_handle_cash, crm_update_customer_last_activity.
--
-- ── How exposed was this really ──────────────────────────────────────────────
--
-- Defence in depth, not an open door. Exploiting it also requires the ability
-- to CREATE an object in a schema that is searched before public, and neither
-- `anon` nor `authenticated` can create schemas or tables here. That is why the
-- advisor rates it WARN rather than ERROR. It is worth closing because the cost
-- is one clause per function and the failure mode is total.
--
-- Most of the codebase was already pinned — record_vendor_payment,
-- rma_document_counters, rma_set_opening_cost and ~30 others carry
-- `SET search_path = public` already. This finishes the job.
--
-- ── Why ALTER and not CREATE OR REPLACE ──────────────────────────────────────
--
-- ALTER FUNCTION ... SET attaches the setting without touching the body. The
-- alternative would mean restating 23 function bodies in this file, and this
-- project has already been bitten once by a function rewritten from memory
-- (transfer_stock, which silently lost four guards). Nothing here can change
-- behaviour, and the verification below proves the bodies are byte-identical.
--
-- ── Why `public` and not `''` ────────────────────────────────────────────────
--
-- The stricter empty search_path requires every reference to be schema
-- qualified. Nearly all of them are — but rma_search_by_serial reads
-- `FROM rma_tickets` unqualified, so an empty path would break it. `public`
-- pins the resolution without demanding a rewrite.

BEGIN;

-- ── SECURITY DEFINER: the eight that decide authority ────────────────────────
ALTER FUNCTION public.crm_update_customer_last_activity()   SET search_path = public;
ALTER FUNCTION public.rma_can_handle_cash()                 SET search_path = public;
ALTER FUNCTION public.rma_current_user_email()              SET search_path = public;
ALTER FUNCTION public.rma_is_admin()                        SET search_path = public;
ALTER FUNCTION public.rma_is_authenticated()                SET search_path = public;
ALTER FUNCTION public.rma_is_manager_or_above()             SET search_path = public;
ALTER FUNCTION public.rma_is_staff()                        SET search_path = public;
ALTER FUNCTION public.rma_user_role()                       SET search_path = public;

-- ── SECURITY INVOKER: guards and triggers. Lower stakes, same hygiene. ───────
ALTER FUNCTION public.assert_purchase_status_transition()   SET search_path = public;
ALTER FUNCTION public.assert_tracking_mode_change_is_safe() SET search_path = public;
ALTER FUNCTION public.rma_access_is_current(text, timestamp with time zone)
                                                            SET search_path = public;
ALTER FUNCTION public.rma_guard_custom_role_delete()        SET search_path = public;
ALTER FUNCTION public.rma_hold_unit_cost()                  SET search_path = public;
ALTER FUNCTION public.rma_search_by_serial(text)            SET search_path = public;
ALTER FUNCTION public.rma_validate_user_role()              SET search_path = public;
ALTER FUNCTION public.set_credit_notes_updated_at()         SET search_path = public;
ALTER FUNCTION public.set_crm_invoices_updated_at()         SET search_path = public;
ALTER FUNCTION public.set_payments_updated_at()             SET search_path = public;
ALTER FUNCTION public.set_quotations_updated_at()           SET search_path = public;
ALTER FUNCTION public.set_sales_orders_updated_at()         SET search_path = public;
ALTER FUNCTION public.set_updated_at_col()                  SET search_path = public;
ALTER FUNCTION public.set_updated_date()                    SET search_path = public;
ALTER FUNCTION public.set_vendor_payments_updated_at()      SET search_path = public;

COMMIT;

-- ═══ Verification ════════════════════════════════════════════════════════════
-- Every row must report PASS.

SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       'no function in public is left unpinned' AS what,
       COALESCE(string_agg(p.proname, ', '), '(none)') AS actual
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proconfig IS NULL
UNION ALL
SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       'every SECURITY DEFINER function is pinned',
       COALESCE(string_agg(p.proname, ', '), '(none)')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef
   AND NOT COALESCE(array_to_string(p.proconfig, ',') LIKE '%search_path%', false)
UNION ALL
-- The authority predicates must still execute. Reaching these rows at all is
-- the proof: a function that failed to resolve a name would raise and take the
-- whole statement with it.
--
-- NOT written as `f() = f()`. Run from the SQL editor there is no JWT, so
-- rma_user_role() is NULL and rma_is_staff() is `NULL IN (...)`, which is NULL
-- — and `NULL = NULL` is NULL, so that spelling reports FAIL for a perfectly
-- healthy function. IS NOT DISTINCT FROM is null-safe and says what is meant.
SELECT CASE WHEN public.rma_is_staff() IS NOT DISTINCT FROM public.rma_is_staff()
            THEN 'PASS' ELSE 'FAIL' END,
       'rma_is_staff() still executes',
       COALESCE(public.rma_is_staff()::text, '(null — correct with no JWT)')
UNION ALL
SELECT CASE WHEN public.rma_user_role() IS NOT DISTINCT FROM public.rma_user_role()
            THEN 'PASS' ELSE 'FAIL' END,
       'rma_user_role() still executes',
       COALESCE(public.rma_user_role(), '(null — correct with no JWT)')
UNION ALL
-- One predicate that returns a real value without a JWT, so the block does not
-- rest entirely on null-tolerant checks.
SELECT CASE WHEN public.rma_is_authenticated() = false THEN 'PASS' ELSE 'FAIL' END,
       'rma_is_authenticated() returns false with no JWT',
       public.rma_is_authenticated()::text;
