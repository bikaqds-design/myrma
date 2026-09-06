-- credit_notes could not represent a discount, so a credit raised against a
-- discounted invoice line could never reconcile. (Audit finding BUG-013.)
--
-- crm_invoices and quotations both carry subtotal / discount_amount /
-- tax_amount / total, and SalesDocumentDetail.jsx already renders a discount
-- row for any document that has one (line 738). credit_notes had every column
-- except discount_amount, so this brings it to parity and the existing UI picks
-- it up with no client change.
--
-- Additive and defaulted, so existing rows and the issue_credit_note RPC (which
-- reads only `total`) are unaffected.
--
-- Pairs with the client fix in the same change:
--   src/api/db/_documentTotals.ts   the single shared money formula
--   src/api/db/creditNotes.ts       stores real subtotal/discount/tax/total
--   src/pages/SalesDocuments/_modals.jsx
--                                   carries discount_pct/tax_pct onto the lines

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid='public.credit_notes'::regclass
                AND attname='discount_amount' AND NOT attisdropped) THEN
    RAISE NOTICE 'credit_notes.discount_amount already exists; nothing to do.';
  ELSE
    ALTER TABLE public.credit_notes
      ADD COLUMN discount_amount numeric(12,2) NOT NULL DEFAULT 0;
    RAISE NOTICE 'credit_notes.discount_amount added.';
  END IF;
END
$do$;

DO $do$
DECLARE
  v_bad integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid='public.credit_notes'::regclass
                    AND attname='discount_amount' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Refusing to finish: the column was not created.';
  END IF;

  -- Every existing credit note must still reconcile: subtotal - discount + tax = total.
  SELECT count(*) INTO v_bad
    FROM public.credit_notes
   WHERE abs((coalesce(subtotal,0) - coalesce(discount_amount,0) + coalesce(tax_amount,0))
             - coalesce(total,0)) > 0.01;
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'Refusing to finish: % existing credit notes do not reconcile after adding the column.', v_bad;
  END IF;

  RAISE NOTICE 'All existing credit notes reconcile.';
END
$do$;

-- ─── Data check performed before this change ─────────────────────────────────
-- All 5 existing credit notes were examined against their source invoices:
-- none of those invoices carries any discount or tax (discount_amount 0.00,
-- tax_amount 0.00, zero lines with a non-zero discount_pct or tax_pct), so no
-- existing credit note has a wrong total and there is nothing to repair. The
-- defect was latent and would have bitten the first credit against a taxed or
-- discounted invoice.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
--   ALTER TABLE public.credit_notes DROP COLUMN discount_amount;
-- Only safe alongside reverting the client change, which writes to it.
