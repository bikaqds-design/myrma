-- 20260807_revoke_anon_rpc_execute.sql
--
-- Stop `anon` being able to CALL the SECURITY DEFINER RPCs that are nothing to
-- do with anonymous visitors.
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- Supabase grants EXECUTE on new functions to anon and authenticated by
-- default. `REVOKE ... FROM PUBLIC` does not undo that: it removes the PUBLIC
-- grant, not the direct one to anon. Several migrations used exactly that
-- spelling and their own verification checked `has_function_privilege('public',
-- ...)`, which passes while anon still holds the privilege. 20260800 is the
-- clearest case — it explicitly asserts the counters are not readable by
-- PUBLIC, and anon could call them the whole time.
--
-- Every one of these is guarded internally, so an anonymous caller was refused
-- rather than served. This is defence in depth: the guard is the reason it was
-- not an incident, not a reason to leave the door reachable. record_vendor_payment
-- and rma_set_opening_cost WRITE — an unauthenticated caller should not be able
-- to reach the point where only an IF statement stands between them and the
-- ledger.
--
-- ── What is deliberately NOT revoked, and why ────────────────────────────────
--
-- Five predicates keep their anon grant:
--
--     rma_is_staff, rma_is_admin, rma_is_manager_or_above,
--     rma_user_role, rma_current_user_email
--
-- They are called inside RLS policy expressions, and a policy expression runs
-- as the querying role. anon evaluates policies containing these on 13 to 28
-- tables — rma_is_manager_or_above alone appears in 28 anon-reachable policies.
-- Revoking EXECUTE would not make those policies return false; it would make
-- the query fail with "permission denied for function", which is how the public
-- RMA tracker would break.
--
-- They also leak nothing to an anonymous caller: with no JWT they return NULL
-- or false, which is the same answer the policy needs. So this is a considered
-- exception, not an oversight — if a future audit flags these five, this is the
-- reason they are still there.

-- ── Both spellings are required ──────────────────────────────────────────────
--
-- Revoking from anon alone was not enough for three of these. Their ACL carried
-- `=X/postgres` — an entry with an empty grantee, which is how Postgres writes
-- a grant to PUBLIC — and anon inherits whatever PUBLIC holds. The other five
-- had already had their PUBLIC grant removed by their own migrations, so the
-- anon revoke was sufficient there and it looked like the job was done.
--
-- Hence both, on all eight. Neither spelling alone is reliable, and the earlier
-- migrations that used only one are exactly why this file exists.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.record_vendor_payment(uuid, numeric, text, text, date, text, text, jsonb, character, numeric) FROM anon;
REVOKE EXECUTE ON FUNCTION public.rma_set_opening_cost(uuid, uuid, numeric) FROM anon;
REVOKE EXECUTE ON FUNCTION public.rma_invoice_cogs(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.rma_vi_landed_unit_costs(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.rma_document_counters() FROM anon;
REVOKE EXECUTE ON FUNCTION public.rma_staff_directory() FROM anon;
REVOKE EXECUTE ON FUNCTION public.rma_can_handle_cash() FROM anon;
REVOKE EXECUTE ON FUNCTION public.rma_is_authenticated() FROM anon;

REVOKE EXECUTE ON FUNCTION public.record_vendor_payment(uuid, numeric, text, text, date, text, text, jsonb, character, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rma_set_opening_cost(uuid, uuid, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rma_invoice_cogs(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rma_vi_landed_unit_costs(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rma_document_counters() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rma_staff_directory() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rma_can_handle_cash() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rma_is_authenticated() FROM PUBLIC;

COMMIT;

-- ═══ Verification ════════════════════════════════════════════════════════════
-- Every row must report PASS.

SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
       'no anon-callable SECURITY DEFINER RPC outside the five predicates' AS what,
       COALESCE(string_agg(p.proname, ', '), 'none') AS actual
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_type t ON t.oid = p.prorettype
 WHERE n.nspname = 'public' AND p.prosecdef AND t.typname <> 'trigger'
   AND has_function_privilege('anon', p.oid, 'EXECUTE')
   AND p.proname NOT IN ('rma_is_staff','rma_is_admin','rma_is_manager_or_above',
                         'rma_user_role','rma_current_user_email')
UNION ALL
-- The five must KEEP it, or RLS breaks for anonymous visitors.
SELECT CASE WHEN count(*) = 5 THEN 'PASS' ELSE 'FAIL' END,
       'the five policy predicates still executable by anon', count(*)::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('rma_is_staff','rma_is_admin','rma_is_manager_or_above',
                     'rma_user_role','rma_current_user_email')
   AND has_function_privilege('anon', p.oid, 'EXECUTE')
UNION ALL
-- Staff must be unaffected: revoking from anon must not touch authenticated.
SELECT CASE WHEN count(*) = 8 THEN 'PASS' ELSE 'FAIL' END,
       'authenticated still holds all eight', count(*)::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('record_vendor_payment','rma_set_opening_cost','rma_invoice_cogs',
                     'rma_vi_landed_unit_costs','rma_document_counters',
                     'rma_staff_directory','rma_can_handle_cash','rma_is_authenticated')
   AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
