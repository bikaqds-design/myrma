-- ============================================================================
-- 20260895 — cancel_sales_order: a sales rep cancels only their own orders
-- ============================================================================
-- The own-order check was a bare
--     IF NOT (rma_is_manager_or_above() OR v_so.assigned_rep = v_email
--             OR v_so.created_by = v_email) THEN RAISE
-- For an order with no assigned rep, "assigned_rep = me" is NULL, so for a
-- sales rep who did not create it the whole test is NULL, and IF NOT NULL does
-- not fire: any rep could cancel a colleague's unassigned order (releasing its
-- reservations). The same fix is part of 20260894 on the `next` line; this
-- file carries it to `main` on its own, and does nothing where it is already
-- in place.
--
-- Rewrites only the guard text in the live definition (the body differs
-- between lines), refusing unless it finds exactly one bare check.
-- Pinned by src/test/cancelSalesOrderRepCheck.test.js;
-- supabase/tests/cancel_sales_order_rep_check.sql is the rolled-back probe.
-- ============================================================================

DO $$
DECLARE
  v_def  text;
  v_have integer;
  v_old  text := E'IF NOT (public.rma_is_manager_or_above()\n          OR v_so.assigned_rep = v_email\n          OR v_so.created_by  = v_email) THEN';
  v_new  text := E'IF NOT COALESCE(public.rma_is_manager_or_above()\n          OR v_so.assigned_rep = v_email\n          OR v_so.created_by  = v_email, false) THEN';
BEGIN
  SELECT replace(pg_get_functiondef('public.cancel_sales_order'::regproc), E'\r\n', E'\n') INTO v_def;
  IF strpos(v_def, v_new) > 0 THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: cancel_sales_order holds its own-order check % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END $$;

DO $$
BEGIN
  IF strpos(replace(pg_get_functiondef('public.cancel_sales_order'::regproc), E'\r\n', E'\n'),
            E'IF NOT COALESCE(public.rma_is_manager_or_above()\n          OR v_so.assigned_rep = v_email') = 0 THEN
    RAISE EXCEPTION 'Refusing to finish: cancel_sales_order''s own-order check is still bare';
  END IF;
END $$;
