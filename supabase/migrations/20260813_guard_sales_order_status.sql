-- A sales order may not be advanced by a direct client write.
-- (Audit finding BUG-004, part 1 of 2 — the stock-integrity half.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- approve_sales_order() is where a sales order becomes real stock:
--
--   IF NOT rma_is_manager_or_above() THEN RAISE ...
--   IF v_so.status <> 'sent'         THEN RAISE ...
--   FOR each line -> funnel_reserve_line('sales_order', ...)
--   UPDATE sales_orders SET status='delivered', confirmed_at=NOW(), delivered_at=NOW()
--
-- The reservation and the status are set together, in one transaction, and that
-- pairing is the whole guarantee. But `status` is an ordinary column on a table
-- a sales rep may update — sales_update_sales_orders lets them write their own
-- row — so a rep could simply
--
--   PATCH /rest/v1/sales_orders?id=eq.<own> {"status":"delivered"}
--
-- and land in exactly the state approve_sales_order produces, having reserved
-- nothing. The manager check, the `must be sent first` check and every
-- funnel_reserve_line call are skipped. The order then looks fulfilled while the
-- goods are still sellable to somebody else.
--
-- This is not hypothetical shape-fitting: 15 sales orders already sit at
-- 'delivered' with no stock_moves rows behind them (audit BUG-041), and the
-- table also holds legacy 'accepted' and 'confirmed' values that no current code
-- path produces. Something has been writing this column directly.
--
-- ── Why the guard can be this tight ──────────────────────────────────────────
--
-- Because only one client path legitimately writes this column. Every write to
-- sales_orders in src/ was enumerated before this migration:
--
--   insert(...)                     create, always status 'draft'
--   update(updates)                 line_items / dates / notes — never status
--   update({status:'sent'})         markSent, i.e. submit for approval
--   rpc('approve_sales_order')      accept   -> reserves stock, sets delivered
--   rpc('reject_sales_order')       decline  -> sets declined
--   rpc('cancel_sales_order')       cancel   -> sets cancelled
--
-- So `-> sent` is the only status change a browser has any business making. The
-- three consequential ones already go through SECURITY DEFINER functions, which
-- run as `postgres` and are therefore untouched by this trigger.
--
-- ── Deliberately NOT decided here ────────────────────────────────────────────
--
-- Who may *approve* — a manager approving their own purchase order, a rep
-- accepting their own quotation — is the other half of BUG-004 and is a
-- business-policy question, not a data-integrity one. It is left alone by this
-- migration. Nothing below changes which roles can approve anything; it only
-- stops the approval being simulated by writing the column by hand.
--
-- Legacy rows are not touched or migrated either. The guard constrains
-- transitions from here on, and says nothing about how a row reached the state
-- it is in.

CREATE OR REPLACE FUNCTION public.rma_guard_sales_order_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
BEGIN
  -- The RPCs run as the function owner. They are the intended writers.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- Backup & Restore upserts this table from the browser, and only an
  -- administrator can reach it. Consistent with 20260808/20260809: an admin is
  -- not a segregation boundary here, and a restore that silently skipped sales
  -- orders would be discovered at the worst possible moment.
  IF public.rma_is_admin() THEN
    RETURN NEW;
  END IF;

  -- The document forms post the whole row back on save, so an unchanged status
  -- is the normal case and must pass — editing a draft's line items is not a
  -- transition.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Submitting for approval, and re-submitting one that came back declined.
  IF NEW.status = 'sent' AND OLD.status IN ('draft', 'sent', 'declined') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'A sales order cannot be moved from % to % by editing it. Use the %.',
    OLD.status,
    NEW.status,
    CASE NEW.status
      WHEN 'delivered' THEN 'Accept action, which reserves the stock at the same time (approve_sales_order)'
      WHEN 'accepted'  THEN 'Accept action, which reserves the stock at the same time (approve_sales_order)'
      WHEN 'confirmed' THEN 'Accept action, which reserves the stock at the same time (approve_sales_order)'
      WHEN 'declined'  THEN 'Reject action (reject_sales_order)'
      WHEN 'cancelled' THEN 'Cancel action, which releases any reservation (cancel_sales_order)'
      ELSE 'documented action for that transition'
    END
    USING ERRCODE = 'P0001';
END;
$fn$;

COMMENT ON FUNCTION public.rma_guard_sales_order_status() IS
  'Refuses direct client changes to sales_orders.status other than submitting for approval. The consequential transitions belong to approve_sales_order/reject_sales_order/cancel_sales_order, which pair the status with stock reservation. SECURITY DEFINER callers and administrators pass through.';

DROP TRIGGER IF EXISTS trg_sales_orders_guard_status ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_guard_status
  BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_sales_order_status();

-- ═══ Guard ═══════════════════════════════════════════════════════════════════
-- Prove it on a throwaway row rather than trusting the reasoning: a non-admin
-- must be refused 'delivered' and allowed 'sent'. Both are undone before the
-- block ends, and either expectation failing rolls the whole migration back.

DO $do$
DECLARE
  v_rep      text;
  v_customer uuid;
  v_id       uuid;
  v_blocked  boolean := false;
BEGIN
  SELECT user_email INTO v_rep
    FROM public.user_roles
   WHERE role IN ('sales_rep', 'manager') AND status = 'active'
   LIMIT 1;
  SELECT id INTO v_customer FROM public.customers LIMIT 1;

  IF v_rep IS NULL OR v_customer IS NULL THEN
    RAISE NOTICE 'Skipping the behavioural guard: no active non-admin staff member or no customer. Run supabase/manual/20260851 by hand.';
    RETURN;
  END IF;

  INSERT INTO public.sales_orders
    (so_code, customer_id, status, line_items,
     subtotal, discount_amount, tax_amount, total, created_by, assigned_rep)
  VALUES ('SO-GUARD-' || substr(gen_random_uuid()::text, 1, 8), v_customer, 'draft', '[]'::jsonb,
          0, 0, 0, 0, v_rep, v_rep)
  RETURNING id INTO v_id;

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_rep, 'role', 'authenticated')::text, true);

  -- Must still be allowed: submitting for approval.
  BEGIN
    UPDATE public.sales_orders SET status = 'sent' WHERE id = v_id;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RAISE EXCEPTION
      'Refusing to apply: submitting a sales order for approval is now refused (SQLSTATE %). The guard is too tight. Nothing has been changed.',
      SQLSTATE;
  END;

  -- Must be refused: the stock-reservation bypass this migration exists to stop.
  BEGIN
    UPDATE public.sales_orders SET status = 'delivered' WHERE id = v_id;
  EXCEPTION WHEN raise_exception THEN
    v_blocked := true;
  END;

  RESET ROLE;

  IF NOT v_blocked THEN
    RAISE EXCEPTION
      'Refusing to apply: a sales order can still be marked delivered by a direct write, so the guard is not working. Nothing has been changed.';
  END IF;

  DELETE FROM public.sales_orders WHERE id = v_id;

  RAISE NOTICE 'Guard verified in place: a sales order can be submitted for approval but not marked delivered by hand.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- supabase/manual/20260851_verify_sales_order_status_guard.sql
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP TRIGGER trg_sales_orders_guard_status ON public.sales_orders;
--   DROP FUNCTION public.rma_guard_sales_order_status();
