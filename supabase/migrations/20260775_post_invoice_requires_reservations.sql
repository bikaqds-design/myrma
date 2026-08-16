-- 20260775_post_invoice_requires_reservations.sql
--
-- Refuse to post an invoice that cannot deliver the stock it bills for.
--
-- Found 2026-08-16 while running the deferred "reserve/deliver on an SO/Invoice"
-- row of the warehouse checklist. Reproduced end to end against a throwaway
-- customer:
--
--   1. SO-89405717 for 2x a serialized product, approved
--        -> deliver_units' precondition met: 2 units reservation_status='reserved',
--           reserved_by_doc_id = the SO
--   2. INV-2026-00021 created from that SO and posted
--        -> both units become 'delivered'.  Correct.
--   3. Invoice voided
--        -> void_invoice restores both units to 'available' AND clears
--           reserved_by_doc_type / reserved_by_doc_id.
--        -> the SO stays status='delivered' and still offers "Create Invoice".
--   4. A second invoice is raised off the same SO and posted
--        -> INV-2026-00022 posted with a gapless code, customer billed 200,
--           and deliver_units matched ZERO rows because the reservation link
--           was cleared in step 3.  No error. No warning. No stock moved.
--
-- So the customer is invoiced for goods the system never marks as delivered:
-- AR goes up, inventory does not go down, and nothing anywhere says so. Step 4
-- is silent because deliver_units is a plain FOR..LOOP — zero matching rows is
-- indistinguishable from success.
--
-- The fix is a precondition rather than a change to void semantics. Whatever
-- reason the reservations are missing (this void-then-repost path, a manual
-- release, an invoice hand-linked to an SO), the invariant worth enforcing is
-- the same: an invoice must not reach 'posted' unless the serialized stock it
-- bills is actually reserved and ready to hand over. Money and stock move
-- together or neither moves.
--
-- Only serialized lines are counted. Bulk stock is decremented out of
-- warehouse_stock on a different path and keeps no per-unit reservation, and
-- service lines have no stock at all — counting either would make every mixed
-- invoice unpostable.
--
-- Rollback: re-run 20260734's definition of post_invoice.

CREATE OR REPLACE FUNCTION public.post_invoice(
  p_invoice_id  uuid,
  p_actor_email text
)
RETURNS text   -- assigned inv_code
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv       record;
  v_code      text;
  v_expected  integer;
  v_reserved  integer;
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
    WHERE p.stock_tracking_mode = 'serialized';

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

  -- Deliver inventory reserved by the linked SO — same transaction (Invariant I1)
  IF v_inv.so_id IS NOT NULL THEN
    PERFORM public.deliver_units('sales_order', v_inv.so_id, p_actor_email);
  END IF;

  RETURN v_code;
END;
$$;
