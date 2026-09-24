-- ============================================================================
-- 20260896_invoice_from_delivery.sql
-- P-02a — invoice what a delivery shipped (owner decision 2026-09-24: goods
-- are invoiced only for what was delivered). Design: docs/P01_DELIVERIES.md.
-- ============================================================================
-- After 20260894 an order ships by deliveries: confirm_delivery moves the
-- stock and records its cost. This file lets each confirmed delivery be
-- invoiced on its own:
--
--   1. One live invoice per DELIVERY; the "one live invoice per order" index
--      now applies only to whole-order (legacy) invoices, since an order that
--      ships in three deliveries gets three invoices.
--   2. create_invoice_from_delivery(delivery, actor): the delivery's lines at
--      the order's prices, discounts and taxes; quantity = what shipped.
--   3. post_invoice, for a delivery invoice, numbers it and takes the
--      delivery's cost of goods — it does NOT check reservations or deliver
--      stock (that happened at confirmation; doing it again would ship the
--      rest of the order's reservation under this invoice).
--   4. void_invoice, for a delivery invoice, cancels the bill only. It used to
--      put back every unit ever delivered on the ORDER (it looks the moves up
--      by so_id) — for a delivery invoice that would restock goods that left
--      on other deliveries too. The goods have left; bringing them back is a
--      return (P-05). The delivery can be invoiced again.
--   5. rma_invoice_cogs reports the delivery's recorded cost for such an
--      invoice (it would otherwise cost whatever the order still holds).
--
-- The rewrites change only the named text in the live definitions and refuse
-- unless they find it exactly as expected; each is a no-op once applied.
-- Pinned by src/test/invoiceFromDelivery.test.js;
-- supabase/tests/invoice_from_delivery.sql is the rolled-back reference script.
-- ============================================================================

-- ── 1. one live invoice per delivery ─────────────────────────────────────────
DROP INDEX IF EXISTS public.crm_invoices_one_live_per_so_idx;
CREATE UNIQUE INDEX crm_invoices_one_live_per_so_idx ON public.crm_invoices (so_id)
  WHERE so_id IS NOT NULL AND delivery_id IS NULL AND doc_status <> 'cancelled';
CREATE UNIQUE INDEX IF NOT EXISTS crm_invoices_one_live_per_delivery_idx ON public.crm_invoices (delivery_id)
  WHERE delivery_id IS NOT NULL AND doc_status <> 'cancelled';

-- ── 2. create_invoice_from_delivery ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_invoice_from_delivery(p_delivery_id uuid, p_actor_email text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_d     public.deliveries;
  v_so    public.sales_orders;
  v_id    uuid := gen_random_uuid();
  v_src   jsonb;
  v_w     record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authorized to invoice a delivery' USING ERRCODE = 'P0001';
  END IF;

  -- delivery first, then its order: the order confirm_delivery locks them in
  SELECT * INTO v_d FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery % not found', p_delivery_id USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_so FROM public.sales_orders WHERE id = v_d.sales_order_id FOR UPDATE;

  -- who may invoice it: as convert_so_to_invoice (manager+, or the order's rep)
  IF NOT COALESCE(
       public.rma_is_manager_or_above()
       OR (public.rma_user_role() = 'sales_rep'
           AND (v_so.assigned_rep = v_actor OR v_so.created_by = v_actor)),
       false) THEN
    RAISE EXCEPTION 'Not authorized to invoice this delivery' USING ERRCODE = 'P0001';
  END IF;

  IF v_d.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Only a confirmed delivery can be invoiced (this one is %)', v_d.status USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM public.crm_invoices WHERE delivery_id = p_delivery_id AND doc_status <> 'cancelled') THEN
    RAISE EXCEPTION 'This delivery has already been invoiced' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.crm_invoices
    (id, so_id, delivery_id, customer_id, doc_status, payment_status, line_items,
     payment_terms, reference_po, notes, assigned_rep, created_by)
  VALUES (
    v_id, v_so.id, p_delivery_id, v_so.customer_id, 'draft', 'unpaid', '[]'::jsonb,
    v_so.payment_terms, v_so.reference_po, v_so.notes, COALESCE(v_so.assigned_rep, v_actor), v_actor
  );

  -- what shipped, at the order line's price, discount and tax
  SELECT jsonb_agg(jsonb_build_object(
           'product_id', sol.product_id, 'product_name', sol.product_name, 'description', sol.description,
           'qty', dl.qty, 'unit_price', sol.unit_price, 'discount_pct', sol.discount_pct, 'tax_pct', sol.tax_pct)
         ORDER BY sol.line_no)
    INTO v_src
    FROM public.delivery_lines dl
    JOIN public.sales_order_lines sol ON sol.id = dl.sales_order_line_id
   WHERE dl.delivery_id = p_delivery_id;

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'This delivery has no lines to invoice' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_w FROM public._crm_invoice_write_lines(v_id, v_src);

  UPDATE public.crm_invoices SET
    line_items      = v_w.line_items,
    subtotal        = v_w.subtotal,
    discount_amount = v_w.discount_amount,
    tax_amount      = v_w.tax_amount,
    total           = v_w.total
  WHERE id = v_id;

  RETURN v_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.create_invoice_from_delivery(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_from_delivery(uuid, text) TO authenticated, service_role;

-- ── 3. post_invoice: a delivery invoice moves no stock ───────────────────────
DO $$
DECLARE
  v_def  text;
  v_have integer;
  v_so   text := 'IF v_inv.so_id IS NOT NULL THEN';
  v_cogs text := E'  UPDATE public.crm_invoices\n  SET cogs_base       = COALESCE(v_cogs, 0),';
  v_pre  text := E'  -- ── Precondition: the serialized stock this invoice bills must be reserved ──';
BEGIN
  SELECT replace(pg_get_functiondef('public.post_invoice'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%v_inv.delivery_id IS NULL%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_so, ''))) / length(v_so);
  IF v_have <> 3 THEN
    RAISE EXCEPTION 'Refusing to apply: post_invoice has % order branches, expected 3', v_have;
  END IF;
  IF strpos(v_def, v_cogs) = 0 OR strpos(v_def, v_pre) = 0
     OR (length(v_def) - length(replace(v_def, v_cogs, ''))) / length(v_cogs) <> 1
     OR (length(v_def) - length(replace(v_def, v_pre, ''))) / length(v_pre) <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: post_invoice does not read as expected';
  END IF;
  v_def := replace(v_def, v_so, 'IF v_inv.so_id IS NOT NULL AND v_inv.delivery_id IS NULL THEN');
  v_def := replace(v_def, v_pre,
       E'  -- 20260896: an invoice for a delivery bills goods that already left when\n'
    || E'  -- the delivery was confirmed; its cost is what that delivery recorded.\n'
    || E'  -- Every stock branch below is for whole-order invoices only.\n'
    || E'  IF v_inv.delivery_id IS NOT NULL\n'
    || E'     AND NOT EXISTS (SELECT 1 FROM public.deliveries WHERE id = v_inv.delivery_id AND status = ''confirmed'') THEN\n'
    || E'    RAISE EXCEPTION ''Cannot post this invoice: its delivery is not confirmed'' USING ERRCODE = ''P0001'';\n'
    || E'  END IF;\n\n'
    || v_pre);
  v_def := replace(v_def, v_cogs,
       E'  IF v_inv.delivery_id IS NOT NULL THEN\n'
    || E'    SELECT COALESCE(SUM(dl.cogs_base), 0), COALESCE(SUM(dl.cogs_unknown_qty), 0)::integer\n'
    || E'      INTO v_cogs, v_unknown\n'
    || E'      FROM public.delivery_lines dl WHERE dl.delivery_id = v_inv.delivery_id;\n'
    || E'  END IF;\n\n'
    || v_cogs);
  EXECUTE v_def;
END $$;

-- ── 4. void_invoice: a delivery invoice restocks nothing ─────────────────────
DO $$
DECLARE
  v_def  text;
  v_have integer;
  v_so   text := 'IF v_inv.so_id IS NOT NULL THEN';
BEGIN
  SELECT replace(pg_get_functiondef('public.void_invoice'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%v_inv.delivery_id IS NULL%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_so, ''))) / length(v_so);
  IF v_have <> 2 THEN
    RAISE EXCEPTION 'Refusing to apply: void_invoice has % order branches, expected 2', v_have;
  END IF;
  -- Both branches find the order's deliver moves by so_id; for an invoice of
  -- one delivery that is every delivery on the order. The goods left on a
  -- delivery and come back only by a return (P-05).
  EXECUTE replace(v_def, v_so, 'IF v_inv.so_id IS NOT NULL AND v_inv.delivery_id IS NULL THEN');
END $$;

-- ── 5. rma_invoice_cogs: a delivery invoice costs what its delivery recorded ─
DO $$
DECLARE
  v_def  text;
  v_have integer;
  v_old  text := E'  IF v_inv.so_id IS NULL THEN\n    RETURN QUERY SELECT 0::numeric, 0;\n    RETURN;\n  END IF;';
BEGIN
  SELECT replace(pg_get_functiondef('public.rma_invoice_cogs'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%v_inv.delivery_id IS NOT NULL%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: rma_invoice_cogs has its no-order branch % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_old
    || E'\n\n  -- 20260896: an invoice for a delivery costs what that delivery recorded\n'
    || E'  IF v_inv.delivery_id IS NOT NULL THEN\n'
    || E'    RETURN QUERY SELECT round(COALESCE(SUM(dl.cogs_base), 0), 2), COALESCE(SUM(dl.cogs_unknown_qty), 0)::integer\n'
    || E'      FROM public.delivery_lines dl WHERE dl.delivery_id = v_inv.delivery_id;\n'
    || E'    RETURN;\n'
    || E'  END IF;');
END $$;

-- ── 6. review of the first version ───────────────────────────────────────────
-- (a) restore_units proved "this document delivered the unit" through the
--     invoice's order. With one invoice per delivery that is every delivery on
--     the order: a return against delivery A's invoice could put back a unit
--     that left on delivery B, which would then still be billed. For an invoice
--     of a delivery (or a credit note on one) the unit must be one that
--     delivery shipped.
DO $$
DECLARE
  v_def  text;
  v_pairs text[][] := ARRAY[
    ARRAY[E'  v_so_id    uuid;\n', E'  v_so_id    uuid;\n  v_delivery_id uuid;   -- 20260896\n'],
    ARRAY[E'    SELECT i.so_id INTO v_so_id\n      FROM public.credit_notes cn',
          E'    SELECT i.so_id, i.delivery_id INTO v_so_id, v_delivery_id\n      FROM public.credit_notes cn'],
    ARRAY[E'    SELECT i.so_id INTO v_so_id FROM public.crm_invoices i WHERE i.id = p_doc_id;',
          E'    SELECT i.so_id, i.delivery_id INTO v_so_id, v_delivery_id FROM public.crm_invoices i WHERE i.id = p_doc_id;'],
    ARRAY[E'              AND iu.reservation_status = ''delivered''\n         );',
          E'              AND iu.reservation_status = ''delivered''\n         )\n'
       || E'      -- 20260896: an invoice of one delivery vouches only for what that delivery shipped\n'
       || E'      OR (v_delivery_id IS NOT NULL AND NOT EXISTS (\n'
       || E'           SELECT 1 FROM public.delivery_line_units dlu\n'
       || E'             JOIN public.delivery_lines dl ON dl.id = dlu.delivery_line_id\n'
       || E'            WHERE dl.delivery_id = v_delivery_id AND dlu.unit_id = u.unit_id));']];
  i integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.restore_units'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%v_delivery_id%' THEN
    RETURN;
  END IF;
  FOR i IN 1 .. array_length(v_pairs, 1) LOOP
    IF (length(v_def) - length(replace(v_def, v_pairs[i][1], ''))) / length(v_pairs[i][1]) <> 1 THEN
      RAISE EXCEPTION 'Refusing to apply: restore_units does not read as expected (piece %)', i;
    END IF;
    v_def := replace(v_def, v_pairs[i][1], v_pairs[i][2]);
  END LOOP;
  EXECUTE v_def;
END $$;

-- (b) rma_reservation_integrity skipped an order with ANY invoice; the first
--     delivery invoice then silenced the check for the rest of the order.
--     Only a whole-order invoice ends it now.
DO $$
DECLARE
  v_def text;
  v_old text := 'AND NOT EXISTS (SELECT 1 FROM public.crm_invoices i WHERE i.so_id = so.id);';
BEGIN
  SELECT replace(pg_get_functiondef('public.rma_reservation_integrity'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%i.so_id = so.id AND i.delivery_id IS NULL%' THEN
    RETURN;
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: rma_reservation_integrity does not read as expected';
  END IF;
  EXECUTE replace(v_def, v_old, 'AND NOT EXISTS (SELECT 1 FROM public.crm_invoices i WHERE i.so_id = so.id AND i.delivery_id IS NULL);');
END $$;

-- (c) cost of goods is for managers and accountants (as the delivery unit and
--     bin tables are); rma_invoice_cogs let any staff role read it. Its only
--     caller is post_invoice, which runs as a manager.
DO $$
DECLARE
  v_def text;
  v_old text := '  IF NOT public.rma_is_staff() THEN';
BEGIN
  SELECT replace(pg_get_functiondef('public.rma_invoice_cogs'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%rma_user_role() = ''accountant''%' THEN
    RETURN;
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: rma_invoice_cogs does not read as expected';
  END IF;
  EXECUTE replace(v_def, v_old, '  IF NOT COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = ''accountant'', false) THEN');
END $$;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.create_invoice_from_delivery(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: anon can invoice a delivery';
  END IF;
  IF pg_get_functiondef('public.post_invoice'::regproc) NOT LIKE '%v_inv.delivery_id IS NULL%'
     OR pg_get_functiondef('public.void_invoice'::regproc) NOT LIKE '%v_inv.delivery_id IS NULL%'
     OR pg_get_functiondef('public.rma_invoice_cogs'::regproc) NOT LIKE '%v_inv.delivery_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'Refusing to finish: post_invoice, void_invoice or rma_invoice_cogs was not updated';
  END IF;
  IF pg_get_functiondef('public.restore_units'::regproc) NOT LIKE '%v_delivery_id IS NOT NULL AND NOT EXISTS%'
     OR pg_get_functiondef('public.rma_reservation_integrity'::regproc) NOT LIKE '%i.so_id = so.id AND i.delivery_id IS NULL%'
     OR pg_get_functiondef('public.rma_invoice_cogs'::regproc) NOT LIKE '%rma_user_role() = ''accountant''%' THEN
    RAISE EXCEPTION 'Refusing to finish: the review fixes (restore_units, integrity, cost access) did not apply';
  END IF;
END $$;
