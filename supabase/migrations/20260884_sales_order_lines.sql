-- ============================================================================
-- 20260884_sales_order_lines.sql
-- W2 / L-01, second document type — Sales Orders. The same design as
-- 20260883 (quotations); read that header first. What differs is below.
--
-- WHY IT MATTERS MORE HERE: a confirmed sales order has stock reserved for its
-- lines (approve_sales_order → funnel_reserve_line). The status guard
-- (rma_guard_sales_order_status) only polices status changes, so a client
-- could rewrite a CONFIRMED order's line_items directly — the reservation then
-- belongs to lines the order no longer has. The INSERT policy also let a
-- client create an order already linked to any quotation, skipping
-- convert_quotation_to_so's rules (accepted only; a manager and a reason when
-- expired, 20260880).
--
-- WHAT THIS DOES
--   * sales_order_lines: one row per line, FK to sales_orders (cascade) and
--     products, CHECKs as on quotation_lines. Source of truth; sales_orders.
--     line_items is kept as a mirror written in the same transaction, so
--     approve_sales_order, rma_reservation_integrity, the PDF, the screens and
--     salesOrders.convertToInvoice read it unchanged.
--   * create_sales_order / update_sales_order (SECURITY DEFINER). Every line
--     must be a real catalogue product (the app's rule for orders — a free-text
--     line cannot be reserved or invoiced). Lines change only on a DRAFT order
--     (the screen's own rule; a sent order is awaiting approval and a confirmed
--     one holds stock). An order is linked to a quotation only by
--     convert_quotation_to_so, which now builds the order's rows from the
--     quotation's rows.
--   * Who may write is the live policies this replaces (20260781): create =
--     manager+ or sales rep; edit = manager+ or a sales rep who owns the order
--     before and after. Lines are readable exactly when their order is.
--   * INSERT on sales_orders is revoked from authenticated, and a client-surface
--     trigger refuses any direct UPDATE beyond status and the archive flag
--     (status itself stays policed by rma_guard_sales_order_status).
--   * An order converted from a quotation keeps the lines the customer
--     accepted: its products, quantities and prices cannot be edited.
--   * convert_quotation_to_so takes the actor from the login only, and a sales
--     rep converts only a quotation they own (by id alone, any rep could).
--   * Draft and sent orders and quotations whose historical lines the backfill
--     had to correct get their mirror and totals rebuilt from the rows (8).
-- ============================================================================

-- ── 1. the table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sales_order_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id  uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  line_no         integer NOT NULL,
  -- Nullable only so historical orders can be copied as they are; every line
  -- written from now on must name a product (checked in the writer below).
  product_id      uuid REFERENCES public.products(id),
  product_name    text NOT NULL,
  description     text,
  qty             integer NOT NULL,
  unit_price      numeric(14,4) NOT NULL DEFAULT 0,
  discount_pct    numeric(5,2) NOT NULL DEFAULT 0,
  tax_pct         numeric(5,2) NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_order_lines_qty_positive   CHECK (qty >= 1),
  CONSTRAINT sales_order_lines_price_nonneg   CHECK (unit_price >= 0),
  CONSTRAINT sales_order_lines_discount_range CHECK (discount_pct >= 0 AND discount_pct <= 100),
  CONSTRAINT sales_order_lines_tax_range      CHECK (tax_pct >= 0 AND tax_pct <= 100),
  CONSTRAINT sales_order_lines_name_present   CHECK (length(btrim(product_name)) > 0),
  CONSTRAINT sales_order_lines_unique_line    UNIQUE (sales_order_id, line_no)
);

CREATE INDEX IF NOT EXISTS sales_order_lines_order_idx   ON public.sales_order_lines (sales_order_id);
CREATE INDEX IF NOT EXISTS sales_order_lines_product_idx ON public.sales_order_lines (product_id) WHERE product_id IS NOT NULL;

COMMENT ON TABLE public.sales_order_lines IS
  'One row per sales-order line. Source of truth; sales_orders.line_items is a read-only mirror maintained by create_sales_order / update_sales_order / convert_quotation_to_so. Client writes are revoked.';

-- A line is readable exactly when its order is: the subquery runs under the
-- caller's own policies on sales_orders.
ALTER TABLE public.sales_order_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_sales_order_lines" ON public.sales_order_lines;
CREATE POLICY "read_sales_order_lines"
  ON public.sales_order_lines
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.sales_orders o WHERE o.id = sales_order_lines.sales_order_id));

REVOKE ALL ON TABLE public.sales_order_lines FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.sales_order_lines FROM authenticated;
GRANT SELECT ON TABLE public.sales_order_lines TO authenticated;
GRANT ALL ON TABLE public.sales_order_lines TO service_role;

-- ── 2. the client surface: status and archive only ──────────────────────────
-- An allowlist, as for quotations: a column added later is protected by
-- default. Status is still policed by rma_guard_sales_order_status (only
-- draft/sent/declined → sent from the client); archiving is
-- salesDocuments.setArchived; everything else goes through update_sales_order.
CREATE OR REPLACE FUNCTION public.rma_guard_sales_order_client_writes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_open text[] := ARRAY['status', 'archived', 'archived_at', 'archived_by', 'updated_at'];
BEGIN
  -- Client surface only. The RPCs (and rma_restore_apply) run as the owner.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- A stored generated column reads as NULL in NEW inside a BEFORE trigger, so
  -- it would look changed on every update (crm_invoices.cogs_complete does).
  -- No client can write one, and each derives from columns guarded here.
  SELECT v_open || COALESCE(array_agg(a.attname::text), ARRAY[]::text[])
    INTO v_open
    FROM pg_attribute a
   WHERE a.attrelid = TG_RELID AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated <> '';

  IF (to_jsonb(NEW) - v_open) IS DISTINCT FROM (to_jsonb(OLD) - v_open) THEN
    RAISE EXCEPTION 'A sales order''s lines, amounts and details are changed through the order form (update_sales_order), not directly.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.rma_guard_sales_order_client_writes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_guard_sales_order_client_writes() TO service_role;

DROP TRIGGER IF EXISTS trg_sales_orders_client_writes ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_client_writes
  BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_sales_order_client_writes();

-- An order is created by create_sales_order or convert_quotation_to_so only.
REVOKE INSERT ON TABLE public.sales_orders FROM authenticated;

-- The quotation guard (20260883) gets the same generated-column exclusion, so a
-- generated column added to quotations later cannot turn every status update
-- into a refusal. Behaviour is otherwise unchanged.
CREATE OR REPLACE FUNCTION public.rma_guard_quotation_client_writes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_open text[] := ARRAY['status', 'archived', 'archived_at', 'archived_by', 'updated_at'];
BEGIN
  -- Client surface only. create_quotation/update_quotation run as the owner.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- A stored generated column reads as NULL in NEW inside a BEFORE trigger, so
  -- it would look changed on every update (crm_invoices.cogs_complete does).
  -- No client can write one, and each derives from columns guarded here.
  SELECT v_open || COALESCE(array_agg(a.attname::text), ARRAY[]::text[])
    INTO v_open
    FROM pg_attribute a
   WHERE a.attrelid = TG_RELID AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated <> '';

  IF (to_jsonb(NEW) - v_open) IS DISTINCT FROM (to_jsonb(OLD) - v_open) THEN
    RAISE EXCEPTION 'A quotation''s lines, amounts and details are changed through the quotation form (update_quotation), not directly.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

-- ── 3. writing the lines (internal) ──────────────────────────────────────────
-- As _quotation_write_lines, except that every line must name an existing
-- catalogue product — and so a line sent without a name takes the product's
-- catalogue name instead of being refused.
CREATE OR REPLACE FUNCTION public._sales_order_write_lines(p_so_id uuid, p_lines jsonb)
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
  v_price text;
  v_dpct  text;
  v_tpct  text;
  v_cat   text;
  v_sub   numeric := 0;
  v_dsum  numeric := 0;
  v_tsum  numeric := 0;
BEGIN
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'At least one line item is required' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_lines) > 500 THEN
    RAISE EXCEPTION 'A sales order can have at most 500 lines' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.sales_order_lines WHERE sales_order_id = p_so_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Line % is not a line item', v_no + 1 USING ERRCODE = 'P0001';
    END IF;

    v_name  := btrim(COALESCE(v_line->>'product_name', ''));
    v_pid   := btrim(COALESCE(v_line->>'product_id', ''));
    v_qty   := btrim(COALESCE(v_line->>'qty', ''));
    v_price := COALESCE(NULLIF(btrim(COALESCE(v_line->>'unit_price', '')), ''), '0');
    v_dpct  := COALESCE(NULLIF(btrim(COALESCE(v_line->>'discount_pct', '')), ''), '0');
    v_tpct  := COALESCE(NULLIF(btrim(COALESCE(v_line->>'tax_pct', '')), ''), '0');

    IF v_pid = '' THEN
      RAISE EXCEPTION 'Line "%": a sales order line must be a catalogue product', COALESCE(NULLIF(v_name, ''), (v_no + 1)::text) USING ERRCODE = 'P0001';
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
    IF v_price !~ '^[0-9]{1,10}(\.[0-9]+)?$' THEN
      RAISE EXCEPTION 'Line "%": price must be 0 or more', v_name USING ERRCODE = 'P0001';
    END IF;
    IF v_dpct !~ '^[0-9]{1,3}(\.[0-9]+)?$' OR v_dpct::numeric > 100 THEN
      RAISE EXCEPTION 'Line "%": discount must be between 0 and 100', v_name USING ERRCODE = 'P0001';
    END IF;
    IF v_tpct !~ '^[0-9]{1,3}(\.[0-9]+)?$' OR v_tpct::numeric > 100 THEN
      RAISE EXCEPTION 'Line "%": tax must be between 0 and 100', v_name USING ERRCODE = 'P0001';
    END IF;

    BEGIN
      INSERT INTO public.sales_order_lines
        (sales_order_id, line_no, product_id, product_name, description, qty, unit_price, discount_pct, tax_pct)
      VALUES (
        p_so_id, v_no, v_pid::uuid, v_name,
        NULLIF(btrim(COALESCE(v_line->>'description', '')), ''),
        v_qty::integer, v_price::numeric, v_dpct::numeric, v_tpct::numeric
      );
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'Line "%": that product does not exist', v_name USING ERRCODE = 'P0001';
    END;

    v_no := v_no + 1;
  END LOOP;

  -- From the rows as stored (see _quotation_write_lines).
  SELECT COALESCE(sum(b.base), 0),
         COALESCE(sum(b.disc), 0),
         COALESCE(sum((b.base - b.disc) * b.tax_pct / 100), 0)
    INTO v_sub, v_dsum, v_tsum
    FROM (SELECT l.qty * l.unit_price                        AS base,
                 l.qty * l.unit_price * l.discount_pct / 100 AS disc,
                 l.tax_pct
            FROM public.sales_order_lines l WHERE l.sales_order_id = p_so_id) b;

  RETURN QUERY
  SELECT round(v_sub, 2), round(v_dsum, 2), round(v_tsum, 2), round(v_sub - v_dsum + v_tsum, 2),
         (SELECT jsonb_agg(jsonb_build_object(
                   'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
                   'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
                 ORDER BY l.line_no)
            FROM public.sales_order_lines l WHERE l.sales_order_id = p_so_id);
END
$function$;

REVOKE ALL ON FUNCTION public._sales_order_write_lines(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sales_order_write_lines(uuid, jsonb) TO service_role;

-- ── 4. create_sales_order ────────────────────────────────────────────────────
-- No quotation_id: an order is linked to a quotation only by
-- convert_quotation_to_so, which applies 20260880's rules.
CREATE OR REPLACE FUNCTION public.create_sales_order(
  p_customer_id    uuid,
  p_lines          jsonb,
  p_delivery_date  date,
  p_payment_terms  text,
  p_reference_po   text,
  p_notes          text,
  p_assigned_rep   text,
  p_actor_email    text
)
RETURNS public.sales_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_id    uuid := gen_random_uuid();
  v_t     record;
  v_row   public.sales_orders;
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep', false) THEN
    RAISE EXCEPTION 'Not authorized to create a sales order' USING ERRCODE = 'P0001';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Your login has no email, so this sales order cannot be attributed' USING ERRCODE = 'P0001';
  END IF;
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'A customer is required' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.sales_orders
    (id, so_code, customer_id, status, line_items,
     delivery_date, payment_terms, reference_po, notes, assigned_rep, created_by)
  VALUES (
    v_id, public.generate_doc_code('SO'), p_customer_id, 'draft', '[]'::jsonb,
    p_delivery_date, p_payment_terms, p_reference_po, p_notes, p_assigned_rep, v_actor
  );

  SELECT * INTO v_t FROM public._sales_order_write_lines(v_id, p_lines);

  UPDATE public.sales_orders SET
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

REVOKE ALL ON FUNCTION public.create_sales_order(uuid, jsonb, date, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_sales_order(uuid, jsonb, date, text, text, text, text, text) TO authenticated, service_role;

-- ── 5. update_sales_order ────────────────────────────────────────────────────
-- Sets only the header fields present as keys in p_fields; p_lines NULL keeps
-- the lines. A DRAFT order only.
CREATE OR REPLACE FUNCTION public.update_sales_order(
  p_id          uuid,
  p_lines       jsonb,
  p_fields      jsonb,
  p_actor_email text
)
RETURNS public.sales_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor   text := public.rma_current_user_email();
  v_allowed text[] := ARRAY['delivery_date', 'payment_terms', 'reference_po', 'notes', 'assigned_rep'];
  v_key     text;
  v_so      public.sales_orders;
  v_f       jsonb := COALESCE(p_fields, '{}'::jsonb);
  v_rep     text;
  v_date    date;
  v_items   jsonb;
  v_sub     numeric;
  v_dis     numeric;
  v_tax     numeric;
  v_tot     numeric;
  v_new     text;
  v_old     text;
  v_row     public.sales_orders;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authorized to edit a sales order' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(v_f) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Fields must be an object' USING ERRCODE = 'P0001';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(v_f) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'The field "%" cannot be changed here', v_key USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order % not found', p_id USING ERRCODE = 'P0001';
  END IF;

  v_rep := CASE WHEN v_f ? 'assigned_rep' THEN NULLIF(btrim(COALESCE(v_f->>'assigned_rep', '')), '') ELSE v_so.assigned_rep END;

  -- The UPDATE policy this replaces (sales_update_sales_orders, 20260781),
  -- before (USING) and after (WITH CHECK), COALESCE-wrapped (BUG-087).
  IF NOT COALESCE(
       public.rma_is_manager_or_above()
       OR (public.rma_user_role() = 'sales_rep'
           AND (v_so.assigned_rep = v_actor OR v_so.created_by = v_actor)
           AND (v_rep = v_actor OR v_so.created_by = v_actor)),
       false) THEN
    RAISE EXCEPTION 'Not authorized to edit this sales order' USING ERRCODE = 'P0001';
  END IF;

  -- The screen edits only a draft: a sent order is awaiting approval, and a
  -- confirmed one holds stock reserved for the lines it has now.
  IF v_so.status <> 'draft' THEN
    RAISE EXCEPTION 'This sales order is % and can no longer be edited', v_so.status USING ERRCODE = 'P0001';
  END IF;

  -- An order converted from a quotation carries what the customer accepted —
  -- and, for an expired quotation, what a manager overrode with a reason. Its
  -- products, quantities, prices, discounts and taxes cannot change here; the
  -- header (delivery date, terms, notes, rep) still can. The form always sends
  -- the lines back, so an unchanged set passes: only a real change is refused.
  IF v_so.quotation_id IS NOT NULL AND p_lines IS NOT NULL THEN
    BEGIN
      SELECT string_agg(concat_ws('|',
               lower(btrim(COALESCE(e.l->>'product_id', ''))),
               round(COALESCE(NULLIF(btrim(COALESCE(e.l->>'qty', '')), ''), '0')::numeric, 4),
               round(COALESCE(NULLIF(btrim(COALESCE(e.l->>'unit_price', '')), ''), '0')::numeric, 4),
               round(COALESCE(NULLIF(btrim(COALESCE(e.l->>'discount_pct', '')), ''), '0')::numeric, 2),
               round(COALESCE(NULLIF(btrim(COALESCE(e.l->>'tax_pct', '')), ''), '0')::numeric, 2)), ';' ORDER BY e.o)
        INTO v_new
        FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS e(l, o);
    EXCEPTION WHEN OTHERS THEN
      v_new := NULL;   -- unreadable lines are a change
    END;
    SELECT string_agg(concat_ws('|',
             COALESCE(lower(l.product_id::text), ''),
             round(l.qty::numeric, 4), round(l.unit_price, 4), round(l.discount_pct, 2), round(l.tax_pct, 2)), ';' ORDER BY l.line_no)
      INTO v_old
      FROM public.sales_order_lines l WHERE l.sales_order_id = p_id;
    IF v_new IS DISTINCT FROM v_old THEN
      RAISE EXCEPTION 'This order was converted from a quotation, and its products, quantities and prices are what the customer accepted. Cancel the order and revise the quotation instead.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF v_f ? 'delivery_date' THEN
    BEGIN
      v_date := NULLIF(btrim(COALESCE(v_f->>'delivery_date', '')), '')::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'The delivery date is not a date' USING ERRCODE = 'P0001';
    END;
  END IF;

  v_items := v_so.line_items; v_sub := v_so.subtotal; v_dis := v_so.discount_amount;
  v_tax := v_so.tax_amount;   v_tot := v_so.total;
  IF p_lines IS NOT NULL THEN
    SELECT w.line_items, w.subtotal, w.discount_amount, w.tax_amount, w.total
      INTO v_items, v_sub, v_dis, v_tax, v_tot
      FROM public._sales_order_write_lines(p_id, p_lines) w;
  END IF;

  UPDATE public.sales_orders SET
    line_items      = v_items,
    subtotal        = v_sub,
    discount_amount = v_dis,
    tax_amount      = v_tax,
    total           = v_tot,
    delivery_date   = CASE WHEN v_f ? 'delivery_date' THEN v_date               ELSE delivery_date END,
    payment_terms   = CASE WHEN v_f ? 'payment_terms' THEN v_f->>'payment_terms' ELSE payment_terms END,
    reference_po    = CASE WHEN v_f ? 'reference_po'  THEN v_f->>'reference_po'  ELSE reference_po  END,
    notes           = CASE WHEN v_f ? 'notes'         THEN v_f->>'notes'         ELSE notes         END,
    assigned_rep    = v_rep
  WHERE id = p_id
  RETURNING * INTO v_row;

  RETURN v_row;
END
$function$;

REVOKE ALL ON FUNCTION public.update_sales_order(uuid, jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_sales_order(uuid, jsonb, jsonb, text) TO authenticated, service_role;

-- ── 6. convert_quotation_to_so writes the rows too ───────────────────────────
-- Body as live (20260880, with 20260867's COALESCE) plus one block after the
-- INSERT (see its comment). Same signature, so the grants are kept.
CREATE OR REPLACE FUNCTION public.convert_quotation_to_so(p_quotation_id uuid, p_actor_email text, p_override_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_qt         record;
  v_so_code    text;
  v_so_id      uuid;
  v_src        jsonb;
  v_w          record;
  v_null_lines bigint;
  v_actor      text := public.rma_current_user_email();   -- 20260884: never the caller's parameter
  v_reason     text := btrim(COALESCE(p_override_reason, ''));
  v_override   text;
BEGIN
  IF NOT COALESCE((public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep'), false) THEN
    RAISE EXCEPTION 'Not authorized to convert quotations' USING ERRCODE = 'P0001';
  END IF;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Your login has no email, so this conversion cannot be attributed' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_qt FROM public.quotations WHERE id = p_quotation_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quotation not found: %', p_quotation_id;
  END IF;

  -- 20260884: a sales rep converts only a quotation they own — the one they
  -- can read (sales_rep_read_quotations). By id alone, any rep could convert
  -- any accepted quotation and then own the order it produced.
  IF NOT COALESCE(public.rma_is_manager_or_above()
                  OR (v_qt.assigned_rep = v_actor OR v_qt.created_by = v_actor), false) THEN
    RAISE EXCEPTION 'Not authorized to convert this quotation' USING ERRCODE = 'P0001';
  END IF;

  -- Not merely "not cancelled, declined or converted": only an ACCEPTED quote
  -- is one the customer has agreed to. A draft or sent one has not been.
  IF v_qt.status <> 'accepted' THEN
    RAISE EXCEPTION 'Only an accepted quotation can be converted to a sales order (this one is %).', v_qt.status
      USING ERRCODE = 'P0001';
  END IF;

  IF v_qt.validity_until IS NOT NULL AND v_qt.validity_until < public.rma_today() THEN
    IF NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
      RAISE EXCEPTION 'This quotation expired on %. Only a manager can convert an expired quotation.', v_qt.validity_until
        USING ERRCODE = 'P0001';
    END IF;
    IF length(v_reason) < 10 THEN
      RAISE EXCEPTION 'This quotation expired on %. A manager can still convert it by giving a reason (at least 10 characters).', v_qt.validity_until
        USING ERRCODE = 'P0001';
    END IF;
    v_override := v_reason;
  END IF;

  SELECT count(*) INTO v_null_lines
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_qt.line_items) = 'array' THEN v_qt.line_items ELSE '[]'::jsonb END) AS line
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
    payment_terms, reference_po, notes, assigned_rep, created_by, override_reason
  )
  VALUES (
    v_so_code, p_quotation_id, v_qt.customer_id, 'draft', v_qt.line_items,
    v_qt.subtotal, v_qt.discount_amount, v_qt.tax_amount, v_qt.total,
    v_qt.payment_terms, v_qt.reference_po, v_qt.notes,
    COALESCE(v_qt.assigned_rep, v_actor), v_actor, v_override
  )
  RETURNING id INTO v_so_id;

  -- 20260884: the order's lines as rows, built from the quotation's rows (the
  -- source of truth since 20260883; the raw line_items only if a quotation
  -- somehow has none). The order's mirror and totals then come from its own
  -- rows, so they always agree: for any quotation written through
  -- create_quotation these equal the quotation's figures, while for a
  -- historical one whose old jsonb broke the rules the order takes the
  -- corrected lines. A line whose product has since been deleted refuses the
  -- conversion with a readable message.
  SELECT jsonb_agg(jsonb_build_object(
           'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
           'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
         ORDER BY l.line_no)
    INTO v_src
    FROM public.quotation_lines l WHERE l.quotation_id = p_quotation_id;

  SELECT * INTO v_w FROM public._sales_order_write_lines(v_so_id, COALESCE(v_src, v_qt.line_items));

  UPDATE public.sales_orders SET
    line_items      = v_w.line_items,
    subtotal        = v_w.subtotal,
    discount_amount = v_w.discount_amount,
    tax_amount      = v_w.tax_amount,
    total           = v_w.total
  WHERE id = v_so_id;

  UPDATE public.quotations
  SET status = 'converted', updated_at = NOW()
  WHERE id = p_quotation_id;

  RETURN v_so_id;
END;
$function$;

-- ── 7. backfill existing orders ──────────────────────────────────────────────
-- As 20260883 section 6: text-first parsing, a malformed or deleted product id
-- costs only the link, values outside the rules are clamped and reported, and
-- orders whose lines no longer add up to their stored total are counted.
-- Historical line_items and totals are not rewritten.
CREATE OR REPLACE FUNCTION pg_temp.so_bf_num(p text, p_default numeric) RETURNS numeric LANGUAGE plpgsql AS $f$
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
  v_price    numeric;
  v_dpct     numeric;
  v_tpct     numeric;
  v_unread   boolean;
  v_changed  integer := 0;
  v_lines    integer := 0;
  v_drift    integer;
BEGIN
  FOR v_o IN
    SELECT o.id, o.line_items FROM public.sales_orders o
     WHERE NOT EXISTS (SELECT 1 FROM public.sales_order_lines ol WHERE ol.sales_order_id = o.id)
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

      v_qty   := pg_temp.so_bf_num(v_t.l->>'qty', 1);
      v_price := pg_temp.so_bf_num(v_t.l->>'unit_price', 0);
      v_dpct  := pg_temp.so_bf_num(v_t.l->>'discount_pct', 0);
      v_tpct  := pg_temp.so_bf_num(v_t.l->>'tax_pct', 0);

      -- A value that is there but could not be read ("1,000", "$10", "1e3") fell
      -- back to a default: that is a change too, and is reported like one.
      v_unread := EXISTS (SELECT 1 FROM unnest(ARRAY['qty', 'unit_price', 'discount_pct', 'tax_pct']) k
                           WHERE v_t.l->>k IS NOT NULL AND btrim(v_t.l->>k) !~ '^-?[0-9]+(\.[0-9]+)?$');

      IF v_unread OR v_qty <> round(v_qty) OR v_qty < 1 OR v_price < 0 OR v_dpct NOT BETWEEN 0 AND 100 OR v_tpct NOT BETWEEN 0 AND 100
         OR v_pid IS NULL THEN
        v_changed := v_changed + 1;
        RAISE WARNING 'sales_order_lines backfill: order % line % had values outside the new rules (qty %, price %, discount %, tax %, product %); stored inside them',
          v_o.id, v_no + 1, v_t.l->>'qty', v_t.l->>'unit_price', v_t.l->>'discount_pct', v_t.l->>'tax_pct', COALESCE(v_t.l->>'product_id', '-');
      END IF;

      INSERT INTO public.sales_order_lines
        (sales_order_id, line_no, product_id, product_name, description, qty, unit_price, discount_pct, tax_pct)
      VALUES (
        v_o.id, v_no, v_pid,
        COALESCE(NULLIF(btrim(COALESCE(v_t.l->>'product_name', '')), ''), '(unnamed line)'),
        NULLIF(btrim(COALESCE(v_t.l->>'description', '')), ''),
        GREATEST(1, LEAST(999999999, round(v_qty)))::integer,
        GREATEST(0, LEAST(9999999999, v_price)),
        LEAST(100, GREATEST(0, v_dpct)),
        LEAST(100, GREATEST(0, v_tpct))
      );
      v_lines := v_lines + 1;
      v_no := v_no + 1;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_drift
    FROM public.sales_orders o
    JOIN LATERAL (
      SELECT round(COALESCE(sum(l.qty * l.unit_price * (1 - l.discount_pct / 100) * (1 + l.tax_pct / 100)), 0), 2) AS t
        FROM public.sales_order_lines l WHERE l.sales_order_id = o.id) s ON true
   WHERE abs(s.t - o.total) > 0.01;

  RAISE NOTICE 'sales_order_lines backfill: % lines written, % brought inside the new rules, % orders whose lines no longer add up to their stored total',
    v_lines, v_changed, v_drift;
END $$;

-- ── 8. unsettled documents agree with their rows ─────────────────────────────
-- A draft or sent sales order or quotation is not yet an issued figure, and
-- approve_sales_order reserves stock from the order's line_items. Where the
-- backfill had to bring a historical line inside the rules, the mirror and
-- totals of these documents are rebuilt from the rows so that everything
-- downstream acts on the same lines. Confirmed, delivered, accepted and
-- converted documents keep their figures as issued. (Quotations are included
-- because 20260883 left theirs as they were.)
DO $$
DECLARE v_so integer; v_qt integer;
BEGIN
  WITH r AS (
    SELECT l.sales_order_id AS id,
           jsonb_agg(jsonb_build_object(
             'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
             'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
             ORDER BY l.line_no) AS items,
           sum(l.qty * l.unit_price) AS sub,
           sum(l.qty * l.unit_price * l.discount_pct / 100) AS dis,
           sum((l.qty * l.unit_price - l.qty * l.unit_price * l.discount_pct / 100) * l.tax_pct / 100) AS tax
      FROM public.sales_order_lines l GROUP BY l.sales_order_id)
  UPDATE public.sales_orders o SET
    line_items = r.items, subtotal = round(r.sub, 2), discount_amount = round(r.dis, 2),
    tax_amount = round(r.tax, 2), total = round(r.sub - r.dis + r.tax, 2)
  FROM r
  WHERE o.id = r.id AND o.status IN ('draft', 'sent')
    AND (o.line_items IS DISTINCT FROM r.items OR o.total IS DISTINCT FROM round(r.sub - r.dis + r.tax, 2));
  GET DIAGNOSTICS v_so = ROW_COUNT;

  WITH r AS (
    SELECT l.quotation_id AS id,
           jsonb_agg(jsonb_build_object(
             'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
             'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
             ORDER BY l.line_no) AS items,
           sum(l.qty * l.unit_price) AS sub,
           sum(l.qty * l.unit_price * l.discount_pct / 100) AS dis,
           sum((l.qty * l.unit_price - l.qty * l.unit_price * l.discount_pct / 100) * l.tax_pct / 100) AS tax
      FROM public.quotation_lines l GROUP BY l.quotation_id)
  UPDATE public.quotations q SET
    line_items = r.items, subtotal = round(r.sub, 2), discount_amount = round(r.dis, 2),
    tax_amount = round(r.tax, 2), total = round(r.sub - r.dis + r.tax, 2)
  FROM r
  WHERE q.id = r.id AND q.status IN ('draft', 'sent')
    AND (q.line_items IS DISTINCT FROM r.items OR q.total IS DISTINCT FROM round(r.sub - r.dis + r.tax, 2));
  GET DIAGNOSTICS v_qt = ROW_COUNT;

  RAISE NOTICE 'unsettled documents rebuilt from their rows: % sales orders, % quotations', v_so, v_qt;
END $$;

-- ── guard: nothing new is reachable by anon or callable where it should not be
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.create_sales_order(uuid, jsonb, date, text, text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.update_sales_order(uuid, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._sales_order_write_lines(uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: a sales-order-line function is executable by the wrong role';
  END IF;
  IF has_table_privilege('anon', 'public.sales_order_lines', 'SELECT')
     OR has_table_privilege('authenticated', 'public.sales_order_lines', 'INSERT')
     OR has_table_privilege('authenticated', 'public.sales_orders', 'INSERT') THEN
    RAISE EXCEPTION 'Refusing to finish: a client can still write sales-order lines or orders directly';
  END IF;
END $$;
