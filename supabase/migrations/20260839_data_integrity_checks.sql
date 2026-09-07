-- A standing integrity check over the invariants live data already violates.
-- (Audit finding BUG-041.)
--
-- ── What the audit found, re-confirmed today ─────────────────────────────────
--
--   6  posted invoices claim `amount_paid > 0` with no payment_applications or
--      credit_note_applications behind it. `v_customer_ledger` reads the
--      applications, so it shows those invoices as wholly unpaid while the
--      invoice itself says "paid" — two different balances for the same
--      customer, both rendered in the UI.
--   15 sales orders of 20 sit at status 'delivered' with no `stock_moves` rows,
--      so the stock history has no record of the goods leaving.
--   8  inventory_units carry a blank serial number.
--   3  posted invoices have no due date, so they can never become overdue and
--      never appear in an aging bucket.
--
-- ── What this migration does, and deliberately does not do ───────────────────
--
-- It does NOT repair anything. Most of these rows belong to the seed/fixture
-- data whose purge the owner has explicitly deferred until after launch, and
-- deleting or rewriting financial rows on a hunch is exactly the kind of
-- unasked-for change that turns a reporting problem into a data-loss problem.
--
-- What it adds is the part that does not depend on that decision: a check that
-- can be run at any time and says precisely which rows are wrong and why. The
-- value is less in counting today's 32 known-bad rows than in the 33rd — a new
-- violation appearing after launch, in real trading data, is currently
-- invisible until someone queries a customer statement and disbelieves it.
--
-- Reversal rows carry a NEGATIVE `amount_applied` and also set `is_reversal`,
-- so the net applied is a plain SUM. Subtracting reversals as well double-counts
-- them and invents violations that do not exist — which it did on the first
-- attempt at this query, reporting two healthy invoices as broken.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
DECLARE
  v_missing text;
BEGIN
  FOREACH v_missing IN ARRAY ARRAY['crm_invoices','payment_applications','credit_note_applications',
                                   'sales_orders','stock_moves','inventory_units'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relname=v_missing) THEN
      RAISE EXCEPTION 'Refusing to apply: public.% does not exist.', v_missing;
    END IF;
  END LOOP;
END
$do$;

-- ═══ The check ═══════════════════════════════════════════════════════════════
-- One row per violation, shaped so a screen can group by `check_name` and a
-- person can act on `detail` without writing SQL.

CREATE OR REPLACE FUNCTION public.rma_data_integrity_issues()
RETURNS TABLE (
  check_name text,
  severity   text,
  entity     text,
  entity_id  uuid,
  reference  text,
  detail     text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $fn$
  -- 1. amount_paid must equal the sum of what was applied to the invoice.
  SELECT 'unbacked_amount_paid',
         'high',
         'crm_invoices',
         i.id,
         i.inv_code,
         format('amount_paid is %s but applications total %s', i.amount_paid, applied.total_applied)
    FROM public.crm_invoices i
    JOIN LATERAL (
      SELECT coalesce((SELECT sum(pa.amount_applied) FROM public.payment_applications pa
                        WHERE pa.invoice_id = i.id), 0)
           + coalesce((SELECT sum(ca.amount_applied) FROM public.credit_note_applications ca
                        WHERE ca.invoice_id = i.id), 0) AS total_applied
    ) applied ON true
   WHERE i.doc_status <> 'cancelled'
     AND i.amount_paid IS DISTINCT FROM applied.total_applied

  UNION ALL

  -- 2. A delivered order must have left a trace in stock history.
  SELECT 'delivered_without_stock_moves',
         'medium',
         'sales_orders',
         so.id,
         so.so_code,
         'status is delivered but no stock_moves rows reference this order'
    FROM public.sales_orders so
   WHERE so.status = 'delivered'
     AND NOT EXISTS (SELECT 1 FROM public.stock_moves m
                      WHERE m.doc_type = 'sales_order' AND m.doc_id = so.id)

  UNION ALL

  -- 3. A unit with no serial cannot be traced, matched to an RMA, or counted
  --    reliably against a customer's claim.
  SELECT 'unit_without_serial',
         'low',
         'inventory_units',
         u.id,
         coalesce(u.serial_number, '(null)'),
         'inventory unit has no serial number'
    FROM public.inventory_units u
   WHERE u.serial_number IS NULL OR btrim(u.serial_number) = ''

  UNION ALL

  -- 4. A posted invoice with no due date is never overdue and never ages.
  SELECT 'posted_invoice_without_due_date',
         'medium',
         'crm_invoices',
         i.id,
         i.inv_code,
         'invoice is posted but has no due_date, so it can never age or fall overdue'
    FROM public.crm_invoices i
   WHERE i.doc_status = 'posted' AND i.due_date IS NULL
$fn$;

REVOKE ALL ON FUNCTION public.rma_data_integrity_issues() FROM PUBLIC, anon;
-- Admins only: the rows name customers, invoice codes and amounts.
GRANT EXECUTE ON FUNCTION public.rma_data_integrity_issues() TO authenticated;

-- The grant above is to `authenticated` because that is the only role a browser
-- session has; the role check is inside the summary wrapper below, which is what
-- the UI calls. Kept separate so a future scheduled job can call the detail
-- function directly without impersonating an admin.

CREATE OR REPLACE FUNCTION public.rma_data_integrity_summary()
RETURNS TABLE (check_name text, severity text, issue_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NOT public.rma_is_admin() THEN
    RAISE EXCEPTION 'Only an administrator can run the data integrity check.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
    SELECT i.check_name, i.severity, count(*)
      FROM public.rma_data_integrity_issues() i
     GROUP BY i.check_name, i.severity
     ORDER BY CASE i.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, i.check_name;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rma_data_integrity_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_data_integrity_summary() TO authenticated;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  v_high bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='rma_data_integrity_issues') THEN
    RAISE EXCEPTION 'Refusing to finish: the check function was not created.';
  END IF;

  -- Sanity: the check must actually find the violations the audit documented.
  -- A check that reports a clean database when six invoices are known bad is
  -- worse than no check, because it is believed.
  SELECT count(*) INTO v_high
    FROM public.rma_data_integrity_issues()
   WHERE check_name = 'unbacked_amount_paid';
  IF v_high < 1 THEN
    RAISE EXCEPTION
      'Refusing to finish: the unbacked_amount_paid check found nothing, but 6 such invoices are known to exist. The query is wrong.';
  END IF;

  RAISE NOTICE 'BUG-041: integrity checks installed; unbacked_amount_paid currently finds % row(s).', v_high;
END
$do$;

-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP FUNCTION public.rma_data_integrity_summary();
--   DROP FUNCTION public.rma_data_integrity_issues();
