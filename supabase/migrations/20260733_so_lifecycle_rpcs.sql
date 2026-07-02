-- Sales Order lifecycle RPCs: atomic, row-locked, role-checked.
-- Replaces the multi-await client-side flows in salesOrders.ts and
-- quotations.ts. Closes H1 (reserve every line type), H2 (release path),
-- H4a (atomic QT→SO), M1 (FOR UPDATE locks), M5 (server-side role checks).

-- ── convert_quotation_to_so ──────────────────────────────────────────────────
-- Atomically inserts the SO and flips qt.status='converted' in one tx.
-- The FOR UPDATE lock on the quotation serializes concurrent conversion
-- attempts, closing the duplicate-SO race (FR-006).
CREATE OR REPLACE FUNCTION public.convert_quotation_to_so(
  p_quotation_id uuid,
  p_actor_email  text
)
RETURNS uuid   -- new SO id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_qt         record;
  v_so_code    text;
  v_so_id      uuid;
  v_null_lines bigint;
BEGIN
  SELECT * INTO v_qt
  FROM public.quotations
  WHERE id = p_quotation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quotation not found: %', p_quotation_id;
  END IF;

  IF v_qt.status IN ('cancelled', 'declined', 'converted') THEN
    RAISE EXCEPTION 'Cannot convert a % quotation', v_qt.status;
  END IF;

  -- Reject free-form lines (product_id IS NULL) — server-side guard (FR-001/L3)
  SELECT count(*) INTO v_null_lines
  FROM jsonb_array_elements(v_qt.line_items) AS line
  WHERE (line->>'product_id') IS NULL OR (line->>'product_id') = '';

  IF v_null_lines > 0 THEN
    RAISE EXCEPTION '% line(s) have no product — promote them to real products first', v_null_lines;
  END IF;

  -- Idempotency guard: refuse if a non-cancelled SO already references this QT
  IF EXISTS (
    SELECT 1 FROM public.sales_orders
    WHERE quotation_id = p_quotation_id
      AND status <> 'cancelled'
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

  -- Flip quotation in the same transaction — no second await possible
  UPDATE public.quotations
  SET status = 'converted', updated_at = NOW()
  WHERE id = p_quotation_id;

  RETURN v_so_id;
END;
$$;

-- ── approve_sales_order ──────────────────────────────────────────────────────
-- Role-checked, row-locked. Reserves every line via funnel_reserve_line
-- (serialized → reserve_units; service/non-stock → no-op). If any serialized
-- line has insufficient stock the whole approval rolls back and the SO stays
-- at 'sent'. Closes H1, M1, M5.
CREATE OR REPLACE FUNCTION public.approve_sales_order(
  p_so_id       uuid,
  p_actor_email text
)
RETURNS SETOF public.sales_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_so   record;
  v_line record;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to approve sales orders';
  END IF;

  SELECT * INTO v_so
  FROM public.sales_orders
  WHERE id = p_so_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found: %', p_so_id;
  END IF;

  IF v_so.status <> 'sent' THEN
    RAISE EXCEPTION 'Sales order must be submitted for approval first (current: %)', v_so.status;
  END IF;

  FOR v_line IN
    SELECT
      (line->>'product_id')::uuid AS product_id,
      (line->>'qty')::integer     AS qty
    FROM jsonb_array_elements(v_so.line_items) AS line
    WHERE (line->>'product_id') IS NOT NULL AND (line->>'product_id') <> ''
  LOOP
    PERFORM public.funnel_reserve_line(
      'sales_order', p_so_id, v_line.product_id, v_line.qty, p_actor_email
    );
  END LOOP;

  UPDATE public.sales_orders
  SET
    status       = 'delivered',
    confirmed_at = NOW(),
    delivered_at = NOW(),
    updated_at   = NOW()
  WHERE id = p_so_id;

  RETURN QUERY SELECT * FROM public.sales_orders WHERE id = p_so_id;
END;
$$;

-- ── reject_sales_order ───────────────────────────────────────────────────────
-- Role-checked, row-locked. Sets status='declined'. No inventory effect.
-- Closes M5 for the reject path.
CREATE OR REPLACE FUNCTION public.reject_sales_order(
  p_so_id       uuid,
  p_actor_email text
)
RETURNS SETOF public.sales_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to reject sales orders';
  END IF;

  UPDATE public.sales_orders
  SET status = 'declined', updated_at = NOW()
  WHERE id = p_so_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found: %', p_so_id;
  END IF;

  RETURN QUERY SELECT * FROM public.sales_orders WHERE id = p_so_id;
END;
$$;

-- ── cancel_sales_order ───────────────────────────────────────────────────────
-- Row-locked. Refuses if a non-cancelled invoice already references this SO.
-- Releases all serialized units reserved by this SO via release_units.
-- Works from any not-yet-invoiced status (draft, sent, delivered).
-- Closes H2, M1.
CREATE OR REPLACE FUNCTION public.cancel_sales_order(
  p_so_id       uuid,
  p_actor_email text
)
RETURNS SETOF public.sales_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_so record;
BEGIN
  SELECT * INTO v_so
  FROM public.sales_orders
  WHERE id = p_so_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found: %', p_so_id;
  END IF;

  IF v_so.status = 'cancelled' THEN
    RAISE EXCEPTION 'Sales order is already cancelled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.crm_invoices
    WHERE so_id = p_so_id
      AND doc_status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'Cannot cancel — an invoice exists; void or credit it first';
  END IF;

  -- Release all serialized units reserved by this SO (no-op if none were reserved)
  PERFORM public.release_units('sales_order', p_so_id, p_actor_email);

  UPDATE public.sales_orders
  SET status = 'cancelled', updated_at = NOW()
  WHERE id = p_so_id;

  RETURN QUERY SELECT * FROM public.sales_orders WHERE id = p_so_id;
END;
$$;
