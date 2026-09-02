-- 20260831_find_currency_mismatched_invoices.sql
-- Read-only. Finds purchase documents whose currency is probably wrong.
--
-- ═══ Why this exists ═════════════════════════════════════════════════════════
--
-- Found by opening a real record in the app: vendor invoice 45d291aa (from
-- PO-76109814, ASRock) shows CURRENCY EGP and a total of 3,750 — but the
-- purchase order it was raised from is 3,750 USD.
--
-- The cause is the backfill in 20260792. Purchase orders already had a
-- free-text currency field holding 'USD', which was normalised. Vendor invoices
-- had no currency at all, so every existing one was set to the base currency,
-- which is right for the local ones and wrong for the imports.
--
-- The consequence, once 20260794 is applied: receiving that invoice would cost
-- 30 motherboards at E£125 each instead of roughly E£6,062 each — under-costing
-- the stock by about 98%, and reporting a margin near 100% on every one of them
-- when they sell. It is worth fixing BEFORE the invoice is received, because
-- after receipt the cost is written onto the units and correcting the invoice
-- no longer corrects the stock.
--
-- This script only reports. Nothing is changed; the correction is at the bottom
-- as a commented-out statement to run per invoice after checking the paperwork.

-- ─── 1. Vendor invoices that disagree with their purchase order ──────────────
SELECT
  'vi_vs_po_currency'                      AS finding,
  vi.id                                    AS vendor_invoice_id,
  COALESCE(vi.vi_code, '(not yet coded)')  AS vi_code,
  b.brand_name                             AS vendor,
  vi.status,
  vi.currency                              AS vi_currency,
  vi.total                                 AS vi_total,
  po.po_code,
  po.currency                              AS po_currency,
  po.total                                 AS po_total,
  CASE
    WHEN vi.status IN ('partially_received','received')
      THEN 'ALREADY RECEIVED — correcting the invoice will NOT correct the stock'
    ELSE 'not yet received — safe to correct'
  END                                      AS urgency
FROM public.vendor_invoices vi
JOIN public.purchase_orders po ON po.id = vi.purchase_order_id
LEFT JOIN public.brands b ON b.id = vi.vendor_id
WHERE vi.currency IS DISTINCT FROM po.currency

UNION ALL

-- ─── 2. Standalone invoices that look like imports ───────────────────────────
-- No purchase order to compare against, so this is a weaker signal: an invoice
-- in the base currency from a vendor whose other documents are foreign. Worth a
-- human look rather than proof of anything.
SELECT
  'base_currency_invoice_from_a_foreign_vendor',
  vi.id,
  COALESCE(vi.vi_code, '(not yet coded)'),
  b.brand_name,
  vi.status,
  vi.currency,
  vi.total,
  NULL, NULL, NULL,
  'check the supplier paperwork'
FROM public.vendor_invoices vi
LEFT JOIN public.brands b ON b.id = vi.vendor_id
WHERE vi.purchase_order_id IS NULL
  AND vi.currency = (SELECT config_value #>> '{}' FROM public.rma_config
                      WHERE config_key = 'default_currency')
  AND EXISTS (
    SELECT 1 FROM public.purchase_orders po2
     WHERE po2.vendor_id = vi.vendor_id
       AND po2.currency <> (SELECT config_value #>> '{}' FROM public.rma_config
                             WHERE config_key = 'default_currency'))

ORDER BY 1, 5;

-- ─── Correcting one, once the paperwork confirms it ──────────────────────────
--
-- Do this only for invoices NOT yet received. Both columns must move together:
-- the rate guard (20260792) refuses a foreign currency at a rate of 1, and
-- refuses the base currency at any other rate.
--
--   UPDATE public.vendor_invoices
--      SET currency = 'USD', exchange_rate = 48.50
--    WHERE id = '<vendor_invoice_id>'
--      AND status NOT IN ('partially_received','received');
--
-- total_base is generated, so it recalculates on its own. Re-run this script
-- afterwards; the row should be gone from the first section.
