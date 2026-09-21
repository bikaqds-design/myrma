-- ============================================================================
-- 20260881_supplier_invoice_po_amendment.sql — BL-10 / I-06
--
-- SUPPLIER INVOICE IDENTITY
--   A vendor invoice recorded OUR code (VI-...) and nothing of the supplier's
--   own invoice number, so the same bill could be entered twice, approved twice
--   and paid twice, and nothing could say so. Now:
--     * vendor_invoices.supplier_invoice_no (+ supplier_invoice_date), required
--       before a draft can be submitted for approval;
--     * a unique index per supplier on the number, ignoring case and spaces,
--       within the invoice's year (suppliers restart their numbering) and
--       ignoring cancelled invoices, so a cancelled one frees its number;
--     * a friendly refusal that names the invoice already on file, ahead of the
--       index's bare "duplicate key";
--     * a near-duplicate rule: same supplier and currency, an amount within 1%
--       and a date within 30 days of another live invoice (under a different
--       number: the way a bill is entered twice on purpose or by accident) needs
--       a written reason (10+ characters, kept in duplicate_override_reason)
--       before it can be submitted.
--
-- WHO APPROVES
--   A vendor invoice with no purchase order behind it is spend nobody ordered.
--   It now needs a reason (non_po_reason) to be submitted and an administrator
--   OTHER than the person who entered it to approve it. The approver is recorded
--   from the login (approved_by) and cannot be rewritten by a client.
--
-- CREATING PAST THE APPROVAL
--   A manager could INSERT a vendor invoice already 'approved', or a purchase
--   order already 'confirmed', skipping the administrator entirely (the
--   approval-authority trigger only looks at UPDATE) and then receive stock
--   against it. A client-created vendor invoice or purchase order is now always
--   a draft. Backup & Restore is an RPC and is unaffected.
--
-- PURCHASE-ORDER AMENDMENT
--   A confirmed order is locked (I-01, PR #45) and its refusal message tells
--   people to "use the amend action", which did not exist. amend_purchase_order
--   is that action. It changes only lines, terms, delivery date and notes (never
--   the supplier, currency or status), needs a manager and a written reason,
--   refuses if a live vendor invoice already sits against the order, snapshots
--   the order as it stood into purchase_order_revisions, recomputes every total
--   from the lines (the caller's totals are ignored: a small "total" sent with
--   large lines must not slip past the value test), bumps revision_no, and
--   returns the order to 'pending_confirmation' for an administrator when the
--   value goes up or any price, discount or tax changes. A quantity cut at the
--   same prices, or a change of terms, keeps it confirmed. The
--   confirmed -> pending_confirmation step is allowed only inside that RPC
--   (a transaction-local flag); set by a client it would unlock editing.
--
-- NOT DONE HERE: the supplier's invoice attachment (needs storage), a duplicate
-- exception report, and the dependency on I-01: without PR #45 a confirmed PO
-- can still be edited directly, and this amendment is then the audited route
-- rather than the only one.
--
-- Idempotent. Not applied to production without the owner's OK.
-- ============================================================================

-- ── columns ─────────────────────────────────────────────────────────────────
ALTER TABLE public.vendor_invoices ADD COLUMN IF NOT EXISTS supplier_invoice_no text;
ALTER TABLE public.vendor_invoices ADD COLUMN IF NOT EXISTS supplier_invoice_date date;
ALTER TABLE public.vendor_invoices ADD COLUMN IF NOT EXISTS non_po_reason text;
ALTER TABLE public.vendor_invoices ADD COLUMN IF NOT EXISTS duplicate_override_reason text;
ALTER TABLE public.vendor_invoices ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS revision_no integer NOT NULL DEFAULT 1;

-- The number with case, spaces (including non-breaking and zero-width ones that
-- come with a paste from a PDF or e-mail) removed, so INV 001 and inv001 match.
CREATE OR REPLACE FUNCTION public.rma_norm_supplier_no(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT lower(regexp_replace(p, '[[:space:]\u00a0\u200b\u200c\u200d\ufeff]', '', 'g'))
$function$;
REVOKE ALL ON FUNCTION public.rma_norm_supplier_no(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_norm_supplier_no(text) TO authenticated, service_role;

-- One supplier number per supplier per year, live invoices only. The year is the
-- year the invoice was ENTERED, never the supplier's invoice date: a date the
-- client types could otherwise be changed to slip the same bill past the check.
DROP INDEX IF EXISTS public.vendor_invoices_supplier_no_uniq;
CREATE UNIQUE INDEX vendor_invoices_supplier_no_uniq
  ON public.vendor_invoices (
    vendor_id,
    public.rma_norm_supplier_no(supplier_invoice_no),
    ((EXTRACT(YEAR FROM (created_at AT TIME ZONE 'UTC')))::integer)
  )
  WHERE supplier_invoice_no IS NOT NULL AND status <> 'cancelled';

-- ── the vendor-invoice identity and approval guard ──────────────────────────
CREATE OR REPLACE FUNCTION public.rma_guard_vendor_invoice_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_key      text;
  v_year     integer;
  v_dup      record;
  v_near     record;
  v_approver text;
BEGIN
  -- Only the client surface. An RPC (receive_vendor_invoice, the payment RPCs)
  -- and Backup & Restore run as the owner.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Created past the administrator's approval it would be receivable at once.
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'A vendor invoice is created as a draft; it becomes approved when an administrator approves it.'
        USING ERRCODE = 'P0001';
    END IF;
    NEW.approved_by := NULL;
  ELSE
    -- Who raised it, when, and which supplier/order it belongs to cannot be
    -- rewritten in the same statement that approves it (that would defeat the
    -- rule below), nor once it has left draft.
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    IF OLD.status <> 'draft'
       AND (NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
            OR NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id
            OR NEW.currency IS DISTINCT FROM OLD.currency
            OR NEW.total IS DISTINCT FROM OLD.total
            OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
            OR NEW.line_items IS DISTINCT FROM OLD.line_items
            OR NEW.supplier_invoice_no IS DISTINCT FROM NULLIF(btrim(OLD.supplier_invoice_no), '')
            OR NEW.supplier_invoice_date IS DISTINCT FROM OLD.supplier_invoice_date) THEN
      RAISE EXCEPTION 'A vendor invoice that has been submitted cannot have its supplier, order, amounts, lines or supplier invoice number changed. Send it back to draft first.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  NEW.supplier_invoice_no        := NULLIF(btrim(NEW.supplier_invoice_no), '');
  NEW.non_po_reason              := NULLIF(btrim(NEW.non_po_reason), '');
  NEW.duplicate_override_reason  := NULLIF(btrim(NEW.duplicate_override_reason), '');

  -- The approver is whoever approved it, taken from the login. Any other write
  -- leaves it as it was.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'pending_approval' AND NEW.status = 'approved' THEN
      v_approver := public.rma_current_user_email();
      NEW.approved_by := v_approver;
      IF v_approver IS NULL THEN
        RAISE EXCEPTION 'Your login has no email, so the approval cannot be attributed.'
          USING ERRCODE = 'P0001';
      END IF;
      IF NEW.purchase_order_id IS NULL AND COALESCE(lower(v_approver) = lower(NEW.created_by), true) THEN
        RAISE EXCEPTION 'The person who entered a vendor invoice with no purchase order cannot approve it. Ask another administrator.'
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      NEW.approved_by := OLD.approved_by;
    END IF;
  END IF;

  -- The same supplier number twice: name the one already on file.
  IF NEW.supplier_invoice_no IS NOT NULL AND NEW.status <> 'cancelled' THEN
    v_key  := public.rma_norm_supplier_no(NEW.supplier_invoice_no);
    v_year := EXTRACT(YEAR FROM (COALESCE(NEW.created_at, now()) AT TIME ZONE 'UTC'))::integer;
    SELECT o.id, o.vi_code, o.supplier_invoice_no INTO v_dup
      FROM public.vendor_invoices o
     WHERE o.vendor_id = NEW.vendor_id
       AND o.id <> NEW.id
       AND o.status <> 'cancelled'
       AND o.supplier_invoice_no IS NOT NULL
       AND public.rma_norm_supplier_no(o.supplier_invoice_no) = v_key
       AND EXTRACT(YEAR FROM (o.created_at AT TIME ZONE 'UTC'))::integer = v_year
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Supplier invoice % has already been entered for this supplier (%). Cancel the earlier one first if it was a mistake.',
        NEW.supplier_invoice_no, COALESCE(v_dup.vi_code, 'a draft')
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Submitting for approval is the gate.
  IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'pending_approval' THEN
    IF NEW.supplier_invoice_no IS NULL THEN
      RAISE EXCEPTION 'Enter the supplier''s own invoice number before submitting this vendor invoice for approval.'
        USING ERRCODE = 'P0001';
    END IF;

    IF NEW.purchase_order_id IS NULL AND length(COALESCE(NEW.non_po_reason, '')) < 10 THEN
      RAISE EXCEPTION 'This vendor invoice has no purchase order. Say why (at least 10 characters) before submitting it.'
        USING ERRCODE = 'P0001';
    END IF;

    -- A different number, but the same bill: same supplier and currency, an
    -- amount within 1% and a date within 30 days of another live invoice.
    IF NEW.total > 0 THEN
      SELECT o.vi_code, o.supplier_invoice_no INTO v_near
        FROM public.vendor_invoices o
       WHERE o.vendor_id = NEW.vendor_id
         AND o.id <> NEW.id
         AND o.status <> 'cancelled'
         AND o.currency = NEW.currency
         AND abs(o.total - NEW.total) <= NEW.total * 0.01
         AND abs(COALESCE(o.supplier_invoice_date, (o.created_at AT TIME ZONE 'UTC')::date)
               - COALESCE(NEW.supplier_invoice_date, (now() AT TIME ZONE 'UTC')::date)) <= 30
       LIMIT 1;
      IF FOUND AND length(COALESCE(NEW.duplicate_override_reason, '')) < 10 THEN
        RAISE EXCEPTION 'This looks like a duplicate of % (supplier invoice %): same supplier, an amount within 1%% and within 30 days. If it is a separate bill, say why (at least 10 characters) and submit again.',
          COALESCE(v_near.vi_code, 'another invoice'), v_near.supplier_invoice_no
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.rma_guard_vendor_invoice_identity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_guard_vendor_invoice_identity() TO service_role;

DROP TRIGGER IF EXISTS trg_vendor_invoices_identity ON public.vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_identity
  BEFORE INSERT OR UPDATE ON public.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_vendor_invoice_identity();

-- ── a purchase order is created as a draft, and its revision is not editable ─
CREATE OR REPLACE FUNCTION public.rma_guard_purchase_order_client_writes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'A purchase order is created as a draft; it is confirmed by an administrator.'
        USING ERRCODE = 'P0001';
    END IF;
    NEW.revision_no := 1;
  ELSE
    NEW.revision_no := OLD.revision_no;      -- moved only by amend_purchase_order
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.rma_guard_purchase_order_client_writes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_guard_purchase_order_client_writes() TO service_role;

DROP TRIGGER IF EXISTS trg_purchase_orders_client_writes ON public.purchase_orders;
CREATE TRIGGER trg_purchase_orders_client_writes
  BEFORE INSERT OR UPDATE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_purchase_order_client_writes();

-- ── revisions ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.purchase_order_revisions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id      uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  rev_no     integer NOT NULL,
  snapshot   jsonb NOT NULL,
  reason     text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (po_id, rev_no)
);

ALTER TABLE public.purchase_order_revisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS manager_read_po_revisions ON public.purchase_order_revisions;
CREATE POLICY manager_read_po_revisions ON public.purchase_order_revisions
  FOR SELECT USING (public.rma_is_manager_or_above() OR public.rma_user_role() = 'accountant');

-- Written only by amend_purchase_order.
REVOKE ALL ON TABLE public.purchase_order_revisions FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.purchase_order_revisions FROM authenticated;
GRANT SELECT ON TABLE public.purchase_order_revisions TO authenticated;
GRANT ALL ON TABLE public.purchase_order_revisions TO service_role;

-- ── the status guard: confirmed -> pending_confirmation only inside the RPC ──
CREATE OR REPLACE FUNCTION public.assert_purchase_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_allowed text[];
BEGIN
  -- Only interested in an actual change. The document forms send the whole row
  -- back on every save, so same-value writes are routine and must pass through.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'purchase_orders' THEN
    v_allowed := CASE OLD.status
      -- Send for approval, or abandon before anyone has looked at it.
      WHEN 'draft'                THEN ARRAY['sent', 'pending_confirmation', 'cancelled']
      -- Awaiting a manager: approve, reject back to draft, or let it lapse.
      WHEN 'sent'                 THEN ARRAY['pending_confirmation', 'confirmed', 'draft', 'cancelled', 'expired']
      WHEN 'pending_confirmation' THEN ARRAY['confirmed', 'draft', 'cancelled', 'expired']
      -- Approved. Completion states are written only by receive_vendor_invoice.
      WHEN 'confirmed'            THEN ARRAY['partially_completed', 'completed', 'cancelled', 'expired']
      -- Part-delivered. Cancelling is refused from here: stock has arrived.
      WHEN 'partially_completed'  THEN ARRAY['completed']
      -- Terminal.
      WHEN 'completed'            THEN ARRAY[]::text[]
      WHEN 'cancelled'            THEN ARRAY[]::text[]
      -- Lapsed rather than refused, so it may be revived or closed off.
      WHEN 'expired'              THEN ARRAY['draft', 'cancelled']
      ELSE ARRAY[]::text[]
    END;
    -- Reopening a confirmed order unlocks its lines for editing, so it is the
    -- amend_purchase_order RPC's alone: it sets this flag for its own
    -- transaction (a client cannot; the flag is set from inside the database).
    IF OLD.status = 'confirmed' AND current_setting('rma.po_amend', true) = 'on' THEN
      v_allowed := array_append(v_allowed, 'pending_confirmation'::text);
    END IF;
  ELSE
    v_allowed := CASE OLD.status
      WHEN 'draft'              THEN ARRAY['pending_approval', 'cancelled']
      WHEN 'pending_approval'   THEN ARRAY['approved', 'draft', 'cancelled']
      -- Approved but nothing received yet, so cancelling is still safe.
      -- Not back to 'draft': that would reopen the line items for editing
      -- without a second approval.
      WHEN 'approved'           THEN ARRAY['partially_received', 'received', 'cancelled']
      -- Stock has arrived. Forward to fully received only.
      WHEN 'partially_received' THEN ARRAY['received']
      WHEN 'received'           THEN ARRAY[]::text[]
      WHEN 'cancelled'          THEN ARRAY[]::text[]
      ELSE ARRAY[]::text[]
    END;
  END IF;

  IF NOT (NEW.status = ANY (v_allowed)) THEN
    RAISE EXCEPTION
      'Illegal % status change: % -> %. Allowed from "%": %.',
      replace(TG_TABLE_NAME, '_', ' '),
      OLD.status,
      NEW.status,
      OLD.status,
      CASE WHEN array_length(v_allowed, 1) IS NULL
           THEN 'nothing (terminal state)'
           ELSE array_to_string(v_allowed, ', ')
      END
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;

-- ── amend_purchase_order ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.amend_purchase_order(
  p_po_id uuid, p_changes jsonb, p_reason text, p_actor_email text)
 RETURNS purchase_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_po       record;
  v_actor    text := COALESCE(public.rma_current_user_email(), p_actor_email);
  v_reason   text := btrim(COALESCE(p_reason, ''));
  v_key      text;
  v_settable text[] := ARRAY['line_items', 'payment_terms', 'delivery_terms', 'shipping_address',
                             'billing_address', 'terms_conditions', 'expected_delivery_date', 'notes'];
  -- Sent by the forms but never trusted: they are recomputed from the lines.
  v_derived  text[] := ARRAY['subtotal', 'discount_amount', 'tax_amount', 'total'];
  v_lines    jsonb;
  v_line     record;
  v_qty      numeric;
  v_cost     numeric;
  v_disc     numeric;
  v_tax      numeric;
  v_base     numeric;
  v_sub      numeric := 0;
  v_dsum     numeric := 0;
  v_tsum     numeric := 0;
  v_new_sub  numeric;
  v_new_disc numeric;
  v_new_tax  numeric;
  v_new_total numeric;
  v_price_changed boolean := false;
  v_reapprove boolean := false;
  v_date     date;
  v_result   public.purchase_orders;
BEGIN
  IF NOT COALESCE(public.rma_is_manager_or_above(), false) THEN
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

  -- Lines: validate, and recompute every total from them with the same
  -- arithmetic the forms use (discount on the base, tax on the discounted amount).
  IF p_changes ? 'line_items' THEN
    v_lines := p_changes -> 'line_items';
    IF jsonb_typeof(v_lines) <> 'array' OR jsonb_array_length(v_lines) = 0 THEN
      RAISE EXCEPTION 'An order needs at least one line.' USING ERRCODE = 'P0001';
    END IF;
    FOR v_line IN SELECT n, l FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS t(l, n) LOOP
      IF jsonb_typeof(v_line.l) <> 'object' OR COALESCE(v_line.l ->> 'product_id', '') = '' THEN
        RAISE EXCEPTION 'Line % has no product.', v_line.n USING ERRCODE = 'P0001';
      END IF;
      IF COALESCE(v_line.l ->> 'qty_ordered', '') !~ '^[0-9]+(\.[0-9]+)?$' OR (v_line.l ->> 'qty_ordered')::numeric <= 0 THEN
        RAISE EXCEPTION 'Line % needs a quantity above zero.', v_line.n USING ERRCODE = 'P0001';
      END IF;
      IF COALESCE(v_line.l ->> 'unit_cost', '') !~ '^[0-9]+(\.[0-9]+)?$' THEN
        RAISE EXCEPTION 'Line % needs a unit cost of zero or more.', v_line.n USING ERRCODE = 'P0001';
      END IF;
      IF COALESCE(v_line.l ->> 'discount_pct', '0') !~ '^[0-9]+(\.[0-9]+)?$' OR COALESCE(v_line.l ->> 'tax_pct', '0') !~ '^[0-9]+(\.[0-9]+)?$'
         OR COALESCE((v_line.l ->> 'discount_pct')::numeric, 0) > 100 OR COALESCE((v_line.l ->> 'tax_pct')::numeric, 0) > 100 THEN
        RAISE EXCEPTION 'Line % has an invalid discount or tax percentage.', v_line.n USING ERRCODE = 'P0001';
      END IF;

      v_qty  := (v_line.l ->> 'qty_ordered')::numeric;
      v_cost := (v_line.l ->> 'unit_cost')::numeric;
      v_disc := COALESCE((v_line.l ->> 'discount_pct')::numeric, 0);
      v_tax  := COALESCE((v_line.l ->> 'tax_pct')::numeric, 0);
      v_base := v_qty * v_cost;
      v_sub  := v_sub + v_base;
      v_dsum := v_dsum + v_base * v_disc / 100;
      v_tsum := v_tsum + (v_base - v_base * v_disc / 100) * v_tax / 100;

      -- a price, discount or tax that the old order did not carry for this product
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_po.line_items) AS o(l)
         WHERE o.l ->> 'product_id' = v_line.l ->> 'product_id'
           AND COALESCE(o.l ->> 'unit_cost', '') ~ '^[0-9]+(\.[0-9]+)?$' AND (o.l ->> 'unit_cost')::numeric = v_cost
           AND COALESCE(NULLIF(o.l ->> 'discount_pct', '')::numeric, 0) = v_disc
           AND COALESCE(NULLIF(o.l ->> 'tax_pct', '')::numeric, 0) = v_tax
      ) THEN
        v_price_changed := true;
      END IF;
    END LOOP;

    v_new_sub   := round(v_sub, 2);
    v_new_disc  := round(v_dsum, 2);
    v_new_tax   := round(v_tsum, 2);
    v_new_total := round(v_sub - v_dsum + v_tsum, 2);
    v_reapprove := v_price_changed OR v_new_total > v_po.total;
  END IF;

  IF p_changes ? 'expected_delivery_date' THEN
    BEGIN
      v_date := NULLIF(p_changes ->> 'expected_delivery_date', '')::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'The expected delivery date is not a valid date.' USING ERRCODE = 'P0001';
    END;
  END IF;

  -- Snapshot the order as it stands, then apply. The flag lets exactly this
  -- statement reopen a confirmed order.
  INSERT INTO public.purchase_order_revisions (po_id, rev_no, snapshot, reason, created_by)
  VALUES (p_po_id, v_po.revision_no, to_jsonb(v_po), v_reason, COALESCE(v_actor, 'unknown'));

  PERFORM set_config('rma.po_amend', 'on', true);
  UPDATE public.purchase_orders
     SET line_items      = CASE WHEN p_changes ? 'line_items' THEN v_lines ELSE line_items END,
         subtotal        = CASE WHEN p_changes ? 'line_items' THEN v_new_sub   ELSE subtotal END,
         discount_amount = CASE WHEN p_changes ? 'line_items' THEN v_new_disc  ELSE discount_amount END,
         tax_amount      = CASE WHEN p_changes ? 'line_items' THEN v_new_tax   ELSE tax_amount END,
         total           = CASE WHEN p_changes ? 'line_items' THEN v_new_total ELSE total END,
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
