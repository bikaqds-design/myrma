-- Stage 2: overseas purchasing in the vendor's currency.
--
-- Local purchases stay in the base currency with a rate of 1. Overseas ones
-- carry the vendor's currency and the rate that was actually paid, typed on the
-- document by whoever raised it.
--
-- ── Why the rate lives on the row ────────────────────────────────────────────
--
-- Not looked up when a report runs. The rate a bank gave on the day is a fact
-- about that purchase, and a document converted last year must still convert
-- the same way today. Looking it up live would mean every historical cost — and
-- so every historical margin — silently changes whenever the rate moves.
--
-- ── Why the base totals are generated columns ────────────────────────────────
--
-- total_base could be computed by the application and written alongside total.
-- It would then be wrong the first time anyone updated total through a path
-- that forgot, and nothing would say so. GENERATED ALWAYS makes that
-- impossible: Postgres recomputes it on every write, and it cannot be set
-- directly even by mistake.

-- ═══ 1. Normalise the existing free-text currency ════════════════════════════
-- purchase_orders.currency is a free-text box today: it prints on the PDF and
-- means nothing. Anything that is not a currency this installation knows about
-- becomes the base currency, which is what those rows have effectively been all
-- along.

DO $do$
DECLARE
  v_base text;
  v_fixed integer;
BEGIN
  SELECT config_value #>> '{}' INTO v_base
    FROM public.rma_config WHERE config_key = 'default_currency';

  UPDATE public.purchase_orders
     SET currency = COALESCE(
       (SELECT code FROM public.currencies
         WHERE code = upper(btrim(purchase_orders.currency))),
       v_base)
   WHERE currency IS NULL
      OR upper(btrim(currency)) NOT IN (SELECT code FROM public.currencies);

  GET DIAGNOSTICS v_fixed = ROW_COUNT;
  RAISE NOTICE 'Normalised currency on % purchase order(s) to %.', v_fixed, v_base;

  -- Uppercase whatever remains, so 'usd' and 'USD' stop being different values.
  UPDATE public.purchase_orders SET currency = upper(btrim(currency))
   WHERE currency <> upper(btrim(currency));
END
$do$;

-- ═══ 2. Currency, rate and base totals ═══════════════════════════════════════

ALTER TABLE public.purchase_orders
  ALTER COLUMN currency TYPE char(3),
  ALTER COLUMN currency SET NOT NULL,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,8) NOT NULL DEFAULT 1;

ALTER TABLE public.vendor_invoices
  ADD COLUMN IF NOT EXISTS currency      char(3),
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,8) NOT NULL DEFAULT 1;

-- Vendor invoices had no currency at all. Everything existing is base.
UPDATE public.vendor_invoices
   SET currency = (SELECT config_value #>> '{}' FROM public.rma_config
                    WHERE config_key = 'default_currency')
 WHERE currency IS NULL;

ALTER TABLE public.vendor_invoices
  ALTER COLUMN currency SET NOT NULL;

ALTER TABLE public.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_currency_fkey,
  ADD CONSTRAINT purchase_orders_currency_fkey
    FOREIGN KEY (currency) REFERENCES public.currencies(code) ON DELETE RESTRICT;

ALTER TABLE public.vendor_invoices
  DROP CONSTRAINT IF EXISTS vendor_invoices_currency_fkey,
  ADD CONSTRAINT vendor_invoices_currency_fkey
    FOREIGN KEY (currency) REFERENCES public.currencies(code) ON DELETE RESTRICT;

-- A rate of zero or below would cost an entire shipment at nothing or invert it.
ALTER TABLE public.purchase_orders
  DROP CONSTRAINT IF EXISTS chk_po_rate_positive,
  ADD CONSTRAINT chk_po_rate_positive CHECK (exchange_rate > 0);

ALTER TABLE public.vendor_invoices
  DROP CONSTRAINT IF EXISTS chk_vi_rate_positive,
  ADD CONSTRAINT chk_vi_rate_positive CHECK (exchange_rate > 0);

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS total_base numeric(12,2)
    GENERATED ALWAYS AS (round(total * exchange_rate, 2)) STORED;

ALTER TABLE public.vendor_invoices
  ADD COLUMN IF NOT EXISTS total_base numeric(12,2)
    GENERATED ALWAYS AS (round(total * exchange_rate, 2)) STORED;

COMMENT ON COLUMN public.purchase_orders.exchange_rate IS
  'Units of base currency per one unit of this document''s currency, as actually paid. 1 for local purchases. Recorded on the document because a past purchase must keep converting the way it did at the time.';
COMMENT ON COLUMN public.purchase_orders.total_base IS
  'total in base currency. Generated, so it cannot drift out of step with total or the rate.';

-- ═══ 3. A document in the base currency must have a rate of exactly 1 ════════
-- Not a CHECK constraint: the base currency lives in config, so the test is not
-- immutable. A rate of 1.02 on a local purchase would inflate its cost by two
-- percent and nothing downstream would question it.

CREATE OR REPLACE FUNCTION public.rma_guard_document_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_base text;
BEGIN
  SELECT config_value #>> '{}' INTO v_base
    FROM public.rma_config WHERE config_key = 'default_currency';

  IF NEW.currency = v_base AND NEW.exchange_rate <> 1 THEN
    RAISE EXCEPTION
      'A document in the base currency (%) must have an exchange rate of 1, not %.',
      v_base, NEW.exchange_rate
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.currency <> v_base AND NEW.exchange_rate = 1 THEN
    RAISE EXCEPTION
      'A document in % needs the exchange rate that was actually paid. A rate of 1 would record % as though it were %.',
      NEW.currency, NEW.currency, v_base
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_guard_po_rate ON public.purchase_orders;
CREATE TRIGGER trg_guard_po_rate
  BEFORE INSERT OR UPDATE OF currency, exchange_rate ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_document_rate();

DROP TRIGGER IF EXISTS trg_guard_vi_rate ON public.vendor_invoices;
CREATE TRIGGER trg_guard_vi_rate
  BEFORE INSERT OR UPDATE OF currency, exchange_rate ON public.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_document_rate();

-- ═══ 4. Landed charges ═══════════════════════════════════════════════════════
-- Freight, customs and clearance on an import are a large share of what the
-- goods actually cost. Leaving them out overstates gross margin on every
-- imported item, so they are captured against the vendor invoice and
-- apportioned into unit cost by line value at receipt (stage 3).

CREATE TABLE IF NOT EXISTS public.vendor_invoice_charges (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_invoice_id uuid        NOT NULL REFERENCES public.vendor_invoices(id) ON DELETE CASCADE,
  charge_type       text        NOT NULL CHECK (charge_type IN
                                  ('freight', 'customs', 'clearance', 'insurance', 'handling', 'other')),
  description       text,
  -- In the vendor invoice's own currency, like its line items.
  amount            numeric(12,2) NOT NULL CHECK (amount >= 0),
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendor_invoice_charges_vi_idx
  ON public.vendor_invoice_charges(vendor_invoice_id);

COMMENT ON TABLE public.vendor_invoice_charges IS
  'Freight, customs and clearance on a vendor invoice. Apportioned across the goods by line value at receipt so they land in unit cost rather than being lost to general expenses.';

ALTER TABLE public.vendor_invoice_charges ENABLE ROW LEVEL SECURITY;

-- Mirrors vendor_invoices: managers write, accountants and staff read.
DROP POLICY IF EXISTS vi_charges_manager_write ON public.vendor_invoice_charges;
CREATE POLICY vi_charges_manager_write ON public.vendor_invoice_charges
  FOR ALL TO authenticated
  USING (public.rma_is_manager_or_above()) WITH CHECK (public.rma_is_manager_or_above());

DROP POLICY IF EXISTS vi_charges_staff_read ON public.vendor_invoice_charges;
CREATE POLICY vi_charges_staff_read ON public.vendor_invoice_charges
  FOR SELECT TO authenticated
  USING (public.rma_is_manager_or_above() OR public.rma_user_role() = 'accountant');

REVOKE ALL ON public.vendor_invoice_charges FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_invoice_charges TO authenticated;
GRANT ALL ON public.vendor_invoice_charges TO service_role, postgres;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
DECLARE
  v_bad integer;
  v_base text;
BEGIN
  SELECT config_value #>> '{}' INTO v_base
    FROM public.rma_config WHERE config_key = 'default_currency';

  SELECT count(*) INTO v_bad FROM (
    SELECT 1 FROM public.purchase_orders
      WHERE currency = v_base AND exchange_rate <> 1
    UNION ALL
    SELECT 1 FROM public.vendor_invoices
      WHERE currency = v_base AND exchange_rate <> 1
  ) x;

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'Refusing to apply: % existing document(s) are in the base currency but carry a rate other than 1. Nothing has been changed.', v_bad;
  END IF;

  RAISE NOTICE 'Purchasing is currency-aware. Existing documents are all % at rate 1.', v_base;
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Run supabase/manual/20260827_verify_purchasing_currency.sql.
