-- ============================================================================
-- 20260888_purchase_order_lines.sql
-- W2 / L-01, fifth document type — purchase orders. Same design as 20260883
-- (quotations), 20260884 (sales orders), 20260885 (invoices) and 20260887
-- (credit notes); read 20260883 first.
--
-- WHAT DIFFERS
--   * Who may write is manager+ only: the policy this replaces is
--     manager_write_purchase_orders (FOR ALL, rma_is_manager_or_above()).
--   * The browser computed a PO's totals and wrote them, with the lines, by a
--     direct INSERT/UPDATE (purchaseOrders.create / update), on any status the
--     lock did not cover: a PO awaiting confirmation (sent /
--     pending_confirmation) could have its lines and figures changed after
--     the approver was asked. create_purchase_order / update_purchase_order
--     now write it, and only a DRAFT is edited — to change one that is
--     waiting, send it back to draft; a confirmed one is amended.
--   * Lines are catalogue products with qty_ordered / unit_cost (the purchase
--     shape, not the sales one). The quantity is a whole number of at least 1
--     (the form only ever sent one; amend_purchase_order used to accept 2.5).
--   * amend_purchase_order (20260881) writes the rows too, and decides "a
--     price, discount or tax the old order did not carry" against the old
--     ROWS. Its snapshot keeps the old line_items mirror. It now takes the
--     actor from the login only (it fell back to the parameter).
--   * Direct client updates keep what the screens do on their own: status
--     (policed by assert_purchase_status_transition and
--     rma_guard_approval_authority) and the archive fields.
--
-- Readers of purchase_orders.line_items (purchaseOrders.convertToVendorInvoice,
-- the PO PDF, the screens) see the mirror and did not change. The vendor
-- invoice is the next document type.
-- ============================================================================

-- ── 1. the table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.purchase_order_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id  uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  line_no            integer NOT NULL,
  -- Nullable only so historical orders can be copied as they are; every line
  -- written from now on names a product.
  product_id         uuid REFERENCES public.products(id),
  product_name       text NOT NULL,
  description        text,
  qty_ordered        integer NOT NULL,
  unit_cost          numeric(14,4) NOT NULL DEFAULT 0,
  discount_pct       numeric(5,2) NOT NULL DEFAULT 0,
  tax_pct            numeric(5,2) NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_order_lines_qty_positive   CHECK (qty_ordered >= 1),
  CONSTRAINT purchase_order_lines_cost_nonneg    CHECK (unit_cost >= 0),
  CONSTRAINT purchase_order_lines_discount_range CHECK (discount_pct >= 0 AND discount_pct <= 100),
  CONSTRAINT purchase_order_lines_tax_range      CHECK (tax_pct >= 0 AND tax_pct <= 100),
  CONSTRAINT purchase_order_lines_name_present   CHECK (length(btrim(product_name)) > 0),
  CONSTRAINT purchase_order_lines_unique_line    UNIQUE (purchase_order_id, line_no)
);

CREATE INDEX IF NOT EXISTS purchase_order_lines_po_idx ON public.purchase_order_lines (purchase_order_id);
CREATE INDEX IF NOT EXISTS purchase_order_lines_product_idx ON public.purchase_order_lines (product_id) WHERE product_id IS NOT NULL;

COMMENT ON TABLE public.purchase_order_lines IS
  'One row per purchase-order line. Source of truth; purchase_orders.line_items is a read-only mirror maintained by create_purchase_order / update_purchase_order / amend_purchase_order. Client writes are revoked.';

ALTER TABLE public.purchase_order_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_purchase_order_lines" ON public.purchase_order_lines;
CREATE POLICY "read_purchase_order_lines"
  ON public.purchase_order_lines
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.purchase_orders o WHERE o.id = purchase_order_lines.purchase_order_id));

REVOKE ALL ON TABLE public.purchase_order_lines FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.purchase_order_lines FROM authenticated;
GRANT SELECT ON TABLE public.purchase_order_lines TO authenticated;
GRANT ALL ON TABLE public.purchase_order_lines TO service_role;

-- ── 2. the client surface ────────────────────────────────────────────────────
-- Directly, a client may change only what markSent / markConfirmed /
-- rejectToDraft / cancel and archiving change. Everything else goes through
-- update_purchase_order (a draft) or amend_purchase_order (a confirmed order).
CREATE OR REPLACE FUNCTION public.rma_guard_purchase_order_allowlist()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_open text[] := ARRAY['status', 'archived', 'archived_at', 'archived_by', 'updated_at'];
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- A stored generated column (total_base) reads as NULL in NEW inside a
  -- BEFORE trigger and would look changed on every update.
  SELECT v_open || COALESCE(array_agg(a.attname::text), ARRAY[]::text[])
    INTO v_open
    FROM pg_attribute a
   WHERE a.attrelid = TG_RELID AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated <> '';

  IF (to_jsonb(NEW) - v_open) IS DISTINCT FROM (to_jsonb(OLD) - v_open) THEN
    RAISE EXCEPTION 'A purchase order''s lines, amounts and details are changed through the order form (update_purchase_order) or, once confirmed, by amending it — not directly.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.rma_guard_purchase_order_allowlist() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_guard_purchase_order_allowlist() TO service_role;

DROP TRIGGER IF EXISTS trg_purchase_orders_allowlist ON public.purchase_orders;
CREATE TRIGGER trg_purchase_orders_allowlist
  BEFORE UPDATE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_purchase_order_allowlist();

-- A purchase order is created by create_purchase_order only.
REVOKE INSERT ON TABLE public.purchase_orders FROM authenticated;

-- ── 3. writing the lines (internal) ──────────────────────────────────────────
-- Every line an existing catalogue product, whose catalogue name fills a
-- missing one; totals from the rows as stored (discount on the line base, tax
-- on the discounted amount, rounded once at the end).
CREATE OR REPLACE FUNCTION public._purchase_order_write_lines(p_po_id uuid, p_lines jsonb)
RETURNS TABLE (subtotal numeric, discount_amount numeric, tax_amount numeric, total numeric, line_items jsonb)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_line  jsonb;
  v_no    integer := 0;
  v_name  text;
  v_pid   text;
  v_qty   text;
  v_cost  text;
  v_dpct  text;
  v_tpct  text;
  v_cat   text;
  v_sub   numeric := 0;
  v_dsum  numeric := 0;
  v_tsum  numeric := 0;
BEGIN
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'An order needs at least one line' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_lines) > 500 THEN
    RAISE EXCEPTION 'A purchase order can have at most 500 lines' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.purchase_order_lines WHERE purchase_order_id = p_po_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Line % is not a line item', v_no + 1 USING ERRCODE = 'P0001';
    END IF;

    v_name := btrim(COALESCE(v_line->>'product_name', ''));
    v_pid  := btrim(COALESCE(v_line->>'product_id', ''));
    v_qty  := btrim(COALESCE(v_line->>'qty_ordered', ''));
    v_cost := COALESCE(NULLIF(btrim(COALESCE(v_line->>'unit_cost', '')), ''), '0');
    v_dpct := COALESCE(NULLIF(btrim(COALESCE(v_line->>'discount_pct', '')), ''), '0');
    v_tpct := COALESCE(NULLIF(btrim(COALESCE(v_line->>'tax_pct', '')), ''), '0');

    IF v_pid = '' THEN
      RAISE EXCEPTION 'Line "%": a purchase order line must be a catalogue product', COALESCE(NULLIF(v_name, ''), (v_no + 1)::text) USING ERRCODE = 'P0001';
    END IF;
    IF v_pid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Line "%": the product reference is not valid', COALESCE(NULLIF(v_name, ''), (v_no + 1)::text) USING ERRCODE = 'P0001';
    END IF;
    SELECT p.product_name INTO v_cat FROM public.products p WHERE p.id = v_pid::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Line "%": that product does not exist', COALESCE(NULLIF(v_name, ''), (v_no + 1)::text) USING ERRCODE = 'P0001';
    END IF;
    v_name := COALESCE(NULLIF(v_name, ''), NULLIF(btrim(v_cat), ''), '(unnamed product)');
    IF length(v_name) > 300 THEN
      RAISE EXCEPTION 'Line "%": the product name is longer than 300 characters', left(v_name, 40) USING ERRCODE = 'P0001';
    END IF;
    -- Text first: NaN and Infinity are valid numerics that pass a range test.
    IF v_qty !~ '^[0-9]{1,9}$' OR v_qty::integer < 1 THEN
      RAISE EXCEPTION 'Line "%": quantity must be a whole number of at least 1', v_name USING ERRCODE = 'P0001';
    END IF;
    IF v_cost !~ '^[0-9]{1,10}(\.[0-9]+)?$' THEN
      RAISE EXCEPTION 'Line "%": unit cost must be 0 or more', v_name USING ERRCODE = 'P0001';
    END IF;
    IF v_dpct !~ '^[0-9]{1,3}(\.[0-9]+)?$' OR v_dpct::numeric > 100 THEN
      RAISE EXCEPTION 'Line "%": discount must be between 0 and 100', v_name USING ERRCODE = 'P0001';
    END IF;
    IF v_tpct !~ '^[0-9]{1,3}(\.[0-9]+)?$' OR v_tpct::numeric > 100 THEN
      RAISE EXCEPTION 'Line "%": tax must be between 0 and 100', v_name USING ERRCODE = 'P0001';
    END IF;

    BEGIN
      INSERT INTO public.purchase_order_lines
        (purchase_order_id, line_no, product_id, product_name, description, qty_ordered, unit_cost, discount_pct, tax_pct)
      VALUES (
        p_po_id, v_no, v_pid::uuid, v_name,
        NULLIF(btrim(COALESCE(v_line->>'description', '')), ''),
        v_qty::integer, v_cost::numeric, v_dpct::numeric, v_tpct::numeric
      );
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'Line "%": that product does not exist', v_name USING ERRCODE = 'P0001';
    END;

    v_no := v_no + 1;
  END LOOP;

  SELECT COALESCE(sum(b.base), 0),
         COALESCE(sum(b.disc), 0),
         COALESCE(sum((b.base - b.disc) * b.tax_pct / 100), 0)
    INTO v_sub, v_dsum, v_tsum
    FROM (SELECT l.qty_ordered * l.unit_cost                        AS base,
                 l.qty_ordered * l.unit_cost * l.discount_pct / 100 AS disc,
                 l.tax_pct
            FROM public.purchase_order_lines l WHERE l.purchase_order_id = p_po_id) b;

  -- purchase_orders' money columns are numeric(12,2)
  IF v_sub >= 10000000000 OR v_sub - v_dsum + v_tsum >= 10000000000 THEN
    RAISE EXCEPTION 'This order is too large to store (a total of 10 billion or more)' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT round(v_sub, 2), round(v_dsum, 2), round(v_tsum, 2), round(v_sub - v_dsum + v_tsum, 2),
         (SELECT jsonb_agg(jsonb_build_object(
                   'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
                   'qty_ordered', l.qty_ordered, 'unit_cost', l.unit_cost, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
                 ORDER BY l.line_no)
            FROM public.purchase_order_lines l WHERE l.purchase_order_id = p_po_id);
END
$function$;

REVOKE ALL ON FUNCTION public._purchase_order_write_lines(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._purchase_order_write_lines(uuid, jsonb) TO service_role;

-- ── 4. header fields (internal) ──────────────────────────────────────────────
-- The fields create and update may set, by key presence: a key with null
-- blanks the field, a missing key leaves it. Dates are read as text first so a
-- malformed one is refused readably.
CREATE OR REPLACE FUNCTION public._purchase_order_check_fields(p_fields jsonb, p_allowed text[])
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_key text;
BEGIN
  IF jsonb_typeof(p_fields) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Fields must be an object' USING ERRCODE = 'P0001';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_fields) LOOP
    IF NOT (v_key = ANY (p_allowed)) THEN
      RAISE EXCEPTION 'The field "%" cannot be set here', v_key USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['issue_date', 'expected_delivery_date'] LOOP
    IF p_fields ? v_key AND NULLIF(btrim(COALESCE(p_fields->>v_key, '')), '') IS NOT NULL THEN
      -- ISO text first: 'infinity', 'epoch' and 'today' are valid date input
      IF btrim(p_fields->>v_key) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'The % is not a valid date', replace(v_key, '_', ' ') USING ERRCODE = 'P0001';
      END IF;
      BEGIN
        PERFORM (p_fields->>v_key)::date;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'The % is not a valid date', replace(v_key, '_', ' ') USING ERRCODE = 'P0001';
      END;
    END IF;
  END LOOP;
  IF p_fields ? 'exchange_rate' AND COALESCE(btrim(p_fields->>'exchange_rate'), '') !~ '^[0-9]{1,10}(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'The exchange rate must be a positive number' USING ERRCODE = 'P0001';
  END IF;
  IF p_fields ? 'exchange_rate' AND (p_fields->>'exchange_rate')::numeric <= 0 THEN
    RAISE EXCEPTION 'The exchange rate must be a positive number' USING ERRCODE = 'P0001';
  END IF;
  IF p_fields ? 'currency' AND COALESCE(btrim(p_fields->>'currency'), '') !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'The currency must be a three-letter code' USING ERRCODE = 'P0001';
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION public._purchase_order_check_fields(jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._purchase_order_check_fields(jsonb, text[]) TO service_role;

-- ── 5. create_purchase_order ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_purchase_order(
  p_vendor_id   uuid,
  p_lines       jsonb,
  p_fields      jsonb,
  p_actor_email text
)
RETURNS public.purchase_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_id    uuid := gen_random_uuid();
  v_f     jsonb := COALESCE(p_fields, '{}'::jsonb);
  v_code  text;
  v_t     record;
  v_row   public.purchase_orders;
BEGIN
  -- The policy this replaces (manager_write_purchase_orders).
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Not authorized to create a purchase order' USING ERRCODE = 'P0001';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Your login has no email, so this purchase order cannot be attributed' USING ERRCODE = 'P0001';
  END IF;
  IF p_vendor_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.brands b WHERE b.id = p_vendor_id) THEN
    RAISE EXCEPTION 'A vendor is required' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public._purchase_order_check_fields(v_f, ARRAY[
    'currency', 'exchange_rate', 'issue_date', 'expected_delivery_date', 'payment_terms', 'delivery_terms',
    'shipping_address', 'billing_address', 'terms_conditions', 'notes']);
  IF NULLIF(btrim(COALESCE(v_f->>'currency', '')), '') IS NULL THEN
    RAISE EXCEPTION 'A currency is required' USING ERRCODE = 'P0001';
  END IF;

  v_code := public.generate_doc_code('PO');

  INSERT INTO public.purchase_orders
    (id, po_code, vendor_id, status, line_items, currency, exchange_rate,
     issue_date, expected_delivery_date, payment_terms, delivery_terms,
     shipping_address, billing_address, terms_conditions, notes, created_by)
  VALUES (
    v_id, v_code, p_vendor_id, 'draft', '[]'::jsonb, v_f->>'currency', COALESCE((v_f->>'exchange_rate')::numeric, 1),
    NULLIF(btrim(COALESCE(v_f->>'issue_date', '')), '')::date,
    NULLIF(btrim(COALESCE(v_f->>'expected_delivery_date', '')), '')::date,
    NULLIF(v_f->>'payment_terms', ''), NULLIF(v_f->>'delivery_terms', ''),
    NULLIF(v_f->>'shipping_address', ''), NULLIF(v_f->>'billing_address', ''),
    NULLIF(v_f->>'terms_conditions', ''), NULLIF(v_f->>'notes', ''), v_actor
  );

  SELECT * INTO v_t FROM public._purchase_order_write_lines(v_id, p_lines);

  UPDATE public.purchase_orders SET
    line_items      = v_t.line_items,
    subtotal        = v_t.subtotal,
    discount_amount = v_t.discount_amount,
    tax_amount      = v_t.tax_amount,
    total           = v_t.total
  WHERE id = v_id
  RETURNING * INTO v_row;

  RETURN v_row;
END
$function$;

REVOKE ALL ON FUNCTION public.create_purchase_order(uuid, jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_purchase_order(uuid, jsonb, jsonb, text) TO authenticated, service_role;

-- ── 6. update_purchase_order: a draft only ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_purchase_order(
  p_id          uuid,
  p_lines       jsonb,
  p_fields      jsonb,
  p_actor_email text
)
RETURNS public.purchase_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_f     jsonb := COALESCE(p_fields, '{}'::jsonb);
  v_po    public.purchase_orders;
  v_items jsonb;
  v_sub   numeric;
  v_dis   numeric;
  v_tax   numeric;
  v_tot   numeric;
  v_row   public.purchase_orders;
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) OR v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authorized to edit a purchase order' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public._purchase_order_check_fields(v_f, ARRAY[
    'currency', 'exchange_rate', 'issue_date', 'expected_delivery_date', 'payment_terms', 'delivery_terms',
    'shipping_address', 'billing_address', 'terms_conditions', 'notes']);
  IF v_f ? 'currency' AND NULLIF(btrim(COALESCE(v_f->>'currency', '')), '') IS NULL THEN
    RAISE EXCEPTION 'A currency is required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order % not found', p_id USING ERRCODE = 'P0001';
  END IF;
  -- Sent and pending orders await confirmation of exactly these figures; a
  -- confirmed one is amended (amend_purchase_order).
  IF v_po.status <> 'draft' THEN
    RAISE EXCEPTION 'This purchase order is % and can no longer be edited. Send it back to draft, or amend it once confirmed.', v_po.status
      USING ERRCODE = 'P0001';
  END IF;

  v_items := v_po.line_items; v_sub := v_po.subtotal; v_dis := v_po.discount_amount;
  v_tax := v_po.tax_amount;   v_tot := v_po.total;
  IF p_lines IS NOT NULL THEN
    SELECT w.line_items, w.subtotal, w.discount_amount, w.tax_amount, w.total
      INTO v_items, v_sub, v_dis, v_tax, v_tot
      FROM public._purchase_order_write_lines(p_id, p_lines) w;
  END IF;

  UPDATE public.purchase_orders SET
    line_items      = v_items,
    subtotal        = v_sub,
    discount_amount = v_dis,
    tax_amount      = v_tax,
    total           = v_tot,
    currency         = CASE WHEN v_f ? 'currency'         THEN v_f->>'currency' ELSE currency END,
    exchange_rate    = CASE WHEN v_f ? 'exchange_rate'    THEN COALESCE((v_f->>'exchange_rate')::numeric, 1) ELSE exchange_rate END,
    issue_date       = CASE WHEN v_f ? 'issue_date'       THEN NULLIF(btrim(COALESCE(v_f->>'issue_date', '')), '')::date ELSE issue_date END,
    expected_delivery_date = CASE WHEN v_f ? 'expected_delivery_date' THEN NULLIF(btrim(COALESCE(v_f->>'expected_delivery_date', '')), '')::date ELSE expected_delivery_date END,
    payment_terms    = CASE WHEN v_f ? 'payment_terms'    THEN NULLIF(v_f->>'payment_terms', '')    ELSE payment_terms END,
    delivery_terms   = CASE WHEN v_f ? 'delivery_terms'   THEN NULLIF(v_f->>'delivery_terms', '')   ELSE delivery_terms END,
    shipping_address = CASE WHEN v_f ? 'shipping_address' THEN NULLIF(v_f->>'shipping_address', '') ELSE shipping_address END,
    billing_address  = CASE WHEN v_f ? 'billing_address'  THEN NULLIF(v_f->>'billing_address', '')  ELSE billing_address END,
    terms_conditions = CASE WHEN v_f ? 'terms_conditions' THEN NULLIF(v_f->>'terms_conditions', '') ELSE terms_conditions END,
    notes            = CASE WHEN v_f ? 'notes'            THEN NULLIF(v_f->>'notes', '')            ELSE notes END,
    updated_at       = now()
  WHERE id = p_id
  RETURNING * INTO v_row;

  RETURN v_row;
END
$function$;

REVOKE ALL ON FUNCTION public.update_purchase_order(uuid, jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_purchase_order(uuid, jsonb, jsonb, text) TO authenticated, service_role;

-- ── 7. amend_purchase_order writes the rows ──────────────────────────────────
-- As 20260881, except: the lines go through _purchase_order_write_lines (so an
-- amended order's rows, mirror and totals agree), "a price the old order did
-- not carry" is judged against the old rows, and the actor is the login only.
CREATE OR REPLACE FUNCTION public.amend_purchase_order(p_po_id uuid, p_changes jsonb, p_reason text, p_actor_email text)
 RETURNS purchase_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_po       record;
  v_actor    text := public.rma_current_user_email();
  v_reason   text := btrim(COALESCE(p_reason, ''));
  v_key      text;
  v_settable text[] := ARRAY['line_items', 'payment_terms', 'delivery_terms', 'shipping_address',
                             'billing_address', 'terms_conditions', 'expected_delivery_date', 'notes'];
  -- Sent by the forms but never trusted: they are recomputed from the lines.
  v_derived  text[] := ARRAY['subtotal', 'discount_amount', 'tax_amount', 'total'];
  v_num      text := '^[0-9]+(\.[0-9]+)?$';
  v_old      jsonb;
  v_items    jsonb;
  v_sub      numeric;
  v_dis      numeric;
  v_tax      numeric;
  v_tot      numeric;
  v_reapprove boolean := false;
  v_date     date;
  v_result   public.purchase_orders;
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) OR v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authorized to amend purchase orders' USING ERRCODE = 'P0001';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Say why the order is being amended (at least 10 characters).' USING ERRCODE = 'P0001';
  END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR p_changes = '{}'::jsonb THEN
    RAISE EXCEPTION 'Nothing to amend.' USING ERRCODE = 'P0001';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_changes) LOOP
    IF NOT (v_key = ANY (v_settable) OR v_key = ANY (v_derived)) THEN
      RAISE EXCEPTION '% cannot be changed by amending a purchase order. Cancel it and raise a new one instead.', v_key
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order not found: %', p_po_id USING ERRCODE = 'P0001';
  END IF;
  IF v_po.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Only a confirmed purchase order is amended (this one is %). Before confirmation it is simply edited; after receipts have started, raise a new order.', v_po.status
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.vendor_invoices WHERE purchase_order_id = p_po_id AND status <> 'cancelled') THEN
    RAISE EXCEPTION 'A vendor invoice has already been raised against this order. Cancel it before amending the order.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_changes ? 'expected_delivery_date' THEN
    IF NULLIF(p_changes ->> 'expected_delivery_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'The expected delivery date is not a valid date.' USING ERRCODE = 'P0001';
    END IF;
    BEGIN
      v_date := NULLIF(p_changes ->> 'expected_delivery_date', '')::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'The expected delivery date is not a valid date.' USING ERRCODE = 'P0001';
    END;
  END IF;

  -- Snapshot the order as it stands (its line_items mirror included), then apply.
  INSERT INTO public.purchase_order_revisions (po_id, rev_no, snapshot, reason, created_by)
  VALUES (p_po_id, v_po.revision_no, to_jsonb(v_po), v_reason, v_actor);

  v_items := v_po.line_items; v_sub := v_po.subtotal; v_dis := v_po.discount_amount;
  v_tax := v_po.tax_amount;   v_tot := v_po.total;

  IF p_changes ? 'line_items' THEN
    -- the (product, cost, discount, tax) tuples the order carried, from its rows
    SELECT COALESCE(jsonb_agg(jsonb_build_object('p', l.product_id, 'c', l.unit_cost, 'd', l.discount_pct, 't', l.tax_pct)), '[]'::jsonb)
      INTO v_old FROM public.purchase_order_lines l WHERE l.purchase_order_id = p_po_id;
    -- an order with no rows (only data written outside the RPCs) is judged
    -- against its mirror
    IF v_old = '[]'::jsonb AND jsonb_typeof(v_po.line_items) = 'array' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('p', e.l->>'product_id', 'c', e.l->>'unit_cost',
                                                   'd', COALESCE(NULLIF(e.l->>'discount_pct', ''), '0'),
                                                   't', COALESCE(NULLIF(e.l->>'tax_pct', ''), '0'))), '[]'::jsonb)
        INTO v_old
        FROM jsonb_array_elements(v_po.line_items) AS e(l)
       WHERE jsonb_typeof(e.l) = 'object'
         AND COALESCE(e.l->>'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND COALESCE(e.l->>'unit_cost', '') ~ v_num
         AND COALESCE(NULLIF(e.l->>'discount_pct', ''), '0') ~ v_num
         AND COALESCE(NULLIF(e.l->>'tax_pct', ''), '0') ~ v_num;
    END IF;

    SELECT w.line_items, w.subtotal, w.discount_amount, w.tax_amount, w.total
      INTO v_items, v_sub, v_dis, v_tax, v_tot
      FROM public._purchase_order_write_lines(p_po_id, p_changes -> 'line_items') w;

    -- a higher total, or a price, discount or tax the old order did not carry
    -- for that product, goes back to an administrator
    v_reapprove := v_tot > v_po.total
      OR EXISTS (SELECT 1 FROM public.purchase_order_lines l
                  WHERE l.purchase_order_id = p_po_id
                    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_old) o
                                     WHERE (o->>'p')::uuid IS NOT DISTINCT FROM l.product_id
                                       AND (o->>'c')::numeric = l.unit_cost
                                       AND (o->>'d')::numeric = l.discount_pct
                                       AND (o->>'t')::numeric = l.tax_pct));
  END IF;

  -- The flag lets exactly this statement reopen a confirmed order.
  PERFORM set_config('rma.po_amend', 'on', true);
  UPDATE public.purchase_orders
     SET line_items      = v_items,
         subtotal        = v_sub,
         discount_amount = v_dis,
         tax_amount      = v_tax,
         total           = v_tot,
         payment_terms    = CASE WHEN p_changes ? 'payment_terms'    THEN p_changes ->> 'payment_terms'    ELSE payment_terms END,
         delivery_terms   = CASE WHEN p_changes ? 'delivery_terms'   THEN p_changes ->> 'delivery_terms'   ELSE delivery_terms END,
         shipping_address = CASE WHEN p_changes ? 'shipping_address' THEN p_changes ->> 'shipping_address' ELSE shipping_address END,
         billing_address  = CASE WHEN p_changes ? 'billing_address'  THEN p_changes ->> 'billing_address'  ELSE billing_address END,
         terms_conditions = CASE WHEN p_changes ? 'terms_conditions' THEN p_changes ->> 'terms_conditions' ELSE terms_conditions END,
         notes            = CASE WHEN p_changes ? 'notes'            THEN p_changes ->> 'notes'            ELSE notes END,
         expected_delivery_date = CASE WHEN p_changes ? 'expected_delivery_date' THEN v_date ELSE expected_delivery_date END,
         revision_no     = revision_no + 1,
         status          = CASE WHEN v_reapprove THEN 'pending_confirmation' ELSE status END,
         updated_at      = now()
   WHERE id = p_po_id
   RETURNING * INTO v_result;
  PERFORM set_config('rma.po_amend', 'off', true);

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.amend_purchase_order(uuid, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.amend_purchase_order(uuid, jsonb, text, text) TO authenticated, service_role;

-- ── 8. backfill existing purchase orders ─────────────────────────────────────
-- As before: text-first, a malformed or deleted product id costs only the
-- link, values outside the rules clamped and reported (including values that
-- could not be read), drift counted. Historical line_items and totals are NOT
-- rewritten here.
CREATE OR REPLACE FUNCTION pg_temp.po_bf_num(p text, p_default numeric) RETURNS numeric LANGUAGE plpgsql AS $f$
BEGIN
  IF btrim(COALESCE(p, '')) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN btrim(p)::numeric; END IF;
  RETURN p_default;
END $f$;

DO $$
DECLARE
  v_o        record;
  v_t        record;
  v_no       integer;
  v_pid      uuid;
  v_qty      numeric;
  v_cost     numeric;
  v_dpct     numeric;
  v_tpct     numeric;
  v_unread   boolean;
  v_changed  integer := 0;
  v_lines    integer := 0;
  v_drift    integer;
BEGIN
  FOR v_o IN
    SELECT o.id, o.line_items FROM public.purchase_orders o
     WHERE NOT EXISTS (SELECT 1 FROM public.purchase_order_lines pl WHERE pl.purchase_order_id = o.id)
       AND jsonb_typeof(o.line_items) = 'array'
  LOOP
    v_no := 0;
    FOR v_t IN SELECT e.l FROM jsonb_array_elements(v_o.line_items) AS e(l)
    LOOP
      IF jsonb_typeof(v_t.l) IS DISTINCT FROM 'object' THEN
        v_t.l := '{}'::jsonb;
      END IF;

      v_pid := NULL;
      IF btrim(COALESCE(v_t.l->>'product_id', '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT p.id INTO v_pid FROM public.products p WHERE p.id = btrim(v_t.l->>'product_id')::uuid;
      END IF;

      v_qty  := pg_temp.po_bf_num(v_t.l->>'qty_ordered', 1);
      v_cost := pg_temp.po_bf_num(v_t.l->>'unit_cost', 0);
      v_dpct := pg_temp.po_bf_num(v_t.l->>'discount_pct', 0);
      v_tpct := pg_temp.po_bf_num(v_t.l->>'tax_pct', 0);

      v_unread := EXISTS (SELECT 1 FROM unnest(ARRAY['qty_ordered', 'unit_cost', 'discount_pct', 'tax_pct']) k
                           WHERE v_t.l->>k IS NOT NULL AND btrim(v_t.l->>k) !~ '^-?[0-9]+(\.[0-9]+)?$');

      IF v_unread OR v_qty <> round(v_qty) OR v_qty < 1 OR v_cost < 0 OR v_dpct NOT BETWEEN 0 AND 100 OR v_tpct NOT BETWEEN 0 AND 100
         OR v_pid IS NULL THEN
        v_changed := v_changed + 1;
        RAISE WARNING 'purchase_order_lines backfill: order % line % had values outside the new rules (qty %, cost %, discount %, tax %, product %); stored inside them',
          v_o.id, v_no + 1, v_t.l->>'qty_ordered', v_t.l->>'unit_cost', v_t.l->>'discount_pct', v_t.l->>'tax_pct', COALESCE(v_t.l->>'product_id', '-');
      END IF;

      INSERT INTO public.purchase_order_lines
        (purchase_order_id, line_no, product_id, product_name, description, qty_ordered, unit_cost, discount_pct, tax_pct)
      VALUES (
        v_o.id, v_no, v_pid,
        COALESCE(NULLIF(btrim(COALESCE(v_t.l->>'product_name', '')), ''), '(unnamed line)'),
        NULLIF(btrim(COALESCE(v_t.l->>'description', '')), ''),
        GREATEST(1, LEAST(999999999, round(v_qty)))::integer,
        GREATEST(0, LEAST(9999999999, v_cost)),
        LEAST(100, GREATEST(0, v_dpct)),
        LEAST(100, GREATEST(0, v_tpct))
      );
      v_lines := v_lines + 1;
      v_no := v_no + 1;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_drift
    FROM public.purchase_orders o
    JOIN LATERAL (
      SELECT round(COALESCE(sum(l.qty_ordered * l.unit_cost * (1 - l.discount_pct / 100) * (1 + l.tax_pct / 100)), 0), 2) AS t
        FROM public.purchase_order_lines l WHERE l.purchase_order_id = o.id) s ON true
   WHERE abs(s.t - o.total) > 0.01;

  RAISE NOTICE 'purchase_order_lines backfill: % lines written, % brought inside the new rules, % orders whose lines no longer add up to their stored total',
    v_lines, v_changed, v_drift;
END $$;

-- ── 9. draft orders agree with their rows ────────────────────────────────────
-- A draft is not yet a figure anyone confirmed. Orders sent, pending,
-- confirmed or later keep the figures they were confirmed (or asked to be
-- confirmed) on; the next amendment rewrites them from the rows.
DO $$
DECLARE v_n integer;
BEGIN
  WITH r AS (
    SELECT l.purchase_order_id AS id,
           jsonb_agg(jsonb_build_object(
             'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
             'qty_ordered', l.qty_ordered, 'unit_cost', l.unit_cost, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
             ORDER BY l.line_no) AS items,
           sum(l.qty_ordered * l.unit_cost) AS sub,
           sum(l.qty_ordered * l.unit_cost * l.discount_pct / 100) AS dis,
           sum((l.qty_ordered * l.unit_cost - l.qty_ordered * l.unit_cost * l.discount_pct / 100) * l.tax_pct / 100) AS tax
      FROM public.purchase_order_lines l GROUP BY l.purchase_order_id)
  UPDATE public.purchase_orders o SET
    line_items = r.items, subtotal = round(r.sub, 2), discount_amount = round(r.dis, 2),
    tax_amount = round(r.tax, 2), total = round(r.sub - r.dis + r.tax, 2)
  FROM r
  WHERE o.id = r.id AND o.status = 'draft'
    AND (o.line_items IS DISTINCT FROM r.items OR o.total IS DISTINCT FROM round(r.sub - r.dis + r.tax, 2));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'draft purchase orders synced from their rows: %', v_n;
END $$;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.create_purchase_order(uuid, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.update_purchase_order(uuid, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.amend_purchase_order(uuid, jsonb, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._purchase_order_write_lines(uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._purchase_order_check_fields(jsonb, text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: a purchase-order function is executable by the wrong role';
  END IF;
  IF has_table_privilege('anon', 'public.purchase_order_lines', 'SELECT')
     OR has_table_privilege('authenticated', 'public.purchase_order_lines', 'INSERT')
     OR has_table_privilege('authenticated', 'public.purchase_orders', 'INSERT') THEN
    RAISE EXCEPTION 'Refusing to finish: a client can still write purchase-order lines or orders directly';
  END IF;
END $$;
