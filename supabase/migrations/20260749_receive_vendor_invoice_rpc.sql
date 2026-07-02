-- ═══════════════════════════════════════════════════════════════════════════
--  Sprint 9 — receive_vendor_invoice (atomic, dual-mode)
--
--  Replaces Sprint 8's interim manual receive_stock as the permanent,
--  auditable path for new stock: every unit/quantity received here traces
--  back to a specific vendor_invoices.id.
--
--  p_receipt_lines shape (jsonb array), one element per product being
--  received in this call:
--    serialized: {"product_id": "...", "warehouse_id": "...", "serials": ["SN1","SN2"]}
--    bulk:       {"product_id": "...", "warehouse_id": "...", "qty": 10}
--  (branches on the product's stock_tracking_mode, same convention as
--  Sprint 8's receive_stock — extended here since Sprint 9 was originally
--  specced serial-only, before the bulk-tracking mode existed)
--
--  - Locks the VI row FOR UPDATE, requires status IN ('confirmed',
--    'partially_received'), enforces rma_is_manager_or_above()
--  - Rejects any serial that's already a live unit (Sprint 7.6 §4 — the
--    partial unique index on serial_number does this automatically; caught
--    here for a friendly per-serial error instead of a raw 23505)
--  - Increments each line's qty_received in vendor_invoices.line_items
--    (JSONB rebuilt via jsonb_agg — arrays preserve order, unlike objects)
--  - Assigns vi_code via nextval_for_type('vendor_invoice') only on the
--    FIRST receipt (idempotent — a later partial receipt reuses the code)
--  - Status becomes 'received' once every line's qty_received >= qty_ordered,
--    else 'partially_received' (Sprint 9 audit A8 — multi-shipment receiving)
--  - One transaction: either the whole receipt call lands, or none of it does
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.receive_vendor_invoice(
  p_vi_id         uuid,
  p_receipt_lines jsonb,
  p_actor_email   text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vi                 record;
  v_receipt             jsonb;
  v_product_id          uuid;
  v_warehouse_id        uuid;
  v_tracking_mode       text;
  v_serial              text;
  v_unit_id             uuid;
  v_ws_id               uuid;
  v_received_this_line  integer;
  v_receipt_totals      jsonb := '[]'::jsonb;
  v_final_line_items    jsonb;
  v_all_complete        boolean;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to receive a vendor invoice' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_vi FROM public.vendor_invoices WHERE id = p_vi_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor invoice % not found', p_vi_id USING ERRCODE = 'P0001';
  END IF;
  IF v_vi.status NOT IN ('confirmed', 'partially_received') THEN
    RAISE EXCEPTION 'Vendor invoice must be confirmed before receiving (current status: %)', v_vi.status
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_receipt IN SELECT * FROM jsonb_array_elements(p_receipt_lines)
  LOOP
    v_product_id   := (v_receipt->>'product_id')::uuid;
    v_warehouse_id := (v_receipt->>'warehouse_id')::uuid;

    SELECT stock_tracking_mode INTO v_tracking_mode FROM public.products WHERE id = v_product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product % not found', v_product_id USING ERRCODE = 'P0001';
    END IF;

    IF v_tracking_mode = 'bulk' THEN
      v_received_this_line := (v_receipt->>'qty')::integer;
      IF v_received_this_line IS NULL OR v_received_this_line <= 0 THEN
        RAISE EXCEPTION 'A positive qty is required for bulk product %', v_product_id USING ERRCODE = 'P0001';
      END IF;

      SELECT id INTO v_ws_id FROM public.warehouse_stock
      WHERE product_id = v_product_id AND warehouse_id = v_warehouse_id
      FOR UPDATE;

      IF NOT FOUND THEN
        INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity)
        VALUES (v_product_id, v_warehouse_id, v_received_this_line, 0)
        RETURNING id INTO v_ws_id;
      ELSE
        UPDATE public.warehouse_stock
        SET quantity = quantity + v_received_this_line, updated_at = now()
        WHERE id = v_ws_id;
      END IF;

      INSERT INTO public.stock_moves
        (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
      VALUES
        ('warehouse_stock', v_ws_id, 'vendor_invoice', p_vi_id, 'receive', v_received_this_line, NULL, 'available', p_actor_email);
    ELSE
      v_received_this_line := 0;
      FOR v_serial IN SELECT jsonb_array_elements_text(COALESCE(v_receipt->'serials', '[]'::jsonb))
      LOOP
        BEGIN
          INSERT INTO public.inventory_units
            (product_id, product_name, serial_number, status, reservation_status, warehouse_id, vendor_invoice_id, created_date)
          SELECT v_product_id, p.product_name, v_serial, 'company_stock', 'available', v_warehouse_id, p_vi_id, now()
          FROM public.products p WHERE p.id = v_product_id
          RETURNING id INTO v_unit_id;
        EXCEPTION WHEN unique_violation THEN
          RAISE EXCEPTION 'Serial number % is already in use', v_serial USING ERRCODE = 'P0001';
        END;

        INSERT INTO public.stock_moves
          (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
        VALUES
          ('unit', v_unit_id, 'vendor_invoice', p_vi_id, 'receive', 1, NULL, 'available', p_actor_email);

        v_received_this_line := v_received_this_line + 1;
      END LOOP;
    END IF;

    v_receipt_totals := v_receipt_totals ||
      jsonb_build_object('product_id', v_product_id::text, 'received', v_received_this_line);
  END LOOP;

  -- Fold each receipt's received qty onto the matching line's qty_received.
  -- Lines with no matching receipt this call are left untouched.
  SELECT jsonb_agg(
    CASE
      WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_receipt_totals) r WHERE r->>'product_id' = line->>'product_id')
      THEN jsonb_set(
        line,
        '{qty_received}',
        to_jsonb(
          COALESCE((line->>'qty_received')::integer, 0) +
          (SELECT SUM((r->>'received')::integer) FROM jsonb_array_elements(v_receipt_totals) r
           WHERE r->>'product_id' = line->>'product_id')
        )
      )
      ELSE line
    END
  )
  INTO v_final_line_items
  FROM jsonb_array_elements(v_vi.line_items) line;

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
END;
$$;
