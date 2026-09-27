-- ============================================================================
-- 20260897_goods_receipts.sql
-- P-03a — goods receipts: stock arrives when goods arrive against a purchase
-- order, not when the supplier's invoice is received. Design and the owner's
-- decisions: docs/P03_GOODS_RECEIPTS.md.
-- ============================================================================
-- A receipt is one arrival against one confirmed purchase order. A manager
-- prepares it (which PO lines, how many, into which warehouse, the serial
-- numbers scanned for a serialized product) and confirms it: the units are
-- created / the bins filled at the PO line's net price in the base currency,
-- every move is on the ledger under doc_type 'goods_receipt', a gapless
-- GRN-YYYY-NNNNN code is assigned, and the order moves to partially_completed
-- or completed. Invoicing what was received and re-costing it from the
-- supplier's invoice is P-03b.
--
-- Two paths never mix on one order: an order that already received stock on a
-- supplier invoice (receive_vendor_invoice) cannot get receipts, and a supplier
-- invoice whose order has a receipt cannot be received on. An order with a
-- receipt cannot be amended.
--
-- Pinned by src/test/goodsReceipts.test.js; supabase/tests/goods_receipts.sql
-- is the rolled-back reference script.
-- ============================================================================

-- ── 1. numbering: GRN-YYYY-NNNNN ─────────────────────────────────────────────
INSERT INTO public.document_sequences (seq_type, last_value, seq_year)
VALUES ('goods_receipt', 0, EXTRACT(YEAR FROM now())::integer)
ON CONFLICT (seq_type) DO NOTHING;

DO $$
DECLARE
  v_def  text;
  v_old  text := '    WHEN ''delivery''       THEN ''DN''';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.nextval_for_type'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%WHEN ''goods_receipt''%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: nextval_for_type holds the delivery prefix % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_old || E'\n    WHEN ''goods_receipt''  THEN ''GRN''');
END $$;

-- A restore cannot carry document_sequences (20260878 resets them from the
-- codes issued), so the reconciler must know receipts too.
DO $$
DECLARE
  v_def  text;
  v_old  text := '(''delivery'',       ''deliveries'',            ''delivery_code'',  ''DN'')';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.rma_reconcile_document_sequences'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%''goods_receipts''%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: rma_reconcile_document_sequences lists delivery % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_old || E',\n      (''goods_receipt'',  ''goods_receipts'',        ''grn_code'',       ''GRN'')');
END $$;

-- ── 2. the ledger knows receipts ─────────────────────────────────────────────
ALTER TABLE public.stock_moves DROP CONSTRAINT IF EXISTS stock_moves_doc_type_check;
ALTER TABLE public.stock_moves ADD CONSTRAINT stock_moves_doc_type_check CHECK (doc_type = ANY (ARRAY[
  'sales_order', 'invoice', 'credit_note', 'manual', 'vendor_invoice', 'rma_ticket', 'manufacturer_batch', 'goods_receipt']));

-- ── 3. tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.goods_receipts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grn_code           text UNIQUE,
  purchase_order_id  uuid NOT NULL REFERENCES public.purchase_orders(id),
  vendor_id          uuid REFERENCES public.brands(id),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'cancelled')),
  supplier_ref       text,
  notes              text,
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  confirmed_by       text,
  confirmed_at       timestamptz,
  cancelled_by       text,
  cancelled_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS goods_receipts_po_idx ON public.goods_receipts (purchase_order_id);

CREATE TABLE IF NOT EXISTS public.goods_receipt_lines (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_receipt_id        uuid NOT NULL REFERENCES public.goods_receipts(id) ON DELETE CASCADE,
  line_no                 integer NOT NULL,
  purchase_order_line_id  uuid NOT NULL REFERENCES public.purchase_order_lines(id),
  product_id              uuid NOT NULL REFERENCES public.products(id),
  product_name            text NOT NULL,
  qty                     integer NOT NULL CHECK (qty >= 1),
  warehouse_id            uuid NOT NULL REFERENCES public.warehouses(id),
  serials                 text[] NOT NULL DEFAULT '{}',
  unit_cost_base          numeric(14,4),              -- set at confirmation; NULL = unknown
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (goods_receipt_id, line_no),
  UNIQUE (goods_receipt_id, purchase_order_line_id)
);
CREATE INDEX IF NOT EXISTS goods_receipt_lines_po_line_idx ON public.goods_receipt_lines (purchase_order_line_id);

CREATE TABLE IF NOT EXISTS public.goods_receipt_line_units (
  goods_receipt_line_id uuid NOT NULL REFERENCES public.goods_receipt_lines(id) ON DELETE CASCADE,
  unit_id               uuid NOT NULL REFERENCES public.inventory_units(id),
  PRIMARY KEY (goods_receipt_line_id, unit_id)
);
CREATE TABLE IF NOT EXISTS public.goods_receipt_line_bins (
  goods_receipt_line_id uuid NOT NULL REFERENCES public.goods_receipt_lines(id) ON DELETE CASCADE,
  warehouse_stock_id    uuid NOT NULL REFERENCES public.warehouse_stock(id),
  qty                   integer NOT NULL CHECK (qty >= 1),
  PRIMARY KEY (goods_receipt_line_id, warehouse_stock_id)
);

-- where a unit came from
ALTER TABLE public.inventory_units ADD COLUMN IF NOT EXISTS goods_receipt_id uuid REFERENCES public.goods_receipts(id);

COMMENT ON TABLE public.goods_receipts IS
  'An arrival of part or all of a confirmed purchase order (P-03). Stock and its cost arrive at confirm_goods_receipt. Procedure-only: create_goods_receipt / confirm_goods_receipt / cancel_goods_receipt.';

-- Read like the purchase order it belongs to (managers and accountants);
-- written only by the RPCs.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['goods_receipts', 'goods_receipt_lines', 'goods_receipt_line_units', 'goods_receipt_line_bins'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "read_goods_receipts" ON public.goods_receipts;
CREATE POLICY "read_goods_receipts" ON public.goods_receipts FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.purchase_orders po WHERE po.id = goods_receipts.purchase_order_id));
DROP POLICY IF EXISTS "read_goods_receipt_lines" ON public.goods_receipt_lines;
CREATE POLICY "read_goods_receipt_lines" ON public.goods_receipt_lines FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.goods_receipts r WHERE r.id = goods_receipt_lines.goods_receipt_id));
DROP POLICY IF EXISTS "read_goods_receipt_line_units" ON public.goods_receipt_line_units;
CREATE POLICY "read_goods_receipt_line_units" ON public.goods_receipt_line_units FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.goods_receipt_lines l WHERE l.id = goods_receipt_line_units.goods_receipt_line_id));
DROP POLICY IF EXISTS "read_goods_receipt_line_bins" ON public.goods_receipt_line_bins;
CREATE POLICY "read_goods_receipt_line_bins" ON public.goods_receipt_line_bins FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.goods_receipt_lines l WHERE l.id = goods_receipt_line_bins.goods_receipt_line_id));

-- the server audit log (20260876) records receipts like every other document
DROP TRIGGER IF EXISTS trg_audit_goods_receipts ON public.goods_receipts;
CREATE TRIGGER trg_audit_goods_receipts AFTER INSERT OR DELETE OR UPDATE ON public.goods_receipts
  FOR EACH ROW EXECUTE FUNCTION public.rma_audit_row();
DROP TRIGGER IF EXISTS trg_audit_truncate_goods_receipts ON public.goods_receipts;
CREATE TRIGGER trg_audit_truncate_goods_receipts AFTER TRUNCATE ON public.goods_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION public.rma_audit_truncate();

-- ── 4. how much of a PO line has arrived ─────────────────────────────────────
-- Confirmed receipts have arrived; drafts hold their quantity too, so two
-- drafts cannot both claim the last units of a line.
CREATE OR REPLACE FUNCTION public.rma_po_line_received_qty(p_po_line_id uuid, p_include_drafts boolean)
RETURNS integer LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $function$
  SELECT COALESCE(sum(l.qty), 0)::integer
    FROM public.goods_receipt_lines l
    JOIN public.goods_receipts r ON r.id = l.goods_receipt_id
   WHERE l.purchase_order_line_id = p_po_line_id
     AND (r.status = 'confirmed' OR (p_include_drafts AND r.status = 'draft'))
$function$;
REVOKE ALL ON FUNCTION public.rma_po_line_received_qty(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_po_line_received_qty(uuid, boolean) TO authenticated, service_role;

-- ── 5. create_goods_receipt: a draft arrival ─────────────────────────────────
-- p_lines: [{purchase_order_line_id, qty, warehouse_id, serials: [..]}]
-- A serialized product's serials are scanned on arrival: exactly qty distinct,
-- non-blank serials not already in use. A bulk product takes none.
CREATE OR REPLACE FUNCTION public.create_goods_receipt(p_po_id uuid, p_lines jsonb, p_fields jsonb, p_actor_email text)
RETURNS public.goods_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_actor   text := public.rma_current_user_email();
  v_po      public.purchase_orders;
  v_gr      public.goods_receipts;
  v_in      jsonb;
  v_pol     public.purchase_order_lines;
  v_prod    public.products;
  v_wh      public.warehouses;
  v_qty_txt text;
  v_qty     integer;
  v_open    integer;
  v_serials text[];
  v_sn      text;
  v_no      integer := 0;
  v_seen    uuid[] := '{}';
  v_all_upper text[] := '{}';
BEGIN
  IF v_actor IS NULL OR NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Only managers and above can receive goods' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Say what arrived: at least one line' USING ERRCODE = 'P0001';
  END IF;
  IF p_fields IS NOT NULL AND jsonb_typeof(p_fields) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Fields must be an object' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order % not found', p_po_id USING ERRCODE = 'P0001';
  END IF;
  IF v_po.status NOT IN ('confirmed', 'partially_completed') THEN
    RAISE EXCEPTION 'Goods are received against a confirmed purchase order (this one is %)', v_po.status USING ERRCODE = 'P0001';
  END IF;
  -- the legacy path: stock already arrived on a supplier invoice of this order
  IF EXISTS (SELECT 1 FROM public.vendor_invoices vi
               JOIN public.vendor_invoice_lines vl ON vl.vendor_invoice_id = vi.id
              WHERE vi.purchase_order_id = p_po_id AND vi.status <> 'cancelled' AND vl.qty_received > 0) THEN
    RAISE EXCEPTION 'This order is being received on its supplier invoice; keep receiving there' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.goods_receipts (purchase_order_id, vendor_id, status, supplier_ref, notes, created_by)
  VALUES (p_po_id, v_po.vendor_id, 'draft',
          NULLIF(btrim(p_fields->>'supplier_ref'), ''), NULLIF(btrim(p_fields->>'notes'), ''), v_actor)
  RETURNING * INTO v_gr;

  FOR v_in IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    BEGIN
      SELECT * INTO v_pol FROM public.purchase_order_lines
       WHERE id = (v_in->>'purchase_order_line_id')::uuid AND purchase_order_id = p_po_id;
    EXCEPTION WHEN invalid_text_representation THEN
      v_pol := NULL;
    END;
    IF v_pol.id IS NULL THEN
      RAISE EXCEPTION 'A line is not on this purchase order' USING ERRCODE = 'P0001';
    END IF;
    IF v_pol.id = ANY (v_seen) THEN
      RAISE EXCEPTION 'Line % appears twice in this receipt', v_pol.line_no + 1 USING ERRCODE = 'P0001';
    END IF;
    v_seen := v_seen || v_pol.id;

    SELECT * INTO v_prod FROM public.products WHERE id = v_pol.product_id;
    IF v_prod.id IS NULL THEN
      RAISE EXCEPTION 'Line % has no catalogue product to receive', v_pol.line_no + 1 USING ERRCODE = 'P0001';
    END IF;
    IF v_prod.product_type IS NOT DISTINCT FROM 'service' THEN
      RAISE EXCEPTION '% is a service; services are not received into stock', v_prod.product_name USING ERRCODE = 'P0001';
    END IF;

    -- a whole number, judged as text first (NaN/Infinity/1e3 are valid numerics)
    v_qty_txt := btrim(COALESCE(v_in->>'qty', ''));
    IF v_qty_txt !~ '^[0-9]{1,9}$' OR v_qty_txt::integer < 1 THEN
      RAISE EXCEPTION '%: the quantity must be a whole number of at least 1', v_pol.product_name USING ERRCODE = 'P0001';
    END IF;
    v_qty := v_qty_txt::integer;
    v_open := v_pol.qty_ordered - public.rma_po_line_received_qty(v_pol.id, true);
    IF v_qty > v_open THEN
      RAISE EXCEPTION '%: only % left to receive on this order, and % were entered', v_pol.product_name, GREATEST(v_open, 0), v_qty
        USING ERRCODE = 'P0001';
    END IF;

    BEGIN
      SELECT * INTO v_wh FROM public.warehouses WHERE id = (v_in->>'warehouse_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_wh := NULL;
    END;
    IF v_wh.id IS NULL THEN
      RAISE EXCEPTION '%: choose the warehouse the goods went into', v_pol.product_name USING ERRCODE = 'P0001';
    END IF;
    -- a sellable location: main, branch or the legacy untyped kind; never a
    -- system (RMA/scrap) location or an archived one
    IF COALESCE(v_wh.is_system, false) OR NOT COALESCE(v_wh.is_active, true)
       OR COALESCE(v_wh.warehouse_type, 'main') NOT IN ('main', 'branch') THEN
      RAISE EXCEPTION '%: % is not a warehouse goods can be received into', v_pol.product_name, v_wh.name USING ERRCODE = 'P0001';
    END IF;

    v_serials := '{}';
    IF v_prod.stock_tracking_mode = 'bulk' THEN
      IF jsonb_typeof(v_in->'serials') = 'array' AND jsonb_array_length(v_in->'serials') > 0 THEN
        RAISE EXCEPTION '% is counted in bulk and takes no serial numbers', v_pol.product_name USING ERRCODE = 'P0001';
      END IF;
    ELSE
      IF jsonb_typeof(v_in->'serials') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION '%: scan the serial number of each unit', v_pol.product_name USING ERRCODE = 'P0001';
      END IF;
      FOR v_sn IN SELECT btrim(e) FROM jsonb_array_elements_text(v_in->'serials') e LOOP
        -- a JSON null reads as SQL NULL: "= ''" is NULL for it and would let a
        -- unit with no serial through (review)
        IF v_sn IS NULL OR v_sn = '' THEN
          RAISE EXCEPTION '%: a serial number is blank', v_pol.product_name USING ERRCODE = 'P0001';
        END IF;
        -- across every line of this receipt, case ignored
        IF upper(v_sn) = ANY (v_all_upper) THEN
          RAISE EXCEPTION '%: serial % is entered twice', v_pol.product_name, v_sn USING ERRCODE = 'P0001';
        END IF;
        v_all_upper := v_all_upper || upper(v_sn);
        v_serials := v_serials || v_sn;
      END LOOP;
      IF cardinality(v_serials) <> v_qty THEN
        RAISE EXCEPTION '%: % units need % serial numbers, and % were entered', v_pol.product_name, v_qty, v_qty, cardinality(v_serials)
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    INSERT INTO public.goods_receipt_lines
      (goods_receipt_id, line_no, purchase_order_line_id, product_id, product_name, qty, warehouse_id, serials)
    VALUES (v_gr.id, v_no, v_pol.id, v_prod.id, v_pol.product_name, v_qty, v_wh.id, v_serials);
    v_no := v_no + 1;
  END LOOP;

  -- serials already in use, or on another open draft, are refused here rather
  -- than at confirmation
  SELECT sn INTO v_sn
    FROM public.goods_receipt_lines l, unnest(l.serials) sn
   WHERE l.goods_receipt_id = v_gr.id
     AND (EXISTS (SELECT 1 FROM public.inventory_units u
                   WHERE upper(btrim(u.serial_number)) = upper(sn) AND u.status <> 'closed')
          OR EXISTS (SELECT 1 FROM public.goods_receipt_lines l2
                       JOIN public.goods_receipts r2 ON r2.id = l2.goods_receipt_id
                      WHERE r2.status = 'draft' AND r2.id <> v_gr.id
                        AND upper(sn) = ANY (SELECT upper(x) FROM unnest(l2.serials) x)))
   LIMIT 1;
  IF v_sn IS NOT NULL THEN
    RAISE EXCEPTION 'Serial number % is already in use', v_sn USING ERRCODE = 'P0001';
  END IF;

  RETURN v_gr;
END
$fn$;

-- ── 6. confirm_goods_receipt: the goods arrive ───────────────────────────────
CREATE OR REPLACE FUNCTION public.confirm_goods_receipt(p_receipt_id uuid, p_actor_email text)
RETURNS public.goods_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_actor       text := public.rma_current_user_email();
  v_gr          public.goods_receipts;
  v_po          public.purchase_orders;
  v_l           record;
  v_cost        numeric;
  v_tax_in_cost boolean;
  v_ws_id       uuid;
  v_unit_id     uuid;
  v_sn          text;
  v_all_in      boolean;
BEGIN
  IF v_actor IS NULL OR NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Only managers and above can confirm a goods receipt' USING ERRCODE = 'P0001';
  END IF;

  -- the receipt, then its order
  SELECT * INTO v_gr FROM public.goods_receipts WHERE id = p_receipt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Goods receipt % not found', p_receipt_id USING ERRCODE = 'P0001';
  END IF;
  IF v_gr.status <> 'draft' THEN
    RAISE EXCEPTION 'This goods receipt is already %', v_gr.status USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_po FROM public.purchase_orders WHERE id = v_gr.purchase_order_id FOR UPDATE;
  IF v_po.status NOT IN ('confirmed', 'partially_completed') THEN
    RAISE EXCEPTION 'The purchase order is % and can no longer receive goods', v_po.status USING ERRCODE = 'P0001';
  END IF;
  -- again, under the order's lock: an invoice of this order may have received
  -- stock since the draft was made (receive_vendor_invoice takes the same lock
  -- before its own check) — review
  IF EXISTS (SELECT 1 FROM public.vendor_invoices vi
               JOIN public.vendor_invoice_lines vl ON vl.vendor_invoice_id = vi.id
              WHERE vi.purchase_order_id = v_po.id AND vi.status <> 'cancelled' AND vl.qty_received > 0) THEN
    RAISE EXCEPTION 'This order has since been received on its supplier invoice; cancel this draft receipt' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE((config_value #>> '{}')::boolean, false) INTO v_tax_in_cost
    FROM public.rma_config WHERE config_key = 'purchase_tax_in_cost';
  v_tax_in_cost := COALESCE(v_tax_in_cost, false);

  FOR v_l IN
    SELECT l.*, pol.qty_ordered, pol.unit_cost, pol.discount_pct, pol.tax_pct, p.stock_tracking_mode
      FROM public.goods_receipt_lines l
      JOIN public.purchase_order_lines pol ON pol.id = l.purchase_order_line_id
      JOIN public.products p ON p.id = l.product_id
     WHERE l.goods_receipt_id = p_receipt_id
     ORDER BY l.line_no
  LOOP
    -- confirmed receipts plus this one never exceed what was ordered
    IF public.rma_po_line_received_qty(v_l.purchase_order_line_id, false) + v_l.qty > v_l.qty_ordered THEN
      RAISE EXCEPTION '%: more would arrive than was ordered', v_l.product_name USING ERRCODE = 'P0001';
    END IF;
    -- the warehouse may have been archived or re-typed since the draft (review)
    IF NOT EXISTS (SELECT 1 FROM public.warehouses w
                    WHERE w.id = v_l.warehouse_id AND NOT COALESCE(w.is_system, false) AND COALESCE(w.is_active, true)
                      AND COALESCE(w.warehouse_type, 'main') IN ('main', 'branch')) THEN
      RAISE EXCEPTION '%: its warehouse can no longer receive goods; cancel this draft and receive into another', v_l.product_name
        USING ERRCODE = 'P0001';
    END IF;

    -- the PO line's net price in the base currency (as rma_vi_landed_unit_costs
    -- prices an invoice line); no price = unknown cost, never zero
    v_cost := CASE WHEN COALESCE(v_l.unit_cost, 0) <= 0 THEN NULL
                   ELSE round(v_l.unit_cost
                              * (1 - COALESCE(v_l.discount_pct, 0) / 100)
                              * CASE WHEN v_tax_in_cost THEN 1 + COALESCE(v_l.tax_pct, 0) / 100 ELSE 1 END
                              * COALESCE(v_po.exchange_rate, 1), 4) END;

    IF v_l.stock_tracking_mode = 'bulk' THEN
      -- The cost is stated even when it is 0 (a free line): without this,
      -- rma_hold_unit_cost reads "total unchanged" as "no cost given" and
      -- values the free units at the bin's average (review).
      PERFORM set_config('rma.cost_stated', 'on', true);
      SELECT id INTO v_ws_id FROM public.warehouse_stock
       WHERE product_id = v_l.product_id AND warehouse_id = v_l.warehouse_id FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO public.warehouse_stock
          (product_id, warehouse_id, quantity, reserved_quantity, total_cost_base, uncosted_quantity)
        VALUES (v_l.product_id, v_l.warehouse_id, v_l.qty, 0,
                CASE WHEN v_cost IS NULL THEN 0 ELSE round(v_cost * v_l.qty, 4) END,
                CASE WHEN v_cost IS NULL THEN v_l.qty ELSE 0 END)
        RETURNING id INTO v_ws_id;
      ELSIF v_cost IS NULL THEN
        UPDATE public.warehouse_stock
           SET quantity = quantity + v_l.qty, uncosted_quantity = uncosted_quantity + v_l.qty, updated_at = now()
         WHERE id = v_ws_id;
      ELSE
        UPDATE public.warehouse_stock
           SET quantity = quantity + v_l.qty, total_cost_base = total_cost_base + round(v_cost * v_l.qty, 4), updated_at = now()
         WHERE id = v_ws_id;
      END IF;
      INSERT INTO public.stock_moves (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
      VALUES ('warehouse_stock', v_ws_id, 'goods_receipt', p_receipt_id, 'receive', v_l.qty, NULL, 'available', v_actor);
      INSERT INTO public.goods_receipt_line_bins (goods_receipt_line_id, warehouse_stock_id, qty)
      VALUES (v_l.id, v_ws_id, v_l.qty);
      PERFORM set_config('rma.cost_stated', 'off', true);
    ELSE
      IF cardinality(v_l.serials) <> v_l.qty THEN
        RAISE EXCEPTION '%: % units need % serial numbers', v_l.product_name, v_l.qty, v_l.qty USING ERRCODE = 'P0001';
      END IF;
      FOREACH v_sn IN ARRAY v_l.serials LOOP
        BEGIN
          INSERT INTO public.inventory_units
            (product_id, product_name, serial_number, status, reservation_status, warehouse_id, goods_receipt_id, unit_cost_base, created_date)
          VALUES (v_l.product_id, v_l.product_name, v_sn, 'company_stock', 'available', v_l.warehouse_id, p_receipt_id, v_cost, now())
          RETURNING id INTO v_unit_id;
        EXCEPTION WHEN unique_violation THEN
          RAISE EXCEPTION 'Serial number % is already in use', v_sn USING ERRCODE = 'P0001';
        END;
        INSERT INTO public.stock_moves (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
        VALUES ('unit', v_unit_id, 'goods_receipt', p_receipt_id, 'receive', 1, NULL, 'available', v_actor);
        INSERT INTO public.goods_receipt_line_units (goods_receipt_line_id, unit_id) VALUES (v_l.id, v_unit_id);
      END LOOP;
    END IF;

    UPDATE public.goods_receipt_lines SET unit_cost_base = v_cost WHERE id = v_l.id;
  END LOOP;

  UPDATE public.goods_receipts
     SET status = 'confirmed', grn_code = public.nextval_for_type('goods_receipt'),
         confirmed_by = v_actor, confirmed_at = now(), updated_at = now()
   WHERE id = p_receipt_id
  RETURNING * INTO v_gr;

  -- every stock line in: completed; otherwise partially completed (a service
  -- line has nothing to receive)
  SELECT bool_and(public.rma_po_line_received_qty(pol.id, false) >= pol.qty_ordered)
    INTO v_all_in
    FROM public.purchase_order_lines pol
    JOIN public.products p ON p.id = pol.product_id
   WHERE pol.purchase_order_id = v_po.id
     AND p.product_type IS DISTINCT FROM 'service';
  UPDATE public.purchase_orders
     SET status = CASE WHEN COALESCE(v_all_in, false) THEN 'completed' ELSE 'partially_completed' END,
         updated_at = now()
   WHERE id = v_po.id;

  RETURN v_gr;
END
$fn$;

-- ── 7. cancel_goods_receipt: a draft only ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_goods_receipt(p_receipt_id uuid, p_actor_email text)
RETURNS public.goods_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_gr    public.goods_receipts;
BEGIN
  IF v_actor IS NULL OR NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Only managers and above can cancel a goods receipt' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_gr FROM public.goods_receipts WHERE id = p_receipt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Goods receipt % not found', p_receipt_id USING ERRCODE = 'P0001';
  END IF;
  IF v_gr.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft goods receipt can be cancelled (this one is %); goods that arrived go back by a return to the supplier', v_gr.status
      USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.goods_receipts
     SET status = 'cancelled', cancelled_by = v_actor, cancelled_at = now(), updated_at = now()
   WHERE id = p_receipt_id
  RETURNING * INTO v_gr;
  RETURN v_gr;
END
$fn$;

DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['create_goods_receipt(uuid, jsonb, jsonb, text)', 'confirm_goods_receipt(uuid, text)', 'cancel_goods_receipt(uuid, text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', s);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', s);
  END LOOP;
END $$;

-- ── 8. the two paths never mix; an order with a receipt is not amended ───────
-- receive_vendor_invoice: (a) it takes the ORDER's lock before looking for
-- receipts, so it and create_goods_receipt (which locks the order first)
-- cannot both pass their checks and receive the same goods twice (review);
-- (b) an order with a receipt is not received on its invoice; (c) the cost it
-- writes to a bin is stated even when it is 0 (see rma_hold_unit_cost below).
DO $$
DECLARE
  v_def  text;
  v_old  text := E'  IF jsonb_typeof(p_receipt_lines) IS DISTINCT FROM ''array'' THEN';
  -- this file's first version, already on staging: removed before re-adding
  v_prev text := E'  -- 20260897: an order received by goods receipts is not received again on its invoice\n'
              || E'  IF v_vi.purchase_order_id IS NOT NULL AND EXISTS (\n'
              || E'       SELECT 1 FROM public.goods_receipts WHERE purchase_order_id = v_vi.purchase_order_id AND status <> ''cancelled'') THEN\n'
              || E'    RAISE EXCEPTION ''This order is received by goods receipts; receive the goods there, not on the invoice'' USING ERRCODE = ''P0001'';\n'
              || E'  END IF;\n';
  v_tail text := E'  IF v_vi.purchase_order_id IS NOT NULL THEN\n    SELECT status INTO v_po_status';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.receive_vendor_invoice'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%rma.cost_stated%' THEN
    RETURN;
  END IF;
  v_def := replace(v_def, v_prev, '');
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: receive_vendor_invoice holds its line-list check % time(s), expected 1', v_have;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_tail, ''))) / length(v_tail);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: receive_vendor_invoice holds its order sync % time(s), expected 1', v_have;
  END IF;
  v_def := replace(v_def, v_old,
       E'  -- 20260897: the order''s lock first, then: an order received by goods\n'
    || E'  -- receipts is not received again on its invoice\n'
    || E'  IF v_vi.purchase_order_id IS NOT NULL THEN\n'
    || E'    PERFORM 1 FROM public.purchase_orders WHERE id = v_vi.purchase_order_id FOR UPDATE;\n'
    || E'    IF EXISTS (SELECT 1 FROM public.goods_receipts WHERE purchase_order_id = v_vi.purchase_order_id AND status <> ''cancelled'') THEN\n'
    || E'      RAISE EXCEPTION ''This order is received by goods receipts; receive the goods there, not on the invoice'' USING ERRCODE = ''P0001'';\n'
    || E'    END IF;\n'
    || E'  END IF;\n'
    || E'  PERFORM set_config(''rma.cost_stated'', ''on'', true);   -- a cost of 0 is stated, not missing\n'
    || v_old);
  v_def := replace(v_def, v_tail, E'  PERFORM set_config(''rma.cost_stated'', ''off'', true);\n\n' || v_tail);
  EXECUTE v_def;
END $$;

-- rma_hold_unit_cost keeps a bin's average when quantity moves and the caller
-- stated no cost. A receipt of goods that cost 0 changes neither the total nor
-- the unknown count, so it read as "no cost stated" and the free units took the
-- bin's average — value from nothing (review). A receiving function now says
-- it stated the cost with the transaction-local rma.cost_stated.
DO $$
DECLARE
  v_def  text;
  v_old  text := E'BEGIN\n  -- Only when quantity moved and the caller stated neither a value nor a';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.rma_hold_unit_cost'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%rma.cost_stated%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: rma_hold_unit_cost does not read as expected (% matches)', v_have;
  END IF;
  EXECUTE replace(v_def, v_old,
       E'BEGIN\n'
    || E'  -- 20260897: a receiving function that states the cost (even 0) says so\n'
    || E'  IF current_setting(''rma.cost_stated'', true) = ''on'' THEN\n'
    || E'    RETURN NEW;\n'
    || E'  END IF;\n\n'
    || E'  -- Only when quantity moved and the caller stated neither a value nor a');
END $$;

-- the unit's receipt is a traced fact: not a column a client may rewrite
DO $$
DECLARE
  v_def  text;
  v_old  text := '''manufacturer_batch_id'',';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.rma_guard_inventory_ledger_columns'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%''goods_receipt_id''%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: rma_guard_inventory_ledger_columns lists manufacturer_batch_id % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_old || '''goods_receipt_id'',');
END $$;

DO $$
DECLARE
  v_def  text;
  v_old  text := E'  IF EXISTS (SELECT 1 FROM public.vendor_invoices WHERE purchase_order_id = p_po_id AND status <> ''cancelled'') THEN';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.amend_purchase_order'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%Goods have been received against it%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: amend_purchase_order holds its invoice check % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old,
       E'  -- 20260897: its lines are what receipts were recorded against\n'
    || E'  IF EXISTS (SELECT 1 FROM public.goods_receipts WHERE purchase_order_id = p_po_id AND status <> ''cancelled'') THEN\n'
    || E'    RAISE EXCEPTION ''Goods have been received against it (or a receipt is being prepared); cancel the draft receipt, or raise a new order'' USING ERRCODE = ''P0001'';\n'
    || E'  END IF;\n'
    || v_old);
END $$;

-- ── 9. Backup & Restore can restore what it backs up ─────────────────────────
-- rma_restore_stage refuses a table not in rma_restore_manifest(), and
-- rma_restore_apply writes in the manifest's order. The manifest had none of the
-- line tables (20260883–20260889), deliveries (20260894) or receipts, so a backup
-- taken since 20260883 could not be restored at all (review). It is now the
-- restorable entries of src/api/backup.js BACKUP_TABLES, in that order (parents
-- first); src/test/restoreManifest.test.js fails if the two drift apart.
CREATE OR REPLACE FUNCTION public.rma_restore_manifest()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    'currencies', 'countries', 'country_area_codes', 'rma_config', 'brands', 'categories',
    'subcategories', 'warehouses', 'pipelines', 'parts', 'custom_field_definitions',
    'custom_roles', 'user_roles', 'user_preferences', 'announcements', 'kb_articles',
    'branding_settings', 'email_templates', 'whatsapp_templates', 'notification_settings',
    'notification_preferences', 'products', 'product_images', 'product_documents',
    'company_documents', 'customers', 'contacts', 'customer_notes', 'deals', 'leads',
    'rma_tickets', 'ticket_comments', 'ticket_activity', 'ticket_parts', 'ticket_resolutions',
    'time_entries', 'purchase_orders', 'purchase_order_lines', 'vendor_invoices',
    'vendor_invoice_lines', 'vendor_invoice_charges', 'vendor_payments',
    'vendor_payment_applications', 'goods_receipts', 'goods_receipt_lines', 'manufacturer_batches',
    'inventory_units', 'warehouse_stock', 'goods_receipt_line_units', 'goods_receipt_line_bins',
    'quotations', 'quotation_lines', 'sales_orders', 'sales_order_lines', 'deliveries',
    'delivery_lines', 'delivery_line_units', 'delivery_line_bins', 'crm_invoices',
    'crm_invoice_lines', 'invoices', 'payments', 'payment_applications', 'credit_notes',
    'credit_note_lines', 'credit_note_applications', 'activities', 'notifications',
    'user_activity_log'
  ]::text[]
$function$;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.confirm_goods_receipt(uuid, text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.goods_receipts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.goods_receipt_lines', 'UPDATE') THEN
    RAISE EXCEPTION 'Refusing to finish: goods receipts are writable outside their RPCs';
  END IF;
  -- checked on the definition: calling it would burn a number of a gapless sequence
  IF pg_get_functiondef('public.nextval_for_type'::regproc) NOT LIKE '%WHEN ''goods_receipt''  THEN ''GRN''%'
     OR NOT EXISTS (SELECT 1 FROM public.document_sequences WHERE seq_type = 'goods_receipt')
     OR pg_get_functiondef('public.rma_reconcile_document_sequences'::regproc) NOT LIKE '%''goods_receipts''%' THEN
    RAISE EXCEPTION 'Refusing to finish: the goods_receipt sequence is not registered as GRN-';
  END IF;
  IF pg_get_functiondef('public.receive_vendor_invoice'::regproc) NOT LIKE '%is received by goods receipts%'
     OR pg_get_functiondef('public.amend_purchase_order'::regproc) NOT LIKE '%Goods have been received against it%'
     OR pg_get_functiondef('public.receive_vendor_invoice'::regproc) NOT LIKE '%FROM public.purchase_orders WHERE id = v_vi.purchase_order_id FOR UPDATE%'
     OR pg_get_functiondef('public.rma_hold_unit_cost'::regproc) NOT LIKE '%rma.cost_stated%'
     OR pg_get_functiondef('public.rma_guard_inventory_ledger_columns'::regproc) NOT LIKE '%''goods_receipt_id''%' THEN
    RAISE EXCEPTION 'Refusing to finish: receive_vendor_invoice or amend_purchase_order was not updated';
  END IF;
END $$;
