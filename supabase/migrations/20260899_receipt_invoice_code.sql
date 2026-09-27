-- ============================================================================
-- 20260899_receipt_invoice_code.sql
-- P-03c follow-up: a supplier invoice raised from goods receipts gets its
-- VI- number when it is approved.
-- ============================================================================
-- vendor_invoices.vi_code is assigned by receive_vendor_invoice on the first
-- receipt (20260749, still so in 20260889). An invoice from goods receipts
-- (20260898) is never received itself — its goods arrived on the receipts — so
-- it stayed payable for ever with no number. It is numbered at approval, the
-- moment it becomes a payable, from the same gapless counter: the counter is a
-- table row, so an approval that fails rolls its number back with it.
--
-- The trigger's name sorts after every other BEFORE trigger on the table, so
-- the client guards (allowlist, identity, approval authority, locks) all see
-- the row before the number is set. A restore (rma.audit_suspended) writes the
-- number back as it was and is left alone.
--
-- Pinned by src/test/goodsReceiptScreens.test.js; supabase/tests/receipt_invoicing.sql
-- (the VI- number check in section 3) is the rolled-back reference check.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rma_receipt_invoice_code_on_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF current_setting('rma.audit_suspended', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' AND NEW.vi_code IS NULL
     AND EXISTS (SELECT 1 FROM public.vendor_invoice_receipt_lines WHERE vendor_invoice_id = NEW.id) THEN
    NEW.vi_code := public.nextval_for_type('vendor_invoice');
  END IF;
  RETURN NEW;
END
$fn$;
-- a trigger function: nobody calls it (a new function is PUBLIC-executable by default)
REVOKE ALL ON FUNCTION public.rma_receipt_invoice_code_on_approval() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rma_receipt_invoice_code_on_approval() TO service_role;

DROP TRIGGER IF EXISTS trg_vendor_invoices_zz_receipt_code ON public.vendor_invoices;
CREATE TRIGGER trg_vendor_invoices_zz_receipt_code
  BEFORE UPDATE OF status ON public.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_receipt_invoice_code_on_approval();

-- Invoices from receipts approved before this migration: number them now, in
-- approval order (none exist outside staging).
DO $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN
    SELECT vi.id FROM public.vendor_invoices vi
     WHERE vi.vi_code IS NULL AND vi.status = 'approved'
       AND EXISTS (SELECT 1 FROM public.vendor_invoice_receipt_lines k WHERE k.vendor_invoice_id = vi.id)
     ORDER BY vi.approved_at NULLS LAST, vi.id
  LOOP
    UPDATE public.vendor_invoices SET vi_code = public.nextval_for_type('vendor_invoice') WHERE id = r.id;
    n := n + 1;
  END LOOP;
  RAISE NOTICE '20260899: % approved invoice(s) from receipts numbered', n;
END $$;
