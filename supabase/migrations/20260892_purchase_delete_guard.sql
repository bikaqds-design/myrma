-- ============================================================================
-- 20260892_purchase_delete_guard.sql
-- A purchase order or vendor invoice past draft cannot be deleted from the
-- client surface — the same rule 20260875 gave quotations, sales orders,
-- invoices and credit notes.
--
-- Why it matters (found by the 20260888 review):
--   * manager_write_purchase_orders / manager_write_vendor_invoices are FOR ALL,
--     so a manager could DELETE a confirmed PO or an approved, received or paid
--     vendor invoice.
--   * The foreign keys cascade: deleting a vendor invoice silently removes its
--     vendor_payment_applications (money already applied to it), its charges
--     and its lines; deleting a PO removes its amendment history
--     (purchase_order_revisions) and its lines. Received stock keeps pointing
--     at nothing (inventory_units.vendor_invoice_id has no action, so that
--     delete fails loudly today — the others do not).
--
-- The guard is 20260875's rma_guard_settled_document (client surface only: an
-- RPC and Backup & Restore run as the owner and are unaffected; no
-- administrator exemption). A draft can still be deleted. The DELETE policies
-- are left as they are, for 20260875's reason: a status condition there would
-- turn the refusal into a silent 0-row delete.
-- ============================================================================

DROP TRIGGER IF EXISTS trg_purchase_orders_lock_settled_delete ON public.purchase_orders;
CREATE TRIGGER trg_purchase_orders_lock_settled_delete
  BEFORE DELETE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_settled_document('status');

DROP TRIGGER IF EXISTS trg_vendor_invoices_lock_settled_delete ON public.vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_lock_settled_delete
  BEFORE DELETE ON public.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_settled_document('status');

-- ── guard ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgname IN ('trg_purchase_orders_lock_settled_delete', 'trg_vendor_invoices_lock_settled_delete')) <> 2 THEN
    RAISE EXCEPTION 'Refusing to finish: the purchase delete guards are not both in place';
  END IF;
END $$;
