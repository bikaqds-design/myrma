-- cancel_sales_order: authorize before looking anything up.
--
-- 20260788 added an owner check to this function, but placed it after the row
-- fetch, because the check needs assigned_rep and created_by from the row. The
-- re-run of 20260824_probe_rpc_authorization.sql caught the consequence: a
-- viewer calling with a non-existent id got
--
--   Sales order not found: 00000000-0000-0000-0000-000000000000
--
-- rather than a refusal. Two problems with that:
--
--   * It answers "does this sales order exist?" for anybody with a session,
--     before deciding whether they are allowed to ask.
--   * The authorization check is unreachable for any id that does not resolve,
--     so nothing can verify it fires — which is how it showed up as UNGUARDED
--     in a probe that was otherwise reporting the fix working.
--
-- Fixed with a coarse gate first — the caller must at least be a manager or a
-- sales rep — then the fetch, then the fine-grained owner test. Same final
-- authority, but a viewer is turned away before the function looks at
-- anything.
--
-- The other six functions 20260788 touched already check before they read.

CREATE OR REPLACE FUNCTION public.cancel_sales_order(p_so_id uuid, p_actor_email text)
RETURNS SETOF sales_orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_so    record;
  v_email text := public.rma_current_user_email();
BEGIN
  -- Coarse gate: nobody outside sales or management cancels an order, and
  -- this costs no lookup, so it answers before revealing whether the id is real.
  IF NOT (public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep') THEN
    RAISE EXCEPTION 'Not authorized to cancel sales orders' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found: %', p_so_id;
  END IF;

  -- Fine-grained: a rep may cancel their own orders, not a colleague's.
  -- Mirrors sales_update_sales_orders.
  IF NOT (public.rma_is_manager_or_above()
          OR v_so.assigned_rep = v_email
          OR v_so.created_by  = v_email) THEN
    RAISE EXCEPTION 'Not authorized to cancel this sales order' USING ERRCODE = 'P0001';
  END IF;

  IF v_so.status = 'cancelled' THEN
    RAISE EXCEPTION 'Sales order is already cancelled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.crm_invoices
    WHERE so_id = p_so_id AND doc_status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'Cannot cancel — an invoice exists; void or credit it first';
  END IF;

  PERFORM public.release_units('sales_order', p_so_id, p_actor_email);

  UPDATE public.sales_orders
  SET status = 'cancelled', updated_at = NOW()
  WHERE id = p_so_id;

  RETURN QUERY SELECT * FROM public.sales_orders WHERE id = p_so_id;
END;
$fn$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Re-run supabase/manual/20260824_probe_rpc_authorization.sql. cancel_sales_order
-- should now read "Not authorized to cancel sales orders" rather than reporting
-- whether the id exists.
