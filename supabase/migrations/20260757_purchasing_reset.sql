-- ═══════════════════════════════════════════════════════════════════════════
--  Purchasing Redesign — reset + schema rebuild (step 2 of 7)
--
--  USER-APPROVED DESTRUCTIVE RESET (2026-07-05): the Purchasing module is
--  only a few days old with no real procurement data in it. Rather than
--  migrate existing rows onto the new Vendor(=Brand) model, every purchase
--  document row is wiped and the `vendors` + `proforma_invoices` tables are
--  dropped outright. `purchase_orders`/`vendor_invoices` themselves are
--  KEPT (just repointed + extended) so `inventory_units.vendor_invoice_id`
--  and the `stock_moves` ledger keep a valid table to reference.
--
--  Residual effect (documented, accepted): any inventory_units rows already
--  linked to a vendor_invoice_id lose that link (set NULL below) since the
--  FK has no ON DELETE clause and the VI they point to is about to be wiped.
--  The stock itself is untouched — only the "which paperwork received this"
--  pointer is cleared. Old stock_moves rows with doc_type='vendor_invoice'
--  keep their doc_id, which will now dangle (harmless: append-only history).
--
--  New funnel:
--    Purchase Order   (non-financial, never touches inventory)
--      draft -> sent -> pending_confirmation -> confirmed
--      -> partially_completed / completed (set by receive_vendor_invoice,
--         see 20260758)             -- or cancelled / expired at any point
--    Vendor Invoice   (financial: inventory receipt + vendor payable)
--      draft -> pending_approval -> approved
--      -> partially_received -> received       -- or cancelled
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Drop the view first (depends on all 3 tables) ────────────────────────
DROP VIEW IF EXISTS public.v_purchase_documents;

-- ── 2. Clear the receipt-provenance link before wiping vendor_invoices ──────
UPDATE public.inventory_units SET vendor_invoice_id = NULL WHERE vendor_invoice_id IS NOT NULL;

-- ── 3. Wipe purchase documents (child-to-parent order) ──────────────────────
DELETE FROM public.vendor_invoices;
DELETE FROM public.purchase_orders;

-- ── 4. Remove Proforma Invoices entirely ────────────────────────────────────
ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS proforma_invoice_id;
DROP TABLE IF EXISTS public.proforma_invoices;

-- ── 5. Repoint vendor_id -> brands(id) (tables are empty; safe) ─────────────
ALTER TABLE public.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_vendor_id_fkey;
ALTER TABLE public.purchase_orders
  ADD CONSTRAINT purchase_orders_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.brands(id);

ALTER TABLE public.vendor_invoices DROP CONSTRAINT IF EXISTS vendor_invoices_vendor_id_fkey;
ALTER TABLE public.vendor_invoices
  ADD CONSTRAINT vendor_invoices_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.brands(id);

-- ── 6. Drop the now-unused standalone vendors table ─────────────────────────
DROP TABLE IF EXISTS public.vendors;

-- ── 7. purchase_orders: new fields + new status flow ────────────────────────
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS issue_date        date DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS currency          text,
  ADD COLUMN IF NOT EXISTS payment_terms     text,
  ADD COLUMN IF NOT EXISTS delivery_terms    text,
  ADD COLUMN IF NOT EXISTS shipping_address  text,
  ADD COLUMN IF NOT EXISTS billing_address   text,
  ADD COLUMN IF NOT EXISTS terms_conditions  text,
  ADD COLUMN IF NOT EXISTS subtotal          numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount   numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount        numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS archived          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at       timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by       text;

DO $$
DECLARE
  v_constraint_name text;
BEGIN
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.purchase_orders'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%status%';
  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.purchase_orders DROP CONSTRAINT %I', v_constraint_name);
  END IF;
END $$;

ALTER TABLE public.purchase_orders
  ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN (
    'draft', 'sent', 'pending_confirmation', 'confirmed',
    'partially_completed', 'completed', 'cancelled', 'expired'
  ));

-- ── 8. vendor_invoices: new fields + new status flow ─────────────────────────
ALTER TABLE public.vendor_invoices
  ADD COLUMN IF NOT EXISTS due_date         date,
  ADD COLUMN IF NOT EXISTS subtotal         numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount  numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount       numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS archived         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at      timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by      text;

-- confirmed_at -> approved_at (the VI's "approved" moment, since 'confirmed'
-- is no longer a vendor_invoices status — see the CHECK below).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'vendor_invoices' AND column_name = 'confirmed_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'vendor_invoices' AND column_name = 'approved_at'
  ) THEN
    ALTER TABLE public.vendor_invoices RENAME COLUMN confirmed_at TO approved_at;
  END IF;
END $$;
ALTER TABLE public.vendor_invoices ADD COLUMN IF NOT EXISTS approved_at timestamptz;

DO $$
DECLARE
  v_constraint_name text;
BEGIN
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.vendor_invoices'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%status%';
  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.vendor_invoices DROP CONSTRAINT %I', v_constraint_name);
  END IF;
END $$;

ALTER TABLE public.vendor_invoices
  ADD CONSTRAINT vendor_invoices_status_check
  CHECK (status IN (
    'draft', 'pending_approval', 'approved',
    'partially_received', 'received', 'cancelled'
  ));
