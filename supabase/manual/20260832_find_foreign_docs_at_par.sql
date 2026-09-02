-- 20260832_find_foreign_docs_at_par.sql
-- Read-only. Finds foreign-currency documents sitting at an exchange rate of 1.
--
-- ═══ Why this exists ═════════════════════════════════════════════════════════
--
-- 20260792 does two things in order: it normalises the free-text currency on
-- purchase orders (section 1), and only afterwards creates the trigger that
-- refuses a foreign document at a rate of 1 (section 3). Rows that already
-- existed took `exchange_rate` from the column DEFAULT of 1 and were never
-- passed through the guard, because ADD COLUMN is not an UPDATE OF the columns
-- the trigger watches.
--
-- So the guard protects everything created from now on, and protected nothing
-- that was already there. A USD purchase order for 3,750 is currently recorded
-- as being worth 3,750 in base currency — understated by roughly the exchange
-- rate, about forty-eight times.
--
-- This matters more now than it did yesterday. total_base is what every spend
-- figure, vendor total, pivot cell and sort now adds (20260793), and from
-- 20260794 it is also what unit cost and therefore every margin is derived
-- from. A wrong rate here is wrong everywhere downstream.
--
-- Nothing is changed by this script. The correction is at the bottom.

SELECT
  'purchase_order'                       AS doc,
  po.id,
  po.po_code                             AS code,
  b.brand_name                           AS vendor,
  po.status,
  po.currency,
  po.exchange_rate,
  po.total,
  po.total_base,
  'total_base equals total — this document is being counted as if it were base currency'
                                         AS problem
FROM public.purchase_orders po
LEFT JOIN public.brands b ON b.id = po.vendor_id
WHERE po.currency <> (SELECT config_value #>> '{}' FROM public.rma_config
                       WHERE config_key = 'default_currency')
  AND po.exchange_rate = 1

UNION ALL

SELECT
  'vendor_invoice',
  vi.id,
  COALESCE(vi.vi_code, '(not yet coded)'),
  b.brand_name,
  vi.status,
  vi.currency,
  vi.exchange_rate,
  vi.total,
  vi.total_base,
  CASE
    WHEN vi.status IN ('partially_received','received')
      THEN 'ALREADY RECEIVED — the wrong cost is on the stock; fixing the invoice will not fix it'
    ELSE 'not yet received — correcting now also corrects the cost of the goods'
  END
FROM public.vendor_invoices vi
LEFT JOIN public.brands b ON b.id = vi.vendor_id
WHERE vi.currency <> (SELECT config_value #>> '{}' FROM public.rma_config
                       WHERE config_key = 'default_currency')
  AND vi.exchange_rate = 1

UNION ALL

-- The same fault seen from the other side: a vendor payment in a foreign
-- currency at par. 20260793 created its guard at the same time as the column,
-- so this should return nothing — it is here to prove that rather than assume.
SELECT
  'vendor_payment',
  vp.id,
  vp.payment_code,
  b.brand_name,
  vp.status,
  vp.currency,
  vp.exchange_rate,
  vp.amount,
  vp.amount_base,
  'foreign payment recorded at par'
FROM public.vendor_payments vp
LEFT JOIN public.brands b ON b.id = vp.vendor_id
WHERE vp.currency <> (SELECT config_value #>> '{}' FROM public.rma_config
                       WHERE config_key = 'default_currency')
  AND vp.exchange_rate = 1

ORDER BY 1, 3;

-- ─── Correcting them ─────────────────────────────────────────────────────────
--
-- The rate is a fact about what was actually paid, so it has to come off the
-- paperwork rather than be inferred. Set it per document:
--
--   UPDATE public.purchase_orders
--      SET exchange_rate = <rate>          -- base currency per 1 of the document's currency
--    WHERE id = '<id>';
--
--   UPDATE public.vendor_invoices
--      SET exchange_rate = <rate>
--    WHERE id = '<id>'
--      AND status NOT IN ('partially_received','received');
--
-- Or, if one rate is right for a whole group:
--
--   UPDATE public.purchase_orders
--      SET exchange_rate = <rate>
--    WHERE currency = 'USD' AND exchange_rate = 1;
--
-- total_base is generated, so it recalculates by itself. The rate guard now
-- applies to these statements — it will refuse a rate of 1 on a foreign
-- document, which is exactly the condition being fixed.
--
-- Re-run this script afterwards. It should return no rows.
