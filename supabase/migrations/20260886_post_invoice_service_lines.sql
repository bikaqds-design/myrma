-- ============================================================================
-- 20260886_post_invoice_service_lines.sql
--
-- post_invoice refused every invoice made from a sales order that had a
-- SERVICE line on it: "it bills N serialized unit(s) but only 0 are reserved".
--
-- Its precondition (added by 5cf141b, "refuse to post an invoice that delivers
-- no stock") counts the invoice lines whose product has stock_tracking_mode =
-- 'serialized'. That column defaults to 'serialized' for every product,
-- services included, and funnel_reserve_line never reserves a service line
-- (it returns first for product_type = 'service'). So the expected count
-- included units that could never be reserved, and the check always failed —
-- installation, support or any service sold on an order could not be invoiced
-- from that order.
--
-- Fix: the same classification funnel_reserve_line uses — a service line is not
-- stock. The rest of post_invoice is the live body unchanged; same signature,
-- so the grants are kept. Found while testing W2 (sales invoice lines) with
-- service products.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.post_invoice(p_invoice_id uuid, p_actor_email text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inv       record;
  v_code      text;
  v_expected  integer;
  v_reserved  integer;
  v_cogs      numeric := 0;   -- 20260797
  v_unknown   integer := 0;
BEGIN
  IF NOT public.rma_is_manager_or_above() THEN
    RAISE EXCEPTION 'Not authorized to post invoices';
  END IF;

  SELECT * INTO v_inv
  FROM public.crm_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.doc_status <> 'draft' THEN
    RAISE EXCEPTION 'Invoice is already % — cannot post again', v_inv.doc_status;
  END IF;

  -- ── Precondition: the serialized stock this invoice bills must be reserved ──
  IF v_inv.so_id IS NOT NULL THEN
    -- How many serialized units do this invoice's lines actually bill for?
    SELECT COALESCE(SUM((li ->> 'qty')::numeric), 0)::integer
      INTO v_expected
    FROM jsonb_array_elements(COALESCE(v_inv.line_items, '[]'::jsonb)) AS li
    JOIN public.products p
      ON p.id = NULLIF(li ->> 'product_id', '')::uuid
    WHERE p.stock_tracking_mode = 'serialized'
      -- 20260886: a service line is never reserved (funnel_reserve_line returns
      -- for it first), so counting it here made every order invoice with a
      -- service on it unpostable. stock_tracking_mode defaults to 'serialized'
      -- for services too, so the product type has to be checked as well.
      AND p.product_type IS DISTINCT FROM 'service';

    IF v_expected > 0 THEN
      -- How many are actually held for the linked SO right now?
      SELECT COUNT(*)
        INTO v_reserved
      FROM public.inventory_units
      WHERE reserved_by_doc_type = 'sales_order'
        AND reserved_by_doc_id   = v_inv.so_id
        AND reservation_status   = 'reserved';

      IF v_reserved < v_expected THEN
        RAISE EXCEPTION
          'Cannot post this invoice: it bills % serialized unit(s) but only % are reserved on sales order %. Posting would charge the customer for stock the system never hands over.',
          v_expected, v_reserved, v_inv.so_id
          USING HINT = 'Voiding a posted invoice releases its reservations. A sales order in that state cannot currently re-reserve stock from the UI — raise a new sales order for the goods still owed.';
      END IF;
    END IF;
  END IF;

  -- Assign gapless code inside this tx; rolls back if deliver_units fails below
  v_code := public.nextval_for_type('invoice');

  UPDATE public.crm_invoices
  SET
    inv_code   = v_code,
    doc_status = 'posted',
    posted_at  = NOW(),
    updated_at = NOW()
  WHERE id = p_invoice_id;

  -- ── Cost of goods sold, captured BEFORE the stock moves ──────────────────
  -- It has to be read first: delivering serialised units changes their
  -- reservation, and delivering bulk stock changes the very average the cost
  -- is read from. Afterwards there is nothing left to measure.
  --
  -- Captured on the invoice rather than computed on demand later, because the
  -- cost of what was sold is a fact about the day it shipped. Re-deriving it
  -- next quarter from a moving average would report a different profit for the
  -- same sale every time stock is revalued.
  IF v_inv.so_id IS NOT NULL THEN
    SELECT c.cogs_base, c.unknown_qty
      INTO v_cogs, v_unknown
      FROM public.rma_invoice_cogs(p_invoice_id) c;
  END IF;

  UPDATE public.crm_invoices
  SET cogs_base       = COALESCE(v_cogs, 0),
      cogs_unknown_qty = COALESCE(v_unknown, 0)
  WHERE id = p_invoice_id;

  -- Deliver inventory reserved by the linked SO — same transaction (Invariant I1)
  IF v_inv.so_id IS NOT NULL THEN
    PERFORM public.deliver_units('sales_order', v_inv.so_id, p_actor_email);

    -- 20260797: bulk stock was reserved by funnel_reserve_line when the sales
    -- order was approved and then never delivered by anything — the customer
    -- was billed and the quantity never left the warehouse, while
    -- reserved_quantity grew until no further bulk sale of that product could
    -- be reserved at all. deliver_warehouse_stock existed and had no caller
    -- anywhere in the codebase.
    PERFORM public.deliver_warehouse_stock('sales_order', v_inv.so_id, p_actor_email);
  END IF;

  RETURN v_code;
END;
$function$;
