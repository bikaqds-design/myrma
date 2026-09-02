-- Close the RPC bypass.
--
-- Measured, not assumed: supabase/manual/20260824_probe_rpc_authorization.sql
-- ran as a viewer and got past every function below. Its control call
-- (post_invoice, which does check) came back "Not authorized to post
-- invoices", so the probe was genuinely running as a viewer.
--
-- ── Why this matters more than it looks ──────────────────────────────────────
--
-- These are SECURITY DEFINER functions in the public schema. PostgREST exposes
-- each at /rest/v1/rpc/<name>, and SECURITY DEFINER means they execute as the
-- owner — so RLS does not apply to anything they do.
--
-- 20260787 stopped a viewer deleting a customer directly. It did not stop them
-- calling delete_customer_cascade, which deletes the customer, its notes and
-- its activities while checking nothing but whether an RMA ticket is attached.
-- The same shape applies to reversing a payment, cancelling a sales order,
-- converting a quotation, moving stock and adjusting part quantities.
--
-- ── Two treatments ───────────────────────────────────────────────────────────
--
-- Seven of these are called by the application, so they gain the authorization
-- check they should always have had. The rest are internal helpers that the
-- application never calls directly — grep for `.rpc('` in src/ — so they stop
-- being HTTP endpoints at all. A function that is only ever called by another
-- function has no reason to be reachable from a browser.
--
-- Revoking from PUBLIC as well as anon and authenticated is deliberate: a
-- function whose proacl is NULL carries an implicit EXECUTE to PUBLIC, so
-- revoking from the two named roles alone would change nothing.

-- ═══ Part 1 — internals stop being endpoints ═════════════════════════════════

DO $do$
DECLARE
  r record;
  v_names text[] := ARRAY[
    -- financial reversal internals; the public reverse_* wrappers check and stay
    '_reverse_payment_application',
    '_reverse_credit_note_application',
    '_reverse_vendor_payment_application',
    -- stock movement primitives, called by the guarded RPCs above them
    'reserve_units', 'release_units', 'deliver_units',
    'reserve_warehouse_stock', 'release_warehouse_stock',
    'deliver_warehouse_stock', 'restore_warehouse_stock',
    'reserve_parts', 'deliver_parts', 'restore_parts',
    'funnel_reserve_line',
    -- document numbering; callable directly it just burns gapless sequence numbers
    'nextval_for_type',
    -- cron entry point
    'queue_overdue_ticket_emails',
    -- trigger bodies, never meant to be called directly
    'assert_not_system_warehouse'
  ];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY(v_names)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres, service_role', r.sig);
  END LOOP;
END
$do$;

-- ═══ Part 2 — the seven the application calls ════════════════════════════════

-- customers.admin_delete restricts deletion to admins. This is the same
-- operation through a different door, so it takes the same rule.
CREATE OR REPLACE FUNCTION public.delete_customer_cascade(p_customer_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_tickets integer;
  v_name    text;
BEGIN
  IF NOT public.rma_is_admin() THEN
    RAISE EXCEPTION 'Not authorized to delete customers' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_tickets FROM rma_tickets WHERE customer_id = p_customer_id;

  IF v_tickets > 0 THEN
    SELECT COALESCE(company_name, contact_person, id::text) INTO v_name
    FROM customers WHERE id = p_customer_id;

    RAISE EXCEPTION
      'Cannot delete "%": % RMA ticket(s) reference this customer. Delete or reassign the tickets first — their serials, repair outcomes and stock history would go with them.',
      COALESCE(v_name, p_customer_id::text), v_tickets
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM activities
   WHERE related_type = 'customer' AND related_id = p_customer_id;
  DELETE FROM customer_notes WHERE customer_id = p_customer_id;
  DELETE FROM customers      WHERE id          = p_customer_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.delete_customers_cascade(p_customer_ids UUID[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_tickets   integer;
  v_customers integer;
BEGIN
  IF NOT public.rma_is_admin() THEN
    RAISE EXCEPTION 'Not authorized to delete customers' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*), count(DISTINCT customer_id)
    INTO v_tickets, v_customers
  FROM rma_tickets
  WHERE customer_id = ANY(p_customer_ids);

  IF v_tickets > 0 THEN
    RAISE EXCEPTION
      'Cannot delete: % of the selected customers have % RMA ticket(s) between them. Delete or reassign those tickets first.',
      v_customers, v_tickets
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM activities
   WHERE related_type = 'customer' AND related_id = ANY(p_customer_ids);
  DELETE FROM customer_notes WHERE customer_id = ANY(p_customer_ids);
  DELETE FROM customers      WHERE id          = ANY(p_customer_ids);
END;
$fn$;

-- parts.staff_update allows any staff member except a viewer to change stock.
CREATE OR REPLACE FUNCTION public.adjust_part_quantity(p_id uuid, p_delta integer)
RETURNS TABLE(id uuid, quantity integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  IF NOT (public.rma_is_staff() AND public.rma_user_role() <> 'viewer') THEN
    RAISE EXCEPTION 'Not authorized to adjust part quantities' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  UPDATE public.parts
     SET quantity     = GREATEST(0, parts.quantity + p_delta),
         updated_date = now()
   WHERE parts.id = p_id
  RETURNING parts.id, parts.quantity;
END;
$fn$;

-- Called when a credit note restocks returned goods; that is a manager action,
-- matching void_credit_note and issue_credit_note.
CREATE OR REPLACE FUNCTION public.restore_units(
  p_unit_ids uuid[], p_doc_type text, p_doc_id uuid,
  p_actor_email text, p_to_status text DEFAULT 'available'::text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_unit_id uuid;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to restore units' USING ERRCODE = 'P0001';
  END IF;

  FOREACH v_unit_id IN ARRAY p_unit_ids
  LOOP
    UPDATE public.inventory_units
    SET
      reservation_status = 'available',
      status             = CASE
                             WHEN p_to_status = 'active_rma' THEN 'active_rma'
                             ELSE status
                           END
    WHERE id = v_unit_id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', v_unit_id, p_doc_type, p_doc_id, 'restore', 1, 'delivered', p_to_status, p_actor_email);
  END LOOP;
END;
$fn$;

-- Mirrors sales_update_sales_orders: a manager, or the rep who owns the order.
CREATE OR REPLACE FUNCTION public.cancel_sales_order(p_so_id uuid, p_actor_email text)
RETURNS SETOF sales_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_so record;
BEGIN
  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found: %', p_so_id;
  END IF;

  IF NOT (public.rma_is_manager_or_above()
          OR v_so.assigned_rep = public.rma_current_user_email()
          OR v_so.created_by  = public.rma_current_user_email()) THEN
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

-- Mirrors sales_insert_sales_orders: managers and sales reps raise orders.
CREATE OR REPLACE FUNCTION public.convert_quotation_to_so(p_quotation_id uuid, p_actor_email text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_qt         record;
  v_so_code    text;
  v_so_id      uuid;
  v_null_lines bigint;
BEGIN
  IF NOT (public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep') THEN
    RAISE EXCEPTION 'Not authorized to convert quotations' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_qt FROM public.quotations WHERE id = p_quotation_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quotation not found: %', p_quotation_id;
  END IF;

  IF v_qt.status IN ('cancelled', 'declined', 'converted') THEN
    RAISE EXCEPTION 'Cannot convert a % quotation', v_qt.status;
  END IF;

  SELECT count(*) INTO v_null_lines
  FROM jsonb_array_elements(v_qt.line_items) AS line
  WHERE (line->>'product_id') IS NULL OR (line->>'product_id') = '';

  IF v_null_lines > 0 THEN
    RAISE EXCEPTION '% line(s) have no product — promote them to real products first', v_null_lines;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sales_orders
    WHERE quotation_id = p_quotation_id AND status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'Quotation already converted to a sales order';
  END IF;

  v_so_code := public.generate_doc_code('SO');

  INSERT INTO public.sales_orders (
    so_code, quotation_id, customer_id, status, line_items,
    subtotal, discount_amount, tax_amount, total,
    payment_terms, reference_po, notes, assigned_rep, created_by
  )
  VALUES (
    v_so_code, p_quotation_id, v_qt.customer_id, 'draft', v_qt.line_items,
    v_qt.subtotal, v_qt.discount_amount, v_qt.tax_amount, v_qt.total,
    v_qt.payment_terms, v_qt.reference_po, v_qt.notes,
    COALESCE(v_qt.assigned_rep, p_actor_email), p_actor_email
  )
  RETURNING id INTO v_so_id;

  UPDATE public.quotations
  SET status = 'converted', updated_at = NOW()
  WHERE id = p_quotation_id;

  RETURN v_so_id;
END;
$fn$;

-- The p_email parameter was taken on trust, so anyone could mark anyone else's
-- notifications read. The caller's identity now comes from the JWT; the
-- parameter is kept so the existing call sites still work, and ignored.
CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_email text, p_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_email text := public.rma_current_user_email();
BEGIN
  IF v_email IS NULL OR NOT public.rma_is_staff() THEN
    RAISE EXCEPTION 'Not authorized to mark notifications read' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.notifications
  SET read_by = array_append(read_by, v_email)
  WHERE id = ANY(p_ids)
    AND NOT (COALESCE(read_by, '{}') @> ARRAY[v_email]);
END;
$fn$;

-- Returns a random string, so it leaks nothing, but there is no reason for an
-- unauthenticated or non-staff caller to mint document codes.
CREATE OR REPLACE FUNCTION public.generate_doc_code(p_prefix text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  IF NOT public.rma_is_staff() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  RETURN p_prefix || '-' || LPAD((FLOOR(RANDOM() * 90000000) + 10000000)::text, 8, '0');
END;
$fn$;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════
-- Every function the application calls must still be executable by
-- authenticated, or the app breaks on the next deploy. Refuse otherwise.

DO $do$
DECLARE
  v_called text[] := ARRAY[
    'receive_stock','transfer_stock','adjust_stock','recalculate_stock',
    'move_rma_units','promote_rma_unit','archive_warehouse','adjust_part_quantity',
    'issue_credit_note','restore_units','apply_credit_note_to_invoice',
    'void_credit_note','reverse_credit_note_application',
    'delete_customer_cascade','delete_customers_cascade',
    'generate_doc_code','convert_quotation_to_so','rma_search_by_serial',
    'approve_sales_order','reject_sales_order','cancel_sales_order',
    'post_invoice','void_invoice','record_vendor_payment',
    'apply_vendor_payment_to_invoice','void_vendor_payment',
    'reverse_vendor_payment_application','mark_notifications_read',
    'crm_convert_lead','record_payment','apply_payment_to_invoice',
    'void_payment','reverse_payment_application','receive_vendor_invoice'
  ];
  r record;
  v_broken text[] := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY(v_called)
  LOOP
    IF NOT has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      v_broken := v_broken || r.proname;
    END IF;
  END LOOP;

  IF array_length(v_broken, 1) > 0 THEN
    RAISE EXCEPTION
      'Refusing to apply: the application calls these functions but authenticated can no longer execute them: %. Nothing has been changed.',
      array_to_string(v_broken, ', ');
  END IF;

  RAISE NOTICE 'RPC authorization applied. Re-run 20260824_probe_rpc_authorization.sql — every row should read guarded.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Re-run supabase/manual/20260824_probe_rpc_authorization.sql. Expect every
-- row to read "guarded", and the control row to stay "guarded — probe is
-- sound". The revoked internals will report a permission error rather than an
-- authorization message, which is the same outcome by a stricter route.
