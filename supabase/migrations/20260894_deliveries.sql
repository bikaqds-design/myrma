-- ============================================================================
-- 20260894_deliveries.sql
-- P-01a — the delivery (shipment) document, database side. Design and the
-- owner's decisions: docs/P01_DELIVERIES.md.
--
--   * deliveries / delivery_lines: a shipment of part or all of a confirmed
--     sales order. draft -> confirmed, or draft -> cancelled.
--   * confirm_delivery (managers and above — owner decision) moves exactly the
--     delivered quantity of each line out of stock: serialized units reserved
--     for the order become 'delivered'; bulk quantity leaves the bins that hold
--     the order's reservation. Cost of goods is captured per line at that
--     moment (serialized: each unit's own cost; bulk: the bin's average, read
--     before the stock moves), with the units and bins recorded. A gapless
--     DN-YYYY-NNNNN code is assigned. When every stock line of the order is
--     fully delivered, the order becomes 'delivered' (the first thing to set
--     that status since 20260879).
--   * Stock moves stay under doc_type 'sales_order' / the order's id, so the
--     reservation ledger (net reserved per order, used by release and cancel)
--     is unchanged; delivery_line_units / delivery_line_bins say which
--     delivery took them.
--   * Two paths, never mixed on one order: an order with a live invoice made
--     the old way (convert_so_to_invoice, which ships everything when posted)
--     cannot get deliveries, and an order with a delivery cannot be converted
--     the old way. Invoicing a delivery is P-02a.
-- ============================================================================

-- ── 1. numbering: DN-YYYY-NNNNN ──────────────────────────────────────────────
INSERT INTO public.document_sequences (seq_type, last_value, seq_year)
VALUES ('delivery', 0, EXTRACT(YEAR FROM now())::integer)
ON CONFLICT (seq_type) DO NOTHING;

DO $$
DECLARE
  v_def  text;
  v_old  text := '    WHEN ''purchase_order'' THEN ''PO''';
  v_have integer;
BEGIN
  SELECT pg_get_functiondef('public.nextval_for_type'::regproc) INTO v_def;
  IF v_def LIKE '%WHEN ''delivery''%' THEN
    RETURN;   -- already registered
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: nextval_for_type holds the purchase_order prefix % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_old || E'\n    WHEN ''delivery''       THEN ''DN''');
END $$;

-- A restore cannot carry document_sequences; rma_reconcile_document_sequences
-- (20260878) resets each counter to the highest code issued. It must know
-- deliveries, or a restored database re-issues DN-…-00001 and every
-- confirmation fails on the unique code.
DO $$
DECLARE
  v_def  text;
  v_old  text := '(''batch'',          ''manufacturer_batches'',  ''batch_number'',   ''BATCH'')';
  v_have integer;
BEGIN
  SELECT pg_get_functiondef('public.rma_reconcile_document_sequences'::regproc) INTO v_def;
  IF v_def LIKE '%''deliveries''%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: rma_reconcile_document_sequences lists batch % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_old || E',
      (''delivery'',       ''deliveries'',            ''delivery_code'',  ''DN'')');
END $$;

-- ── 2. tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_code   text UNIQUE,                       -- assigned at confirmation
  sales_order_id  uuid NOT NULL REFERENCES public.sales_orders(id),
  customer_id     uuid NOT NULL REFERENCES public.customers(id),
  status          text NOT NULL DEFAULT 'draft',
  notes           text,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_by    text,
  confirmed_at    timestamptz,
  cancelled_by    text,
  cancelled_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deliveries_status_check CHECK (status IN ('draft', 'confirmed', 'cancelled')),
  CONSTRAINT deliveries_confirmed_has_code CHECK (status <> 'confirmed' OR (delivery_code IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS deliveries_so_idx ON public.deliveries (sales_order_id);

CREATE TABLE IF NOT EXISTS public.delivery_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id          uuid NOT NULL REFERENCES public.deliveries(id) ON DELETE CASCADE,
  line_no              integer NOT NULL,
  sales_order_line_id  uuid NOT NULL REFERENCES public.sales_order_lines(id),
  product_id           uuid NOT NULL REFERENCES public.products(id),
  product_name         text NOT NULL,
  qty                  integer NOT NULL,
  cogs_base            numeric(14,2),                -- set at confirmation
  cogs_unknown_qty     integer NOT NULL DEFAULT 0,   -- units with no known cost
  CONSTRAINT delivery_lines_qty_positive CHECK (qty >= 1),
  CONSTRAINT delivery_lines_unique_line UNIQUE (delivery_id, line_no),
  CONSTRAINT delivery_lines_one_per_so_line UNIQUE (delivery_id, sales_order_line_id)
);
CREATE INDEX IF NOT EXISTS delivery_lines_delivery_idx ON public.delivery_lines (delivery_id);
CREATE INDEX IF NOT EXISTS delivery_lines_so_line_idx ON public.delivery_lines (sales_order_line_id);

-- which serialized units / which bulk bins a confirmed line took
CREATE TABLE IF NOT EXISTS public.delivery_line_units (
  delivery_line_id  uuid NOT NULL REFERENCES public.delivery_lines(id) ON DELETE CASCADE,
  unit_id           uuid NOT NULL REFERENCES public.inventory_units(id),
  unit_cost_base    numeric(14,4),
  PRIMARY KEY (delivery_line_id, unit_id)
);
CREATE TABLE IF NOT EXISTS public.delivery_line_bins (
  delivery_line_id    uuid NOT NULL REFERENCES public.delivery_lines(id) ON DELETE CASCADE,
  warehouse_stock_id  uuid NOT NULL REFERENCES public.warehouse_stock(id),
  qty                 integer NOT NULL CHECK (qty >= 1),
  avg_cost_base       numeric(14,4),
  PRIMARY KEY (delivery_line_id, warehouse_stock_id)
);

COMMENT ON TABLE public.deliveries IS
  'A shipment of part or all of a confirmed sales order (P-01). Stock and cost of goods leave at confirm_delivery. Procedure-only: create_delivery / confirm_delivery / cancel_delivery.';

-- Read like the order it ships; written only by the RPCs.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['deliveries', 'delivery_lines', 'delivery_line_units', 'delivery_line_bins'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "read_deliveries" ON public.deliveries;
CREATE POLICY "read_deliveries" ON public.deliveries FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.sales_orders o WHERE o.id = deliveries.sales_order_id));
DROP POLICY IF EXISTS "read_delivery_lines" ON public.delivery_lines;
CREATE POLICY "read_delivery_lines" ON public.delivery_lines FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.deliveries d WHERE d.id = delivery_lines.delivery_id));
-- which units and at what cost: cost is commercially sensitive (as rma_invoice_cogs)
DROP POLICY IF EXISTS "read_delivery_line_units" ON public.delivery_line_units;
CREATE POLICY "read_delivery_line_units" ON public.delivery_line_units FOR SELECT
  USING (COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = 'accountant', false)
         AND EXISTS (SELECT 1 FROM public.delivery_lines l WHERE l.id = delivery_line_units.delivery_line_id));
DROP POLICY IF EXISTS "read_delivery_line_bins" ON public.delivery_line_bins;
CREATE POLICY "read_delivery_line_bins" ON public.delivery_line_bins FOR SELECT
  USING (COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = 'accountant', false)
         AND EXISTS (SELECT 1 FROM public.delivery_lines l WHERE l.id = delivery_line_bins.delivery_line_id));

-- ── 3. how much of an order line is already spoken for ───────────────────────
-- Confirmed deliveries count as delivered; drafts hold their quantity too, so
-- two drafts cannot both claim the last units.
CREATE OR REPLACE FUNCTION public.rma_so_line_delivered_qty(p_so_line_id uuid, p_include_drafts boolean)
RETURNS integer LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $function$
  SELECT COALESCE(sum(l.qty), 0)::integer
    FROM public.delivery_lines l
    JOIN public.deliveries d ON d.id = l.delivery_id
   WHERE l.sales_order_line_id = p_so_line_id
     AND (d.status = 'confirmed' OR (p_include_drafts AND d.status = 'draft'))
$function$;
REVOKE ALL ON FUNCTION public.rma_so_line_delivered_qty(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_so_line_delivered_qty(uuid, boolean) TO authenticated, service_role;

-- ── 4. create_delivery: a draft shipment ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_delivery(p_so_id uuid, p_lines jsonb, p_notes text, p_actor_email text)
RETURNS public.deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_so    public.sales_orders;
  v_id    uuid := gen_random_uuid();
  v_line  jsonb;
  v_sol   public.sales_order_lines;
  v_qty   text;
  v_open  integer;
  v_no    integer := 0;
  v_type  text;
  v_row   public.deliveries;
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) OR v_actor IS NULL THEN
    RAISE EXCEPTION 'Only a manager can prepare a delivery' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order % not found', p_so_id USING ERRCODE = 'P0001';
  END IF;
  IF v_so.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Only a confirmed sales order is delivered (this one is %)', v_so.status USING ERRCODE = 'P0001';
  END IF;
  -- Two paths never mix: an invoice made from the whole order ships
  -- everything when it is posted.
  IF EXISTS (SELECT 1 FROM public.crm_invoices i
              WHERE i.so_id = p_so_id AND i.doc_status <> 'cancelled' AND i.delivery_id IS NULL) THEN
    RAISE EXCEPTION 'This order was invoiced as a whole; its stock ships when that invoice is posted, not by deliveries' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Choose at least one line to deliver' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.deliveries (id, sales_order_id, customer_id, status, notes, created_by)
  VALUES (v_id, p_so_id, v_so.customer_id, 'draft', NULLIF(btrim(COALESCE(p_notes, '')), ''), v_actor);

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(v_line) IS DISTINCT FROM 'object'
       OR COALESCE(v_line->>'sales_order_line_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Line % does not name a line of this order', v_no + 1 USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_sol FROM public.sales_order_lines
     WHERE id = (v_line->>'sales_order_line_id')::uuid AND sales_order_id = p_so_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Line % is not a line of this order', v_no + 1 USING ERRCODE = 'P0001';
    END IF;
    IF v_sol.product_id IS NULL THEN
      RAISE EXCEPTION 'Line "%" has no catalogue product, so there is nothing in stock to deliver', v_sol.product_name USING ERRCODE = 'P0001';
    END IF;
    SELECT p.product_type INTO v_type FROM public.products p WHERE p.id = v_sol.product_id;
    IF v_type = 'service' THEN
      RAISE EXCEPTION 'Line "%" is a service; services are not delivered from stock', v_sol.product_name USING ERRCODE = 'P0001';
    END IF;
    v_qty := btrim(COALESCE(v_line->>'qty', ''));
    IF v_qty !~ '^[0-9]{1,9}$' OR v_qty::integer < 1 THEN
      RAISE EXCEPTION 'Line "%": the quantity to deliver must be a whole number of at least 1', v_sol.product_name USING ERRCODE = 'P0001';
    END IF;
    v_open := v_sol.qty - public.rma_so_line_delivered_qty(v_sol.id, true);
    IF v_qty::integer > v_open THEN
      RAISE EXCEPTION 'Line "%": only % left to deliver (ordered %, the rest already delivered or on another draft delivery)',
        v_sol.product_name, GREATEST(v_open, 0), v_sol.qty USING ERRCODE = 'P0001';
    END IF;
    BEGIN
      INSERT INTO public.delivery_lines (delivery_id, line_no, sales_order_line_id, product_id, product_name, qty)
      VALUES (v_id, v_no, v_sol.id, v_sol.product_id, v_sol.product_name, v_qty::integer);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Line "%" is listed twice; give it once with the total quantity', v_sol.product_name USING ERRCODE = 'P0001';
    END;
    v_no := v_no + 1;
  END LOOP;

  SELECT * INTO v_row FROM public.deliveries WHERE id = v_id;
  RETURN v_row;
END
$function$;

-- ── 5. confirm_delivery: the goods leave ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.confirm_delivery(p_delivery_id uuid, p_actor_email text)
RETURNS public.deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    text := public.rma_current_user_email();
  v_d        public.deliveries;
  v_so       public.sales_orders;
  v_l        record;
  v_mode     text;
  v_unit     record;
  v_bin      record;
  v_left     integer;
  v_take     integer;
  v_cost     numeric;
  v_unknown  integer;
  v_got      integer;
  v_avg      numeric;
  v_row      public.deliveries;
BEGIN
  -- Owner decision: only managers and above confirm that goods left.
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) OR v_actor IS NULL THEN
    RAISE EXCEPTION 'Only a manager can confirm a delivery' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_d FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery % not found', p_delivery_id USING ERRCODE = 'P0001';
  END IF;
  IF v_d.status <> 'draft' THEN
    RAISE EXCEPTION 'This delivery is % and cannot be confirmed again', v_d.status USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_so FROM public.sales_orders WHERE id = v_d.sales_order_id FOR UPDATE;
  IF v_so.status <> 'confirmed' THEN
    RAISE EXCEPTION 'The sales order is % — only a confirmed order is delivered', v_so.status USING ERRCODE = 'P0001';
  END IF;

  FOR v_l IN
    SELECT l.*, sol.qty AS ordered
      FROM public.delivery_lines l
      JOIN public.sales_order_lines sol ON sol.id = l.sales_order_line_id
     WHERE l.delivery_id = p_delivery_id
     ORDER BY l.line_no
  LOOP
    -- never beyond what was ordered, counting only what has really shipped
    IF public.rma_so_line_delivered_qty(v_l.sales_order_line_id, false) + v_l.qty > v_l.ordered THEN
      RAISE EXCEPTION 'Line "%": delivering % would ship more than the % ordered', v_l.product_name, v_l.qty, v_l.ordered USING ERRCODE = 'P0001';
    END IF;

    SELECT p.stock_tracking_mode INTO v_mode FROM public.products p WHERE p.id = v_l.product_id;
    v_cost := 0; v_unknown := 0; v_got := 0;

    IF v_mode = 'bulk' THEN
      v_left := v_l.qty;
      FOR v_bin IN
        SELECT sm.ref_id AS ws_id,
               SUM(CASE WHEN sm.move_type = 'reserve' THEN sm.qty ELSE 0 END)
             - SUM(CASE WHEN sm.move_type IN ('release', 'deliver') THEN sm.qty ELSE 0 END) AS net
          FROM public.stock_moves sm
          JOIN public.warehouse_stock ws ON ws.id = sm.ref_id
         WHERE sm.doc_type = 'sales_order' AND sm.doc_id IS NOT DISTINCT FROM v_so.id
           AND sm.ref_type = 'warehouse_stock' AND ws.product_id = v_l.product_id
         GROUP BY sm.ref_id
        HAVING SUM(CASE WHEN sm.move_type = 'reserve' THEN sm.qty ELSE 0 END)
             - SUM(CASE WHEN sm.move_type IN ('release', 'deliver') THEN sm.qty ELSE 0 END) > 0
         ORDER BY sm.ref_id
      LOOP
        EXIT WHEN v_left = 0;
        v_take := LEAST(v_left, v_bin.net);
        -- the bin's average BEFORE the stock moves (rma_hold_unit_cost keeps it
        -- steady as the quantity drops, as for deliver_warehouse_stock)
        SELECT avg_cost_base INTO v_avg FROM public.warehouse_stock WHERE id = v_bin.ws_id FOR UPDATE;
        INSERT INTO public.delivery_line_bins (delivery_line_id, warehouse_stock_id, qty, avg_cost_base)
        VALUES (v_l.id, v_bin.ws_id, v_take, v_avg);
        IF v_avg IS NULL THEN
          v_unknown := v_unknown + v_take;
        ELSE
          v_cost := v_cost + v_take * v_avg;
        END IF;
        UPDATE public.warehouse_stock
           SET quantity = quantity - v_take,
               reserved_quantity = GREATEST(reserved_quantity - v_take, 0),
               updated_at = now()
         WHERE id = v_bin.ws_id AND quantity >= v_take;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Line "%": the bin holding its reservation has less stock than the reservation', v_l.product_name USING ERRCODE = 'P0001';
        END IF;
        INSERT INTO public.stock_moves (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
        VALUES ('warehouse_stock', v_bin.ws_id, 'sales_order', v_so.id, 'deliver', v_take, 'reserved', 'delivered', v_actor);
        v_left := v_left - v_take;
        v_got := v_got + v_take;
      END LOOP;
    ELSE
      -- serialized (the default for a stock product)
      FOR v_unit IN
        SELECT id, unit_cost_base FROM public.inventory_units
         WHERE reserved_by_doc_type = 'sales_order' AND reserved_by_doc_id = v_so.id
           AND reservation_status = 'reserved' AND product_id = v_l.product_id
         ORDER BY reserved_at NULLS LAST, id
         LIMIT v_l.qty
         FOR UPDATE
      LOOP
        UPDATE public.inventory_units
           SET reservation_status = 'delivered', reserved_by_doc_type = NULL, reserved_by_doc_id = NULL,
               reserved_at = NULL, reserved_by_email = NULL
         WHERE id = v_unit.id;
        INSERT INTO public.stock_moves (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
        VALUES ('unit', v_unit.id, 'sales_order', v_so.id, 'deliver', 1, 'reserved', 'delivered', v_actor);
        INSERT INTO public.delivery_line_units (delivery_line_id, unit_id, unit_cost_base)
        VALUES (v_l.id, v_unit.id, v_unit.unit_cost_base);
        IF v_unit.unit_cost_base IS NULL THEN
          v_unknown := v_unknown + 1;
        ELSE
          v_cost := v_cost + v_unit.unit_cost_base;
        END IF;
        v_got := v_got + 1;
      END LOOP;
    END IF;

    IF v_got < v_l.qty THEN
      RAISE EXCEPTION 'Line "%": only % reserved for this order, % to deliver', v_l.product_name, v_got, v_l.qty USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.delivery_lines SET cogs_base = round(v_cost, 2), cogs_unknown_qty = v_unknown WHERE id = v_l.id;
  END LOOP;

  UPDATE public.deliveries
     SET status = 'confirmed', delivery_code = public.nextval_for_type('delivery'),
         confirmed_by = v_actor, confirmed_at = now(), updated_at = now()
   WHERE id = p_delivery_id
   RETURNING * INTO v_row;

  -- The order is delivered once every stock line has shipped in full.
  IF NOT EXISTS (
    SELECT 1 FROM public.sales_order_lines sol
      JOIN public.products p ON p.id = sol.product_id
     WHERE sol.sales_order_id = v_so.id
       AND p.product_type IS DISTINCT FROM 'service'
       AND public.rma_so_line_delivered_qty(sol.id, false) < sol.qty) THEN
    UPDATE public.sales_orders SET status = 'delivered', delivered_at = now() WHERE id = v_so.id;
  END IF;

  RETURN v_row;
END
$function$;

-- ── 6. cancel_delivery: a draft only ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_delivery(p_delivery_id uuid, p_actor_email text)
RETURNS public.deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_d     public.deliveries;
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) OR v_actor IS NULL THEN
    RAISE EXCEPTION 'Only a manager can cancel a delivery' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_d FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery % not found', p_delivery_id USING ERRCODE = 'P0001';
  END IF;
  IF v_d.status <> 'draft' THEN
    RAISE EXCEPTION 'A % delivery cannot be cancelled — the goods have left; record a return instead', v_d.status USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.deliveries SET status = 'cancelled', cancelled_by = v_actor, cancelled_at = now(), updated_at = now()
   WHERE id = p_delivery_id RETURNING * INTO v_d;
  RETURN v_d;
END
$function$;

DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['create_delivery(uuid, jsonb, text, text)', 'confirm_delivery(uuid, text)', 'cancel_delivery(uuid, text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', s);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', s);
  END LOOP;
END $$;

-- ── 7. the two paths never mix ───────────────────────────────────────────────
-- An invoice made from a delivery (P-02a) carries its delivery_id; the
-- column is added here so both checks can name it.
ALTER TABLE public.crm_invoices ADD COLUMN IF NOT EXISTS delivery_id uuid REFERENCES public.deliveries(id);

DO $$
DECLARE
  v_def  text;
  v_old  text := '  IF EXISTS (SELECT 1 FROM public.crm_invoices WHERE so_id = p_so_id AND doc_status <> ''cancelled'') THEN';
  v_new  text := '  -- An order that ships by deliveries is invoiced delivery by delivery
  -- (20260894): converting it whole would ship its stock a second time.
  IF EXISTS (SELECT 1 FROM public.deliveries WHERE sales_order_id = p_so_id AND status <> ''cancelled'') THEN
    RAISE EXCEPTION ''This order ships by deliveries; invoice each delivery instead of the whole order'' USING ERRCODE = ''P0001'';
  END IF;

  IF EXISTS (SELECT 1 FROM public.crm_invoices WHERE so_id = p_so_id AND doc_status <> ''cancelled'') THEN';
  v_have integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'convert_so_to_invoice';
  IF v_def LIKE '%ships by deliveries%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: convert_so_to_invoice holds its duplicate check % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END $$;

-- ── 8. cancelling an order, the integrity report, the audit log (review) ─────
-- cancel_sales_order checked only "an invoice exists", so an order whose goods
-- had left on a delivery (not invoiced yet) could be cancelled, and then could
-- never be invoiced. It now refuses an order with a confirmed delivery and
-- takes its draft deliveries with it. Its own-order check for a sales rep was
-- also a bare (a OR b OR c): with no assigned rep, "assigned_rep = me" is NULL,
-- the whole test NULL, and IF NOT NULL does not fire — a rep could cancel any
-- colleague's unassigned order. Now COALESCE-wrapped.
DO $$
DECLARE
  v_def  text;
  v_have integer;
  v_old_guard text := E'IF NOT (public.rma_is_manager_or_above()\n          OR v_so.assigned_rep = v_email\n          OR v_so.created_by  = v_email) THEN';
  v_new_guard text := E'IF NOT COALESCE(public.rma_is_manager_or_above()\n          OR v_so.assigned_rep = v_email\n          OR v_so.created_by  = v_email, false) THEN';
  v_anchor text := E'  PERFORM public.release_units(''sales_order'', p_so_id, p_actor_email);';
  v_add text := E'  -- 20260894: goods that left on a delivery are not cancelled by cancelling\n'
             || E'  -- the order (a return is P-05); draft deliveries go with the order.\n'
             || E'  IF EXISTS (SELECT 1 FROM public.deliveries WHERE sales_order_id = p_so_id AND status = ''confirmed'') THEN\n'
             || E'    RAISE EXCEPTION ''Goods have been delivered on this order; it can no longer be cancelled'' USING ERRCODE = ''P0001'';\n'
             || E'  END IF;\n'
             || E'  UPDATE public.deliveries SET status = ''cancelled'', cancelled_by = v_email, cancelled_at = now(), updated_at = now()\n'
             || E'   WHERE sales_order_id = p_so_id AND status = ''draft'';\n\n';
BEGIN
  SELECT replace(pg_get_functiondef('public.cancel_sales_order'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%Goods have been delivered on this order%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old_guard, ''))) / length(v_old_guard);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: cancel_sales_order holds its own-order check % time(s), expected 1', v_have;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: cancel_sales_order releases units % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(replace(v_def, v_old_guard, v_new_guard), v_anchor, v_add || v_anchor);
END $$;

-- rma_reservation_integrity's "confirmed order holds less than it sold" did
-- not count what confirmed deliveries already took, so every partly
-- delivered order was reported.
DO $$
DECLARE
  v_def  text;
  v_have integer;
  v_old  text := E'AND m.ref_type = ''warehouse_stock''), 0)::numeric AS qty';
  v_new  text := E'AND m.ref_type = ''warehouse_stock''), 0)::numeric\n'
              || E'           -- 20260894: what confirmed deliveries took was sold and has left\n'
              || E'           + COALESCE((SELECT SUM(dl.qty) FROM public.delivery_lines dl\n'
              || E'                         JOIN public.deliveries d ON d.id = dl.delivery_id\n'
              || E'                        WHERE d.sales_order_id = so.id AND d.status = ''confirmed''), 0)::numeric AS qty';
BEGIN
  SELECT replace(pg_get_functiondef('public.rma_reservation_integrity'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%what confirmed deliveries took%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: rma_reservation_integrity holds its held-quantity sum % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END $$;

-- The server audit log (20260876) records deliveries like every other document.
DROP TRIGGER IF EXISTS trg_audit_deliveries ON public.deliveries;
CREATE TRIGGER trg_audit_deliveries AFTER INSERT OR DELETE OR UPDATE ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public.rma_audit_row();
DROP TRIGGER IF EXISTS trg_audit_truncate_deliveries ON public.deliveries;
CREATE TRIGGER trg_audit_truncate_deliveries AFTER TRUNCATE ON public.deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION public.rma_audit_truncate();

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.confirm_delivery(uuid, text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.deliveries', 'INSERT')
     OR has_table_privilege('authenticated', 'public.delivery_lines', 'UPDATE') THEN
    RAISE EXCEPTION 'Refusing to finish: deliveries are writable outside their RPCs';
  END IF;
  -- checked on the definition: calling it would burn a number of a gapless sequence
  IF pg_get_functiondef('public.nextval_for_type'::regproc) NOT LIKE '%WHEN ''delivery''       THEN ''DN''%'
     OR NOT EXISTS (SELECT 1 FROM public.document_sequences WHERE seq_type = 'delivery') THEN
    RAISE EXCEPTION 'Refusing to finish: the delivery sequence is not registered as DN-';
  END IF;
  IF pg_get_functiondef('public.cancel_sales_order'::regproc) NOT LIKE '%Goods have been delivered on this order%'
     OR pg_get_functiondef('public.cancel_sales_order'::regproc) NOT LIKE '%IF NOT COALESCE(public.rma_is_manager_or_above()%'
     OR pg_get_functiondef('public.rma_reservation_integrity'::regproc) NOT LIKE '%what confirmed deliveries took%' THEN
    RAISE EXCEPTION 'Refusing to finish: cancel_sales_order or rma_reservation_integrity was not updated';
  END IF;
END $$;
