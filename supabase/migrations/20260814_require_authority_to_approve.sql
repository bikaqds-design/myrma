-- Approving a document is an authority, not just a legal transition.
-- (Audit finding BUG-004, part 2 of 2 — the segregation-of-duties half.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- assert_purchase_status_transition() already guards purchase_orders and
-- vendor_invoices, and it does its job well: it knows that pending_approval may
-- become approved, that a received invoice is terminal, and so on. What it
-- never asks is WHO is making the change.
--
-- Combined with manager_write_vendor_invoices / manager_write_purchase_orders,
-- which grant a manager ALL on both tables, that means the manager who raised a
-- purchase order can approve their own spend — by pressing the button the
-- interface offers them, since vendorInvoices.approve() is a plain
-- UPDATE ... SET status='approved'.
--
-- The application already believes otherwise. ROLE_DEFAULT_PERMISSIONS in
-- src/lib/permissions.ts gives manager `purchasing.approve: false`, with the
-- comment: "a manager can raise and receive a purchase order but not approve
-- their own spend. admin/super_admin bypass canDo, so approval lands with
-- them." That intent existed only in the browser. This migration moves it to
-- the database.
--
-- ── The rule, and that it was chosen rather than derived ─────────────────────
--
-- Approval of a purchase document requires an administrator. Hardcoded,
-- deliberately: the alternative of reading `purchasing.approve` out of
-- user_roles.permissions would allow delegating approval to a named manager
-- later without a migration, and that flexibility was explicitly declined in
-- favour of a rule that is predictable and cannot be widened by an accidental
-- permission edit. Delegating approval later therefore means changing this
-- function, which is the intended friction.
--
-- On the sales side the equivalent decision — accepting a quotation, which is
-- what lets it convert into a sales order and reserve stock — is restricted to
-- manager or above rather than to admins. That is not a softer choice made for
-- convenience; it is the rule the database already applies one step later, in
-- approve_sales_order():
--
--     IF NOT public.rma_is_manager_or_above() THEN
--       RAISE EXCEPTION 'Not authorized to approve sales orders';
--
-- Making quotation acceptance admin-only would have put a stricter gate in
-- front of a looser one, which stops nobody and confuses everybody.
--
-- Declining a quotation is deliberately NOT restricted. Recording that a
-- customer said no is the rep's own work, not an internal approval, and the
-- interface offers it from the deal screen as an ordinary act.
--
-- ── Why nothing gets stranded ────────────────────────────────────────────────
--
-- Checked before applying: no purchase order sits at 'sent' or
-- 'pending_confirmation', and no vendor invoice sits at 'pending_approval'.
-- Purchase orders are 4 confirmed and 1 completed; vendor invoices are 3
-- received and 1 approved. So there is no document mid-flight that a manager
-- can no longer finish and an administrator has not yet seen.
--
-- ── What this does NOT do ────────────────────────────────────────────────────
--
-- It does not build a transition map for quotations. They still have neither a
-- transition trigger nor a status check constraint, so 'converted' can be
-- written by hand without a sales order ever existing. That is BUG-034, it is
-- a larger piece of work, and folding it in here would widen the blast radius
-- of a change whose point is a two-line authority check.

CREATE OR REPLACE FUNCTION public.rma_guard_approval_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
BEGIN
  -- SECURITY DEFINER callers (the RPCs) run as their owner and are trusted to
  -- have done their own authorization. approve_sales_order does exactly that.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- The document forms post the whole row back, so an unchanged status is the
  -- ordinary case.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Purchase side: approving committed spend is an administrator's act.
  IF TG_TABLE_NAME = 'vendor_invoices' AND NEW.status = 'approved' THEN
    IF NOT public.rma_is_admin() THEN
      RAISE EXCEPTION
        'Only an administrator can approve a vendor invoice. A manager may raise and receive it, but approving the spend is a separate authority.'
        USING ERRCODE = 'P0001';
    END IF;

  ELSIF TG_TABLE_NAME = 'purchase_orders' AND NEW.status = 'confirmed' THEN
    IF NOT public.rma_is_admin() THEN
      RAISE EXCEPTION
        'Only an administrator can confirm a purchase order. A manager may raise it and send it for approval.'
        USING ERRCODE = 'P0001';
    END IF;

  -- Sales side: accepting a quotation is what allows it to become a sales order
  -- and reserve stock, so it carries the same authority approve_sales_order
  -- already demands one step later.
  ELSIF TG_TABLE_NAME = 'quotations' AND NEW.status = 'accepted' THEN
    IF NOT public.rma_is_manager_or_above() THEN
      RAISE EXCEPTION
        'Only a manager or above can accept a quotation. Send it for approval instead.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.rma_guard_approval_authority() IS
  'Requires an administrator to approve a vendor invoice or confirm a purchase order, and a manager or above to accept a quotation. Complements assert_purchase_status_transition(), which checks whether a transition is legal but not who is making it. SECURITY DEFINER callers pass through.';

DROP TRIGGER IF EXISTS trg_vendor_invoices_approval_authority ON public.vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_approval_authority
  BEFORE UPDATE ON public.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_approval_authority();

DROP TRIGGER IF EXISTS trg_purchase_orders_approval_authority ON public.purchase_orders;
CREATE TRIGGER trg_purchase_orders_approval_authority
  BEFORE UPDATE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_approval_authority();

DROP TRIGGER IF EXISTS trg_quotations_approval_authority ON public.quotations;
CREATE TRIGGER trg_quotations_approval_authority
  BEFORE UPDATE ON public.quotations
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_approval_authority();

-- ═══ Guard ═══════════════════════════════════════════════════════════════════
-- Prove it on throwaway rows rather than trusting the reasoning: a manager must
-- be refused a vendor-invoice approval and an administrator must still be
-- allowed one. Both rows are removed before the block ends, and either
-- expectation failing rolls the whole migration back.

DO $do$
DECLARE
  v_manager  text;
  v_admin    text;
  v_vendor   uuid;
  v_id       uuid;
  v_blocked  boolean := false;
BEGIN
  SELECT user_email INTO v_manager
    FROM public.user_roles WHERE role = 'manager' AND status = 'active' LIMIT 1;
  SELECT user_email INTO v_admin
    FROM public.user_roles WHERE role IN ('admin', 'super_admin') AND status = 'active' LIMIT 1;
  SELECT id INTO v_vendor FROM public.brands LIMIT 1;

  IF v_manager IS NULL OR v_admin IS NULL OR v_vendor IS NULL THEN
    RAISE NOTICE 'Skipping the behavioural guard: no active manager, admin, or vendor to build a fixture from. Run supabase/manual/20260852 by hand.';
    RETURN;
  END IF;

  INSERT INTO public.vendor_invoices
    (vendor_id, status, line_items, subtotal, discount_amount, tax_amount, total,
     currency, exchange_rate, created_by)
  VALUES (v_vendor, 'pending_approval', '[]'::jsonb, 0, 0, 0, 0, 'EGP', 1, v_manager)
  RETURNING id INTO v_id;

  PERFORM set_config('role', 'authenticated', true);

  -- Must be refused: the manager who raised it approving their own spend.
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_manager, 'role', 'authenticated')::text, true);
  BEGIN
    UPDATE public.vendor_invoices SET status = 'approved' WHERE id = v_id;
  EXCEPTION WHEN raise_exception THEN
    v_blocked := true;
  END;

  IF NOT v_blocked THEN
    RESET ROLE;
    DELETE FROM public.vendor_invoices WHERE id = v_id;
    RAISE EXCEPTION
      'Refusing to apply: a manager can still approve a vendor invoice, so the guard is not working. Nothing has been changed.';
  END IF;

  -- Must be allowed: an administrator approving it.
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_admin, 'role', 'authenticated')::text, true);
  BEGIN
    UPDATE public.vendor_invoices SET status = 'approved' WHERE id = v_id;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RAISE EXCEPTION
      'Refusing to apply: an administrator can no longer approve a vendor invoice either (SQLSTATE %). Approval would be impossible for everyone. Nothing has been changed.',
      SQLSTATE;
  END;

  RESET ROLE;
  DELETE FROM public.vendor_invoices WHERE id = v_id;

  RAISE NOTICE 'Guard verified in place: a manager cannot approve a vendor invoice, an administrator can.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- supabase/manual/20260852_verify_approval_authority.sql
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP TRIGGER trg_vendor_invoices_approval_authority ON public.vendor_invoices;
--   DROP TRIGGER trg_purchase_orders_approval_authority ON public.purchase_orders;
--   DROP TRIGGER trg_quotations_approval_authority      ON public.quotations;
--   DROP FUNCTION public.rma_guard_approval_authority();
