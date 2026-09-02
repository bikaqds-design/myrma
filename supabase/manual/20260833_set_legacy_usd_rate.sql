-- 20260833_set_legacy_usd_rate.sql
-- Corrects the four USD purchase orders and one vendor invoice that 20260792
-- left at an exchange rate of 1. See 20260832 for how they got that way.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  The rate is set: 48.50 EGP per 1 USD, the rate these four orders were
--  raised at on 2026-07-06. Ready to run as it stands.
--
--  The guard below still refuses a rate of 1, so this script can never be run
--  back into the state it exists to fix.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- What it changes:
--   • every purchase order in USD still sitting at a rate of 1
--   • the ASRock vendor invoice 45d291aa, which is recorded as EGP but was
--     raised from PO-76109814 in USD — both its currency and its rate
--
-- What it deliberately does NOT change:
--   • any vendor invoice already received. The cost is already written onto
--     units in a warehouse; correcting the invoice would not correct them, and
--     would leave the two disagreeing. Those need a stock revaluation, which is
--     a different and more invasive operation.
--
-- total_base is a generated column, so it recalculates itself. Re-run
-- 20260832_find_foreign_docs_at_par.sql afterwards — it should return no rows.

DO $do$
DECLARE
  -- ─────────────────────────────────────────────────────────────────────────
  v_rate numeric := 48.50;    -- EGP per 1 USD on 2026-07-06, given by the user
  -- ─────────────────────────────────────────────────────────────────────────
  v_base       text;
  v_pos        integer;
  v_vis        integer;
  v_skipped    integer;
BEGIN
  IF v_rate = 1 THEN
    RAISE EXCEPTION
      'Set v_rate first. A rate of 1 is the very condition this script exists to fix — running it unedited would change nothing and report success.';
  END IF;
  IF v_rate <= 0 THEN
    RAISE EXCEPTION 'An exchange rate must be positive, not %.', v_rate;
  END IF;

  SELECT config_value #>> '{}' INTO v_base
    FROM public.rma_config WHERE config_key = 'default_currency';

  IF v_base = 'USD' THEN
    RAISE EXCEPTION
      'The base currency is USD, so a USD document is not foreign and this script does not apply.';
  END IF;

  -- ── Purchase orders ─────────────────────────────────────────────────────
  UPDATE public.purchase_orders
     SET exchange_rate = v_rate,
         updated_at    = now()
   WHERE currency = 'USD'
     AND exchange_rate = 1;
  GET DIAGNOSTICS v_pos = ROW_COUNT;

  -- ── The one vendor invoice whose currency is wrong too ──────────────────
  -- Matched by its purchase order rather than by a pasted id, so the script
  -- says what it means: an invoice must be in the currency of the order it
  -- came from. If a second one ever appears, this catches it as well.
  UPDATE public.vendor_invoices vi
     SET currency      = po.currency,
         exchange_rate = v_rate
    FROM public.purchase_orders po
   WHERE po.id = vi.purchase_order_id
     AND po.currency = 'USD'
     AND vi.currency IS DISTINCT FROM po.currency
     AND vi.status NOT IN ('partially_received', 'received');
  GET DIAGNOSTICS v_vis = ROW_COUNT;

  -- ── Anything already received, reported rather than touched ─────────────
  SELECT count(*) INTO v_skipped
    FROM public.vendor_invoices vi
    JOIN public.purchase_orders po ON po.id = vi.purchase_order_id
   WHERE po.currency = 'USD'
     AND vi.currency IS DISTINCT FROM po.currency
     AND vi.status IN ('partially_received', 'received');

  RAISE NOTICE 'Rate % applied to % purchase order(s) and % vendor invoice(s).',
    v_rate, v_pos, v_vis;

  IF v_skipped > 0 THEN
    RAISE WARNING
      '% vendor invoice(s) were left alone because the goods are already received. Their stock is costed at the wrong rate and needs a revaluation, not an invoice edit.',
      v_skipped;
  END IF;
END
$do$;

-- Shows the result. Every foreign document should now carry a rate that is not
-- 1, and a total_base that differs from its total.
SELECT
  'purchase_order' AS doc, po_code AS code, currency, exchange_rate, total, total_base
  FROM public.purchase_orders
 WHERE currency <> (SELECT config_value #>> '{}' FROM public.rma_config
                     WHERE config_key = 'default_currency')
UNION ALL
SELECT
  'vendor_invoice', COALESCE(vi_code, '(not yet coded)'), currency, exchange_rate, total, total_base
  FROM public.vendor_invoices
 WHERE currency <> (SELECT config_value #>> '{}' FROM public.rma_config
                     WHERE config_key = 'default_currency')
ORDER BY 1, 2;
