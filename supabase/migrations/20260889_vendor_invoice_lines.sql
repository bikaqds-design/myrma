-- ============================================================================
-- 20260889_vendor_invoice_lines.sql
-- W2 / L-01, sixth and last document type — vendor (supplier) invoices. Same
-- design as 20260883-20260888; read 20260883 first.
--
-- WHAT DIFFERS
--   * Manager+ only (manager_write_vendor_invoices), like purchase orders.
--   * A line carries qty_received, which receive_vendor_invoice moves: the
--     rows and the line_items mirror are updated together (the function is
--     20260882's, plus that one block).
--   * The browser computed a vendor invoice's totals and wrote them with the
--     lines; the identity guard (20260881) locks them only after submission,
--     so a draft's figures were whatever the browser sent.
--     create_vendor_invoice / update_vendor_invoice (a draft only) now write
--     it. The supplier number, its date, the no-PO reason and the dates go
--     through them too, normalised as the identity guard does (a definer call
--     skips that guard), and a supplier number already on file is refused by
--     name, as the guard does.
--   * Converting a purchase order was a browser read-then-insert that never
--     sent a currency: vendor_invoices.currency is NOT NULL with no default,
--     so "Create vendor invoice" from a PO always failed (also on main).
--     convert_po_to_vendor_invoice locks the order, takes its currency, rate
--     and rows, and refuses a second live invoice for the same order.
--   * Direct client updates keep what the screens do on their own: status
--     (transition, approval-authority and identity guards still apply),
--     approved_at, duplicate_override_reason (submitForApproval) and the
--     archive fields.
--
-- rma_vi_landed_unit_costs and receive_vendor_invoice's line lookups read the
-- line_items mirror by index; line_no is that index, so they agree.
-- ============================================================================

-- ── 1. the table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vendor_invoice_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_invoice_id  uuid NOT NULL REFERENCES public.vendor_invoices(id) ON DELETE CASCADE,
  line_no            integer NOT NULL,
  -- Nullable only so historical invoices can be copied as they are; every line
  -- written from now on names a product.
  product_id         uuid REFERENCES public.products(id),
  product_name       text NOT NULL,
  description        text,
  qty_ordered        integer NOT NULL,
  qty_received       integer NOT NULL DEFAULT 0,
  unit_cost          numeric(14,4) NOT NULL DEFAULT 0,
  discount_pct       numeric(5,2) NOT NULL DEFAULT 0,
  tax_pct            numeric(5,2) NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_invoice_lines_qty_positive   CHECK (qty_ordered >= 1),
  CONSTRAINT vendor_invoice_lines_received_range CHECK (qty_received >= 0 AND qty_received <= qty_ordered),
  CONSTRAINT vendor_invoice_lines_cost_nonneg    CHECK (unit_cost >= 0),
  CONSTRAINT vendor_invoice_lines_discount_range CHECK (discount_pct >= 0 AND discount_pct <= 100),
  CONSTRAINT vendor_invoice_lines_tax_range      CHECK (tax_pct >= 0 AND tax_pct <= 100),
  CONSTRAINT vendor_invoice_lines_name_present   CHECK (length(btrim(product_name)) > 0),
  CONSTRAINT vendor_invoice_lines_unique_line    UNIQUE (vendor_invoice_id, line_no)
);

CREATE INDEX IF NOT EXISTS vendor_invoice_lines_vi_idx ON public.vendor_invoice_lines (vendor_invoice_id);
CREATE INDEX IF NOT EXISTS vendor_invoice_lines_product_idx ON public.vendor_invoice_lines (product_id) WHERE product_id IS NOT NULL;

COMMENT ON TABLE public.vendor_invoice_lines IS
  'One row per vendor-invoice line. Source of truth; vendor_invoices.line_items is a read-only mirror maintained by create_vendor_invoice / update_vendor_invoice / convert_po_to_vendor_invoice / receive_vendor_invoice. Client writes are revoked.';

ALTER TABLE public.vendor_invoice_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_vendor_invoice_lines" ON public.vendor_invoice_lines;
CREATE POLICY "read_vendor_invoice_lines"
  ON public.vendor_invoice_lines
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.vendor_invoices v WHERE v.id = vendor_invoice_lines.vendor_invoice_id));

REVOKE ALL ON TABLE public.vendor_invoice_lines FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.vendor_invoice_lines FROM authenticated;
GRANT SELECT ON TABLE public.vendor_invoice_lines TO authenticated;
GRANT ALL ON TABLE public.vendor_invoice_lines TO service_role;

-- ── 2. the client surface ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_guard_vendor_invoice_allowlist()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_open text[] := ARRAY['status', 'approved_at', 'duplicate_override_reason',
                         'archived', 'archived_at', 'archived_by', 'updated_at'];
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
    RAISE EXCEPTION 'A vendor invoice''s lines, amounts and details are changed through the invoice form (update_vendor_invoice), not directly.'
      USING ERRCODE = 'P0001';
  END IF;
  -- Received is what receive_vendor_invoice records; set directly it would
  -- bring in no stock and leave the invoice unreceivable (review).
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('partially_received', 'received') THEN
    RAISE EXCEPTION 'A vendor invoice is received by receiving its goods, not by setting its status.'
      USING ERRCODE = 'P0001';
  END IF;
  -- The open columns belong to one step each: the duplicate reason to
  -- submitting a draft, the approval time to approving.
  IF NEW.duplicate_override_reason IS DISTINCT FROM OLD.duplicate_override_reason AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'The reason for a possible duplicate is given when the invoice is submitted.'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.approved_at IS DISTINCT FROM OLD.approved_at
     AND NOT (OLD.status = 'pending_approval' AND NEW.status = 'approved') THEN
    RAISE EXCEPTION 'The approval time is recorded when the invoice is approved.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.rma_guard_vendor_invoice_allowlist() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_guard_vendor_invoice_allowlist() TO service_role;

DROP TRIGGER IF EXISTS trg_vendor_invoices_allowlist ON public.vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_allowlist
  BEFORE UPDATE ON public.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_vendor_invoice_allowlist();

-- A vendor invoice is created by create_vendor_invoice or
-- convert_po_to_vendor_invoice only.
REVOKE INSERT ON TABLE public.vendor_invoices FROM authenticated;

-- ── 3. writing the lines (internal) ──────────────────────────────────────────
-- As _purchase_order_write_lines; a draft's lines have received nothing yet.
CREATE OR REPLACE FUNCTION public._vendor_invoice_write_lines(p_vi_id uuid, p_lines jsonb)
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
    RAISE EXCEPTION 'A vendor invoice needs at least one line' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_lines) > 500 THEN
    RAISE EXCEPTION 'A vendor invoice can have at most 500 lines' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.vendor_invoice_lines WHERE vendor_invoice_id = p_vi_id;

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
      RAISE EXCEPTION 'Line "%": a vendor invoice line must be a catalogue product', COALESCE(NULLIF(v_name, ''), (v_no + 1)::text) USING ERRCODE = 'P0001';
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
      INSERT INTO public.vendor_invoice_lines
        (vendor_invoice_id, line_no, product_id, product_name, description, qty_ordered, qty_received, unit_cost, discount_pct, tax_pct)
      VALUES (
        p_vi_id, v_no, v_pid::uuid, v_name,
        NULLIF(btrim(COALESCE(v_line->>'description', '')), ''),
        v_qty::integer, 0, v_cost::numeric, v_dpct::numeric, v_tpct::numeric
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
            FROM public.vendor_invoice_lines l WHERE l.vendor_invoice_id = p_vi_id) b;

  -- vendor_invoices' money columns hold 10 digits before the point
  IF v_sub >= 10000000000 OR v_sub - v_dsum + v_tsum >= 10000000000 THEN
    RAISE EXCEPTION 'This invoice is too large to store (a total of 10 billion or more)' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT round(v_sub, 2), round(v_dsum, 2), round(v_tsum, 2), round(v_sub - v_dsum + v_tsum, 2),
         (SELECT jsonb_agg(jsonb_build_object(
                   'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
                   'qty_ordered', l.qty_ordered, 'qty_received', l.qty_received,
                   'unit_cost', l.unit_cost, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
                 ORDER BY l.line_no)
            FROM public.vendor_invoice_lines l WHERE l.vendor_invoice_id = p_vi_id);
END
$function$;

REVOKE ALL ON FUNCTION public._vendor_invoice_write_lines(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._vendor_invoice_write_lines(uuid, jsonb) TO service_role;

-- ── 4. header fields and the supplier number (internal) ──────────────────────
CREATE OR REPLACE FUNCTION public._vendor_invoice_check_fields(p_fields jsonb)
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
    IF NOT (v_key = ANY (ARRAY['currency', 'exchange_rate', 'invoice_date', 'due_date', 'notes',
                              'supplier_invoice_no', 'supplier_invoice_date', 'non_po_reason'])) THEN
      RAISE EXCEPTION 'The field "%" cannot be set here', v_key USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['invoice_date', 'due_date', 'supplier_invoice_date'] LOOP
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
  IF p_fields ? 'exchange_rate' AND (COALESCE(btrim(p_fields->>'exchange_rate'), '') !~ '^[0-9]{1,10}(\.[0-9]+)?$'
                                     OR (p_fields->>'exchange_rate')::numeric <= 0) THEN
    RAISE EXCEPTION 'The exchange rate must be a positive number' USING ERRCODE = 'P0001';
  END IF;
  IF p_fields ? 'currency' AND COALESCE(btrim(p_fields->>'currency'), '') !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'The currency must be a three-letter code' USING ERRCODE = 'P0001';
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION public._vendor_invoice_check_fields(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._vendor_invoice_check_fields(jsonb) TO service_role;

-- The identity guard's "same supplier number twice" rule, for the definer
-- path it does not see: name the invoice already on file.
CREATE OR REPLACE FUNCTION public._vendor_invoice_assert_supplier_no(p_vi public.vendor_invoices)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_dup record;
BEGIN
  IF p_vi.supplier_invoice_no IS NULL OR p_vi.status = 'cancelled' THEN
    RETURN;
  END IF;
  SELECT o.vi_code INTO v_dup
    FROM public.vendor_invoices o
   WHERE o.vendor_id = p_vi.vendor_id
     AND o.id <> p_vi.id
     AND o.status <> 'cancelled'
     AND o.supplier_invoice_no IS NOT NULL
     AND public.rma_norm_supplier_no(o.supplier_invoice_no) = public.rma_norm_supplier_no(p_vi.supplier_invoice_no)
     AND EXTRACT(YEAR FROM (o.created_at AT TIME ZONE 'UTC'))::integer
         = EXTRACT(YEAR FROM (COALESCE(p_vi.created_at, now()) AT TIME ZONE 'UTC'))::integer
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Supplier invoice % has already been entered for this supplier (%). Cancel the earlier one first if it was a mistake.',
      p_vi.supplier_invoice_no, COALESCE(v_dup.vi_code, 'a draft')
      USING ERRCODE = 'P0001';
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION public._vendor_invoice_assert_supplier_no(public.vendor_invoices) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._vendor_invoice_assert_supplier_no(public.vendor_invoices) TO service_role;

-- ── 5. create_vendor_invoice: an invoice not raised from an order ────────────
CREATE OR REPLACE FUNCTION public.create_vendor_invoice(
  p_vendor_id   uuid,
  p_lines       jsonb,
  p_fields      jsonb,
  p_actor_email text
)
RETURNS public.vendor_invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_id    uuid := gen_random_uuid();
  v_f     jsonb := COALESCE(p_fields, '{}'::jsonb);
  v_t     record;
  v_row   public.vendor_invoices;
  v_probe public.vendor_invoices;
BEGIN
  -- The policy this replaces (manager_write_vendor_invoices).
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Not authorized to create a vendor invoice' USING ERRCODE = 'P0001';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Your login has no email, so this vendor invoice cannot be attributed' USING ERRCODE = 'P0001';
  END IF;
  IF p_vendor_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.brands b WHERE b.id = p_vendor_id) THEN
    RAISE EXCEPTION 'A vendor is required' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public._vendor_invoice_check_fields(v_f);
  IF NULLIF(btrim(COALESCE(v_f->>'currency', '')), '') IS NULL THEN
    RAISE EXCEPTION 'A currency is required' USING ERRCODE = 'P0001';
  END IF;

  -- Before the INSERT, or the unique index answers first with a raw error.
  v_probe.id := v_id;
  v_probe.vendor_id := p_vendor_id;
  v_probe.status := 'draft';
  v_probe.created_at := now();
  v_probe.supplier_invoice_no := CASE WHEN COALESCE(public.rma_norm_supplier_no(v_f->>'supplier_invoice_no'), '') = '' THEN NULL ELSE btrim(v_f->>'supplier_invoice_no') END;
  PERFORM public._vendor_invoice_assert_supplier_no(v_probe);

  -- vi_code stays NULL until the first receipt (receive_vendor_invoice).
  INSERT INTO public.vendor_invoices
    (id, vendor_id, status, line_items, currency, exchange_rate, invoice_date, due_date, notes,
     supplier_invoice_no, supplier_invoice_date, non_po_reason, created_by)
  VALUES (
    v_id, p_vendor_id, 'draft', '[]'::jsonb, v_f->>'currency', COALESCE((v_f->>'exchange_rate')::numeric, 1),
    NULLIF(btrim(COALESCE(v_f->>'invoice_date', '')), '')::date,
    NULLIF(btrim(COALESCE(v_f->>'due_date', '')), '')::date,
    NULLIF(v_f->>'notes', ''),
    CASE WHEN COALESCE(public.rma_norm_supplier_no(v_f->>'supplier_invoice_no'), '') = '' THEN NULL ELSE btrim(v_f->>'supplier_invoice_no') END,
    NULLIF(btrim(COALESCE(v_f->>'supplier_invoice_date', '')), '')::date,
    NULLIF(btrim(COALESCE(v_f->>'non_po_reason', '')), ''),
    v_actor
  );

  SELECT * INTO v_t FROM public._vendor_invoice_write_lines(v_id, p_lines);

  UPDATE public.vendor_invoices SET
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

REVOKE ALL ON FUNCTION public.create_vendor_invoice(uuid, jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_vendor_invoice(uuid, jsonb, jsonb, text) TO authenticated, service_role;

-- ── 6. update_vendor_invoice: a draft only ───────────────────────────────────
-- The lines of an invoice raised from an order stay editable while it is a
-- draft: the supplier's bill can differ from what was ordered, and approval is
-- where that is looked at.
CREATE OR REPLACE FUNCTION public.update_vendor_invoice(
  p_id          uuid,
  p_lines       jsonb,
  p_fields      jsonb,
  p_actor_email text
)
RETURNS public.vendor_invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_f     jsonb := COALESCE(p_fields, '{}'::jsonb);
  v_vi    public.vendor_invoices;
  v_items jsonb;
  v_sub   numeric;
  v_dis   numeric;
  v_tax   numeric;
  v_tot   numeric;
  v_row   public.vendor_invoices;
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) OR v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authorized to edit a vendor invoice' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public._vendor_invoice_check_fields(v_f);
  IF v_f ? 'currency' AND NULLIF(btrim(COALESCE(v_f->>'currency', '')), '') IS NULL THEN
    RAISE EXCEPTION 'A currency is required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_vi FROM public.vendor_invoices WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor invoice % not found', p_id USING ERRCODE = 'P0001';
  END IF;
  IF v_vi.status <> 'draft' THEN
    RAISE EXCEPTION 'This vendor invoice is % and can no longer be edited. Send it back to draft first.', v_vi.status
      USING ERRCODE = 'P0001';
  END IF;

  IF v_f ? 'supplier_invoice_no' THEN
    v_vi.supplier_invoice_no := CASE WHEN COALESCE(public.rma_norm_supplier_no(v_f->>'supplier_invoice_no'), '') = '' THEN NULL ELSE btrim(v_f->>'supplier_invoice_no') END;
    PERFORM public._vendor_invoice_assert_supplier_no(v_vi);
  END IF;

  v_items := v_vi.line_items; v_sub := v_vi.subtotal; v_dis := v_vi.discount_amount;
  v_tax := v_vi.tax_amount;   v_tot := v_vi.total;
  IF p_lines IS NOT NULL THEN
    SELECT w.line_items, w.subtotal, w.discount_amount, w.tax_amount, w.total
      INTO v_items, v_sub, v_dis, v_tax, v_tot
      FROM public._vendor_invoice_write_lines(p_id, p_lines) w;
  END IF;

  UPDATE public.vendor_invoices SET
    line_items      = v_items,
    subtotal        = v_sub,
    discount_amount = v_dis,
    tax_amount      = v_tax,
    total           = v_tot,
    currency      = CASE WHEN v_f ? 'currency'      THEN v_f->>'currency' ELSE currency END,
    exchange_rate = CASE WHEN v_f ? 'exchange_rate' THEN COALESCE((v_f->>'exchange_rate')::numeric, 1) ELSE exchange_rate END,
    invoice_date  = CASE WHEN v_f ? 'invoice_date'  THEN NULLIF(btrim(COALESCE(v_f->>'invoice_date', '')), '')::date ELSE invoice_date END,
    due_date      = CASE WHEN v_f ? 'due_date'      THEN NULLIF(btrim(COALESCE(v_f->>'due_date', '')), '')::date ELSE due_date END,
    notes         = CASE WHEN v_f ? 'notes'         THEN NULLIF(v_f->>'notes', '') ELSE notes END,
    supplier_invoice_no   = CASE WHEN v_f ? 'supplier_invoice_no'   THEN CASE WHEN COALESCE(public.rma_norm_supplier_no(v_f->>'supplier_invoice_no'), '') = '' THEN NULL ELSE btrim(v_f->>'supplier_invoice_no') END ELSE supplier_invoice_no END,
    supplier_invoice_date = CASE WHEN v_f ? 'supplier_invoice_date' THEN NULLIF(btrim(COALESCE(v_f->>'supplier_invoice_date', '')), '')::date ELSE supplier_invoice_date END,
    non_po_reason         = CASE WHEN v_f ? 'non_po_reason'         THEN NULLIF(btrim(COALESCE(v_f->>'non_po_reason', '')), '') ELSE non_po_reason END,
    updated_at    = now()
  WHERE id = p_id
  RETURNING * INTO v_row;

  RETURN v_row;
END
$function$;

REVOKE ALL ON FUNCTION public.update_vendor_invoice(uuid, jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_vendor_invoice(uuid, jsonb, jsonb, text) TO authenticated, service_role;

-- ── 7. convert_po_to_vendor_invoice: one transaction, the order locked ───────
CREATE OR REPLACE FUNCTION public.convert_po_to_vendor_invoice(p_po_id uuid, p_actor_email text)
RETURNS public.vendor_invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_po    public.purchase_orders;
  v_src   jsonb;
  v_id    uuid := gen_random_uuid();
  v_t     record;
  v_row   public.vendor_invoices;
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) OR v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authorized to raise a vendor invoice' USING ERRCODE = 'P0001';
  END IF;

  -- Locked first, so two clicks (or two people) cannot both pass the check below.
  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order % not found', p_po_id USING ERRCODE = 'P0001';
  END IF;
  IF v_po.status NOT IN ('confirmed', 'partially_completed') THEN
    RAISE EXCEPTION 'A vendor invoice is raised from a confirmed purchase order (this one is %)', v_po.status
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.vendor_invoices WHERE purchase_order_id = p_po_id AND status <> 'cancelled') THEN
    RAISE EXCEPTION 'A vendor invoice has already been raised against this order' USING ERRCODE = 'P0001';
  END IF;

  -- The order's rows (its mirror only if it has none, which only data written
  -- outside the RPCs can).
  SELECT jsonb_agg(jsonb_build_object(
           'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
           'qty_ordered', l.qty_ordered, 'unit_cost', l.unit_cost, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
           ORDER BY l.line_no)
    INTO v_src
    FROM public.purchase_order_lines l WHERE l.purchase_order_id = p_po_id;

  INSERT INTO public.vendor_invoices
    (id, purchase_order_id, vendor_id, status, line_items, currency, exchange_rate, notes, created_by)
  VALUES (v_id, p_po_id, v_po.vendor_id, 'draft', '[]'::jsonb, v_po.currency, v_po.exchange_rate, v_po.notes, v_actor);

  SELECT * INTO v_t FROM public._vendor_invoice_write_lines(v_id, COALESCE(v_src, v_po.line_items));

  UPDATE public.vendor_invoices SET
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

REVOKE ALL ON FUNCTION public.convert_po_to_vendor_invoice(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_po_to_vendor_invoice(uuid, text) TO authenticated, service_role;

-- ── 8. receive_vendor_invoice keeps the rows in step ─────────────────────────
-- 20260882's function, unchanged but for one block: what this call received
-- is added to each line's row as well as to the mirror. Same signature, so
-- CREATE OR REPLACE keeps its grants.
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

  -- The rows move with the mirror (20260889): line_no is the mirror's index.
  UPDATE public.vendor_invoice_lines l
     SET qty_received = l.qty_received + (v_taken->>(l.line_no::text))::integer,
         updated_at   = now()
   WHERE l.vendor_invoice_id = p_vi_id
     AND v_taken ? (l.line_no::text);

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

-- ── 9. backfill existing vendor invoices ─────────────────────────────────────
-- As before: text-first, a malformed or deleted product id costs only the
-- link, values outside the rules clamped and reported (including values that
-- could not be read), drift counted. qty_received is kept within 0..ordered.
-- Historical line_items and totals are NOT rewritten here.
CREATE OR REPLACE FUNCTION pg_temp.vi_bf_num(p text, p_default numeric) RETURNS numeric LANGUAGE plpgsql AS $f$
BEGIN
  IF btrim(COALESCE(p, '')) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN btrim(p)::numeric; END IF;
  RETURN p_default;
END $f$;

DO $$
DECLARE
  v_v        record;
  v_t        record;
  v_no       integer;
  v_pid      uuid;
  v_qty      numeric;
  v_rec      numeric;
  v_cost     numeric;
  v_dpct     numeric;
  v_tpct     numeric;
  v_q        integer;
  v_unread   boolean;
  v_changed  integer := 0;
  v_lines    integer := 0;
  v_drift    integer;
BEGIN
  FOR v_v IN
    SELECT i.id, i.line_items FROM public.vendor_invoices i
     WHERE NOT EXISTS (SELECT 1 FROM public.vendor_invoice_lines vl WHERE vl.vendor_invoice_id = i.id)
       AND jsonb_typeof(i.line_items) = 'array'
  LOOP
    v_no := 0;
    FOR v_t IN SELECT e.l FROM jsonb_array_elements(v_v.line_items) AS e(l)
    LOOP
      IF jsonb_typeof(v_t.l) IS DISTINCT FROM 'object' THEN
        v_t.l := '{}'::jsonb;
      END IF;

      v_pid := NULL;
      IF btrim(COALESCE(v_t.l->>'product_id', '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT p.id INTO v_pid FROM public.products p WHERE p.id = btrim(v_t.l->>'product_id')::uuid;
      END IF;

      v_qty  := pg_temp.vi_bf_num(v_t.l->>'qty_ordered', 1);
      v_rec  := pg_temp.vi_bf_num(v_t.l->>'qty_received', 0);
      v_cost := pg_temp.vi_bf_num(v_t.l->>'unit_cost', 0);
      v_dpct := pg_temp.vi_bf_num(v_t.l->>'discount_pct', 0);
      v_tpct := pg_temp.vi_bf_num(v_t.l->>'tax_pct', 0);
      v_q    := GREATEST(1, LEAST(999999999, round(v_qty)))::integer;

      v_unread := EXISTS (SELECT 1 FROM unnest(ARRAY['qty_ordered', 'qty_received', 'unit_cost', 'discount_pct', 'tax_pct']) k
                           WHERE v_t.l->>k IS NOT NULL AND btrim(v_t.l->>k) !~ '^-?[0-9]+(\.[0-9]+)?$');

      IF v_unread OR v_qty <> round(v_qty) OR v_qty < 1 OR v_rec <> round(v_rec) OR v_rec < 0 OR round(v_rec) > v_q
         OR v_cost < 0 OR v_dpct NOT BETWEEN 0 AND 100 OR v_tpct NOT BETWEEN 0 AND 100 OR v_pid IS NULL THEN
        v_changed := v_changed + 1;
        RAISE WARNING 'vendor_invoice_lines backfill: invoice % line % had values outside the new rules (qty %, received %, cost %, discount %, tax %, product %); stored inside them',
          v_v.id, v_no + 1, v_t.l->>'qty_ordered', v_t.l->>'qty_received', v_t.l->>'unit_cost', v_t.l->>'discount_pct', v_t.l->>'tax_pct', COALESCE(v_t.l->>'product_id', '-');
      END IF;

      INSERT INTO public.vendor_invoice_lines
        (vendor_invoice_id, line_no, product_id, product_name, description, qty_ordered, qty_received, unit_cost, discount_pct, tax_pct)
      VALUES (
        v_v.id, v_no, v_pid,
        COALESCE(NULLIF(btrim(COALESCE(v_t.l->>'product_name', '')), ''), '(unnamed line)'),
        NULLIF(btrim(COALESCE(v_t.l->>'description', '')), ''),
        v_q,
        LEAST(v_q, GREATEST(0, round(v_rec)))::integer,
        GREATEST(0, LEAST(9999999999, v_cost)),
        LEAST(100, GREATEST(0, v_dpct)),
        LEAST(100, GREATEST(0, v_tpct))
      );
      v_lines := v_lines + 1;
      v_no := v_no + 1;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_drift
    FROM public.vendor_invoices i
    JOIN LATERAL (
      SELECT round(COALESCE(sum(l.qty_ordered * l.unit_cost * (1 - l.discount_pct / 100) * (1 + l.tax_pct / 100)), 0), 2) AS t
        FROM public.vendor_invoice_lines l WHERE l.vendor_invoice_id = i.id) s ON true
   WHERE abs(s.t - i.total) > 0.01;

  RAISE NOTICE 'vendor_invoice_lines backfill: % lines written, % brought inside the new rules, % invoices whose lines no longer add up to their stored total',
    v_lines, v_changed, v_drift;
END $$;

-- ── 10. draft invoices agree with their rows ─────────────────────────────────
-- A draft has not been submitted, approved or received against. Everything
-- past draft keeps the figures it was submitted, approved or received on.
DO $$
DECLARE v_n integer;
BEGIN
  WITH r AS (
    SELECT l.vendor_invoice_id AS id,
           jsonb_agg(jsonb_build_object(
             'product_id', l.product_id, 'product_name', l.product_name, 'description', l.description,
             'qty_ordered', l.qty_ordered, 'qty_received', l.qty_received,
             'unit_cost', l.unit_cost, 'discount_pct', l.discount_pct, 'tax_pct', l.tax_pct)
             ORDER BY l.line_no) AS items,
           sum(l.qty_ordered * l.unit_cost) AS sub,
           sum(l.qty_ordered * l.unit_cost * l.discount_pct / 100) AS dis,
           sum((l.qty_ordered * l.unit_cost - l.qty_ordered * l.unit_cost * l.discount_pct / 100) * l.tax_pct / 100) AS tax
      FROM public.vendor_invoice_lines l GROUP BY l.vendor_invoice_id)
  UPDATE public.vendor_invoices i SET
    line_items = r.items, subtotal = round(r.sub, 2), discount_amount = round(r.dis, 2),
    tax_amount = round(r.tax, 2), total = round(r.sub - r.dis + r.tax, 2)
  FROM r
  WHERE i.id = r.id AND i.status = 'draft'
    AND (i.line_items IS DISTINCT FROM r.items OR i.total IS DISTINCT FROM round(r.sub - r.dis + r.tax, 2));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'draft vendor invoices synced from their rows: %', v_n;
END $$;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.create_vendor_invoice(uuid, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.update_vendor_invoice(uuid, jsonb, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.convert_po_to_vendor_invoice(uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.receive_vendor_invoice(uuid, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._vendor_invoice_write_lines(uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._vendor_invoice_check_fields(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._vendor_invoice_assert_supplier_no(public.vendor_invoices)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing to finish: a vendor-invoice function is executable by the wrong role';
  END IF;
  IF has_table_privilege('anon', 'public.vendor_invoice_lines', 'SELECT')
     OR has_table_privilege('authenticated', 'public.vendor_invoice_lines', 'INSERT')
     OR has_table_privilege('authenticated', 'public.vendor_invoices', 'INSERT') THEN
    RAISE EXCEPTION 'Refusing to finish: a client can still write vendor-invoice lines or invoices directly';
  END IF;
END $$;
