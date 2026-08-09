-- ============================================================================
-- 20260773 — Enforce the purchase document lifecycle in the database
-- ============================================================================
-- Every purchase status change is currently a bare client-side write:
--
--   supabase.from('purchase_orders').update({ status: 'confirmed' }).eq('id', id)
--
-- with no condition on the status it is moving FROM. src/api/db/purchasing.ts
-- says so in as many words above vendorInvoices.update — "intended for
-- pre-approval edits only; the UI gates this by status". The UI is therefore
-- the only thing standing between the data and an illegal transition, and the
-- UI is not a security boundary: PostgREST exposes these tables directly, so
-- any authenticated session can PATCH a status to any value the CHECK
-- constraint permits.
--
-- The transitions that actually cost money if they slip through:
--
--   * un-cancelling. 'cancelled' is read as "this money was never committed" by
--     every analytics measure (DEAD_STATUSES in _shared.js). Reviving a
--     cancelled document silently rewrites historical spend.
--
--   * reopening a received document. A vendor invoice at 'received' has already
--     created inventory_units and warehouse_stock rows. Sending it back to
--     'draft' makes its line items editable again; re-approving and re-receiving
--     then books the same delivery into stock twice, with no reversal of the
--     first.
--
--   * cancelling after receipt. Stock has physically arrived and been booked,
--     but the document that explains it drops out of every spend figure. The
--     stock is then unexplained and the vendor balance is wrong.
--
--   * skipping approval. draft -> confirmed / draft -> approved bypasses the
--     approval activity entirely, which is the only record of who authorised
--     the spend.
--
-- Same discipline as assert_not_system_warehouse (20260770) and
-- assert_tracking_mode_change_is_safe (20260772): where the consequence of a
-- bad write is silent and financial, the rule belongs in the database.
--
-- The rule is expressed as an explicit whitelist of legal edges rather than a
-- list of prohibitions, so a status added later is refused by default and has
-- to be considered here rather than quietly inheriting free movement.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.assert_purchase_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
$$;

DROP TRIGGER IF EXISTS trg_assert_po_status_transition ON public.purchase_orders;
CREATE TRIGGER trg_assert_po_status_transition
  BEFORE UPDATE OF status ON public.purchase_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_purchase_status_transition();

DROP TRIGGER IF EXISTS trg_assert_vi_status_transition ON public.vendor_invoices;
CREATE TRIGGER trg_assert_vi_status_transition
  BEFORE UPDATE OF status ON public.vendor_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_purchase_status_transition();

-- ─── Notes on the legitimate writers ─────────────────────────────────────────
-- receive_vendor_invoice (20260758) is the only writer of the received and
-- completed states. Its edges are all whitelisted above:
--
--   VI  approved | partially_received  ->  partially_received | received
--   PO  confirmed | partially_completed ->  partially_completed | completed
--
-- It already refuses to run unless the VI is approved or partially_received, so
-- the trigger never sees a receive from an earlier state. Its PO sync skips
-- 'cancelled' and 'expired' explicitly, which is why neither appears as a source
-- for the completion states.
--
-- The trigger is BEFORE UPDATE OF status, so the receive RPC's other column
-- writes (line_items, received_at, updated_at) are untouched by it.

-- ─── Verification ────────────────────────────────────────────────────────────
--   UPDATE public.vendor_invoices SET status = 'draft'
--    WHERE status = 'received';
--   -- ERROR: Illegal vendor invoices status change: received -> draft.
--   --        Allowed from "received": nothing (terminal state).
--
--   UPDATE public.purchase_orders SET status = 'confirmed'
--    WHERE status = 'cancelled';
--   -- ERROR: Illegal purchase orders status change: cancelled -> confirmed. …
--
--   UPDATE public.vendor_invoices SET status = 'approved'
--    WHERE status = 'draft';
--   -- ERROR: … Allowed from "draft": pending_approval, cancelled.
--
-- The normal flow is unaffected: draft -> pending_approval -> approved ->
-- partially_received -> received all pass, as does archiving or editing any
-- other column at any status.
