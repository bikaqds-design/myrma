-- ============================================================================
-- 20260885_crm_invoice_lines.sql
-- W2 / L-01, third document type — sales invoices (crm_invoices). Same design
-- as 20260883 (quotations) and 20260884 (sales orders); read those first.
--
-- WHAT DIFFERS
--   * A non-draft invoice was already locked by rma_guard_settled_document
--     (20260875), so the editing hole is smaller than on sales orders — but a
--     DRAFT invoice's line_items and totals could still be written directly
--     with any figures, and post_invoice turns them into the posted invoice.
--   * An invoice for an order was created in the BROWSER: salesOrders.
--     convertToInvoice read the order, checked "already invoiced?" with one
--     query and inserted with another. Two clicks, or two people, got two
--     invoices for one order. convert_so_to_invoice now does it in one
--     transaction with the order row locked.
--   * A manually raised invoice has no order (create_crm_invoice takes no
--     so_id): an invoice is tied to an order only by convert_so_to_invoice.
--   * Lines must be catalogue products, as on orders.
--   * An invoice made from an order carries what the customer accepted and the
--     stock reserved for it: its products, quantities and prices cannot be
--     edited (partial invoicing is P-02's, and will be designed there).
--   * Draft invoices whose historical lines the backfill corrected are rebuilt
--     from their rows; posted invoices keep their figures as issued.
--
-- post_invoice (stock and cost of goods), the credit-note caps
-- (_credit_note_assert_within_caps, issue_credit_note) and
-- rma_reservation_integrity read crm_invoices.line_items — kept as the mirror,
-- so none of them changed.
-- ============================================================================

-- ── 1. the table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_invoice_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crm_invoice_id  uuid NOT NULL REFERENCES public.crm_invoices(id) ON DELETE CASCADE,
  line_no         integer NOT NULL,
  -- Nullable only so historical invoices can be copied as they are; every line
  -- written from now on names a product.
  product_id      uuid REFERENCES public.products(id),
  product_name    text NOT NULL,
  description     text,
  qty             integer NOT NULL,
  unit_price      numeric(14,4) NOT NULL DEFAULT 0,
  discount_pct    numeric(5,2) NOT NULL DEFAULT 0,
  tax_pct         numeric(5,2) NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_invoice_lines_qty_positive   CHECK (qty >= 1),
  CONSTRAINT crm_invoice_lines_price_nonneg   CHECK (unit_price >= 0),
  CONSTRAINT crm_invoice_lines_discount_range CHECK (discount_pct >= 0 AND discount_pct <= 100),
  CONSTRAINT crm_invoice_lines_tax_range      CHECK (tax_pct >= 0 AND tax_pct <= 100),
  CONSTRAINT crm_invoice_lines_name_present   CHECK (length(btrim(product_name)) > 0),
  CONSTRAINT crm_invoice_lines_unique_line    UNIQUE (crm_invoice_id, line_no)
);

CREATE INDEX IF NOT EXISTS crm_invoice_lines_invoice_idx ON public.crm_invoice_lines (crm_invoice_id);
CREATE INDEX IF NOT EXISTS crm_invoice_lines_product_idx ON public.crm_invoice_lines (product_id) WHERE product_id IS NOT NULL;

COMMENT ON TABLE public.crm_invoice_lines IS
  'One row per sales-invoice line. Source of truth; crm_invoices.line_items is a read-only mirror maintained by create_crm_invoice / update_crm_invoice / convert_so_to_invoice. Client writes are revoked.';

ALTER TABLE public.crm_invoice_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_crm_invoice_lines" ON public.crm_invoice_lines;
CREATE POLICY "read_crm_invoice_lines"
  ON public.crm_invoice_lines
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.crm_invoices i WHERE i.id = crm_invoice_lines.crm_invoice_id));

REVOKE ALL ON TABLE public.crm_invoice_lines FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.crm_invoice_lines FROM authenticated;
GRANT SELECT ON TABLE public.crm_invoice_lines TO authenticated;
GRANT ALL ON TABLE public.crm_invoice_lines TO service_role;

-- ── 2. the client surface ────────────────────────────────────────────────────
-- Directly, a client may change only what crmInvoices.cancelDraft and
-- archiving change: doc_status (policed by rma_assert_sales_status_transition),
-- void_reason, and the archive fields. Everything else on a draft goes through
-- update_crm_invoice; a non-draft is also locked by rma_guard_settled_document.
CREATE OR REPLACE FUNCTION public.rma_guard_crm_invoice_client_writes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_open text[] := ARRAY['doc_status', 'void_reason', 'archived', 'archived_at', 'archived_by', 'updated_at'];
BEGIN
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
    RAISE EXCEPTION 'An invoice''s lines, amounts and details are changed through the invoice form (update_crm_invoice), not directly.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.rma_guard_crm_invoice_client_writes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_guard_crm_invoice_client_writes() TO service_role;

DROP TRIGGER IF EXISTS trg_crm_invoices_client_writes ON public.crm_invoices;
CREATE TRIGGER trg_crm_invoices_client_writes
  BEFORE UPDATE ON public.crm_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_crm_invoice_client_writes();

-- An invoice is created by create_crm_invoice or convert_so_to_invoice only.
REVOKE INSERT ON TABLE public.crm_invoices FROM authenticated;

-- ── 3. writing the lines (internal) ──────────────────────────────────────────
-- As _sales_order_write_lines: every line an existing catalogue product, whose
-- catalogue name fills a missing one; totals from the rows as stored.
CREATE OR REPLACE FUNCTION public._crm_invoice_write_lines(p_inv_id uuid, p_lines jsonb)
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
    RAISE EXCEPTION 'An invoice can have at most 500 lines' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.crm_invoice_lines WHERE crm_invoice_id = p_inv_id;

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
      RAISE EXCEPTION 'Line "%": an invoice line must be a catalogue product', COALESCE(NULLIF(v_name, ''), (v_no + 1)::text) USING ERRCODE = 'P0001';
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
      INSERT INTO public.crm_invoice_lines
        (crm_invoice_id, line_no, product_id, product_name, description, qty, unit_price, discount_pct, tax_pct)
      VALUES (
        p_inv_id, v_no, v_pid::uuid, v_name,
        NULLIF(btrim(COALESCE(v_line->>'description', '')), ''),
        v_qty::integer, v_price::numeric, v_dpct::numeric, v_tpct::numeric
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
    FROM (SELECT l.qty * l.unit_price                        AS base,
                 l.qty * l.unit_price * l.discount_pct / 100 AS disc,
                 l.tax_pct
            FROM public.crm_invoice_lines l WHERE l.crm_invoice_id = p_inv_id) b;

  RETURN QUERY
  SELECT round(v_sub, 2), round(v_dsum, 2), round(v_tsum, 2), round(v_sub - v_dsum + v_tsum, 2),
         (SELECT jsonb_agg(jsonb_build_object(
                   'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
                   'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
                 ORDER BY l.line_no)
            FROM public.crm_invoice_lines l WHERE l.crm_invoice_id = p_inv_id);
END
$function$;

REVOKE ALL ON FUNCTION public._crm_invoice_write_lines(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._crm_invoice_write_lines(uuid, jsonb) TO service_role;

-- ── 4. create_crm_invoice: a manual invoice, not tied to an order ────────────
CREATE OR REPLACE FUNCTION public.create_crm_invoice(
  p_customer_id    uuid,
  p_lines          jsonb,
  p_due_date       date,
  p_payment_terms  text,
  p_reference_po   text,
  p_notes          text,
  p_assigned_rep   text,
  p_actor_email    text
)
RETURNS public.crm_invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_id    uuid := gen_random_uuid();
  v_t     record;
  v_row   public.crm_invoices;
BEGIN
  -- The INSERT policy this replaces (sales_insert_crm_invoices, 20260781).
  IF NOT COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = 'sales_rep', false) THEN
    RAISE EXCEPTION 'Not authorized to create an invoice' USING ERRCODE = 'P0001';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Your login has no email, so this invoice cannot be attributed' USING ERRCODE = 'P0001';
  END IF;
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'A customer is required' USING ERRCODE = 'P0001';
  END IF;

  -- inv_code stays NULL on a draft: post_invoice assigns the gapless number.
  INSERT INTO public.crm_invoices
    (id, customer_id, doc_status, payment_status, line_items,
     due_date, payment_terms, reference_po, notes, assigned_rep, created_by)
  VALUES (
    v_id, p_customer_id, 'draft', 'unpaid', '[]'::jsonb,
    p_due_date, p_payment_terms, p_reference_po, p_notes, p_assigned_rep, v_actor
  );

  SELECT * INTO v_t FROM public._crm_invoice_write_lines(v_id, p_lines);

  UPDATE public.crm_invoices SET
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

REVOKE ALL ON FUNCTION public.create_crm_invoice(uuid, jsonb, date, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_crm_invoice(uuid, jsonb, date, text, text, text, text, text) TO authenticated, service_role;

-- ── 5. update_crm_invoice: a draft only ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_crm_invoice(
  p_id          uuid,
  p_lines       jsonb,
  p_fields      jsonb,
  p_actor_email text
)
RETURNS public.crm_invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor   text := public.rma_current_user_email();
  v_allowed text[] := ARRAY['due_date', 'payment_terms', 'reference_po', 'notes', 'assigned_rep'];
  v_key     text;
  v_inv     public.crm_invoices;
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
  v_row     public.crm_invoices;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authorized to edit an invoice' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(v_f) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Fields must be an object' USING ERRCODE = 'P0001';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(v_f) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'The field "%" cannot be changed here', v_key USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  SELECT * INTO v_inv FROM public.crm_invoices WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found', p_id USING ERRCODE = 'P0001';
  END IF;

  v_rep := CASE WHEN v_f ? 'assigned_rep' THEN NULLIF(btrim(COALESCE(v_f->>'assigned_rep', '')), '') ELSE v_inv.assigned_rep END;

  -- The UPDATE policy this replaces (sales_update_crm_invoices, 20260781),
  -- before and after, COALESCE-wrapped (BUG-087).
  IF NOT COALESCE(
       public.rma_is_manager_or_above()
       OR (public.rma_user_role() = 'sales_rep'
           AND (v_inv.assigned_rep = v_actor OR v_inv.created_by = v_actor)
           AND (v_rep = v_actor OR v_inv.created_by = v_actor)),
       false) THEN
    RAISE EXCEPTION 'Not authorized to edit this invoice' USING ERRCODE = 'P0001';
  END IF;

  IF v_inv.doc_status <> 'draft' THEN
    RAISE EXCEPTION 'This invoice is % and can no longer be edited', v_inv.doc_status USING ERRCODE = 'P0001';
  END IF;

  -- An invoice for an order bills what the customer accepted and what was
  -- reserved: its products, quantities and prices cannot change here (the form
  -- sends the lines back on every save, so an unchanged set passes).
  IF v_inv.so_id IS NOT NULL AND p_lines IS NOT NULL THEN
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
      v_new := NULL;
    END;
    SELECT string_agg(concat_ws('|',
             COALESCE(lower(l.product_id::text), ''),
             round(l.qty::numeric, 4), round(l.unit_price, 4), round(l.discount_pct, 2), round(l.tax_pct, 2)), ';' ORDER BY l.line_no)
      INTO v_old
      FROM public.crm_invoice_lines l WHERE l.crm_invoice_id = p_id;
    IF v_new IS DISTINCT FROM v_old THEN
      RAISE EXCEPTION 'This invoice was made from a sales order, and its products, quantities and prices are what was ordered and reserved. Cancel the draft and correct the order instead.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF v_f ? 'due_date' THEN
    BEGIN
      v_date := NULLIF(btrim(COALESCE(v_f->>'due_date', '')), '')::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'The due date is not a date' USING ERRCODE = 'P0001';
    END;
  END IF;

  v_items := v_inv.line_items; v_sub := v_inv.subtotal; v_dis := v_inv.discount_amount;
  v_tax := v_inv.tax_amount;   v_tot := v_inv.total;
  IF p_lines IS NOT NULL THEN
    SELECT w.line_items, w.subtotal, w.discount_amount, w.tax_amount, w.total
      INTO v_items, v_sub, v_dis, v_tax, v_tot
      FROM public._crm_invoice_write_lines(p_id, p_lines) w;
  END IF;

  UPDATE public.crm_invoices SET
    line_items      = v_items,
    subtotal        = v_sub,
    discount_amount = v_dis,
    tax_amount      = v_tax,
    total           = v_tot,
    due_date        = CASE WHEN v_f ? 'due_date'      THEN v_date                ELSE due_date      END,
    payment_terms   = CASE WHEN v_f ? 'payment_terms' THEN v_f->>'payment_terms' ELSE payment_terms END,
    reference_po    = CASE WHEN v_f ? 'reference_po'  THEN v_f->>'reference_po'  ELSE reference_po  END,
    notes           = CASE WHEN v_f ? 'notes'         THEN v_f->>'notes'         ELSE notes         END,
    assigned_rep    = v_rep
  WHERE id = p_id
  RETURNING * INTO v_row;

  RETURN v_row;
END
$function$;

REVOKE ALL ON FUNCTION public.update_crm_invoice(uuid, jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_crm_invoice(uuid, jsonb, jsonb, text) TO authenticated, service_role;

-- ── 6. convert_so_to_invoice: one transaction, the order locked ──────────────
-- Replaces the browser's read-check-insert (salesOrders.convertToInvoice).
-- Who may: a manager, or the sales rep who owns the order — what a rep could
-- effectively do before (they can read only their own orders).
CREATE OR REPLACE FUNCTION public.convert_so_to_invoice(p_so_id uuid, p_actor_email text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_so    public.sales_orders;
  v_id    uuid := gen_random_uuid();
  v_src   jsonb;
  v_w     record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authorized to invoice a sales order' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order % not found', p_so_id USING ERRCODE = 'P0001';
  END IF;

  IF NOT COALESCE(
       public.rma_is_manager_or_above()
       OR (public.rma_user_role() = 'sales_rep'
           AND (v_so.assigned_rep = v_actor OR v_so.created_by = v_actor)),
       false) THEN
    RAISE EXCEPTION 'Not authorized to invoice this sales order' USING ERRCODE = 'P0001';
  END IF;

  IF v_so.status NOT IN ('confirmed', 'delivered') THEN
    RAISE EXCEPTION 'Approve the sales order before invoicing it (it is %)', v_so.status USING ERRCODE = 'P0001';
  END IF;

  -- Under the order's row lock, so a second click waits here and then sees the
  -- first invoice instead of creating another.
  IF EXISTS (SELECT 1 FROM public.crm_invoices WHERE so_id = p_so_id AND doc_status <> 'cancelled') THEN
    RAISE EXCEPTION 'This sales order has already been converted to an invoice' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.crm_invoices
    (id, so_id, customer_id, doc_status, payment_status, line_items,
     payment_terms, reference_po, notes, assigned_rep, created_by)
  VALUES (
    v_id, p_so_id, v_so.customer_id, 'draft', 'unpaid', '[]'::jsonb,
    v_so.payment_terms, v_so.reference_po, v_so.notes, COALESCE(v_so.assigned_rep, v_actor), v_actor
  );

  -- From the order's rows (the raw line_items only if an order has none, which
  -- only data written outside the RPCs can); mirror and totals from the
  -- invoice's own rows.
  SELECT jsonb_agg(jsonb_build_object(
           'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
           'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
         ORDER BY l.line_no)
    INTO v_src
    FROM public.sales_order_lines l WHERE l.sales_order_id = p_so_id;

  SELECT * INTO v_w FROM public._crm_invoice_write_lines(v_id, COALESCE(v_src, v_so.line_items));

  UPDATE public.crm_invoices SET
    line_items      = v_w.line_items,
    subtotal        = v_w.subtotal,
    discount_amount = v_w.discount_amount,
    tax_amount      = v_w.tax_amount,
    total           = v_w.total
  WHERE id = v_id;

  RETURN v_id;
END
$function$;

REVOKE ALL ON FUNCTION public.convert_so_to_invoice(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_so_to_invoice(uuid, text) TO authenticated, service_role;

-- ── 7. backfill existing invoices ────────────────────────────────────────────
-- As 20260883 / 20260884: text-first, a malformed or deleted product id costs
-- only the link, values outside the rules clamped and reported, drift counted.
-- Historical line_items and totals — posted invoices among them — are NOT
-- rewritten.
CREATE OR REPLACE FUNCTION pg_temp.inv_bf_num(p text, p_default numeric) RETURNS numeric LANGUAGE plpgsql AS $f$
BEGIN
  IF btrim(COALESCE(p, '')) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN btrim(p)::numeric; END IF;
  RETURN p_default;
END $f$;

DO $$
DECLARE
  v_i        record;
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
  FOR v_i IN
    SELECT i.id, i.line_items FROM public.crm_invoices i
     WHERE NOT EXISTS (SELECT 1 FROM public.crm_invoice_lines il WHERE il.crm_invoice_id = i.id)
       AND jsonb_typeof(i.line_items) = 'array'
  LOOP
    v_no := 0;
    FOR v_t IN SELECT e.l FROM jsonb_array_elements(v_i.line_items) AS e(l)
    LOOP
      IF jsonb_typeof(v_t.l) IS DISTINCT FROM 'object' THEN
        v_t.l := '{}'::jsonb;
      END IF;

      v_pid := NULL;
      IF btrim(COALESCE(v_t.l->>'product_id', '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT p.id INTO v_pid FROM public.products p WHERE p.id = btrim(v_t.l->>'product_id')::uuid;
      END IF;

      v_qty   := pg_temp.inv_bf_num(v_t.l->>'qty', 1);
      v_price := pg_temp.inv_bf_num(v_t.l->>'unit_price', 0);
      v_dpct  := pg_temp.inv_bf_num(v_t.l->>'discount_pct', 0);
      v_tpct  := pg_temp.inv_bf_num(v_t.l->>'tax_pct', 0);

      v_unread := EXISTS (SELECT 1 FROM unnest(ARRAY['qty', 'unit_price', 'discount_pct', 'tax_pct']) k
                           WHERE v_t.l->>k IS NOT NULL AND btrim(v_t.l->>k) !~ '^-?[0-9]+(\.[0-9]+)?$');

      IF v_unread OR v_qty <> round(v_qty) OR v_qty < 1 OR v_price < 0 OR v_dpct NOT BETWEEN 0 AND 100 OR v_tpct NOT BETWEEN 0 AND 100
         OR v_pid IS NULL THEN
        v_changed := v_changed + 1;
        RAISE WARNING 'crm_invoice_lines backfill: invoice % line % had values outside the new rules (qty %, price %, discount %, tax %, product %); stored inside them',
          v_i.id, v_no + 1, v_t.l->>'qty', v_t.l->>'unit_price', v_t.l->>'discount_pct', v_t.l->>'tax_pct', COALESCE(v_t.l->>'product_id', '-');
      END IF;

      INSERT INTO public.crm_invoice_lines
        (crm_invoice_id, line_no, product_id, product_name, description, qty, unit_price, discount_pct, tax_pct)
      VALUES (
        v_i.id, v_no, v_pid,
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
    FROM public.crm_invoices i
    JOIN LATERAL (
      SELECT round(COALESCE(sum(l.qty * l.unit_price * (1 - l.discount_pct / 100) * (1 + l.tax_pct / 100)), 0), 2) AS t
        FROM public.crm_invoice_lines l WHERE l.crm_invoice_id = i.id) s ON true
   WHERE abs(s.t - i.total) > 0.01;

  RAISE NOTICE 'crm_invoice_lines backfill: % lines written, % brought inside the new rules, % invoices whose lines no longer add up to their stored total',
    v_lines, v_changed, v_drift;
END $$;

-- ── 8. draft invoices agree with their rows ──────────────────────────────────
-- A draft is not an issued figure, and post_invoice will deliver stock and
-- book cost of goods from its line_items. Where the backfill corrected a
-- historical line, a DRAFT's mirror and totals are rebuilt from the rows.
-- Posted, paid and void invoices keep their figures as issued.
DO $$
DECLARE v_n integer;
BEGIN
  WITH r AS (
    SELECT l.crm_invoice_id AS id,
           jsonb_agg(jsonb_build_object(
             'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
             'qty', l.qty, 'unit_price', l.unit_price, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
             ORDER BY l.line_no) AS items,
           sum(l.qty * l.unit_price) AS sub,
           sum(l.qty * l.unit_price * l.discount_pct / 100) AS dis,
           sum((l.qty * l.unit_price - l.qty * l.unit_price * l.discount_pct / 100) * l.tax_pct / 100) AS tax
      FROM public.crm_invoice_lines l GROUP BY l.crm_invoice_id)
  UPDATE public.crm_invoices i SET
    line_items = r.items, subtotal = round(r.sub, 2), discount_amount = round(r.dis, 2),
    tax_amount = round(r.tax, 2), total = round(r.sub - r.dis + r.tax, 2)
  FROM r
  WHERE i.id = r.id AND i.doc_status = 'draft'
    AND (i.line_items IS DISTINCT FROM r.items OR i.total IS DISTINCT FROM round(r.sub - r.dis + r.tax, 2));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'draft invoices rebuilt from their rows: %', v_n;
END $$;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.create_crm_invoice(uuid, jsonb, date, text, text, text, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.update_crm_invoice(uuid, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.convert_so_to_invoice(uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._crm_invoice_write_lines(uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: an invoice-line function is executable by the wrong role';
  END IF;
  IF has_table_privilege('anon', 'public.crm_invoice_lines', 'SELECT')
     OR has_table_privilege('authenticated', 'public.crm_invoice_lines', 'INSERT')
     OR has_table_privilege('authenticated', 'public.crm_invoices', 'INSERT') THEN
    RAISE EXCEPTION 'Refusing to finish: a client can still write invoice lines or invoices directly';
  END IF;
END $$;
