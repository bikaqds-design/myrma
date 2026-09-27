-- ============================================================================
-- 20260900_supplier_bill_match.sql
-- P-04 — match the purchase order, the goods received and the supplier's bill
-- before the bill is approved for payment.
-- ============================================================================
-- Already in place: a bill is paid only once approved (record_vendor_payment),
-- a repeated or near-duplicate supplier number needs a reason (20260881), a
-- bill with no order needs a reason and a second approver (20260881), and a bill
-- raised from goods receipts bills exactly the products and quantities that
-- arrived (20260898). What was missing:
--
--   * nothing compared a bill's prices with the order's, so a supplier could
--     bill above the agreed price and it was approved without anyone seeing it;
--   * a bill converted from a whole order (the older path) could be edited to
--     bill more than was ordered, or products that were never ordered.
--
--   1. rma_vendor_invoice_match(vi): one row per bill line — ordered, received,
--      billed, the order's net unit price and the billed one, and an issue:
--      'over_billed' (more than ordered, or than received for a bill from
--      receipts), 'price_above' (billed net price above the order's by more
--      than the tenant's tolerance), 'not_on_order'. Net = unit cost less the
--      line discount; tax is not compared (it follows the law, not the deal).
--      Prices are compared in the document currency when bill and order share
--      one, else in the base currency.
--   2. At submit (draft -> pending_approval) over-billing is refused, and a
--      price above the order or a product not on it needs a written reason
--      (vendor_invoices.price_variance_reason, 10+ characters) that the approver
--      sees. Checked once, at submit: a submitted bill cannot change.
--   3. rma_config 'purchase_price_tolerance_pct' (percent; unset, blank or not
--      a plain number = 0, i.e. any increase needs a reason). Control Panel >
--      Regional settings.
--
-- Pinned by src/test/supplierBillMatch.test.jsx; supabase/tests/supplier_bill_match.sql
-- is the rolled-back reference script.
-- ============================================================================

ALTER TABLE public.vendor_invoices ADD COLUMN IF NOT EXISTS price_variance_reason text;
COMMENT ON COLUMN public.vendor_invoices.price_variance_reason IS
  'P-04: why the bill prices something above its purchase order (beyond purchase_price_tolerance_pct) or bills a product not on the order. Given when the bill is submitted; the approver sees it.';

-- ── 1. the match ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_purchase_price_tolerance_pct()
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE v_text text;
BEGIN
  SELECT c.config_value #>> '{}' INTO v_text FROM public.rma_config c WHERE c.config_key = 'purchase_price_tolerance_pct';
  -- unset, blank or not a plain number = no tolerance (never a cast error at submit)
  IF v_text IS NULL OR btrim(v_text) !~ '^[0-9]+(\.[0-9]+)?$' THEN
    RETURN 0;
  END IF;
  RETURN btrim(v_text)::numeric;
END
$fn$;
REVOKE ALL ON FUNCTION public.rma_purchase_price_tolerance_pct() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_purchase_price_tolerance_pct() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rma_vendor_invoice_match(p_vi_id uuid)
RETURNS TABLE (
  line_no          integer,
  product_id       uuid,
  product_name     text,
  ordered_qty      integer,
  received_qty     integer,
  billed_qty       integer,
  order_unit_net   numeric,
  billed_unit_net  numeric,
  price_diff_pct   numeric,
  issue            text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_vi   public.vendor_invoices;
  v_po   public.purchase_orders;
  v_tol  numeric := public.rma_purchase_price_tolerance_pct();
  v_same boolean;
BEGIN
  -- Purchase figures are for managers and accountants. A call with no login is
  -- the database itself (the submit guard).
  IF public.rma_current_user_email() IS NOT NULL
     AND NOT COALESCE(public.rma_is_manager_or_above() OR public.rma_user_role() = 'accountant', false) THEN
    RAISE EXCEPTION 'Not authorized to see purchase prices' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_vi FROM public.vendor_invoices WHERE id = p_vi_id;
  IF NOT FOUND OR v_vi.purchase_order_id IS NULL THEN
    RETURN; -- no order to match (a bill with no order has its own controls)
  END IF;
  SELECT * INTO v_po FROM public.purchase_orders WHERE id = v_vi.purchase_order_id;
  v_same := v_vi.currency IS NOT DISTINCT FROM v_po.currency;

  RETURN QUERY
  WITH bill AS (
    SELECT l.line_no, l.product_id, l.product_name, l.qty_ordered AS billed_qty,
           l.unit_cost * (1 - COALESCE(l.discount_pct, 0) / 100) AS net,
           k.goods_receipt_line_id AS grl_id
      FROM public.vendor_invoice_lines l
      LEFT JOIN public.vendor_invoice_receipt_lines k
             ON k.vendor_invoice_id = l.vendor_invoice_id AND k.line_no = l.line_no
     WHERE l.vendor_invoice_id = p_vi_id
  ),
  po AS (
    SELECT pl.id, pl.line_no, pl.product_id, pl.qty_ordered,
           pl.unit_cost * (1 - COALESCE(pl.discount_pct, 0) / 100) AS net
      FROM public.purchase_order_lines pl
     WHERE pl.purchase_order_id = v_po.id
  ),
  matched AS (
    SELECT b.*,
           -- a bill line from a receipt knows its order line; otherwise the
           -- order line at the same position with the same product, else the
           -- order's lines of that product taken together
           COALESCE(gl.purchase_order_line_id,
                    (SELECT p.id FROM po p WHERE p.line_no = b.line_no AND p.product_id = b.product_id)) AS pol_id,
           gl.qty AS grl_qty
      FROM bill b
      LEFT JOIN public.goods_receipt_lines gl ON gl.id = b.grl_id
  ),
  priced AS (
    SELECT m.*,
           CASE WHEN m.pol_id IS NOT NULL THEN (SELECT p.net FROM po p WHERE p.id = m.pol_id)
                ELSE (SELECT max(p.net) FROM po p WHERE p.product_id = m.product_id) END AS order_net,
           CASE WHEN m.grl_id IS NOT NULL THEN (SELECT p.qty_ordered FROM po p WHERE p.id = m.pol_id)
                ELSE (SELECT sum(p.qty_ordered)::integer FROM po p WHERE p.product_id = m.product_id) END AS ordered,
           -- billed on this bill for the same product (the older path compares
           -- per product, since its lines need not follow the order's)
           sum(m.billed_qty) OVER (PARTITION BY m.product_id) AS billed_for_product
      FROM matched m
  ),
  judged AS (
    SELECT pr.*,
           CASE WHEN pr.order_net IS NULL OR pr.order_net = 0 THEN NULL
                WHEN v_same THEN round((pr.net - pr.order_net) / pr.order_net * 100, 2)
                ELSE round((pr.net * COALESCE(v_vi.exchange_rate, 1) - pr.order_net * COALESCE(v_po.exchange_rate, 1))
                           / (pr.order_net * COALESCE(v_po.exchange_rate, 1)) * 100, 2) END AS diff_pct
      FROM priced pr
  )
  SELECT j.line_no, j.product_id, j.product_name, j.ordered,
         CASE WHEN j.grl_id IS NOT NULL THEN j.grl_qty END,
         j.billed_qty,
         round(j.order_net, 4), round(j.net, 4), j.diff_pct,
         CASE
           WHEN j.ordered IS NULL THEN 'not_on_order'
           WHEN j.grl_id IS NOT NULL AND j.billed_qty > j.grl_qty THEN 'over_billed'
           WHEN j.grl_id IS NULL AND j.billed_for_product > j.ordered THEN 'over_billed'
           WHEN j.order_net IS NOT NULL AND j.order_net = 0 AND j.net > 0 THEN 'price_above'
           WHEN j.diff_pct IS NOT NULL AND j.diff_pct > v_tol THEN 'price_above'
         END
    FROM judged j
   ORDER BY j.line_no;
END
$fn$;
REVOKE ALL ON FUNCTION public.rma_vendor_invoice_match(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rma_vendor_invoice_match(uuid) TO authenticated, service_role;

-- ── 2. the check at submit ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rma_guard_vendor_invoice_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_over  text;
  v_price text;
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN   -- a restore writes rows back as they were
    RETURN NEW;
  END IF;
  -- the reason is written only while the bill is a draft (it is given at submit)
  IF NEW.price_variance_reason IS DISTINCT FROM OLD.price_variance_reason AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'The reason for a price above the order is given when the bill is submitted.' USING ERRCODE = 'P0001';
  END IF;
  NEW.price_variance_reason := NULLIF(btrim(NEW.price_variance_reason), '');

  IF NOT (OLD.status = 'draft' AND NEW.status = 'pending_approval') OR NEW.purchase_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT string_agg(format('%s (billed %s, %s)', m.product_name, m.billed_qty,
                           CASE WHEN m.received_qty IS NOT NULL THEN 'received ' || m.received_qty ELSE 'ordered ' || m.ordered_qty END), '; ' ORDER BY m.line_no)
    INTO v_over
    FROM public.rma_vendor_invoice_match(NEW.id) m WHERE m.issue = 'over_billed';
  IF v_over IS NOT NULL THEN
    RAISE EXCEPTION 'This bill charges for more than was ordered or received: %. Correct the quantities before submitting.', v_over
      USING ERRCODE = 'P0001';
  END IF;

  SELECT string_agg(CASE WHEN m.issue = 'not_on_order' THEN format('%s is not on the order', m.product_name)
                         WHEN m.price_diff_pct IS NULL THEN format('%s at %s, free on the order', m.product_name, m.billed_unit_net)
                         ELSE format('%s at %s against %s on the order (+%s%%)', m.product_name, m.billed_unit_net, m.order_unit_net, m.price_diff_pct) END,
                    '; ' ORDER BY m.line_no)
    INTO v_price
    FROM public.rma_vendor_invoice_match(NEW.id) m WHERE m.issue IN ('price_above', 'not_on_order');
  IF v_price IS NOT NULL AND length(COALESCE(NEW.price_variance_reason, '')) < 10 THEN
    RAISE EXCEPTION 'This bill does not match its purchase order: %. Say why (at least 10 characters) and submit again.', v_price
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$fn$;
-- a trigger function: nobody calls it (a new function is PUBLIC-executable by default)
REVOKE ALL ON FUNCTION public.rma_guard_vendor_invoice_match() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rma_guard_vendor_invoice_match() TO service_role;

DROP TRIGGER IF EXISTS trg_vendor_invoices_match ON public.vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_match
  BEFORE UPDATE OF status, price_variance_reason ON public.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_vendor_invoice_match();

-- ── 3. the reason is written with the submit, like the duplicate reason ─────
-- The allowlist (20260889) refuses a direct write to any column it does not
-- name; price_variance_reason joins the ones a client may set (the guard above
-- limits it to a draft).
DO $$
DECLARE
  v_def text;
  v_old text := $o$ARRAY['status', 'approved_at', 'duplicate_override_reason',$o$;
  v_new text := $o$ARRAY['status', 'approved_at', 'duplicate_override_reason', 'price_variance_reason',$o$;
BEGIN
  SELECT replace(pg_get_functiondef('public.rma_guard_vendor_invoice_allowlist'::regproc), E'\r\n', E'\n') INTO v_def;
  IF strpos(v_def, v_new) > 0 THEN
    RETURN; -- already applied
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION '20260900: the allowlist guard does not read as expected; not changed';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END $$;
