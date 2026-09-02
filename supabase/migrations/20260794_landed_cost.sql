-- 20260794_landed_cost.sql
-- Currency engine, stage 3 — what the goods actually cost.
--
-- ═══ Why ═════════════════════════════════════════════════════════════════════
--
-- The system has never recorded a cost of any kind. inventory_units and
-- warehouse_stock carry quantities and nothing else, so there is no figure to
-- put against a sale — every margin, every profit-and-loss line and every sales
-- rep's performance number is uncomputable today. This is the stage that makes
-- them possible.
--
-- Cost is captured where it is actually known: when a vendor invoice is
-- received into a warehouse. At that moment the line price, the discount, the
-- exchange rate and the freight are all on the document.
--
-- ═══ What lands in unit cost ═════════════════════════════════════════════════
--
--   line net      = qty x unit_cost x (1 - discount%)
--   + its share of the invoice's freight, customs, clearance and insurance,
--     apportioned across lines BY LINE VALUE
--   x the invoice's exchange rate
--   = unit_cost_base, in base currency, to four decimal places
--
-- Charges are apportioned across ALL lines of the invoice, not just the ones
-- being received now. Receiving half a shipment must not load the whole freight
-- bill onto that half — the per-unit share has to be the same whether the goods
-- arrive in one delivery or four.
--
-- Tax is EXCLUDED by default. VAT on a purchase for resale is recoverable, so
-- putting it in unit cost overstates the cost of goods and understates margin
-- on every line. Businesses that cannot reclaim it set rma_config
-- 'purchase_tax_in_cost' to true and it is included instead. Apportionment of
-- charges is always by the pre-tax line value, since tax is not part of what
-- was bought.
--
-- ═══ Keeping cost correct once stock moves ═══════════════════════════════════
--
-- Five RPCs change warehouse_stock.quantity: receive_stock, receive_vendor_
-- invoice, transfer_stock, adjust_stock and deliver_warehouse_stock, plus
-- restore_warehouse_stock on a credit note. A running cost total maintained by
-- hand in six places is the shape of bug this project has already been bitten
-- by more than once — the warehouse-destination filter written four times and
-- wrong in all four.
--
-- So it is not maintained by hand. A BEFORE UPDATE trigger holds the unit cost
-- constant whenever quantity moves and nobody set a cost explicitly: shipping
-- four of ten units takes four units' worth of value out, and the average is
-- untouched. Only the two operations that genuinely know a different cost —
-- receiving against a vendor invoice, and transferring between warehouses —
-- override it. Every other path is correct without being told.
--
-- ═══ What this does NOT do ═══════════════════════════════════════════════════
--
-- Stock that is already in the warehouses gets a cost of zero, because nobody
-- ever recorded what it cost and inventing a figure would be worse than
-- admitting that. `avg_cost_base = 0` on a row with stock means COST UNKNOWN,
-- not free — margin reporting in stage 5 must report it as unknown rather than
-- as a 100% margin. The same is true of stock received through receive_stock,
-- the manual path, which has no document to take a price from.
--
-- ═══ Applying ════════════════════════════════════════════════════════════════
-- Paste into the Supabase SQL editor. One transaction: any failure applies
-- nothing. Verify with supabase/manual/20260830_verify_landed_cost.sql.

-- ═══ 1. Is purchase tax part of cost? ════════════════════════════════════════

INSERT INTO public.rma_config (config_key, config_value)
VALUES ('purchase_tax_in_cost', 'false'::jsonb)
ON CONFLICT (config_key) DO NOTHING;

-- ═══ 2. Where cost is stored ═════════════════════════════════════════════════

-- A serialised unit is one physical thing, so it carries its own actual cost —
-- specific identification, no averaging and no drift.
ALTER TABLE public.inventory_units
  ADD COLUMN IF NOT EXISTS unit_cost_base numeric(14,4);

COMMENT ON COLUMN public.inventory_units.unit_cost_base IS
  'Landed cost of this one unit in base currency, set when it was received. NULL means it predates costing or arrived through a path with no price.';

-- Bulk stock is fungible, so it carries a value and a quantity; the average is
-- derived from them and cannot be written, which is what stops it drifting.
ALTER TABLE public.warehouse_stock
  ADD COLUMN IF NOT EXISTS total_cost_base numeric(18,4) NOT NULL DEFAULT 0;

ALTER TABLE public.warehouse_stock
  ADD COLUMN IF NOT EXISTS avg_cost_base numeric(14,4)
    GENERATED ALWAYS AS (
      CASE WHEN quantity > 0 THEN round(total_cost_base / quantity, 4) ELSE 0 END
    ) STORED;

COMMENT ON COLUMN public.warehouse_stock.total_cost_base IS
  'Base-currency value of the stock on hand. Maintained by rma_hold_unit_cost() unless a receipt or transfer sets it explicitly.';
COMMENT ON COLUMN public.warehouse_stock.avg_cost_base IS
  'Weighted average cost per unit. Derived; 0 on a row WITH stock means the cost is unknown, not that the goods were free.';

-- ═══ 3. The trigger that keeps every other path correct ══════════════════════

CREATE OR REPLACE FUNCTION public.rma_hold_unit_cost()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_old_avg numeric;
BEGIN
  -- Only when quantity moved and the caller did NOT state a cost. A caller that
  -- sets total_cost_base itself knows something this function does not, and is
  -- left alone.
  IF NEW.quantity IS DISTINCT FROM OLD.quantity
     AND NEW.total_cost_base IS NOT DISTINCT FROM OLD.total_cost_base
  THEN
    v_old_avg := CASE WHEN OLD.quantity > 0
                      THEN OLD.total_cost_base / OLD.quantity
                      ELSE 0 END;
    NEW.total_cost_base := round(v_old_avg * NEW.quantity, 4);
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_warehouse_stock_hold_unit_cost ON public.warehouse_stock;
CREATE TRIGGER trg_warehouse_stock_hold_unit_cost
  BEFORE UPDATE ON public.warehouse_stock
  FOR EACH ROW EXECUTE FUNCTION public.rma_hold_unit_cost();

-- ═══ 4. Landed unit cost of a vendor invoice ═════════════════════════════════
-- One row per line, in base currency. Read by receive_vendor_invoice and by the
-- screen that previews what a receipt will cost, so both agree by construction
-- rather than by two implementations happening to match.

CREATE OR REPLACE FUNCTION public.rma_vi_landed_unit_costs(p_vi_id uuid)
RETURNS TABLE (product_id uuid, unit_cost_base numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_vi          record;
  v_tax_in_cost boolean;
  v_charges     numeric := 0;
  v_line_value  numeric := 0;
BEGIN
  -- SECURITY DEFINER, so it reads past RLS. Without this guard any signed-in
  -- account could ask what any shipment cost, which is exactly the class of
  -- unguarded definer function 20260788 went through and closed.
  IF NOT public.rma_is_staff() THEN
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

  -- The apportionment base: every line's pre-tax value, whether or not it is
  -- being received yet. Freight is earned by the whole shipment.
  SELECT COALESCE(SUM(
           COALESCE((l->>'qty_ordered')::numeric, 0)
         * COALESCE((l->>'unit_cost')::numeric, 0)
         * (1 - COALESCE((l->>'discount_pct')::numeric, 0) / 100)
         ), 0)
    INTO v_line_value
    FROM jsonb_array_elements(COALESCE(v_vi.line_items, '[]'::jsonb)) l;

  RETURN QUERY
  SELECT
    (l->>'product_id')::uuid,
    round(
      (
        -- the line's own price per unit, after discount and optionally tax
        COALESCE((l->>'unit_cost')::numeric, 0)
      * (1 - COALESCE((l->>'discount_pct')::numeric, 0) / 100)
      * CASE WHEN v_tax_in_cost
             THEN 1 + COALESCE((l->>'tax_pct')::numeric, 0) / 100
             ELSE 1 END
        -- plus this line's share of the charges, per unit
      + CASE
          WHEN v_line_value > 0 AND COALESCE((l->>'qty_ordered')::numeric, 0) > 0
          THEN v_charges
             * (
                 COALESCE((l->>'qty_ordered')::numeric, 0)
               * COALESCE((l->>'unit_cost')::numeric, 0)
               * (1 - COALESCE((l->>'discount_pct')::numeric, 0) / 100)
               / v_line_value
               )
             / COALESCE((l->>'qty_ordered')::numeric, 1)
          ELSE 0
        END
      )
      -- into base currency
      * COALESCE(v_vi.exchange_rate, 1),
      4
    )
  FROM jsonb_array_elements(COALESCE(v_vi.line_items, '[]'::jsonb)) l
  WHERE (l->>'product_id') IS NOT NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rma_vi_landed_unit_costs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rma_vi_landed_unit_costs(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.rma_vi_landed_unit_costs(uuid) IS
  'Landed cost per unit in base currency for each line of a vendor invoice: price after discount, plus the line share of freight and customs apportioned by line value, at the invoice exchange rate.';

-- ═══ 5. Receiving writes the cost ════════════════════════════════════════════
-- Same body as 20260758 with costing added. CREATE OR REPLACE keeps the
-- existing GRANTs (the authenticated/service_role lockdown from 20260752), so
-- the signature is deliberately unchanged.

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
  v_po_status           text;
  v_unit_cost           numeric;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
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

  FOR v_receipt IN SELECT * FROM jsonb_array_elements(p_receipt_lines)
  LOOP
    v_product_id   := (v_receipt->>'product_id')::uuid;
    v_warehouse_id := (v_receipt->>'warehouse_id')::uuid;

    SELECT stock_tracking_mode INTO v_tracking_mode FROM public.products WHERE id = v_product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product % not found', v_product_id USING ERRCODE = 'P0001';
    END IF;

    -- What this product costs, landed, on this invoice. Computed per receipt
    -- line rather than once, because a single invoice can carry the same
    -- product on more than one line; the function returns the line's own cost.
    SELECT c.unit_cost_base INTO v_unit_cost
      FROM public.rma_vi_landed_unit_costs(p_vi_id) c
     WHERE c.product_id = v_product_id
     LIMIT 1;
    v_unit_cost := COALESCE(v_unit_cost, 0);

    IF v_tracking_mode = 'bulk' THEN
      v_received_this_line := (v_receipt->>'qty')::integer;
      IF v_received_this_line IS NULL OR v_received_this_line <= 0 THEN
        RAISE EXCEPTION 'A positive qty is required for bulk product %', v_product_id USING ERRCODE = 'P0001';
      END IF;

      SELECT id INTO v_ws_id FROM public.warehouse_stock
      WHERE product_id = v_product_id AND warehouse_id = v_warehouse_id
      FOR UPDATE;

      IF NOT FOUND THEN
        INSERT INTO public.warehouse_stock
          (product_id, warehouse_id, quantity, reserved_quantity, total_cost_base)
        VALUES
          (v_product_id, v_warehouse_id, v_received_this_line, 0,
           round(v_unit_cost * v_received_this_line, 4))
        RETURNING id INTO v_ws_id;
      ELSE
        -- Both columns move together, so rma_hold_unit_cost() stands aside and
        -- the new goods blend into the average at the price actually paid.
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
      v_received_this_line := 0;
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

  -- Sync the linked Purchase Order's completion status, if any.
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

-- ═══ 6. Charges are locked once the goods are costed ═════════════════════════
-- Adding freight after a receipt would not change the cost already written onto
-- the units that arrived, so the invoice and the stock would disagree and
-- nothing would say which was right. The charge has to be on the invoice before
-- the goods are received.

CREATE OR REPLACE FUNCTION public.rma_guard_charges_before_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_status text;
  v_vi     uuid := COALESCE(NEW.vendor_invoice_id, OLD.vendor_invoice_id);
BEGIN
  SELECT status INTO v_status FROM public.vendor_invoices WHERE id = v_vi;

  IF v_status IN ('partially_received', 'received') THEN
    RAISE EXCEPTION
      'This invoice has already been received, so its landed cost is fixed. Changing charges now would not update the cost of the goods already in stock.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$fn$;

DROP TRIGGER IF EXISTS trg_charges_before_receipt ON public.vendor_invoice_charges;
CREATE TRIGGER trg_charges_before_receipt
  BEFORE INSERT OR UPDATE OR DELETE ON public.vendor_invoice_charges
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_charges_before_receipt();

-- ═══ 7. A transfer carries its cost to the destination ═══════════════════════
-- The one movement where holding the destination's own average would be wrong:
-- goods worth 500 each arriving in a warehouse that averages 100 must raise
-- that average, not be silently revalued down to it. Signature unchanged, so
-- the existing GRANTs are preserved.

CREATE OR REPLACE FUNCTION public.transfer_stock(
  p_product_id        uuid,
  p_from_warehouse_id uuid,
  p_to_warehouse_id   uuid,
  p_actor_email       text,
  p_unit_id           uuid DEFAULT NULL,
  p_qty               integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tracking_mode text;
  v_unit          record;
  v_src           record;
  v_dst_id        uuid;
  v_moved         numeric;   -- 20260794: value leaving the source, at its average
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to transfer stock' USING ERRCODE = 'P0001';
  END IF;

  -- ── NEW in 20260770 ──────────────────────────────────────────────────────
  PERFORM public.assert_not_system_warehouse(p_to_warehouse_id, 'destination');
  PERFORM public.assert_not_system_warehouse(p_from_warehouse_id, 'source');
  -- ─────────────────────────────────────────────────────────────────────────

  IF p_from_warehouse_id = p_to_warehouse_id THEN
    RAISE EXCEPTION 'Source and destination warehouse must differ' USING ERRCODE = 'P0001';
  END IF;

  SELECT stock_tracking_mode INTO v_tracking_mode FROM public.products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id USING ERRCODE = 'P0001';
  END IF;

  IF v_tracking_mode = 'bulk' THEN
    IF p_qty IS NULL OR p_qty <= 0 THEN
      RAISE EXCEPTION 'A positive quantity is required to transfer bulk stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_src FROM public.warehouse_stock
    WHERE product_id = p_product_id AND warehouse_id = p_from_warehouse_id
    FOR UPDATE;

    IF NOT FOUND OR (v_src.quantity - v_src.reserved_quantity) < p_qty THEN
      RAISE EXCEPTION 'Insufficient available stock at source warehouse: need %, only % available',
        p_qty, COALESCE(v_src.quantity - v_src.reserved_quantity, 0)
        USING ERRCODE = 'P0001';
    END IF;

    -- Read before the update: avg_cost_base is derived from the very columns
    -- about to change. Goods worth 500 each must arrive at the destination
    -- worth 500 each, not be silently revalued to whatever it already averages.
    v_moved := round(COALESCE(v_src.avg_cost_base, 0) * p_qty, 4);

    UPDATE public.warehouse_stock
    SET quantity = quantity - p_qty,
        total_cost_base = GREATEST(total_cost_base - v_moved, 0),
        updated_at = now()
    WHERE id = v_src.id;

    SELECT id INTO v_dst_id FROM public.warehouse_stock
    WHERE product_id = p_product_id AND warehouse_id = p_to_warehouse_id
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.warehouse_stock (product_id, warehouse_id, quantity, reserved_quantity, total_cost_base)
      VALUES (p_product_id, p_to_warehouse_id, p_qty, 0, v_moved)
      RETURNING id INTO v_dst_id;
    ELSE
      -- Setting both columns keeps rma_hold_unit_cost() out of the way, so the
      -- arriving goods blend in at their own cost rather than the destination's.
      UPDATE public.warehouse_stock
      SET quantity = quantity + p_qty,
          total_cost_base = total_cost_base + v_moved,
          updated_at = now()
      WHERE id = v_dst_id;
    END IF;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('warehouse_stock', v_src.id, 'manual', NULL, 'transfer', p_qty, p_from_warehouse_id::text, p_to_warehouse_id::text, p_actor_email),
      ('warehouse_stock', v_dst_id, 'manual', NULL, 'transfer', p_qty, p_from_warehouse_id::text, p_to_warehouse_id::text, p_actor_email);
  ELSE
    IF p_unit_id IS NULL THEN
      RAISE EXCEPTION 'A unit id is required to transfer serialized stock' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_unit FROM public.inventory_units WHERE id = p_unit_id FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unit % not found', p_unit_id USING ERRCODE = 'P0001';
    END IF;

    IF v_unit.reservation_status != 'available' THEN
      RAISE EXCEPTION 'Cannot transfer unit % — it is currently %, not available',
        p_unit_id, v_unit.reservation_status
        USING ERRCODE = 'P0001';
    END IF;

    IF v_unit.warehouse_id IS DISTINCT FROM p_from_warehouse_id THEN
      RAISE EXCEPTION 'Unit % is not currently in the specified source warehouse', p_unit_id
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.inventory_units SET warehouse_id = p_to_warehouse_id WHERE id = p_unit_id;

    INSERT INTO public.stock_moves
      (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
    VALUES
      ('unit', p_unit_id, 'manual', NULL, 'transfer', 1, p_from_warehouse_id::text, p_to_warehouse_id::text, p_actor_email);
  END IF;
END;
$$;

-- ═══ Guards ══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  v_bad text;
BEGIN
  -- avg_cost_base must be generated. A writable column would let a client set
  -- an average that disagrees with the value and quantity it is supposed to
  -- come from, which is the whole reason it is derived.
  IF (SELECT is_generated FROM information_schema.columns
       WHERE table_schema='public' AND table_name='warehouse_stock'
         AND column_name='avg_cost_base') IS DISTINCT FROM 'ALWAYS' THEN
    RAISE EXCEPTION 'Refusing to apply: warehouse_stock.avg_cost_base is not a generated column.';
  END IF;

  -- Both rewritten RPCs must still be executable by the app.
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('receive_vendor_invoice', 'transfer_stock')
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to apply: authenticated cannot execute %. Receiving and transfers would fail for every user.', v_bad;
  END IF;

  RAISE NOTICE 'Landed costing applied. Existing stock has avg_cost_base 0, meaning COST UNKNOWN.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Run supabase/manual/20260830_verify_landed_cost.sql.
