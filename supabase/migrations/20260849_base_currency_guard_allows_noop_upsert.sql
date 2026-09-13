-- BUG-025 (found while testing the atomic restore): an upsert that writes back
-- the base currency already stored was refused as if it changed it.
--
-- rma_guard_base_currency() already let a no-op through — but only for
-- TG_OP = 'UPDATE'. An upsert is INSERT … ON CONFLICT DO UPDATE, and PostgreSQL
-- fires BEFORE INSERT row triggers for every proposed row *before* it detects
-- the conflict. So the trigger saw an "insert", skipped its no-op check, counted
-- 109 transaction documents and refused.
--
-- Measured with a rolled-back probe on 2026-09-13: a plain UPDATE writing the
-- same value → allowed; the same value as an upsert → refused.
--
-- Consequence: a backup could never be restored into a database that had any
-- invoices, quotations, orders or payments — neither by the old table-by-table
-- path nor the new atomic one — because rma_config is restored near the start
-- and the default_currency row always trips this. The settings screen does not
-- hit it (the base currency is shown read-only there), which is why it went
-- unnoticed.
--
-- The fix only widens the no-op case. Writing a DIFFERENT base currency while
-- documents exist is still refused, by either path.

CREATE OR REPLACE FUNCTION public.rma_guard_base_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_docs integer;
BEGIN
  IF NEW.config_key <> 'default_currency' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.config_value IS NOT DISTINCT FROM OLD.config_value THEN
    RETURN NEW;   -- a no-op save from the settings form
  END IF;
  -- The same no-op arriving as an upsert: BEFORE INSERT fires before the
  -- conflict is found, so compare with what is already stored.
  IF TG_OP = 'INSERT' AND EXISTS (
       SELECT 1 FROM public.rma_config c
        WHERE c.config_key = NEW.config_key
          AND c.config_value IS NOT DISTINCT FROM NEW.config_value) THEN
    RETURN NEW;
  END IF;

  SELECT
      (SELECT count(*) FROM public.crm_invoices)
    + (SELECT count(*) FROM public.quotations)
    + (SELECT count(*) FROM public.sales_orders)
    + (SELECT count(*) FROM public.purchase_orders)
    + (SELECT count(*) FROM public.vendor_invoices)
    + (SELECT count(*) FROM public.payments)
    + (SELECT count(*) FROM public.vendor_payments)
    INTO v_docs;

  IF v_docs > 0 THEN
    RAISE EXCEPTION
      'The base currency cannot be changed: % transaction document(s) already exist and their stored amounts were recorded against the current base. Changing it would silently reinterpret every one of them.',
      v_docs
      USING ERRCODE = 'P0001';
  END IF;

  -- Must be a currency this installation actually knows about.
  IF NOT EXISTS (
    SELECT 1 FROM public.currencies
     WHERE code = btrim(NEW.config_value #>> '{}') AND is_active
  ) THEN
    RAISE EXCEPTION 'Unknown or inactive currency: %', NEW.config_value #>> '{}'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END
$function$;

-- ═══ Guard: no-op allowed, real change still refused ═════════════════════════

DO $do$
DECLARE v_other text; v_refused boolean := false;
BEGIN
  -- Same value as an upsert must now pass.
  INSERT INTO public.rma_config (config_key, config_value)
  SELECT config_key, config_value FROM public.rma_config WHERE config_key = 'default_currency'
  ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

  -- A different, active currency as an upsert must still be refused while documents exist.
  SELECT code INTO v_other FROM public.currencies
   WHERE is_active AND code <> (SELECT btrim(config_value #>> '{}') FROM public.rma_config WHERE config_key = 'default_currency')
   LIMIT 1;
  IF v_other IS NOT NULL THEN
    BEGIN
      INSERT INTO public.rma_config (config_key, config_value)
      VALUES ('default_currency', to_jsonb(v_other))
      ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;
    EXCEPTION WHEN OTHERS THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'Refusing to finish: a real base-currency change was allowed through the upsert path.';
    END IF;
  END IF;
END
$do$;
