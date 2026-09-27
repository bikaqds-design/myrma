-- ============================================================================
-- 20260902_customer_returns.sql
-- P-05a — customer returns: goods sold on a delivery come back into stock.
-- Design and the owner's decisions: docs/P05_RETURNS_REFUNDS.md.
-- ============================================================================
-- A return is goods coming back from one confirmed delivery whose invoice is
-- posted. A manager prepares it (which delivery lines, how many, into which
-- sellable warehouse, and for a serialized product exactly which of the units
-- that left on that line) and confirms it: the units become available again in
-- that warehouse at their own cost, the bins are refilled at the delivery
-- line's cost (unknown if any unit on that line had no known cost), every move
-- is on the ledger under doc_type 'customer_return', and a gapless
-- RTN-YYYY-NNNNN code is assigned. The credit note for it is P-05b.
--
-- Owner decisions (2026-09-27): goods first (the credit note is made from the
-- return); back to stock only; managers and above.
--
-- Once a delivery has a return, its invoice is credited, never voided, and the
-- delivery is never invoiced again — either would bill or unbill the goods a
-- second time.
--
-- Pinned by src/test/customerReturns.test.js; supabase/tests/customer_returns.sql
-- is the rolled-back reference script.
-- ============================================================================

-- ── 1. numbering: RTN-YYYY-NNNNN ─────────────────────────────────────────────
INSERT INTO public.document_sequences (seq_type, last_value, seq_year)
VALUES ('customer_return', 0, EXTRACT(YEAR FROM now())::integer)
ON CONFLICT (seq_type) DO NOTHING;

DO $$
DECLARE
  v_def  text;
  v_old  text := '    WHEN ''goods_receipt''  THEN ''GRN''';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.nextval_for_type'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%WHEN ''customer_return''%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: nextval_for_type holds the goods_receipt prefix % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_old || E'\n    WHEN ''customer_return'' THEN ''RTN''');
END $$;

-- a restore cannot carry document_sequences (20260878 resets them from the
-- codes issued), so the reconciler must know returns too
DO $$
DECLARE
  v_def  text;
  v_old  text := '(''goods_receipt'',  ''goods_receipts'',        ''grn_code'',       ''GRN'')';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.rma_reconcile_document_sequences'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%''customer_returns''%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: rma_reconcile_document_sequences lists goods_receipt % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_old || E',\n      (''customer_return'', ''customer_returns'',     ''return_code'',    ''RTN'')');
END $$;

-- ── 2. the ledger knows returns ──────────────────────────────────────────────
ALTER TABLE public.stock_moves DROP CONSTRAINT IF EXISTS stock_moves_doc_type_check;
ALTER TABLE public.stock_moves ADD CONSTRAINT stock_moves_doc_type_check CHECK (doc_type = ANY (ARRAY[
  'sales_order', 'invoice', 'credit_note', 'manual', 'vendor_invoice', 'rma_ticket', 'manufacturer_batch',
  'goods_receipt', 'customer_return']));

-- ── 3. tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.customer_returns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_code     text UNIQUE,                        -- assigned at confirmation
  delivery_id     uuid NOT NULL REFERENCES public.deliveries(id),
  sales_order_id  uuid NOT NULL REFERENCES public.sales_orders(id),
  customer_id     uuid NOT NULL REFERENCES public.customers(id),
  status          text NOT NULL DEFAULT 'draft',
  reason          text,
  notes           text,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_by    text,
  confirmed_at    timestamptz,
  cancelled_by    text,
  cancelled_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_returns_status_check CHECK (status IN ('draft', 'confirmed', 'cancelled')),
  CONSTRAINT customer_returns_confirmed_has_code CHECK (status <> 'confirmed' OR (return_code IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS customer_returns_delivery_idx ON public.customer_returns (delivery_id);

CREATE TABLE IF NOT EXISTS public.customer_return_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_return_id  uuid NOT NULL REFERENCES public.customer_returns(id) ON DELETE CASCADE,
  line_no             integer NOT NULL,
  delivery_line_id    uuid NOT NULL REFERENCES public.delivery_lines(id),
  product_id          uuid NOT NULL REFERENCES public.products(id),
  product_name        text NOT NULL,
  qty                 integer NOT NULL CHECK (qty >= 1),
  warehouse_id        uuid NOT NULL REFERENCES public.warehouses(id),
  unit_ids            uuid[] NOT NULL DEFAULT '{}',     -- serialized: exactly which units
  cost_base           numeric(14,2),                    -- set at confirmation
  cost_unknown_qty    integer NOT NULL DEFAULT 0,
  UNIQUE (customer_return_id, line_no),
  UNIQUE (customer_return_id, delivery_line_id)
);
CREATE INDEX IF NOT EXISTS customer_return_lines_dl_idx ON public.customer_return_lines (delivery_line_id);

CREATE TABLE IF NOT EXISTS public.customer_return_line_units (
  customer_return_line_id uuid NOT NULL REFERENCES public.customer_return_lines(id) ON DELETE CASCADE,
  unit_id                 uuid NOT NULL REFERENCES public.inventory_units(id),
  unit_cost_base          numeric(14,4),
  PRIMARY KEY (customer_return_line_id, unit_id)
);
CREATE TABLE IF NOT EXISTS public.customer_return_line_bins (
  customer_return_line_id uuid NOT NULL REFERENCES public.customer_return_lines(id) ON DELETE CASCADE,
  warehouse_stock_id      uuid NOT NULL REFERENCES public.warehouse_stock(id),
  qty                     integer NOT NULL CHECK (qty >= 1),
  unit_cost_base          numeric(14,4),
  PRIMARY KEY (customer_return_line_id, warehouse_stock_id)
);

COMMENT ON TABLE public.customer_returns IS
  'Goods coming back from a confirmed, invoiced delivery (P-05). Stock returns at confirm_customer_return. Procedure-only: create_customer_return / confirm_customer_return / cancel_customer_return.';

-- Read like the delivery they come back from; written only by the RPCs.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_returns', 'customer_return_lines', 'customer_return_line_units', 'customer_return_line_bins'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "read_customer_returns" ON public.customer_returns;
CREATE POLICY "read_customer_returns" ON public.customer_returns FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.deliveries d WHERE d.id = customer_returns.delivery_id));
DROP POLICY IF EXISTS "read_customer_return_lines" ON public.customer_return_lines;
CREATE POLICY "read_customer_return_lines" ON public.customer_return_lines FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.customer_returns r WHERE r.id = customer_return_lines.customer_return_id));
-- which units / bins and at what cost: as delivery_line_units (manager+ / accountant)
DROP POLICY IF EXISTS "read_customer_return_line_units" ON public.customer_return_line_units;
CREATE POLICY "read_customer_return_line_units" ON public.customer_return_line_units FOR SELECT
  USING (COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = 'accountant', false)
         AND EXISTS (SELECT 1 FROM public.customer_return_lines l WHERE l.id = customer_return_line_units.customer_return_line_id));
DROP POLICY IF EXISTS "read_customer_return_line_bins" ON public.customer_return_line_bins;
CREATE POLICY "read_customer_return_line_bins" ON public.customer_return_line_bins FOR SELECT
  USING (COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = 'accountant', false)
         AND EXISTS (SELECT 1 FROM public.customer_return_lines l WHERE l.id = customer_return_line_bins.customer_return_line_id));

-- the server audit log (20260876) records returns like every other document
DROP TRIGGER IF EXISTS trg_audit_customer_returns ON public.customer_returns;
CREATE TRIGGER trg_audit_customer_returns AFTER INSERT OR DELETE OR UPDATE ON public.customer_returns
  FOR EACH ROW EXECUTE FUNCTION public.rma_audit_row();
DROP TRIGGER IF EXISTS trg_audit_truncate_customer_returns ON public.customer_returns;
CREATE TRIGGER trg_audit_truncate_customer_returns AFTER TRUNCATE ON public.customer_returns
  FOR EACH STATEMENT EXECUTE FUNCTION public.rma_audit_truncate();

-- ── 4. how much of a delivery line has come back ─────────────────────────────
-- Confirmed returns count; drafts hold their quantity too, so two drafts
-- cannot both return the last units.
CREATE OR REPLACE FUNCTION public.rma_delivery_line_returned_qty(p_delivery_line_id uuid, p_include_drafts boolean)
RETURNS integer LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT COALESCE(sum(l.qty), 0)::integer
    FROM public.customer_return_lines l
    JOIN public.customer_returns r ON r.id = l.customer_return_id
   WHERE l.delivery_line_id = p_delivery_line_id
     AND (r.status = 'confirmed' OR (p_include_drafts AND r.status = 'draft'))
$fn$;
REVOKE ALL ON FUNCTION public.rma_delivery_line_returned_qty(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_delivery_line_returned_qty(uuid, boolean) TO authenticated, service_role;

-- a warehouse goods may go back into: sellable (main / branch / legacy
-- untyped), not a system location, not archived — as confirm_goods_receipt
CREATE OR REPLACE FUNCTION public._rma_warehouse_is_sellable(p_warehouse_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.warehouses w
                  WHERE w.id = p_warehouse_id AND NOT COALESCE(w.is_system, false) AND COALESCE(w.is_active, true)
                    AND COALESCE(w.warehouse_type, 'main') IN ('main', 'branch'))
$fn$;
REVOKE ALL ON FUNCTION public._rma_warehouse_is_sellable(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._rma_warehouse_is_sellable(uuid) TO service_role;

-- ── 5. create_customer_return ────────────────────────────────────────────────
-- p_lines: [{delivery_line_id, qty, warehouse_id, unit_ids: [uuid, ...]}]
--   serialized: unit_ids are the units coming back (qty, if given, must match)
--   bulk: qty, no unit_ids
-- p_fields: {reason, notes}
CREATE OR REPLACE FUNCTION public.create_customer_return(p_delivery_id uuid, p_lines jsonb, p_fields jsonb, p_actor_email text)
RETURNS public.customer_returns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_actor  text := public.rma_current_user_email();
  v_d      public.deliveries;
  v_r      public.customer_returns;
  v_x      jsonb;
  v_dl     record;
  v_qty    integer;
  v_wh     uuid;
  v_units  uuid[];
  v_u      jsonb;
  v_uid    uuid;
  v_n      integer := 0;
  v_seen   uuid[] := '{}';
  v_reason text;
  v_notes  text;
BEGIN
  IF v_actor IS NULL OR NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Only managers and above can record a return' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_d FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery % not found', p_delivery_id USING ERRCODE = 'P0001';
  END IF;
  IF v_d.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Only goods from a confirmed delivery can be returned (this one is %)', v_d.status USING ERRCODE = 'P0001';
  END IF;
  -- goods first, then the credit note, which credits the posted invoice
  IF NOT EXISTS (SELECT 1 FROM public.crm_invoices WHERE delivery_id = p_delivery_id AND doc_status = 'posted') THEN
    RAISE EXCEPTION 'This delivery has no posted invoice yet. Invoice it first; the return is then credited against that invoice'
      USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'A return needs at least one line' USING ERRCODE = 'P0001';
  END IF;
  IF p_fields IS NOT NULL AND jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'Fields must be an object' USING ERRCODE = 'P0001';
  END IF;
  v_reason := NULLIF(btrim(p_fields ->> 'reason'), '');
  v_notes  := NULLIF(btrim(p_fields ->> 'notes'), '');

  INSERT INTO public.customer_returns (delivery_id, sales_order_id, customer_id, reason, notes, created_by)
  VALUES (v_d.id, v_d.sales_order_id, v_d.customer_id, v_reason, v_notes, v_actor)
  RETURNING * INTO v_r;

  FOR v_x IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(v_x) <> 'object' THEN
      RAISE EXCEPTION 'Each return line must be an object' USING ERRCODE = 'P0001';
    END IF;
    IF COALESCE(v_x ->> 'delivery_line_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Each return line needs the delivery line it comes back from' USING ERRCODE = 'P0001';
    END IF;
    SELECT dl.*, p.stock_tracking_mode INTO v_dl
      FROM public.delivery_lines dl
      JOIN public.products p ON p.id = dl.product_id
     WHERE dl.id = (v_x ->> 'delivery_line_id')::uuid AND dl.delivery_id = p_delivery_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'That line is not on this delivery' USING ERRCODE = 'P0001';
    END IF;
    IF v_dl.id = ANY (v_seen) THEN
      RAISE EXCEPTION '%: listed twice in this return', v_dl.product_name USING ERRCODE = 'P0001';
    END IF;
    v_seen := v_seen || v_dl.id;

    IF COALESCE(v_x ->> 'warehouse_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT public._rma_warehouse_is_sellable((v_x ->> 'warehouse_id')::uuid) THEN
      RAISE EXCEPTION '%: choose a sellable warehouse (main or branch) for the goods to go back into', v_dl.product_name
        USING ERRCODE = 'P0001';
    END IF;
    v_wh := (v_x ->> 'warehouse_id')::uuid;

    -- quantity: a whole number, judged as text first ("1e3", "2.5", "-1" refused)
    IF v_x ? 'qty' AND jsonb_typeof(v_x -> 'qty') <> 'null'
       AND (jsonb_typeof(v_x -> 'qty') NOT IN ('number', 'string') OR (v_x ->> 'qty') !~ '^[0-9]{1,6}$') THEN
      RAISE EXCEPTION '%: the quantity must be a whole number', v_dl.product_name USING ERRCODE = 'P0001';
    END IF;
    v_qty := NULLIF(v_x ->> 'qty', '')::integer;

    v_units := '{}';
    IF v_dl.stock_tracking_mode = 'bulk' THEN
      IF jsonb_typeof(v_x -> 'unit_ids') = 'array' AND jsonb_array_length(v_x -> 'unit_ids') > 0 THEN
        RAISE EXCEPTION '%: a bulk product is returned by quantity, not by unit', v_dl.product_name USING ERRCODE = 'P0001';
      END IF;
    ELSE
      IF jsonb_typeof(v_x -> 'unit_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(v_x -> 'unit_ids') = 0 THEN
        RAISE EXCEPTION '%: choose which units are coming back', v_dl.product_name USING ERRCODE = 'P0001';
      END IF;
      FOR v_u IN SELECT value FROM jsonb_array_elements(v_x -> 'unit_ids') LOOP
        IF jsonb_typeof(v_u) <> 'string' OR (v_u #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          RAISE EXCEPTION '%: a unit is not identified', v_dl.product_name USING ERRCODE = 'P0001';
        END IF;
        v_uid := (v_u #>> '{}')::uuid;
        IF v_uid = ANY (v_units) THEN
          RAISE EXCEPTION '%: a unit is listed twice', v_dl.product_name USING ERRCODE = 'P0001';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.delivery_line_units WHERE delivery_line_id = v_dl.id AND unit_id = v_uid) THEN
          RAISE EXCEPTION '%: a unit did not leave on this delivery line', v_dl.product_name USING ERRCODE = 'P0001';
        END IF;
        IF EXISTS (SELECT 1 FROM public.customer_return_lines l
                     JOIN public.customer_returns r ON r.id = l.customer_return_id
                    WHERE l.delivery_line_id = v_dl.id AND r.status <> 'cancelled' AND r.id <> v_r.id
                      AND v_uid = ANY (l.unit_ids)) THEN
          RAISE EXCEPTION '%: a unit has already come back (or is on another draft return)', v_dl.product_name USING ERRCODE = 'P0001';
        END IF;
        v_units := v_units || v_uid;
      END LOOP;
      IF v_qty IS NOT NULL AND v_qty <> cardinality(v_units) THEN
        RAISE EXCEPTION '%: % units chosen but the quantity says %', v_dl.product_name, cardinality(v_units), v_qty USING ERRCODE = 'P0001';
      END IF;
      v_qty := cardinality(v_units);
    END IF;

    IF v_qty IS NULL OR v_qty < 1 THEN
      RAISE EXCEPTION '%: the quantity must be at least 1', v_dl.product_name USING ERRCODE = 'P0001';
    END IF;
    -- never more than left on this line, drafts counted
    IF public.rma_delivery_line_returned_qty(v_dl.id, true) + v_qty > v_dl.qty THEN
      RAISE EXCEPTION '%: % left on this delivery, % already came back or are on a draft return',
        v_dl.product_name, v_dl.qty, public.rma_delivery_line_returned_qty(v_dl.id, true) USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.customer_return_lines
      (customer_return_id, line_no, delivery_line_id, product_id, product_name, qty, warehouse_id, unit_ids)
    VALUES (v_r.id, v_n, v_dl.id, v_dl.product_id, v_dl.product_name, v_qty, v_wh, v_units);
    v_n := v_n + 1;
  END LOOP;

  RETURN v_r;
END
$fn$;

-- ── 6. confirm_customer_return ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.confirm_customer_return(p_return_id uuid, p_actor_email text)
RETURNS public.customer_returns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_actor  text := public.rma_current_user_email();
  v_did    uuid;
  v_r      public.customer_returns;
  v_l      record;
  v_uid    uuid;
  v_unit   public.inventory_units;
  v_cost   numeric;
  v_avg    numeric;
  v_known  numeric;
  v_unk    integer;
  v_ws_id  uuid;
BEGIN
  IF v_actor IS NULL OR NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Only managers and above can confirm a return' USING ERRCODE = 'P0001';
  END IF;

  -- the delivery first (as create_customer_return), then the return
  SELECT delivery_id INTO v_did FROM public.customer_returns WHERE id = p_return_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return % not found', p_return_id USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM public.deliveries WHERE id = v_did FOR UPDATE;
  SELECT * INTO v_r FROM public.customer_returns WHERE id = p_return_id FOR UPDATE;
  IF v_r.status <> 'draft' THEN
    RAISE EXCEPTION 'This return is already %', v_r.status USING ERRCODE = 'P0001';
  END IF;
  -- the invoice may have been voided since the draft
  IF NOT EXISTS (SELECT 1 FROM public.crm_invoices WHERE delivery_id = v_did AND doc_status = 'posted') THEN
    RAISE EXCEPTION 'This delivery no longer has a posted invoice; cancel this draft return' USING ERRCODE = 'P0001';
  END IF;

  FOR v_l IN
    SELECT l.*, dl.qty AS delivered, p.stock_tracking_mode
      FROM public.customer_return_lines l
      JOIN public.delivery_lines dl ON dl.id = l.delivery_line_id
      JOIN public.products p ON p.id = l.product_id
     WHERE l.customer_return_id = p_return_id
     ORDER BY l.line_no
  LOOP
    IF public.rma_delivery_line_returned_qty(v_l.delivery_line_id, false) + v_l.qty > v_l.delivered THEN
      RAISE EXCEPTION '%: more would come back than left on this delivery', v_l.product_name USING ERRCODE = 'P0001';
    END IF;
    -- the warehouse may have been archived or re-typed since the draft
    IF NOT public._rma_warehouse_is_sellable(v_l.warehouse_id) THEN
      RAISE EXCEPTION '%: its warehouse can no longer take stock; cancel this draft and choose another', v_l.product_name
        USING ERRCODE = 'P0001';
    END IF;

    v_known := 0; v_unk := 0;
    IF v_l.stock_tracking_mode = 'bulk' THEN
      -- the delivery line's cost per unit, known only if every unit it took had one
      SELECT CASE WHEN count(*) > 0 AND bool_and(b.avg_cost_base IS NOT NULL)
                  THEN round(sum(b.qty * b.avg_cost_base) / sum(b.qty), 4) END
        INTO v_avg
        FROM public.delivery_line_bins b WHERE b.delivery_line_id = v_l.delivery_line_id;

      PERFORM set_config('rma.cost_stated', 'on', true);   -- the cost is stated (or stated unknown)
      SELECT id INTO v_ws_id FROM public.warehouse_stock
       WHERE product_id = v_l.product_id AND warehouse_id = v_l.warehouse_id FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO public.warehouse_stock
          (product_id, warehouse_id, quantity, reserved_quantity, total_cost_base, uncosted_quantity)
        VALUES (v_l.product_id, v_l.warehouse_id, v_l.qty, 0,
                CASE WHEN v_avg IS NULL THEN 0 ELSE round(v_avg * v_l.qty, 4) END,
                CASE WHEN v_avg IS NULL THEN v_l.qty ELSE 0 END)
        RETURNING id INTO v_ws_id;
      ELSIF v_avg IS NULL THEN
        UPDATE public.warehouse_stock
           SET quantity = quantity + v_l.qty, uncosted_quantity = uncosted_quantity + v_l.qty, updated_at = now()
         WHERE id = v_ws_id;
      ELSE
        UPDATE public.warehouse_stock
           SET quantity = quantity + v_l.qty, total_cost_base = total_cost_base + round(v_avg * v_l.qty, 4), updated_at = now()
         WHERE id = v_ws_id;
      END IF;
      PERFORM set_config('rma.cost_stated', 'off', true);
      INSERT INTO public.stock_moves (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
      VALUES ('warehouse_stock', v_ws_id, 'customer_return', p_return_id, 'restore', v_l.qty, 'delivered', 'available', v_actor);
      INSERT INTO public.customer_return_line_bins (customer_return_line_id, warehouse_stock_id, qty, unit_cost_base)
      VALUES (v_l.id, v_ws_id, v_l.qty, v_avg);
      IF v_avg IS NULL THEN v_unk := v_l.qty; ELSE v_known := v_avg * v_l.qty; END IF;
    ELSE
      IF cardinality(v_l.unit_ids) <> v_l.qty THEN
        RAISE EXCEPTION '%: % units to return but % chosen', v_l.product_name, v_l.qty, cardinality(v_l.unit_ids) USING ERRCODE = 'P0001';
      END IF;
      FOREACH v_uid IN ARRAY v_l.unit_ids LOOP
        SELECT * INTO v_unit FROM public.inventory_units WHERE id = v_uid FOR UPDATE;
        -- still out with the customer: a unit the customer has since sent in
        -- for repair is on an RMA ticket, not a return
        IF NOT FOUND OR v_unit.status <> 'company_stock' OR v_unit.reservation_status <> 'delivered' THEN
          RAISE EXCEPTION '%: unit % is no longer with the customer (it may be on an RMA ticket)',
            v_l.product_name, COALESCE(v_unit.serial_number, v_uid::text) USING ERRCODE = 'P0001';
        END IF;
        IF EXISTS (SELECT 1 FROM public.customer_return_line_units ru
                     JOIN public.customer_return_lines l2 ON l2.id = ru.customer_return_line_id
                    WHERE ru.unit_id = v_uid AND l2.delivery_line_id = v_l.delivery_line_id) THEN
          RAISE EXCEPTION '%: unit % has already come back from this delivery', v_l.product_name, v_unit.serial_number USING ERRCODE = 'P0001';
        END IF;
        UPDATE public.inventory_units
           SET reservation_status = 'available', warehouse_id = v_l.warehouse_id
         WHERE id = v_uid;
        INSERT INTO public.stock_moves (ref_type, ref_id, doc_type, doc_id, move_type, qty, from_status, to_status, actor_email)
        VALUES ('unit', v_uid, 'customer_return', p_return_id, 'restore', 1, 'delivered', 'available', v_actor);
        INSERT INTO public.customer_return_line_units (customer_return_line_id, unit_id, unit_cost_base)
        VALUES (v_l.id, v_uid, v_unit.unit_cost_base);
        IF v_unit.unit_cost_base IS NULL THEN v_unk := v_unk + 1; ELSE v_known := v_known + v_unit.unit_cost_base; END IF;
      END LOOP;
    END IF;

    UPDATE public.customer_return_lines SET cost_base = round(v_known, 2), cost_unknown_qty = v_unk WHERE id = v_l.id;
  END LOOP;

  UPDATE public.customer_returns
     SET status = 'confirmed', return_code = public.nextval_for_type('customer_return'),
         confirmed_by = v_actor, confirmed_at = now(), updated_at = now()
   WHERE id = p_return_id
  RETURNING * INTO v_r;
  RETURN v_r;
END
$fn$;

-- ── 7. cancel_customer_return: a draft only ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_customer_return(p_return_id uuid, p_actor_email text)
RETURNS public.customer_returns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_r     public.customer_returns;
BEGIN
  IF v_actor IS NULL OR NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Only managers and above can cancel a return' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_r FROM public.customer_returns WHERE id = p_return_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return % not found', p_return_id USING ERRCODE = 'P0001';
  END IF;
  IF v_r.status <> 'draft' THEN
    RAISE EXCEPTION 'A % return cannot be cancelled — the goods are back in stock', v_r.status USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.customer_returns SET status = 'cancelled', cancelled_by = v_actor, cancelled_at = now(), updated_at = now()
   WHERE id = p_return_id RETURNING * INTO v_r;
  RETURN v_r;
END
$fn$;

DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['create_customer_return(uuid, jsonb, jsonb, text)', 'confirm_customer_return(uuid, text)',
                           'cancel_customer_return(uuid, text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', s);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', s);
  END LOOP;
END $$;

-- ── 8. a delivery with a return is credited, never voided or re-invoiced ─────
DO $$
DECLARE
  v_def  text;
  v_old  text := E'  IF EXISTS (SELECT 1 FROM public.crm_invoices WHERE delivery_id = p_delivery_id AND doc_status <> ''cancelled'') THEN';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.create_invoice_from_delivery'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%-- 20260902:%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: create_invoice_from_delivery holds its duplicate check % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old,
       E'  -- 20260902: goods from it have come back, so it is credited, never billed again\n'
    || E'  IF EXISTS (SELECT 1 FROM public.customer_returns WHERE delivery_id = p_delivery_id AND status <> ''cancelled'') THEN\n'
    || E'    RAISE EXCEPTION ''Goods from this delivery have been returned; it cannot be invoiced again'' USING ERRCODE = ''P0001'';\n'
    || E'  END IF;\n\n'
    || v_old);
END $$;

DO $$
DECLARE
  v_def  text;
  v_old  text := E'  IF v_inv.so_id IS NOT NULL AND v_inv.delivery_id IS NULL THEN\n    SELECT array_agg(DISTINCT ref_id) INTO v_unit_ids';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.void_invoice'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%-- 20260902:%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: void_invoice holds its unit restore % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old,
       E'  -- 20260902: goods from its delivery have come back; voiding would leave the\n'
    || E'  -- goods the customer kept unbilled for ever (the delivery is not invoiced again)\n'
    || E'  IF v_inv.delivery_id IS NOT NULL AND EXISTS (\n'
    || E'       SELECT 1 FROM public.customer_returns WHERE delivery_id = v_inv.delivery_id AND status <> ''cancelled'') THEN\n'
    || E'    RAISE EXCEPTION ''Goods from this invoice''''s delivery have been returned; credit it with a credit note instead of voiding it''\n'
    || E'      USING ERRCODE = ''P0001'';\n'
    || E'  END IF;\n\n'
    || v_old);
END $$;

-- ── 9. Backup & Restore: the restorable BACKUP_TABLES, in order ──────────────
-- (src/test/restoreManifest.test.js fails if the two drift apart)
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
    'vendor_payment_applications', 'goods_receipts', 'goods_receipt_lines',
    'vendor_invoice_receipt_lines', 'purchase_cost_adjustments', 'manufacturer_batches',
    'inventory_units', 'warehouse_stock', 'goods_receipt_line_units', 'goods_receipt_line_bins',
    'quotations', 'quotation_lines', 'sales_orders', 'sales_order_lines', 'deliveries',
    'delivery_lines', 'delivery_line_units', 'delivery_line_bins', 'customer_returns',
    'customer_return_lines', 'customer_return_line_units', 'customer_return_line_bins',
    'crm_invoices', 'crm_invoice_lines', 'invoices', 'payments', 'payment_applications',
    'credit_notes', 'credit_note_lines', 'credit_note_applications', 'activities',
    'notifications', 'user_activity_log'
  ]::text[]
$function$;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.confirm_customer_return(uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.create_customer_return(uuid, jsonb, jsonb, text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.customer_returns', 'INSERT')
     OR has_table_privilege('authenticated', 'public.customer_return_lines', 'UPDATE') THEN
    RAISE EXCEPTION 'Refusing to finish: customer returns are writable outside their RPCs';
  END IF;
  -- checked on the definition: calling it would burn a number of a gapless sequence
  IF pg_get_functiondef('public.nextval_for_type'::regproc) NOT LIKE '%WHEN ''customer_return'' THEN ''RTN''%'
     OR NOT EXISTS (SELECT 1 FROM public.document_sequences WHERE seq_type = 'customer_return')
     OR pg_get_functiondef('public.rma_reconcile_document_sequences'::regproc) NOT LIKE '%''customer_returns''%' THEN
    RAISE EXCEPTION 'Refusing to finish: the customer_return sequence is not registered as RTN-';
  END IF;
  IF pg_get_functiondef('public.create_invoice_from_delivery'::regproc) NOT LIKE '%it cannot be invoiced again%'
     OR pg_get_functiondef('public.void_invoice'::regproc) NOT LIKE '%credit it with a credit note instead of voiding it%' THEN
    RAISE EXCEPTION 'Refusing to finish: create_invoice_from_delivery or void_invoice was not updated';
  END IF;
END $$;
