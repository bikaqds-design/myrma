-- ============================================================================
-- 20260882_costing_cleanup.sql
-- Backlog BL-09 / I-07 — every item has a real cost, or admits it has none.
--
-- BEFORE (measured on the code, not assumed)
--   * receive_vendor_invoice looked a line's cost up BY PRODUCT with LIMIT 1.
--     An invoice that carries the same product on two lines (two prices, two
--     shipments) costed BOTH receipts at whichever line came first, and folded
--     both received quantities onto every line for that product.
--   * A product that was not on the invoice at all could be received against it,
--     silently costed at zero.
--   * A line with no price was costed COALESCE(..., 0): a serial unit got
--     unit_cost_base = 0 and a bulk receipt blended zero-cost goods into the
--     bin's weighted average, so margin looked like profit. Zero is a claim;
--     an unknown is not. (20260795 already taught manual receipts and the
--     average to tell the two apart; this receipt path had not caught up.)
--   * Received quantity was not bounded by what the line ordered.
--   * Nothing listed the stock that still has no cost, and the opening-cost
--     function took one product and one warehouse per call.
--
-- AFTER
--   * rma_vi_landed_unit_costs returns one row per LINE (line_index), and
--     unit_cost_base is NULL for a line with no price.
--   * receive_vendor_invoice takes an optional line_index per receipt line. With
--     none, a product on exactly one line resolves to it; a product on several
--     lines, or on none, is refused with a message that says so. What is
--     received can never exceed what the line still has open, across every
--     entry in the same call. Unknown cost is recorded as unknown: NULL on the
--     unit, uncosted_quantity on the bin. Received quantities fold by line.
--   * rma_uncosted_stock() lists what still has no cost (the worklist).
--   * rma_import_opening_costs(rows) values many product/warehouse pairs in one
--     call and reports each row's outcome, so one bad row does not hide the rest.
--
-- SCOPE NOTE: the app's receive screen sends line_index from this migration's
-- companion change; an older client that omits it still works whenever a
-- product sits on one line, which is every invoice that worked before.
-- ============================================================================

-- ── 1. the landed cost, per line ────────────────────────────────────────────
-- The return type changes (line_index, and a NULL cost), so it is dropped and
-- recreated; the grants are put back below.
DROP FUNCTION IF EXISTS public.rma_vi_landed_unit_costs(uuid);

CREATE FUNCTION public.rma_vi_landed_unit_costs(p_vi_id uuid)
RETURNS TABLE (line_index integer, product_id uuid, unit_cost_base numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_vi          record;
  v_tax_in_cost boolean;
  v_charges     numeric := 0;
  v_line_value  numeric := 0;
BEGIN
  IF NOT COALESCE(public.rma_is_staff(), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_vi FROM public.vendor_invoices WHERE id = p_vi_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor invoice % not found', p_vi_id USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE((config_value #>> '{}')::boolean, false) INTO v_tax_in_cost
    FROM public.rma_config WHERE config_key = 'purchase_tax_in_cost';
  v_tax_in_cost := COALESCE(v_tax_in_cost, false);

  SELECT COALESCE(SUM(amount), 0) INTO v_charges
    FROM public.vendor_invoice_charges WHERE vendor_invoice_id = p_vi_id;

  -- Freight is earned by the whole shipment: apportion over every priced line,
  -- received yet or not.
  SELECT COALESCE(SUM(
           COALESCE((l->>'qty_ordered')::numeric, 0)
         * COALESCE((l->>'unit_cost')::numeric, 0)
         * (1 - COALESCE((l->>'discount_pct')::numeric, 0) / 100)
         ), 0)
    INTO v_line_value
    FROM jsonb_array_elements(COALESCE(v_vi.line_items, '[]'::jsonb)) l;

  RETURN QUERY
  SELECT
    (t.ord - 1)::integer,
    (t.l->>'product_id')::uuid,
    CASE
      -- No price on the line: the cost is UNKNOWN, not a price of nothing plus a
      -- share of the freight.
      WHEN COALESCE((t.l->>'unit_cost')::numeric, 0) <= 0 THEN NULL
      ELSE round(
        (
          COALESCE((t.l->>'unit_cost')::numeric, 0)
        * (1 - COALESCE((t.l->>'discount_pct')::numeric, 0) / 100)
        * CASE WHEN v_tax_in_cost
               THEN 1 + COALESCE((t.l->>'tax_pct')::numeric, 0) / 100
               ELSE 1 END
        + CASE
            WHEN v_line_value > 0 AND COALESCE((t.l->>'qty_ordered')::numeric, 0) > 0
            THEN v_charges
               * (
                   COALESCE((t.l->>'qty_ordered')::numeric, 0)
                 * COALESCE((t.l->>'unit_cost')::numeric, 0)
                 * (1 - COALESCE((t.l->>'discount_pct')::numeric, 0) / 100)
                 / v_line_value
                 )
               / COALESCE((t.l->>'qty_ordered')::numeric, 1)
            ELSE 0
          END
        )
        * COALESCE(v_vi.exchange_rate, 1),
        4)
    END
  FROM jsonb_array_elements(COALESCE(v_vi.line_items, '[]'::jsonb)) WITH ORDINALITY AS t(l, ord)
  WHERE (t.l->>'product_id') IS NOT NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rma_vi_landed_unit_costs(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_vi_landed_unit_costs(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.rma_vi_landed_unit_costs(uuid) IS
  'Landed unit cost in base currency, one row per invoice line (line_index is 0-based). NULL means the line carries no price: unknown, never zero.';

-- ── 2. receiving an invoice ─────────────────────────────────────────────────
-- Same signature as before, so CREATE OR REPLACE keeps the grants.
CREATE OR REPLACE FUNCTION public.receive_vendor_invoice(
  p_vi_id         uuid,
  p_receipt_lines jsonb,
  p_actor_email   text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_vi                 record;
  v_receipt            jsonb;
  v_product_id         uuid;
  v_warehouse_id       uuid;
  v_tracking_mode      text;
  v_serial             text;
  v_unit_id            uuid;
  v_ws_id              uuid;
  v_received_this_line integer;
  v_line_idx           integer;
  v_lines              integer;
  v_matches            integer;
  v_open               integer;
  v_taken              jsonb := '{}'::jsonb;   -- line index -> received in THIS call
  v_final_line_items   jsonb;
  v_all_complete       boolean;
  v_po_status          text;
  v_unit_cost          numeric;                -- NULL = unknown
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Not authorized to receive a vendor invoice' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_vi FROM public.vendor_invoices WHERE id = p_vi_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor invoice % not found', p_vi_id USING ERRCODE = 'P0001';
  END IF;
  IF v_vi.status NOT IN ('approved', 'partially_received') THEN
    RAISE EXCEPTION 'Vendor invoice must be approved before receiving (current status: %)', v_vi.status
      USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_receipt_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Receipt lines must be a list' USING ERRCODE = 'P0001';
  END IF;

  v_lines := jsonb_array_length(COALESCE(v_vi.line_items, '[]'::jsonb));

  FOR v_receipt IN SELECT * FROM jsonb_array_elements(p_receipt_lines)
  LOOP
    v_product_id   := (v_receipt->>'product_id')::uuid;
    v_warehouse_id := (v_receipt->>'warehouse_id')::uuid;

    SELECT stock_tracking_mode INTO v_tracking_mode FROM public.products WHERE id = v_product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product % not found', v_product_id USING ERRCODE = 'P0001';
    END IF;

    -- Which invoice line this receipt belongs to.
    IF v_receipt ? 'line_index' AND jsonb_typeof(v_receipt->'line_index') = 'number' THEN
      v_line_idx := (v_receipt->>'line_index')::integer;
      IF v_line_idx < 0 OR v_line_idx >= v_lines
         OR (v_vi.line_items->v_line_idx->>'product_id') IS DISTINCT FROM v_product_id::text THEN
        RAISE EXCEPTION 'Line % of this invoice is not product %', v_line_idx + 1, v_product_id
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      SELECT count(*)::integer, min(t.ord - 1)::integer INTO v_matches, v_line_idx
        FROM jsonb_array_elements(v_vi.line_items) WITH ORDINALITY AS t(l, ord)
       WHERE t.l->>'product_id' = v_product_id::text;
      IF v_matches = 0 THEN
        RAISE EXCEPTION 'Product % is not on this vendor invoice, so it cannot be received against it', v_product_id
          USING ERRCODE = 'P0001';
      ELSIF v_matches > 1 THEN
        RAISE EXCEPTION 'Product % is on % lines of this invoice; say which line is being received', v_product_id, v_matches
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    -- This line's own cost (NULL when the line has no price).
    SELECT c.unit_cost_base INTO v_unit_cost
      FROM public.rma_vi_landed_unit_costs(p_vi_id) c
     WHERE c.line_index = v_line_idx;

    IF v_tracking_mode = 'bulk' THEN
      v_received_this_line := (v_receipt->>'qty')::integer;
      IF v_received_this_line IS NULL OR v_received_this_line <= 0 THEN
        RAISE EXCEPTION 'A positive qty is required for bulk product %', v_product_id USING ERRCODE = 'P0001';
      END IF;
    ELSE
      v_received_this_line := jsonb_array_length(COALESCE(v_receipt->'serials', '[]'::jsonb));
    END IF;

    -- Never more than the line still has open, counting earlier entries of this call.
    v_open := COALESCE((v_vi.line_items->v_line_idx->>'qty_ordered')::integer, 0)
            - COALESCE((v_vi.line_items->v_line_idx->>'qty_received')::integer, 0)
            - COALESCE((v_taken->>v_line_idx::text)::integer, 0);
    IF v_received_this_line > v_open THEN
      RAISE EXCEPTION 'Line % of this invoice has only % left to receive, and % were entered', v_line_idx + 1, GREATEST(v_open, 0), v_received_this_line
        USING ERRCODE = 'P0001';
    END IF;

    IF v_tracking_mode = 'bulk' THEN
      SELECT id INTO v_ws_id FROM public.warehouse_stock
      WHERE product_id = v_product_id AND warehouse_id = v_warehouse_id
      FOR UPDATE;

      IF NOT FOUND THEN
        INSERT INTO public.warehouse_stock
          (product_id, warehouse_id, quantity, reserved_quantity, total_cost_base, uncosted_quantity)
        VALUES
          (v_product_id, v_warehouse_id, v_received_this_line, 0,
           CASE WHEN v_unit_cost IS NULL THEN 0 ELSE round(v_unit_cost * v_received_this_line, 4) END,
           CASE WHEN v_unit_cost IS NULL THEN v_received_this_line ELSE 0 END)
        RETURNING id INTO v_ws_id;
      ELSIF v_unit_cost IS NULL THEN
        -- Unknown cost: count the units as unknown instead of letting the bin's
        -- average absorb them. Setting uncosted_quantity keeps rma_hold_unit_cost()
        -- out of the way.
        UPDATE public.warehouse_stock
        SET quantity          = quantity + v_received_this_line,
            uncosted_quantity = uncosted_quantity + v_received_this_line,
            updated_at        = now()
        WHERE id = v_ws_id;
      ELSE
        UPDATE public.warehouse_stock
        SET quantity        = quantity + v_received_this_line,
            total_cost_base = total_cost_base + round(v_unit_cost * v_received_this_line, 4),
            updated_at      = now()
        WHERE id = v_ws_id;
      END IF;

      INSERT INTO public.stock_moves
        (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
      VALUES
        ('warehouse_stock', v_ws_id, 'vendor_invoice', p_vi_id, 'receive', v_received_this_line, NULL, 'available', p_actor_email);
    ELSE
      FOR v_serial IN SELECT jsonb_array_elements_text(COALESCE(v_receipt->'serials', '[]'::jsonb))
      LOOP
        BEGIN
          INSERT INTO public.inventory_units
            (product_id, product_name, serial_number, status, reservation_status, warehouse_id, vendor_invoice_id, unit_cost_base, created_date)
          SELECT v_product_id, p.product_name, v_serial, 'company_stock', 'available', v_warehouse_id, p_vi_id, v_unit_cost, now()
          FROM public.products p WHERE p.id = v_product_id
          RETURNING id INTO v_unit_id;
        EXCEPTION WHEN unique_violation THEN
          RAISE EXCEPTION 'Serial number % is already in use', v_serial USING ERRCODE = 'P0001';
        END;

        INSERT INTO public.stock_moves
          (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
        VALUES
          ('unit', v_unit_id, 'vendor_invoice', p_vi_id, 'receive', 1, NULL, 'available', p_actor_email);
      END LOOP;
    END IF;

    v_taken := jsonb_set(v_taken, ARRAY[v_line_idx::text],
                         to_jsonb(COALESCE((v_taken->>v_line_idx::text)::integer, 0) + v_received_this_line));
  END LOOP;

  -- Fold what was received onto ITS line, by index.
  SELECT jsonb_agg(
    CASE
      WHEN v_taken ? ((t.ord - 1)::text)
      THEN jsonb_set(
             t.line,
             '{qty_received}',
             to_jsonb(COALESCE((t.line->>'qty_received')::integer, 0) + (v_taken->>((t.ord - 1)::text))::integer))
      ELSE t.line
    END
    ORDER BY t.ord)
  INTO v_final_line_items
  FROM jsonb_array_elements(v_vi.line_items) WITH ORDINALITY AS t(line, ord);

  SELECT bool_and(COALESCE((line->>'qty_received')::integer, 0) >= COALESCE((line->>'qty_ordered')::integer, 0))
  INTO v_all_complete
  FROM jsonb_array_elements(v_final_line_items) line;

  UPDATE public.vendor_invoices
  SET
    line_items = v_final_line_items,
    vi_code    = COALESCE(vi_code, public.nextval_for_type('vendor_invoice')),
    status     = CASE WHEN v_all_complete THEN 'received' ELSE 'partially_received' END,
    received_at = COALESCE(received_at, now())
  WHERE id = p_vi_id;

  IF v_vi.purchase_order_id IS NOT NULL THEN
    SELECT status INTO v_po_status FROM public.purchase_orders WHERE id = v_vi.purchase_order_id FOR UPDATE;
    IF v_po_status IS NOT NULL AND v_po_status NOT IN ('cancelled', 'expired') THEN
      UPDATE public.purchase_orders
      SET status = CASE WHEN v_all_complete THEN 'completed' ELSE 'partially_completed' END,
          updated_at = now()
      WHERE id = v_vi.purchase_order_id;
    END IF;
  END IF;
END;
$$;

-- ── 3. the worklist: stock that still has no cost ───────────────────────────
-- Delivered units are not stock on hand (20260874), and only company_stock is
-- sellable stock: RMA-location units are not part of this valuation.
CREATE FUNCTION public.rma_uncosted_stock()
RETURNS TABLE (
  product_id     uuid,
  product_name   text,
  sku            text,
  warehouse_id   uuid,
  warehouse_name text,
  tracking       text,
  uncosted_units integer,
  total_units    integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = 'accountant', false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT p.id, p.product_name, p.sku, w.id, w.name, 'bulk'::text,
         ws.uncosted_quantity, ws.quantity
    FROM public.warehouse_stock ws
    JOIN public.products p   ON p.id = ws.product_id
    JOIN public.warehouses w ON w.id = ws.warehouse_id
   WHERE ws.uncosted_quantity > 0
  UNION ALL
  SELECT u.product_id, COALESCE(p.product_name, u.product_name), p.sku, w.id, w.name, 'serialized'::text,
         count(*) FILTER (WHERE u.unit_cost_base IS NULL)::integer,
         count(*)::integer
    FROM public.inventory_units u
    LEFT JOIN public.products p   ON p.id = u.product_id
    LEFT JOIN public.warehouses w ON w.id = u.warehouse_id
   WHERE u.status = 'company_stock'
     AND u.reservation_status IS DISTINCT FROM 'delivered'
   GROUP BY u.product_id, COALESCE(p.product_name, u.product_name), p.sku, w.id, w.name
  HAVING count(*) FILTER (WHERE u.unit_cost_base IS NULL) > 0
  ORDER BY 2, 5;
END
$fn$;

REVOKE ALL ON FUNCTION public.rma_uncosted_stock() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_uncosted_stock() TO authenticated, service_role;

-- ── 4. opening costs, many at once ──────────────────────────────────────────
-- p_rows: [{"sku": "...", "warehouse": "<code or name>", "unit_cost": 123.45}, ...]
-- Each row runs on its own, through the same function a single valuation uses, so
-- every rule of rma_set_opening_cost applies (manager+, a positive cost, only
-- uncosted stock, a real landed cost is never overwritten). One bad row is
-- reported and skipped; it does not stop the others.
CREATE FUNCTION public.rma_import_opening_costs(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_row     jsonb;
  v_n       integer := 0;
  v_out     jsonb := '[]'::jsonb;
  v_product uuid;
  v_wh      uuid;
  v_cost    numeric;
  v_msg     text;
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Not authorized to set stock costs' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Rows must be a list' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_rows) > 1000 THEN
    RAISE EXCEPTION 'At most 1000 rows per import' USING ERRCODE = 'P0001';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_n := v_n + 1;
    BEGIN
      IF (v_row->>'unit_cost') IS NULL OR (v_row->>'unit_cost') !~ '^[0-9]+(\.[0-9]+)?$' THEN
        RAISE EXCEPTION 'unit_cost must be a positive number' USING ERRCODE = 'P0001';
      END IF;
      v_cost := (v_row->>'unit_cost')::numeric;

      SELECT id INTO v_product FROM public.products
       WHERE lower(btrim(sku)) = lower(btrim(v_row->>'sku')) LIMIT 1;
      IF v_product IS NULL THEN
        RAISE EXCEPTION 'No product with SKU %', COALESCE(v_row->>'sku', '(blank)') USING ERRCODE = 'P0001';
      END IF;

      SELECT id INTO v_wh FROM public.warehouses
       WHERE lower(btrim(code)) = lower(btrim(v_row->>'warehouse'))
          OR lower(btrim(name)) = lower(btrim(v_row->>'warehouse'))
       ORDER BY (lower(btrim(code)) = lower(btrim(v_row->>'warehouse'))) DESC
       LIMIT 1;
      IF v_wh IS NULL THEN
        RAISE EXCEPTION 'No warehouse %', COALESCE(v_row->>'warehouse', '(blank)') USING ERRCODE = 'P0001';
      END IF;

      v_msg := public.rma_set_opening_cost(v_product, v_wh, v_cost);
      v_out := v_out || jsonb_build_object('row', v_n, 'ok', true, 'message', v_msg);
    EXCEPTION WHEN OTHERS THEN
      v_out := v_out || jsonb_build_object('row', v_n, 'ok', false, 'message', SQLERRM);
    END;
  END LOOP;

  RETURN v_out;
END
$fn$;

REVOKE ALL ON FUNCTION public.rma_import_opening_costs(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_import_opening_costs(jsonb) TO authenticated, service_role;

-- ── guard: nothing new is anon-executable ───────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.rma_vi_landed_unit_costs(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_uncosted_stock()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rma_import_opening_costs(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.receive_vendor_invoice(uuid, jsonb, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: a costing function is executable by anon';
  END IF;
END $$;
