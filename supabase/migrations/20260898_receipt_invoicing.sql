-- ============================================================================
-- 20260898_receipt_invoicing.sql
-- P-03b — invoice what was received, and re-cost it from the supplier's
-- invoice. Owner decisions (2026-09-25, docs/P03_GOODS_RECEIPTS.md): a
-- supplier invoice from a receipt-based order bills ONLY what was received
-- (three-way match: order → receipt → invoice), and approving it re-costs the
-- stock still on hand, reporting a variance on what was already sold.
-- ============================================================================
--   1. vendor_invoice_receipt_lines ties each invoice line to the receipt line
--      it bills — one receipt line to one live invoice line. (Replaces
--      goods_receipt_lines.qty_invoiced from 20260897, which nothing set: a
--      receipt line is billed whole, by the invoice that links it, so the
--      link is the fact and a counter would only drift from it.)
--   2. create_vendor_invoice_from_receipts(po, receipts?, actor): a draft
--      supplier invoice for the confirmed receipts not yet billed (all, or the
--      ones named) — one invoice line per receipt line, at the order's price.
--      convert_po_to_vendor_invoice refuses a receipt-based order.
--   3. update_vendor_invoice keeps such an invoice's products and quantities
--      equal to its receipts; prices, discounts, taxes and freight may change
--      to what the supplier actually billed.
--   4. On approval, rma_recost_from_vendor_invoice sets each receipt line's
--      cost to the invoice's landed unit cost: units / bin quantity still on
--      hand take it; what already left is recorded as a price variance.
--      Every change is a row in purchase_cost_adjustments.
--   5. (review) Once approved, an invoice from receipts is fixed: its charges
--      cannot change and it cannot be cancelled. A restore (rma.audit_suspended)
--      is exempt from both and is never re-costed a second time.
--
-- Pinned by src/test/receiptInvoicing.test.js; supabase/tests/receipt_invoicing.sql
-- is the rolled-back reference script.
-- ============================================================================

-- ── 1. the link, and the adjustment record ───────────────────────────────────
ALTER TABLE public.goods_receipt_lines DROP COLUMN IF EXISTS qty_invoiced;

CREATE TABLE IF NOT EXISTS public.vendor_invoice_receipt_lines (
  vendor_invoice_id      uuid NOT NULL REFERENCES public.vendor_invoices(id) ON DELETE CASCADE,
  line_no                integer NOT NULL,                 -- = vendor_invoice_lines.line_no
  goods_receipt_line_id  uuid NOT NULL REFERENCES public.goods_receipt_lines(id),
  PRIMARY KEY (vendor_invoice_id, line_no)
);
CREATE INDEX IF NOT EXISTS vendor_invoice_receipt_lines_grl_idx ON public.vendor_invoice_receipt_lines (goods_receipt_line_id);

CREATE TABLE IF NOT EXISTS public.purchase_cost_adjustments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_invoice_id      uuid NOT NULL REFERENCES public.vendor_invoices(id),
  goods_receipt_line_id  uuid NOT NULL REFERENCES public.goods_receipt_lines(id),
  product_id             uuid REFERENCES public.products(id),
  kind                   text NOT NULL CHECK (kind IN ('revalued', 'variance')),
  qty                    integer NOT NULL CHECK (qty >= 1),
  old_unit_cost_base     numeric(14,4),                    -- NULL = was unknown
  new_unit_cost_base     numeric(14,4) NOT NULL,
  amount_base            numeric(14,4),                    -- qty x (new - old); NULL when old was unknown
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_cost_adjustments_vi_idx ON public.purchase_cost_adjustments (vendor_invoice_id);
COMMENT ON TABLE public.purchase_cost_adjustments IS
  'P-03b: when an approved supplier invoice prices received goods differently from the order: ''revalued'' = stock still on hand took the new cost; ''variance'' = the goods had already left, so the difference is a price variance. Written only by rma_recost_from_vendor_invoice.';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendor_invoice_receipt_lines', 'purchase_cost_adjustments'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;
DROP POLICY IF EXISTS "read_vendor_invoice_receipt_lines" ON public.vendor_invoice_receipt_lines;
CREATE POLICY "read_vendor_invoice_receipt_lines" ON public.vendor_invoice_receipt_lines FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.vendor_invoices vi WHERE vi.id = vendor_invoice_receipt_lines.vendor_invoice_id));
-- cost is for managers and accountants
DROP POLICY IF EXISTS "read_purchase_cost_adjustments" ON public.purchase_cost_adjustments;
CREATE POLICY "read_purchase_cost_adjustments" ON public.purchase_cost_adjustments FOR SELECT
  USING (COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = 'accountant', false));

-- A receipt line billed by a live (not cancelled) invoice line, or NULL.
CREATE OR REPLACE FUNCTION public.rma_grn_line_billed_by(p_grl_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $function$
  SELECT k.vendor_invoice_id
    FROM public.vendor_invoice_receipt_lines k
    JOIN public.vendor_invoices vi ON vi.id = k.vendor_invoice_id
   WHERE k.goods_receipt_line_id = p_grl_id AND vi.status <> 'cancelled'
   LIMIT 1
$function$;
REVOKE ALL ON FUNCTION public.rma_grn_line_billed_by(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_grn_line_billed_by(uuid) TO authenticated, service_role;

-- ── 2. create_vendor_invoice_from_receipts ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_vendor_invoice_from_receipts(p_po_id uuid, p_receipt_ids uuid[], p_actor_email text)
RETURNS public.vendor_invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_actor text := public.rma_current_user_email();
  v_po    public.purchase_orders;
  v_id    uuid := gen_random_uuid();
  v_src   jsonb;
  v_links uuid[];
  v_t     record;
  v_row   public.vendor_invoices;
  i       integer;
BEGIN
  IF v_actor IS NULL OR NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
    RAISE EXCEPTION 'Not authorized to raise a vendor invoice' USING ERRCODE = 'P0001';
  END IF;

  -- the order first: two clicks cannot both bill the same receipt lines
  SELECT * INTO v_po FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order % not found', p_po_id USING ERRCODE = 'P0001';
  END IF;
  IF p_receipt_ids IS NOT NULL AND EXISTS (
       SELECT 1 FROM unnest(p_receipt_ids) r(id)
        WHERE NOT EXISTS (SELECT 1 FROM public.goods_receipts g
                           WHERE g.id = r.id AND g.purchase_order_id = p_po_id AND g.status = 'confirmed')) THEN
    RAISE EXCEPTION 'Only confirmed receipts of this order can be invoiced' USING ERRCODE = 'P0001';
  END IF;

  -- confirmed receipt lines not yet billed, at the order line's price
  SELECT jsonb_agg(jsonb_build_object(
           'product_id', gl.product_id, 'product_name', gl.product_name, 'description', pol.description,
           'qty_ordered', gl.qty, 'qty_received', gl.qty,
           'unit_cost', pol.unit_cost, 'discount_pct', pol.discount_pct, 'tax_pct', pol.tax_pct)
           ORDER BY g.confirmed_at, g.id, gl.line_no),
         array_agg(gl.id ORDER BY g.confirmed_at, g.id, gl.line_no)
    INTO v_src, v_links
    FROM public.goods_receipt_lines gl
    JOIN public.goods_receipts g ON g.id = gl.goods_receipt_id
    JOIN public.purchase_order_lines pol ON pol.id = gl.purchase_order_line_id
   WHERE g.purchase_order_id = p_po_id AND g.status = 'confirmed'
     AND (p_receipt_ids IS NULL OR g.id = ANY (p_receipt_ids))
     AND public.rma_grn_line_billed_by(gl.id) IS NULL;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'Nothing received on this order is waiting to be invoiced' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.vendor_invoices
    (id, purchase_order_id, vendor_id, status, line_items, currency, exchange_rate, notes, created_by)
  VALUES (v_id, p_po_id, v_po.vendor_id, 'draft', '[]'::jsonb, v_po.currency, v_po.exchange_rate, v_po.notes, v_actor);

  SELECT * INTO v_t FROM public._vendor_invoice_write_lines(v_id, v_src);
  FOR i IN 1 .. cardinality(v_links) LOOP
    INSERT INTO public.vendor_invoice_receipt_lines (vendor_invoice_id, line_no, goods_receipt_line_id)
    VALUES (v_id, i - 1, v_links[i]);
  END LOOP;

  UPDATE public.vendor_invoices SET
    line_items = v_t.line_items, subtotal = v_t.subtotal, discount_amount = v_t.discount_amount,
    tax_amount = v_t.tax_amount, total = v_t.total
  WHERE id = v_id
  RETURNING * INTO v_row;
  RETURN v_row;
END
$fn$;
REVOKE ALL ON FUNCTION public.create_vendor_invoice_from_receipts(uuid, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_vendor_invoice_from_receipts(uuid, uuid[], text) TO authenticated, service_role;

-- a receipt-based order is invoiced from its receipts, never whole; checked
-- before the status check, so a completed order hears the right reason
DO $$
DECLARE
  v_def  text;
  v_old  text := E'  IF v_po.status NOT IN (''confirmed'', ''partially_completed'') THEN\n    RAISE EXCEPTION ''A vendor invoice is raised from a confirmed purchase order';
  v_ins  text := E'  -- 20260898: goods on this order arrive by receipts; bill what arrived\n'
              || E'  IF EXISTS (SELECT 1 FROM public.goods_receipts WHERE purchase_order_id = p_po_id AND status <> ''cancelled'') THEN\n'
              || E'    RAISE EXCEPTION ''This order is received by goods receipts; invoice it from its receipts'' USING ERRCODE = ''P0001'';\n'
              || E'  END IF;\n';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.convert_po_to_vendor_invoice'::regproc), E'\r\n', E'\n') INTO v_def;
  v_def := replace(v_def, v_ins, '');   -- an earlier placement of this check, if any
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: convert_po_to_vendor_invoice holds its status check % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_ins || v_old);
END $$;

-- ── 3. an invoice from receipts bills what arrived ───────────────────────────
DO $$
DECLARE
  v_def  text;
  v_old  text := E'      FROM public._vendor_invoice_write_lines(p_id, p_lines) w;\n';
  v_have integer;
BEGIN
  SELECT replace(pg_get_functiondef('public.update_vendor_invoice'::regproc), E'\r\n', E'\n') INTO v_def;
  IF v_def LIKE '%its products and quantities are those of the receipts%' THEN
    RETURN;
  END IF;
  v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_have <> 1 THEN
    RAISE EXCEPTION 'Refusing to apply: update_vendor_invoice rewrites its lines % time(s), expected 1', v_have;
  END IF;
  EXECUTE replace(v_def, v_old, v_old
    || E'    -- 20260898: an invoice raised from receipts bills what arrived (three-way match)\n'
    || E'    IF EXISTS (SELECT 1 FROM public.vendor_invoice_receipt_lines WHERE vendor_invoice_id = p_id)\n'
    || E'       AND ((SELECT count(*) FROM public.vendor_invoice_lines WHERE vendor_invoice_id = p_id)\n'
    || E'              <> (SELECT count(*) FROM public.vendor_invoice_receipt_lines WHERE vendor_invoice_id = p_id)\n'
    || E'            OR EXISTS (SELECT 1 FROM public.vendor_invoice_receipt_lines k\n'
    || E'                         JOIN public.goods_receipt_lines g ON g.id = k.goods_receipt_line_id\n'
    || E'                         LEFT JOIN public.vendor_invoice_lines l ON l.vendor_invoice_id = p_id AND l.line_no = k.line_no\n'
    || E'                        WHERE k.vendor_invoice_id = p_id\n'
    || E'                          AND (l.id IS NULL OR l.product_id IS DISTINCT FROM g.product_id OR l.qty_ordered <> g.qty))) THEN\n'
    || E'      RAISE EXCEPTION ''This invoice bills goods that arrived: its products and quantities are those of the receipts. Prices, discounts and taxes can change.'' USING ERRCODE = ''P0001'';\n'
    || E'    END IF;\n');
END $$;

-- ── 4. approval re-costs what arrived ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_recost_from_vendor_invoice(p_vi_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_actor   text := public.rma_current_user_email();
  v_k       record;
  v_new     numeric;
  v_old     numeric;
  v_u       record;
  v_b       record;
  v_ws      public.warehouse_stock;
  v_n       integer;
  v_on      integer;
  v_on_old  numeric;
  v_off     integer;
  v_off_amt numeric;
  v_off_unk boolean;
  v_on_amt  numeric;
  v_on_unk  boolean;
  v_want    numeric;
  v_apply   numeric;
  v_clip    integer;
  v_seen    jsonb := '{}';   -- bin -> units already revalued in this call
BEGIN
  FOR v_k IN
    SELECT k.line_no, g.id AS grl_id, g.product_id, g.unit_cost_base
      FROM public.vendor_invoice_receipt_lines k
      JOIN public.goods_receipt_lines g ON g.id = k.goods_receipt_line_id
     WHERE k.vendor_invoice_id = p_vi_id
     ORDER BY k.line_no
     FOR UPDATE OF g
  LOOP
    SELECT c.unit_cost_base INTO v_new FROM public.rma_vi_landed_unit_costs(p_vi_id) c WHERE c.line_index = v_k.line_no;
    -- an unpriced invoice line tells us nothing new; the booked cost stands
    CONTINUE WHEN v_new IS NULL;
    v_old := v_k.unit_cost_base;
    CONTINUE WHEN v_old IS NOT NULL AND v_old = v_new;

    -- serialized: each unit that arrived on this line
    v_on := 0; v_on_old := 0; v_off := 0; v_off_amt := 0; v_off_unk := false;
    v_on_amt := 0; v_on_unk := false; v_clip := 0;
    FOR v_u IN
      SELECT u.id, u.status, u.reservation_status, u.unit_cost_base
        FROM public.goods_receipt_line_units x
        JOIN public.inventory_units u ON u.id = x.unit_id
       WHERE x.goods_receipt_line_id = v_k.grl_id
       FOR UPDATE OF u
    LOOP
      IF v_u.status = 'company_stock' AND v_u.reservation_status IN ('available', 'reserved') THEN
        UPDATE public.inventory_units SET unit_cost_base = v_new WHERE id = v_u.id;
        v_on := v_on + 1;
        IF v_u.unit_cost_base IS NULL THEN v_on_unk := true;
        ELSE v_on_amt := v_on_amt + (v_new - v_u.unit_cost_base); END IF;
      ELSE
        v_off := v_off + 1;
        IF v_u.unit_cost_base IS NULL THEN v_off_unk := true;
        ELSE v_off_amt := v_off_amt + (v_new - v_u.unit_cost_base); END IF;
      END IF;
    END LOOP;

    -- bulk: the bins it filled. A bin is pooled at weighted average, so what
    -- is still on hand of this receipt is read as min(received, in the bin).
    FOR v_b IN
      SELECT x.warehouse_stock_id, x.qty FROM public.goods_receipt_line_bins x WHERE x.goods_receipt_line_id = v_k.grl_id
    LOOP
      SELECT * INTO v_ws FROM public.warehouse_stock WHERE id = v_b.warehouse_stock_id FOR UPDATE;
      IF v_old IS NULL THEN
        -- booked as unknown: that many of the bin's unknown units become known
        v_n := LEAST(v_b.qty, v_ws.uncosted_quantity);
        IF v_n > 0 THEN
          UPDATE public.warehouse_stock
             SET total_cost_base = total_cost_base + round(v_new * v_n, 4),
                 uncosted_quantity = uncosted_quantity - v_n, updated_at = now()
           WHERE id = v_ws.id;
        END IF;
      ELSE
        -- costed units of this bin not already revalued by an earlier receipt
        -- line in this call: two lines into one bin must not claim the same
        -- units (review)
        v_n := GREATEST(0, LEAST(v_b.qty,
                 v_ws.quantity - v_ws.uncosted_quantity - COALESCE((v_seen ->> v_ws.id::text)::integer, 0)));
        IF v_n > 0 THEN
          v_want  := round((v_new - v_old) * v_n, 4);
          -- a bin pooled with cheaper stock cannot fall below 0: apply what it
          -- can hold, and report the rest as variance — never clip it silently.
          -- Such units appear in both rows, each with its own part of the amount.
          v_apply := GREATEST(v_want, -v_ws.total_cost_base);
          UPDATE public.warehouse_stock
             SET total_cost_base = total_cost_base + v_apply, updated_at = now()
           WHERE id = v_ws.id;
          v_on_amt := v_on_amt + v_apply;
          IF v_apply <> v_want THEN
            v_off_amt := v_off_amt + (v_want - v_apply);
            v_clip := v_clip + v_n;
          END IF;
          v_seen := jsonb_set(v_seen, ARRAY[v_ws.id::text],
                              to_jsonb(COALESCE((v_seen ->> v_ws.id::text)::integer, 0) + v_n));
        END IF;
      END IF;
      v_n := GREATEST(v_n, 0);
      v_on := v_on + v_n;
      v_off := v_off + (v_b.qty - v_n);
      IF v_old IS NULL THEN
        IF v_b.qty - v_n > 0 THEN v_off_unk := true; END IF;
      ELSE
        v_off_amt := v_off_amt + (v_b.qty - v_n) * (v_new - v_old);
      END IF;
    END LOOP;

    -- amounts are what was actually applied / left over, not qty x difference
    IF v_on > 0 THEN
      INSERT INTO public.purchase_cost_adjustments
        (vendor_invoice_id, goods_receipt_line_id, product_id, kind, qty, old_unit_cost_base, new_unit_cost_base, amount_base, created_by)
      VALUES (p_vi_id, v_k.grl_id, v_k.product_id, 'revalued', v_on, v_old, v_new,
              CASE WHEN v_old IS NULL OR v_on_unk THEN NULL ELSE round(v_on_amt, 4) END, v_actor);
    END IF;
    -- goods already gone, plus any revaluation a bin could not absorb
    IF v_off + v_clip > 0 THEN
      INSERT INTO public.purchase_cost_adjustments
        (vendor_invoice_id, goods_receipt_line_id, product_id, kind, qty, old_unit_cost_base, new_unit_cost_base, amount_base, created_by)
      VALUES (p_vi_id, v_k.grl_id, v_k.product_id, 'variance', v_off + v_clip, v_old, v_new,
              CASE WHEN v_off_unk THEN NULL ELSE round(v_off_amt, 4) END, v_actor);
    END IF;

    UPDATE public.goods_receipt_lines SET unit_cost_base = v_new WHERE id = v_k.grl_id;
  END LOOP;
END
$fn$;
REVOKE ALL ON FUNCTION public.rma_recost_from_vendor_invoice(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rma_recost_from_vendor_invoice(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.rma_vendor_invoice_recost_on_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  -- a restore writes rows back as they were, adjustments included; re-costing
  -- here would add duplicate ones (review). rma_restore_apply sets this flag.
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved'
     AND EXISTS (SELECT 1 FROM public.vendor_invoice_receipt_lines WHERE vendor_invoice_id = NEW.id) THEN
    PERFORM public.rma_recost_from_vendor_invoice(NEW.id);
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.rma_vendor_invoice_recost_on_approval() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_vendor_invoices_recost_on_approval ON public.vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_recost_on_approval
  AFTER UPDATE OF status ON public.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_vendor_invoice_recost_on_approval();

-- ── 4b. once its costs are booked, an invoice from receipts is fixed ─────────
-- (review) A receipt-based invoice stays 'approved' for good, and the charges
-- guard (20260794) only locked freight once an invoice was received — so freight
-- edited after approval changed nothing in stock and was recorded nowhere. Its
-- charges are now fixed from approval on. The same guard now stands aside for a
-- restore, which writes charges back onto invoices that are already received.
CREATE OR REPLACE FUNCTION public.rma_guard_charges_before_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
  v_vi     uuid := COALESCE(NEW.vendor_invoice_id, OLD.vendor_invoice_id);
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN   -- a restore (20260898)
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT status INTO v_status FROM public.vendor_invoices WHERE id = v_vi;

  IF v_status IN ('partially_received', 'received') THEN
    RAISE EXCEPTION
      'This invoice has already been received, so its landed cost is fixed. Changing charges now would not update the cost of the goods already in stock.'
      USING ERRCODE = 'P0001';
  END IF;

  -- 20260898: an invoice for goods that arrived by receipts books its cost at
  -- approval
  IF v_status NOT IN ('draft', 'pending_approval', 'cancelled')
     AND EXISTS (SELECT 1 FROM public.vendor_invoice_receipt_lines WHERE vendor_invoice_id = v_vi) THEN
    RAISE EXCEPTION
      'This invoice is approved and the cost of its goods is booked; its charges can no longer change.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$function$;

-- (review) Cancelling an approved invoice from receipts freed its receipt lines
-- but left the stock at its price and its adjustments standing, with nothing
-- owed. It is refused: the cost it booked is part of the stock now.
CREATE OR REPLACE FUNCTION public.rma_guard_receipt_invoice_cancel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'cancelled' AND OLD.status NOT IN ('draft', 'pending_approval', 'cancelled')
     AND EXISTS (SELECT 1 FROM public.vendor_invoice_receipt_lines WHERE vendor_invoice_id = NEW.id) THEN
    RAISE EXCEPTION 'This invoice is approved and the cost of its goods is booked, so it cannot be cancelled. Correct a price with a supplier credit note.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS trg_vendor_invoices_receipt_cancel ON public.vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_receipt_cancel
  BEFORE UPDATE OF status ON public.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_receipt_invoice_cancel();

-- ── 5. Backup & Restore knows the two new tables ─────────────────────────────
-- The manifest is the restorable BACKUP_TABLES in order (20260897;
-- src/test/restoreManifest.test.js keeps them in step).
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
    'delivery_lines', 'delivery_line_units', 'delivery_line_bins', 'crm_invoices',
    'crm_invoice_lines', 'invoices', 'payments', 'payment_applications', 'credit_notes',
    'credit_note_lines', 'credit_note_applications', 'activities', 'notifications',
    'user_activity_log'
  ]::text[]
$function$;

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.create_vendor_invoice_from_receipts(uuid, uuid[], text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rma_recost_from_vendor_invoice(uuid)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.vendor_invoice_receipt_lines', 'INSERT')
     OR has_table_privilege('authenticated', 'public.purchase_cost_adjustments', 'INSERT') THEN
    RAISE EXCEPTION 'Refusing to finish: receipt invoicing is reachable outside its functions';
  END IF;
  IF pg_get_functiondef('public.convert_po_to_vendor_invoice'::regproc) NOT LIKE '%invoice it from its receipts%'
     OR pg_get_functiondef('public.update_vendor_invoice'::regproc) NOT LIKE '%its products and quantities are those of the receipts%' THEN
    RAISE EXCEPTION 'Refusing to finish: convert_po_to_vendor_invoice or update_vendor_invoice was not updated';
  END IF;
END $$;
